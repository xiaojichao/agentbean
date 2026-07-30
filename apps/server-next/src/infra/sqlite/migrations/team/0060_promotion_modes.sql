-- #923 Promotion evaluator/proposal/Team policy/Agent escalation 与 atomic simple-request handoff。

CREATE TABLE semantic_promotion_rollouts (
  team_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'proposal-only')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_at INTEGER NOT NULL
);

CREATE TABLE semantic_promotion_evaluations (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_lineage_key TEXT NOT NULL,
  rollout TEXT NOT NULL CHECK (rollout IN ('off', 'shadow', 'proposal-only')),
  path_kind TEXT NOT NULL,
  evaluation_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX semantic_promotion_evaluations_source_idx
  ON semantic_promotion_evaluations(source_lineage_key, created_at);

CREATE TABLE promotion_proposals (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  source_lineage_key TEXT NOT NULL,
  source_lineage_json TEXT NOT NULL,
  source_revision INTEGER,
  requester_id TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  objective_snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'accepted', 'rejected', 'cancelled', 'expired')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  authorization_token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  root_task_id TEXT,
  management_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX promotion_proposals_open_lineage_idx
  ON promotion_proposals(source_lineage_key) WHERE status = 'open';

CREATE TABLE promotion_proposal_action_receipts (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  authority_subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  action TEXT NOT NULL CHECK (action IN ('accept', 'reject', 'cancel', 'expire')),
  command_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'no_op')),
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX promotion_proposal_action_receipts_proposal_idx
  ON promotion_proposal_action_receipts(proposal_id);

CREATE TABLE team_promotion_policies (
  team_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  rule_id TEXT NOT NULL,
  preauthorized INTEGER NOT NULL CHECK (preauthorized IN (0, 1)),
  require_orchestration_need INTEGER NOT NULL CHECK (require_orchestration_need = 1),
  updated_at INTEGER NOT NULL
);

CREATE TABLE simple_request_escalation_handoffs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_dispatch_id TEXT NOT NULL UNIQUE,
  target_agent_id TEXT NOT NULL,
  root_task_id TEXT NOT NULL,
  management_run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'applied'),
  targeted_offer_required INTEGER NOT NULL CHECK (targeted_offer_required = 1),
  targeted_offer_id TEXT NOT NULL UNIQUE,
  material_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
