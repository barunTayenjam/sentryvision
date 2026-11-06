# SentryVision Release Notes

## SentryVision v1.7.2 — Cheap Stream Profile

**Release date**: November 2026

Live viewing now costs ~250 kbps per tile instead of 1.5–4 Mbps, on both LAN
and internet. Designed for FUP-limited connections and remote viewers over
cloudflared (WebRTC UDP cannot cross the tunnel; those viewers use MSE).

### Streaming

- **`h264_cheap` go2rtc profile** (640×360 @ 10 fps @ 250 kbps, measured
  ~255 kbps): every grid *and* focused tile pulls it. The 1440p main stream
  is never sent to a browser. Transcoder spawns per viewer, costs nothing idle.
- **HD 60s burst**: focused tiles get a button that raises the profile to the
  720p substream (1500 kbps) for one minute, then reconnects to cheap.
- **Hidden-tab teardown**: a tab hidden for 30 s stops streaming and resumes on
  return. Start paths refuse to run while hidden; the teardown timer is
  re-armed on every effect run; a resume suppressed by the restart cooldown
  retries once.
- **JPEG relay opt-out**: `requestStream` accepts `frames: false` (default
  `true`). Video-decoding clients opt out, saving ~4.5 Mbps per camera of
  relayed JPEGs nobody rendered. The flag survives socket reconnect replay.
- **Canvas fallback removed**: a failing MSE path now surfaces an error or
  retries MSE once — it never silently switches to a costlier transport.
  Remote (WAN) viewers skip the 5 s WebRTC timeout and go straight to MSE.

### Fixes

- `next build` unblocked: unused `SortOption` type in the Faces Gallery had
  failed every build since the gallery landed, leaving the deployed bundle
  stale.

## SentryVision v1.7.1 — Honest Detection Pipeline

**Release date**: October 2026

This release replaces guessed person attributes with measured ones, closes the
ghost-detection loopholes, and surfaces real pipeline metadata in the UI.

### Detection Pipeline

- **Pose-grounded person attributes**: the 33 MediaPipe landmarks the verifier
  already computed now feed `pose_features.py` (stance / facing / arms raised /
  torso lean). Removed fabrications: `estimatedAge` (was a distance lookup),
  `suspicious` bodyLanguage (was bbox aspect, worth +20 threat points on
  bystanders), `side_view_or_crouching`, and the `back_or_side` facing fallback.
- **Person persistence gate** (Node): a person event persists only with
  ≥ `PERSON_MIN_TRACK_HITS` (3), score ≥ `PERSON_MIN_CONFIDENCE` (0.55), and no
  explicit rejection — one-frame ghosts no longer become person events.
- **Person dedupe tuning**: 18px spatial window over 10 minutes
  (`PERSON_DEDUPE_SHIFT_PX` / `PERSON_DEDUPE_WINDOW_MS`).
- **ByteTrack round-2 recovery**: leftover strong detections re-associate with
  lost tracks, eliminating duplicate track_ids that kept tracklet_len at 2.
- **Snapshot-space bboxes**: bounding boxes are published in the event image's
  pixel space (`bboxSpace: 'image'`), with a backfill script for historical rows.

### Frontend

- Events page renders what the pipeline measured: detection summary, pose chips,
  person attributes, and verification verdict (Verified / Rejected / Unknown)
  via `lib/detectionMeta` + `lib/mapEnhancedEvent` (vitest-tested).
- Slideshow hardening: stable interval timer, document-level keyboard nav,
  fullscreen-exit ends the slideshow.

## SentryVision v1.7.0 — Analytics, Chat & Codebase Hardening

**Release date**: September 2026

This release introduces daily analytics insights, an AI chat interface querying detection data, system log viewer, timelapse backfill capabilities, and comprehensive codebase hardening with full documentation.

### New Features

- **Daily Insights Dashboard (`/app/insights`)**: 25+ analytics dimensions, hourly stacked type distribution, threat breakdown, activity heatmap, peak burst tracking, and quiet gap detection.
- **Ask Page (`/app/ask`)**: AI chat interface powered by NVIDIA NIM / Ollama with tool calling over recorded detection data, Markdown answers, and report export.
- **System Logs Viewer (`/app/logs`)**: Dedicated viewer with level filtering (warn, error, info), service filtering (backend, opencv), and live auto-refresh.
- **Timelapse Backfill (`/app/timelapse`)**: On-demand timelapse generation and regeneration for past dates directly from the web UI.

