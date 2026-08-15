-- #1200：终态 root Task 通过 Promotion gate 创建显式后续 root Task。
ALTER TABLE promotion_source_relations
  ADD COLUMN relation_kind TEXT CHECK (relation_kind IS NULL OR relation_kind IN ('task-continuation'));
ALTER TABLE promotion_source_relations ADD COLUMN source_task_id TEXT;
ALTER TABLE promotion_source_relations
  ADD COLUMN source_task_revision INTEGER CHECK (source_task_revision IS NULL OR source_task_revision >= 1);
ALTER TABLE promotion_source_relations ADD COLUMN source_version_ids_json TEXT;
CREATE INDEX promotion_source_relations_source_task_idx
  ON promotion_source_relations(source_task_id, created_at);

ALTER TABLE promotion_command_receipts RENAME TO promotion_command_receipts_old;
CREATE TABLE promotion_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('promote-to-task', 'create-task-continuation')),
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
INSERT INTO promotion_command_receipts SELECT * FROM promotion_command_receipts_old;
DROP TABLE promotion_command_receipts_old;
CREATE UNIQUE INDEX promotion_command_receipts_idempotency_key_idx
  ON promotion_command_receipts(idempotency_key);

ALTER TABLE promotion_idempotency_tombstones RENAME TO promotion_idempotency_tombstones_old;
CREATE TABLE promotion_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('promote-to-task', 'create-task-continuation')),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);
INSERT INTO promotion_idempotency_tombstones SELECT * FROM promotion_idempotency_tombstones_old;
DROP TABLE promotion_idempotency_tombstones_old;
CREATE UNIQUE INDEX promotion_idempotency_tombstones_idempotency_key_idx
  ON promotion_idempotency_tombstones(idempotency_key);
CREATE INDEX promotion_idempotency_tombstones_receipt_idx
  ON promotion_idempotency_tombstones(receipt_id);
