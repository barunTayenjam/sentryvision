# SentryVision — API Source of Truth

**Generated:** 2026-09-24 · **v1.7.0** · From live codebase analysis (not docs)

All endpoints prefixed with `/api`. Base URL: `http://192.168.31.99:9753` in prod; the Next dev server proxies `/api` to :9753 in dev.

---

## Architecture Summary

| Layer | Tech | Port | Mounts |
|-------|------|------|--------|
| Frontend | Next.js 14 (React 18) / TS / TailwindCSS / shadcn | 9753 (static export served by backend) | `frontend-next/` |
| Backend | Express 5 / TypeScript / TypeORM / Socket.io | 9753 | `server/` |
| OpenCV | Flask / OpenCV MOG2 + YOLOv8n + InsightFace | 8084 (HTTP) / 9090 (WS) | `opencv-service/` |
| Database | PostgreSQL 15+ (26 migrations) | 5432 | `database/` |
| Cache | In-memory (Redis optional) | — | — |

**Data flow:** Camera (RTSP) → Python OpenCV → Express API → PostgreSQL → React Frontend

---

## Route Mount Map

| Mount Path | File | Controller(s) |
|------------|------|---------------|
| `/go2rtc` | `server/src/index.ts` (proxy) + `middleware/go2rtcAuth.ts` | JWT-gated proxy to go2rtc — token via `Authorization: Bearer` or `?token=` |
| `/api/auth` | `server/src/routes/auth.ts` | `AuthController` |
| `/api/cameras` | `server/src/routes/cameras.ts` | `CameraController` |
| `/api/streams` | `server/src/routes/streams.ts` | `StreamController` |
| `/api/analytics` | `server/src/routes/analytics.ts` | `AnalyticsController` |
| `/api/detection-data` | `server/src/routes/detectionData.ts` | `DetectionDataController` |
| `/api/settings` | `server/src/routes/settings.ts` | `SettingsController` |
| `/api/nvidia` | `server/src/routes/nvidiaRoutes.ts` | `NvidiaController` |
| `/api/motion` | `server/src/routes/motion.ts` | (inline) |
| `/api/events` | `server/src/routes/event-search.ts` + `events.ts` | `EventController` + `eventSearchService` |
| `/api/alerts` | `server/src/routes/alerts.ts` | `AlertController` |
| `/api/notifications` | `server/src/routes/notificationRoutes.ts` | `NotificationService` |
| `/api/detection` | `server/src/routes/detection-operations.ts` + `detectionRoutes.ts` | `consolidatedDetectionService` + `detectionService` |
| `/api/detection-redo` | `server/src/routes/detectionRedoRoutes.ts` | (inline) |
| `/api/highlights` | `server/src/routes/highlights.ts` | (inline, raw SQL) |
| `/api/timelapse` | `server/src/routes/timelapse.ts` | `TimelapseService` |
| `/api/face-clusters` | `server/src/routes/face-clusters.ts` | (inline, raw SQL) |
| `/api/chat` | `server/src/routes/chat.ts` | `ChatController` |
| *(direct)* | `server/src/routes/index.ts` | `StreamController`, `SystemController`, `DetectionImageController` |
| *(static)* | `server/src/routes/staticRoutes.ts` | (inline + express.static) |

---

## Complete Endpoint Inventory

### Authentication — `/api/auth`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/auth/register` | admin | `authController.register` |
| POST | `/api/auth/login` | rate-limited | `authController.login` |
| GET | `/api/auth/profile` | user | `authController.getProfile` |
| POST | `/api/auth/change-password` | user | `authController.changePassword` |
| POST | `/api/auth/refresh` | rate-limited | `authController.refreshToken` — presents 7-day refresh token (body `{refreshToken}`), verifies `purpose: 'refresh'` + live session row, rotates both tokens |
| POST | `/api/auth/logout` | user | `authController.logout` |
| GET | `/api/auth/mfa/setup` | user | `authController.setupMfa` |
| POST | `/api/auth/mfa/challenge` | rate-limited | `authController.mfaChallenge` — issues JWT only for `status='active'` accounts |
| POST | `/api/auth/mfa/verify` | rate-limited | `authController.verifyMfa` |
| POST | `/api/auth/mfa/disable` | rate-limited | `authController.disableMfa` — requires `{currentPassword}` or `{code}` |

