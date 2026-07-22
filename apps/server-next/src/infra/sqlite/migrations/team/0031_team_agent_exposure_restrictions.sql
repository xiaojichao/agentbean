-- #710: Team Owner/Admin 收紧（AC#4）：只能禁用 active manifest 已暴露的 operation。
-- 每 team+agent 一条生效 restriction（UNIQUE(team_id, agent_id)）；manifest_id 作为 revision 围栏——
-- 读路径仅在 restriction.manifest_id == 当前 active manifest id 时应用，manifest supersede 后旧 restriction
-- 自动失效，需 owner/admin 针对新 revision 重设（避免静默套用到新公开契约）。
CREATE TABLE team_agent_exposure_restrictions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  disabled_capabilities_json TEXT NOT NULL,
  disabled_skills_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, agent_id)
);
