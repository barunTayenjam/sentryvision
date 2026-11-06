# Full-repo review brief — SentryVision v1.7.2

One file for a complete code-review pass of this repository. Canonical detailed
docs: `AGENTS.md` (repo map + commands), `README.md`, `docs/ARCHITECTURE.md`,
`docs/API-SOURCE-OF-TRUTH.md` (full endpoint inventory). This brief adds what
those lack: review ordering, invariants, and current repo state.

## What the system is

Self-hosted home security: two RTSP cameras → go2rtc (sole RTSP client per
camera) → Python OpenCV detection pipeline (MOG2 → YOLO → ByteTrack → ArcFace
→ human verification) → Express 5 + TypeORM + Socket.io backend → PostgreSQL.
Next.js 14 static export served by the backend. Live viewing via WebRTC/MSE at
250 kbps per tile. Production, single-node Docker Compose, IST timezone.

| Container | Port | Role |
|---|---|---|
| sentryvision-app | 9753 (public) | Express API + serves frontend `out/` + go2rtc proxy |
| sentryvision-opencv | 8084 HTTP / 9090 WS (internal) | Detection pipeline |
| sentryvision-go2rtc | 1984 API (loopback) / 8555 WebRTC | RTSP bridge + transcodes |
| sentryvision-postgres | 5432 (internal) | 44 tracked migrations (+1 untracked WIP) |
| sentryvision-relations | 8085 (internal) | RelateAnything sidecar (numpy 2, isolated) |

**Deploy model**: containers bind-mount the source. Python hot-mounts (edit +
`docker restart`), Node runs from `server/dist` (compile + restart), frontend
needs `npm run build` **then** restart — CSP inline-script hashes are collected
from `frontend-next/out` at app startup; a stale allowlist = blank page.

## Repo map (LOC, file counts)

| Area | LOC | Contents |
|---|---|---|
| `server/src` | 35 387 | 13 controllers, 30 route files, 49 services, 27 models, middleware, cron |
| `frontend-next/src` | 16 638 | 12 views, 8 app pages, 44 components, 10 hooks, 4 zustand stores |
| `opencv-service` | 12 560 | 37 modules: `app.py` (Flask entry), `rtsp_ingestion/`, detection chain |
| `database/migrations` | 1 930 | 44 tracked SQL migrations (046 is untracked WIP) |
| `scripts/` | 3 149 | health, backup, deploy, reconciliation |
| `e2e/` | — | Playwright tests against a live :9753 (uses `tester` DB account) |

## Entry points / lifecycles

- **HTTP**: `server/src/index.ts` → routes (`routes/index.ts` mounts `/api/*`)
  → controller → service → TypeORM. Validation: Zod (`middleware/validation.ts`).
- **Boot**: `bootstrap.ts` → `initializers/{database,services,cron}.ts`.
- **Socket.io**: `streams/rtspManager.ts` — viewer rooms, `frameRoomFor()`
  opt-out, python frame relay. Events: `requestStream`/`stopStream`/`frame`/
  `motionDetected`/`eventCreated`/`personDetected`/`faceDetected`.
- **Detection**: opencv `rtsp_ingestion/` (FFmpegReader 640×360@5fps) →
  MotionGate → InProcessYOLO → ByteTracker → IdentityEnrichment →
  HumanVerifier → WebSocketPublisher → Node `PythonWsClient` →
  `pipeline/detectionPersistence.ts` → `events` table. Full chain: AGENTS.md.
- **Frontend**: `frontend-next/src/app/` (App Router), views in `src/views/`,
  API clients in `src/services/api/baseClient.ts` (auth headers, refresh,
  retry), state in `src/stores/` (ADR-001).

## Review areas, ordered by risk

### 1. Auth & security surface (highest blast radius)

