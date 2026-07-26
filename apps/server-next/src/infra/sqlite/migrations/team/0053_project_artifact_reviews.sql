-- #824 人工审核产物版本并切换唯一最终版。
-- 全部 additive：#823 已写入的集合与版本行不被改写，只新增一个可空指针列与三张新表。
-- 编号跳过 0052 让位给同期在飞的 #830 回填切片；注册是静态列表，编号不连续不影响执行。

-- 唯一最终版指针。刻意不加外键，与 0049 的 current_version_id 保持同一取舍：
-- 避免与版本表形成循环引用，一致性由同事务写入 + 下方复合外键保证。
ALTER TABLE project_artifact_collections ADD COLUMN final_version_id TEXT;

-- 复合唯一索引：供审核与最终化审计用复合外键封住「跨作用域」与「版本不属于该集合」两个窗口。
CREATE UNIQUE INDEX project_artifact_versions_scope_idx
  ON project_artifact_versions(id, team_id, channel_id);

CREATE UNIQUE INDEX project_artifact_versions_collection_scope_idx
  ON project_artifact_versions(id, collection_id);

-- append-only 审核记录：没有 UPDATE/DELETE 路径，仓储接口也只暴露 list/append。
-- 一个版本可以有任意多条决定，版本的「当前审核状态」由最新一条派生，旧记录永远保留。
CREATE TABLE project_artifact_reviews (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  -- 审核语境：受审版本所属 Stage，写入时从版本自身读取，不接受客户端提交。
  stage_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'changes_requested')),
  comment TEXT NOT NULL DEFAULT '',
  basis_json TEXT NOT NULL DEFAULT '[]',
  reviewed_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (version_id, team_id, channel_id)
    REFERENCES project_artifact_versions(id, team_id, channel_id) ON DELETE CASCADE,
  -- 结构性保证：审核记录的 collection_id 必须就是该版本所属集合，无法指向别的集合。
  FOREIGN KEY (version_id, collection_id)
    REFERENCES project_artifact_versions(id, collection_id) ON DELETE CASCADE,
  FOREIGN KEY (stage_id, team_id, channel_id)
    REFERENCES project_stages(id, team_id, channel_id) ON DELETE CASCADE
);

-- 排序键与 domain 的 latestProjectArtifactReview 一致：created_at 后取 id。
CREATE INDEX project_artifact_reviews_version_idx
  ON project_artifact_reviews(version_id, created_at, id);

CREATE INDEX project_artifact_reviews_channel_idx
  ON project_artifact_reviews(team_id, channel_id, created_at, id);

-- append-only 最终化审计：每次切换写一行，记录切换来源、依据审核与操作者身份。
-- 首次最终化 previous_version_id 为 NULL；旧最终版行永不被修改或删除。
CREATE TABLE project_artifact_finalizations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  collection_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  previous_version_id TEXT,
  basis_review_id TEXT NOT NULL REFERENCES project_artifact_reviews(id) ON DELETE CASCADE,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('human', 'pi_manager')),
  finalized_by TEXT NOT NULL,
  management_run_id TEXT,
  -- PI Manager 代表用户最终化时必须携带的人类确认引用；人类自己操作时为 NULL。
  human_confirmation_kind TEXT CHECK (human_confirmation_kind IN ('message')),
  human_confirmation_ref_id TEXT,
  human_confirmation_by TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL,
  -- Manager 路径 fail-closed：actor_kind='pi_manager' 的行必须三项确认字段齐全。
  CHECK (
    (actor_kind = 'human'
      AND human_confirmation_kind IS NULL
      AND human_confirmation_ref_id IS NULL
      AND human_confirmation_by IS NULL)
    OR (actor_kind = 'pi_manager'
      AND human_confirmation_kind IS NOT NULL
      AND human_confirmation_ref_id IS NOT NULL
      AND human_confirmation_by IS NOT NULL
      AND management_run_id IS NOT NULL)
  ),
  FOREIGN KEY (version_id, team_id, channel_id)
    REFERENCES project_artifact_versions(id, team_id, channel_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, collection_id)
    REFERENCES project_artifact_versions(id, collection_id) ON DELETE CASCADE
);

CREATE INDEX project_artifact_finalizations_collection_idx
  ON project_artifact_finalizations(collection_id, created_at, id);

CREATE INDEX project_artifact_finalizations_channel_idx
  ON project_artifact_finalizations(team_id, channel_id, created_at, id);

-- 审核与最终化共用一个幂等命名空间：同一 key 复用到不同命令时 fail closed。
CREATE TABLE project_artifact_decision_mutations (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('review', 'finalization')),
  collection_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  review_id TEXT REFERENCES project_artifact_reviews(id) ON DELETE CASCADE,
  finalization_id TEXT REFERENCES project_artifact_finalizations(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, idempotency_key)
);
