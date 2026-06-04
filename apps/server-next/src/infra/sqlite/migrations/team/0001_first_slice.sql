CREATE TABLE channels (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'channel',
  name TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  dm_target_agent_id TEXT
);

CREATE TABLE channel_human_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE channel_agent_members (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_id TEXT,
  sender_kind TEXT NOT NULL,
  sender_id TEXT,
  sender_name TEXT,
  body TEXT NOT NULL,
  client_message_id TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE dispatches (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  device_id TEXT,
  status TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  prompt TEXT NOT NULL,
  history_json TEXT NOT NULL DEFAULT '[]',
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  accepted_at INTEGER,
  completed_at INTEGER
);

CREATE INDEX idx_channels_team_created ON channels(team_id, created_at);
CREATE INDEX idx_channels_team_kind ON channels(team_id, kind);
CREATE INDEX idx_channel_human_members_user ON channel_human_members(user_id);
CREATE INDEX idx_channel_agent_members_agent ON channel_agent_members(agent_id);
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX idx_messages_client_id ON messages(channel_id, client_message_id);
CREATE INDEX idx_dispatches_message ON dispatches(message_id);
CREATE INDEX idx_dispatches_agent_status ON dispatches(agent_id, status);
CREATE INDEX idx_dispatches_request_id ON dispatches(request_id);
