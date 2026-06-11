CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  dispatch_id TEXT,
  workspace_run_id TEXT,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT,
  relative_path TEXT,
  path_kind TEXT,
  sha256 TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE workspace_runs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  dispatch_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL,
  cwd TEXT,
  exit_code INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  artifact_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX idx_artifacts_team_id ON artifacts(team_id, id);
CREATE INDEX idx_artifacts_message ON artifacts(message_id, created_at);
CREATE INDEX idx_artifacts_workspace_run ON artifacts(workspace_run_id, created_at);
CREATE INDEX idx_workspace_runs_team_id ON workspace_runs(team_id, id);
CREATE INDEX idx_workspace_runs_dispatch ON workspace_runs(dispatch_id, created_at);
