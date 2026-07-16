CREATE TABLE team_management_policies_v3 (
  team_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('direct', 'shadow', 'managed')),
  placement_policy_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  max_management_phase INTEGER NOT NULL DEFAULT 1
    CHECK (max_management_phase IN (1, 2, 3))
);

INSERT INTO team_management_policies_v3
  (team_id, mode, placement_policy_json, updated_by, updated_at, max_management_phase)
SELECT team_id, mode, placement_policy_json, updated_by, updated_at, max_management_phase
FROM team_management_policies;

DROP TABLE team_management_policies;
ALTER TABLE team_management_policies_v3 RENAME TO team_management_policies;

CREATE TABLE management_runs_v3 (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  root_task_id TEXT,
  root_message_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_for_agents', 'waiting_for_user', 'recovering', 'in_review', 'completed', 'failed', 'cancelled')),
  placement_policy_json TEXT NOT NULL,
  active_worker_id TEXT,
  checkpoint_revision INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_revision >= 0),
  budget_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  target_agent_id TEXT,
  target_kind TEXT CHECK (target_kind IN ('custom', 'agentos-hosted')),
  management_phase INTEGER NOT NULL DEFAULT 1
    CHECK (management_phase IN (1, 2, 3)),
  main_agent_id TEXT,
  active_agent_id TEXT,
  collaboration_mode TEXT NOT NULL DEFAULT 'single-agent'
    CHECK (collaboration_mode IN ('single-agent', 'manager-orchestrated', 'handoff'))
);

INSERT INTO management_runs_v3
  (id, team_id, channel_id, root_task_id, root_message_id, status, placement_policy_json,
   active_worker_id, checkpoint_revision, budget_json, created_at, updated_at, completed_at,
   target_agent_id, target_kind, management_phase, main_agent_id, active_agent_id, collaboration_mode)
SELECT id, team_id, channel_id, root_task_id, root_message_id, status, placement_policy_json,
  active_worker_id, checkpoint_revision, budget_json, created_at, updated_at, completed_at,
  target_agent_id, target_kind, management_phase, main_agent_id, active_agent_id, collaboration_mode
FROM management_runs;

DROP TABLE management_runs;
ALTER TABLE management_runs_v3 RENAME TO management_runs;

CREATE INDEX management_runs_team_created_idx
  ON management_runs(team_id, created_at, id);
CREATE INDEX management_runs_root_task_idx
  ON management_runs(root_task_id, created_at DESC)
  WHERE root_task_id IS NOT NULL;
