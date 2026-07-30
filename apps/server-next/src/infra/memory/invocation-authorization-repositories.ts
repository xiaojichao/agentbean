import type {
  InvocationActionApprovalRecord,
  InvocationActionApprovalRepository,
  InvocationAuthorizationCommandReceiptRecord,
  InvocationAuthorizationFactRecord,
  InvocationAuthorizationFactRepository,
  InvocationAuthorizationIdempotencyTombstoneRecord,
  InvocationAuthorizationReceiptRepository,
  InvocationAuthorizationRepositories,
  InvocationEffectOutcomeRecord,
  InvocationEffectOutcomeRepository,
} from '../../application/invocation-authorization-repositories.js';

/**
 * #927 In-memory invocation authorization 仓储实现。
 *
 * 与 promotion-gate-repositories.ts 同构：snapshot/restore 用于测试事务回滚，
 * clone 用于并发隔离。
 */

export interface InvocationAuthorizationMemoryState {
  authorizationFacts: Map<string, InvocationAuthorizationFactRecord>;
  actionApprovals: Map<string, InvocationActionApprovalRecord>;
  effectOutcomes: Map<string, InvocationEffectOutcomeRecord>;
  receipts: Map<string, InvocationAuthorizationCommandReceiptRecord>;
  idempotencyKeyIndex: Map<string, string>;
  effectDedupIndex: Map<string, string>;
  tombstones: Map<string, InvocationAuthorizationIdempotencyTombstoneRecord>;
}

export function createInvocationAuthorizationMemoryState(): InvocationAuthorizationMemoryState {
  return {
    authorizationFacts: new Map(),
    actionApprovals: new Map(),
    effectOutcomes: new Map(),
    receipts: new Map(),
    idempotencyKeyIndex: new Map(),
    effectDedupIndex: new Map(),
    tombstones: new Map(),
  };
}

export function cloneInvocationAuthorizationMemoryState(
  state: InvocationAuthorizationMemoryState,
): InvocationAuthorizationMemoryState {
  return {
    authorizationFacts: new Map(state.authorizationFacts),
    actionApprovals: new Map(state.actionApprovals),
    effectOutcomes: new Map(state.effectOutcomes),
    receipts: new Map(state.receipts),
    idempotencyKeyIndex: new Map(state.idempotencyKeyIndex),
    effectDedupIndex: new Map(state.effectDedupIndex),
    tombstones: new Map(state.tombstones),
  };
}

export function restoreInvocationAuthorizationMemoryState(
  target: InvocationAuthorizationMemoryState,
  source: InvocationAuthorizationMemoryState,
): void {
  target.authorizationFacts = new Map(source.authorizationFacts);
  target.actionApprovals = new Map(source.actionApprovals);
  target.effectOutcomes = new Map(source.effectOutcomes);
  target.receipts = new Map(source.receipts);
  target.idempotencyKeyIndex = new Map(source.idempotencyKeyIndex);
  target.effectDedupIndex = new Map(source.effectDedupIndex);
  target.tombstones = new Map(source.tombstones);
}

export function createInMemoryInvocationAuthorizationRepositories(
  state: InvocationAuthorizationMemoryState = createInvocationAuthorizationMemoryState(),
): InvocationAuthorizationRepositories {
  const authorizationFacts: InvocationAuthorizationFactRepository = {
    async create(record) { state.authorizationFacts.set(record.id, record); return record; },
    async getById(id) { return state.authorizationFacts.get(id) ?? null; },
    async getByIdempotencyKey({ managementRunId, idempotencyKey }) {
      for (const fact of state.authorizationFacts.values()) {
        if (fact.managementRunId === managementRunId && fact.idempotencyKey === idempotencyKey) return fact;
      }
      return null;
    },
    async getByInvocationId(invocationId) {
      for (const fact of state.authorizationFacts.values()) {
        if (fact.invocationId === invocationId && fact.state === 'active') return fact;
      }
      return null;
    },
    async updateState({ id, state: newState, supersededAt }) {
      const existing = state.authorizationFacts.get(id);
      if (existing) state.authorizationFacts.set(id, { ...existing, state: newState, supersededAt });
    },
  };

  const actionApprovals: InvocationActionApprovalRepository = {
    async create(record) { state.actionApprovals.set(record.id, record); return record; },
    async getById(id) { return state.actionApprovals.get(id) ?? null; },
    async getByEffectDedupKey({ managementRunId, invocationId, effectKind, dedupKey }) {
      const key = `${managementRunId}:${invocationId}:${effectKind}:${dedupKey}`;
      const approvalId = state.effectDedupIndex.get(key);
      return approvalId ? (state.actionApprovals.get(approvalId) ?? null) : null;
    },
  };

  const effectOutcomes: InvocationEffectOutcomeRepository = {
    async create(record) {
      state.effectOutcomes.set(record.id, record);
      state.effectDedupIndex.set(
        `${record.managementRunId}:${record.invocationId}:${record.effectKind}:${record.dedupKey}`,
        record.id,
      );
      return record;
    },
    async getByEffectIdentity({ managementRunId, invocationId, effectKind, dedupKey }) {
      const key = `${managementRunId}:${invocationId}:${effectKind}:${dedupKey}`;
      const outcomeId = state.effectDedupIndex.get(key);
      return outcomeId ? (state.effectOutcomes.get(outcomeId) ?? null) : null;
    },
  };

  const receipts: InvocationAuthorizationReceiptRepository = {
    async createReceipt(record) {
      state.receipts.set(record.receiptId, record);
      state.idempotencyKeyIndex.set(record.idempotencyKey, record.receiptId);
      return record;
    },
    async getReceiptByIdempotencyKey(idempotencyKey) {
      const receiptId = state.idempotencyKeyIndex.get(idempotencyKey);
      return receiptId ? (state.receipts.get(receiptId) ?? null) : null;
    },
    async createTombstone(record) { state.tombstones.set(record.id, record); return record; },
  };

  return { authorizationFacts, actionApprovals, effectOutcomes, receipts };
}
