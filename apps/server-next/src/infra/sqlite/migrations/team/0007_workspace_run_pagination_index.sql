CREATE INDEX idx_workspace_runs_team_updated_id ON workspace_runs(team_id, updated_at DESC, id DESC);
