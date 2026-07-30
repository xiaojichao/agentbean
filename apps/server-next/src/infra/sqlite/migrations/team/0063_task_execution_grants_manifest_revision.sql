-- #946 execution context grant：绑定 manifest revision + 扩撤销归因。
-- grant 新增 manifest_revision（签发时冻结的 Agent Exposure Manifest revision），
-- 供「频道踢人 / manifest 变化」精确撤销。revocation_reason CHECK 扩 authority-revoked
-- （membership）与 manifest-superseded（manifest）。SQLite 不能 ALTER CHECK，故重建表
-- （create-new + copy + drop + rename，与 0021/0028 同惯例）。0062 已生产，copy 作安全兜底。
CREATE TABLE task_execution_grants_new (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  manifest_revision INTEGER NOT NULL DEFAULT 0,
  claim_lease_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL
    OR revocation_reason IN (
      'task-revised', 'claim-released', 'claim-expired',
      'authority-revoked', 'manifest-superseded'
    )
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO task_execution_grants_new (
  id, team_id, management_run_id, task_id, task_revision, task_attempt, manifest_revision,
  claim_lease_id, agent_id, state, granted_at, revoked_at, revocation_reason, created_at, updated_at
)
SELECT
  id, team_id, management_run_id, task_id, task_revision, task_attempt, 0,
  claim_lease_id, agent_id, state, granted_at, revoked_at, revocation_reason, created_at, updated_at
FROM task_execution_grants;

-- SQLite 默认（legacy_alter_table=OFF）在 RENAME 时会重新校验库内所有 trigger/view 的
-- 引用完整性——若存在引用他表的悬空 trigger（如某些 legacy 测试 fixture 未建 channels/
-- messages，而 0054 的 project_reference_sets trigger 引用它们），RENAME 会在此报错。
-- task_execution_grants 本身无 trigger/view 引用，故开启 legacy 行为跳过该校验、只安全改名。
PRAGMA legacy_alter_table = ON;
DROP TABLE task_execution_grants;
ALTER TABLE task_execution_grants_new RENAME TO task_execution_grants;
PRAGMA legacy_alter_table = OFF;

CREATE UNIQUE INDEX task_execution_grants_active_task_attempt_idx
  ON task_execution_grants(task_id, task_attempt) WHERE state = 'active';
CREATE INDEX task_execution_grants_agent_idx
  ON task_execution_grants(agent_id, state);
CREATE INDEX task_execution_grants_claim_idx
  ON task_execution_grants(claim_lease_id);
