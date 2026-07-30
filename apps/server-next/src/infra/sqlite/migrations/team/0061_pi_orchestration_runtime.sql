-- #924 Server-owned PI orchestration run/claim/scheduling/command/recovery facts.
-- 旧 ManagementRun 继续可读；新 root Task 由 active claim + scheduling facts 进入唯一 Server path。

ALTER TABLE management_runs
  ADD COLUMN orchestration_revision INTEGER NOT NULL DEFAULT 0 CHECK (orchestration_revision >= 0);
ALTER TABLE management_runs
  ADD COLUMN recovery_state TEXT NOT NULL DEFAULT 'healthy'
    CHECK (recovery_state IN ('healthy', 'recovery_pending'));

CREATE TABLE pi_orchestration_claims (
  management_run_id TEXT PRIMARY KEY,
  root_task_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'closed')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE UNIQUE INDEX pi_orchestration_claims_active_root_idx
  ON pi_orchestration_claims(root_task_id) WHERE state = 'active';

CREATE TABLE pi_orchestration_scheduling (
  management_run_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('queued', 'runnable', 'waiting', 'recovery_pending')),
  eligible_at INTEGER NOT NULL,
  enqueued_at INTEGER NOT NULL,
  priority INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  waiting_reason TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pi_orchestration_scheduling_runnable_idx
  ON pi_orchestration_scheduling(state, priority DESC, eligible_at, enqueued_at, management_run_id);

CREATE TABLE pi_orchestration_deadlines (
  management_run_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'satisfied', 'cancelled')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (management_run_id, kind)
);

CREATE TABLE pi_orchestration_command_receipts (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  run_revision INTEGER NOT NULL CHECK (run_revision >= 1),
  scheduling_revision INTEGER NOT NULL CHECK (scheduling_revision >= 1),
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  created_at INTEGER NOT NULL,
  UNIQUE (management_run_id, idempotency_key)
);

CREATE TABLE pi_orchestration_attempt_audits (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  worker_id TEXT,
  fencing_token INTEGER,
  decision TEXT NOT NULL CHECK (decision IN ('applied', 'rejected')),
  reason_code TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX pi_orchestration_attempt_audits_run_idx
  ON pi_orchestration_attempt_audits(management_run_id, created_at, id);

CREATE TABLE pi_orchestration_outbox (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL,
  receipt_id TEXT,
  event_sequence INTEGER NOT NULL CHECK (event_sequence >= 1),
  state TEXT NOT NULL CHECK (state IN ('pending', 'delivered')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX pi_orchestration_outbox_receipt_idx
  ON pi_orchestration_outbox(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE INDEX pi_orchestration_outbox_pending_idx
  ON pi_orchestration_outbox(state, created_at, id);

-- #922 已原子创建的 promotion facts 前滚为 #924 的 canonical claim/scheduling facts。
INSERT OR IGNORE INTO pi_orchestration_claims (
  management_run_id, root_task_id, state, revision, created_at, updated_at
)
SELECT management_run_id, task_id, 'active', 1, created_at, created_at
FROM promotion_source_relations;

INSERT OR IGNORE INTO pi_orchestration_scheduling (
  management_run_id, state, eligible_at, enqueued_at, priority, revision, updated_at
)
SELECT management_run_id, 'runnable', created_at, created_at, 0, 1, created_at
FROM promotion_scheduling_intents;

UPDATE management_runs
SET orchestration_revision = 1
WHERE id IN (SELECT management_run_id FROM pi_orchestration_claims)
  AND orchestration_revision = 0;
