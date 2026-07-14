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

export interface TaskCoordinationMemoryState {
  coordinations: Map<string, TaskCoordinationRecord>;
  criteria: Map<string, TaskAcceptanceCriterionRecord>;
  dependencies: Map<string, TaskDependencyRecord>;
  claimLeases: Map<string, TaskClaimLeaseRecord>;
  evidenceSnapshots: Map<string, EvidenceSnapshotRecord>;
  deliveries: Map<string, SubtaskDeliveryRecord>;
  acceptances: Map<string, SubtaskAcceptanceRecord>;
}

export function createTaskCoordinationMemoryState(): TaskCoordinationMemoryState {
  return {
    coordinations: new Map(), criteria: new Map(), dependencies: new Map(),
    claimLeases: new Map(), evidenceSnapshots: new Map(), deliveries: new Map(),
    acceptances: new Map(),
  };
}

export function cloneTaskCoordinationMemoryState(
  state: TaskCoordinationMemoryState,
): TaskCoordinationMemoryState {
  return {
    coordinations: new Map(state.coordinations), criteria: new Map(state.criteria),
    dependencies: new Map(state.dependencies), claimLeases: new Map(state.claimLeases),
    evidenceSnapshots: new Map(state.evidenceSnapshots), deliveries: new Map(state.deliveries),
    acceptances: new Map(state.acceptances),
  };
}

export function restoreTaskCoordinationMemoryState(
  target: TaskCoordinationMemoryState,
  source: TaskCoordinationMemoryState,
): void {
  for (const key of Object.keys(source) as (keyof TaskCoordinationMemoryState)[]) {
    target[key].clear();
    for (const [id, value] of source[key]) target[key].set(id, value as never);
  }
}

