CREATE TABLE team_management_policies (
  team_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'shadow', 'managed')),
  placement_policy_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE managed_request_reservations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  management_run_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, request_key)
);

CREATE TABLE management_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_task_id TEXT,
  root_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_agents', 'waiting_for_user', 'recovering', 'in_review', 'completed', 'failed', 'cancelled')),
  placement_policy_json TEXT NOT NULL,
  active_worker_id TEXT,
  checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
  budget_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE manager_leases (
  management_run_id TEXT PRIMARY KEY REFERENCES management_runs(id) ON DELETE CASCADE,
  worker_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL,
  lease_fingerprint TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE TABLE management_events (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'manager', 'agent', 'human')),
  actor_id TEXT,
  idempotency_key TEXT NOT NULL,
  causation_event_id TEXT,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (management_run_id, sequence),
  UNIQUE (management_run_id, idempotency_key)
);

CREATE TABLE management_checkpoints (
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  checkpoint_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (management_run_id, revision)
);

CREATE TABLE agent_invocations (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  intent_json TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (management_run_id, idempotency_key)
);

CREATE TABLE invocation_dispatch_attempts (
  id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(id) ON DELETE CASCADE,
  dispatch_id TEXT NOT NULL UNIQUE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (invocation_id, attempt_number)
);

CREATE UNIQUE INDEX one_active_dispatch_attempt_per_invocation
  ON invocation_dispatch_attempts(invocation_id)
  WHERE status IN ('queued', 'sent', 'accepted', 'running');

CREATE TABLE management_shadow_decisions (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  input_hash TEXT NOT NULL,
  objective_hash TEXT NOT NULL,
  argument_hash TEXT NOT NULL,
  target_json TEXT NOT NULL,
  tool_sequence_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX management_runs_team_created_idx ON management_runs(team_id, created_at, id);
CREATE INDEX management_events_run_sequence_idx ON management_events(management_run_id, sequence);
CREATE INDEX agent_invocations_run_created_idx ON agent_invocations(management_run_id, created_at, id);
