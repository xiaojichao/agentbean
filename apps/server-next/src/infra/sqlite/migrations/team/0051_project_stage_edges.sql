CREATE TABLE project_stage_edges (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  upstream_stage_id TEXT NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,
  downstream_stage_id TEXT NOT NULL REFERENCES project_stages(id) ON DELETE CASCADE,
  upstream_task_id TEXT NOT NULL,
  upstream_task_revision INTEGER NOT NULL CHECK (upstream_task_revision > 0),
  downstream_task_id TEXT NOT NULL,
  downstream_task_revision INTEGER NOT NULL CHECK (downstream_task_revision > 0),
  semantics TEXT NOT NULL CHECK (semantics IN ('blocks_start', 'provides_context')),
  required_inputs_json TEXT NOT NULL DEFAULT '[]',
  mirrored_task_dependency INTEGER NOT NULL DEFAULT 0 CHECK (mirrored_task_dependency IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (upstream_stage_id <> downstream_stage_id),
  CHECK (upstream_task_id <> downstream_task_id),
  UNIQUE (team_id, channel_id, upstream_stage_id, downstream_stage_id),
  FOREIGN KEY (upstream_task_id, team_id, upstream_task_revision, channel_id)
    REFERENCES tasks(id, team_id, revision, channel_id) ON DELETE RESTRICT,
  FOREIGN KEY (downstream_task_id, team_id, downstream_task_revision, channel_id)
    REFERENCES tasks(id, team_id, revision, channel_id) ON DELETE RESTRICT
);

CREATE INDEX project_stage_edges_channel_idx
  ON project_stage_edges(team_id, channel_id, created_at, id);

CREATE INDEX project_stage_edges_downstream_idx
  ON project_stage_edges(team_id, channel_id, downstream_stage_id);

CREATE INDEX project_stage_edges_upstream_idx
  ON project_stage_edges(team_id, channel_id, upstream_stage_id);
