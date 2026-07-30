-- ADR-0064 #948-G：具名 output slot 声明 + input binding 声明 + 不可变 output snapshot。
--
-- 向后兼容：output_slots_json / input_bindings_json 为 nullable，mapper 缺省读回 []
--（同 0042 required_skills_json / 0047 preferred_skills_json 的 ALTER TABLE 习惯）。
--
-- output snapshot 在 delivery 合法验收时一次性写入，无 UPDATE 路径（不可变）。
-- UNIQUE(task_id, task_revision, task_attempt, slot_name) 锁定「每 revision+attempt 每 slot 一行」，
-- 配合 reviseInTransaction revision 时 attempt 重置 → 旧 attempt 的 snapshot 留在原行不变。
-- resolved_delivery_id 用 RESTRICT 保护 provenance（同 evidence_snapshots.invocation_id 习惯）。

ALTER TABLE task_coordinations ADD COLUMN output_slots_json TEXT;
ALTER TABLE task_coordinations ADD COLUMN input_bindings_json TEXT;

CREATE TABLE task_output_snapshots (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES task_coordinations(task_id) ON DELETE CASCADE,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  slot_name TEXT NOT NULL,
  resolved_delivery_id TEXT NOT NULL REFERENCES subtask_deliveries(id) ON DELETE RESTRICT,
  resolved_evidence_refs_json TEXT NOT NULL,
  resolved_at INTEGER NOT NULL,
  UNIQUE (task_id, task_revision, task_attempt, slot_name)
);
