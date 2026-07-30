-- #966 execution context grant 绑定固定 Workspace revision。
-- grant 新增 workspace_revision_id（签发时冻结的 Project Channel Workspace revisionId），
-- 供 Agent 据此读取固定输入版本（AC#1：执行中不静默改为最新）。nullable：频道无 workspace 时为 NULL。
-- ADD COLUMN 无 CHECK 约束，无需重建表（对比 0063 的 manifest_revision 重建）。
ALTER TABLE task_execution_grants ADD COLUMN workspace_revision_id TEXT;
