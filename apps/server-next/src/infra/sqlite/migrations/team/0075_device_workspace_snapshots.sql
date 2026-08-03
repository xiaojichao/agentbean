CREATE TABLE IF NOT EXISTS device_workspace_snapshots (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_workspace_snapshots_scope
  ON device_workspace_snapshots (team_id, channel_id, created_at);
