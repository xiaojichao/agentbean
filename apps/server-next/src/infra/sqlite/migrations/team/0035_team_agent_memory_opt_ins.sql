-- #718: Team Owner/Admin opt-in（AC#3）。每 team+agent 一条生效记录（UNIQUE(team_id, agent_id)）。
-- projection_id 作为 revision 围栏：读路径仅在 opt-in.projection_id == 当前 active projection id
-- 且 enabled=1 时消费（domain evaluateTeamAgentMemoryOptIn fail-closed）；projection supersede 后
-- 旧 opt-in 自动失效，需 owner/admin 针对新 revision 重设（避免静默套用到新内容，AC#7）。
-- 默认 opted-out：无记录或 enabled=0 时 Team 不消费（AC#5 明确授权后才进入 Team）。
-- enabled 用 INTEGER 0/1（SQLite 无原生 BOOL），service 层做 boolean 映射。
CREATE TABLE team_agent_memory_opt_ins (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  projection_id TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(team_id, agent_id)
);