### Architecture & Hardening

- **API Source of Truth**: Full inventory of ~108 endpoints mapped across all 20 route modules (`API-SOURCE-OF-TRUTH.md`).
- **Endpoint URL Alignment**: Fixed detection config and motion settings parameter mismatches between frontend services and backend routes.
- **Dead Code Cleanup**: Removed 10 orphaned API methods in `detectionService.ts` and `systemService.ts` that had no backend counterpart.
- **Documentation Overhaul**: Consolidated all project documentation into the root directory; removed 33 obsolete/stale docs.
- **ADRs Published**: Formalized architectural direction for Zustand state management (ADR-001), service decomposition (ADR-002), and backend MVC consistency (ADR-003).

---

## SentryVision v1.6.0 — Resource Optimizations

**Release date**: June 2026

This release fundamentally re-architects the SentryVision stack for low-resource hardware (2GB RAM / 2-core CPU), fixes the Python RTSP camera connectivity pipeline end-to-end, upgrades the detection model to YOLOv8n, and adds a one-click install script.

---

## Breaking Changes

- **Frontend no longer runs as a separate container.** The frontend is now compiled at build time and served as static files by the backend. Docker Compose drops from 5 to 4 services. If you were running the frontend standalone in development, use `npm run dev` from `frontend/` for HMR (`:5173`), or let the backend serve it (`:9753`).
- **Redis is disabled by default.** The in-memory cache replaces Redis entirely unless `REDIS_DISABLED=false` is set. This saves ~150MB RAM on low-end hardware.
- **YOLOv4-tiny replaced with YOLOv8n.** The ONNX model is baked into the Docker image. Existing weights in `opencv-service/models/` will be ignored in favor of the built-in model.

---

## New Features

### One-Click Install (`scripts/install.sh`)

- Zero-interaction install: detects LAN IP, generates secure secrets (`openssl rand`), writes `.env`, creates empty camera configs, builds and starts everything.
- `curl -fsSL https://raw.githubusercontent.com/barunTayenjam/sentryvision/main/scripts/install.sh | bash`
- Cameras are added later through the web UI — no terminal editing required.
- Re-runnable: running again detects the existing install and rebuilds if needed.

### go2rtc Integration

- go2rtc (`alexxit/go2rtc:1.9.14`) proxies at `/go2rtc` via `http-proxy-middleware` in Express.
- Manual WebSocket upgrade handler (not `proxy.ws:true`) to avoid intercepting Socket.io paths.
- WebRTC candidates auto-populated (LAN IP + optional public IP via entrypoint script).
- Single RTSP connection to cameras — Python FFmpegReader consumes go2rtc's internal re-stream instead of connecting to cameras directly.

### Class-Whitelisted YOLOv8n Detection

- YOLOv8n ONNX (~215ms inference, 2× faster than YOLOv5n at higher mAP).
- Class whitelist (`_relevant_classes`) restricts to: `person`, `car`, `truck`, `bus`, `motorcycle`, `bicycle`, `dog`, `cat`, `bird`, `horse`. Blocks COCO false positives (`train`, `surfboard`, `vase`, `potted plant`).
- Tuned confidence thresholds: person 0.30, car 0.35, default 0.50.

### Stream Fallback Chain

- **WebRTC** (lowest latency, LAN only — UDP via port 8555).
- **MSE** (fMP4 via WebSocket — works through Cloudflare Tunnel TCP-only).
- **Canvas** (last resort — JPEG frames from Python pipeline).
- Watchdog fallback for stuck `'connecting'` state.

---

## Bug Fixes

### Python RTSP Pipeline (Root Cause of Zero Frames)