`server/src/auth/`, `middleware/{auth,enhancedRateLimit,go2rtcAuth}.ts`,
`controllers/AuthController.ts` (login/register/MFA), `docs/SECURITY.md`.
Check: JWT access/refresh rotation, session + password-history enforcement,
rate-limit keying (per-IP vs per-account), go2rtc token gate (media URLs carry
`?token=` — verify they can't leak into logs), audit logging on sensitive ops.

### 2. Detection pipeline (most churn: 81 file touches / 90 days)

`opencv-service/` — verify the contract chain still holds: motion gate before
YOLO, verifier tiers (YOLO ≥0.90 → face → pose, floor 0.55), person
persistence gate lives in **Node** (`PERSON_MIN_TRACK_HITS=3`, confidence
0.55), bbox space = image pixels (`bboxSpace: 'image'`), `persons_detected`
dedupes IoU>0.3 and drops `lost` tracks. Model fallback chain
(v8s QAT → v8n → v5n → v4-tiny) must warn, never crash. Tests:
`opencv-service/tests/`.

### 3. Event persistence + RAG/chat

`pipeline/detectionPersistence.ts`, `services/eventSearchService.ts`,
`services/chat/`, `services/nvidia/`, `services/detection/`. Recent rework:
semantic search + event-grounded RAG (Wave 1+2), JEV threat pre-filter.
Check: no fabricated attributes in answers (v1.7.1 removed several — don't
let them back), event images written before DB rows or reconciled, retention
service can't delete rows whose files are referenced.

### 4. Streaming — ALREADY REVIEWED 2026-11-06

Read `docs/REVIEW-2026-11-06-cheap-stream-profile.md` for that slice
(250 kbps profile, HD burst, hidden-tab teardown, `frames:false`).
Do not re-derive its fixed findings; its "deferred minors" list is accepted.

### 5. Frontend correctness

Zustand stores (4), `hooks/useCameraStream.ts` (complex — rate limits,
visibility state machine), `views/EventsPage.tsx` (known exhaustive-deps
warnings are pre-existing). Check: no secret in client bundle, `baseClient`
refresh loop terminates, legacy-only routes (`/app/*`) vs canonical routes.

### 6. Data, migrations, retention

44 tracked migrations — check idempotency (a 45th, `046_create_face_clusters.sql`,
is owner WIP, not reviewed). `utils/cronJobs.ts` +
`retentionPolicyService.ts` + `automatedCleanupService.ts`: cron jobs must be
idempotent (restart-safe) since the container restarts on every deploy.

## Cross-cutting invariants

1. Cameras must see exactly **one** RTSP client (go2rtc). No code path may
   open a second camera connection — everything reads go2rtc's re-stream.
2. The 24/7 detection transcode (`cam*_low`, 720p/10fps/1500k) must never be
   starved by viewer load (cheap transcodes spawn per viewer, despawn idle).
3. No browser path may reach the 1440p main stream.
4. Secrets only via `.env` / `server/cameras.json` (gitignored). Check nothing
   inlined them historically (`docs/CONTRIBUTING.md` references filter-repo).
5. Detection runs **in Python**; Node's `consolidatedDetectionService`
   `detectObjects`/`detectFaces` are disabled guards that throw — by design.
6. Uncommitted owner WIP exists (see below) — never `git add -A`.

## Current repo state (2026-11-06)

- `main` @ `250de0c`. Last merged: cheap stream profile (`bc158cf`).
- **Uncommitted owner WIP — out of scope, do not touch or commit**:
  `docker-compose.yml`, `opencv-service/{arcface_recognizer,cluster_and_populate}.py`,
  `opencv-service/rtsp_ingestion/frame_pipeline.py`, untracked
  `database/migrations/046_create_face_clusters.sql`,
  `opencv-service/face_clustering.json`, `opencv-service/tests/test_arcface_cosine.py`.
- Accepted deferred minors (streaming): stale "browser canvas" error copy,
  dead `isWanStream` state, latent `streamSrc ?? camera.id` 1440p path,
  `activateHq` can't extend a burst, no fallback for missing `_cheap` stream.
- Never human-exercised: hidden-tab teardown and HD burst in a logged-in
  browser (verified by measurement + code reading only).

## Verification commands

```bash
cd frontend-next && npm run typecheck && npm run lint && npx vitest run   # 33/33; 0 lint errors expected
cd server && node --experimental-vm-modules node_modules/.bin/jest        # 515/515 — plain npx jest FAILS on ESM
cd server && npx tsc --noEmit -p tsconfig.json                            # server typecheck
# Python suite: host and container have no pytest — run in a throwaway container
# (documented in docs/OPENCV-SERVICE.md; 136 pytest tests):
docker run --rm -v $(pwd)/opencv-service:/app:ro -w /app sentryvision-opencv:latest \
  sh -c "pip install -q pytest pytest-asyncio && python -m pytest tests -q"
# E2E (Playwright, uses the 'tester' DB account) — see e2e/*.test.ts
npm run build && npm run build:server                                     # deploy build (then docker restart sentryvision-app)
docker ps --format '{{.Names}}\t{{.Status}}' | grep sentryvision          # all healthy
curl -s http://127.0.0.1:1984/api/streams | python3 -m json.tool          # stream/consumer state
```

Data: `docker exec sentryvision-postgres psql -U sentryvision -d sentryvision`.
Logs: `docker logs sentryvision-{app,opencv,go2rtc} --since 5m`.
