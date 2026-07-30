-- #964 Project Channel Workspace import provenance
-- Add provenance_json column to track which device imported this revision,
-- without exposing the source device's absolute file paths.

ALTER TABLE project_channel_workspace_revisions
  ADD COLUMN provenance_json TEXT;
