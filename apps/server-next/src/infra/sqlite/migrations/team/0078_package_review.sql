-- #1061 分离文件审核、Task 交付验收与最终版设置：package 绑定审核 + authority token + 新命令 receipt。
--
-- 三件事:
-- 1. 重建 project_artifact_reviews:#824 的审核只绑 collection/version/stage(0053),#1061 AC1
--    要求绑定 package/delivery/Task revision/attempt 与 reviewer authority basis;
--    stage_id 改可空(#1060 交付形成的版本 stage 可为 NULL,0076 已放开版本侧)。
--    重建遵循 0076 同款惯例(create-new + copy + drop + rename,disableForeignKeys)。
-- 2. task_coordinations 加 human_acceptance_authority_ids_json:创建时预绑定的人类验收者
--    (root = Human review authority,subtask = Subtask human acceptance authority,AC3/AC4);
--    空 = 未绑定(人类不得验收,fail closed)。ALTER ADD COLUMN 即可,SQLite 不支持并行级联。
-- 3. 新表 package_review_command_receipts / package_review_idempotency_tombstones:
--    #1061 三个人类命令的幂等 receipt(照抄 0077 output-package 同款结构)。

-- 历史库守卫:注册侧已按 project_artifact_collections 存在性门禁,此处防御性复核。
-- (重建依赖 0049/0053 的 review 表,缺该链路的库不执行。)

CREATE TABLE project_artifact_reviews_new (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  -- 审核语境:受审版本所属 Stage,写入时从版本自身读取,不接受客户端提交;#1061 起可空
  -- (交付形成版本可能无 Stage 来源,0076)。
  stage_id TEXT,
  -- #1061 AC1:审核绑定 package 上下文(交付来源)。软引用:package 是已成立的交付事实,
  -- 即使后续 package 行随频道治理清理,审核审计也不被改写。
  package_id TEXT,
  delivery_id TEXT,
  task_id TEXT,
  task_revision INTEGER CHECK (task_revision IS NULL OR task_revision > 0),
  task_attempt INTEGER CHECK (task_attempt IS NULL OR task_attempt > 0),
  -- #1061 AC1:本次审核依据的 authority basis(team-owner/team-admin/project-lead/
  -- stage-reviewer-delegation/subtask-human-acceptance/root-review-authority)。
  authority_basis TEXT NOT NULL DEFAULT 'stage-reviewer-delegation'
    CHECK (authority_basis IN ('team-owner', 'team-admin', 'project-lead',
      'stage-reviewer-delegation', 'subtask-human-acceptance', 'root-review-authority')),
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  comment TEXT NOT NULL DEFAULT '',
  basis_json TEXT NOT NULL DEFAULT '[]',
  reviewed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (version_id, team_id, channel_id)
    REFERENCES project_artifact_versions(id, team_id, channel_id) ON DELETE CASCADE,
  -- 结构性保证:审核记录的 collection_id 必须就是该版本所属集合,无法指向别的集合。
  FOREIGN KEY (version_id, collection_id)
    REFERENCES project_artifact_versions(id, collection_id) ON DELETE CASCADE,
  FOREIGN KEY (stage_id, team_id, channel_id)
    REFERENCES project_stages(id, team_id, channel_id) ON DELETE CASCADE
);

INSERT INTO project_artifact_reviews_new (
  id, team_id, channel_id, collection_id, version_id, stage_id,
  package_id, delivery_id, task_id, task_revision, task_attempt,
  authority_basis, decision, comment, basis_json, reviewed_by, created_at
)
SELECT id, team_id, channel_id, collection_id, version_id, stage_id,
  NULL, NULL, NULL, NULL, NULL,
  'stage-reviewer-delegation', decision, comment, basis_json, reviewed_by, created_at
FROM project_artifact_reviews;

DROP TABLE project_artifact_reviews;
ALTER TABLE project_artifact_reviews_new RENAME TO project_artifact_reviews;

-- 0053 的索引随 DROP 丢失,按原名原样重建。
CREATE INDEX project_artifact_reviews_version_idx
  ON project_artifact_reviews(version_id, created_at, id);

CREATE INDEX project_artifact_reviews_channel_idx
  ON project_artifact_reviews(team_id, channel_id, created_at, id);

-- #1061:按 package 查审核(availableActions / 投影用)。
CREATE INDEX project_artifact_reviews_package_idx
  ON project_artifact_reviews(package_id, created_at, id)
  WHERE package_id IS NOT NULL;

-- #1061 AC3/AC4:coordination 创建时预绑定的人类验收 authority(JSON 数组)。
-- 存量行缺省空数组 = 未绑定(人类验收 fail closed)。
ALTER TABLE task_coordinations
  ADD COLUMN human_acceptance_authority_ids_json TEXT NOT NULL DEFAULT '[]';

-- #1061 三个人类命令的 command receipt(ADR-0067)。
CREATE TABLE package_review_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'submit-package-artifact-review',
    'submit-package-review-and-finalize',
    'submit-package-review-and-reject-delivery'
  )),
  command_schema_version INTEGER NOT NULL CHECK (command_schema_version >= 1),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  committed_revisions_json TEXT NOT NULL,
  event_refs_json TEXT NOT NULL,
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  result_json TEXT,
  commit_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX package_review_command_receipts_idempotency_idx
  ON package_review_command_receipts(team_id, idempotency_key);

-- 幂等 tombstone:result 治理压缩后的去重锚(#900 §1.5),与 receipt 同事务写入。
CREATE TABLE package_review_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'submit-package-artifact-review',
    'submit-package-review-and-finalize',
    'submit-package-review-and-reject-delivery'
  )),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX package_review_idempotency_tombstones_idempotency_idx
  ON package_review_idempotency_tombstones(team_id, idempotency_key);
CREATE INDEX package_review_idempotency_tombstones_receipt_idx
  ON package_review_idempotency_tombstones(receipt_id);
