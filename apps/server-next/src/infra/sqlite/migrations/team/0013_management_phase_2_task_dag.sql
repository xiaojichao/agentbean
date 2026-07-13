ALTER TABLE tasks
  ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0);

CREATE UNIQUE INDEX tasks_id_team_revision_idx
  ON tasks(id, team_id, revision);

CREATE TABLE task_coordinations (
  task_id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL REFERENCES management_runs(id) ON DELETE CASCADE,
  root_task_id TEXT,
  parent_task_id TEXT,
  node_kind TEXT NOT NULL CHECK (node_kind IN ('root', 'subtask')),
  review_policy TEXT NOT NULL CHECK (review_policy IN ('human', 'manager')),
  claim_policy TEXT NOT NULL CHECK (claim_policy IN ('open', 'targeted')),
  required_capabilities_json TEXT NOT NULL DEFAULT '[]',
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts >= attempt),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (task_id, team_id, task_revision),
  FOREIGN KEY (task_id, team_id, task_revision)
    REFERENCES tasks(id, team_id, revision) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX task_coordinations_run_idx
  ON task_coordinations(management_run_id, task_id);

CREATE TABLE task_acceptance_criteria (
  task_id TEXT NOT NULL REFERENCES task_coordinations(task_id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence_required INTEGER NOT NULL CHECK (evidence_required IN (0, 1)),
  allowed_evidence_kinds_json TEXT,
  introduced_revision INTEGER NOT NULL CHECK (introduced_revision > 0),
  retired_revision INTEGER CHECK (retired_revision >= introduced_revision),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (task_id, criterion_id)
);

CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES task_coordinations(task_id) ON DELETE CASCADE,
  dependency_task_id TEXT NOT NULL REFERENCES task_coordinations(task_id) ON DELETE CASCADE,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  CHECK (task_id <> dependency_task_id),
  PRIMARY KEY (task_id, dependency_task_id)
);

CREATE TABLE task_claim_leases (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  agent_id TEXT NOT NULL,
  lease_token_hash TEXT NOT NULL,
  lease_fingerprint TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'invalidated')),
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  UNIQUE (id, team_id, task_id, task_revision, task_attempt),
  FOREIGN KEY (task_id) REFERENCES task_coordinations(task_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX one_active_task_claim_per_attempt
  ON task_claim_leases(task_id, task_revision, task_attempt)
  WHERE status = 'active';

CREATE TABLE evidence_snapshots (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'artifact', 'workspace-run', 'invocation', 'task')),
  source_id TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  snapshot_revision INTEGER,
  snapshot_json TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  UNIQUE (team_id, task_id, invocation_id, kind, source_id, snapshot_hash),
  UNIQUE (id, team_id, task_id, invocation_id),
  FOREIGN KEY (task_id) REFERENCES task_coordinations(task_id) ON DELETE CASCADE
);

CREATE TABLE subtask_deliveries (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_revision INTEGER NOT NULL CHECK (task_revision > 0),
  task_attempt INTEGER NOT NULL CHECK (task_attempt > 0),
  claim_lease_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  delivery_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, idempotency_key),
  UNIQUE (id, team_id, task_id, invocation_id),
  UNIQUE (id, team_id, task_id, claim_lease_id, invocation_id),
  FOREIGN KEY (claim_lease_id, team_id, task_id, task_revision, task_attempt)
    REFERENCES task_claim_leases(id, team_id, task_id, task_revision, task_attempt) ON DELETE RESTRICT
);

CREATE TABLE subtask_delivery_evidence_refs (
  delivery_id TEXT NOT NULL,
  evidence_snapshot_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  PRIMARY KEY (delivery_id, evidence_snapshot_id),
  FOREIGN KEY (delivery_id, team_id, task_id, invocation_id)
    REFERENCES subtask_deliveries(id, team_id, task_id, invocation_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_snapshot_id, team_id, task_id, invocation_id)
    REFERENCES evidence_snapshots(id, team_id, task_id, invocation_id) ON DELETE RESTRICT
);

CREATE TABLE subtask_acceptances (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  claim_lease_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  decision_version INTEGER NOT NULL CHECK (decision_version > 0),
  decision TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'needs_human')),
  canonical INTEGER NOT NULL CHECK (canonical IN (0, 1)),
  acceptance_json TEXT NOT NULL,
  decided_at INTEGER NOT NULL,
  UNIQUE (delivery_id, decision_version),
  UNIQUE (id, team_id, task_id, invocation_id),
  FOREIGN KEY (delivery_id, team_id, task_id, claim_lease_id, invocation_id)
    REFERENCES subtask_deliveries(id, team_id, task_id, claim_lease_id, invocation_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX one_canonical_acceptance_per_delivery
  ON subtask_acceptances(delivery_id)
  WHERE canonical = 1;

CREATE TABLE subtask_acceptance_criterion_results (
  acceptance_id TEXT NOT NULL REFERENCES subtask_acceptances(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
  PRIMARY KEY (acceptance_id, criterion_id)
);

CREATE TABLE subtask_acceptance_evidence_refs (
  acceptance_id TEXT NOT NULL REFERENCES subtask_acceptances(id) ON DELETE CASCADE,
  criterion_id TEXT NOT NULL,
  evidence_snapshot_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,
  PRIMARY KEY (acceptance_id, criterion_id, evidence_snapshot_id),
  FOREIGN KEY (acceptance_id, criterion_id)
    REFERENCES subtask_acceptance_criterion_results(acceptance_id, criterion_id) ON DELETE CASCADE,
  FOREIGN KEY (acceptance_id, team_id, task_id, invocation_id)
    REFERENCES subtask_acceptances(id, team_id, task_id, invocation_id) ON DELETE CASCADE,
  FOREIGN KEY (evidence_snapshot_id, team_id, task_id, invocation_id)
    REFERENCES evidence_snapshots(id, team_id, task_id, invocation_id) ON DELETE RESTRICT
);
