-- Phase 3 P3-10/11（地基）：Candidate（外部 Agent 提议的记忆）持久化。
-- 外部 Agent 的新结论先进 candidate（spec §1/§11），由 PI Manager 关联来源、去重、识别冲突，
-- accept/reject/merge 后才进 active memory。本表是 review 队列（非审计），故保留 proposed_content 原文。
-- projection_hash 唯一约束做去重闸门（同 team 下相同 projection 不重复建 candidate）。

CREATE TABLE memory_candidates (
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  task_id TEXT,
  source_agent_id TEXT NOT NULL,
  source_invocation_id TEXT NOT NULL,
  source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
  content_kind TEXT NOT NULL CHECK (content_kind IN (
    'summary', 'fact', 'decision', 'preference', 'procedure'
  )),
  proposed_content TEXT NOT NULL CHECK (length(proposed_content) > 0),
  projection_hash TEXT NOT NULL CHECK (length(projection_hash) > 0),
  status TEXT NOT NULL CHECK (status IN (
    'candidate', 'accepted', 'rejected', 'merged', 'conflict'
  )),
  conflict_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflict_memory_ids_json)),
  created_at INTEGER NOT NULL,
  decided_at INTEGER,
  PRIMARY KEY (id, team_id),
  UNIQUE (team_id, projection_hash),
  CHECK ((status IN ('accepted', 'rejected', 'merged') AND decided_at IS NOT NULL)
    OR (status IN ('candidate', 'conflict') AND decided_at IS NULL)),
  CHECK (decided_at IS NULL OR decided_at >= created_at)
);

CREATE INDEX memory_candidates_run_idx
  ON memory_candidates(team_id, management_run_id, status, id);
