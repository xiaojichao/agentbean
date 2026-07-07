CREATE TABLE pinned_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id)
);
CREATE INDEX idx_pinned_channel ON pinned_messages(team_id, channel_id, created_at);
