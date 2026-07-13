-- 对齐 devices 表（0012/0013 + PR#393）：拆 agents.name 的"设备报告"与"用户自定义"语义。
-- 扫描（registerDiscoveredAgents）上报的 name 标 'scanned'；用户经 updateAgentConfig
-- 改名后置 'custom'。agents.upsert 冲突时 'custom' 名受保护，不被设备报告名覆盖
-- （修复 AgentOS 托管型 Agent 改名保存后点扫描名称被还原的 bug）。
-- 历史行缺少可靠的改名来源记录，无法区分设备报告名与用户已经改过的名称。
-- 升级时保守标为 'custom'，优先避免部署后的首次扫描再次覆盖用户数据；新建行由
-- repositories.upsert 显式写入 'scanned'。
ALTER TABLE agents ADD COLUMN name_source TEXT NOT NULL DEFAULT 'custom';
