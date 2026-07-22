CREATE TABLE channel_coordination_jobs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retry_wait', 'completed', 'failed', 'cancelled')),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  next_retry_at INTEGER,
  active_model_availability TEXT NOT NULL CHECK (active_model_availability IN ('available', 'unavailable')),
  active_model_card_id TEXT,
  active_model_revision_id TEXT,
  active_model_model_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (active_model_availability = 'available'
      AND active_model_card_id IS NOT NULL
      AND active_model_revision_id IS NOT NULL
      AND active_model_model_id IS NOT NULL)
    OR
    (active_model_availability = 'unavailable'
      AND active_model_card_id IS NULL
      AND active_model_revision_id IS NULL
      AND active_model_model_id IS NULL)
  )
);

CREATE INDEX idx_channel_coordination_jobs_runnable
  ON channel_coordination_jobs(status, next_retry_at, created_at);
CREATE INDEX idx_channel_coordination_jobs_channel
  ON channel_coordination_jobs(channel_id, created_at);
