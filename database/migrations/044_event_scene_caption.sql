-- Persist the caption text that produced each event's scene embedding.
-- Re-embedding on model change, keyword search over the same text, and
-- answer grounding all need the source text, not just the vector.
ALTER TABLE events ADD COLUMN IF NOT EXISTS scene_caption text;

CREATE INDEX IF NOT EXISTS idx_events_scene_caption
  ON events USING gin (to_tsvector('english', scene_caption));

COMMENT ON COLUMN events.scene_caption IS 'Deterministic scene caption (sceneCaptionService) whose embedding is stored in scene_embedding';
