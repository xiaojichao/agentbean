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
  SemanticPromotionEvaluationRecord,
  PromotionProposalRecord,
  PromotionProposalActionReceiptRecord,
  SimpleRequestEscalationHandoffRecord,
} from '../../application/promotion-gate-repositories.js';
import type {
  SemanticPromotionRolloutStateV1,
  TeamPromotionPolicyV1,
} from '../../../../../packages/contracts/src/index.js';

// #922 Promotion gate 的内存持久化实现（独立工厂，便于与 SQLite 实现跑同一套件）。
// 模式与 #921 message-tracer-repositories 一致：Map 存储 + UNIQUE 预扫描 throw（PROMOTION_UNIQUE: 前缀）+
// clone/restore 快照，使内存与 SQLite 实现跑同一套测试套件。

export interface PromotionGateMemoryState {
  readonly sourceRelations: Map<string, PromotionSourceRelationRecord>;
  readonly schedulingIntents: Map<string, PromotionSchedulingIntentRecord>;
  readonly outbox: Map<string, PromotionOutboxRecord>;
  readonly receipts: Map<string, PromotionCommandReceiptRecord>;
  readonly tombstones: Map<string, PromotionIdempotencyTombstoneRecord>;
  readonly evaluations: Map<string, SemanticPromotionEvaluationRecord>;
  readonly semanticRollouts: Map<string, SemanticPromotionRolloutStateV1>;
  readonly proposals: Map<string, PromotionProposalRecord>;
  readonly proposalActionReceipts: Map<string, PromotionProposalActionReceiptRecord>;
  readonly teamPolicies: Map<string, TeamPromotionPolicyV1>;
  readonly handoffs: Map<string, SimpleRequestEscalationHandoffRecord>;
}

export function createPromotionGateMemoryState(): PromotionGateMemoryState {
  return {
    sourceRelations: new Map(),
    schedulingIntents: new Map(),
    outbox: new Map(),
    receipts: new Map(),
    tombstones: new Map(),
    evaluations: new Map(),
    semanticRollouts: new Map(),
    proposals: new Map(),
    proposalActionReceipts: new Map(),
    teamPolicies: new Map(),
    handoffs: new Map(),
  };
}

export function clonePromotionGateMemoryState(state: PromotionGateMemoryState): PromotionGateMemoryState {
  return {
    sourceRelations: new Map(state.sourceRelations),
    schedulingIntents: new Map(state.schedulingIntents),
    outbox: new Map(state.outbox),
    receipts: new Map(state.receipts),
    tombstones: new Map(state.tombstones),
    evaluations: new Map(state.evaluations),
    semanticRollouts: new Map(state.semanticRollouts),
    proposals: new Map(state.proposals),
    proposalActionReceipts: new Map(state.proposalActionReceipts),
    teamPolicies: new Map(state.teamPolicies),
    handoffs: new Map(state.handoffs),
  };
}

export function restorePromotionGateMemoryState(
  state: PromotionGateMemoryState,
  snapshot: PromotionGateMemoryState,
): void {
  state.sourceRelations.clear();
  for (const [id, record] of snapshot.sourceRelations) state.sourceRelations.set(id, record);
  state.schedulingIntents.clear();
  for (const [id, record] of snapshot.schedulingIntents) state.schedulingIntents.set(id, record);
  state.outbox.clear();
  for (const [id, record] of snapshot.outbox) state.outbox.set(id, record);
  state.receipts.clear();
  for (const [id, record] of snapshot.receipts) state.receipts.set(id, record);
  state.tombstones.clear();
  for (const [id, record] of snapshot.tombstones) state.tombstones.set(id, record);
  state.evaluations.clear();
  for (const [id, record] of snapshot.evaluations) state.evaluations.set(id, record);
  state.semanticRollouts.clear();
  for (const [id, record] of snapshot.semanticRollouts) state.semanticRollouts.set(id, record);
  state.proposals.clear();
  for (const [id, record] of snapshot.proposals) state.proposals.set(id, record);
  state.proposalActionReceipts.clear();
  for (const [id, record] of snapshot.proposalActionReceipts) state.proposalActionReceipts.set(id, record);
  state.teamPolicies.clear();
  for (const [id, record] of snapshot.teamPolicies) state.teamPolicies.set(id, record);
  state.handoffs.clear();
  for (const [id, record] of snapshot.handoffs) state.handoffs.set(id, record);
}

