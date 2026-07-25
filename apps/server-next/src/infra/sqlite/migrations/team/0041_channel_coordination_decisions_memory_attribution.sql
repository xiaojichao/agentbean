-- #720 AC#5: Active Memory 归因持久化列。
-- memory_attribution 存储 ActiveMemoryAttributionDto 的 JSON
--   ({ schemaVersion:1, entries:[{id,source,selectionReason}], contextHash })。
-- 只存 ID/来源码/理由码 + 聚合哈希，绝不存正文/prompt（遵守 ChannelCoordinationDecisionRecord
-- 「绝不保存完整 prompt」约束）。null = 未注入 Active Memory（infra failure 或解析失败）。
-- 简单 ALTER ADD COLUMN，不重建表（参照 0029 惯例）。
ALTER TABLE channel_coordination_decisions ADD COLUMN memory_attribution TEXT;
