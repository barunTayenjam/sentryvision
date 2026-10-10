# Plan — Frigate Parity Features (2026-10-10)

## Scope

Adopted from Frigate gap analysis. User decisions:

- **Dropped**: continuous recording (#1), clip export (#2) — timelapse only is sufficient. Visual mask/zone editor (#12), PWA (#13), custom per-camera roles (#14). All of Tier 4 (#15–#18: speed estimation, PTZ autotracking, HomeKit, stationary objects).
- **In scope (8 features)**: review triage queue, motion-only review, MQTT + HA discovery, semantic search, detector backend validation, audio event detection, LPR, active-learning feedback loop.
- **Dropped**: Birdseye — `AdaptiveCameraGrid.tsx` exists but activity-mode composition deferred.

## Verified Current State

| Area | State |
|---|---|
| Review | `reviewService.ts` (232 lines) complete: bundling (30s threshold), severity (`person/car/vehicle/truck` → alert), per-user `UserReviewStatus`, cache. `generateReviewSegments()` has **zero production callers** — only constructed in `serviceRegistry.ts`. No review UI page, no route wiring. |
| Motion events | `detectionPersistence.ts:85` — `event_type` fallback `'motion'` exists; motion snapshots stored via `getEventPath('motion')`. No motion-only listing distinct from tracked objects. |
| MQTT | `config/index.ts:164` — full env-driven config (`MQTT_ENABLED/HOST/PORT/TOPIC_PREFIX/USER/PASSWORD/QOS`), validation at :270. **No client code anywhere** in `server/src`. |
| Semantic search | `eventSearchService.ts` (706 lines) — Postgres full-text only. No embeddings, no vector index. `face_embeddings` = `REAL[]` (128-dim), no pgvector. |
| Detector | `opencv-service/requirements.txt` already has `onnxruntime>=1.15.0` + `onnx==1.16.0` — **unused by detection path**. `pipeline.py:238-278` loads ONNX via `cv2.dnn.readNet`, attempts `DNN_BACKEND_CUDA`, falls back CPU. `model_selection.py` has model chain incl. CrowdHuman QAT 640x384 variants. |
| Audio | Nothing. No audio decode in `ffmpeg_reader.py`, no audio model. |
| LPR | Nothing. |
| Birdseye | `AdaptiveCameraGrid.tsx` exists — adaptive layout + slideshow, no activity-mode composition. |
| Feedback loop | `detectionRedoRoutes.ts` reruns detection on stored frames — no user annotation of FP/FN, no dataset export, no training. |

## Waves

Three drivers for ordering: (1) review backend is written-but-dead — cheapest high-value first; (2) MQTT is small and unlocks external automation; (3) Python pipeline work (detectors, audio, LPR) is heaviest and risks regression — last, after TDD harness confirmed stable.

---

## Wave 1 — Review UX (backend wiring + UI)

### 1. Review triage queue (#10)

**Goal**: Frigate Review page equivalent — Alerts/Detections tabs, per-user reviewed state, batch actions, unreviewed counts.

**Backend** (wire what exists):
- `pipeline/detectionPersistence.ts`: after event persist, call `serviceRegistry.get('reviewService').generateReviewSegments(camera)` — fire-and-forget with `.catch()`, matching existing preview pattern.
- `routes/review.ts` (new): `GET /api/review/segments` (filters: camera/severity/labels/reviewed/after/before, paginated), `POST /api/review/segments/:id/acknowledge`, `POST /api/review/segments/batch-acknowledge`, `GET /api/review/counts` (unreviewed counts per severity for tab badges).
- `serviceRegistry.ts`: register singleton with real deps (timelineService, previewService already available).
- Reuse: `severity` field maps directly to Alerts (`alert`) / Detections (`detection`) tabs.

**Frontend**:
- `views/ReviewPage.tsx` (new route `/review`): two tabs (Alerts/Detections) with unreviewed counts, card grid of segments (preview thumbnail + object chips + camera + time), grey→green reviewed state per Frigate convention, batch mark-reviewed, `Ctrl/Cmd-click` multi-select, keyboard `R` (mark reviewed) + `Esc` (clear).
- Nav entry in `AppFrame` between Live and Events.

**Tests**: jest — segment generation from persisted events, severity calc, batch ack idempotency, per-user isolation (user A ack ≠ user B). API drift test: new routes in extractor.

### 2. Motion-only review tab (#4, recording-free variant)

**Goal**: surface MOG2 motion windows that produced no tracked object — validate tuning, catch missed objects. No recording replay exists in this system, so cards show snapshot + metadata, not video scrub.

**Backend**:
- Python `frame_pipeline.py`: when MotionGate fires and no YOLO detection follows within a window (e.g. 2s), emit lightweight motion-only event (camera, timestamp, motion area %, contour bbox) at reduced rate (one per cooldown, reuse existing `cooldownPeriod`). Publish via existing WebSocket channel with distinct `type: 'motion_only'`.
- `detectionPersistence.ts`: handle `motion_only` — persist as `event_type: 'motion'` with `object_detections: null`, store snapshot.
- Review route: third tab Motion — `severity: 'motion'` filter or separate query on `event_type='motion' AND object_detections IS NULL`.

**Frontend**: Motion tab in ReviewPage — same cards, yellow accent (Frigate color coding), "no object detected" chip.

**Tests**: python pytest — cooldown enforcement, suppression when YOLO fires in window. Server jest — motion_only persistence path.

---

## Wave 2 — Integration

### 3. MQTT publisher + Home Assistant discovery (#3)

**Goal**: publish camera/detection state to MQTT for HA and other automation. Replaces Frigate's biggest integration moat.

**Server**:
- `npm i mqtt` in `server/`.
- `services/mqttService.ts` (new): lazy connect when `config.mqtt.enabled`, QoS from config, reconnect/backoff, retained messages for state topics. Registered in `serviceRegistry`.
- Topics (`{topicPrefix}` default `sentryvision`):
  - `{prefix}/{camera}/person` → `ON/OFF` (retained, last-known track state)
  - `{prefix}/{camera}/events` → JSON event payload on persist
  - `{prefix}/{camera}/status` → `online/offline` (from streamHealthMonitor, retained + LWT `offline`)
  - `{prefix}/availability` → `online` retained, MQTT last-will `offline`
- HA discovery: `{prefix}/binary_sensor/{camera}_person/config` retained JSON (`name`, `state_topic`, `device_class: occupancy`) + one `camera.{camera}` device grouping per camera. MQTT-only, no cloud.
- Wire: `detectionPersistence.ts` (events), `streamHealthMonitor.ts` (status).
- `ENVIRONMENT.md` + `.env.example`: document all existing `MQTT_*` vars (already validated).

**Tests**: jest with `mqtt` mocked — publish on event, retained state transitions, LWT registered, disabled-config = no connect. Startup when `MQTT_ENABLED=true` and no host → existing validation already exits; test confirms.

### 4. Semantic search over events (#11)

**Goal**: natural-language query over 60K+ events. Keep sovereignty: local embedding model, no cloud.

**Server**:
- Migration: `CREATE EXTENSION IF NOT EXISTS vector` + `events.scene_embedding vector(384)` (nullable) + ivfflat index. Guard: if extension unavailable (constrained hosts), feature self-disables and full-text remains — consistent with "runs on anything" principle.
- Embedding source: local sentence-transformer (e.g. `all-MiniLM-L6-v2`, 384-dim) — runs in **opencv-service** (Python, models baked at build per existing Dockerfile pattern). New route `POST /embed` returning vector for text.
- Embed what: (a) `eventMetadataWriter` output — existing NVIDIA/relations scene descriptions when present; (b) fallback: structured caption from labels (`"person detected at front door, night, 2 faces"`). Backfill script `scripts/backfill-embeddings.py` (or server-side batch via opencv `/embed`) for existing events, run once, resumable.
- `eventSearchService.ts`: add `semanticQuery(text, filters)` — `<=>` cosine distance order, hybrid with full-text (semantic candidates ∪ keyword matches, merged ranked). `GET /api/events/search?q=...&mode=semantic|hybrid`.
- `AskPage`/`EventsPage` integration: search bar mode toggle. Triggers concept from Frigate skipped — YAGNI until search proven.

**Tests**: python pytest for `/embed` (dimension, determinism). Server jest — hybrid ranking merge, extension-missing fallback path. Migration up/down.

---

## Wave 3 — Detection pipeline

### 5. Detector backend — RESCOPED 2026-10-10 (mostly done already)

**Finding**: host is Ryzen 5 5500GT, **no GPU** — TensorRT/CUDA/EdgeTPU paths moot. Branch `fix/person-recall-and-face-recognition` already landed the real work:
- Dual QAT chain live: `crowdhuman_v8s_qat_640x384` persons + `coco_qat_640x384` vehicles/animals, ORT INT8 (`frame_pipeline.py:85 OrtRunner`, `QAT_ORT=1`).
- 720p detect feed + motion ROI crop-zoom (commit `c04346a`).
- Benchmark: QAT person recall 0.864 vs COCO 0.780 (3,115 AI-labeled events).

**Remaining work**:
1. Measure `QAT_ORT=1` INT8 speedup vs QDQ-fp32 path (memory records QAT at 145ms vs COCO 93ms — ORT INT8 should close that; no measured numbers on branch yet).
2. Complete pending validation from recall initiative: night walk test, false-positive drift check after overnight 720p+QAT run, open persistence-gate root cause (drop is upstream of verifier, unconfirmed).
3. Health/metrics: `routes/system.py` `/health` reports active backend + inference ms; surface in SettingsHub.

**Quality ceiling after this = fine-tune loop (#7)** — Frigate+'s edge is user-footage training, not a better stock model (`model_selection.py` proves bigger COCO models don't help this footage).

### 6. Audio event detection (#6)

**Goal**: detect glass break / scream / loud bang on cameras with audio — new event type, feeds same alert path.

**opencv-service**:
- `ffmpeg_reader.py`: opt-in second input decode (`-map 0:a:0?`) when `AUDIO_ENABLED=true` per camera (`cameras.json` `"audio": {"enabled": true, "sensitivity": 0.6}`). Cameras without audio stream: `-map` optional flag fails soft.
- New `audio_detector.py`: YAMNet (TF-Hub TFLite, 521 classes → map to ~15 alert classes: `Glassbreak, Screaming, Shout, Gunshot_firearms, Bang, Explosion, Siren, Speech` etc.), 0.96s window @ 16kHz mono, RMS pre-gate to skip silence, confidence threshold per class.
- Emits `audio` event via existing WebSocket publisher → `detectionPersistence` persists `event_type: 'audio'`, `confidence`, class label into `object_detections` JSONB `[{label:"scream", source:"audio"}]`.
- Reviews as severity `detection` (not alert — verify-before-alert principle; audio alone is weak evidence).

**Server**: no schema change (JSONB). Notification service: audio events eligible only if label in user's alert-class list (new `NotificationPreferences` field, default `[]` = off — no new noise).

**Tests**: pytest — wav fixture → class + confidence, silence → no event, camera without audio → no crash. jest — persistence + notification preference gating.

---

## Wave 4 — Learning

### 7. Active-learning feedback loop (#8)

**Goal**: Frigate+-style model improvement, fully local — the sovereignty-differentiator.

**Phase A (annotation, both waves of value alone)**:
- `events` migration: `user_feedback` enum column (`null | 'false_positive' | 'false_negative' | 'confirmed'`), nullable, one verdict per event (update in place).
- `EventsPage` + `EventDetailPanel`: per-event verdict buttons (✓ / ✗-FP / ✗-FN), stored via `PATCH /api/events/:id/feedback`.
- `scripts/export-training-set.py`: dump crops (existing `image_path` + bbox from `object_detections`) + YOLO-format labels to `data/training/`, split train/val. Frigate+ style submission to cloud: **rejected** — data sovereignty principle #1.

**Phase B (fine-tune, opt-in, manual)**:
- `scripts/finetune-yolo.py`: ultralytics fine-tune from `yolov8n.onnx`→`.pt` base, small epochs default (10), output to `models/`.
- `model_selection.py`: accept custom fine-tuned model in `AVAILABLE_MODELS` via `YOLO_MODEL` env (already supported pattern).
- No automatic retraining — manual, explicit, review metrics before swap.

**Tests**: jest — feedback endpoint validation + persistence, export script unit (label format). pytest — model_selection accepts fine-tuned file.

### 8. License plate recognition (#7)

**Goal**: capture plates on vehicle detections — Driveway/gate use case, queried later.

**opencv-service**:
- New `plate_reader.py`, two-stage on vehicle track's best frame (highest-res crop, track end): (1) plate detect — YOLOv8n-plate (open-source, e.g. `anpr` community model) or contour-based via existing MOG2 + geometry filter; (2) OCR — PaddleOCR (CPU-viable) or EasyOCR. Decision after on-device benchmark; PaddleOCR preferred (smaller).
- Result → `detectionPersistence`: plate string + confidence into `object_detections` entry for vehicle track; snapshot crop saved alongside event.
- Privacy: plates only on vehicle tracks (never faces-by-default principle), retention follows event retention, redaction not needed given local-only.

**Server**:
- `eventSearchService`: filter token `plate:<value>` (fuzzy, ILIKE) + `label:car` intersect.
- `EventsPage` filter UI: plate text input.
- Migration: none — JSONB again. Optional materialized `plate_text` column if search proves slow (defer).

**Tests**: pytest — fixture image → plate string, non-plate crop → no emission, per-camera opt-out (`"lpr": {"enabled": false}`). jest — search filter.

---

## Cross-cutting

- Every feature: `npm run lint && npm run typecheck` after frontend changes; `npm run test:server` green; pytest suite green; rebuild flow `cd server && npm run build && docker restart sentryvision-app`, `docker restart sentryvision-opencv` for python hot-mount.
- Migrations: sequential `database/migrations/` numbering, up/down tested.
- No new cloud calls anywhere — all models local, baked into images at build (`download_all_models.py` / relations pattern).
- API drift tests updated with each new route (repo convention).
- Docs updated per feature: `API-SOURCE-OF-TRUTH.md`, `ENVIRONMENT.md`, `OPENCV-SERVICE.md`, `PRODUCT.md` capabilities.

## Execution order + rough size

| # | Feature | Size | Deps |
|---|---|---|---|
| 1 | Review triage queue | M | none |
| 2 | Motion-only review tab | M | #1 (shares UI) |
| 3 | MQTT + HA discovery | M | none (parallel-safe) |
| 4 | Semantic search | L | none (parallel-safe) |
| 5 | Detector backend (rescoped: INT8 measure + validation) | S | none |
| 6 | Audio detection | M | ffmpeg_reader changes |
| 7 | Feedback loop Phase A | S | none; Phase B manual |
| 8 | LPR | L | #5 shipped first (perf headroom) |

1→2 sequential; 3, 4, 7A parallel-safe anytime; 5 before 6/8 for perf headroom.
