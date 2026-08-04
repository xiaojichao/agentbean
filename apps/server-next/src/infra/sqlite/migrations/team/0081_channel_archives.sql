-- #1066 归档 Channel 并收口撤权、恢复与只读历史（AC12）：Channel 归档审计记录。
--
-- 只写不删：归档是权威人显式动作，保留稳定 identity/actor/authority basis/
-- channel revision/outcome/受影响工作清单/时间，供只读审计查询。
-- 与 0077/0078 同款取舍：cancelled/invalidated/pending 清单以 JSON 列存储
-- （归档后这些工作是终态事实，不再需要关系化查询）。

-- 审计行随频道硬删级联（与投影表外键 CASCADE 惯例一致：channel_archives 的
-- 只读语义是「不因成员撤权/归档改写」，频道本身删除时审计一并收口）。

CREATE TABLE IF NOT EXISTS channel_archives (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  actor_user_id TEXT NOT NULL,
  authority_basis TEXT NOT NULL,
  channel_revision INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  cancelled_task_ids_json TEXT NOT NULL,
  released_claim_ids_json TEXT NOT NULL,
  invalidated_offer_ids_json TEXT NOT NULL,
  cancelled_invocation_ids_json TEXT NOT NULL,
  pending_review_task_ids_json TEXT NOT NULL,
  pending_review_delivery_ids_json TEXT NOT NULL,
  pending_delivery_count INTEGER NOT NULL,
  cancelled_staging_count INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_archives_channel
  ON channel_archives (team_id, channel_id, archived_at DESC);
