-- LLM 总结的 capabilities 候选（capability-summarizer 慢路径结果）。
-- 与 scanned_capabilities_json（机械提取）平行；UI 分别标注「已验证 / AI 总结」。
ALTER TABLE agents ADD COLUMN scanned_capabilities_summarized_json TEXT;
