CREATE TABLE project_document_input_set_results (
  input_set_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES channel_documents(id) ON DELETE CASCADE,
  base_revision_id TEXT NOT NULL REFERENCES channel_document_revisions(id),
  status TEXT NOT NULL CHECK (status IN ('unchanged','committed','conflict','failed')),
  artifact_id TEXT REFERENCES artifacts(id),
  revision_id TEXT REFERENCES channel_document_revisions(id),
  error TEXT,
  request_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (input_set_id, document_id),
  CHECK (
    (status = 'unchanged' AND artifact_id IS NULL AND revision_id IS NULL AND error IS NULL)
    OR (status = 'committed' AND artifact_id IS NOT NULL AND revision_id IS NOT NULL AND error IS NULL)
    OR (status = 'conflict' AND artifact_id IS NOT NULL AND revision_id IS NULL)
    OR (status = 'failed' AND revision_id IS NULL)
  )
);

CREATE INDEX project_document_input_set_results_invocation_idx
  ON project_document_input_set_results(team_id, channel_id, invocation_id, created_at);

CREATE TRIGGER project_document_input_set_results_scope_insert
BEFORE INSERT ON project_document_input_set_results
FOR EACH ROW
WHEN NOT EXISTS (
  SELECT 1
  FROM channels AS channel
  JOIN channel_documents AS document ON document.id = NEW.document_id
  JOIN channel_document_revisions AS base_revision
    ON base_revision.id = NEW.base_revision_id
   AND base_revision.document_id = NEW.document_id
  WHERE channel.id = NEW.channel_id
    AND channel.team_id = NEW.team_id
    AND document.team_id = NEW.team_id
    AND document.channel_id = NEW.channel_id
)
BEGIN
  SELECT RAISE(ABORT, 'project document input set result scope mismatch');
END;
