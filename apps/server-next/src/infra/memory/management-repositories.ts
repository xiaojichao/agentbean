import type { AgentCollaborationProposalRecordDto, AgentHandoffRecordDto, AgentInvocationRecordDto, ManagementCheckpointV1 } from '../../../../../packages/contracts/src/index.js';
import type { ManagerLeaseRecord } from '../../../../../packages/domain/src/index.js';
import type {
  InvocationDispatchAttemptRecord,
  ManagedRequestReservationRecord,
  ManagementEventRecord,
  ManagementPolicyRecord,
  ManagementRepositories,
  ManagementRunRecord,
  ManagementShadowDecisionRecord,
} from '../../application/management-repositories.js';
import { createManagementUnitOfWork, serializeManagementTransactions, type ManagementUnitOfWork } from '../../application/management-unit-of-work.js';

interface ManagementMemoryState {
  policies: Map<string, ManagementPolicyRecord>;
  reservations: Map<string, ManagedRequestReservationRecord>;
  runs: Map<string, ManagementRunRecord>;
  leases: Map<string, ManagerLeaseRecord>;
  events: Map<string, ManagementEventRecord>;
  checkpoints: Map<string, ManagementCheckpointV1>;
  invocations: Map<string, AgentInvocationRecordDto>;
  collaborationProposals: Map<string, AgentCollaborationProposalRecordDto>;
  handoffs: Map<string, AgentHandoffRecordDto>;
  attempts: Map<string, InvocationDispatchAttemptRecord>;
  shadowDecisions: Map<string, ManagementShadowDecisionRecord>;
}

export function createInMemoryManagementPersistence(): {
  repositories: ManagementRepositories;
  unitOfWork: ManagementUnitOfWork;
} {
  const state = emptyState();
  const repositories = createRepositories(state);
  return {
    repositories,
    unitOfWork: createManagementUnitOfWork(serializeManagementTransactions(async (operation) => {
      const snapshot = cloneState(state);
      try {
        return await operation(repositories);
      } catch (error) {
        restoreState(state, snapshot);
        throw error;
      }
    })),
  };
}