### Cameras — `/api/cameras`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/cameras` | optional | `cameraController.listAll` |
| GET | `/api/cameras/:id` | optional | `cameraController.getById` |
| POST | `/api/cameras` | user | `cameraController.addCamera` |
| PUT | `/api/cameras/:id` | user | `cameraController.update` |
| DELETE | `/api/cameras/:id` | user | `cameraController.remove` |
| POST | `/api/cameras/:id/stream/start` | user | `cameraController.startStream` |
| POST | `/api/cameras/:id/stream/stop` | user | `cameraController.stopStream` |
| POST | `/api/cameras/:id/stream/start-test` | user | `cameraController.startTest` |
| POST | `/api/cameras/:id/stream/stop-test` | user | `cameraController.stopTest` |
| POST | `/api/cameras/:id/snapshot` | user | `cameraController.takeSnapshot` |
| POST | `/api/cameras/:id/night-mode` | user | `cameraController.toggleNightMode` |
| GET | `/api/cameras/:cameraId/zones` | optional | `cameraController.getZones` |
| POST | `/api/cameras/:cameraId/zones` | user | `cameraController.addZone` |
| PUT | `/api/cameras/:cameraId/zones/:zoneId` | user | `cameraController.updateZone` |
| DELETE | `/api/cameras/:cameraId/zones/:zoneId` | user | `cameraController.removeZone` |
| GET | `/api/cameras/:cameraId/filters` | optional | `cameraController.getFilters` |
| PUT | `/api/cameras/:cameraId/filters/track` | user | `cameraController.updateTrack` |
| PUT | `/api/cameras/:cameraId/filters/:label` | user | `cameraController.updateFilter` |
| DELETE | `/api/cameras/:cameraId/filters/:label` | user | `cameraController.removeFilter` |

### Streams — `/api/streams`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/streams/:cameraId/live` | optional | `streamController.getLiveStream` |
| GET | `/api/streams/:cameraId/frame` | user | `streamController.getFrame` |
| GET | `/api/streams/:cameraId/status` | optional | `streamController.getStatus` |
| GET | `/api/streams/:cameraId/detect` | user | `streamController.detect` |
| GET | `/api/streaming/metrics` | optional | `streamController.getMetrics` |
| GET | `/snapshot/:cameraId.jpg` | optional | `streamController.getSnapshot` |
| GET | `/stream/:cameraId` | optional | `streamController.getMjpegStream` |
| GET | `/stream/:cameraId/test` | optional | `streamController.getMjpegStream` |

### Events — `/api/events`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/events/list-enhanced` | optional | `eventController.listEnhanced` |
| GET | `/api/events/:id/relations` | optional | `eventController.getEventRelations` → `relationAnalysisService` |
| GET | `/api/events/:id/relation-threat` | optional | `eventController.getEventRelationThreat` → `relationThreatService` (9router LLM, grounded in stored relations) |
| GET | `/api/events/search` | optional | `eventSearchService.searchEvents` |
| GET | `/api/events/stats/today` | optional | `eventSearchService.getTodayEventCount` |
| GET | `/api/events/stats/calendar` | optional | `eventSearchService.getCalendarStats` |
| GET | `/api/events/stats/range` | optional | `eventSearchService.getRangeStats` |
| GET | `/api/events/list` | optional | `eventSearchService.listEventFiles` |
| GET | `/api/events/:id/details` | optional | `eventSearchService.getEventDetails` |
| GET | `/api/events/image/:filename` | optional | (inline, serves files) |
| POST | `/api/events/:id/archive` | user | (inline, deletes event) |
| POST | `/api/events/bulk/archive` | user | (inline, bulk delete) |

### AI Analysis — `/api/nvidia`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/nvidia/analyze` | user | `nvidiaController.analyze` |
| POST | `/api/nvidia/analyze-event` | user | `nvidiaController.analyzeEvent` |
| POST | `/api/nvidia/analyze-event-with-bboxes` | user | `nvidiaController.analyzeEventWithBboxes` |
| POST | `/api/nvidia/analyze-with-bboxes` | user | `nvidiaController.analyzeWithBboxes` |
| POST | `/api/nvidia/analyze-persons` | user | `nvidiaController.analyzePersons` |
| GET | `/api/nvidia/event-analysis/:eventId` | user | `nvidiaController.getEventAnalysis` |
| GET | `/api/nvidia/health` | public | `nvidiaController.health` |
| GET | `/api/nvidia/results` | user | `nvidiaController.getResults` |
| GET | `/api/nvidia/models` | user | `nvidiaController.getModels` |
| PUT | `/api/nvidia/config` | admin | `nvidiaController.updateConfig` |

