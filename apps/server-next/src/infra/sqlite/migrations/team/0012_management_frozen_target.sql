ALTER TABLE management_runs ADD COLUMN target_agent_id TEXT;
ALTER TABLE management_runs ADD COLUMN target_kind TEXT CHECK (target_kind IN ('custom', 'agentos-hosted'));

CREATE INDEX management_runs_root_task_idx
  ON management_runs(root_task_id, created_at DESC)
  WHERE root_task_id IS NOT NULL;
