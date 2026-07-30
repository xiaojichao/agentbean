-- #930 Team PI authority cutover 与 legacy 兼容退役（ADR-0068）
-- 持久化 authority epoch / migration revision / readiness token / drain lineage / 退役指标。

CREATE TABLE team_pi_authority_migrations (
  team_id TEXT PRIMARY KEY,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
  migration_revision INTEGER NOT NULL CHECK (migration_revision >= 0),
  state TEXT NOT NULL CHECK (state IN (
    'legacy', 'shadow', 'cutover_pending', 'new_authority', 'legacy_read_only', 'retired'
  )),
  legacy_writer_fenced INTEGER NOT NULL CHECK (legacy_writer_fenced IN (0, 1)),
  emergency_stop INTEGER NOT NULL CHECK (emergency_stop IN (0, 1)),
  cutover_version INTEGER,
  cutover_at INTEGER,
  cutover_by TEXT,
  drain_deadline_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE pi_cutover_readiness_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  migration_revision INTEGER NOT NULL CHECK (migration_revision >= 0),
  current_epoch INTEGER NOT NULL CHECK (current_epoch >= 0),
  target_epoch INTEGER NOT NULL CHECK (target_epoch >= 1),
  current_state TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  all_passed INTEGER NOT NULL CHECK (all_passed IN (0, 1)),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX pi_cutover_readiness_snapshots_team_idx
  ON pi_cutover_readiness_snapshots(team_id, issued_at);

CREATE TABLE pi_cutover_readiness_tokens (
  token_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  target_epoch INTEGER NOT NULL CHECK (target_epoch >= 1),
  migration_revision INTEGER NOT NULL CHECK (migration_revision >= 0),
  readiness_snapshot_id TEXT NOT NULL,
  issued_to TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE INDEX pi_cutover_readiness_tokens_team_idx
  ON pi_cutover_readiness_tokens(team_id, issued_at);

CREATE TABLE message_authority_epoch_bindings (
  message_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  source_lineage_key TEXT NOT NULL,
  authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
  migration_revision INTEGER NOT NULL CHECK (migration_revision >= 0),
  bound_at INTEGER NOT NULL,
  client_message_id TEXT
);

CREATE INDEX message_authority_epoch_bindings_lineage_idx
  ON message_authority_epoch_bindings(source_lineage_key);

CREATE UNIQUE INDEX message_authority_epoch_bindings_client_msg_idx
  ON message_authority_epoch_bindings(client_message_id)
  WHERE client_message_id IS NOT NULL;

CREATE TABLE legacy_drain_lineages (
  drain_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  lineage_key TEXT NOT NULL,
  job_id TEXT NOT NULL,
  cutover_version INTEGER NOT NULL CHECK (cutover_version >= 1),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  drain_lease_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draining', 'completed', 'expired', 'recovery_pending')),
  deadline_at INTEGER NOT NULL,
  result_message_id TEXT,
  result_payload_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX legacy_drain_lineages_lineage_idx
  ON legacy_drain_lineages(lineage_key);

CREATE INDEX legacy_drain_lineages_team_state_idx
  ON legacy_drain_lineages(team_id, state);

CREATE TABLE legacy_compatibility_projections (
  source_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN (
    'coordination_job', 'coordination_decision', 'management_run_legacy'
  )),
  payload_json TEXT NOT NULL,
  projected_at INTEGER NOT NULL,
  PRIMARY KEY (projection_kind, source_id)
);

CREATE TABLE legacy_write_attempt_audits (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  write_kind TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX legacy_write_attempt_audits_team_idx
  ON legacy_write_attempt_audits(team_id, created_at);

CREATE TABLE pi_authority_cutover_audits (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX pi_authority_cutover_audits_team_idx
  ON pi_authority_cutover_audits(team_id, created_at);

CREATE TABLE pi_authority_cutover_outbox (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  event_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX pi_authority_cutover_outbox_pending_idx
  ON pi_authority_cutover_outbox(published_at, created_at);

CREATE TABLE pi_authority_cutover_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'evaluate-cutover-readiness',
    'execute-pi-authority-cutover',
    'submit-legacy-drain-result',
    'emergency-stop-pi',
    'clear-emergency-stop',
    'advance-migration-state',
    'bind-message-authority-epoch',
    'record-legacy-write-attempt'
  )),
  command_schema_version INTEGER NOT NULL CHECK (command_schema_version >= 1),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  committed_revisions_json TEXT NOT NULL,
  event_refs_json TEXT NOT NULL,
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  result_json TEXT,
  commit_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX pi_authority_cutover_command_receipts_idempotency_idx
  ON pi_authority_cutover_command_receipts(idempotency_key);

CREATE TABLE pi_authority_cutover_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX pi_authority_cutover_tombstones_idempotency_idx
  ON pi_authority_cutover_idempotency_tombstones(idempotency_key);

CREATE TABLE pi_authority_retirement_counters (
  team_id TEXT PRIMARY KEY,
  legacy_writer_call_count INTEGER NOT NULL CHECK (legacy_writer_call_count >= 0),
  legacy_client_call_count INTEGER NOT NULL CHECK (legacy_client_call_count >= 0),
  observation_window_started_at INTEGER,
  observation_window_ends_at INTEGER,
  emergency_stop_drill_passed INTEGER NOT NULL CHECK (emergency_stop_drill_passed IN (0, 1)),
  forward_recovery_drill_passed INTEGER NOT NULL CHECK (forward_recovery_drill_passed IN (0, 1)),
  historical_provenance_export_verified INTEGER NOT NULL CHECK (historical_provenance_export_verified IN (0, 1)),
  replacement_query_path_ready INTEGER NOT NULL CHECK (replacement_query_path_ready IN (0, 1)),
  updated_at INTEGER NOT NULL
);
