-- #718: Agent owner 按 Team 发布的 Team-scoped Agent Memory 投影。
-- team_id 不加 REFERENCES：teams 表在 Global DB，team 迁移在 Team DB，SQLite 无法跨库 FK
-- （与 agent_exposure_manifests / team_pi_policies 同惯例）。
-- AC#1：Team+Agent 联合 scope；同 team+agent 仅一个 active revision——由部分唯一索引
--       WHERE status='active' 在 DB 层强制，配合 service 的原子 supersede。
-- AC#6：content/summary/tags/sourceRefs 全为 owner 主动发布的公开最小化内容，
--       不含 Device-local 原文、Agent 内部 Session 或其他 Team 投影。
-- 投影内容直接存 FormalMemoryKind（fact/decision/rule/preference），不经底层 MemoryKind 映射
-- （projection 是独立表，不复用 memory_items）。
CREATE TABLE agent_memory_projections (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded', 'expired', 'withdrawn')),
  kind TEXT NOT NULL CHECK (kind IN ('fact', 'decision', 'rule', 'preference')),
  content TEXT NOT NULL CHECK (length(content) > 0),
  summary TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
  valid_from INTEGER NOT NULL,
  valid_until INTEGER,
  published_by TEXT,
  published_at INTEGER,
  superseded_by_id TEXT,
  withdrawn_by TEXT,
  withdrawn_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (valid_until IS NULL OR valid_until > valid_from)
);

-- AC#1 不变量：每个 team+agent 至多一个 active revision（DB 层兜底，防并发双发布）。
CREATE UNIQUE INDEX idx_agent_memory_projection_active
  ON agent_memory_projections(team_id, agent_id) WHERE status = 'active';

-- 历史列举与 revision 计算：按 team+agent+revision。
CREATE INDEX idx_agent_memory_projection_team_agent
  ON agent_memory_projections(team_id, agent_id, revision);
