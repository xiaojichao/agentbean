-- #922 Promotion gate：source relation（编排权归属 + provenance）、scheduling intent、outbox
-- 与 command receipt / idempotency tombstone。
-- 合同：#894（promotion）/ #896（root Task）/ #900（Server API/幂等/receipt）/ ADR-0062 / ADR-0067 / ADR-0069。
--
-- promotion 使用独立 receipt/tombstone 表，不触碰 #921 的 command_receipts / idempotency_tombstones
-- （SQLite 改 CHECK 须重建历史表，风险且违反 migration-table-guard 纪律）。receipt 是逻辑概念
-- （一个 command 一个 receipt），物理按 command family 分表不违反 ADR-0067。

-- 1. Promotion source relation：来源 → root Task 的不可变编排权归属 + provenance（#894 §8/§10）。
--    同一 source lineage 最多一个 root Task；来源编辑/删除只产生 attention，不静默改写本行。
CREATE TABLE promotion_source_relations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  lineage_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  trigger_command_revision INTEGER NOT NULL CHECK (trigger_command_revision >= 0),
  objective_snapshot_json TEXT NOT NULL,
  scope_snapshot_json TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  data_snapshot_json TEXT,
  provenance_json TEXT NOT NULL,
  claim_state TEXT NOT NULL CHECK (claim_state IN ('awaiting-driver')),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX promotion_source_relations_lineage_key_idx ON promotion_source_relations(lineage_key);
CREATE INDEX promotion_source_relations_task_idx ON promotion_source_relations(task_id);

-- 2. Promotion scheduling intent（最小占位：持久调度事实，完整 scheduler 重放 follow-up）。
CREATE TABLE promotion_scheduling_intents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('queue')),
  profile_hint TEXT,
  deadline INTEGER,
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending')),
  created_at INTEGER NOT NULL
);
CREATE INDEX promotion_scheduling_intents_run_idx ON promotion_scheduling_intents(management_run_id);

-- 3. Promotion outbox record（最小占位：原子落库的待投递事实，完整 delivery 投递 follow-up）。
CREATE TABLE promotion_outbox_records (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  event_ref_json TEXT NOT NULL,
  audience TEXT NOT NULL,
  delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending')),
  created_at INTEGER NOT NULL
);
CREATE INDEX promotion_outbox_records_receipt_idx ON promotion_outbox_records(receipt_id);

-- 4. Promotion command receipt（独立于 #921 command_receipts，一个 command 恰好一个 receipt，#900 §6）。
CREATE TABLE promotion_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('promote-to-task')),
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
CREATE UNIQUE INDEX promotion_command_receipts_idempotency_key_idx ON promotion_command_receipts(idempotency_key);

-- 5. Promotion idempotency tombstone（result 治理压缩后的去重锚，#900 §1.5）。
CREATE TABLE promotion_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('promote-to-task')),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX promotion_idempotency_tombstones_idempotency_key_idx ON promotion_idempotency_tombstones(idempotency_key);
CREATE INDEX promotion_idempotency_tombstones_receipt_idx ON promotion_idempotency_tombstones(receipt_id);
