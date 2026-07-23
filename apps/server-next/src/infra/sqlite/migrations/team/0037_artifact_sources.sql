ALTER TABLE artifacts ADD COLUMN artifact_role TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_id TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_kind TEXT;
ALTER TABLE artifacts ADD COLUMN source_root_label TEXT;

CREATE INDEX idx_artifacts_channel_path ON artifacts(team_id, channel_id, relative_path, created_at);
