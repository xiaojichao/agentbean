CREATE TABLE project_reference_sets (
  id TEXT PRIMARY KEY,
  contract_version INTEGER NOT NULL DEFAULT 1,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id, message_id)
);
CREATE INDEX project_reference_sets_message_idx ON project_reference_sets(team_id, channel_id, message_id);

CREATE TABLE project_reference_selections (
  id TEXT PRIMARY KEY,
  reference_set_id TEXT NOT NULL REFERENCES project_reference_sets(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('bundle_all','bundle_subset','document','artifact_version')),
  position INTEGER NOT NULL CHECK (position >= 0),
  bundle_id TEXT,
  bundle_name TEXT,
  bundle_member_count INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (reference_set_id, position),
  CHECK (
    (bundle_id IS NULL AND bundle_name IS NULL AND bundle_member_count IS NULL)
    OR
    (bundle_id IS NOT NULL AND bundle_name IS NOT NULL AND bundle_member_count IS NOT NULL)
  )
);
CREATE INDEX project_reference_selections_set_idx ON project_reference_selections(reference_set_id, position);

CREATE TABLE project_reference_items (
  id TEXT PRIMARY KEY,
  selection_id TEXT NOT NULL REFERENCES project_reference_selections(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('document_revision','artifact_version')),
  position INTEGER NOT NULL CHECK (position >= 0),
  document_id TEXT,
  revision_id TEXT,
  revision_number INTEGER,
  filename TEXT,
  bundle_position INTEGER,
  collection_id TEXT,
  version_id TEXT,
  version_number INTEGER,
  artifact_id TEXT,
  artifact_filename TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (selection_id, position),
  CHECK (
    (
      kind = 'document_revision'
      AND document_id IS NOT NULL
      AND revision_id IS NOT NULL
      AND revision_number IS NOT NULL
      AND filename IS NOT NULL
      AND collection_id IS NULL
      AND version_id IS NULL
      AND version_number IS NULL
      AND artifact_id IS NULL
      AND artifact_filename IS NULL
    )
    OR
    (
      kind = 'artifact_version'
      AND document_id IS NULL
      AND revision_id IS NULL
      AND revision_number IS NULL
      AND filename IS NULL
      AND bundle_position IS NULL
      AND collection_id IS NOT NULL
      AND version_id IS NOT NULL
      AND version_number IS NOT NULL
      AND artifact_id IS NOT NULL
      AND artifact_filename IS NOT NULL
    )
  )
);

CREATE TABLE project_reference_set_mutations (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  reference_set_id TEXT NOT NULL REFERENCES project_reference_sets(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, idempotency_key)
);
