ALTER TABLE channel_document_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'attachment';
ALTER TABLE channel_document_revisions ADD COLUMN restored_from_revision_id TEXT;

CREATE TABLE channel_document_publications (
  id TEXT PRIMARY KEY,
  revision_id TEXT NOT NULL UNIQUE,
  message_id TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL
);

CREATE TABLE channel_document_operations (
  document_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  revision_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (document_id, idempotency_key)
);

CREATE INDEX idx_channel_document_publications_revision
  ON channel_document_publications(revision_id);
