import type {
  PromotionGateCommandName,
  PromotionGateReceiptOutcome,
  PromotionRiskLevel,
  PromotionRevisionRefV1,
  PromotionEventRefV1,
  PromotionProposalStatus,
  SemanticPromotionRolloutMode,
  TeamPromotionPolicyV1,
} from '../../../../../packages/contracts/src/index.js';
import type { SqliteDatabase } from './repositories.js';
import type {
  PromotionCommandReceiptRecord,
  PromotionCommandReceiptRepository,
  PromotionGateRepositories,
  PromotionIdempotencyTombstoneRecord,
  PromotionOutboxRecord,
  PromotionOutboxRepository,
  PromotionSchedulingIntentRecord,
  PromotionSchedulingIntentRepository,
  PromotionSourceRelationRecord,
  PromotionSourceRelationRepository,
  PromotionProposalRecord,
  PromotionProposalActionReceiptRecord,
  SemanticPromotionEvaluationRecord,
  SimpleRequestEscalationHandoffRecord,
} from '../../application/promotion-gate-repositories.js';

// #922 Promotion gate 的 SQLite 持久化实现。模式与 #921 message-tracer-repositories 一致：
// Row 接口 + mapRow（JSON 字段 parse/stringify、bool↔int）+ INSERT/SELECT（UNIQUE 靠 DB 约束抛错）。

interface SourceRelationRow {
  id: string;
  team_id: string;
  lineage_key: string;
  task_id: string;
  management_run_id: string;
  requester_id: string;
  trigger_command_revision: number;
  objective_snapshot_json: string;
  scope_snapshot_json: string;
  risk_level: PromotionRiskLevel;
  data_snapshot_json: string | null;
  provenance_json: string;
  claim_state: string;
  created_at: number;
}

interface SchedulingIntentRow {
  id: string;
  team_id: string;
  management_run_id: string;
  intent: string;
  profile_hint: string | null;
  deadline: number | null;
  attempt: number;
  state: string;
  created_at: number;
}

interface OutboxRow {
  id: string;
  team_id: string;
  receipt_id: string;
  event_ref_json: string;
  audience: string;
  delivery_state: string;
  created_at: number;
}

interface ReceiptRow {
  receipt_id: string;
  team_id: string;
  command_name: PromotionGateCommandName;
  command_schema_version: number;
  idempotency_key: string;
  command_hash: string;
  outcome: PromotionGateReceiptOutcome;
  committed_revisions_json: string;
  event_refs_json: string;
  result_available: number;
  result_json: string | null;
  commit_time: number;
  created_at: number;
}

interface TombstoneRow {
  id: string;
  team_id: string;
  command_name: PromotionGateCommandName;
  idempotency_key: string;
  command_hash: string;
  receipt_id: string;
  outcome: PromotionGateReceiptOutcome;
  result_available: number;
  created_at: number;
}

interface EvaluationRow {
  id: string;
  team_id: string;
  channel_id: string;
  source_lineage_key: string;
  rollout: SemanticPromotionRolloutMode;
  path_kind: string;
  evaluation_json: string | null;
  created_at: number;
}

interface SemanticPromotionRolloutRow {
  team_id: string;
  mode: SemanticPromotionRolloutMode;
  revision: number;
  updated_at: number;
}

interface ProposalRow {
  id: string;
  team_id: string;
  channel_id: string;
  source_lineage_key: string;
  source_lineage_json: string;
  source_revision: number | null;
  requester_id: string;
  approver_id: string;
  objective_snapshot_json: string;
  status: PromotionProposalStatus;
  revision: number;
  authorization_token_hash: string;
  expires_at: number;
  root_task_id: string | null;
  management_run_id: string | null;
  created_at: number;
  updated_at: number;
}

interface ProposalActionReceiptRow {
  id: string;
  proposal_id: string;
  authority_subject: string;
  idempotency_key: string;
  action: PromotionProposalActionReceiptRecord['action'];
  command_hash: string;
  outcome: PromotionProposalActionReceiptRecord['outcome'];
  result_json: string;
  created_at: number;
}

interface TeamPromotionPolicyRow {
  team_id: string;
  revision: number;
  enabled: number;
  rule_id: string;
  preauthorized: number;
  require_orchestration_need: number;
  updated_at: number;
}

