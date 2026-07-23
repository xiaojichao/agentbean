-- Some focused migration tests start from a minimal Task-only database. Keep
-- this migration safe there; normal installs already created this table in
-- 0002 and the CREATE is a no-op.
CREATE TABLE IF NOT EXISTS artifacts (
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

ALTER TABLE artifacts ADD COLUMN artifact_role TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_id TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_kind TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_label TEXT;

CREATE INDEX idx_artifacts_channel_path ON artifacts(team_id, channel_id, relative_path, created_at);