### Detection — `/api/detection`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/detection` | user | `detectionService.getConfig` |
| PUT | `/api/detection` | user | `detectionService.updateConfig` |
| GET | `/api/detection/stats` | user | `enhancedDetectionService.getDetectionStats` |
| POST | `/api/detection/person/:cameraId/trigger` | user | (inline, consolidated detection) |
| POST | `/api/detection/face/:cameraId/trigger` | user | (inline, consolidated detection) |
| GET | `/api/detection/person/settings` | optional | `consolidatedDetectionService.getObjectDetectionSettings` |
| PUT | `/api/detection/person/settings` | user | `consolidatedDetectionService.updateObjectDetectionSettings` |
| GET | `/api/detection/face/settings` | optional | `consolidatedDetectionService.getFacialRecognitionSettings` |
| PUT | `/api/detection/face/settings` | user | `consolidatedDetectionService.updateFacialRecognitionSettings` |
| GET | `/api/detection/motion/settings` | optional | `consolidatedDetectionService.getMotionSettings` |
| PUT | `/api/detection/motion/settings` | user | `consolidatedDetectionService.updateMotionSettings` |

### Detection Redo — `/api/detection-redo`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/detection-redo/rerun-detection` | user | (inline, re-runs on file) |
| POST | `/api/detection-redo/rerun-event-detection` | user | (inline, re-runs on event) |

### Detection Data — `/api/detection-data`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/detection-data` | user | `detectionDataController.list` |
| GET | `/api/detection-data/stats` | user | `detectionDataController.stats` |

### Motion — `/api/motion`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/motion/events` | optional | `eventSearchService.getMotionEvents` |
| GET | `/api/motion/:cameraId/events` | optional | `eventSearchService.getCameraMotionEvents` |
| POST | `/api/motion/:cameraId/simulate` | admin | (inline, simulate motion) |
| POST | `/api/motion/:cameraId/analyze` | user | (inline, analyze current frame) |

### Analytics — `/api/analytics`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/analytics/hourly` | optional | `analyticsController.getHourly` |
| GET | `/api/analytics/weekly` | optional | `analyticsController.getWeekly` |
| GET | `/api/analytics/monthly` | optional | `analyticsController.getMonthly` |
| GET | `/api/analytics/storage` | optional | (inline, storage stats) |
| GET | `/api/analytics/daily/:date` | optional | `analyticsController.getDailyInsights` |

### Highlights — `/api/highlights`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/highlights/:date` | optional | (inline, raw SQL) |
| GET | `/api/highlights/:date/summary` | optional | (inline, raw SQL) |

### Timelapse — `/api/timelapse`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/timelapse/list/:date` | optional | (inline) |
| GET | `/api/timelapse/:cameraId/:date` | optional | (inline) |
| POST | `/api/timelapse/generate/:cameraId/:date` | user | (inline, 10min timeout) |

### Face Clusters — `/api/face-clusters`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/face-clusters` | user | (inline, raw SQL) |
| GET | `/api/face-clusters/image/:clusterId` | optional | (inline) |
| POST | `/api/face-clusters/:clusterId/name` | user | (inline) |

### Static Routes — `server/src/routes/staticRoutes.ts`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/events/:filename` | public | Serve event image (path-validated, cached) |
| GET | `/snapshots/:filename` | public | Serve snapshot image |
| GET | `/health` | public | Service uptime check |
| GET | `/health/ready` | public | Readiness probe (DB + streamManager + pythonWs) |
| GET | `/api/streams/health` | public | Per-camera stream health (stale, restart attempts) |
| (static) | `/events/*` | public | `express.static(data/detections)` |
| (static) | `/snapshots/*` | public | `express.static(data/detections/snapshots)` |
| (static) | `/timelapse/*` | public | `express.static(public/timelapse)` |
| (static) | `/public/*` | public | `express.static(public)` |
| (static) | `/*` (frontend) | public | SPA static + index.html fallback (if `FRONTEND_DIST_PATH` exists) |

### Chat — `/api/chat`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/chat/message` | user | `chatController.message` |
| GET | `/api/chat/history` | user | `chatController.history` |
| DELETE | `/api/chat/history` | user | `chatController.clear` |

