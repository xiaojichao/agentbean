ALTER TABLE management_runs ADD COLUMN initiated_by_user_id TEXT;

CREATE TABLE management_access_audits (
  id TEXT PRIMARY KEY,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('team', 'channel', 'task', 'management')),
  scope_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('access', 'transmit', 'permission-change')),
  decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied')),
  diagnostic_code TEXT,
  projection_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX management_access_audits_run_created_idx
  ON management_access_audits(management_run_id, created_at, id);
