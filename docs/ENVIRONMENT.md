# Environment Variables

Complete reference for all SentryVision environment variables. Copy `.env.example` to `.env` and edit.

```bash
cp .env.example .env
```

## Backend (Express)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NODE_ENV` | No | `development` | `production` enables optimizations |
| `PORT` | No | `9753` | Backend HTTP port |
| `DB_HOST` | Yes | `localhost` | PostgreSQL host (`postgres` in Docker) |
| `DB_PORT` | No | `5432` | PostgreSQL port |
| `DB_NAME` | Yes | `sentryvision` | Database name |
| `DB_USER` | Yes | `sentryvision` | Database user |
| `DB_PASSWORD` | Yes | — | Database password |
| `JWT_ACCESS_SECRET` | Yes | — | JWT signing key (access tokens) |
| `JWT_REFRESH_SECRET` | Yes | — | JWT signing key (refresh tokens) |
| `CREDENTIAL_ENCRYPTION_KEY` | Yes | — | Encrypts camera credentials at rest |
| `OPENCV_SERVICE_URL` | No | `http://localhost:8084` | Python OpenCV service URL (`http://opencv:8084` in Docker) |
| `OPENCV_API_TOKEN` | No | — | Auth token for OpenCV service |
| `DETECTIONS_DIR` | No | `./data/detections` | Detection image storage path |
| `TZ` | No | `Asia/Kolkata` | Server timezone |
| `REDIS_DISABLED` | No | `true` | Set `false` to enable Redis cache |
| `REDIS_URL` | No | — | Redis connection string (if enabled) |

## MQTT (optional, Home Assistant integration)

Set `MQTT_ENABLED=true` to publish camera state and detection events to an MQTT
broker. All vars are optional except `MQTT_HOST` when enabled; startup validation
fails fast if `MQTT_ENABLED=true` without `MQTT_HOST`.

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `MQTT_ENABLED` | No | `false` | Enable the MQTT publisher |
| `MQTT_HOST` | Yes (if enabled) | — | Broker host/hostname |
| `MQTT_PORT` | No | `1883` | Broker port |
| `MQTT_TOPIC_PREFIX` | No | `sentryvision` | Root topic for all published messages |
| `MQTT_USER` | No | — | Broker username |
| `MQTT_PASSWORD` | No | — | Broker password |
| `MQTT_QOS` | No | `0` | Quality of service (0/1/2) |

### Published topics

| Topic | Payload | Retained | Meaning |
|-------|---------|----------|---------|
| `{prefix}/availability` | `online` / `offline` | yes | SentryVision broker availability (last-will `offline`) |
| `{prefix}/{camera}/person` | `ON` / `OFF` | yes | Person present on camera |
| `{prefix}/{camera}/status` | `online` / `offline` / `warning` | yes | Camera stream health |
| `{prefix}/{camera}/events` | JSON | no | Detection event (id, camera, type, confidence, timestamp) |
| `homeassistant/binary_sensor/sentryvision_{camera}_person/config` | JSON | yes | HA discovery: person occupancy binary sensor per camera |

## PostgreSQL Tuning

| Variable | Default | Purpose |
|----------|---------|---------|
| `POSTGRES_PASSWORD` | — | Database password |
| `POSTGRES_SHARED_BUFFERS` | `48MB` | Shared memory buffers |
| `POSTGRES_MAX_CONNECTIONS` | `15` | Max connections |
| `POSTGRES_WORK_MEM` | `2MB` | Per-query work memory |
| `POSTGRES_MAINTENANCE_WORK_MEM` | `16MB` | Maintenance operations |
| `POSTGRES_EFFECTIVE_CACHE_SIZE` | `96MB` | OS cache estimate |
| `POSTGRES_CPU_LIMIT` | `0.5` | Docker CPU limit |
| `POSTGRES_MEM_LIMIT` | `512M` | Docker RAM limit |

## Detection Pipeline