- **Camera RTSP connection limit**: TP-LINK cameras reject a 2nd concurrent RTSP connection with `Operation not permitted`. go2rtc now holds the sole allowed slot; Python reads from `rtsp://go2rtc:8554/{camera_id}` instead of hitting cameras directly.
- **Collapsed dual FFmpeg readers to single reader per camera**: Both previously connected to the same go2rtc stream, wasting one FFmpeg + one RTSP connection per camera.
- **Removed VAAPI hwaccel flags** (`-hwaccel vaapi -hwaccel_device /dev/dri/renderD128`) from `ffmpeg_reader.py` — no longer needed (and was crashing on non-Intel hosts).
- **Fixed YOLOv8 ONNX output parsing**: Transposes `(84,8400)` → `(8400,84)` and uses unified pixel-space bbox scaling (640×640 blob, not normalized).

### Backend API Fixes

- **Fixed 6 hanging detection endpoints**: `authenticate` → `requireUser` middleware mismatch in `detectionRoutes.ts` and `detectionRedoRoutes.ts`.
- **Fixed CSP for WebSocket/MediaSource/workers**: Relaxed helmet Content-Security-Policy to allow `ws:` connections and Web Workers.
- **Immutable cache headers**: Added `Cache-Control: public, max-age=31536000, immutable` for content-hashed static assets.
- **Fixed MSE settle race condition**: `video.srcObject = ms` → `video.src = URL.createObjectURL(ms)`.

### Frontend

- **Stream reconnection stability**: Rewritten `CameraStream.tsx` with robust fallback chain, proper lifecycle cleanup, and watchdog timer.
- **Grid layout fix**: Fixed height calculation so the camera grid doesn't overflow.

---

## Performance Improvements

| Metric                      | Before (1.5.0)                                     | After (1.6.0)                            |
| --------------------------- | -------------------------------------------------- | ---------------------------------------- |
| Containers                  | 5 (frontend + backend + opencv + postgres + redis) | 4 (backend + opencv + postgres + go2rtc) |
| RAM idle                    | ~2.1 GB                                            | ~700 MB                                  |
| RAM full pipeline           | ~3.5 GB                                            | ~1.5 GB                                  |
| YOLO inference              | ~400ms (YOLOv5n)                                   | ~215ms (YOLOv8n)                         |
| RTSP connections per camera | 2 (FFmpeg × 2)                                     | 1 (go2rtc → multiple consumers)          |

---

## Infrastructure Changes

- **Docker Compose reduced from 5 to 4 services**: Removed `frontend` and `redis` services; added `go2rtc`.
- **Resource limits tuned**: PostgreSQL 256M/0.5 CPU, Backend 512M/1 CPU, OpenCV 2G/2 CPU, go2rtc 128M/0.5 CPU.
- **PostgreSQL tuned for low memory**: `shared_buffers=64MB`, `max_connections=20`, `work_mem=4MB`, `huge_pages=off`.
- **OpenCV image rebuilt**: Python dependencies streamlined, YOLOv8n ONNX baked into image (no runtime download).

---

## Full Changelog

```
e31e723 fix: Python pipeline RTSP connectivity + YOLOv8n upgrade + detection accuracy
75bf2ce fix: detection route hang + MSE stream settle race + go2rtc proxy fixes
6bfdb9b chore: bump version to 1.5.0
3ce0502 fix: stabilize live stream reconnection + cleanup Dockerfiles
bfc74a8 fix: eliminate all catch (error: any) + Record<string, any> in server
10425d0 fix: add logging to 11 empty catch blocks across server and frontend
4f2b16c docs: fix AGENTS.md migration count (28→26) and remove false strict mode claim
c10631f fix: add auth guards, MFA rate limit, fix .dockerignore, remove root dep dupes
af06f90 fix: nginx backend port, go2rtc version pin, remove unused vulnerable deps
e45011b fix: WebRTC-then-fallback streaming, grid layout height fix
debf17a refactor: DB-first camera loading, stream stability fixes, go2rtc public IP support
```

## Upgrade Guide

### From v1.5.0

```bash
git pull
docker compose down --remove-orphans
docker compose up -d --build
```

**Post-upgrade steps:**

1. Remove old `redis` service if you had one in your compose override.
2. If you had YOLO weights in `opencv-service/models/`, they are replaced by the baked-in model.
3. Update `go2rtc.yaml` if you were running go2rtc separately — the new config uses port 8555 for WebRTC.

### Fresh Install

```bash
bash scripts/install.sh
```

Or the one-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/barunTayenjam/sentryvision/main/scripts/install.sh | bash
```
