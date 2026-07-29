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

// #922 Promotion gate 的内存持久化实现（独立工厂，便于与 SQLite 实现跑同一套件）。
// 模式与 #921 message-tracer-repositories 一致：Map 存储 + UNIQUE 预扫描 throw（PROMOTION_UNIQUE: 前缀）+
// clone/restore 快照，使内存与 SQLite 实现跑同一套测试套件。

export interface PromotionGateMemoryState {
  readonly sourceRelations: Map<string, PromotionSourceRelationRecord>;
  readonly schedulingIntents: Map<string, PromotionSchedulingIntentRecord>;
  readonly outbox: Map<string, PromotionOutboxRecord>;
  readonly receipts: Map<string, PromotionCommandReceiptRecord>;
  readonly tombstones: Map<string, PromotionIdempotencyTombstoneRecord>;
}

export function createPromotionGateMemoryState(): PromotionGateMemoryState {
  return {
    sourceRelations: new Map(),
    schedulingIntents: new Map(),
    outbox: new Map(),
    receipts: new Map(),
    tombstones: new Map(),
  };
}

export function clonePromotionGateMemoryState(state: PromotionGateMemoryState): PromotionGateMemoryState {
  return {
    sourceRelations: new Map(state.sourceRelations),
    schedulingIntents: new Map(state.schedulingIntents),
    outbox: new Map(state.outbox),
    receipts: new Map(state.receipts),
    tombstones: new Map(state.tombstones),
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

  return { sourceRelations, schedulingIntents, outbox, receipts };
}
