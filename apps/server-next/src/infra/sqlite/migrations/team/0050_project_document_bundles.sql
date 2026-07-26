-- #825：一次来源明确的 Agent 输出所产生的多份 Markdown 以固定成员的文档包展示。
-- 成员只保存 ChannelDocument 身份与纳入时的 initialRevisionId；正文与修订权威仍是 channel_documents。
-- 表结构刻意不提供成员的 UPDATE/追加路径：Bundle 成员在创建事务中一次写死，后续新增 Markdown 不回填。

CREATE TABLE project_document_bundles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('workspace_run')),
  source_workspace_run_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  source_invocation_id TEXT,
  source_task_id TEXT,
  source_message_id TEXT,
  source_json TEXT NOT NULL,
  member_count INTEGER NOT NULL CHECK (member_count > 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX project_document_bundles_channel_idx
  ON project_document_bundles(team_id, channel_id, created_at DESC, id DESC);

CREATE INDEX project_document_bundles_source_idx
  ON project_document_bundles(team_id, channel_id, source_workspace_run_id);

-- 成员外键一律 CASCADE：Bundle 是 ChannelDocument 的只读投影，不得对正文权威的生命周期
-- 拥有否决权。若用 RESTRICT，deleteChannel（先删文档、后删 channel 行）会被成员行挡住，
-- channels 上的 CASCADE 根本来不及触发，含 Bundle 的频道将永久无法删除。
CREATE TABLE project_document_bundle_members (
  bundle_id TEXT NOT NULL REFERENCES project_document_bundles(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  document_id TEXT NOT NULL REFERENCES channel_documents(id) ON DELETE CASCADE,
  initial_revision_id TEXT NOT NULL REFERENCES channel_document_revisions(id) ON DELETE CASCADE,
  initial_revision_number INTEGER NOT NULL CHECK (initial_revision_number > 0),
  initial_filename TEXT NOT NULL,
  PRIMARY KEY (bundle_id, document_id),
  UNIQUE (bundle_id, position)
);

CREATE INDEX project_document_bundle_members_document_idx
  ON project_document_bundle_members(document_id);

CREATE TABLE project_document_bundle_mutations (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  bundle_id TEXT NOT NULL REFERENCES project_document_bundles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, idempotency_key)
);
