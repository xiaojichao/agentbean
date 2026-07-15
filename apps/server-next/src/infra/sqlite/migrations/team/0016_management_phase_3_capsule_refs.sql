-- Phase 3 P3-08 (slice 1)：Capsule 引用持久化地基。
-- Capsule 本身是可撤销投影不持久化（spec §4.1，0015 无 capsule 表），但 Invocation intent
-- 引用 capsuleId 时，checkpoint 必须能权威判定该 capsule 是否仍有效（存在 + 未过期 + 未 deny），
-- 不能只信 intent 引用（management-checkpoint.ts 的 fail-closed 注释）。故单独持久化最小 ref。

CREATE TABLE memory_capsule_refs (
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  task_id TEXT,
  target_agent_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(content_hash) > 0),
  authorization_decision_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  denied_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (id, team_id),
  CHECK (denied_at IS NULL OR (denied_at >= issued_at AND denied_at <= expires_at))
);

CREATE INDEX memory_capsule_refs_run_idx
  ON memory_capsule_refs(team_id, management_run_id, id);
