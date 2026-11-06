# Full-repo review brief — SentryVision v1.7.2

One file for a complete code-review pass. Canonical details: `AGENTS.md`,
`README.md`, `docs/ARCHITECTURE.md`, `docs/API-SOURCE-OF-TRUTH.md`. This brief
adds what those lack: review ordering, invariants (prose + executable), data
sensitivity, exposure, and current repo state.

## Deliverable format (read first)

- **Report only — do not modify code, the working tree, or containers.** Fixes
  are approved separately by the owner.
- **Severity scale**: `Critical` (data loss / security hole / outage) ·
  `High` (realistic risk or cost) · `Improvement` (worthwhile, not urgent) ·
  `Optional` (style).
- **Time budget**: one working session. Work areas in order; if time runs out,
  stop and report coverage honestly — areas 1–4 matter more than 5–8.
- **Coverage levels — state which you used per area**: `Read` (every line of
  the listed files) · `Skim` (structure + spot-read of hot paths) · `Grep`
  (targeted search for the named patterns). 65k LOC does not fit one session
  as Read; suggested split: areas 1–4 `Read`/`Skim`, areas 5–8 `Grep` with
  named entry files, plus `npm audit` + `pip check` style sweeps.
- **Findings template**: last section of this file.

## What the system is

Self-hosted home security: two RTSP cameras → go2rtc (sole RTSP client per
camera) → Python OpenCV detection pipeline (MOG2 → YOLO → ByteTrack → ArcFace
face recognition → human verification) → Express 5 + TypeORM + Socket.io
backend → PostgreSQL. Next.js 14 static export served by the backend. Live
viewing via WebRTC/MSE at 250 kbps per tile. Production, single-node Docker
Compose, IST timezone. **Processes biometric data** (face embeddings) — see
area 2.

| Container | Port | Role |
|---|---|---|
| sentryvision-app | 9753, `0.0.0.0` (LAN) | Express API + serves frontend `out/` + go2rtc proxy |
| sentryvision-opencv | 8084 HTTP / 9090 WS (internal) | Detection pipeline |
| sentryvision-go2rtc | 1984 API (loopback) / 8555 (public UDP+TCP) | RTSP bridge + transcodes |
| sentryvision-postgres | 5432 (internal) | 44 tracked migrations |
| sentryvision-relations | 8085 (internal) | RelateAnything sidecar (numpy 2, isolated) |

**Network exposure**: LAN on `0.0.0.0:9753`; internet via a cloudflared tunnel
(`argus.tayenjam.dpdns.org`) terminating at the app; JWT-gated. Port 8555
(WebRTC) is published `0.0.0.0` — LAN-exposed by design; whether the router
forwards it from the WAN is an owner check, not verifiable from code. WebRTC
media can't cross the tunnel (UDP), so remote viewers use proxied MSE. No TLS
on 9753 itself — TLS ends at cloudflared.

**Deploy model**: containers bind-mount the source. Python hot-mounts (edit +
`docker restart`), Node runs from `server/dist` (compile + restart), frontend
needs `npm run build` **then** restart — CSP inline-script hashes are collected
from `frontend-next/out` at startup; a stale allowlist = blank page (see
Recommendations).

## Repo map

