-- #707: 扩展 channel_coordination_decisions——intent 放开到 6 值 + 门禁审计列。
-- SQLite 不能 ALTER CHECK，故重建表（create-new + copy + drop + rename，与 0021 同惯例）。
-- 生产仍走 legacy，无历史数据；copy 仅作安全兜底。
CREATE TABLE channel_coordination_decisions_new (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES channel_coordination_jobs(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('resolved', 'failed')),
  intent TEXT CHECK (intent IS NULL OR intent IN (
    'no_action', 'system_reply', 'clarification_required',
    'agent_request', 'tracked_task', 'task_followup'
  )),
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
  gate_status TEXT CHECK (gate_status IS NULL OR gate_status IN ('proposed', 'suggested', 'applied', 'blocked')),
  risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('low', 'high')),
  objective TEXT,
  target_agent_id TEXT,
  linked_task_id TEXT,
  blocking_reason TEXT,
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
  CHECK (
    (outcome = 'resolved' AND intent IS NOT NULL)
    OR
    (outcome = 'failed' AND intent IS NULL)
  )
);

INSERT INTO channel_coordination_decisions_new (
  id, job_id, team_id, channel_id, message_id, outcome, intent, reason_code, reply_text,
  usage_input, usage_output, active_model_availability, active_model_card_id,
  active_model_revision_id, active_model_model_id, response_model, diagnostic_code,
  attempt, system_message_id, idempotency_key, created_at, updated_at
)
SELECT
  id, job_id, team_id, channel_id, message_id, outcome, intent, reason_code, reply_text,
  usage_input, usage_output, active_model_availability, active_model_card_id,
  active_model_revision_id, active_model_model_id, response_model, diagnostic_code,
  attempt, system_message_id, idempotency_key, created_at, updated_at
FROM channel_coordination_decisions;

DROP TABLE channel_coordination_decisions;
ALTER TABLE channel_coordination_decisions_new RENAME TO channel_coordination_decisions;

CREATE INDEX idx_channel_coordination_decisions_channel
  ON channel_coordination_decisions(team_id, channel_id, created_at);
CREATE INDEX idx_channel_coordination_decisions_message
  ON channel_coordination_decisions(message_id);