function createRepositories(state: ManagementMemoryState): ManagementRepositories {
  return {
    policies: {
      async get(teamId) { return state.policies.get(teamId) ?? null; },
      async upsert(record) { state.policies.set(record.teamId, record); return record; },
    },
    reservations: {
      async create(record) {
        if ([...state.reservations.values()].some((item) => item.teamId === record.teamId && item.requestKey === record.requestKey)) throw new Error('managed request reservation already exists');
        if ([...state.reservations.values()].some((item) => item.managementRunId === record.managementRunId)) throw new Error('management run reservation already exists');
        state.reservations.set(record.id, record); return record;
      },
      async getByRequestKey(input) { return [...state.reservations.values()].find((item) => item.teamId === input.teamId && item.requestKey === input.requestKey) ?? null; },
    },
    runs: {
      async create(record) { if (state.runs.has(record.id)) throw new Error('management run already exists'); state.runs.set(record.id, record); return record; },
      async getById(id) { return state.runs.get(id) ?? null; },
      async getByRootTaskId(rootTaskId) { return [...state.runs.values()].find((run) => run.rootTaskId === rootTaskId) ?? null; },
      async update(record) { if (!state.runs.has(record.id)) throw new Error('management run does not exist'); state.runs.set(record.id, record); return record; },
    },
    leases: {
      async get(managementRunId) { return state.leases.get(managementRunId) ?? null; },
      async put(record) { state.leases.set(record.managementRunId, record); return record; },
    },
    events: {
      async append(record) {
        const duplicate = state.events.has(record.event.id) || [...state.events.values()].some(({ event }) => event.managementRunId === record.event.managementRunId && (event.sequence === record.event.sequence || event.idempotencyKey === record.event.idempotencyKey));
        if (duplicate) throw new Error('management event sequence or idempotency key already exists');
        state.events.set(record.event.id, record); return record;
      },
      async list(managementRunId) { return [...state.events.values()].filter(({ event }) => event.managementRunId === managementRunId).sort((a, b) => a.event.sequence - b.event.sequence); },
    },
    checkpoints: {
      async put(record) { const key = `${record.managementRunId}:${record.revision}`; if (state.checkpoints.has(key)) throw new Error('management checkpoint already exists'); state.checkpoints.set(key, record); return record; },
      async get(input) { return state.checkpoints.get(`${input.managementRunId}:${input.revision}`) ?? null; },
      async getLatest(managementRunId) { return [...state.checkpoints.values()].filter((item) => item.managementRunId === managementRunId).sort((a, b) => b.revision - a.revision)[0] ?? null; },
    },
    invocations: {
      async create(record) {
        if ([...state.invocations.values()].some((item) => item.managementRunId === record.managementRunId && item.idempotencyKey === record.idempotencyKey)) throw new Error('agent invocation idempotency key already exists');
        state.invocations.set(record.id, record); return record;
      },
      async getById(id) { return state.invocations.get(id) ?? null; },
      async getByIdempotencyKey(input) { return [...state.invocations.values()].find((item) => item.managementRunId === input.managementRunId && item.idempotencyKey === input.idempotencyKey) ?? null; },
      async listByRun(managementRunId) { return [...state.invocations.values()].filter((item) => item.managementRunId === managementRunId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); },
    },
    collaborationProposals: {
      async create(record) {
        if ([...state.collaborationProposals.values()].some((item) => item.managementRunId === record.managementRunId && item.idempotencyKey === record.idempotencyKey)) throw new Error('collaboration proposal idempotency key already exists');
        state.collaborationProposals.set(record.id, record); return record;
      },
      async getById(id) { return state.collaborationProposals.get(id) ?? null; },
      async getByIdempotencyKey(input) { return [...state.collaborationProposals.values()].find((item) => item.managementRunId === input.managementRunId && item.idempotencyKey === input.idempotencyKey) ?? null; },
      async listByRun(managementRunId) { return [...state.collaborationProposals.values()].filter((item) => item.managementRunId === managementRunId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); },
    },
    handoffs: {
      async create(record) {
        if ([...state.handoffs.values()].some((item) => item.managementRunId === record.managementRunId && item.idempotencyKey === record.idempotencyKey)) throw new Error('handoff idempotency key already exists');
        state.handoffs.set(record.id, record); return record;
      },
      async update(record) { if (!state.handoffs.has(record.id)) throw new Error('handoff does not exist'); state.handoffs.set(record.id, record); return record; },
      async getById(id) { return state.handoffs.get(id) ?? null; },
      async getByInvocationId(invocationId) { return [...state.handoffs.values()].find((item) => item.invocationId === invocationId) ?? null; },
      async getByIdempotencyKey(input) { return [...state.handoffs.values()].find((item) => item.managementRunId === input.managementRunId && item.idempotencyKey === input.idempotencyKey) ?? null; },
      async listByRun(managementRunId) { return [...state.handoffs.values()].filter((item) => item.managementRunId === managementRunId).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)); },
    },
    dispatchAttempts: {
      async create(record) {
        const attempts = [...state.attempts.values()];
        if (attempts.some((item) => item.dispatchId === record.dispatchId || (item.invocationId === record.invocationId && item.attemptNumber === record.attemptNumber))) throw new Error('dispatch attempt already exists');
        if (isActive(record.status) && attempts.some((item) => item.invocationId === record.invocationId && isActive(item.status))) throw new Error('active dispatch attempt already exists');
        state.attempts.set(record.id, record); return record;
      },
      async update(record) {
        if (!state.attempts.has(record.id)) throw new Error('dispatch attempt does not exist');
        state.attempts.set(record.id, record); return record;
      },
      async getByDispatchId(dispatchId) { return [...state.attempts.values()].find((item) => item.dispatchId === dispatchId) ?? null; },
      async list(invocationId) { return [...state.attempts.values()].filter((item) => item.invocationId === invocationId).sort((a, b) => a.attemptNumber - b.attemptNumber); },
    },
    shadowDecisions: {
      async create(record) { if (state.shadowDecisions.has(record.id)) throw new Error('shadow decision already exists'); state.shadowDecisions.set(record.id, record); return record; },
      async getByRequestKey(shadowRequestKey) { return [...state.shadowDecisions.values()].find((item) => item.shadowRequestKey === shadowRequestKey) ?? null; },
    },
  };
}

function isActive(status: string): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}
function emptyState(): ManagementMemoryState { return { policies: new Map(), reservations: new Map(), runs: new Map(), leases: new Map(), events: new Map(), checkpoints: new Map(), invocations: new Map(), collaborationProposals: new Map(), handoffs: new Map(), attempts: new Map(), shadowDecisions: new Map() }; }
function cloneState(state: ManagementMemoryState): ManagementMemoryState { return { policies: new Map(state.policies), reservations: new Map(state.reservations), runs: new Map(state.runs), leases: new Map(state.leases), events: new Map(state.events), checkpoints: new Map(state.checkpoints), invocations: new Map(state.invocations), collaborationProposals: new Map(state.collaborationProposals), handoffs: new Map(state.handoffs), attempts: new Map(state.attempts), shadowDecisions: new Map(state.shadowDecisions) }; }
function restoreState(target: ManagementMemoryState, source: ManagementMemoryState): void { for (const key of Object.keys(source) as (keyof ManagementMemoryState)[]) { target[key].clear(); for (const [id, value] of source[key]) target[key].set(id, value as never); } }
