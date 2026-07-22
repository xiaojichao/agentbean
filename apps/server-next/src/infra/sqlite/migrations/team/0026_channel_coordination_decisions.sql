-- #706: 每条人类频道消息的 PI 协调结论。
-- 一 Job 一 Decision（job_id UNIQUE 保证幂等，AC#7）。
-- 只存短理由码与结构化字段；不存完整思维链/prompt/敏感工具输出（AC#4）。
-- 服务端内部表，永不投影到 Team/Web DTO（AC#8）。
CREATE TABLE channel_coordination_decisions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES channel_coordination_jobs(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'failed')),
  intent TEXT CHECK (intent IS NULL OR intent IN ('no_action', 'system_reply', 'clarification_required')),
  reason_code TEXT,
  reply_text TEXT,
  usage_input INTEGER,
  usage_output INTEGER,
  active_model_availability TEXT NOT NULL CHECK (active_model_availability IN ('available', 'unavailable')),
  active_model_card_id TEXT,
  active_model_revision_id TEXT,
  active_model_model_id TEXT,
  response_model TEXT,
  diagnostic_code TEXT,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  system_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
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
  ),
  -- resolved 必须有合法 intent；failed 的 intent 必须为空。
  CHECK (
    (outcome = 'resolved' AND intent IS NOT NULL)
    OR
    (outcome = 'failed' AND intent IS NULL)
  )
);

CREATE INDEX idx_channel_coordination_decisions_channel
  ON channel_coordination_decisions(team_id, channel_id, created_at);
CREATE INDEX idx_channel_coordination_decisions_message
  ON channel_coordination_decisions(message_id);
