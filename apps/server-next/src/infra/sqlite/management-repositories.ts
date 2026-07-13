import type {
  AgentInvocationRecordDto,
  ManagementCheckpointV1,
  ManagementEventV1,
  ManagementRunDto,
} from '../../../../../packages/contracts/src/index.js';
import type { ManagerLeaseRecord } from '../../../../../packages/domain/src/index.js';
import type {
  InvocationDispatchAttemptRecord,
  ManagedRequestReservationRecord,
  ManagementEventRecord,
  ManagementPolicyRecord,
  ManagementRepositories,
  ManagementShadowDecisionRecord,
} from '../../application/management-repositories.js';
import { createManagementUnitOfWork, serializeManagementTransactions, type ManagementUnitOfWork } from '../../application/management-unit-of-work.js';
import type { SqliteDatabase } from './repositories.js';

export function createSqliteManagementPersistence(db: SqliteDatabase): {
  repositories: ManagementRepositories;
  unitOfWork: ManagementUnitOfWork;
} {
  const repositories = createSqliteManagementRepositories(db);
  return {
    repositories,
    unitOfWork: createManagementUnitOfWork(serializeManagementTransactions(async (operation) => {
      db.exec('BEGIN IMMEDIATE;');
      try {
        const result = await operation(repositories);
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK;'); } catch { /* preserve the original error */ }
        throw error;
      }
    })),
  };
}

