-- Daily digest persistence: one concise summary per IST day, regenerable.
-- Push notifications are ephemeral; this table makes digests revisitable.
CREATE TABLE IF NOT EXISTS daily_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  digest_date DATE NOT NULL UNIQUE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '/events',
  event_count INT NOT NULL DEFAULT 0,
  detection_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_daily_digests_date
  ON daily_digests (digest_date DESC);

COMMENT ON TABLE daily_digests IS 'One concise per-day summary (totals, vehicles arrived/left, peaks, threat, highlight); upserted by the 08:00 IST digest job';