### Notifications — `/api/notifications`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/notifications/subscribe` | user | (inline, Web Push) |
| DELETE | `/api/notifications/unsubscribe` | user | (inline) |
| POST | `/api/notifications/resubscribe` | user | (inline) |
| GET | `/api/notifications/subscription` | user | (inline) |
| GET | `/api/notifications/vapid-public-key` | public | (inline) |
| GET | `/api/notifications/logs` | user | (inline) |
| POST | `/api/notifications/test` | user | (inline) |
| GET | `/api/notifications/preferences` | user | (inline) |
| PUT | `/api/notifications/preferences` | user | (inline) |
| POST | `/api/notifications/preferences/reset` | user | (inline) |

### Settings — `/api/settings`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/settings` | user | `settingsController.getSettings` |
| PUT | `/api/settings` | user | `settingsController.updateSettings` |

### Alerts — `/api/alerts`

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/alerts` | user | `alertController.getAll` |
| POST | `/api/alerts/:id/acknowledge` | user | `alertController.acknowledge` |
| DELETE | `/api/alerts/:id` | user | `alertController.remove` |

### System — `/api/system` + misc

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/health` | public | `systemController.health` |
| GET | `/api/stats` | optional | `systemController.stats` |
| GET | `/api/system/overview` | user | `systemController.overview` |
| GET | `/api/system/health` | optional | `systemController.systemHealth` |
| GET | `/api/system/logs` | user | `systemController.getLogs` |
| DELETE | `/api/system/logs` | admin | `systemController.clearLogs` |
| POST | `/api/maintenance/cleanup-images` | admin | `systemController.cleanupImages` |
| POST | `/api/maintenance/cleanup-full` | admin | `systemController.runFullCleanup` |
| GET | `/api/maintenance/cleanup-status` | admin | `systemController.cleanupStatus` |
| POST | `/api/maintenance/reindex-embeddings` | admin | inline — batch backfill `events.scene_embedding`/`scene_caption` (body `{batch}`, run until `remainingAfter: 0`) |
| GET | `/detections/image/:imageId` | optional | `detectionImageController.getImageWithOverlay` |
| GET | `/api/snapshots/list` | optional | `detectionImageController.listSnapshots` |

---

## Frontend Service → Backend Endpoint Mapping

### `baseClient.ts`
- `API_URL = '/api'` (relative — same origin; the backend serves the static export)
- `fetchWithRetry` — auto JWT refresh on 401, retry 3x, 120s timeout
- Helpers: `apiGet`, `apiPost`, `apiPut`, `apiDelete`, `apiClient` object

### `authService.ts`
| Method | Backend Call |
|--------|-------------|
| `login(user, pass)` | POST `/auth/login` |
| `register(data)` | POST `/auth/register` |
| `getProfile()` | GET `/auth/profile` |
| `changePassword(current, new)` | POST `/auth/change-password` |
| `refreshToken()` | POST `/auth/refresh` |
| `logout()` | POST `/auth/logout` |
| `setupMFA()` | GET `/auth/mfa/setup` |
| `verifyMFA(code)` | POST `/auth/mfa/verify` |
| `mfaChallenge(token, code)` | POST `/auth/mfa/challenge` |
| `disableMFA()` | POST `/auth/mfa/disable` |

### `cameraService.ts`
| Method | Backend Call |
|--------|-------------|
| `getCameras()` | GET `/cameras` |
| `getCamera(id)` | GET `/cameras/:id` |
| `addCamera(cam)` | POST `/cameras` |
| `updateCamera(id, updates)` | PUT `/cameras/:id` |
| `deleteCamera(id)` | DELETE `/cameras/:id` |
| `getStreamStatus(id)` | GET `/streams/:id/status` |
| `startCameraStream(id)` | POST `/cameras/:id/stream/start` |
| `stopCameraStream(id)` | POST `/cameras/:id/stream/stop` |
| `takeSnapshot(id)` | POST `/cameras/:id/snapshot` |
| `toggleNightMode(id, on)` | POST `/cameras/:id/night-mode` |
| `getMotionSettings(camId)` | ⚠️ GET `/motion/:camId/settings` |
| `updateMotionSettings(camId, s)` | ⚠️ PUT `/motion/:camId/settings` |
| `getZones(camId)` | GET `/cameras/:camId/zones` |
| `addZone(camId, zone)` | POST `/cameras/:camId/zones` |
| `updateZone(camId, zoneId, u)` | PUT `/cameras/:camId/zones/:zoneId` |
| `deleteZone(camId, zoneId)` | DELETE `/cameras/:camId/zones/:zoneId` |
| `getFilters(camId)` | GET `/cameras/:camId/filters` |
| `updateTrackList(camId, track)` | PUT `/cameras/:camId/filters/track` |
| `updateFilter(camId, label, f)` | PUT `/cameras/:camId/filters/:label` |
| `deleteFilter(camId, label)` | DELETE `/cameras/:camId/filters/:label` |
| `testCameraConnection(data)` | POST `/cameras/:name/stream/start-test` |

