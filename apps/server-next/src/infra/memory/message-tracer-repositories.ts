import type {
  CommandReceiptRecord,
  CommandReceiptRepository,
  IdempotencyTombstoneRecord,
  InboxItemRecord,
  InboxReadBoundaryRecord,
  MessageInboxRepository,
  MessageTracerOutboxRecord,
  MessageTracerOutboxRepository,
  MessageTracerRepositories,
} from '../../application/message-tracer-repositories.js';

// #921 切片 B：Message tracer 的内存持久化实现（独立工厂，便于与 SQLite 实现跑同一套件）。
// thread_id 定位语义与 SQLite 的生成列 thread_key=COALESCE(thread_id,'') 一致：mainline('') 与 thread 独立成序。

export interface MessageTracerMemoryState {
  readonly inboxItems: Map<string, InboxItemRecord>;
  readonly inboxReadBoundaries: Map<string, InboxReadBoundaryRecord>;
  readonly commandReceipts: Map<string, CommandReceiptRecord>;
  readonly idempotencyTombstones: Map<string, IdempotencyTombstoneRecord>;
  readonly outbox: Map<string, MessageTracerOutboxRecord>;
}

export function createMessageTracerMemoryState(): MessageTracerMemoryState {
  return {
    inboxItems: new Map(),
    inboxReadBoundaries: new Map(),
    commandReceipts: new Map(),
    idempotencyTombstones: new Map(),
    outbox: new Map(),
  };
}

export function cloneMessageTracerMemoryState(state: MessageTracerMemoryState): MessageTracerMemoryState {
  return {
    inboxItems: new Map(state.inboxItems),
    inboxReadBoundaries: new Map(state.inboxReadBoundaries),
    commandReceipts: new Map(state.commandReceipts),
    idempotencyTombstones: new Map(state.idempotencyTombstones),
    outbox: new Map(state.outbox),
  };
}

export function restoreMessageTracerMemoryState(
  state: MessageTracerMemoryState,
  snapshot: MessageTracerMemoryState,
): void {
  state.inboxItems.clear();
  for (const [id, record] of snapshot.inboxItems) state.inboxItems.set(id, record);
  state.inboxReadBoundaries.clear();
  for (const [id, record] of snapshot.inboxReadBoundaries) state.inboxReadBoundaries.set(id, record);
  state.commandReceipts.clear();
  for (const [id, record] of snapshot.commandReceipts) state.commandReceipts.set(id, record);
  state.idempotencyTombstones.clear();
  for (const [id, record] of snapshot.idempotencyTombstones) state.idempotencyTombstones.set(id, record);
  state.outbox.clear();
  for (const [id, record] of snapshot.outbox) state.outbox.set(id, record);
}

function threadKey(threadId: string | null): string {
  return threadId ?? '';
}