interface SimpleRequestHandoffRow {
  id: string;
  team_id: string;
  source_message_id: string;
  source_dispatch_id: string;
  target_agent_id: string;
  root_task_id: string;
  management_run_id: string;
  status: 'applied';
  targeted_offer_required: number;
  targeted_offer_id: string;
  material_json: string;
  created_at: number;
}

function mapSourceRelation(row: SourceRelationRow | undefined): PromotionSourceRelationRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    lineageKey: row.lineage_key,
    taskId: row.task_id,
    managementRunId: row.management_run_id,
    requesterId: row.requester_id,
    triggerCommandRevision: row.trigger_command_revision,
    objectiveSnapshotJson: row.objective_snapshot_json,
    scopeSnapshotJson: row.scope_snapshot_json,
    riskLevel: row.risk_level,
    dataSnapshotJson: row.data_snapshot_json,
    provenanceJson: row.provenance_json,
    claimState: row.claim_state as 'awaiting-driver',
    createdAt: row.created_at,
  };
}

function mapReceipt(row: ReceiptRow | undefined): PromotionCommandReceiptRecord | null {
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    teamId: row.team_id,
    commandName: row.command_name,
    commandSchemaVersion: row.command_schema_version,
    idempotencyKey: row.idempotency_key,
    commandHash: row.command_hash,
    outcome: row.outcome,
    committedRevisions: JSON.parse(row.committed_revisions_json) as PromotionRevisionRefV1[],
    eventRefs: JSON.parse(row.event_refs_json) as PromotionEventRefV1[],
    resultAvailable: row.result_available === 1,
    resultJson: row.result_json,
    commitTime: row.commit_time,
    createdAt: row.created_at,
  };
}

function mapTombstone(row: TombstoneRow | undefined): PromotionIdempotencyTombstoneRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    commandName: row.command_name,
    idempotencyKey: row.idempotency_key,
    commandHash: row.command_hash,
    receiptId: row.receipt_id,
    outcome: row.outcome,
    resultAvailable: row.result_available === 1,
    createdAt: row.created_at,
  };
}

function mapProposal(row: ProposalRow | undefined): PromotionProposalRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    channelId: row.channel_id,
    sourceLineageKey: row.source_lineage_key,
    sourceLineageJson: row.source_lineage_json,
    sourceRevision: row.source_revision,
    requesterId: row.requester_id,
    approverId: row.approver_id,
    objectiveSnapshotJson: row.objective_snapshot_json,
    status: row.status,
    revision: row.revision,
    authorizationTokenHash: row.authorization_token_hash,
    expiresAt: row.expires_at,
    rootTaskId: row.root_task_id,
    managementRunId: row.management_run_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapActionReceipt(row: ProposalActionReceiptRow | undefined): PromotionProposalActionReceiptRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    proposalId: row.proposal_id,
    authoritySubject: row.authority_subject,
    idempotencyKey: row.idempotency_key,
    action: row.action,
    commandHash: row.command_hash,
    outcome: row.outcome,
    resultJson: row.result_json,
    createdAt: row.created_at,
  };
}

