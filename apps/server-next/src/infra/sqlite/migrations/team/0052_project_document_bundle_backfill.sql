-- #830：历史 Markdown 输出的保守回填。本迁移只建回填自身的游标与裁决记录表，
-- 不改写任何既有行 —— 回填的写入一律走 #825 的建包路径，迁移里不做数据推断。

CREATE TABLE project_document_bundle_backfill_progress (
  id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  cursor_run_created_at INTEGER,
  cursor_run_id TEXT,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (id, mode)
);

-- 逐候选 Run 的裁决记录：既是可恢复的报告，也是「同一 Run 不重复裁决」的依据。
-- 刻意不对 channel_id / bundle_id 建外键：这是运维审计记录，不是频道或 Bundle 的投影，
-- 既不该在频道删除时阻塞（RESTRICT 的老坑），也不该随之消失而让回填历史无从复盘。
-- 记录只含 ID、原因码与计数，不含文件名、正文或设备路径。
CREATE TABLE project_document_bundle_backfill_outcomes (
  backfill_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
  team_id TEXT NOT NULL,
  channel_id TEXT,
  workspace_run_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('created', 'would_create', 'existing', 'ambiguous', 'skipped', 'failed')
  ),
  reason_code TEXT,
  member_count INTEGER NOT NULL DEFAULT 0,
  bundle_id TEXT,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY (backfill_id, mode, workspace_run_id)
);

CREATE INDEX project_document_bundle_backfill_outcomes_report_idx
  ON project_document_bundle_backfill_outcomes(backfill_id, mode, outcome);

-- 候选发现与成员事实查询都按「revision 派生自哪一次 Run」检索。表达式部分索引让这条
-- 路径不必全表扫描 channel_document_revisions，同时不影响人工编辑产生的无来源 revision。
CREATE INDEX project_document_bundle_backfill_revision_run_idx
  ON channel_document_revisions(json_extract(source_json, '$.workspaceRunId'))
  WHERE source_json IS NOT NULL;
