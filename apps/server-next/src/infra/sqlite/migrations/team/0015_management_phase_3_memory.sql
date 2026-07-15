CREATE TABLE memory_items (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'semantic', 'episodic', 'procedural', 'preference', 'decision', 'artifact-summary'
  )),
  status TEXT NOT NULL CHECK (status IN (
    'candidate', 'active', 'rejected', 'expired', 'superseded', 'deleted'
  )),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team', 'channel', 'dm', 'task', 'agent', 'user')),
  scope_ref TEXT NOT NULL CHECK (length(scope_ref) > 0),
  content TEXT NOT NULL CHECK (length(content) > 0),
  summary TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  created_by_user_id TEXT,
  created_by_agent_id TEXT,
  approved_by_user_id TEXT,
  valid_from INTEGER,
  valid_until INTEGER,
  superseded_by_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (id, team_id),
  CHECK (created_by_user_id IS NULL OR created_by_agent_id IS NULL),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from),
  FOREIGN KEY (superseded_by_id, team_id)
    REFERENCES memory_items(id, team_id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX memory_items_scope_idx
  ON memory_items(team_id, scope_type, scope_ref, status, updated_at DESC, id);

CREATE INDEX memory_items_validity_idx
  ON memory_items(team_id, status, valid_until, id);

CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'message', 'task', 'artifact', 'workspace-run', 'invocation', 'memory', 'manual', 'local-summary'
  )),
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) > 0),
  source_scope_type TEXT NOT NULL CHECK (source_scope_type IN (
    'team', 'channel', 'dm', 'task', 'agent', 'user'
  )),
  source_scope_ref TEXT NOT NULL CHECK (length(source_scope_ref) > 0),
  source_visibility TEXT NOT NULL CHECK (source_visibility IN (
    'team', 'private', 'dm-participants'
  )),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, source_kind, source_id),
  FOREIGN KEY (memory_id, team_id)
    REFERENCES memory_items(id, team_id) ON DELETE CASCADE
);

CREATE INDEX memory_sources_source_idx
  ON memory_sources(team_id, source_kind, source_id, memory_id);

CREATE TABLE memory_tags (
  memory_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  tag TEXT NOT NULL CHECK (
    length(tag) > 0
    AND tag = lower(tag)
    AND tag NOT GLOB '*[^a-z0-9-]*'
    AND tag NOT LIKE '-%'
    AND tag NOT LIKE '%-'
    AND tag NOT LIKE '%--%'
  ),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id, team_id)
    REFERENCES memory_items(id, team_id) ON DELETE CASCADE
);

CREATE INDEX memory_tags_tag_idx
  ON memory_tags(team_id, tag, memory_id);

CREATE TABLE memory_grants (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  team_id TEXT NOT NULL,
  source_scope_type TEXT NOT NULL CHECK (source_scope_type IN (
    'team', 'channel', 'dm', 'task', 'agent', 'user'
  )),
  source_scope_ref TEXT NOT NULL CHECK (length(source_scope_ref) > 0),
  target_agent_id TEXT NOT NULL,
  authorized_content_kind TEXT NOT NULL CHECK (authorized_content_kind IN (
    'summary', 'fact', 'decision', 'preference', 'procedure'
  )),
  authorized_redaction_level TEXT NOT NULL CHECK (authorized_redaction_level IN (
    'none', 'summary-only', 'sensitive-removed'
  )),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  issued_by_user_id TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
  revoked_at INTEGER,
  PRIMARY KEY (id, version),
  UNIQUE (id, version, team_id),
  CHECK ((status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL))
);

CREATE INDEX memory_grants_current_idx
  ON memory_grants(team_id, id, version DESC);

CREATE INDEX memory_grants_scope_idx
  ON memory_grants(team_id, source_scope_type, source_scope_ref, target_agent_id, version DESC);

CREATE TABLE memory_audit_events (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('memory', 'grant', 'capsule', 'candidate')),
  subject_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'memory-created', 'memory-updated', 'memory-activated', 'memory-rejected',
    'memory-expired', 'memory-superseded', 'memory-deleted',
    'source-linked', 'tag-linked', 'tag-unlinked', 'grant-issued', 'grant-revoked',
    'capsule-created', 'capsule-read', 'capsule-injected', 'capsule-denied', 'capsule-expired',
    'candidate-created', 'candidate-decided'
  )),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('system', 'user', 'agent', 'manager')),
  actor_id TEXT,
  decision_id TEXT,
  target_agent_id TEXT,
  scope_type TEXT CHECK (scope_type IS NULL OR scope_type IN (
    'team', 'channel', 'dm', 'task', 'agent', 'user', 'local-workspace'
  )),
  scope_ref TEXT,
  source_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_refs_json)),
  source_refs_hash TEXT,
  content_hash TEXT,
  redaction_level TEXT CHECK (redaction_level IS NULL OR redaction_level IN (
    'none', 'summary-only', 'sensitive-removed'
  )),
  created_at INTEGER NOT NULL,
  CHECK ((scope_type IS NULL) = (scope_ref IS NULL)),
  CHECK (scope_type <> 'local-workspace' OR event_type = 'capsule-denied')
);

CREATE INDEX memory_audit_subject_idx
  ON memory_audit_events(team_id, subject_kind, subject_id, created_at, id);
