-- Agent 对 primary team 的可见性：0=可见（默认），1=隐藏（移出当前团队）
ALTER TABLE agents ADD COLUMN hidden_from_primary_team INTEGER NOT NULL DEFAULT 0;

-- 清理历史编程执行器 AgentDto（executor-hosted 且非 custom），它们不再作为团队成员
DELETE FROM agent_publications WHERE agent_id IN (
  SELECT id FROM agents WHERE category = 'executor-hosted' AND source IN ('scanned', 'self-register')
);
DELETE FROM agent_identity_links WHERE agent_id IN (
  SELECT id FROM agents WHERE category = 'executor-hosted' AND source IN ('scanned', 'self-register')
);
DELETE FROM agents WHERE category = 'executor-hosted' AND source IN ('scanned', 'self-register');

-- 废弃多团队发布：清空所有额外 publication，agent 只归属 primary team
DELETE FROM agent_publications;
