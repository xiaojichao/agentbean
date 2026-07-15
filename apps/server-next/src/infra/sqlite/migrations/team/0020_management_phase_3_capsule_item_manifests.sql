-- Runtime recovery needs to reconstruct a Capsule from current Memory truth without persisting a
-- second copy of its body. This table stores only immutable selection/authorization metadata.
CREATE TABLE memory_capsule_item_manifests (
  capsule_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team', 'channel', 'dm', 'task', 'agent', 'user')),
  scope_ref TEXT NOT NULL CHECK (length(scope_ref) > 0),
  source_visibility TEXT NOT NULL CHECK (source_visibility IN ('team', 'private', 'dm-participants')),
  content_kind TEXT NOT NULL CHECK (content_kind IN ('summary', 'fact', 'decision', 'preference', 'procedure')),
  redaction_level TEXT NOT NULL CHECK (redaction_level IN ('none', 'summary-only', 'sensitive-removed')),
  content_field TEXT NOT NULL CHECK (content_field IN ('content', 'summary')),
  authorization_json TEXT NOT NULL CHECK (json_valid(authorization_json)),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (capsule_id, team_id, memory_id),
  UNIQUE (capsule_id, team_id, position),
  FOREIGN KEY (capsule_id, team_id)
    REFERENCES memory_capsule_refs(id, team_id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id, team_id)
    REFERENCES memory_items(id, team_id) ON DELETE RESTRICT
);

CREATE INDEX memory_capsule_item_manifests_lookup_idx
  ON memory_capsule_item_manifests(team_id, capsule_id, position, memory_id);