| Variable | Default | Purpose |
|----------|---------|---------|
| `PERSON_MIN_CONFIDENCE` | `0.55` | Minimum YOLO confidence for person (Node persistence gate) |
| `PERSON_MIN_TRACK_HITS` | `3` | ByteTracker hits before a person event persists |
| `PERSON_DEDUPE_SHIFT_PX` | `18` | Bbox shift below which a sighting is the same person |
| `PERSON_DEDUPE_WINDOW_MS` | `600000` | Window for that spatial match (10min) |
| `YOLO_MODEL` | — | Force a specific YOLO model (default: auto → yolov8n) |
| `HUMAN_VERIFIER_SCORE` | `0.55` | Score-floor tier threshold for person verification |
| `LOW_RESOURCE_MODE` | `true` | Reduces model memory footprint |
| `FFMPEG_THREADS` | `2` | FFmpeg decode threads |
| `DEFAULT_FPS` | `2` | Default stream FPS |
| `DEFAULT_RESOLUTION` | `640x360` | Default stream resolution |
| `STREAM_INACTIVITY_TIMEOUT` | `300000` | Kill idle streams after 5min |
| `PIPELINE_MODE` | `python-only` | Detection pipeline mode |
| `PYTHON_WS_URL` | `ws://opencv:9090` | Python WebSocket publisher |

## LLM / AI Analysis

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `NVIDIA_API_KEY` | For AI features | — | NVIDIA NIM API key |
| `NVIDIA_API_BASE_URL` | No | — | Custom endpoint (or Ollama) |
| `NVIDIA_MODEL` | No | — | Model name override |
| `AI_ROLE_SCENE` | No | `nvidia` | GenAI provider for scene analysis (`nvidia` \| `local`) |
| `AI_ROLE_CHAT` | No | `nvidia` | GenAI provider for AskPage/chat (`nvidia` \| `local`) |
| `LOCAL_AI_BASE_URL` | If `AI_ROLE_*=local` | — | OpenAI-compatible base URL (llama.cpp / Ollama, e.g. `http://localhost:11434/v1`) |
| `LOCAL_AI_MODEL` | If `AI_ROLE_*=local` | — | Model name/alias (e.g. `qwen2.5:7b`) |

**Terminology note:** Despite the `NVIDIA_` prefix, any OpenAI-compatible endpoint works (Ollama, vLLM, etc.). `AI_ROLE_*` selects which provider handles each role — a role whose provider is missing config falls back to the other configured provider so a dead endpoint never disables a role.

## Detection (OpenCV service)

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `DETECTOR_BACKEND` | No | `auto` | Force inference engine for any model: `ort` (onnxruntime INT8) or `dnn` (cv2.dnn). `auto` keeps the legacy per-model default. |
| `QAT_ORT` | No | `0` | Legacy: `1` runs QAT models via onnxruntime INT8 (superseded by `DETECTOR_BACKEND=ort`) |
| `CAMERA_FACE_CACHE_TTL` | No | `600` | Seconds to retain face embeddings from ended tracks for visitor-session matching |

## Frontend

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `VITE_BACKEND_URL` | No | `http://localhost:9753` | Backend URL for dev mode |

## go2rtc

| Variable | Default | Purpose |
|----------|---------|---------|
| `GO2RTC_PUBLIC_IP` | — | Public IP for WebRTC candidates |
| `GO2RTC_LAN_IP` | auto-detected | LAN IP for WebRTC candidates |

## Generating Secrets

```bash
# JWT secrets (32-byte hex)
openssl rand -hex 32

# Credential encryption key (32-byte hex)
openssl rand -hex 32

# PostgreSQL password
openssl rand -base64 24
```

## Docker vs Local

| Variable | Local Dev | Docker |
|----------|-----------|--------|
| `DB_HOST` | `localhost` | `postgres` |
| `OPENCV_SERVICE_URL` | `http://localhost:8084` | `http://opencv:8084` |
| `PYTHON_WS_URL` | `ws://localhost:9090` | `ws://opencv:9090` |
| `REDIS_DISABLED` | `true` | `true` |