| Area | LOC | Contents |
|---|---|---|
| `server/src` | 35 387 | 13 controllers, 30 route files, 49 services, 27 models, middleware, cron |
| `frontend-next/src` | 16 638 | 12 views, 8 app pages, 44 components, 10 hooks, 4 zustand stores |
| `opencv-service` | 12 560 | 37 modules: `app.py` (Flask entry), `rtsp_ingestion/`, detection chain |
| `database/migrations` | 1 930 | **44 tracked: 001–034 and 036–045 — there is no 035** (historical gap, not a defect; don't "fix" the numbering). `046_create_face_clusters.sql` is untracked owner WIP. |
| `scripts/` | 3 149 | health, backup, deploy, reconciliation, `check-invariants.sh` |
| `e2e/` | — | Playwright tests against live :9753 (`tester` DB account) |

## Entry points / lifecycles

- **HTTP**: `server/src/index.ts` → `routes/index.ts` mounts `/api/*` →
  controller → service → TypeORM. Validation: Zod (`middleware/validation.ts`).
- **Boot**: `bootstrap.ts` → `initializers/{database,services,cron}.ts`.
- **Socket.io**: `streams/rtspManager.ts` — viewer rooms, `frameRoomFor()`
  opt-out, python frame relay. Events: `requestStream`/`stopStream`/`frame`/
  `motionDetected`/`eventCreated`/`personDetected`/`faceDetected`.
- **Detection**: opencv `rtsp_ingestion/` (FFmpegReader 640×360@5fps from
  go2rtc re-stream) → MotionGate → InProcessYOLO → ByteTracker →
  IdentityEnrichment (ArcFace) → HumanVerifier → WebSocketPublisher → Node
  `PythonWsClient` → `pipeline/detectionPersistence.ts` → `events` table.
- **Frontend**: `frontend-next/src/app/` (App Router), views in `src/views/`,
  API clients in `src/services/api/baseClient.ts`, state in `src/stores/`.

## Review areas, ordered by risk

### 1. Auth, tokens, and exposure surface

`server/src/auth/`, `middleware/{auth,enhancedRateLimit,go2rtcAuth}.ts`,
`AuthController.ts`, `docs/SECURITY.md`. Check: JWT access/refresh rotation,
MFA, session + password-history enforcement.

Specific holes to probe (code refs verified):

- **Socket.io auth** (`streams/socketAuth.ts` — `verifySocketAuth` checks the
  JWT on handshake and sets `socket.data.user`): does `requestStream` in
  `streams/rtspManager.ts` do any per-camera authorization before
  `socket.join(roomName)`? None is visible. Also: can a valid socket join
  rooms for both cameras / roles it shouldn't?
- **go2rtc proxy is unfiltered** (`server/src/index.ts:52-58`): auth-gated,
  but **no method restriction and no path allowlist** — an authenticated user
  can reach the full go2rtc admin API, including endpoints that add streams
  with arbitrary ffmpeg args (`PUT /api/streams`). Assess: exec/SSRF via
  stream source URLs.
- **Rate limiting behind the tunnel**: `trust proxy` is OFF (deliberate —
  see `enhancedRateLimit.keying.test.ts:16`, X-Forwarded-For is never read).
  cloudflared dials the app directly, so every tunnel client shares one
  `req.ip` → one rate-limit bucket for all internet users. Assess blast
  radius (lockout? brute-force window?).
- **LAN is plain HTTP**: `0.0.0.0:9753` — JWTs and `?token=` media URLs
  travel unencrypted on the LAN; TLS ends at cloudflared. Rate severity.
- **`?token=` media URLs** (`go2rtcAuth.ts`, `withMediaToken()`): lifetime,
  scope, leak paths — server logs (the request logger at `index.ts:63` skips
  `/api/streams`, verify nothing else logs the query), Referer, browser
  history. Long-lived tokens in URLs are the known weak spot.
- **Supply chain + host hardening sweep** (`Grep` level): `npm audit` in
  root/frontend/server; Dockerfile root users, capabilities, source bind
  mounts; path traversal in event-image/media serving (static routes,
  `getEventPath`); raw SQL usage in TypeORM repositories; PII (names, faces,
  tokens) in `logger` output.

### 2. Biometric data (most sensitive data in the system)

`server/src/models/FaceEmbedding.ts`, face-cluster services, migration 046
(WIP), `opencv-service/arcface_recognizer.py`, `cluster_and_populate.py`.
Check: encryption at rest (camera credentials get `credentialEncryption.ts`;
nothing similar is visible for embeddings — verify), retention policy coverage
(`retentionPolicyService.ts` — are embeddings and clusters ever purged?),
deletion on request (is there a path that removes an identity end-to-end?),
and whether `scripts/backup.sh` includes them (it backs up DB + files — so
backups carry biometric data wherever they're stored).

**Legal posture for severity calibration**: face embeddings of visitors,
neighbors, and passers-by. India's DPDP Act 2023 may apply even to household
systems depending on how purpose and consent are read; the reviewer's job is
not legal advice — judge severity assuming this data deserves
consent-aware collection, bounded retention, and a working deletion path.

### 3. Data leaving the house

`services/nvidia/`, `services/chat/` (RAG), `nvidiaAnalysisService.ts`.
Verified config: `NVIDIA_API_BASE_URL=http://192.168.31.99:20128/v1` — a **LAN
gateway (9router), over plaintext HTTP**, not the public NVIDIA API.
`OLLAMA_BASE_URL` overrides to local inference when set. Check: which model
IDs on that gateway route to cloud providers and what payloads (event images?
captions? embeddings?) they carry; how the gateway's API keys are stored and
whether they appear in logs; prompt-injection handling for event-derived text
(camera-visible text, object labels) fed to the LLM; and that chat/RAG answers
stay event-grounded (v1.7.1 removed fabricated attributes — don't let them
return).

### 4. Detection pipeline (highest churn: 81 file touches / 90 days)

`opencv-service/`. Verify the contract chain: motion gate before YOLO,
verifier tiers (YOLO ≥0.90 → face → pose, floor 0.55), person persistence gate
in **Node** (`PERSON_MIN_TRACK_HITS=3`, confidence 0.55), bbox space = image
pixels (`bboxSpace: 'image'`), `persons_detected` dedupes IoU>0.3 and drops
`lost` tracks. Model fallback chain (v8s QAT → v8n → v5n → v4-tiny) must warn,
never crash. **Note**: three files in this area have uncommitted owner WIP —
review the **committed version** (`git show HEAD:opencv-service/<file>`);
the working-tree diffs belong to in-progress face-clustering work, out of scope.

### 5. Streaming — already reviewed 2026-11-06

Read `docs/REVIEW-2026-11-06-cheap-stream-profile.md` (250 kbps profile, HD
burst, hidden-tab teardown, `frames:false`). Do not re-derive its fixed
findings; its "deferred minors" are accepted.

### 6. Backup and restore

`scripts/backup.sh` (DB + files) — **no restore procedure exists or has been
tested**; that gap is itself a finding. Check: backup encryption, retention of
backup copies. **Concrete deliverable**: a restore rehearsal into a scratch
Postgres container from the artifacts the script produces (documented steps +
observed result), not just an observation.

### 7. Frontend correctness

Zustand stores (4), `hooks/useCameraStream.ts` (complex: rate limits,
visibility state machine), `views/EventsPage.tsx` (known exhaustive-deps
warnings are pre-existing). Check: no secret in client bundle, `baseClient`
refresh loop terminates, legacy `/app/*` routes vs canonical.

### 8. Data, migrations, cron

44 tracked migrations — idempotency (restarts re-run boot; a re-run migration
must not corrupt). `utils/cronJobs.ts` + retention + cleanup services: cron
jobs must be restart-safe (see Recommendations — advisory locks).

## Invariants — executable + prose

Run `bash scripts/check-invariants.sh` (all six PASS as of 2026-11-06):

1. **No stray `rtsp://` consumer in source** (go2rtc is the sole RTSP client).
2. **`h264_low` detection profile pinned** (720p/10fps/1500k).
3. **`h264_cheap` viewer profile present** (640×360, 250k cap).
4. **Runtime**: cameras see only go2rtc, ≤1 connection each; no other
   container touches port 554.
5. **Secrets untracked** (`.env`, `server/cameras.json` not in git).
6. **No auth secrets in the shipped client bundle** (`out/_next/static/`).

Prose invariants (not yet scripted):

7. The 24/7 detection transcode must never be starved by viewer load.
8. No browser path may reach the 1440p main stream (the latent
   `streamSrc ?? camera.id` fallback in `useCameraStream.ts` is the one known
   candidate — it's an accepted deferred minor, callers pass `streamSrc`
   today; a grep for callers not passing it is the cheap check).
9. Detection runs **in Python**; Node's `detectObjects`/`detectFaces` are
   disabled guards that throw — by design.
10. Never `git add -A` — owner WIP is present (below).

## Current repo state (2026-11-06)

- `main` @ HEAD. Last merged: cheap stream profile + docs.
- **Uncommitted owner WIP — do not touch, commit, or review the diffs**:
  `docker-compose.yml`, `opencv-service/{arcface_recognizer,cluster_and_populate}.py`,
  `opencv-service/rtsp_ingestion/frame_pipeline.py`, untracked
  `database/migrations/046_create_face_clusters.sql`,
  `opencv-service/face_clustering.json`, `opencv-service/tests/test_arcface_cosine.py`.
  Where WIP files overlap review areas, review the committed version only.
- **Runtime ≠ HEAD for the Python service**: opencv hot-mounts the working
  tree, so the running container executes the WIP code, not HEAD. Runtime
  observations (logs, behavior, invariant check 4's neighbor containers) may
  reflect uncommitted code — say so when reporting.
- **Untracked migration 046 is one command away from running**: boot does NOT
  auto-migrate (`synchronize: false`, no `migrationsRun`), but
  `database/migrations/migrate.ts:37` globs every `*.sql` in the directory —
  the next manual `cd database && npm run migrate` executes the WIP DDL. It is
  kept out only by nobody running that command.
- Accepted deferred minors (streaming): stale "browser canvas" error copy,
  dead `isWanStream` state, latent `streamSrc ?? camera.id` 1440p path,
  `activateHq` can't extend a burst, no fallback for missing `_cheap` stream.
- Never human-exercised: hidden-tab teardown and HD burst in a logged-in
  browser (verified by measurement + code reading only).

## Verification commands — safety classes

**Read-only, run freely**:

```bash
bash scripts/check-invariants.sh
cd frontend-next && npm run typecheck && npm run lint && npx vitest run
cd server && node --experimental-vm-modules node_modules/.bin/jest   # plain npx jest FAILS on ESM
cd server && npx tsc --noEmit -p tsconfig.json
docker ps --format '{{.Names}}\t{{.Status}}' | grep sentryvision
curl -s http://127.0.0.1:1984/api/streams | python3 -m json.tool
docker logs sentryvision-{app,opencv,go2rtc} --since 5m
docker exec sentryvision-postgres psql -U sentryvision -d sentryvision -c '\dt'
```

**Mutating — owner sign-off required before running** (change the working
tree, write artifacts, restart production, or hit the live DB):

```bash
npm run build && npm run build:server   # writes out/ + dist/ (hot-mounted!)
docker restart sentryvision-app         # production restart
docker run --rm -v .../opencv-service:/app:ro ... pytest   # pip installs in throwaway container
# e2e suite: runs against LIVE :9753 with the 'tester' account on the production DB
# any psql INSERT/UPDATE/DELETE, any npm run migrate (046 hazard above)
```

## Recorded recommendations (not blockers — owner decides; #1 is urgent)

1. **CSP hash fragility — HIGH priority**: a blank page after any frontend
   deploy is an outage. Compute the allowlist at build time, or fail the
   healthcheck loudly when `out/` and the allowlist disagree. Cheap fix,
   removes a whole failure class.
2. **Jest ESM flag**: put it in an npm script so `npx jest` stops being tribal
   knowledge.
3. **pytest**: bake it into a test image instead of pip-installing per run.
4. **Cron restart-safety**: a job-run table or Postgres advisory locks, rather
   than relying on each job being incidentally idempotent.
5. **Lint ratchet**: enforce "no new warnings" so the known list can't grow.
6. **Deploy provenance**: deploy script logs commit SHA + dirty state, since
   bind-mounted source makes "what's running" fuzzy.
7. **Media tokens**: short-lived, per-stream scoped tokens instead of the
   long-lived JWT in `?token=`.
8. **WIP quarantine**: move untracked `046_create_face_clusters.sql` out of
   `database/migrations/` (e.g. `migrations/wip/`) until it's ready — the
   runner's glob makes its current location a loaded trigger.

## Findings template (copy per finding)

```markdown
### [Severity] <one-line title>
- **Where**: <file>:<line>
- **What**: <the defect or risk>
- **Why it matters**: <impact on a person using this system>
- **Fix**: <concrete change>
```