### `eventService.ts`
| Method | Backend Call |
|--------|-------------|
| `getDailyStats()` | GET `/events/stats/today` ✅ |
| `getMotionEvents(limit)` | GET `/motion/events?limit=N` ✅ |
| `getCameraMotionEvents(camId, limit)` | GET `/motion/:camId/events?limit=N` ✅ |
| `getSnapshots()` | GET `/snapshots/list` ✅ |
| `getEventsList()` | GET `/events/list` ✅ |
| `getEventImageUrl(fn)` | `/events/image/:fn` (URL only) ✅ |
| `getSnapshotImageUrl(fn)` | `/snapshots/:fn` (URL only) ✅ |
| `archiveEvent(id)` | POST `/events/:id/archive` ✅ |
| `getEnhancedEventsList(opts)` | GET `/events/list-enhanced?...` ✅ |
| `getCalendarStats(y, m, cam)` | GET `/events/stats/calendar?...` ✅ |
| `getRangeStats(start, end, cam)` | GET `/events/stats/range?...` ✅ |

### `detectionService.ts`
| Method | Backend Call |
|--------|-------------|
| `triggerPersonDetection(camId)` | POST `/detection/person/:camId/trigger` ✅ |
| `triggerFaceDetection(camId)` | POST `/detection/face/:camId/trigger` ✅ |
| `getPersonDetectionSettings()` | GET `/detection/person/settings` ✅ |
| `updatePersonDetectionSettings(s)` | PUT `/detection/person/settings` ✅ |
| `getFacialRecognitionSettings()` | GET `/detection/face/settings` ✅ |
| `updateFacialRecognitionSettings(s)` | PUT `/detection/face/settings` ✅ |
| `analyzeMotionWithDetection(camId, opts)` | POST `/motion/:camId/analyze` ✅ |
| `analyzeEvent(eventId)` | POST `/nvidia/analyze-event` ✅ |
| `analyzeEventWithBboxes(eventId)` | POST `/nvidia/analyze-event-with-bboxes` ✅ |
| `getEventAnalysis(eventId)` | GET `/nvidia/event-analysis/:eventId` ✅ |
| `getDetectionImage(imgId)` | GET `/detections/image/:imgId` ✅ |
| `getMotionSettings(camId)` | GET `/detection/motion/settings?cameraId=camId` ✅ |
| `updateMotionSettings(camId, s)` | PUT `/detection/motion/settings` ✅ |
| `redoDetection(data)` | POST `/detection-redo/rerun-detection` ✅ |
| `batchDetect(data)` | POST `/detection-redo/rerun-event-detection` ✅ |

### `personService.ts`
| Method | Backend Call |
|--------|-------------|
| `getFaceClusters()` | GET `/face-clusters` ✅ |
| `assignClusterName(id, name)` | POST `/face-clusters/:id/name` ✅ |

### `chatService.ts`
| Method | Backend Call |
|--------|-------------|
| `sendChatMessage(msg, history)` | POST `/chat/message` ✅ |
| `fetchChatHistory(limit)` | GET `/chat/history?limit=N` ✅ |
| `clearChatHistory()` | DELETE `/chat/history` ✅ |

### `insightsService.ts`
| Method | Backend Call |
|--------|-------------|
| `fetchDailyInsights(date)` | GET `/analytics/daily/:date` ✅ |

