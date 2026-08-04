-- #1060 OutputPackage：一次成功 Agent 交付的协作分组(父规格 #1059 §3/§4;ADR-0067)。
--
-- output_packages 绑定唯一 delivery lineage(Agent/Task revision/attempt/可选 Invocation/
-- WorkspaceRun/claim/Device + committed Workspace revision + publish identity)。publish identity
-- 仅作 provenance 与自然幂等键(UNIQUE(team_id, publish_id)),不是 package identity。
-- package 创建后不可变:本迁移只建 INSERT 路径,仓储接口不暴露 update/delete。
--
-- 成员表冻结交付事实:顺序/短标识/交付时 artifact_version_id/角色/final 必需性/来源摘要。
-- 成员对 versions/collections 是刻意的软引用(无 FK):package 是已成立的交付事实,即使
-- 后续 artifact/version 行随频道治理被清理,交付审计也不被静默改写;频道删除经
-- output_packages.channel_id 级联,members 再随 package 级联。

CREATE TABLE output_packages (
  team_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- 唯一 delivery identity(Server 生成,与 package 1:1)。
  delivery_id TEXT NOT NULL,
  publish_id TEXT NOT NULL,
  workspace_revision_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_binding TEXT NOT NULL CHECK (task_binding IN ('managed', 'unmanaged')),
  -- managed 绑定时冻结的 Task revision;unmanaged 为 NULL(合成 taskId 无 revision 概念)。
  task_revision INTEGER CHECK (task_revision IS NULL OR task_revision > 0),
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  invocation_id TEXT,
  workspace_run_id TEXT,
  claim_lease_id TEXT,
  device_id TEXT,
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  status TEXT NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, package_id),
  UNIQUE (team_id, delivery_id),
  -- 同一 delivery/publish identity 至多一个 package:重复 commit 回调/replay 天然收敛。
  UNIQUE (team_id, publish_id)
);

-- 复合作用域唯一索引:封住跨 Team/Channel 引用窗口(与 0049/0053 同款)。
CREATE UNIQUE INDEX output_packages_scope_idx
  ON output_packages(package_id, team_id, channel_id);

CREATE INDEX output_packages_channel_idx
  ON output_packages(team_id, channel_id, created_at, package_id);

CREATE INDEX output_packages_task_idx
  ON output_packages(team_id, channel_id, task_id);

CREATE TABLE output_package_members (
  team_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  -- 包内唯一短标识(F1、F2……),只在 package/Thread 焦点内唯一。
  short_label TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  -- 交付时版本(delivered projection 的锚);软引用,见表头注释。
  artifact_version_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('deliverable')),
  required_for_final INTEGER NOT NULL CHECK (required_for_final IN (0, 1)),
  source_path TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  PRIMARY KEY (team_id, package_id, sequence),
  -- 同一 delivery 中同一逻辑 collection 至多一个 delivered version(#1059 §4)。
  UNIQUE (team_id, package_id, collection_id),
  FOREIGN KEY (team_id, package_id)
    REFERENCES output_packages(team_id, package_id) ON DELETE CASCADE
);

CREATE INDEX output_package_members_package_idx
  ON output_package_members(package_id, sequence);

-- Command receipt(ADR-0067):同 scope/key/hash replay 返回首次 receipt;不同 hash 无副作用 conflict。
CREATE TABLE output_package_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('record-agent-output-package')),
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
CREATE UNIQUE INDEX output_package_command_receipts_idempotency_idx
  ON output_package_command_receipts(team_id, idempotency_key);

-- 幂等 tombstone:result 治理压缩后的去重锚(#900 §1.5),与 receipt 同事务写入。
CREATE TABLE output_package_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN ('record-agent-output-package')),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX output_package_idempotency_tombstones_idempotency_idx
  ON output_package_idempotency_tombstones(team_id, idempotency_key);
CREATE INDEX output_package_idempotency_tombstones_receipt_idx
  ON output_package_idempotency_tombstones(receipt_id);
