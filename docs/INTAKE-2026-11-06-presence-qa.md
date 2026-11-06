# SentryVision intake — questions with answers (2026-11-06)

`[SYS]` = verified from repo/DB/containers today · `[YOU]` = owner must answer.

## A. Cameras and physical setup

1. **What does each camera see? Indoor/outdoor?**
   [YOU] — cameras.json names them only "Camera 1"/"Camera 2"; no placement data exists in the system.
2. **Camera at entry/exit threshold at face height?**
   [YOU] — no zone config exists to tell.
3. **Parked vehicles visible? Spots, covered/open?**
   [SYS] Both cameras track `car, motorcycle, bicycle` (cameras.json `objects.track`), so vehicle detection is on wherever they point. Spot count/coverage: [YOU].
4. **Bedroom camera, or infer wake-up?**
   [YOU]. No bedroom indication anywhere in config.
5. **Third camera possible?**
   [SYS] Yes, technically trivial: pipeline is generic over the camera list — `CAM3_RTSP_URL` env + 2 go2rtc.yaml entries + cameras.json row. Budget/interest: [YOU].
6. **IR/night modes, night quality at gate?**
   [SYS] A `nightMode` flag exists on the Camera model (currently false); detection pipeline has day/night score floors (0.55/0.55). Actual IR quality: [YOU].
7. **Blind spots (back door, side gate)?**
   [YOU] — two cameras cannot cover a full perimeter unless placement says otherwise.

## B. People and identities

1. **Household roster, how many named people?**
   [YOU].
2. **Regular visitors — named or unknown?**
   [YOU]. System has no visitor identity concept beyond `visitorId` on embeddings.
3. **Appearance that defeats face recognition (masks/caps/beard)?**
   [YOU].
4. **Children/elderly affecting accuracy or sensitivity?**
   [YOU].
5. **Face clustering (046) status + ArcFace enrollments?**
   [SYS] **`face_embeddings` has 0 rows — nobody is enrolled; every live identity is `"unknown"`.** 046 is uncommitted exploratory WIP (moved to `migrations/wip/` for safety). Its design: `face_clusters` table, one row per person, `name` NULL until user assigns, 512-d ArcFace centroid, written by `cluster_and_populate.py`, read live by the recognizer, served at `/api/face-clusters`. So the identity layer is mid-pivot: embeddings → clusters → user-assigned names. Completion status: [YOU].

## C. The questions you want answered

1. **List 15–20 day-to-day questions:** [YOU].
2. **"When did dad wake up" — first-sighting good enough?** [YOU]. [SYS] No bedroom sensor exists; first-sighting-in-hall is the best available without new hardware.
3. **"Left and returned" — house, compound, or gate? Car trip counts?** [YOU].
4. **Unknown persons — all strangers, or only near-house / nobody-home?** [YOU].
5. **Vehicles — counts, ownership, type/color, plates?** [SYS] YOLO gives class only (car/motorcycle/bicycle); color from person-attribute-style analysis is not built for vehicles; no LPR wired into events (an LPR module exists in opencv-service but is separate). Which level you need: [YOU].
6. **Past vs right-now questions?** [YOU]. [SYS] Both are feasible — events table + scene embeddings support historical queries.
7. **Proactive alerts/daily summary vs on-demand?** [SYS] A `dailyDigestService` and notification stack (Web Push, VAPID) already exist. Preference: [YOU].
8. **Who asks, on what surface?** [YOU]. [SYS] Web app is the only client today; multi-user auth + MFA + roles exist.

## D. Current code and data

1. **Events table contents + sample rows:**
   [SYS] 27,452 rows, 2026-10-03 → 2026-11-06 (~34 days). Columns: `event_type, file_path, thumbnail_path, timestamp, camera_id, metadata, confidence, persons_detected, faces_detected, known_faces_count, unknown_faces_count, object_detections jsonb, face_detections jsonb, severity, scene_context, threat_assessment, detection_summary, motion_stats, relations, scene_embedding vector(384), scene_caption, user_feedback`.
   Sample (latest person event): `object_detections[0] = {class:"person", trackId:1224, identity:"unknown", confidence:0.80, humanVerified:true, verificationTier:"score_floor", trackletLen:3, bbox, personAttributes:{clothing:"green and yellow-green", distance:"medium", position, torsoLeanDeg:0, bbox_original}}`, snapshot at `/app/data/detections/2026-11/.../motion_cam2_..._t1224.jpg`.
