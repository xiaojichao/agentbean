CREATE TABLE IF NOT EXISTS project_channel_workspaces (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE,
  current_revision_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project_channel_workspace_revisions (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  files_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(channel_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_project_channel_workspace_revisions_channel
  ON project_channel_workspace_revisions(team_id, channel_id, revision DESC);
