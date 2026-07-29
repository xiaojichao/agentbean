import type {
  PromotionGateCommandName,
  PromotionGateReceiptOutcome,
  PromotionRiskLevel,
  PromotionRevisionRefV1,
  PromotionEventRefV1,
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
  };
}
