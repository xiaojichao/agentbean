import type { EvidenceRefDto } from '../../../../../packages/contracts/src/index.js';
import type {
  EvidenceSnapshotRecord,
  SubtaskAcceptanceRecord,
  SubtaskDeliveryRecord,
  TaskAcceptanceCriterionRecord,
  TaskClaimLeaseRecord,
  TaskCoordinationRecord,
  TaskCoordinationRepositories,
  TaskDependencyRecord,
} from '../../application/task-coordination-repositories.js';
import type { SqliteDatabase } from './repositories.js';

export function createSqliteTaskCoordinationRepositories(
  db: SqliteDatabase,
): TaskCoordinationRepositories {
  return {
    coordinations: {
      async create(record) {
        db.prepare(`INSERT INTO task_coordinations
          (task_id, team_id, management_run_id, root_task_id, parent_task_id, node_kind,
           review_policy, claim_policy, required_capabilities_json, task_revision, attempt,
           max_attempts, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.taskId, record.teamId, record.managementRunId, record.rootTaskId ?? null,
            record.parentTaskId ?? null, record.nodeKind, record.reviewPolicy, record.claimPolicy,
            json(record.requiredCapabilities), record.taskRevision, record.attempt, record.maxAttempts,
            record.createdAt, record.updatedAt);
        return record;
      },
      async getByTaskId(taskId) {
        return mapCoordination(db.prepare('SELECT * FROM task_coordinations WHERE task_id = ?').get(taskId));
      },
      async listByManagementRun(managementRunId) {
        return db.prepare(`SELECT * FROM task_coordinations
          WHERE management_run_id = ? ORDER BY created_at, task_id`)
          .all(managementRunId).map(mapCoordinationRequired);
      },
      async update(input) {
        const record = input.record;
        const result = db.prepare(`UPDATE task_coordinations SET
          management_run_id = ?, root_task_id = ?, parent_task_id = ?, node_kind = ?,
          review_policy = ?, claim_policy = ?, required_capabilities_json = ?, task_revision = ?,
          attempt = ?, max_attempts = ?, updated_at = ?
          WHERE task_id = ? AND task_revision = ?`)
          .run(record.managementRunId, record.rootTaskId ?? null, record.parentTaskId ?? null,
            record.nodeKind, record.reviewPolicy, record.claimPolicy, json(record.requiredCapabilities),
            record.taskRevision, record.attempt, record.maxAttempts, record.updatedAt, record.taskId,
            input.expectedTaskRevision);
        return changes(result) === 1 ? record : null;
      },
    },
    criteria: {
      async create(record) {
        db.prepare(`INSERT INTO task_acceptance_criteria
          (task_id, criterion_id, description, evidence_required, allowed_evidence_kinds_json,
           introduced_revision, retired_revision, position)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.taskId, record.id, record.description, record.evidenceRequired ? 1 : 0,
            record.allowedEvidenceKinds ? json(record.allowedEvidenceKinds) : null,
            record.introducedRevision, record.retiredRevision ?? null, record.position);
        return record;
      },
      async updatePosition(input) {
        const result = db.prepare(`UPDATE task_acceptance_criteria SET position = ?
          WHERE task_id = ? AND criterion_id = ?`)
          .run(input.position, input.taskId, input.criterionId);
        if (changes(result) === 0) return null;
        return mapCriterion(db.prepare(`SELECT * FROM task_acceptance_criteria
          WHERE task_id = ? AND criterion_id = ?`).get(input.taskId, input.criterionId));
      },
      async retire(input) {
        const result = db.prepare(`UPDATE task_acceptance_criteria SET retired_revision = ?
          WHERE task_id = ? AND criterion_id = ? AND retired_revision IS NULL`)
          .run(input.retiredRevision, input.taskId, input.criterionId);
        if (changes(result) === 0) return null;
        return mapCriterion(db.prepare(`SELECT * FROM task_acceptance_criteria
          WHERE task_id = ? AND criterion_id = ?`).get(input.taskId, input.criterionId));
      },
      async list(taskId) {
        return db.prepare(`SELECT * FROM task_acceptance_criteria
          WHERE task_id = ? ORDER BY position, criterion_id`).all(taskId).map(mapCriterionRequired);
      },
    },
    dependencies: {
      async create(record) {
        db.prepare(`INSERT INTO task_dependencies
          (task_id, dependency_task_id, task_revision) VALUES (?, ?, ?)`)
          .run(record.taskId, record.dependencyTaskId, record.taskRevision);
        return record;
      },
      async delete(input) {
        db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND dependency_task_id = ?')
          .run(input.taskId, input.dependencyTaskId);
      },
      async list(taskId) {
        return db.prepare(`SELECT * FROM task_dependencies
          WHERE task_id = ? ORDER BY dependency_task_id`).all(taskId).map(mapDependency);
      },
    },
    claimLeases: {
      async create(record) {
        const coordination = getRequiredCoordination(db, record.taskId);
        if (coordination.teamId !== record.teamId ||
            coordination.taskRevision !== record.taskRevision ||
            coordination.attempt !== record.taskAttempt) {
          throw new Error('task claim lease does not match coordination authority');
        }
        if (record.status === 'active' && db.prepare(`SELECT 1 FROM task_claim_leases
          WHERE task_id = ? AND task_revision = ? AND task_attempt = ? AND status = 'active'`)
          .get(record.taskId, record.taskRevision, record.taskAttempt)) {
          throw new Error('active task claim lease already exists');
        }
        db.prepare(`INSERT INTO task_claim_leases
          (id, team_id, task_id, task_revision, task_attempt, agent_id, lease_token_hash,
           lease_fingerprint, fencing_token, status, acquired_at, heartbeat_at, expires_at, released_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.taskId, record.taskRevision, record.taskAttempt,
            record.agentId, record.leaseTokenHash, record.leaseFingerprint, record.fencingToken,
            record.status, record.acquiredAt, record.heartbeatAt, record.expiresAt,
            record.releasedAt ?? null);
        return record;
      },
      async getById(id) {
        return mapClaim(db.prepare('SELECT * FROM task_claim_leases WHERE id = ?').get(id));
      },
      async getCurrent(input) {
        return mapClaim(db.prepare(`SELECT * FROM task_claim_leases
          WHERE task_id = ? AND task_revision = ? AND task_attempt = ? AND status = 'active'`)
          .get(input.taskId, input.taskRevision, input.taskAttempt));
      },
      async getLatest(input) {
        return mapClaim(db.prepare(`SELECT * FROM task_claim_leases
          WHERE task_id = ? AND task_revision = ? AND task_attempt = ?
          ORDER BY fencing_token DESC LIMIT 1`)
          .get(input.taskId, input.taskRevision, input.taskAttempt));
      },
      async listActive() {
        return db.prepare(`SELECT * FROM task_claim_leases WHERE status = 'active' ORDER BY id`)
          .all().map(mapClaim).filter((record): record is TaskClaimLeaseRecord => record !== null);
      },
      async update(input) {
        const result = db.prepare(`UPDATE task_claim_leases SET
          status = ?, heartbeat_at = ?, expires_at = ?, released_at = ?
          WHERE id = ? AND status = ?`)
          .run(input.status, input.heartbeatAt, input.expiresAt, input.releasedAt ?? null,
            input.id, input.expectedStatus);
        return changes(result) === 1
          ? mapClaim(db.prepare('SELECT * FROM task_claim_leases WHERE id = ?').get(input.id))
          : null;
      },
    },
    evidenceSnapshots: {
      async create(record) {
        const coordination = getRequiredCoordination(db, record.taskId);
        if (coordination.teamId !== record.teamId) {
          throw new Error('evidence snapshot does not match Task Team authority');
        }
        db.prepare(`INSERT INTO evidence_snapshots
          (id, team_id, task_id, task_revision, task_attempt, invocation_id, kind, source_id,
           snapshot_hash, snapshot_revision, snapshot_json, captured_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.taskId, record.taskRevision, record.taskAttempt,
            record.invocationId, record.kind, record.sourceId, record.snapshotHash,
            record.snapshotRevision ?? null, json(record.snapshot), record.capturedAt);
        return record;
      },
      async getById(id) {
        return mapSnapshot(db.prepare('SELECT * FROM evidence_snapshots WHERE id = ?').get(id));
      },
      async listByTask(taskId) {
        return db.prepare(`SELECT * FROM evidence_snapshots
          WHERE task_id = ? ORDER BY captured_at, id`).all(taskId).map(mapSnapshotRequired);
      },
    },
    deliveries: {
      async create(record) {
        const snapshots = resolveEvidenceSnapshots(db, record, deliveryEvidenceRefs(record));
        db.prepare(`INSERT INTO subtask_deliveries
          (id, team_id, task_id, task_revision, task_attempt, claim_lease_id, invocation_id,
           idempotency_key, delivery_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.taskId, record.taskRevision, record.taskAttempt,
            record.claimLeaseId, record.invocationId, record.idempotencyKey, json(record), record.createdAt);
        const insertRef = db.prepare(`INSERT INTO subtask_delivery_evidence_refs
          (delivery_id, evidence_snapshot_id, team_id, task_id, invocation_id)
          VALUES (?, ?, ?, ?, ?)`);
        for (const snapshot of snapshots) {
          insertRef.run(record.id, snapshot.id, record.teamId, record.taskId, record.invocationId);
        }
        return record;
      },
      async getById(id) {
        return mapDelivery(db.prepare('SELECT delivery_json FROM subtask_deliveries WHERE id = ?').get(id));
      },
      async getByIdempotencyKey(input) {
        return mapDelivery(db.prepare(`SELECT delivery_json FROM subtask_deliveries
          WHERE task_id = ? AND idempotency_key = ?`).get(input.taskId, input.idempotencyKey));
      },
    },
    acceptances: {
      async create(record) {
        const delivery = deliveryContext(db, record.deliveryId);
        if (delivery.teamId !== record.teamId || delivery.taskId !== record.taskId ||
            delivery.claimLeaseId !== record.claimLeaseId ||
            delivery.taskRevision !== record.expectedTaskRevision ||
            delivery.taskAttempt !== record.taskAttempt) {
          throw new Error('subtask acceptance does not match delivery authority');
        }
        if (record.canonical && db.prepare(`SELECT 1 FROM subtask_acceptances
          WHERE delivery_id = ? AND canonical = 1`).get(record.deliveryId)) {
          throw new Error('canonical subtask acceptance already exists');
        }
        const seenCriterionIds = new Set<string>();
        const criterionSnapshots = record.criteriaResults.map((result) => {
          if (seenCriterionIds.has(result.criterionId)) {
            throw new Error('subtask acceptance criterion result is duplicated');
          }
          seenCriterionIds.add(result.criterionId);
          if (!db.prepare(`SELECT 1 FROM task_acceptance_criteria
            WHERE task_id = ? AND criterion_id = ?`).get(record.taskId, result.criterionId)) {
            throw new Error('subtask acceptance criterion does not belong to task');
          }
          return {
            result,
            snapshots: resolveEvidenceSnapshots(db, {
              teamId: record.teamId,
              taskId: record.taskId,
              invocationId: delivery.invocationId,
            }, result.evidenceRefs),
          };
        });
        db.prepare(`INSERT INTO subtask_acceptances
          (id, team_id, task_id, delivery_id, claim_lease_id, invocation_id, decision_version,
           decision, canonical, acceptance_json, decided_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(record.id, record.teamId, record.taskId, record.deliveryId, record.claimLeaseId,
            delivery.invocationId, record.decisionVersion, record.decision, record.canonical ? 1 : 0,
            json(record), record.decidedAt);
        const insertResult = db.prepare(`INSERT INTO subtask_acceptance_criterion_results
          (acceptance_id, criterion_id, passed) VALUES (?, ?, ?)`);
        const insertRef = db.prepare(`INSERT INTO subtask_acceptance_evidence_refs
          (acceptance_id, criterion_id, evidence_snapshot_id, team_id, task_id, invocation_id)
          VALUES (?, ?, ?, ?, ?, ?)`);
        for (const { result, snapshots } of criterionSnapshots) {
          insertResult.run(record.id, result.criterionId, result.passed ? 1 : 0);
          for (const snapshot of snapshots) {
            insertRef.run(record.id, result.criterionId, snapshot.id, record.teamId,
              record.taskId, delivery.invocationId);
          }
        }
        return record;
      },
      async getCanonicalByDelivery(deliveryId) {
        return mapAcceptance(db.prepare(`SELECT acceptance_json FROM subtask_acceptances
          WHERE delivery_id = ? AND canonical = 1`).get(deliveryId));
      },
      async listByDelivery(deliveryId) {
        return db.prepare(`SELECT acceptance_json FROM subtask_acceptances
          WHERE delivery_id = ? ORDER BY decision_version`).all(deliveryId).map(mapAcceptanceRequired);
      },
    },
  };
}

function deliveryEvidenceRefs(record: SubtaskDeliveryRecord): EvidenceRefDto[] {
  return [...record.evidenceRefs, ...record.claims.flatMap((claim) => claim.evidenceRefs)];
}

function resolveEvidenceSnapshots(
  db: SqliteDatabase,
  context: { teamId: string; taskId: string; invocationId: string },
  refs: readonly EvidenceRefDto[],
): EvidenceSnapshotRecord[] {
  const snapshots = new Map<string, EvidenceSnapshotRecord>();
  for (const ref of refs) {
    const row = db.prepare(`SELECT * FROM evidence_snapshots
      WHERE team_id = ? AND task_id = ? AND invocation_id = ? AND kind = ? AND source_id = ?
        AND snapshot_hash = ? AND captured_at = ?
        AND (snapshot_revision = ? OR (snapshot_revision IS NULL AND ? IS NULL))`)
      .get(context.teamId, context.taskId, context.invocationId, ref.kind, ref.id,
        ref.snapshotHash, ref.capturedAt, ref.snapshotRevision ?? null, ref.snapshotRevision ?? null);
    const snapshot = mapSnapshot(row);
    if (!snapshot) throw new Error('evidence ref has no canonical snapshot in delivery authority');
    snapshots.set(snapshot.id, snapshot);
  }
  return [...snapshots.values()];
}

function deliveryContext(db: SqliteDatabase, deliveryId: string): {
  teamId: string;
  taskId: string;
  taskRevision: number;
  taskAttempt: number;
  claimLeaseId: string;
  invocationId: string;
} {
  const value = db.prepare(`SELECT team_id, task_id, task_revision, task_attempt,
    claim_lease_id, invocation_id FROM subtask_deliveries WHERE id = ?`).get(deliveryId);
  if (!value) throw new Error('subtask delivery does not exist');
  return {
    teamId: text(value, 'team_id'), taskId: text(value, 'task_id'),
    taskRevision: number(value, 'task_revision'), taskAttempt: number(value, 'task_attempt'),
    claimLeaseId: text(value, 'claim_lease_id'), invocationId: text(value, 'invocation_id'),
  };
}

function mapCoordination(value: unknown): TaskCoordinationRecord | null {
  return value ? {
    schemaVersion: 1, taskId: text(value, 'task_id'), teamId: text(value, 'team_id'),
    managementRunId: text(value, 'management_run_id'), rootTaskId: nullableText(value, 'root_task_id'),
    parentTaskId: nullableText(value, 'parent_task_id'),
    nodeKind: text(value, 'node_kind') as TaskCoordinationRecord['nodeKind'],
    reviewPolicy: text(value, 'review_policy') as TaskCoordinationRecord['reviewPolicy'],
    claimPolicy: text(value, 'claim_policy') as TaskCoordinationRecord['claimPolicy'],
    requiredCapabilities: parse<string[]>(text(value, 'required_capabilities_json')),
    taskRevision: number(value, 'task_revision'), attempt: number(value, 'attempt'),
    maxAttempts: number(value, 'max_attempts'),
    createdAt: number(value, 'created_at'), updatedAt: number(value, 'updated_at'),
  } : null;
}
function mapCoordinationRequired(value: unknown): TaskCoordinationRecord {
  return required(mapCoordination(value));
}

function mapCriterion(value: unknown): TaskAcceptanceCriterionRecord | null {
  return value ? { taskId: text(value, 'task_id'), id: text(value, 'criterion_id'),
    description: text(value, 'description'), evidenceRequired: number(value, 'evidence_required') === 1,
    allowedEvidenceKinds: nullableText(value, 'allowed_evidence_kinds_json')
      ? parse(text(value, 'allowed_evidence_kinds_json')) : undefined,
    introducedRevision: number(value, 'introduced_revision'),
    retiredRevision: nullableNumber(value, 'retired_revision'), position: number(value, 'position') } : null;
}
function mapCriterionRequired(value: unknown): TaskAcceptanceCriterionRecord { return required(mapCriterion(value)); }
function mapDependency(value: unknown): TaskDependencyRecord { return { taskId: text(value, 'task_id'), dependencyTaskId: text(value, 'dependency_task_id'), taskRevision: number(value, 'task_revision') }; }
function mapClaim(value: unknown): TaskClaimLeaseRecord | null { return value ? { id: text(value, 'id'), teamId: text(value, 'team_id'), taskId: text(value, 'task_id'), taskRevision: number(value, 'task_revision'), taskAttempt: number(value, 'task_attempt'), agentId: text(value, 'agent_id'), leaseTokenHash: text(value, 'lease_token_hash'), leaseFingerprint: text(value, 'lease_fingerprint'), fencingToken: number(value, 'fencing_token'), status: text(value, 'status') as TaskClaimLeaseRecord['status'], acquiredAt: number(value, 'acquired_at'), heartbeatAt: number(value, 'heartbeat_at'), expiresAt: number(value, 'expires_at'), releasedAt: nullableNumber(value, 'released_at') } : null; }
function mapSnapshot(value: unknown): EvidenceSnapshotRecord | null { return value ? { id: text(value, 'id'), teamId: text(value, 'team_id'), taskId: text(value, 'task_id'), taskRevision: number(value, 'task_revision'), taskAttempt: number(value, 'task_attempt'), invocationId: text(value, 'invocation_id'), kind: text(value, 'kind') as EvidenceSnapshotRecord['kind'], sourceId: text(value, 'source_id'), snapshotHash: text(value, 'snapshot_hash'), snapshotRevision: nullableNumber(value, 'snapshot_revision'), snapshot: parse(text(value, 'snapshot_json')), capturedAt: number(value, 'captured_at') } : null; }
function mapSnapshotRequired(value: unknown): EvidenceSnapshotRecord { return required(mapSnapshot(value)); }
function mapDelivery(value: unknown): SubtaskDeliveryRecord | null { return value ? parse(text(value, 'delivery_json')) : null; }
function mapAcceptance(value: unknown): SubtaskAcceptanceRecord | null { return value ? parse(text(value, 'acceptance_json')) : null; }
function mapAcceptanceRequired(value: unknown): SubtaskAcceptanceRecord { return required(mapAcceptance(value)); }
function getRequiredCoordination(db: SqliteDatabase, taskId: string): TaskCoordinationRecord {
  const coordination = mapCoordination(db.prepare('SELECT * FROM task_coordinations WHERE task_id = ?').get(taskId));
  if (!coordination) throw new Error('task coordination does not exist');
  return coordination;
}
function required<T>(value: T | null): T { if (!value) throw new Error('SQLite task coordination row could not be mapped'); return value; }
function row(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object') throw new Error('SQLite task coordination row is missing'); return value as Record<string, unknown>; }
function text(value: unknown, key: string): string { const result = row(value)[key]; if (typeof result !== 'string') throw new Error(`Invalid ${key}`); return result; }
function number(value: unknown, key: string): number { const result = row(value)[key]; if (typeof result !== 'number') throw new Error(`Invalid ${key}`); return result; }
function nullableText(value: unknown, key: string): string | undefined { const result = row(value)[key]; return result == null ? undefined : text(value, key); }
function nullableNumber(value: unknown, key: string): number | undefined { const result = row(value)[key]; return result == null ? undefined : number(value, key); }
function json(value: unknown): string { return JSON.stringify(value); }
function parse<T>(value: string): T { return JSON.parse(value) as T; }
function changes(value: unknown): number { return value && typeof value === 'object' && typeof (value as { changes?: unknown }).changes === 'number' ? (value as { changes: number }).changes : 0; }
