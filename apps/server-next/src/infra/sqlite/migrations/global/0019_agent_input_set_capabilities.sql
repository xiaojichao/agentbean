-- Agent adapter 公开支持的 ProjectDocumentInputSet 合同版本；旧 Agent 为 NULL，fail closed。
ALTER TABLE agents ADD COLUMN project_document_input_set_versions_json TEXT;