### `systemService.ts`
| Method | Backend Call |
|--------|-------------|
| `getHealth()` | GET `/system/health` ✅ |
| `getStats()` | GET `/stats` ✅ |
| `getSystemOverview()` | GET `/system/overview` ✅ |
| `getHourlyAnalytics(start, end)` | GET `/analytics/hourly` ✅ |
| `getStorageStats()` | GET `/analytics/storage` ✅ |
| `getDayHighlights(date, opts)` | GET `/highlights/:date` ✅ |
| `getDaySummary(date)` | GET `/highlights/:date/summary` ✅ |
| `getTimelapses(date)` | GET `/timelapse/list/:date` ✅ |
| `generateTimelapse(camId, date)` | POST `/timelapse/generate/:camId/:date` ✅ |

### `settingsService.ts`
| Method | Backend Call | Status |
|--------|-------------|--------|
| `getSettings()` | GET `/settings` ✅ |
| `updateSettings(data)` | PUT `/settings` ✅ |
| `getDetectionConfig(cam)` | ⚠️ GET `/detection/:cam` (should be `/detection?camera=cam`) |
| `updateDetectionConfig(data)` | ⚠️ PUT `/detection/:cam` (should be `/detection?camera=cam`) |
| `getSystemLogs(level, limit)` | GET `/system/logs?...` ✅ |
| `clearSystemLogs()` | DELETE `/system/logs` ✅ |
| `getAlerts()` | GET `/alerts` ✅ |
| `acknowledgeAlert(id)` | POST `/alerts/:id/acknowledge` ✅ |
| `deleteAlert(id)` | DELETE `/alerts/:id` ✅ |

### `notificationService.ts`
| Method | Backend Call |
|--------|-------------|
| `getPreferences()` | GET `/notifications/preferences` ✅ |
| `updatePreferences(p)` | PUT `/notifications/preferences` ✅ |
| `resetPreferences()` | POST `/notifications/preferences/reset` ✅ |
| `sendTestNotification()` | POST `/notifications/test` ✅ |
| `getVapidPublicKey()` | GET `/notifications/vapid-public-key` ✅ |
| `getSubscriptionStatus()` | GET `/notifications/subscription` ✅ |
| `subscribeToPush()` | POST `/notifications/subscribe` ✅ |
| `unsubscribeFromPush()` | DELETE `/notifications/unsubscribe` ✅ |

---

## Socket.io Events

| Event | Direction | Payload |
|-------|-----------|---------|
| `streamFrame` | Server→Client | `{ cameraId, frame }` |
| `cameraStatus` | Server→Client | `{ cameraId, isActive, status }` |
| `eventCreated` | Server→Client | `{ id, cameraId, eventType, timestamp }` |
| `personDetected` | Server→Client | `{ cameraId, persons[], imagePath }` |
| `faceDetected` | Server→Client | `{ cameraId, faces[], imagePath }` |
| `enhancedMotionDetected` | Server→Client | `{ cameraId, hasPersons, hasFaces, analysis }` |
| `requestStream` | Client→Server | `{ cameraId, role }` |
| `stopStream` | Client→Server | `{ cameraId, role }` |

---

## Frontend Routes

| Path | Page | Lazy-loaded |
|------|------|-------------|
| `/login` | `Login.tsx` | ✅ |
| `/app/streams` | `StreamDashboard.tsx` | ✅ |
| `/app/events` | `EventsPage.tsx` | ✅ |
| `/app/settings` | `Settings.tsx` | ✅ |
| `/app/timelapse` | `TimelapsePage.tsx` | ✅ |
| `/app/people` | `PeoplePage.tsx` | ✅ |
| `/app/insights` | `InsightsPage.tsx` | ✅ |
| `/app/ask` | `AskPage.tsx` | ✅ |
| `/app/logs` | `LogsPage.tsx` | ✅ |
| `/` | Redirect → `/app/streams` or `/login` | — |
| `*` | `NotFound.tsx` | ✅ |

**Providers:** QueryClientProvider → TooltipProvider → BrowserRouter → SocketProvider → CameraProvider → AuthProvider → ScrollRevealProvider

---

## ⚠️ Broken Calls (Frontend → Backend Mismatch) — historical note

A 2026-09-24 audit found frontend→backend URL drift (motion-settings and
detection-config query params mis-wired) and ten frontend methods with no backend
route at all. Those were fixed or removed in 2026-09-24 (archived tables below).
The drift class is now caught mechanically by the API contract test whenever the
server suite runs. Run it locally with
`cd server && node --experimental-vm-modules node_modules/.bin/jest --coverage=false src/contract`
(the CI job currently fails the suite on pre-existing coverage thresholds unrelated
to this test, so prefer the `--coverage=false` form; CI remediation is tracked separately).