export function createInMemoryMessageTracerRepositories(
  state: MessageTracerMemoryState,
): MessageTracerRepositories {
  const inbox: MessageInboxRepository = {
    async insertItem(input) {
      const key = threadKey(input.threadId);
      for (const existing of state.inboxItems.values()) {
        // (message_id, recipient_id) 唯一：一条消息投递给一个 recipient 恰好一行。
        if (existing.messageId === input.messageId && existing.recipientId === input.recipientId) {
          throw new Error(
            `MESSAGE_TRACER_UNIQUE: inbox item message_id=${input.messageId} recipient_id=${input.recipientId}`,
          );
        }
        // (recipient, channel, thread_key, target_seq) 唯一：recipient × target 内位置不重复（对齐 SQLite 生成列索引）。
        if (existing.recipientId === input.recipientId
          && existing.channelId === input.channelId
          && threadKey(existing.threadId) === key
          && existing.targetSeq === input.targetSeq) {
          throw new Error(
            `MESSAGE_TRACER_UNIQUE: inbox item recipient_id=${input.recipientId} channel_id=${input.channelId} thread_key=${key} target_seq=${input.targetSeq}`,
          );
        }
      }
      state.inboxItems.set(input.id, input);
      return input;
    },
    async listItems(input) {
      const key = threadKey(input.threadId);
      return Array.from(state.inboxItems.values())
        .filter((item) => item.recipientId === input.recipientId
          && item.channelId === input.channelId
          && threadKey(item.threadId) === key
          && item.targetSeq > input.afterSeq)
        .sort((a, b) => a.targetSeq - b.targetSeq)
        .slice(0, input.limit);
    },
    async getMaxTargetSeq(input) {
      const key = threadKey(input.threadId);
      return Array.from(state.inboxItems.values())
        .filter((item) => item.recipientId === input.recipientId
          && item.channelId === input.channelId
          && threadKey(item.threadId) === key)
        .reduce((max, item) => Math.max(max, item.targetSeq), -1);
    },
    async hasUnreadMention(input) {
      const key = threadKey(input.threadId);
      return Array.from(state.inboxItems.values())
        .some((item) => item.recipientId === input.recipientId
          && item.channelId === input.channelId
          && threadKey(item.threadId) === key
          && item.targetSeq >= input.sinceSeq
          && item.mentionsRecipient);
    },
    async getReadBoundary(input) {
      const key = threadKey(input.threadId);
      return Array.from(state.inboxReadBoundaries.values())
        .find((b) => b.recipientId === input.recipientId
          && b.channelId === input.channelId
          && threadKey(b.threadId) === key) ?? null;
    },
    async advanceReadBoundary(input) {
      const existing = await this.getReadBoundary({
        recipientId: input.recipientId,
        channelId: input.channelId,
        threadId: input.threadId,
      });
      if (!existing) {
        const record: InboxReadBoundaryRecord = {
          id: input.id,
          teamId: input.teamId,
          recipientId: input.recipientId,
          channelId: input.channelId,
          threadId: input.threadId,
          targetKind: input.targetKind,
          readSeq: input.newSeq,
          advancedAt: input.now,
          createdAt: input.now,
        };
        state.inboxReadBoundaries.set(record.id, record);
        return record;
      }
      // 单调推进：仅当 newSeq 严格大于当前 readSeq 才更新（ack 幂等，不可回退，#900 §13）。
      if (input.newSeq > existing.readSeq) {
        const updated = { ...existing, readSeq: input.newSeq, advancedAt: input.now };
        state.inboxReadBoundaries.set(existing.id, updated);
        return updated;
      }
      return existing;
    },
  };

  const commandReceipts: CommandReceiptRepository = {
    async createReceipt(input) {
      for (const existing of state.commandReceipts.values()) {
        if (existing.idempotencyKey === input.idempotencyKey) {
          throw new Error(`MESSAGE_TRACER_UNIQUE: receipt idempotency_key=${input.idempotencyKey}`);
        }
      }
      state.commandReceipts.set(input.receiptId, input);
      return input;
    },
    async getReceiptByIdempotencyKey(idempotencyKey) {
      return Array.from(state.commandReceipts.values())
        .find((r) => r.idempotencyKey === idempotencyKey) ?? null;
    },
    async getReceiptById(receiptId) {
      return state.commandReceipts.get(receiptId) ?? null;
    },
    async createTombstone(input) {
      for (const existing of state.idempotencyTombstones.values()) {
        if (existing.idempotencyKey === input.idempotencyKey) {
          throw new Error(`MESSAGE_TRACER_UNIQUE: tombstone idempotency_key=${input.idempotencyKey}`);
        }
      }
      state.idempotencyTombstones.set(input.id, input);
      return input;
    },
    async getTombstoneByIdempotencyKey(idempotencyKey) {
      return Array.from(state.idempotencyTombstones.values())
        .find((t) => t.idempotencyKey === idempotencyKey) ?? null;
    },
  };

  const outbox: MessageTracerOutboxRepository = {
    async enqueue(input) {
      for (const existing of state.outbox.values()) {
        // (receiptId, eventKind) 幂等：command replay 不重复入队（对齐 SQLite 唯一索引）。
        if (existing.receiptId === input.receiptId && existing.eventKind === input.eventKind) {
          throw new Error(
            `MESSAGE_TRACER_UNIQUE: outbox receipt_id=${input.receiptId} event_kind=${input.eventKind}`,
          );
        }
      }
      state.outbox.set(input.id, input);
      return input;
    },
    async listPending(input) {
      return Array.from(state.outbox.values())
        .filter((row) => row.deliveredAt === null)
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, input.limit);
    },
    async markDelivered(input) {
      const existing = state.outbox.get(input.id);
      if (existing) state.outbox.set(input.id, { ...existing, deliveredAt: input.now });
    },
    async incrementAttempts(input) {
      const existing = state.outbox.get(input.id);
      if (existing) state.outbox.set(input.id, { ...existing, attempts: existing.attempts + 1 });
    },
  };

  return { inbox, commandReceipts, outbox };
}
