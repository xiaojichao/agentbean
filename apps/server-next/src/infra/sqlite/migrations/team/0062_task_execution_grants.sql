-- #925 execution context grant：claim 成功同事务签发的输入访问凭证。
-- 随 task revision 变化、claim 释放或过期而失效（ADR-0064 验收#2/#4）。
CREATE TABLE task_execution_grants (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  claim_lease_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL
    OR revocation_reason IN ('task-revised', 'claim-released', 'claim-expired')
  ),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 每个 (task, attempt) 最多一个 active grant（同 revision/attempt 唯一 claim → 唯一 grant）。
CREATE UNIQUE INDEX task_execution_grants_active_task_attempt_idx
  ON task_execution_grants(task_id, task_attempt) WHERE state = 'active';
CREATE INDEX task_execution_grants_agent_idx
  ON task_execution_grants(agent_id, state);
CREATE INDEX task_execution_grants_claim_idx
  ON task_execution_grants(claim_lease_id);
