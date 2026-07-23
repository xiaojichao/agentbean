CREATE TABLE channel_documents (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE channel_document_revisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(document_id, revision)
);

CREATE INDEX idx_channel_documents_channel ON channel_documents(team_id, channel_id, updated_at DESC, id DESC);
CREATE INDEX idx_channel_document_revisions_document ON channel_document_revisions(document_id, revision DESC);
