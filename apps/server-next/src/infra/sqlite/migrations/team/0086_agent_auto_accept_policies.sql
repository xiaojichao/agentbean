CREATE TABLE IF NOT EXISTS agent_auto_accept_policies (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  manifest_id TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  allowed_capability_ids_json TEXT NOT NULL,
  allow_unspecified_capabilities INTEGER NOT NULL CHECK (allow_unspecified_capabilities IN (0, 1)),
  allowed_risk_levels_json TEXT NOT NULL,
  allow_frozen_project_inputs INTEGER NOT NULL CHECK (allow_frozen_project_inputs IN (0, 1)),
  require_complete_preview INTEGER NOT NULL CHECK (require_complete_preview IN (0, 1)),
  max_active_claims INTEGER NOT NULL CHECK (max_active_claims > 0),
  valid_until INTEGER,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, agent_id),
  FOREIGN KEY (manifest_id) REFERENCES agent_exposure_manifests(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_auto_accept_policies_manifest
  ON agent_auto_accept_policies(team_id, agent_id, manifest_id, manifest_revision);
