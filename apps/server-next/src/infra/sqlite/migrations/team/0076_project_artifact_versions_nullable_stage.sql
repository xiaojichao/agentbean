-- #1060 OutputPackage：允许 Agent 交付形成的 ProjectArtifactVersion 无 Stage 来源。
--
-- 背景：0049 要求 stage_id NOT NULL + FK——人工 promote 时 Stage 来自负责人显式指定。
-- 但交付形成的版本(#1060 AC1)的 Stage 来源只能派生自 Task 的 Stage 绑定;Task 未绑定 Stage
-- 或为合成 taskId(Channel-first managed run,无真实 Task)时不存在合法 Stage 可指,
-- stage_id 必须可空,否则交付无法形成逻辑产物版本。stage_id 为 NULL 时复合外键自动不校验
--(SQLite NULL 语义),与 0049 的跨作用域防护兼容。
--
-- 复用 0021/0028/0033 重建惯例(注册时 disableForeignKeys):SQLite 不能 ALTER 去掉 NOT NULL,
-- 故 create-new + copy + drop + rename。reviews/finalizations/mutations 的 FK 按表名引用,
-- 重建后自动指向新表;DROP 会带走旧索引,下方按 0049/0053 原样重建。
--
-- 历史库守卫:注册侧沿用 0053 同款门禁(缺 artifacts/project_artifact_collections 的历史库
-- 不执行本迁移)。

CREATE TABLE project_artifact_versions_new (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  artifact_id TEXT NOT NULL,
  -- #1060：交付形成的版本允许无 Stage 来源(NULL);人工 promote 路径仍在 usecase 层强制 stageId。
  stage_id TEXT,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  source_message_id TEXT,
  source_workspace_run_id TEXT,
  source_invocation_id TEXT,
  lineage_json TEXT NOT NULL DEFAULT '[]',
  promoted_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (collection_id, version_number),
  -- 同一 Artifact 在同一频道至多提升为一个版本:重复提升天然幂等。
  UNIQUE (team_id, channel_id, artifact_id),
  FOREIGN KEY (collection_id, team_id, channel_id)
    REFERENCES project_artifact_collections(id, team_id, channel_id) ON DELETE CASCADE,
  FOREIGN KEY (artifact_id, team_id, channel_id)
    REFERENCES artifacts(id, team_id, channel_id) ON DELETE CASCADE,
  FOREIGN KEY (stage_id, team_id, channel_id)
    REFERENCES project_stages(id, team_id, channel_id) ON DELETE CASCADE
);

INSERT INTO project_artifact_versions_new (
  id, team_id, channel_id, collection_id, version_number, artifact_id, stage_id,
  task_id, task_revision, source_message_id, source_workspace_run_id, source_invocation_id,
  lineage_json, promoted_by, created_at
)
SELECT id, team_id, channel_id, collection_id, version_number, artifact_id, stage_id,
  task_id, task_revision, source_message_id, source_workspace_run_id, source_invocation_id,
  lineage_json, promoted_by, created_at
FROM project_artifact_versions;

DROP TABLE project_artifact_versions;
ALTER TABLE project_artifact_versions_new RENAME TO project_artifact_versions;

-- 0049/0053 的索引随 DROP 丢失,按原名原样重建。
CREATE INDEX project_artifact_versions_collection_idx
  ON project_artifact_versions(collection_id, version_number);

CREATE UNIQUE INDEX project_artifact_versions_scope_idx
  ON project_artifact_versions(id, team_id, channel_id);

CREATE UNIQUE INDEX project_artifact_versions_collection_scope_idx
  ON project_artifact_versions(id, collection_id);