export function createInMemoryPromotionGateRepositories(
  state: PromotionGateMemoryState,
): PromotionGateRepositories {
  const sourceRelations: PromotionSourceRelationRepository = {
    async create(input) {
      for (const existing of state.sourceRelations.values()) {
        // lineage_key 唯一：同一 source lineage 最多一个 root Task（#894 §8）。
        if (existing.lineageKey === input.lineageKey) {
          throw new Error(`PROMOTION_UNIQUE: source relation lineage_key=${input.lineageKey}`);
        }
      }
      state.sourceRelations.set(input.id, input);
      return input;
    },
    async getByLineageKey(lineageKey) {
      return Array.from(state.sourceRelations.values())
        .find((r) => r.lineageKey === lineageKey) ?? null;
    },
  };

  const schedulingIntents: PromotionSchedulingIntentRepository = {
    async create(input) {
      state.schedulingIntents.set(input.id, input);
      return input;
    },
  };

  const outbox: PromotionOutboxRepository = {
    async create(input) {
      state.outbox.set(input.id, input);
      return input;
    },
  };

  const receipts: PromotionCommandReceiptRepository = {
    async createReceipt(input) {
      for (const existing of state.receipts.values()) {
        if (existing.idempotencyKey === input.idempotencyKey) {
          throw new Error(`PROMOTION_UNIQUE: receipt idempotency_key=${input.idempotencyKey}`);
        }
      }
      state.receipts.set(input.receiptId, input);
      return input;
    },
    async getReceiptByIdempotencyKey(idempotencyKey) {
      return Array.from(state.receipts.values())
        .find((r) => r.idempotencyKey === idempotencyKey) ?? null;
    },
    async getReceiptById(receiptId) {
      return state.receipts.get(receiptId) ?? null;
    },
    async createTombstone(input) {
      for (const existing of state.tombstones.values()) {
        if (existing.idempotencyKey === input.idempotencyKey) {
          throw new Error(`PROMOTION_UNIQUE: tombstone idempotency_key=${input.idempotencyKey}`);
        }
      }
      state.tombstones.set(input.id, input);
      return input;
    },
    async getTombstoneByIdempotencyKey(idempotencyKey) {
      return Array.from(state.tombstones.values())
        .find((t) => t.idempotencyKey === idempotencyKey) ?? null;
    },
  };

  return {
    sourceRelations,
    schedulingIntents,
    outbox,
    receipts,
    evaluations: {
      async create(input) {
        state.evaluations.set(input.id, input);
        return input;
      },
      async listBySourceLineageKey(sourceLineageKey) {
        return [...state.evaluations.values()]
          .filter((item) => item.sourceLineageKey === sourceLineageKey)
          .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
      },
    },
    semanticRollout: {
      async get(teamId) {
        return state.semanticRollouts.get(teamId) ?? null;
      },
      async upsert(input) {
        const current = state.semanticRollouts.get(input.teamId);
        if (!canUpsertRevisionedConfig(current, input)) return null;
        if (current?.revision === input.revision) return current;
        state.semanticRollouts.set(input.teamId, input);
        return input;
      },
    },
    proposals: {
      async create(input) {
        if ([...state.proposals.values()].some((item) =>
          item.sourceLineageKey === input.sourceLineageKey && item.status === 'open')) {
          throw new Error(`PROMOTION_UNIQUE: open proposal lineage_key=${input.sourceLineageKey}`);
        }
        state.proposals.set(input.id, input);
        return input;
      },
      async getById(id) {
        return state.proposals.get(id) ?? null;
      },
      async getOpenBySourceLineageKey(sourceLineageKey) {
        return [...state.proposals.values()]
          .find((item) => item.sourceLineageKey === sourceLineageKey && item.status === 'open') ?? null;
      },
      async updateStatus(input) {
        const current = state.proposals.get(input.proposalId);
        if (!current || current.status !== 'open' || current.revision !== input.expectedRevision) return null;
        const updated: PromotionProposalRecord = {
          ...current,
          status: input.status,
          revision: current.revision + 1,
          rootTaskId: input.rootTaskId ?? current.rootTaskId,
          managementRunId: input.managementRunId ?? current.managementRunId,
          updatedAt: input.updatedAt,
        };
        state.proposals.set(current.id, updated);
        return updated;
      },
      async createActionReceipt(input) {
        if ([...state.proposalActionReceipts.values()].some((item) =>
          item.idempotencyKey === input.idempotencyKey)) {
          throw new Error(`PROMOTION_UNIQUE: proposal action idempotency_key=${input.idempotencyKey}`);
        }
        state.proposalActionReceipts.set(input.id, input);
        return input;
      },
      async getActionReceiptByIdempotencyKey(idempotencyKey) {
        return [...state.proposalActionReceipts.values()]
          .find((item) => item.idempotencyKey === idempotencyKey) ?? null;
      },
    },
    teamPolicy: {
      async get(teamId) {
        return state.teamPolicies.get(teamId) ?? null;
      },
      async upsert(input) {
        const current = state.teamPolicies.get(input.teamId);
        if (!canUpsertRevisionedConfig(current, input)) return null;
        if (current?.revision === input.revision) return current;
        state.teamPolicies.set(input.teamId, input);
        return input;
      },
    },
    handoffs: {
      async create(input) {
        if ([...state.handoffs.values()].some((item) => item.sourceDispatchId === input.sourceDispatchId)) {
          throw new Error(`PROMOTION_UNIQUE: handoff source_dispatch_id=${input.sourceDispatchId}`);
        }
        state.handoffs.set(input.id, input);
        return input;
      },
      async getBySourceDispatchId(sourceDispatchId) {
        return [...state.handoffs.values()]
          .find((item) => item.sourceDispatchId === sourceDispatchId) ?? null;
      },
    },
  };
}

function canUpsertRevisionedConfig<T extends { readonly revision: number }>(
  current: T | undefined,
  input: T,
): boolean {
  if (!current) return input.revision === 1;
  if (input.revision === current.revision) return JSON.stringify(input) === JSON.stringify(current);
  return input.revision === current.revision + 1;
}