export function createInMemoryTaskCoordinationRepositories(
  state: TaskCoordinationMemoryState,
): TaskCoordinationRepositories {
  return {
    coordinations: {
      async create(record) {
        if (state.coordinations.has(record.taskId)) throw new Error('task coordination already exists');
        state.coordinations.set(record.taskId, record);
        return record;
      },
      async getByTaskId(taskId) { return state.coordinations.get(taskId) ?? null; },
      async listByManagementRun(managementRunId) {
        return [...state.coordinations.values()]
          .filter((record) => record.managementRunId === managementRunId)
          .sort((left, right) => left.createdAt - right.createdAt || left.taskId.localeCompare(right.taskId));
      },
      async update(input) {
        const current = state.coordinations.get(input.record.taskId);
        if (!current || current.taskRevision !== input.expectedTaskRevision) return null;
        state.coordinations.set(input.record.taskId, input.record);
        return input.record;
      },
    },
    criteria: {
      async create(record) {
        const key = criterionKey(record.taskId, record.id);
        if (state.criteria.has(key)) throw new Error('task criterion id already exists');
        if (!state.coordinations.has(record.taskId)) throw new Error('task coordination does not exist');
        state.criteria.set(key, record);
        return record;
      },
      async updatePosition(input) {
        const key = criterionKey(input.taskId, input.criterionId);
        const current = state.criteria.get(key);
        if (!current) return null;
        const updated = { ...current, position: input.position };
        state.criteria.set(key, updated);
        return updated;
      },
      async retire(input) {
        const key = criterionKey(input.taskId, input.criterionId);
        const current = state.criteria.get(key);
        if (!current || current.retiredRevision !== undefined) return null;
        const retired = { ...current, retiredRevision: input.retiredRevision };
        state.criteria.set(key, retired);
        return retired;
      },
      async list(taskId) {
        return [...state.criteria.values()].filter((item) => item.taskId === taskId)
          .sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
      },
    },
    dependencies: {
      async create(record) {
        if (record.taskId === record.dependencyTaskId) throw new Error('task cannot depend on itself');
        if (!state.coordinations.has(record.taskId) || !state.coordinations.has(record.dependencyTaskId)) {
          throw new Error('task dependency coordination does not exist');
        }
        const key = dependencyKey(record.taskId, record.dependencyTaskId);
        if (state.dependencies.has(key)) throw new Error('task dependency already exists');
        state.dependencies.set(key, record);
        return record;
      },
      async delete(input) { state.dependencies.delete(dependencyKey(input.taskId, input.dependencyTaskId)); },
      async list(taskId) {
        return [...state.dependencies.values()].filter((item) => item.taskId === taskId)
          .sort((left, right) => left.dependencyTaskId.localeCompare(right.dependencyTaskId));
      },
    },
    claimLeases: {
      async create(record) {
        if (state.claimLeases.has(record.id)) throw new Error('task claim lease already exists');
        const duplicate = [...state.claimLeases.values()].some((item) =>
          item.taskId === record.taskId && item.taskRevision === record.taskRevision &&
          item.taskAttempt === record.taskAttempt && item.status === 'active' && record.status === 'active');
        if (duplicate) throw new Error('active task claim lease already exists');
        const coordination = state.coordinations.get(record.taskId);
        if (!coordination || coordination.teamId !== record.teamId ||
            coordination.taskRevision !== record.taskRevision || coordination.attempt !== record.taskAttempt) {
          throw new Error('task claim lease does not match coordination authority');
        }
        state.claimLeases.set(record.id, record);
        return record;
      },
      async getById(id) { return state.claimLeases.get(id) ?? null; },
      async getCurrent(input) {
        return [...state.claimLeases.values()].find((item) => item.taskId === input.taskId &&
          item.taskRevision === input.taskRevision && item.taskAttempt === input.taskAttempt &&
          item.status === 'active') ?? null;
      },
      async getLatest(input) {
        return [...state.claimLeases.values()].filter((item) => item.taskId === input.taskId &&
          item.taskRevision === input.taskRevision && item.taskAttempt === input.taskAttempt)
          .sort((left, right) => right.fencingToken - left.fencingToken)[0] ?? null;
      },
      async listActive() {
        return [...state.claimLeases.values()].filter((item) => item.status === 'active')
          .sort((left, right) => left.id.localeCompare(right.id));
      },
      async update(input) {
        const current = state.claimLeases.get(input.id);
        if (!current || current.status !== input.expectedStatus) return null;
        if (input.status === 'active' && [...state.claimLeases.values()].some((item) =>
          item.id !== input.id && item.taskId === current.taskId &&
          item.taskRevision === current.taskRevision && item.taskAttempt === current.taskAttempt &&
          item.status === 'active')) throw new Error('active task claim lease already exists');
        const updated = { ...current, status: input.status, heartbeatAt: input.heartbeatAt,
          expiresAt: input.expiresAt, releasedAt: input.releasedAt };
        state.claimLeases.set(input.id, updated);
        return updated;
      },
    },
    evidenceSnapshots: {
      async create(record) {
        if (state.evidenceSnapshots.has(record.id)) throw new Error('evidence snapshot already exists');
        const duplicate = [...state.evidenceSnapshots.values()].some((item) =>
          item.teamId === record.teamId && item.taskId === record.taskId &&
          item.invocationId === record.invocationId && item.kind === record.kind &&
          item.sourceId === record.sourceId && item.snapshotHash === record.snapshotHash);
        if (duplicate) throw new Error('canonical evidence snapshot already exists');
        const coordination = state.coordinations.get(record.taskId);
        if (!coordination || coordination.teamId !== record.teamId) {
          throw new Error('evidence snapshot does not match Task Team authority');
        }
        state.evidenceSnapshots.set(record.id, record);
        return record;
      },
      async getById(id) { return state.evidenceSnapshots.get(id) ?? null; },
      async listByTask(taskId) {
        return [...state.evidenceSnapshots.values()].filter((item) => item.taskId === taskId)
          .sort((left, right) => left.capturedAt - right.capturedAt || left.id.localeCompare(right.id));
      },
    },
    deliveries: {
      async create(record) {
        if (state.deliveries.has(record.id)) throw new Error('subtask delivery already exists');
        if ([...state.deliveries.values()].some((item) =>
          item.taskId === record.taskId && item.idempotencyKey === record.idempotencyKey)) {
          throw new Error('subtask delivery idempotency key already exists');
        }
        const claim = state.claimLeases.get(record.claimLeaseId);
        if (!claim || claim.teamId !== record.teamId || claim.taskId !== record.taskId ||
            claim.taskRevision !== record.taskRevision || claim.taskAttempt !== record.taskAttempt) {
          throw new Error('subtask delivery does not match claim authority');
        }
        resolveEvidenceSnapshots(state, record, deliveryEvidenceRefs(record));
        state.deliveries.set(record.id, record);
        return record;
      },
      async getById(id) { return state.deliveries.get(id) ?? null; },
      async listByTask(taskId) {
        return [...state.deliveries.values()].filter((item) => item.taskId === taskId)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
      async getByIdempotencyKey(input) {
        return [...state.deliveries.values()].find((item) =>
          item.taskId === input.taskId && item.idempotencyKey === input.idempotencyKey) ?? null;
      },
    },
    acceptances: {
      async create(record) {
        if (state.acceptances.has(record.id)) throw new Error('subtask acceptance already exists');
        const delivery = state.deliveries.get(record.deliveryId);
        if (!delivery || delivery.teamId !== record.teamId || delivery.taskId !== record.taskId ||
            delivery.claimLeaseId !== record.claimLeaseId ||
            delivery.taskRevision !== record.expectedTaskRevision ||
            delivery.taskAttempt !== record.taskAttempt) {
          throw new Error('subtask acceptance does not match delivery authority');
        }
        if ([...state.acceptances.values()].some((item) =>
          item.deliveryId === record.deliveryId && item.decisionVersion === record.decisionVersion)) {
          throw new Error('subtask acceptance decision version already exists');
        }
        if (record.canonical && [...state.acceptances.values()].some((item) =>
          item.deliveryId === record.deliveryId && item.canonical)) {
          throw new Error('canonical subtask acceptance already exists');
        }
        const seenCriterionIds = new Set<string>();
        for (const result of record.criteriaResults) {
          if (seenCriterionIds.has(result.criterionId)) {
            throw new Error('subtask acceptance criterion result is duplicated');
          }
          seenCriterionIds.add(result.criterionId);
          if (!state.criteria.has(criterionKey(record.taskId, result.criterionId))) {
            throw new Error('subtask acceptance criterion does not belong to task');
          }
          resolveEvidenceSnapshots(state, {
            teamId: record.teamId, taskId: record.taskId, invocationId: delivery.invocationId,
          }, result.evidenceRefs);
        }
        state.acceptances.set(record.id, record);
        return record;
      },
      async getCanonicalByDelivery(deliveryId) {
        return [...state.acceptances.values()].find((item) =>
          item.deliveryId === deliveryId && item.canonical) ?? null;
      },
      async listByDelivery(deliveryId) {
        return [...state.acceptances.values()].filter((item) => item.deliveryId === deliveryId)
          .sort((left, right) => left.decisionVersion - right.decisionVersion);
      },
    },
  };
}

function deliveryEvidenceRefs(record: SubtaskDeliveryRecord): EvidenceRefDto[] {
  return [...record.evidenceRefs, ...record.claims.flatMap((claim) => claim.evidenceRefs)];
}

function resolveEvidenceSnapshots(
  state: TaskCoordinationMemoryState,
  context: { teamId: string; taskId: string; invocationId: string },
  refs: readonly EvidenceRefDto[],
): EvidenceSnapshotRecord[] {
  return refs.map((ref) => {
    const snapshot = [...state.evidenceSnapshots.values()].find((item) =>
      item.teamId === context.teamId && item.taskId === context.taskId &&
      item.invocationId === context.invocationId && item.kind === ref.kind &&
      item.sourceId === ref.id && item.snapshotHash === ref.snapshotHash &&
      item.snapshotRevision === ref.snapshotRevision && item.capturedAt === ref.capturedAt);
    if (!snapshot) throw new Error('evidence ref has no canonical snapshot in delivery authority');
    return snapshot;
  });
}

function criterionKey(taskId: string, criterionId: string): string { return `${taskId}:${criterionId}`; }
function dependencyKey(taskId: string, dependencyTaskId: string): string { return `${taskId}:${dependencyTaskId}`; }
