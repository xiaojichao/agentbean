CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL,
  creator_id TEXT NOT NULL,
  assignee_id TEXT,
  channel_id TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  sort_order REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_tasks_team_channel ON tasks(team_id, channel_id);
CREATE INDEX idx_tasks_team_status ON tasks(team_id, status);
