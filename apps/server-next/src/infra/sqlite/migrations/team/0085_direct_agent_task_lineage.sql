-- #1219：修复旧 Direct Agent delivery 把 Dispatch id 当作 Task id 的历史事实。
--
-- 仅匹配 daemon 的精确 fallback 形态：unmanaged package.task_id、staging.taskId 与
-- staging.workspaceRunId 三者均为同一个真实 Dispatch id；再从该 Dispatch 的 Server-owned
-- origin Message.meta.taskId 解析同 Team/Channel 的当前 Task。其他合成 taskId、managed
-- package、跨作用域/缺失 Task、非当前 Task revision 一律保持不变。

CREATE TEMP TABLE _migration_0085_direct_agent_lineage (
  team_id TEXT NOT NULL,
  package_id TEXT NOT NULL,
  publish_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  legacy_dispatch_id TEXT NOT NULL,
  linked_task_id TEXT NOT NULL,
  linked_task_revision INTEGER NOT NULL,
  linked_task_title TEXT NOT NULL,
  PRIMARY KEY (team_id, package_id),
  UNIQUE (team_id, publish_id)
);

INSERT INTO _migration_0085_direct_agent_lineage (
  team_id,
  package_id,
  publish_id,
  channel_id,
  legacy_dispatch_id,
  linked_task_id,
  linked_task_revision,
  linked_task_title
)
SELECT
  package.team_id,
  package.package_id,
  package.publish_id,
  package.channel_id,
  dispatch.id,
  task.id,
  task.revision,
  task.title
FROM output_packages AS package
JOIN workspace_publish_stagings AS staging
  ON staging.team_id = package.team_id
  AND staging.publish_id = package.publish_id
  AND staging.channel_id = package.channel_id
JOIN dispatches AS dispatch
  ON dispatch.id = package.task_id
  AND dispatch.team_id = package.team_id
  AND dispatch.channel_id = package.channel_id
  AND dispatch.agent_id = package.agent_id
JOIN messages AS origin_message
  ON origin_message.id = dispatch.message_id
  AND origin_message.team_id = package.team_id
  AND origin_message.channel_id = package.channel_id
JOIN tasks AS task
  ON task.id = json_extract(
    CASE WHEN json_valid(origin_message.meta_json) THEN origin_message.meta_json ELSE '{}' END,
    '$.taskId'
  )
  AND task.team_id = package.team_id
  AND (task.channel_id IS NULL OR task.channel_id = package.channel_id)
  AND task.superseded_by_revision IS NULL
WHERE package.task_binding = 'unmanaged'
  AND package.task_revision IS NULL
  AND json_extract(
    CASE WHEN json_valid(staging.provenance_json) THEN staging.provenance_json ELSE '{}' END,
    '$.taskId'
  ) = dispatch.id
  AND json_extract(
    CASE WHEN json_valid(staging.provenance_json) THEN staging.provenance_json ELSE '{}' END,
    '$.workspaceRunId'
  ) = dispatch.id
  AND json_extract(
    CASE WHEN json_valid(staging.provenance_json) THEN staging.provenance_json ELSE '{}' END,
    '$.agentId'
  ) = package.agent_id;

UPDATE output_packages
SET
  task_id = (
    SELECT lineage.linked_task_id
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = output_packages.team_id
      AND lineage.package_id = output_packages.package_id
  ),
  task_binding = 'managed',
  task_revision = (
    SELECT lineage.linked_task_revision
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = output_packages.team_id
      AND lineage.package_id = output_packages.package_id
  )
WHERE EXISTS (
  SELECT 1
  FROM _migration_0085_direct_agent_lineage AS lineage
  WHERE lineage.team_id = output_packages.team_id
    AND lineage.package_id = output_packages.package_id
);

UPDATE workspace_publish_stagings
SET provenance_json = json_set(
  provenance_json,
  '$.taskId',
  (
    SELECT lineage.linked_task_id
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = workspace_publish_stagings.team_id
      AND lineage.publish_id = workspace_publish_stagings.publish_id
  )
)
WHERE EXISTS (
  SELECT 1
  FROM _migration_0085_direct_agent_lineage AS lineage
  WHERE lineage.team_id = workspace_publish_stagings.team_id
    AND lineage.publish_id = workspace_publish_stagings.publish_id
);

