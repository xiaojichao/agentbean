ALTER TABLE management_runs ADD COLUMN main_agent_id TEXT;
ALTER TABLE management_runs ADD COLUMN active_agent_id TEXT;
ALTER TABLE management_runs ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'single-agent'
  CHECK (collaboration_mode IN ('single-agent', 'manager-orchestrated', 'handoff'));

CREATE TABLE agent_collaboration_proposals (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  proposal_json TEXT NOT NULL,
  proposal_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (management_run_id, idempotency_key)
);

CREATE TABLE agent_handoffs (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  intent_json TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  invocation_id TEXT REFERENCES agent_invocations(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('requested', 'accepted', 'running', 'returned', 'rejected', 'failed', 'cancelled', 'timed_out')),
  result_json TEXT,
  accepted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (management_run_id, idempotency_key),
  UNIQUE (invocation_id)
);

CREATE INDEX collaboration_proposals_run_created_idx
  ON agent_collaboration_proposals(management_run_id, created_at, id);
CREATE INDEX agent_handoffs_run_created_idx
  ON agent_handoffs(management_run_id, created_at, id);