2. **Payloads:** [SYS] `personDetected = {cameraId, timestamp, persons: DetectionResult[], imagePath}` · `faceDetected = {cameraId, timestamp, faces: FaceDetection[], imagePath}` · `persons_detected` = integer count. **Track IDs: yes. Identity: string only ("unknown" today). Zones: no.**
3. **Identity concept today:** [SYS] `face_embeddings` (uuid, `visitor_id`, 128-d real[] vector, quality metrics, image path) — 0 rows. No people/names table. WIP `face_clusters` (046) adds cluster identity + user-assigned names.
4. **IdentityEnrichment matching:** [SYS] ArcFace cosine distance on L2-normalized embeddings, tolerance 0.32 (≈0.68 similarity), single best match, no voting (`arcface_recognizer.py:481-510`). Per-track identity cache TTL 30 s (`frame_pipeline.py:749`). Failure → `"unknown"`, never crashes.
5. **services/chat today:** [SYS] 8 files, 2,385 LOC. TS-side tool dispatch (not LLM-native function calling): `queryTools` has `clusterSessions` (session clustering), `vehicleTimeline`, `cameraActivity`, `eventCorrelation`, `detectDailyAnomalies`. Retrieval: event-grounded RAG via `eventSearchService` (vector `scene_embedding` 384 + keyword). Models from `.env`: `NVIDIA_MODEL=kilocode/openrouter/free` (cloud), `OLLAMA_MODEL=gemma3:4b` (local), `JEV_MODEL=cf/@cf/cloudflare/clef-flash` (cloud). Entry: `server/src/services/chat/queryHandler.ts`.
6. **History and cleanliness:** [SYS] ~34 days, continuous (detected a motorcycle event at sampling time). Retention/cleanup services exist; actual retention settings: [YOU check Settings UI].
7. **Zones / line-crossing / home-away today:** [SYS] **None.** Grep across server + opencv found nothing; cameras.json has no zones. Only adjacent piece: chat session clustering.

## E. Compute and models

1. **Hardware/headroom:** [SYS] AMD Ryzen 5 5500GT (6C/12T, iGPU, **no dGPU**), 30 GB RAM, host also runs ~68 containers. YOLOv8 CPU inference already runs 24/7. A second periodic YOLO job is feasible but tight — measure first.
2. **Gateway routing local vs cloud:** [SYS] 9router at `192.168.31.99:20128` (LAN, plaintext HTTP). Known model IDs: `kilocode/openrouter/free` (cloud), `gemma3:4b` (local Ollama), `cf/@cf/cloudflare/clef-flash` (cloud). Full routing table lives in 9router config, not this repo. [YOU] confirm which IDs route cloud.
3. **Cloud LLM acceptable for names/timestamps/snapshots? Local tool-calling model?** [YOU]. [SYS] Current default chat model is a cloud route; Ollama `gemma3:4b` is wired but its tool-calling capability is unverified.

## F. Privacy, legal, household

1. **Household consent to tracking + face recognition?** [YOU].
2. **Retention for embeddings, presence history, visitor snapshots?** [YOU]. [SYS] Embeddings: plaintext at rest, no purge path. Snapshots: under `data/detections/YYYY-MM`, retention service governs.
3. **Delete-person path + encrypted embeddings in scope?** [YOU]. [SYS] Neither exists; both buildable.
4. **Per-person permissions?** [YOU]. [SYS] Multi-user + MFA + roles exist, so it's supported if wanted.

## G. Scope, timeline, process

1. **Demo vs product, deadline:** [YOU].
2. **Hours per week:** [YOU].
3. **Who writes code (you / Claude Code / both); comfort with Python+TS pipeline changes:** [YOU].
4. **Error tolerance — "inferred, low confidence" vs silence unless sure:** [YOU].
5. **First working slice (dad-home / vehicles / unknown visitors):** [YOU]. [SYS] Note: **"is dad home" requires the identity layer that currently has zero enrollments** — identity is the critical path for any person-named feature. Vehicles/unknown-visitors need no identity work.
6. **Non-negotiables (no new containers / cameras / cloud / schema changes):** [YOU].