export function createSqlitePromotionSourceRelationRepository(
  teamDb: SqliteDatabase,
): PromotionSourceRelationRepository {
  return {
    async create(input) {
      teamDb.prepare(`INSERT INTO promotion_source_relations (
          id, team_id, lineage_key, task_id, management_run_id, requester_id, trigger_command_revision,
          objective_snapshot_json, scope_snapshot_json, risk_level, data_snapshot_json, provenance_json,
          claim_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.teamId,
          input.lineageKey,
          input.taskId,
          input.managementRunId,
          input.requesterId,
          input.triggerCommandRevision,
          input.objectiveSnapshotJson,
          input.scopeSnapshotJson,
          input.riskLevel,
          input.dataSnapshotJson,
          input.provenanceJson,
          input.claimState,
          input.createdAt,
        );
      return input;
    },
    async getByLineageKey(lineageKey) {
      const row = teamDb.prepare(
        `SELECT id, team_id, lineage_key, task_id, management_run_id, requester_id, trigger_command_revision,
           objective_snapshot_json, scope_snapshot_json, risk_level, data_snapshot_json, provenance_json,
           claim_state, created_at
         FROM promotion_source_relations WHERE lineage_key = ?`,
      ).get(lineageKey) as SourceRelationRow | undefined;
      return mapSourceRelation(row);
    },
  };
}

export function createSqlitePromotionSchedulingIntentRepository(
  teamDb: SqliteDatabase,
): PromotionSchedulingIntentRepository {
  return {
    async create(input: PromotionSchedulingIntentRecord) {
      teamDb.prepare(`INSERT INTO promotion_scheduling_intents (
          id, team_id, management_run_id, intent, profile_hint, deadline, attempt, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.teamId,
          input.managementRunId,
          input.intent,
          input.profileHint,
          input.deadline,
          input.attempt,
          input.state,
          input.createdAt,
        );
      return input;
    },
  };
}

export function createSqlitePromotionOutboxRepository(teamDb: SqliteDatabase): PromotionOutboxRepository {
  return {
    async create(input: PromotionOutboxRecord) {
      teamDb.prepare(`INSERT INTO promotion_outbox_records (
          id, team_id, receipt_id, event_ref_json, audience, delivery_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.teamId,
          input.receiptId,
          input.eventRefJson,
          input.audience,
          input.deliveryState,
          input.createdAt,
        );
      return input;
    },
  };
}

export function createSqlitePromotionCommandReceiptRepository(
  teamDb: SqliteDatabase,
): PromotionCommandReceiptRepository {
  // 复用同一列清单，避免两处 SELECT 漂移（加列时只改一处）。
  const RECEIPT_COLUMNS = `receipt_id, team_id, command_name, command_schema_version, idempotency_key, command_hash, outcome,
           committed_revisions_json, event_refs_json, result_available, result_json, commit_time, created_at`;
  return {
    async createReceipt(input) {
      teamDb.prepare(`INSERT INTO promotion_command_receipts (
          receipt_id, team_id, command_name, command_schema_version, idempotency_key, command_hash, outcome,
          committed_revisions_json, event_refs_json, result_available, result_json, commit_time, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.receiptId,
          input.teamId,
          input.commandName,
          input.commandSchemaVersion,
          input.idempotencyKey,
          input.commandHash,
          input.outcome,
          JSON.stringify(input.committedRevisions),
          JSON.stringify(input.eventRefs),
          input.resultAvailable ? 1 : 0,
          input.resultJson,
          input.commitTime,
          input.createdAt,
        );
      return input;
    },
    async getReceiptByIdempotencyKey(idempotencyKey) {
      const row = teamDb.prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM promotion_command_receipts WHERE idempotency_key = ?`,
      ).get(idempotencyKey) as ReceiptRow | undefined;
      return mapReceipt(row);
    },
    async getReceiptById(receiptId) {
      const row = teamDb.prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM promotion_command_receipts WHERE receipt_id = ?`,
      ).get(receiptId) as ReceiptRow | undefined;
      return mapReceipt(row);
    },
    async createTombstone(input) {
      teamDb.prepare(`INSERT INTO promotion_idempotency_tombstones (
          id, team_id, command_name, idempotency_key, command_hash, receipt_id, outcome, result_available, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.teamId,
          input.commandName,
          input.idempotencyKey,
          input.commandHash,
          input.receiptId,
          input.outcome,
          input.resultAvailable ? 1 : 0,
          input.createdAt,
        );
      return input;
    },
    async getTombstoneByIdempotencyKey(idempotencyKey) {
      const row = teamDb.prepare(
        `SELECT id, team_id, command_name, idempotency_key, command_hash, receipt_id, outcome, result_available, created_at
         FROM promotion_idempotency_tombstones WHERE idempotency_key = ?`,
      ).get(idempotencyKey) as TombstoneRow | undefined;
      return mapTombstone(row);
    },
  };
}

export function createSqlitePromotionGateRepositories(teamDb: SqliteDatabase): PromotionGateRepositories {
  return {
    sourceRelations: createSqlitePromotionSourceRelationRepository(teamDb),
    schedulingIntents: createSqlitePromotionSchedulingIntentRepository(teamDb),
    outbox: createSqlitePromotionOutboxRepository(teamDb),
    receipts: createSqlitePromotionCommandReceiptRepository(teamDb),
    evaluations: {
      async create(input) {
        teamDb.prepare(`INSERT INTO semantic_promotion_evaluations
          (id, team_id, channel_id, source_lineage_key, rollout, path_kind, evaluation_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.id, input.teamId, input.channelId, input.sourceLineageKey, input.rollout,
            input.pathKind, input.evaluationJson, input.createdAt);
        return input;
      },
      async listBySourceLineageKey(sourceLineageKey) {
        const rows = teamDb.prepare(`SELECT id, team_id, channel_id, source_lineage_key, rollout,
          path_kind, evaluation_json, created_at
          FROM semantic_promotion_evaluations WHERE source_lineage_key = ? ORDER BY created_at, id`)
          .all(sourceLineageKey) as EvaluationRow[];
        return rows.map((row): SemanticPromotionEvaluationRecord => ({
          id: row.id,
          teamId: row.team_id,
          channelId: row.channel_id,
          sourceLineageKey: row.source_lineage_key,
          rollout: row.rollout,
          pathKind: row.path_kind,
          evaluationJson: row.evaluation_json,
          createdAt: row.created_at,
        }));
      },
    },
    semanticRollout: {
      async get(teamId) {
        const row = teamDb.prepare('SELECT * FROM semantic_promotion_rollouts WHERE team_id = ?')
          .get(teamId) as SemanticPromotionRolloutRow | undefined;
        return row ? {
          schemaVersion: 1,
          teamId: row.team_id,
          mode: row.mode,
          revision: row.revision,
          updatedAt: row.updated_at,
        } : null;
      },
      async upsert(input) {
        const currentRow = teamDb.prepare('SELECT * FROM semantic_promotion_rollouts WHERE team_id = ?')
          .get(input.teamId) as SemanticPromotionRolloutRow | undefined;
        const current = currentRow ? {
          schemaVersion: 1 as const,
          teamId: currentRow.team_id,
          mode: currentRow.mode,
          revision: currentRow.revision,
          updatedAt: currentRow.updated_at,
        } : null;
        if (!canUpsertRevisionedConfig(current, input)) return null;
        if (current?.revision === input.revision) return current;
        teamDb.prepare(`INSERT INTO semantic_promotion_rollouts
          (team_id, mode, revision, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(team_id) DO UPDATE SET mode = excluded.mode, revision = excluded.revision,
            updated_at = excluded.updated_at`)
          .run(input.teamId, input.mode, input.revision, input.updatedAt);
        return input;
      },
    },
    proposals: {
      async create(input) {
        teamDb.prepare(`INSERT INTO promotion_proposals
          (id, team_id, channel_id, source_lineage_key, source_lineage_json, source_revision,
           requester_id, approver_id, objective_snapshot_json, status, revision,
           authorization_token_hash, expires_at, root_task_id, management_run_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.id, input.teamId, input.channelId, input.sourceLineageKey, input.sourceLineageJson,
            input.sourceRevision, input.requesterId, input.approverId, input.objectiveSnapshotJson,
            input.status, input.revision, input.authorizationTokenHash, input.expiresAt,
            input.rootTaskId, input.managementRunId, input.createdAt, input.updatedAt);
        return input;
      },
      async getById(id) {
        return mapProposal(teamDb.prepare('SELECT * FROM promotion_proposals WHERE id = ?')
          .get(id) as ProposalRow | undefined);
      },
      async getOpenBySourceLineageKey(sourceLineageKey) {
        return mapProposal(teamDb.prepare(
          `SELECT * FROM promotion_proposals WHERE source_lineage_key = ? AND status = 'open'`,
        ).get(sourceLineageKey) as ProposalRow | undefined);
      },
      async updateStatus(input) {
        const result = teamDb.prepare(`UPDATE promotion_proposals SET
          status = ?, revision = revision + 1, root_task_id = COALESCE(?, root_task_id),
          management_run_id = COALESCE(?, management_run_id), updated_at = ?
          WHERE id = ? AND status = 'open' AND revision = ?`)
          .run(input.status, input.rootTaskId ?? null, input.managementRunId ?? null, input.updatedAt,
            input.proposalId, input.expectedRevision) as { changes?: number };
        if (result.changes !== 1) return null;
        return mapProposal(teamDb.prepare('SELECT * FROM promotion_proposals WHERE id = ?')
          .get(input.proposalId) as ProposalRow | undefined);
      },
      async createActionReceipt(input) {
        teamDb.prepare(`INSERT INTO promotion_proposal_action_receipts
          (id, proposal_id, authority_subject, idempotency_key, action, command_hash, outcome, result_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.id, input.proposalId, input.authoritySubject, input.idempotencyKey, input.action, input.commandHash,
            input.outcome, input.resultJson, input.createdAt);
        return input;
      },
      async getActionReceiptByIdempotencyKey(idempotencyKey) {
        return mapActionReceipt(teamDb.prepare(
          'SELECT * FROM promotion_proposal_action_receipts WHERE idempotency_key = ?',
        ).get(idempotencyKey) as ProposalActionReceiptRow | undefined);
      },
    },
    teamPolicy: {
      async get(teamId) {
        const row = teamDb.prepare('SELECT * FROM team_promotion_policies WHERE team_id = ?')
          .get(teamId) as TeamPromotionPolicyRow | undefined;
        if (row && row.require_orchestration_need !== 1) {
          throw new Error('TEAM_PROMOTION_POLICY_CORRUPT');
        }
        return row ? {
          schemaVersion: 1,
          teamId: row.team_id,
          revision: row.revision,
          enabled: row.enabled === 1,
          ruleId: row.rule_id,
          preauthorized: row.preauthorized === 1,
          // 上方已 fail-closed 校验持久值；合同将该字段冻结为 literal true。
          requireOrchestrationNeed: true,
          updatedAt: row.updated_at,
        } satisfies TeamPromotionPolicyV1 : null;
      },
      async upsert(input) {
        if (input.requireOrchestrationNeed !== true) return null;
        const currentRow = teamDb.prepare('SELECT * FROM team_promotion_policies WHERE team_id = ?')
          .get(input.teamId) as TeamPromotionPolicyRow | undefined;
        if (currentRow && currentRow.require_orchestration_need !== 1) {
          throw new Error('TEAM_PROMOTION_POLICY_CORRUPT');
        }
        const current: TeamPromotionPolicyV1 | null = currentRow ? {
          schemaVersion: 1,
          teamId: currentRow.team_id,
          revision: currentRow.revision,
          enabled: currentRow.enabled === 1,
          ruleId: currentRow.rule_id,
          preauthorized: currentRow.preauthorized === 1,
          requireOrchestrationNeed: true,
          updatedAt: currentRow.updated_at,
        } : null;
        if (!canUpsertRevisionedConfig(current, input)) return null;
        if (current?.revision === input.revision) return current;
        teamDb.prepare(`INSERT INTO team_promotion_policies
          (team_id, revision, enabled, rule_id, preauthorized, require_orchestration_need, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?)
          ON CONFLICT(team_id) DO UPDATE SET revision = excluded.revision, enabled = excluded.enabled,
            rule_id = excluded.rule_id, preauthorized = excluded.preauthorized,
            require_orchestration_need = 1, updated_at = excluded.updated_at`)
          .run(input.teamId, input.revision, input.enabled ? 1 : 0, input.ruleId,
            input.preauthorized ? 1 : 0, input.updatedAt);
        return input;
      },
    },
    handoffs: {
      async create(input) {
        teamDb.prepare(`INSERT INTO simple_request_escalation_handoffs
          (id, team_id, source_message_id, source_dispatch_id, target_agent_id, root_task_id,
           management_run_id, status, targeted_offer_required, targeted_offer_id, material_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'applied', 1, ?, ?, ?)`)
          .run(input.id, input.teamId, input.sourceMessageId, input.sourceDispatchId,
            input.targetAgentId, input.rootTaskId, input.managementRunId, input.targetedOfferId, input.materialJson,
            input.createdAt);
        return input;
      },
      async getBySourceDispatchId(sourceDispatchId) {
        const row = teamDb.prepare(
          'SELECT * FROM simple_request_escalation_handoffs WHERE source_dispatch_id = ?',
        ).get(sourceDispatchId) as SimpleRequestHandoffRow | undefined;
        return row ? {
          id: row.id,
          teamId: row.team_id,
          sourceMessageId: row.source_message_id,
          sourceDispatchId: row.source_dispatch_id,
          targetAgentId: row.target_agent_id,
          rootTaskId: row.root_task_id,
          managementRunId: row.management_run_id,
          status: 'applied',
          targetedOfferRequired: true,
          targetedOfferId: row.targeted_offer_id,
          materialJson: row.material_json,
          createdAt: row.created_at,
        } satisfies SimpleRequestEscalationHandoffRecord : null;
      },
    },
  };
}

function canUpsertRevisionedConfig<T extends { readonly revision: number }>(
  current: T | null,
  input: T,
): boolean {
  if (!current) return input.revision === 1;
  if (input.revision === current.revision) return JSON.stringify(input) === JSON.stringify(current);
  return input.revision === current.revision + 1;
}
