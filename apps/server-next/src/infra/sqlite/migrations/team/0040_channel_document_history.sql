ALTER TABLE channel_document_revisions ADD COLUMN source TEXT NOT NULL DEFAULT 'attachment';
ALTER TABLE channel_document_revisions ADD COLUMN restored_from_revision_id TEXT;

UPDATE channel_document_revisions
SET source = 'run'
WHERE artifact_id IN (
  SELECT id
  FROM artifacts
  WHERE workspace_run_id IS NOT NULL OR dispatch_id IS NOT NULL
);

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

INSERT OR IGNORE INTO channel_document_publications (
  id, revision_id, message_id, published_by, published_at
)
SELECT
  r.id || ':publication',
  r.id,
  a.message_id,
  r.created_by,
  r.created_at
FROM channel_document_revisions r
JOIN artifacts a ON a.id = r.artifact_id
WHERE a.message_id IS NOT NULL;

CREATE INDEX idx_channel_document_publications_revision
  ON channel_document_publications(revision_id);
