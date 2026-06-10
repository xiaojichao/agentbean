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

CREATE INDEX idx_device_invites_team ON device_invites(team_id);