export function createSqliteManagementRepositories(db: SqliteDatabase): ManagementRepositories {
  return {
    policies: {
      async get(teamId) {
        return mapPolicy(db.prepare('SELECT * FROM team_management_policies WHERE team_id = ?').get(teamId));
      },
      async upsert(record) {
        db.prepare(`INSERT INTO team_management_policies
          (team_id, mode, placement_policy_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(team_id) DO UPDATE SET mode=excluded.mode, placement_policy_json=excluded.placement_policy_json,
            updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
          .run(record.teamId, record.mode, json(record.placementPolicy), record.updatedBy, record.updatedAt);
        return record;
      },
    },
    reservations: {
      async create(record) {
        db.prepare(`INSERT INTO managed_request_reservations
          (id, team_id, request_key, request_hash, management_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.requestKey, record.requestHash, record.managementRunId, record.createdAt);
        return record;
      },
      async getByRequestKey(input) {
        return mapReservation(db.prepare(
          'SELECT * FROM managed_request_reservations WHERE team_id = ? AND request_key = ?',
        ).get(input.teamId, input.requestKey));
      },
    },
    runs: {
      async create(record) {
        db.prepare(`INSERT INTO management_runs
          (id, team_id, channel_id, root_task_id, root_message_id, status, placement_policy_json,
           active_worker_id, checkpoint_revision, budget_json, created_at, updated_at, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.channelId, record.rootTaskId ?? null, record.rootMessageId,
            record.status, json(record.placementPolicy), record.activeWorkerId ?? null, record.checkpointRevision,
            json(record.budget), record.createdAt, record.updatedAt, record.completedAt ?? null);
        return record;
      },
      async getById(id) {
        return mapRun(db.prepare('SELECT * FROM management_runs WHERE id = ?').get(id));
      },
      async update(record) {
        const result = db.prepare(`UPDATE management_runs SET status = ?, placement_policy_json = ?,
          active_worker_id = ?, checkpoint_revision = ?, budget_json = ?, updated_at = ?, completed_at = ?
          WHERE id = ?`).run(record.status, json(record.placementPolicy), record.activeWorkerId ?? null,
          record.checkpointRevision, json(record.budget), record.updatedAt, record.completedAt ?? null, record.id);
        if ((result as { changes?: number }).changes === 0) throw new Error('management run does not exist');
        return record;
      },
    },
    leases: {
      async get(managementRunId) {
        return mapLease(db.prepare('SELECT * FROM manager_leases WHERE management_run_id = ?').get(managementRunId));
      },
      async put(record) {
        db.prepare(`INSERT INTO manager_leases
          (management_run_id, worker_id, device_id, profile_id, lease_token_hash, lease_fingerprint,
           fencing_token, acquired_at, heartbeat_at, expires_at, released_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(management_run_id) DO UPDATE SET worker_id=excluded.worker_id, device_id=excluded.device_id,
            profile_id=excluded.profile_id, lease_token_hash=excluded.lease_token_hash,
            lease_fingerprint=excluded.lease_fingerprint, fencing_token=excluded.fencing_token,
            acquired_at=excluded.acquired_at, heartbeat_at=excluded.heartbeat_at,
            expires_at=excluded.expires_at, released_at=excluded.released_at`)
          .run(record.managementRunId, record.workerId, record.host.deviceId, record.host.profileId,
            record.leaseTokenHash, record.leaseFingerprint, record.fencingToken, record.acquiredAt,
            record.heartbeatAt, record.expiresAt, record.releasedAt ?? null);
        return record;
      },
    },
    events: {
      async append(record) {
        const event = record.event;
        db.prepare(`INSERT INTO management_events
          (id, management_run_id, sequence, type, actor_kind, actor_id, idempotency_key,
           causation_event_id, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(event.id, event.managementRunId, event.sequence, event.type, event.actorKind, event.actorId ?? null,
            event.idempotencyKey, event.causationEventId ?? null, json(event.payload), record.payloadHash, event.createdAt);
        return record;
      },
      async list(managementRunId) {
        return db.prepare('SELECT * FROM management_events WHERE management_run_id = ? ORDER BY sequence')
          .all(managementRunId).map(mapEvent);
      },
    },
    checkpoints: {
      async put(record) {
        db.prepare(`INSERT INTO management_checkpoints
          (management_run_id, revision, checkpoint_json, updated_at) VALUES (?, ?, ?, ?)`)
          .run(record.managementRunId, record.revision, json(record), record.updatedAt);
        return record;
      },
      async get(input) {
        const row = db.prepare(`SELECT checkpoint_json FROM management_checkpoints
          WHERE management_run_id = ? AND revision = ?`).get(input.managementRunId, input.revision);
        return row ? parseJson<ManagementCheckpointV1>(text(row, 'checkpoint_json')) : null;
      },
      async getLatest(managementRunId) {
        const row = db.prepare(`SELECT checkpoint_json FROM management_checkpoints
          WHERE management_run_id = ? ORDER BY revision DESC LIMIT 1`).get(managementRunId);
        return row ? parseJson<ManagementCheckpointV1>(text(row, 'checkpoint_json')) : null;
      },
    },
    invocations: {
      async create(record) {
        db.prepare(`INSERT INTO agent_invocations
          (id, management_run_id, intent_json, intent_hash, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.managementRunId, json(record.intent), record.intentHash, record.idempotencyKey, record.createdAt);
        return record;
      },
      async getById(id) {
        return mapInvocation(db.prepare('SELECT * FROM agent_invocations WHERE id = ?').get(id));
      },
      async getByIdempotencyKey(input) {
        return mapInvocation(db.prepare('SELECT * FROM agent_invocations WHERE management_run_id = ? AND idempotency_key = ?').get(input.managementRunId, input.idempotencyKey));
      },
      async listByRun(managementRunId) {
        return db.prepare('SELECT * FROM agent_invocations WHERE management_run_id = ? ORDER BY created_at, id')
          .all(managementRunId).map((value) => {
            const invocation = mapInvocation(value);
            if (!invocation) throw new Error('SQLite invocation row could not be mapped');
            return invocation;
          });
      },
    },
    dispatchAttempts: {
      async create(record) {
        db.prepare(`INSERT INTO invocation_dispatch_attempts
          (id, invocation_id, dispatch_id, attempt_number, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.invocationId, record.dispatchId, record.attemptNumber, record.status,
            record.startedAt, record.completedAt ?? null);
        return record;
      },
      async update(record) {
        const result = db.prepare(`UPDATE invocation_dispatch_attempts SET status = ?, completed_at = ? WHERE id = ?`)
          .run(record.status, record.completedAt ?? null, record.id);
        if ((result as { changes?: number }).changes === 0) throw new Error('dispatch attempt does not exist');
        return record;
      },
      async getByDispatchId(dispatchId) {
        const value = db.prepare('SELECT * FROM invocation_dispatch_attempts WHERE dispatch_id = ?').get(dispatchId);
        return value ? mapAttempt(value) : null;
      },
      async list(invocationId) {
        return db.prepare('SELECT * FROM invocation_dispatch_attempts WHERE invocation_id = ? ORDER BY attempt_number')
          .all(invocationId).map(mapAttempt);
      },
    },
    shadowDecisions: {
      async create(record) {
        db.prepare(`INSERT INTO management_shadow_decisions
          (id, shadow_request_key, input_hash, objective_hash, argument_hash, target_json,
           tool_sequence_json, diagnostics_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.shadowRequestKey, record.inputHash, record.objectiveHash, record.argumentHash,
            json(record.target), json(record.toolSequence), json(record.diagnostics), record.createdAt);
        return record;
      },
      async getByRequestKey(shadowRequestKey) {
        const value = db.prepare('SELECT * FROM management_shadow_decisions WHERE shadow_request_key = ?').get(shadowRequestKey);
        return value ? mapShadowDecision(value) : null;
      },
    },
  };
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('SQLite management row is missing');
  return value as Record<string, unknown>;
}
function text(value: unknown, key: string): string { const result = row(value)[key]; if (typeof result !== 'string') throw new Error(`Invalid ${key}`); return result; }
function number(value: unknown, key: string): number { const result = row(value)[key]; if (typeof result !== 'number') throw new Error(`Invalid ${key}`); return result; }
function nullableText(value: unknown, key: string): string | undefined { const result = row(value)[key]; return result == null ? undefined : text(value, key); }
function nullableNumber(value: unknown, key: string): number | undefined { const result = row(value)[key]; return result == null ? undefined : number(value, key); }
function json(value: unknown): string { return JSON.stringify(value); }
function parseJson<T>(value: string): T { return JSON.parse(value) as T; }

function mapPolicy(value: unknown): ManagementPolicyRecord | null { return value ? { teamId: text(value, 'team_id'), mode: text(value, 'mode') as ManagementPolicyRecord['mode'], placementPolicy: parseJson(text(value, 'placement_policy_json')), updatedBy: text(value, 'updated_by'), updatedAt: number(value, 'updated_at') } : null; }
function mapReservation(value: unknown): ManagedRequestReservationRecord | null { return value ? { id: text(value, 'id'), teamId: text(value, 'team_id'), requestKey: text(value, 'request_key'), requestHash: text(value, 'request_hash'), managementRunId: text(value, 'management_run_id'), createdAt: number(value, 'created_at') } : null; }
function mapRun(value: unknown): ManagementRunDto | null { return value ? { schemaVersion: 1, id: text(value, 'id'), teamId: text(value, 'team_id'), channelId: text(value, 'channel_id'), rootTaskId: nullableText(value, 'root_task_id'), rootMessageId: text(value, 'root_message_id'), mode: 'managed', status: text(value, 'status') as ManagementRunDto['status'], placementPolicy: parseJson(text(value, 'placement_policy_json')), activeWorkerId: nullableText(value, 'active_worker_id'), checkpointRevision: number(value, 'checkpoint_revision'), budget: parseJson(text(value, 'budget_json')), createdAt: number(value, 'created_at'), updatedAt: number(value, 'updated_at'), completedAt: nullableNumber(value, 'completed_at') } : null; }
function mapLease(value: unknown): ManagerLeaseRecord | null { return value ? { managementRunId: text(value, 'management_run_id'), workerId: text(value, 'worker_id'), host: { deviceId: text(value, 'device_id'), profileId: text(value, 'profile_id') }, leaseTokenHash: text(value, 'lease_token_hash'), leaseFingerprint: text(value, 'lease_fingerprint'), fencingToken: number(value, 'fencing_token'), acquiredAt: number(value, 'acquired_at'), heartbeatAt: number(value, 'heartbeat_at'), expiresAt: number(value, 'expires_at'), releasedAt: nullableNumber(value, 'released_at') } : null; }
function mapEvent(value: unknown): ManagementEventRecord { return { event: { schemaVersion: 1, id: text(value, 'id'), managementRunId: text(value, 'management_run_id'), sequence: number(value, 'sequence'), type: text(value, 'type'), actorKind: text(value, 'actor_kind'), actorId: nullableText(value, 'actor_id'), idempotencyKey: text(value, 'idempotency_key'), causationEventId: nullableText(value, 'causation_event_id'), payload: parseJson(text(value, 'payload_json')), createdAt: number(value, 'created_at') } as ManagementEventV1, payloadHash: text(value, 'payload_hash') }; }
function mapInvocation(value: unknown): AgentInvocationRecordDto | null { return value ? { schemaVersion: 1, id: text(value, 'id'), managementRunId: text(value, 'management_run_id'), intent: parseJson(text(value, 'intent_json')), intentHash: text(value, 'intent_hash'), idempotencyKey: text(value, 'idempotency_key'), createdAt: number(value, 'created_at') } : null; }
function mapAttempt(value: unknown): InvocationDispatchAttemptRecord { return { id: text(value, 'id'), invocationId: text(value, 'invocation_id'), dispatchId: text(value, 'dispatch_id'), attemptNumber: number(value, 'attempt_number'), status: text(value, 'status') as InvocationDispatchAttemptRecord['status'], startedAt: number(value, 'started_at'), completedAt: nullableNumber(value, 'completed_at') }; }
function mapShadowDecision(value: unknown): ManagementShadowDecisionRecord { return { id: text(value, 'id'), shadowRequestKey: text(value, 'shadow_request_key'), inputHash: text(value, 'input_hash'), objectiveHash: text(value, 'objective_hash'), argumentHash: text(value, 'argument_hash'), target: parseJson(text(value, 'target_json')), toolSequence: parseJson(text(value, 'tool_sequence_json')), diagnostics: parseJson(text(value, 'diagnostics_json')), createdAt: number(value, 'created_at') }; }
