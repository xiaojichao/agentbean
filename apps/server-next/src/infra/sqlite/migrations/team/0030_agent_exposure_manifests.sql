-- #710: Agent owner 按 Team 发布的不可变 Agent Exposure Manifest。
-- team_id 不加 REFERENCES：teams 表在 Global DB，team 迁移在 Team DB，SQLite 无法跨库 FK
-- （与 team_pi_policies / channel_coordination_* 同惯例）。
-- AC#2：同 team+agent 仅一个 active revision——由部分唯一索引 WHERE status='active' 在 DB 层强制，
-- 配合 service 的原子 supersede（旧 active→superseded + 新→active 在同一事务）。
-- AC#6：capabilities/skills/constraints/availability 全为 owner 公开契约，不含 sourcePath/工具/权限。
CREATE TABLE agent_exposure_manifests (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'expired', 'revoked')),
  capabilities_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  availability_json TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  published_by TEXT,
  published_at INTEGER,
  superseded_by_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- AC#2 不变量：每个 team+agent 至多一个 active revision（DB 层兜底，防并发双发布）。
CREATE UNIQUE INDEX idx_agent_exposure_active
  ON agent_exposure_manifests(team_id, agent_id) WHERE status = 'active';

-- 历史列举与 revision 计算：按 team+agent+revision。
CREATE INDEX idx_agent_exposure_team_agent
  ON agent_exposure_manifests(team_id, agent_id, revision);
