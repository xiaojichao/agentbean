-- 对齐 devices 表（0012/0013 + PR#393）：拆 agents.name 的"设备报告"与"用户自定义"语义。
-- 扫描（registerDiscoveredAgents）上报的 name 标 'scanned'；用户经 updateAgentConfig
-- 改名后置 'custom'。agents.upsert 冲突时 'custom' 名受保护，不被设备报告名覆盖
-- （修复 AgentOS 托管型 Agent 改名保存后点扫描名称被还原的 bug）。
-- 现有 agents 行默认 'scanned'（皆为设备扫描上报而来）。
ALTER TABLE agents ADD COLUMN name_source TEXT NOT NULL DEFAULT 'scanned';
