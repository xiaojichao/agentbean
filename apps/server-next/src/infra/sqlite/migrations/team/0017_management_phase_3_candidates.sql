CREATE TABLE memory_candidates (
  id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  task_id TEXT,
  source_agent_id TEXT NOT NULL,
  source_invocation_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team', 'channel', 'dm', 'task', 'agent', 'user')),
  scope_ref TEXT NOT NULL CHECK (length(scope_ref) > 0),
  content_kind TEXT NOT NULL CHECK (content_kind IN (
    'summary', 'fact', 'decision', 'preference', 'procedure'
  )),
  proposed_content TEXT NOT NULL CHECK (length(proposed_content) > 0),
  projection_hash TEXT NOT NULL CHECK (length(projection_hash) > 0),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
    'candidate', 'accepted', 'rejected', 'merged', 'conflict'
  )),
  conflict_memory_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conflict_memory_ids_json)),
  decided_at INTEGER,
  decided_by TEXT,
  accepted_memory_id TEXT,
  merged_into_memory_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, team_id),
  CHECK (decided_at IS NOT NULL OR status IN ('candidate', 'conflict')),
  CHECK (decided_at IS NULL OR decided_at >= created_at)
);

CREATE INDEX memory_candidates_projection_idx
  ON memory_candidates(team_id, projection_hash, status, updated_at DESC, id);

CREATE INDEX memory_candidates_invocation_idx
  ON memory_candidates(team_id, source_invocation_id, id);

CREATE TABLE memory_candidate_sources (
  memory_candidate_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'message', 'task', 'artifact', 'workspace-run', 'invocation', 'memory', 'manual', 'local-summary'
  )),
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) > 0),
  source_scope_type TEXT NOT NULL CHECK (source_scope_type IN (
    'team', 'channel', 'dm', 'task', 'agent', 'user'
  )),
  source_scope_ref TEXT NOT NULL CHECK (length(source_scope_ref) > 0),
  source_visibility TEXT NOT NULL CHECK (source_visibility IN (
    'team', 'private', 'dm-participants'
  )),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_candidate_id, source_kind, source_id),
  FOREIGN KEY (memory_candidate_id, team_id)
    REFERENCES memory_candidates(id, team_id) ON DELETE CASCADE
);

CREATE INDEX memory_candidate_sources_source_idx
  ON memory_candidate_sources(team_id, source_kind, source_id, memory_candidate_id);
