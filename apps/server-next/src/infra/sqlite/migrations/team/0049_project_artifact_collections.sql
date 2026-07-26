-- #823 将既有不可变 Artifact 显式提升为逻辑产物版本。
-- 集合保存稳定身份与 current version 指针；版本保存 Stage/Task、消息、Workspace Run、
-- Invocation、Artifact 与 lineage 来源。审核与唯一最终版属于后续切片，本迁移不建立相关列。

-- 复合作用域唯一索引：供下方复合外键封住跨 Team/Channel 引用窗口。
CREATE UNIQUE INDEX project_stages_project_artifact_scope_idx
  ON project_stages(id, team_id, channel_id);

CREATE UNIQUE INDEX artifacts_project_artifact_scope_idx
  ON artifacts(id, team_id, channel_id);

CREATE TABLE project_artifact_collections (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  -- name/kind 由项目负责人显式声明，不从文件名、目录、mime 或 path_kind 推断。
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  -- current version 指针；不加外键以避免与版本表形成循环引用，一致性由同事务写入保证。
  current_version_id TEXT NOT NULL,
  version_count INTEGER NOT NULL CHECK (version_count > 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id, name)
);

CREATE UNIQUE INDEX project_artifact_collections_scope_idx
  ON project_artifact_collections(id, team_id, channel_id);

CREATE INDEX project_artifact_collections_channel_idx
  ON project_artifact_collections(team_id, channel_id, created_at, id);

CREATE TABLE project_artifact_versions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  artifact_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  source_message_id TEXT,
  source_workspace_run_id TEXT,
  source_invocation_id TEXT,
  lineage_json TEXT NOT NULL DEFAULT '[]',
  promoted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (collection_id, version_number),
  -- 同一 Artifact 在同一频道至多提升为一个版本：重复提升天然幂等。
  UNIQUE (team_id, channel_id, artifact_id),
  FOREIGN KEY (collection_id, team_id, channel_id)
    REFERENCES project_artifact_collections(id, team_id, channel_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, team_id, channel_id)
    REFERENCES artifacts(id, team_id, channel_id) ON DELETE CASCADE,
  FOREIGN KEY (stage_id, team_id, channel_id)
    REFERENCES project_stages(id, team_id, channel_id) ON DELETE CASCADE
);

CREATE INDEX project_artifact_versions_collection_idx
  ON project_artifact_versions(collection_id, version_number);

CREATE TABLE project_artifact_mutations (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  collection_id TEXT NOT NULL REFERENCES project_artifact_collections(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL REFERENCES project_artifact_versions(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, idempotency_key)
);
