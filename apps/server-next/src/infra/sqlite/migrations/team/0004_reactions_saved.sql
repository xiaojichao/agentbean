CREATE TABLE message_reactions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '❤️',
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, user_id, emoji)
);

CREATE INDEX idx_reactions_message ON message_reactions(message_id);

CREATE TABLE saved_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(message_id, user_id)
);

CREATE INDEX idx_saved_user_team ON saved_messages(user_id, team_id);
