-- #929 audience-scoped System activity / attention / change feed（ADR-0066/0067）
-- 投影与 attention 在 Server 侧按受众持久化；notice 仅唤醒，cursor ack 不推进 Message Read。

CREATE TABLE system_activity_projections (
  projection_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('task_timeline', 'thread_card', 'attention_inbox')),
  level TEXT NOT NULL CHECK (level IN ('info', 'milestone', 'attention', 'action_required')),
  fact_kind TEXT NOT NULL,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  root_task_id TEXT,
  channel_id TEXT,
  thread_id TEXT,
  recipient_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  summary TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind = 'system'),
  attention_identity TEXT,
  attention_revision INTEGER,
  task_revision INTEGER,
  delivery_revision INTEGER,
  allowed_commands_json TEXT,
  confirmation_token TEXT,
  escalation_revision INTEGER,
  feed_position INTEGER NOT NULL CHECK (feed_position >= 1),
  created_at INTEGER NOT NULL
);

-- 同一 event × recipient × surface 恰好一行（重放去重）
CREATE UNIQUE INDEX system_activity_projections_event_recipient_surface_idx
  ON system_activity_projections(event_id, recipient_id, surface);

CREATE INDEX system_activity_projections_task_recipient_idx
  ON system_activity_projections(task_id, recipient_id, surface, feed_position);

CREATE INDEX system_activity_projections_feed_idx
  ON system_activity_projections(recipient_id, feed_position);

CREATE TABLE system_attention_items (
  attention_identity TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  root_task_id TEXT,
  channel_id TEXT,
  thread_id TEXT,
  level TEXT NOT NULL CHECK (level IN ('attention', 'action_required')),
  state TEXT NOT NULL CHECK (state IN ('open', 'resolved', 'dismissed_by_policy', 'superseded')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  source_event_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
  seen_at INTEGER,
  last_reminder_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  resolved_at INTEGER,
  task_revision INTEGER,
  delivery_revision INTEGER,
  allowed_commands_json TEXT,
  confirmation_token TEXT,
  escalation_revision INTEGER
);

CREATE INDEX system_attention_items_recipient_idx
  ON system_attention_items(recipient_id, state, updated_at);

CREATE INDEX system_attention_items_task_idx
  ON system_attention_items(task_id, state);

CREATE TABLE system_activity_watermarks (
  stream_kind TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (stream_kind, stream_id)
);

CREATE TABLE system_activity_feed_cursors (
  recipient_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  acked_position INTEGER NOT NULL CHECK (acked_position >= 0),
  feed_epoch INTEGER NOT NULL CHECK (feed_epoch >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE system_activity_command_receipts (
  receipt_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL CHECK (command_name IN (
    'project-source-fact', 'mark-attention-seen', 'ack-change-feed-cursor', 'retrim-audience'
  )),
  command_schema_version INTEGER NOT NULL CHECK (command_schema_version >= 1),
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  committed_revisions_json TEXT NOT NULL,
  event_refs_json TEXT NOT NULL,
  result_available INTEGER NOT NULL CHECK (result_available IN (0, 1)),
  result_json TEXT,
  commit_time INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX system_activity_command_receipts_idempotency_idx
  ON system_activity_command_receipts(idempotency_key);

CREATE TABLE system_activity_idempotency_tombstones (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX system_activity_tombstones_idempotency_idx
  ON system_activity_idempotency_tombstones(idempotency_key);

CREATE TABLE system_activity_notices (
  notice_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  projection_ids_json TEXT NOT NULL,
  attention_identities_json TEXT NOT NULL,
  cursor TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  delivered_at INTEGER
);

CREATE INDEX system_activity_notices_pending_idx
  ON system_activity_notices(delivered_at, issued_at);