-- package 成形时新建的 artifact version 继承了同一个 synthetic Dispatch taskId；只修正
-- 被该 package member 引用且当前仍指向 legacy Dispatch 的版本，复用的既有版本保持不变。
UPDATE project_artifact_versions
SET
  task_id = (
    SELECT lineage.linked_task_id
    FROM _migration_0085_direct_agent_lineage AS lineage
    JOIN output_package_members AS member
      ON member.team_id = lineage.team_id
      AND member.package_id = lineage.package_id
      AND member.channel_id = lineage.channel_id
    WHERE lineage.team_id = project_artifact_versions.team_id
      AND lineage.channel_id = project_artifact_versions.channel_id
      AND member.artifact_version_id = project_artifact_versions.id
      AND project_artifact_versions.task_id = lineage.legacy_dispatch_id
  ),
  task_revision = (
    SELECT lineage.linked_task_revision
    FROM _migration_0085_direct_agent_lineage AS lineage
    JOIN output_package_members AS member
      ON member.team_id = lineage.team_id
      AND member.package_id = lineage.package_id
      AND member.channel_id = lineage.channel_id
    WHERE lineage.team_id = project_artifact_versions.team_id
      AND lineage.channel_id = project_artifact_versions.channel_id
      AND member.artifact_version_id = project_artifact_versions.id
      AND project_artifact_versions.task_id = lineage.legacy_dispatch_id
  )
WHERE EXISTS (
  SELECT 1
  FROM _migration_0085_direct_agent_lineage AS lineage
  JOIN output_package_members AS member
    ON member.team_id = lineage.team_id
    AND member.package_id = lineage.package_id
    AND member.channel_id = lineage.channel_id
  WHERE lineage.team_id = project_artifact_versions.team_id
    AND lineage.channel_id = project_artifact_versions.channel_id
    AND member.artifact_version_id = project_artifact_versions.id
    AND project_artifact_versions.task_id = lineage.legacy_dispatch_id
);

-- 独立 system package 卡片是可重建投影；同步修正其导航 Task 快照。
UPDATE messages
SET meta_json = json_set(
  meta_json,
  '$.taskId',
  (
    SELECT lineage.linked_task_id
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = messages.team_id
      AND lineage.channel_id = messages.channel_id
      AND json_extract(messages.meta_json, '$.packageId') = lineage.package_id
  ),
  '$.taskTitle',
  (
    SELECT lineage.linked_task_title
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = messages.team_id
      AND lineage.channel_id = messages.channel_id
      AND json_extract(messages.meta_json, '$.packageId') = lineage.package_id
  )
)
WHERE json_valid(meta_json)
  AND json_extract(meta_json, '$.kind') = 'output-package'
  AND EXISTS (
    SELECT 1
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = messages.team_id
      AND lineage.channel_id = messages.channel_id
      AND json_extract(messages.meta_json, '$.packageId') = lineage.package_id
      AND json_extract(messages.meta_json, '$.taskId') = lineage.legacy_dispatch_id
  );

-- Agent 回复内嵌的 outputPackageCard 同样是 package 投影快照。
UPDATE messages
SET meta_json = json_set(
  meta_json,
  '$.outputPackageCard.taskId',
  (
    SELECT lineage.linked_task_id
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = messages.team_id
      AND lineage.channel_id = messages.channel_id
      AND json_extract(messages.meta_json, '$.outputPackageCard.packageId') = lineage.package_id
  ),
  '$.outputPackageCard.taskTitle',
  (
    SELECT lineage.linked_task_title
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = messages.team_id
      AND lineage.channel_id = messages.channel_id
      AND json_extract(messages.meta_json, '$.outputPackageCard.packageId') = lineage.package_id
  )
)
WHERE json_valid(meta_json)
  AND json_extract(meta_json, '$.outputPackageCard.kind') = 'output-package'
  AND EXISTS (
    SELECT 1
    FROM _migration_0085_direct_agent_lineage AS lineage
    WHERE lineage.team_id = messages.team_id
      AND lineage.channel_id = messages.channel_id
      AND json_extract(messages.meta_json, '$.outputPackageCard.packageId') = lineage.package_id
      AND json_extract(messages.meta_json, '$.outputPackageCard.taskId') = lineage.legacy_dispatch_id
  );

DROP TABLE _migration_0085_direct_agent_lineage;
