# Backend

Express 5 + TypeScript + TypeORM + Socket.io on port 9753.

## Quick Start

```bash
cd server
npm install
npm run dev        # Nodemon hot reload (watches src/ + cameras.json)
```

Production:
```bash
npm run build && npm start
```

## Entry Point

`server/src/index.ts` → `bootstrap.ts` → `routes/index.ts`

**Bootstrap order:**
1. Load env vars (`dotenv`)
2. Initialize database (TypeORM/Postgres)
3. Start Socket.io server
4. Wire Python WebSocket client → event bus
5. Mount route modules
6. Serve static frontend from `public/`
7. SPA fallback for client-side routing

## Middleware Stack

| Middleware | File | Purpose |
|------------|------|---------|
| `compression()` | express built-in | gzip responses |
| `cors()` | express middleware | CORS origins (dev: `*`, prod: explicit) |
| `express.json()` | express built-in | JSON body parsing |
| `helmet()` | helmet | CSP, HSTS, security headers |
| `authenticate()` | `middleware/auth.ts` | JWT verification + session check |
| `optionalAuth` | `middleware/auth.ts` | JWT if present, no rejection |
| `requireUser` | `middleware/auth.ts` | Requires logged-in user |
| `requireAdmin` | `middleware/auth.ts` | Requires admin role |
| `validateBody(zodSchema)` | `middleware/zodValidation.ts` | Request body validation |
| `validateQuery(zodSchema)` | `middleware/zodValidation.ts` | Query param validation |
| `validateParams(zodSchema)` | `middleware/zodValidation.ts` | URL param validation |
| `createApiRateLimit()` | `middleware/enhancedRateLimit.ts` | Global rate limit |
| `createAuthRateLimit()` | `middleware/enhancedRateLimit.ts` | Login/register rate limit |
| `createMfaRateLimit()` | `middleware/enhancedRateLimit.ts` | MFA attempt rate limit |
| `createDetectionRateLimit()` | `middleware/enhancedRateLimit.ts` | Detection API rate limit |

## Route Structure

20 route modules mounted in `routes/index.ts`:

```
/api/auth        → auth.ts           (10 endpoints)
/api/cameras     → cameras.ts        (19 endpoints)
/api/streams     → streams.ts        (5 endpoints)
/api/events      → event-search.ts   (11 endpoints)
/api/events      → events.ts         (2 endpoints)
/api/nvidia      → nvidiaRoutes.ts   (11 endpoints)
/api/detection   → detection-operations.ts  (12 endpoints)
/api/detection   → detectionRoutes.ts       (4 endpoints)
/api/detection-redo → detectionRedoRoutes.ts (2 endpoints)
/api/detection-data → detectionData.ts      (2 endpoints)
/api/motion      → motion.ts         (4 endpoints)
/api/analytics   → analytics.ts      (5 endpoints)
/api/highlights  → highlights.ts     (2 endpoints)
/api/timelapse   → timelapse.ts      (3 endpoints)
/api/face-clusters → face-clusters.ts (3 endpoints)
/api/chat        → chat.ts           (3 endpoints)
/api/alerts      → alerts.ts         (3 endpoints)
/api/notifications → notificationRoutes.ts (10 endpoints)
/api/settings    → settings.ts       (2 endpoints)
```

Plus direct routes in `index.ts`:
- `GET /api/health`, `GET /api/stats`, `GET /api/system/*`
- `GET /detections/image/:imageId`, `GET /api/snapshots/list`
- `POST /api/maintenance/cleanup-*`
- `GET /snapshot/:cameraId.jpg`, `GET /stream/:cameraId`

## Controllers

| Controller | Responsibility |
|------------|---------------|
| `AuthController` | Login, register, MFA, JWT |
| `CameraController` | Camera CRUD, streams, zones, filters |
| `StreamController` | RTSP/WebRTC/MSE streaming, frame capture |
| `EventController` | Enhanced event listing, history |
| `DetectionController` | Detection config, filtering |
| `DetectionDataController` | Detection data listing |
| `DetectionImageController` | Detection images with overlays |
| `NvidiaController` | AI scene analysis (NVIDIA/Ollama) |
| `AnalyticsController` | Hourly/weekly/monthly/daily insights |
| `SettingsController` | System settings CRUD |
| `SystemController` | Health, stats, overview, logs, cleanup |
| `AlertController` | Alert CRUD, acknowledge |
| `ChatController` | AI chat with tool calling |

## Services

| Service | Purpose |
|---------|---------|
| `serviceRegistry` | Service locator pattern |
| `inMemoryStateService` | Events, alerts, camera state |
| `eventSearchService` | Full-text event search + pagination |
| `nvidiaAnalysisService` | LLM-based scene analysis |
| `cacheService` | Redis/in-memory cache abstraction |
| `consolidatedDetectionService` | Detection type defs + settings stubs |
| `notificationService` | Web Push + notification preferences |
| `batchProcessingDatabasePostgres` | Batch DB writes (cron-driven) |
| `retentionPolicyService` | Data retention enforcement |
| `automatedCleanupService` | Storage cleanup cron jobs |
| `opencvMicroserviceClient` | HTTP client to Python OpenCV service |
| `streamManager` | RTSP stream orchestration |
| `credentialEncryption` | Camera credential encryption |

## Socket.io

```typescript
const io = new SocketIOServer(server, { cors: { origin: corsOrigins } });
app.set('io', io);
```

**Events emitted by server:**
- `streamFrame` — live JPEG frames per camera room
- `cameraStatus` — camera online/offline status
- `eventCreated` — new detection event
- `personDetected` — person tracked (with bbox, confidence)
- `faceDetected` — face recognized/unknown
- `enhancedMotionDetected` — motion + optional face/person analysis

**Events received from client:**
- `requestStream` — join camera room. Optional `frames: false` (set by every video-decoding client) keeps the socket out of the JPEG frame room; viewer tracking and the python subscription are unaffected
- `stopStream` — leave camera room

## Authentication

JWT-based with:
- Access tokens (short-lived)
- Refresh tokens (longer-lived, stored in `user_sessions`)
- Session validation cached 30s per user
- MFA via TOTP (speakeasy)
- Account lockout after failed attempts
- Password history (bcrypt, 14 rounds)

## Python WebSocket Client

```typescript
// server/src/pipeline/detectionPersistence.ts
// Receives from ws://opencv:9090:
//   - Frame JPEGs (binary)
//   - Tracking events (JSON: person/face/vehicle detections)
// Persists to PostgreSQL events table
// Re-emits as Socket.io events to frontend
```

## go2rtc Proxy

```typescript
// server/src/index.ts
// Proxies /go2rtc → http://go2rtc:1984 (HTTP)
// Manual WebSocket upgrade for /go2rtc WebSocket paths
// Does NOT intercept Socket.io paths
```

## Memory Management

- Node.js max heap: 512MB (`--max-old-space-size=512`)
- Session validity cached (avoids DB round-trip per request)
- In-memory event state with configurable limits
- No Redis by default (`REDIS_DISABLED=true`)

## Key Files

| File | Purpose |
|------|---------|
| `server/src/index.ts` | Express bootstrap, middleware, route wiring |
| `server/src/bootstrap.ts` | Service initialization orchestrator |
| `server/src/routes/index.ts` | Route mounting and direct routes |
| `server/src/middleware/auth.ts` | JWT + session authentication |
| `server/src/database.ts` | TypeORM DataSource configuration |
| `server/src/pipeline/detectionPersistence.ts` | Python→Node detection event pipeline |
| `server/cameras.json` | Camera configuration (gitignored) |
| `server/cameras.example.json` | Camera config template |
