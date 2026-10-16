# Plan: Who came or went — person visit + identity understanding

Date: 2026-10-16 · Status: planned (next run) · Owner: user + agent

## Goal

Ask answers "who came or went": named visitors when identity is enrolled,
"unknown person" otherwise, with arrival/departure times per visit.

## Current state (verified 2026-10-16)

- Person data rich: 6,163 events with `persons_detected > 0`, 7,367 person
  detections, each with bbox (trajectory derivable), 2 cameras.
- Face identity chain EMPTY: `visitor_timeline` 0 rows, `face_embeddings` 0,
  `visitors` empty, 0 events with `faces_detected > 0`. Python pipeline
  parses `identity`/`face_embedding` per tracking event (pythonWsClient.ts:51)
  but nothing lands in `events.face_detections` — persistence path drops it
  (`identifiedDets` always empty in detectionPersistence.ts:227).
- Vehicle arrive/left machinery EXISTS and works: `vehicle_timeline` chat tool
  merges track fragments into visits by 5-min gaps (SESSION_GAP_MS) — same
  pattern reusable for persons.
- Face clusters API exists (`/api/face-clusters`) + PeoplePage UI.

## Waves

### Wave 1 — person visits (arrive/left, anonymous)

1. `personVisits` chat tool (queryTools.ts): person tracks per camera/day →
   merged into visits by SESSION_GAP (reuse vehicle merge logic — extract to
   shared `visitMerger` helper). Visit = {camera, firstSeen, lastSeen,
   durationMin, trackCount, entrySide, exitSide}.
2. Entry/exit direction: bbox x-centroid of first vs last detection frames vs
   camera zone edges (cameras cover gate areas) → "arrived from left",
   "left toward gate". Keep simple: dominant direction label only.
3. Classifier prompt: new tool token — "who came", "when did someone leave",
   "did anyone visit while I was out".
4. TDD: visit merger unit tests (gap split, direction label), tool tests,
    routing tests.

### Wave 2 — face identity chain repair (the "who")

5. Fix persistence: face detections + identity from tracking events land in
   `events.face_detections` (detectionPersistence.ts `identifiedDets` bug).
6. Enrollment: PeoplePage "name this person" on a face cluster → inserts
   `visitors` + `face_embeddings` (pipeline already computes embeddings).
7. Recognition loop: Python InsightFace matches enrolled embeddings →
   tracking event `identity` → event caption gains named-visit text
   (sceneCaptionService: "barun arrived" vs "unknown person") → re-embed via
   existing hook → RAG search finds "when did barun come" semantically.
8. TDD: persistence test (face fields land), caption test (named visitor).

### Wave 3 — Ask synthesis

9. `person_visits` answers cite identity when known: "barun arrived 09:12,
   left 09:25 (13 min, cam1 gate)" / "unknown person visited 14:00-14:08".
10. Synthesis via existing `synthesizeSemanticAnswer` pattern.

## Out of scope

- Multi-camera identity handoff (same person cam1→cam2) — later.
- Clothing/attributes matching (pose attributes already stored, unused here).
- Re-identification without faces (gait etc.).
