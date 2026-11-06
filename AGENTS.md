# AGENTS.md

Essential information for AI agents working on the SentryVision codebase.

## Project Overview

Home security system: React/TypeScript frontend, Express 5 backend, PostgreSQL, Python OpenCV service.

**Version**: 1.7.0 | **Timezone**: IST (UTC+5:30) | **Status**: Production

For documentation index see `docs/DOCS.md`. For complete endpoint mapping see `docs/API-SOURCE-OF-TRUTH.md`.

## Documentation

All docs live in the project root. Key files:

| Doc | Purpose |
|-----|---------|
| `README.md` | Quick start, architecture, commands |
| `docs/PRODUCT.md` | Product vision and capabilities |
| `docs/API-SOURCE-OF-TRUTH.md` | Complete API endpoint inventory |
| `docs/BACKEND.md` | Express API, routes, services, middleware |
| `docs/FRONTEND.md` | React app, pages, services, routing |
| `docs/DATABASE.md` | Schema, migrations, queries |
| `docs/ENVIRONMENT.md` | All environment variables |
| `docs/OPENCV-SERVICE.md` | Python detection pipeline |
| `docs/SECURITY.md` | Auth, rate limiting, headers |
| `docs/CONTRIBUTING.md` | Dev workflow, conventions |
| `docs/DOCS.md` | Full documentation index |

## Architecture

| Layer    | Tech                                                                                              | Port |
| -------- | ------------------------------------------------------------------------------------------------- | ---- |
| Frontend | Next.js 14 (React 18), TypeScript, TailwindCSS, Radix UI (shadcn/ui) — static export served by backend | 9753 |
| Backend  | Express 5, TypeScript, TypeORM, Socket.io                                                         | 9753 |
| OpenCV   | Flask, OpenCV MOG2 + YOLOv8n + InsightFace face recognition                                       | 8084 |
| Relations | Flask, RelateAnything (DINOv3 scene graphs) — numpy 2 sidecar, isolated from opencv's numpy 1.x  | 8085 |
| Database | PostgreSQL 15+ (26 migrations)                                                                    | 5432 |
| Cache    | In-memory (Redis optional, use `REDIS_DISABLED=true`)                                             | —    |

**Data flow**: `Frontend → Backend API → OpenCV Service → PostgreSQL`

**Real-time detection pipeline**:

- Python OpenCV Service detects motion/objects and publishes events via WebSocket to `/nvidia/analyze-event` and `/nvidia/analyze-event-with-bboxes` endpoints
- Frontend AI analysis uses `detectionService.analyzeEvent(eventId)` to analyze detection events
- Events UI uses Socket.io for real-time updates

## Commands

```bash
# Dev
npm run dev              # Frontend only
npm run dev:server       # Backend only
npm run dev:full         # Both (kills stale ports first)

# Build
npm run build            # Frontend (Next.js static export)
npm run build:server     # Backend (tsc → dist/)
npm run build:full       # All of the above

# OpenCV assets (YOLO/InsightFace models) are baked in at Docker image build
# (opencv-service/Dockerfile runs download_all_models.py) — no host build step.
# Relations sidecar bakes its models the same way (relsgg HF weights at
# /opt/hf-cache via HF_HOME, YOLO-World + CLIP at /opt) — fresh installs need
# no runtime downloads; only cameras are added post-install via the Web UI.

# Quality
npm run lint             # ESLint (frontend)
npm run lint:server      # ESLint (server)
npm run lint:fix         # ESLint autofix (frontend)
npm run format           # Prettier write (frontend + server + root)
npm run typecheck        # tsc --noEmit (frontend)
npm run test:server      # Jest (server; tests in server/src/**/*.test.ts)

# Server (cd server)
npm run dev              # Nodemon hot reload (watches src + cameras.json)
npm run build            # Compile TS
npm start                # Production
npm run test:server      # Jest (--experimental-vm-modules)

# Database (cd database)
npm run migrate          # Run pending migrations

# Docker
docker-compose up -d / down / ps / logs -f

# Apply code changes WITHOUT image rebuilds
# Python (opencv):   hot-mounted — edit .py files on host, then:
docker restart sentryvision-opencv

# Python (relations sidecar): hot-mounted the same way:
docker restart sentryvision-relations

# Node (backend):    server/dist is hot-mounted — compile TS, then:
cd server && npm run build && docker restart sentryvision-app
```

