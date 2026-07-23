ALTER TABLE artifacts ADD COLUMN artifact_role TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_id TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_kind TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_label TEXT;

CREATE INDEX idx_artifacts_channel_path ON artifacts(team_id, channel_id, relative_path, created_at);

UPDATE artifacts
SET artifact_role = CASE
  WHEN message_id IS NOT NULL THEN 'attachment'
  WHEN workspace_run_id IS NOT NULL THEN 'run_output'
  ELSE artifact_role
END
WHERE artifact_role IS NULL;

UPDATE artifacts
SET source_root_id = 'legacy_run:' || workspace_run_id,
    source_root_kind = 'legacy_run',
    source_root_label = '历史运行产物'
WHERE workspace_run_id IS NOT NULL
  AND source_root_id IS NULL;

CREATE TABLE artifact_preview_jobs (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES artifacts(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL,
  input_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
  leased_until INTEGER,
  error_code TEXT,
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_artifact_preview_jobs_leasable
ON artifact_preview_jobs(status, leased_until, attempts, updated_at);
