CREATE TABLE channel_project_profiles (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
  project_lead_id TEXT NOT NULL,
  default_reviewer_ids_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id)
);

CREATE UNIQUE INDEX tasks_project_stage_scope_idx
  ON tasks(id, team_id, revision, channel_id);

CREATE TABLE project_stages (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  name TEXT NOT NULL,
  goal TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  reviewer_ids_json TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (team_id, channel_id, task_id),
  FOREIGN KEY (task_id, team_id, task_revision, channel_id)
    REFERENCES tasks(id, team_id, revision, channel_id) ON DELETE RESTRICT
);

CREATE INDEX project_stages_channel_idx
  ON project_stages(team_id, channel_id, created_at, id);

CREATE TABLE channel_project_mutations (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  profile_id TEXT NOT NULL REFERENCES channel_project_profiles(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,
  result_revision INTEGER NOT NULL CHECK (result_revision > 0),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, channel_id, idempotency_key)
);
