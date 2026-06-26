CREATE INDEX IF NOT EXISTS idx_artifacts_workspace_run_boundary
  ON artifacts(team_id, channel_id, workspace_run_id, created_at);
