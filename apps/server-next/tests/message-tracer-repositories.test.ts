import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type {
  CommandReceiptRecord,
  CommandReceiptRepository,
  IdempotencyTombstoneRecord,
  InboxItemRecord,
  MessageInboxRepository,
  MessageTracerOutboxRecord,
  MessageTracerOutboxRepository,
} from '../src/application/message-tracer-repositories.js';
import { applyTeamMigrations, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';
import { createSqliteMessageTracerRepositories } from '../src/infra/sqlite/message-tracer-repositories.js';
import {
  createInMemoryMessageTracerRepositories,
  createMessageTracerMemoryState,
} from '../src/infra/memory/message-tracer-repositories.js';

// #921 切片 B：Message tracer 持久化的双实现（SQLite + 内存）参数化套件。
// 覆盖 inbox 连续前缀、target_seq 分配、thread_id NULL 独立序列、(message,recipient) 唯一、
// Read boundary 单调推进、receipt replay/conflict 锚、tombstone 去重。

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

interface Repos {
  readonly inbox: MessageInboxRepository;
  readonly commandReceipts: CommandReceiptRepository;
  readonly outbox: MessageTracerOutboxRepository;
}

let seq = 0;
function uniqueId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function inboxItem(overrides: Partial<InboxItemRecord> & { id: string; messageId: string; recipientId: string }): InboxItemRecord {
  return {
    teamId: 'team-1',
    channelId: 'channel-1',
    threadId: null,
    targetKind: 'channel-mainline',
    targetSeq: 0,
    senderKind: 'human',
    senderId: 'sender-1',
    mentionsRecipient: false,
    committedAt: 1000,
    createdAt: 1000,
    ...overrides,
  };
}

function receipt(overrides: Partial<CommandReceiptRecord> & { receiptId: string; idempotencyKey: string }): CommandReceiptRecord {
  return {
    teamId: 'team-1',
    commandName: 'send-message',
    commandSchemaVersion: 1,
    commandHash: 'hash-A',
    outcome: 'applied',
    committedRevisions: [{ streamKind: 'delivered', streamId: 'channel-1', revision: 1 }],
    eventRefs: [{ streamKind: 'message', streamId: 'm-1', sequence: 1 }],
    resultAvailable: true,
    resultJson: '{"commandName":"send-message","messageId":"m-1","targetSeq":0,"inboxItemRecipientIds":["r-1"]}',
    commitTime: 1000,
    createdAt: 1000,
    ...overrides,
  };
}

function tombstone(overrides: Partial<IdempotencyTombstoneRecord> & { id: string; idempotencyKey: string }): IdempotencyTombstoneRecord {
  return {
    teamId: 'team-1',
    commandName: 'send-message',
    commandHash: 'hash-A',
    receiptId: 'receipt-1',
    outcome: 'applied',
    resultAvailable: false,
    createdAt: 1000,
    ...overrides,
  };
}

function outboxRecord(overrides: Partial<MessageTracerOutboxRecord> & { id: string; receiptId: string }): MessageTracerOutboxRecord {
  return {
    teamId: 'team-1',
    commandName: 'send-message',
    eventKind: 'message-delivered',
    targetKind: 'channel-mainline',
    channelId: 'c-1',
    threadId: null,
    audienceRecipientIds: ['r-1', 'r-2'],
    payloadJson: '{"messageId":"m-1"}',
    deliveredAt: null,
    attempts: 0,
    createdAt: 1000,
    ...overrides,
  };
}

function runMessageTracerRepositorySuite(label: string, makeRepos: () => Repos): void {
  describe(label, () => {
    test('inbox target_seq 从 -1 起递增，连续前缀按 seq 升序、afterSeq/limit 生效', async () => {
      const { inbox } = makeRepos();
      const target = { recipientId: 'r-1', channelId: 'c-1', threadId: null };
      expect(await inbox.getMaxTargetSeq(target)).toBe(-1);

      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-1', recipientId: 'r-1', channelId: 'c-1', targetSeq: 0 }));
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-2', recipientId: 'r-1', channelId: 'c-1', targetSeq: 1 }));
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-3', recipientId: 'r-1', channelId: 'c-1', targetSeq: 2 }));
      expect(await inbox.getMaxTargetSeq(target)).toBe(2);

      // afterSeq 过滤 + 升序
      const tail = await inbox.listItems({ ...target, afterSeq: 0, limit: 10 });
      expect(tail.map((i) => i.targetSeq)).toEqual([1, 2]);
      // limit 截断
      const head = await inbox.listItems({ ...target, afterSeq: -1, limit: 2 });
      expect(head.map((i) => i.targetSeq)).toEqual([0, 1]);
    });

    test('mainline(threadId null) 与 thread 在同 channel 内独立成序（四类 target 投影）', async () => {
      const { inbox } = makeRepos();
      // mainline seq 0、1
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-main-1', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', targetSeq: 0 }));
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-main-2', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', targetSeq: 1 }));
      // 同 channel 的 thread seq 0——不应与 mainline seq 0 冲突
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-th-1', recipientId: 'r-1', channelId: 'c-1', threadId: 'th-1', targetKind: 'thread', targetSeq: 0 }));

      expect(await inbox.getMaxTargetSeq({ recipientId: 'r-1', channelId: 'c-1', threadId: null })).toBe(1);
      expect(await inbox.getMaxTargetSeq({ recipientId: 'r-1', channelId: 'c-1', threadId: 'th-1' })).toBe(0);

      const mainline = await inbox.listItems({ recipientId: 'r-1', channelId: 'c-1', threadId: null, afterSeq: -1, limit: 10 });
      const thread = await inbox.listItems({ recipientId: 'r-1', channelId: 'c-1', threadId: 'th-1', afterSeq: -1, limit: 10 });
      expect(mainline.map((i) => i.messageId)).toEqual(['m-main-1', 'm-main-2']);
      expect(thread.map((i) => i.messageId)).toEqual(['m-th-1']);
    });

    test('同 (message_id, recipient_id) 唯一：重复插入被拒（幂等去重基石）', async () => {
      const { inbox } = makeRepos();
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-dup', recipientId: 'r-1', channelId: 'c-1', targetSeq: 0 }));
      await expect(inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-dup', recipientId: 'r-1', channelId: 'c-1', targetSeq: 1 })))
        .rejects.toThrow();
      // 不同 recipient 接收同一消息——允许（一条消息投影给多个接收方）
      await expect(inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-dup', recipientId: 'r-2', channelId: 'c-1', targetSeq: 0 })))
        .resolves.toBeTruthy();
    });

    test('同 recipient×target 内 target_seq 唯一：重复位置被拒', async () => {
      const { inbox } = makeRepos();
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-a', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetSeq: 0 }));
      await expect(inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-b', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetSeq: 0 })))
        .rejects.toThrow();
    });

    test('hasUnreadMention：自 sinceSeq 起是否存在提及该 recipient 的未读项', async () => {
      const { inbox } = makeRepos();
      const target = { recipientId: 'r-1', channelId: 'c-1', threadId: null };
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-0', recipientId: 'r-1', channelId: 'c-1', targetSeq: 0 })); // 无提及
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-1', recipientId: 'r-1', channelId: 'c-1', targetSeq: 1, mentionsRecipient: true })); // 提及
      await inbox.insertItem(inboxItem({ id: uniqueId('i'), messageId: 'm-2', recipientId: 'r-1', channelId: 'c-1', targetSeq: 2 })); // 无提及
      // sinceSeq=0（exclusive 下一未读）：未读含 m-1 提及 → true
      expect(await inbox.hasUnreadMention({ ...target, sinceSeq: 0 })).toBe(true);
      // sinceSeq=2（m-1 已读）：未读仅 m-2 无提及 → false
      expect(await inbox.hasUnreadMention({ ...target, sinceSeq: 2 })).toBe(false);
      // 无提及的 recipient：false
      expect(await inbox.hasUnreadMention({ recipientId: 'r-2', channelId: 'c-1', threadId: null, sinceSeq: 0 })).toBe(false);
    });

    test('Read boundary 单调推进：插入后仅严格更大的 seq 才推进，回退/相等为幂等 no-op', async () => {
      const { inbox } = makeRepos();
      const target = { recipientId: 'r-1', channelId: 'c-1', threadId: null };
      expect(await inbox.getReadBoundary(target)).toBeNull();

      const created = await inbox.advanceReadBoundary({ id: uniqueId('b'), teamId: 'team-1', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', newSeq: 5, now: 2000 });
      expect(created.readSeq).toBe(5);

      // 回退：no-op
      const lower = await inbox.advanceReadBoundary({ id: uniqueId('b'), teamId: 'team-1', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', newSeq: 3, now: 3000 });
      expect(lower.readSeq).toBe(5);
      expect(lower.advancedAt).toBe(2000);

      // 相等：no-op
      const same = await inbox.advanceReadBoundary({ id: uniqueId('b'), teamId: 'team-1', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', newSeq: 5, now: 4000 });
      expect(same.readSeq).toBe(5);
      expect(same.advancedAt).toBe(2000);

      // 严格更大：推进
      const higher = await inbox.advanceReadBoundary({ id: uniqueId('b'), teamId: 'team-1', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', newSeq: 7, now: 5000 });
      expect(higher.readSeq).toBe(7);
      expect(higher.advancedAt).toBe(5000);

      const current = await inbox.getReadBoundary(target);
      expect(current?.readSeq).toBe(7);
    });

    test('Read boundary 按 target 独立：mainline 与 thread 各自维护', async () => {
      const { inbox } = makeRepos();
      await inbox.advanceReadBoundary({ id: uniqueId('b'), teamId: 'team-1', recipientId: 'r-1', channelId: 'c-1', threadId: null, targetKind: 'channel-mainline', newSeq: 4, now: 1000 });
      await inbox.advanceReadBoundary({ id: uniqueId('b'), teamId: 'team-1', recipientId: 'r-1', channelId: 'c-1', threadId: 'th-1', targetKind: 'thread', newSeq: 9, now: 1000 });
      expect((await inbox.getReadBoundary({ recipientId: 'r-1', channelId: 'c-1', threadId: null }))?.readSeq).toBe(4);
      expect((await inbox.getReadBoundary({ recipientId: 'r-1', channelId: 'c-1', threadId: 'th-1' }))?.readSeq).toBe(9);
    });

    test('receipt 往返：revisions/eventRefs JSON 正确保留，可按 key 与 id 查', async () => {
      const { commandReceipts } = makeRepos();
      const r = receipt({ receiptId: uniqueId('r'), idempotencyKey: 'k-1', commandHash: 'hash-A' });
      await commandReceipts.createReceipt(r);
      const byKey = await commandReceipts.getReceiptByIdempotencyKey('k-1');
      expect(byKey?.commandHash).toBe('hash-A');
      expect(byKey?.committedRevisions).toEqual([{ streamKind: 'delivered', streamId: 'channel-1', revision: 1 }]);
      expect(byKey?.eventRefs).toEqual([{ streamKind: 'message', streamId: 'm-1', sequence: 1 }]);
      expect(byKey?.resultJson).toContain('send-message');
      const byId = await commandReceipts.getReceiptById(r.receiptId);
      expect(byId?.idempotencyKey).toBe('k-1');
    });

    test('receipt resultAvailable=false 时 resultJson 可为 null（治理压缩后仅留 tombstone）', async () => {
      const { commandReceipts } = makeRepos();
      await commandReceipts.createReceipt(receipt({ receiptId: uniqueId('r'), idempotencyKey: 'k-compressed', commandHash: 'hash-A', resultAvailable: false, resultJson: null }));
      const byKey = await commandReceipts.getReceiptByIdempotencyKey('k-compressed');
      expect(byKey?.resultAvailable).toBe(false);
      expect(byKey?.resultJson).toBeNull();
    });

    test('同 idempotency_key 唯一：重复 receipt 插入被拒（replay/conflict 检测锚）', async () => {
      const { commandReceipts } = makeRepos();
      await commandReceipts.createReceipt(receipt({ receiptId: uniqueId('r'), idempotencyKey: 'k-conflict', commandHash: 'hash-A' }));
      // 同 key 异 hash = conflict 防线（handler 应先查既有并比对 hash）
      await expect(commandReceipts.createReceipt(receipt({ receiptId: uniqueId('r'), idempotencyKey: 'k-conflict', commandHash: 'hash-B' })))
        .rejects.toThrow();
    });

    test('tombstone 往返 + 同 idempotency_key 唯一', async () => {
      const { commandReceipts } = makeRepos();
      const t = tombstone({ id: uniqueId('t'), idempotencyKey: 'k-1', commandHash: 'hash-A', receiptId: 'rid-1' });
      await commandReceipts.createTombstone(t);
      const found = await commandReceipts.getTombstoneByIdempotencyKey('k-1');
      expect(found?.commandHash).toBe('hash-A');
      expect(found?.receiptId).toBe('rid-1');
      expect(found?.resultAvailable).toBe(false);
      await expect(commandReceipts.createTombstone(tombstone({ id: uniqueId('t'), idempotencyKey: 'k-1', commandHash: 'hash-A' })))
        .rejects.toThrow();
    });

    test('outbox 入队 + 幂等(同 receipt+eventKind 不重复) + listPending/markDelivered/incrementAttempts', async () => {
      const { outbox } = makeRepos();
      await outbox.enqueue(outboxRecord({ id: uniqueId('o'), receiptId: 'rcpt-1', createdAt: 2000 }));
      await outbox.enqueue(outboxRecord({ id: uniqueId('o'), receiptId: 'rcpt-2', createdAt: 1000 }));
      // 同 (receiptId, eventKind) 幂等：command replay 不重复入队
      await expect(outbox.enqueue(outboxRecord({ id: uniqueId('o'), receiptId: 'rcpt-1', createdAt: 3000 })))
        .rejects.toThrow();

      // listPending：未投递按 createdAt 升序
      const pending = await outbox.listPending({ limit: 10 });
      expect(pending.map((r) => r.receiptId)).toEqual(['rcpt-2', 'rcpt-1']);

      // incrementAttempts + markDelivered
      await outbox.incrementAttempts({ id: pending[0].id });
      await outbox.markDelivered({ id: pending[0].id, now: 9000 });
      const remaining = await outbox.listPending({ limit: 10 });
      expect(remaining.map((r) => r.receiptId)).toEqual(['rcpt-1']);
      expect(remaining.length).toBe(1);
    });
  });
}

// --- SQLite 实现 ---
function makeSqliteRepos(): Repos {
  const db = new Database(':memory:');
  applyTeamMigrations(db);
  const repos = createSqliteMessageTracerRepositories(db);
  return { inbox: repos.inbox, commandReceipts: repos.commandReceipts, outbox: repos.outbox };
}

runMessageTracerRepositorySuite('SQLite message-tracer repositories', () => makeSqliteRepos());

// SQLite 特有：确认底层表与约束（migration team/0056 落地）。
describe('SQLite message-tracer schema (migration team/0056)', () => {
  test('四表存在 + 0056 记入 schema_migrations', () => {
    const db = new Database(':memory:');
    applyTeamMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of ['inbox_items', 'inbox_read_boundaries', 'command_receipts', 'idempotency_tombstones']) {
      expect(names).toContain(expected);
    }
    const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'team/0056_message_tracer_inbox_receipts.sql'").get();
    expect(applied).toBeTruthy();
    db.close();
  });
});

// --- 内存实现 ---
runMessageTracerRepositorySuite('内存 message-tracer repositories', () => {
  const state = createMessageTracerMemoryState();
  const repos = createInMemoryMessageTracerRepositories(state);
  return { inbox: repos.inbox, commandReceipts: repos.commandReceipts, outbox: repos.outbox };
});
