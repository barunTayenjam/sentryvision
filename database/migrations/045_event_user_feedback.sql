-- Feedback loop Phase A: per-event user verdict for model fine-tuning dataset.
-- One verdict per event, updated in place. Never auto-retrains (sovereignty).
-- Verdicts feed scripts/export-training-set.py (YOLO-format dataset export).
ALTER TABLE events ADD COLUMN IF NOT EXISTS user_feedback text
  CHECK (user_feedback IS NULL OR user_feedback IN ('false_positive', 'false_negative', 'confirmed'));

CREATE INDEX IF NOT EXISTS idx_events_user_feedback
  ON events(user_feedback) WHERE user_feedback IS NOT NULL;

COMMENT ON COLUMN events.user_feedback IS 'User verdict: false_positive | false_negative | confirmed; updated in place, one verdict per event';
