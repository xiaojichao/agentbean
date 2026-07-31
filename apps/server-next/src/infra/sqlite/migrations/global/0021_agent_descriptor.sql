-- Agent descriptor 事实层（AGENTS.md/CLAUDE.md 扫描结果）：
-- description_source：manual=用户手工填写（不被扫描覆盖）/ agent_md=扫描自文件
-- scanned_capabilities_json：扫描到的公开能力候选（无 sourcePath，安全合同 AC#6）
ALTER TABLE agents ADD COLUMN description_source TEXT;
ALTER TABLE agents ADD COLUMN scanned_capabilities_json TEXT;
