# Plan: Event-grounded RAG — full retrieval + answer pipeline

Date: 2026-10-16 · Status: DONE (all waves shipped + verified live) · Branch: main (per current session practice)

## Goal

Ask answers must be fully grounded in detected events: every event searchable by
natural scene description, retrieval time-aware, answer synthesized from the
retrieved evidence instead of a link table.

## Current state (verified live 2026-10-16)

- pgvector `events.scene_embedding vector(384)` + HNSW index (migration 042) — works.
- Embedder: opencv `/embed`, all-MiniLM-L6-v2 384-dim, X-API-Token auth — works.
- `semanticSearch()` hybrid cosine ∪ ILIKE keyword — works but:
  - **Coverage 201/10,382 events (~2%)** — no ingest hook, backfill never run on live DB.
  - **No caption persisted** — text that produced the embedding is discarded.
  - **Keyword leg searches file_path/metadata/camera** — never object/scene text.
  - **`semantic_search` chat tool has no time range** — "last night" ignored.
  - **Answer = markdown link list**, no synthesis; LLM never sees the hits.
- Rich unused context per event: `scene_context`, `relations` (async), `detection_summary`, `motion_stats`, known/unknown face counts.

## Architecture changes

### Wave 1 — caption + ingest embedding (coverage 100%)

1. Migration `047_event_scene_caption.sql`: `events.scene_caption text`, nullable.
2. New `server/src/services/eventSearch/sceneCaptionService.ts`:
   `buildCaption(event): string` — deterministic text from event_type, severity,
   camera, time-of-day bucket (IST), scene_context env/lighting, object classes
   with counts, persons/faces, known/unknown faces, motion summary, relations as
   "subject predicate object" phrases. Single implementation reused by ingest,
   re-embed, backfill.
3. `pipeline/detectionPersistence.ts`: after event save, fire-and-forget
   `embedEventScene(event)` → caption → `/embed` → `UPDATE ... scene_embedding,
   scene_caption`. Failure = warn log, never blocks persist.
4. `relationQueue` worker: when relations land, rebuild caption + re-embed
   (relations materially change scene text).
5. Backfill: `POST /api/admin/reindex-embeddings` (admin route) batching through
   the same service — one caption implementation, host `.cjs` script dropped.

### Wave 2 — retrieval quality

6. `semanticSearch()` keyword leg: `scene_caption ILIKE` (plus existing fields).
7. `semantic_search` tool schema: optional `from`/`to` resolved via existing
   `dateResolver` tokens ("last night") → filters.startDate/endDate (service
   already supports them).
8. Classifier prompt: pass time tokens for scene questions.

### Wave 3 — grounded answers

9. `semanticSearchTool` → after enrichment, build compact JSON context of hits
   (timestamp, camera, similarity, caption, persons, relations) and call the LLM
   once for a 4–8 sentence narrative, reusing `reportGenerator`'s
   `stripUnverifiedNumbers` guard. Answer cites timestamps + cameras; snapshot
   images still attached. LLM failure → fall back to current link table (never
   breaks the feature).

### Wave 4 — verification

10. TDD each wave (server Jest, `unstable_mockModule` convention).
11. End-to-end live check: backfill run, semantic query via Ask, answer cites events.
12. Docs: `API-SOURCE-OF-TRUTH.md` (admin route), `OPENCV-SERVICE.md` embedder note.

## Explicitly out of scope

- No new vector store / no separate embedding DB (pgvector already live).
- No multi-embedding per event (scene-level caption is the unit).
- No re-ranking model (HNSW + hybrid merge is enough at this scale).
- No frontend changes beyond what already exists (`/events?q=` + Ask page wired).
