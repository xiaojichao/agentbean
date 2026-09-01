CREATE TABLE IF NOT EXISTS message_route_analyses (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  message_revision INTEGER NOT NULL CHECK (message_revision > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'deferred', 'resolved', 'failed', 'superseded')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_retry_at INTEGER,
  route_kind TEXT CHECK (route_kind IS NULL OR route_kind IN ('chat_only', 'direct_agent', 'collaboration', 'complex_task', 'clarification')),
  intent_source TEXT CHECK (intent_source IS NULL OR intent_source IN ('pi', 'deterministic_fallback')),
  risk_level TEXT CHECK (risk_level IS NULL OR risk_level IN ('low', 'high')),
  target_agent_ids_json TEXT NOT NULL DEFAULT '[]',
  required_capability_ids_json TEXT NOT NULL DEFAULT '[]',
  linked_task_id TEXT,
  diagnostic_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (message_id)
);

CREATE INDEX IF NOT EXISTS idx_message_route_analyses_runnable
  ON message_route_analyses(status, next_retry_at, updated_at, created_at);