**Always run `npm run lint && npm run typecheck` after frontend changes.**

After a frontend `npm run build` also restart `sentryvision-app`: the CSP inline-script
hashes are collected from `frontend-next/out` once at startup, so a stale allowlist
blocks the page scripts (blank page, React error #423).

## Frontend Structure

```
frontend-next/src/
├── app/                     # Next.js App Router (login/, (app)/, error/loading boundaries)
├── views/                   # Route-level views
│   ├── StreamDashboard.tsx  # Live camera view — default at (/)
│   ├── EventsPage.tsx       # Main events view with filters (/events)
│   ├── PeoplePage.tsx       # People / face clusters (/app/people, legacy-only path)
│   ├── InsightsPage.tsx     # Daily analytics dashboard (/app/insights, legacy-only path)
│   ├── TimelapsePage.tsx    # Timelapse view (/app/timelapse, legacy-only path)
│   ├── AskPage.tsx          # AI chat interface (/ask)
│   ├── LogsPage.tsx         # System logs + alerts (/app/logs, legacy-only path)
│   ├── SecurityPage.tsx     # Security view (/security)
│   ├── AnalyticsPage.tsx    # Analytics view (/analytics)
│   ├── SettingsHub.tsx + Settings.tsx # System settings (/settings)
│   └── LoginPage.tsx        # Auth + MFA (/login)
├── components/
│   ├── live/                # AdaptiveCameraGrid, StreamPanel, RecentDetectionsSection
│   ├── events/              # EventDetailPanel, SmartFilters, RelatedEvents
│   ├── layout/              # AppFrame, navigation, PageContainer
│   ├── settings/            # Settings sub-views
│   ├── dashboard/           # Dashboard widgets
│   ├── brand/               # Branding components
│   ├── ui/                  # shadcn/ui primitives (Radix)
│   ├── ErrorBoundary.tsx
│   └── providers.tsx
├── services/
│   ├── api/                 # REST clients (baseClient.ts shared fetch wrapper w/ auth, retry, refresh
│   │                        #   + cameraService, eventService, detectionService, personService,
│   │                        #   chatService, insightsService, authService, systemService,
│   │                        #   settingsService, notificationService)
│   └── SocketService.ts     # Socket.io singleton client
├── stores/                  # Zustand stores (auth, camera, socket, ui) — see ADR-001
├── hooks/                   # useCameraStream, useCameras, useEvents, useInsights, use-toast, ...
├── lib/                     # utils.ts (cn()), theme.ts
├── types/                   # Type definitions
└── styles/                  # Design tokens
```

## Backend Structure

```
server/src/
├── index.ts                  # Express app bootstrap, middleware, and route configuration
├── bootstrap.ts              # Orchestrates service, database, and cron job initialization
├── initializers/             # Modular initialization logic
│   ├── database.ts           # Database connection and shutdown
│   ├── services.ts           # Core application services setup
│   └── cron.ts               # Scheduled cron jobs initialization
├── pipeline/                 # Core real-time detection pipeline logic
│   ├── detectionPersistence.ts # Persisting detection events to DB and triggering notifications
├── database.ts               # TypeORM connection
├── controllers/              # MVC pattern
│   ├── CameraController.ts   # Camera CRUD + snapshots
│   ├── StreamController.ts   # RTSP streaming
│   ├── AuthController.ts     # Login, register, MFA
│   ├── DetectionController.ts
│   ├── EventController.ts
│   ├── AnalyticsController.ts
│   ├── SettingsController.ts
│   ├── SystemController.ts
│   ├── AlertController.ts
│   └── NvidiaController.ts   # AI scene analysis
├── routes/                   # Route definitions
│   ├── index.ts              # Mount all routes under /api/*
│   ├── auth.ts, cameras.ts, events.ts, streams.ts, staticRoutes.ts
│   ├── detection-operations.ts, detectionRedoRoutes.ts, detectionRoutes.ts
│   ├── motion.ts, face-clusters.ts   # face-clusters mounted at /api/face-clusters
│   ├── notificationRoutes.ts, nvidiaRoutes.ts
│   ├── settings.ts, highlights.ts, timelapse.ts
│   └── analytics.ts, alerts.ts, event-search.ts
├── services/                 # Business logic
│   ├── nvidiaAnalysisService.ts       # NVIDIA AI integration
│   ├── eventSearchService.ts          # Full-text event search
│   ├── batchProcessingDatabasePostgres.ts   # Batch DB writes (cron-driven)
│   ├── retentionPolicyService.ts      # Data retention
│   ├── notificationService.ts
│   ├── automatedCleanupService.ts
│   ├── opencvMicroserviceClient.ts    # HTTP client to OpenCV
│   ├── cacheService.ts                # Redis/in-memory cache
│   ├── serviceRegistry.ts
│   ├── credentialEncryption.ts
│   ├── inMemoryStateService.ts
│   ├── circuitBreaker.ts
│   ├── retryService.ts
│   ├── detection/                     # Detection sub-services
│   ├── review/                        # Review sub-services
│   ├── timeline/                      # Timeline sub-services
│   └── preview/                       # Preview sub-services
├── models/                   # TypeORM entities
│   ├── User.ts, Role.ts, UserSession.ts, PasswordHistory.ts
│   ├── Event.ts, DetectionConfig.ts, ProcessedImage.ts, AdaptiveRegion.ts
│   ├── Visitor (in timeline), FaceEmbedding.ts
│   ├── BatchJob.ts, ReviewSegment.ts, UserReviewStatus.ts
│   ├── RetentionPolicy.ts, StorageStats (system)
│   ├── NotificationLog.ts, NotificationPreferences.ts, NotificationSubscription.ts
│   ├── SecurityEvent.ts, RateLimitCounter.ts, AuditLog.ts
│   └── index.ts              # Re-exports all models
├── middleware/
│   ├── auth.ts               # JWT verification
│   ├── validation.ts         # Zod schemas
│   └── enhancedRateLimit.ts  # Rate limiting
├── detection/                # Detection types + cleanup (pipeline runs in Python)
│   ├── consolidatedDetectionService.ts  # Settings store + disabled-HTTP guards; detection runs in Python
│   └── cleanupService.ts                # Event cleanup
├── streams/
│   ├── rtspManager.ts        # RTSP stream orchestration
│   └── streamHealthMonitor.ts
├── utils/
│   ├── logger.ts, auditLogger.ts
│   ├── encryption.ts, fileHash.ts
│   ├── detectionDataNormalizer.ts
│   ├── cronJobs.ts
│   └── testImageGenerator.ts
├── config/
│   ├── index.ts, detectionConfig.ts, performance.ts, rateLimits.ts
├── types/
│   ├── api.ts, auth.ts, camera.ts, detection.ts, event.ts
├── auth/
│   └── index.ts
├── migrations/               # TypeORM migrations
```

## Detection Pipeline

The detection pipeline runs entirely in Python. Node.js receives structured events over WebSocket.

1. Python `FFmpegReader` captures raw BGR24 frames from RTSP via FFmpeg subprocess (640×360 @ 5 FPS)
2. Python `MotionGate` runs MOG2 background subtraction (pixel threshold: 500, 10-frame warmup)
3. On motion → Python `InProcessYOLO` runs object detection (YOLOv8n → YOLOv5n → yolov4-tiny fallback chain, OpenCV DNN)
4. Python `ByteTracker` performs multi-object tracking (Kalman filter, track lifecycle: started/updated/ended)
5. Python `IdentityEnrichment` runs face recognition on new tracks (InsightFace ArcFace, 30s identity cache)
6. Python `HumanVerifier` verifies each person track (tiered: YOLO ≥ 0.90 → face → MediaPipe pose → score floor 0.55 day / 0.55 night); unverified tracks are discarded before event emission
7. Python `IdentityEnrichment` runs face recognition on new tracks (InsightFace ArcFace, 30s identity cache)
8. Python `WebSocketPublisher` sends JPEG frames + JSON tracking events to Node.js via WebSocket (`ws://localhost:9090`)
9. Node.js `PythonWsClient` receives and re-emits as Node EventEmitter
10. `rtspManager.wirePythonWsFrames()` relays frames to Socket.io rooms with adaptive FPS by viewer count
11. Node.js `detectionPersistence.ts` persists tracking events as `events` in PostgreSQL with image captures. Person counting drops `lost` track states and dedupes overlapping person bboxes (IoU > 0.3), so `persons_detected` = distinct humans, not raw track IDs
12. `consolidatedDetectionService.ts` provides the detection settings store (person/face/motion settings read by routes) and config push to Python; `detectObjects`/`detectFaces` are disabled guards that throw (HTTP detection off) — actual detection runs in Python

## Key Configuration

| File                          | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `server/cameras.json`         | Camera RTSP URLs, zones, tracked objects (gitignored) |
| `server/cameras.example.json` | Camera config template                                |
| `frontend-next/next.config.ts` | Next.js build + API proxy to :9753                     |
| `docker-compose.yml`          | All 5 services                                        |
| `.env.example`                | Environment variable reference                        |

## Database

26 SQL migrations in `database/migrations/` (plus 2 disabled). Key tables:

- **users, roles, user_sessions, password_history, audit_logs** — Auth
- **events** — Core detection events (UUID PK, timestamp, camera_id, event_type, confidence, image_path, persons_detected, faces_detected, object_detections JSONB, face_detections JSONB)
- **face_embeddings** — Face vectors for recognition
- **visitor_timeline, timeline** — Visitor tracking
- **review_segments, user_review_status** — Review workflow
- **batch_jobs** — Async processing
- **notification_*** — Notification preferences and logs
- **system_settings, retention_policies, storage_stats** — System config
- **security_events, rate_limit_counters** — Security

## Conventions

- **TypeScript** with `noImplicitAny` (backend) and permissive frontend config.
- **File naming**: PascalCase components (`CameraGrid.tsx`), camelCase utils (`apiService.ts`)
- **Import order**: external → internal → types
- **API calls**: Use `services/api/baseClient.ts` (handles auth headers, refresh)
- **Components**: Follow shadcn/ui patterns, Radix primitives
- **Backend routes**: MVC pattern — Controller handles logic, Route file just wires Express
- **Validation**: Zod schemas in `middleware/validation.ts`
- **No comments** in code unless asked

## Real-time

- **Socket.io** for live camera frames and motion alerts
- Events: `requestStream`, `stopStream`, `frame`, `motionDetected`
- Live tiles decode video themselves (WebRTC/MSE/HLS via go2rtc `*_cheap` profile, 250 kbps) and send `requestStream` with `frames: false`, so the JPEG frame relay stays off for them
- Frontend connects via `SocketService.ts` → `SocketContext.tsx`

## Environment Variables

```bash
# Backend (.env)
NODE_ENV=development
PORT=9753
DB_HOST=localhost       # "postgres" in Docker
DB_PORT=5432
DB_NAME=sentryvision
DB_USER=sentryvision
DB_PASSWORD=<secret>
JWT_ACCESS_SECRET=<secret>
JWT_REFRESH_SECRET=<secret>
OPENCV_SERVICE_URL=http://localhost:8084  # "http://opencv:8084" in Docker
DETECTIONS_DIR=./data/detections
TZ=Asia/Kolkata

# Frontend (.env)
VITE_BACKEND_URL=http://localhost:9753
```

## Common Issues

| Issue                  | Fix                                                                   |
| ---------------------- | --------------------------------------------------------------------- |
| Port in use            | `npm run kill:ports`                                                  |
| DB connection          | Verify postgres running, check credentials, run migrations            |
| OpenCV down            | `curl http://localhost:8084/health`                                   |
| No motion detected     | Check RTSP URLs in cameras.json, verify FFmpeg, check detection zones |
| Frontend build errors  | `cd frontend-next && rm -rf node_modules && npm install`                     |
| Backend TS errors      | `cd server && rm -rf dist && npm run build`                           |
| Secrets in git history | Use `git filter-repo` — contact maintainer                            |

## Utility Scripts

| Script                                | Purpose                                       |
| ------------------------------------- | --------------------------------------------- |
| `scripts/health.sh`                   | Service health monitoring                     |
| `scripts/diagnose.sh`                 | System diagnostics (cameras, ports, FFmpeg)   |
| `scripts/test-opencv.sh`              | End-to-end test (OpenCV + backend + frontend) |
| `scripts/backup.sh`                   | Database and file backups                     |
| `scripts/deploy.sh`                   | Production deployment                         |
| `scripts/sentryvision.sh`             | Interactive management console                |
| `scripts/batch-detect-and-update.py`  | Python batch detection                        |
| `scripts/reindex-detection-files.cjs` | Reindex detection files                       |
| `scripts/cleanup-orphaned-files.cjs`  | Remove orphaned detection files               |
| `scripts/find-missing-db-records.cjs` | Reconcile files vs DB records                 |
