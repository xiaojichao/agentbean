-- #1062 闭环明确版本修改与 Markdown 并发冲突:修订 provenance 列 + 新命令 receipt。
--
-- 两件事:
-- 1. project_artifact_versions 加修订 provenance 四列(全部可空,交付形成/人工 promote 的
--    版本为 NULL):revised_from_version_id(「基于此修改」的明确来源版本)、
--    revision_basis_review_id(回应的 rejected/changes_requested 审核)、
--    revision_package_id / revision_delivery_id(来源 package/delivery 冻结身份)。
--    软引用:package/review 是已成立事实,后续治理清理不改写修订审计(0078 同款取舍)。
--    ALTER ADD COLUMN 即可,不需要重建表。
-- 2. 新表 artifact_revision_command_receipts / artifact_revision_idempotency_tombstones:
--    save-artifact-version-revision 命令的幂等 receipt(照 0078 同款结构)。

-- 历史库守卫:注册侧已按 project_artifact_collections 存在性门禁,此处防御性复核
-- (缺 0049 链路的库不执行)。

ALTER TABLE project_artifact_versions ADD COLUMN revised_from_version_id TEXT;
ALTER TABLE project_artifact_versions ADD COLUMN revision_basis_review_id TEXT;
ALTER TABLE project_artifact_versions ADD COLUMN revision_package_id TEXT;
ALTER TABLE project_artifact_versions ADD COLUMN revision_delivery_id TEXT;

-- #1062 命令的 command receipt(ADR-0067)。
CREATE TABLE artifact_revision_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('save-artifact-version-revision')),
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
CREATE UNIQUE INDEX artifact_revision_command_receipts_idempotency_idx
  ON artifact_revision_command_receipts(team_id, idempotency_key);

-- 幂等 tombstone:result 治理压缩后的去重锚(#900 §1.5),与 receipt 同事务写入。
CREATE TABLE artifact_revision_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('save-artifact-version-revision')),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX artifact_revision_idempotency_tombstones_idempotency_idx
  ON artifact_revision_idempotency_tombstones(team_id, idempotency_key);
CREATE INDEX artifact_revision_idempotency_tombstones_receipt_idx
  ON artifact_revision_idempotency_tombstones(receipt_id);
