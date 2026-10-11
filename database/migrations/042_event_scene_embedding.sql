-- Semantic search: 384-dim MiniLM embedding per event scene description.
-- Nullable: events without embeddings fall back to full-text search (hybrid
-- degrades to keyword-only). Backfill via scripts/backfill-embeddings.py.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE events ADD COLUMN IF NOT EXISTS scene_embedding vector(384);

-- ivfflat needs more rows than we have initially to pick good lists; hnsw is
-- build-once, query-any-time and fine at 60K rows.
CREATE INDEX IF NOT EXISTS idx_events_scene_embedding
  ON events USING hnsw (scene_embedding vector_cosine_ops);

COMMENT ON COLUMN events.scene_embedding IS 'all-MiniLM-L6-v2 384-dim embedding of event scene description (NVIDIA/relations text or structured fallback)';
