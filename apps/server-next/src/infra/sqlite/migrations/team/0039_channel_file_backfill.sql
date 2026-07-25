ALTER TABLE artifact_preview_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE TABLE channel_file_backfill_progress (
  id TEXT PRIMARY KEY,
  cursor_created_at INTEGER,
  cursor_artifact_id TEXT,
  completed_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_artifacts_backfill_cursor ON artifacts(created_at, id);
