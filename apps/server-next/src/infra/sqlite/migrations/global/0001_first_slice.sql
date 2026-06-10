CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  display_name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  current_team_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE join_links (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  max_uses INTEGER,
  uses_count INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE device_invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  completed_at INTEGER,
  machine_id TEXT,
  profile_id TEXT,
  hostname TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  machine_id TEXT,
  profile_id TEXT,
  hostname TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  daemon_version TEXT,
  system_info TEXT,
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE device_runtimes (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  adapter_kind TEXT NOT NULL,
  name TEXT NOT NULL,
  installed INTEGER NOT NULL DEFAULT 0,
  command TEXT,
  normalized_command_key TEXT,
  cwd TEXT,
  normalized_cwd_key TEXT,
  version TEXT,
  last_seen_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  primary_team_id TEXT NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  role TEXT,
  description TEXT,
  adapter_kind TEXT NOT NULL,
  category TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'offline',
  owner_id TEXT,
  device_id TEXT,
  command TEXT,
  args_json TEXT,
  cwd TEXT,
  env_json TEXT,
  last_seen_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (primary_team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TABLE agent_identity_links (
  identity_key TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE agent_publications (
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, team_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_users_current_team ON users(current_team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE INDEX idx_join_links_team ON join_links(team_id);
CREATE INDEX idx_device_invites_team ON device_invites(team_id);
CREATE INDEX idx_devices_team ON devices(team_id);
CREATE INDEX idx_devices_machine_profile ON devices(machine_id, profile_id);
CREATE INDEX idx_device_runtimes_device ON device_runtimes(device_id);
CREATE INDEX idx_device_runtimes_identity ON device_runtimes(team_id, device_id, adapter_kind, normalized_command_key, normalized_cwd_key);
CREATE INDEX idx_agents_primary_team ON agents(primary_team_id);
CREATE INDEX idx_agents_device ON agents(device_id);
CREATE INDEX idx_agents_identity_lookup ON agents(primary_team_id, device_id, adapter_kind, normalized_name);
CREATE INDEX idx_agent_publications_team ON agent_publications(team_id);