### API contract enforcement (source of truth)

- **Authoritative list of backend endpoints not called by any frontend service:**
  `server/src/contract/internalEndpoints.json` — 26 admin/ops/legacy endpoints,
  each entry carrying its consumer or reason.
- **Enforcement:** `server/src/contract/__tests__/apiContract.test.ts` asserts
  (A) every frontend `/api` call resolves to a registered route, (B) every
  registered route is frontend-called or allowlisted, (C) allowlist entries are
  non-stale and reasoned. Extractor unit tests live beside it in
  `server/src/contract/__tests__/extractors.test.ts`.
- **Run:** `cd server && npm run test:server -- src/contract` (contract + extractor tests).

<details>
<summary>Archived: 2026-09-24 drift-fix tables (historical)</summary>

| Frontend Call | Fix Applied |
|---------------|-------------|
| `cameraService.getMotionSettings()` | ✅ Fixed URL: `/motion/:camId/settings` → `/detection/motion/settings?cameraId=` |
| `cameraService.updateMotionSettings()` | ✅ Fixed URL: `/motion/:camId/settings` PUT → `/detection/motion/settings` with body `{cameraId}` |
| `settingsService.getDetectionConfig(cam)` | ✅ Fixed URL: `/detection/${cam}` → `/detection?camera=${cam}` |
| `settingsService.updateDetectionConfig(data)` | ✅ Fixed URL: `/detection/${camId}` → `/detection?camera=${camId}` |

| Frontend Method | Reason |
|-----------------|--------|
| `detectionService.getKnownPersons()` | No backend route; PeoplePage uses `personService` instead |
| `detectionService.addKnownPerson()` | No backend route |
| `detectionService.getKnownFaces()` | No backend route |
| `detectionService.deleteKnownFace()` | No backend route |
| `detectionService.retrainFaceModel()` | No backend route |
| `detectionService.registerFace()` | No backend route |
| `systemService.getOpenCVStatus()` | No backend route |
| `systemService.getDetectionStats()` | No backend route |
| `systemService.getDetectionTimeSeries()` | No backend route |
| `systemService.getCameraPerformance()` | No backend route |

</details>

---

## Middleware Stack

| Middleware | Location | Purpose |
|------------|----------|---------|
| `authenticate()` | `middleware/auth.ts` | JWT verification, role check |
| `optionalAuth` | `middleware/auth.ts` | JWT if present, no rejection |
| `requireUser` | `middleware/auth.ts` | Requires authenticated user |
| `requireAdmin` | `middleware/auth.ts` | Requires admin role |
| `go2rtcAuth` | `middleware/go2rtcAuth.ts` | JWT gate on `/go2rtc` proxy (Bearer or `?token=`), also applied to WS upgrade |
| `registerSocketAuth(io)` | `streams/socketAuth.ts` | Socket.io `io.use()` JWT gate — connections without a valid `handshake.auth.token` are rejected |
| `createApiRateLimit()` | `middleware/enhancedRateLimit.ts` | Global API rate limit — mounted before all `/api` routes in `routes/index.ts` |
| `createAuthRateLimit()` | `middleware/enhancedRateLimit.ts` | Auth-specific rate limit |
| `createMfaRateLimit()` | `middleware/enhancedRateLimit.ts` | MFA-specific rate limit |
| `createDetectionRateLimit()` | `middleware/enhancedRateLimit.ts` | Detection-specific rate limit |
| `validateBody(schema)` | `middleware/zodValidation.ts` | Zod body validation |
| `validateQuery(schema)` | `middleware/zodValidation.ts` | Zod query validation |
| `validateParams(schema)` | `middleware/zodValidation.ts` | Zod param validation |
| `compression()` | express built-in | gzip responses |

---

## Key Contexts (React)

| Context | File | Responsibility |
|---------|------|----------------|
| `AuthContext` | `contexts/AuthContext.tsx` | Login/logout, MFA, JWT state |
| `CameraContext` | `contexts/CameraContext.tsx` | Camera list, stream management |
| `SocketContext` | `contexts/SocketContext.tsx` | Socket.io connection lifecycle |
| `ScrollRevealContext` | `App.tsx` | Intersection observer for animations |
