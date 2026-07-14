import { describe, expect, test } from 'vitest';
import { planMentionMigration } from '../src/application/mention-migration';
import type { MessageRecord } from '../src/application/repositories';

function msg(over: Partial<MessageRecord> & { id: string; body: string }): MessageRecord {
  return {
    teamId: 't1',
    channelId: 'c1',
    threadId: null,
    senderKind: 'human',
    senderId: 'u1',
    createdAt: 0,
    ...over,
  } as MessageRecord;
}

describe('planMentionMigration (改名时迁移 @oldName → 锁定 agentId)', () => {
  test('REGRESSION: backfills mentions for body @oldName, locking id', () => {
    const result = planMentionMigration(
      [msg({ id: 'm1', body: '@mac1 你有哪些模型？', meta: { routeReason: 'MENTION' } })],
      'mac1',
      'agent-a',
    );
    expect(result).toEqual([
      { messageId: 'm1', meta: { routeReason: 'MENTION', mentions: [{ id: 'agent-a', kind: 'agent', name: 'mac1', start: 0, end: 5 }] } },
    ]);
  });

  test('skips messages without @oldName', () => {
    const result = planMentionMigration(
      [msg({ id: 'm2', body: '普通消息', meta: {} })],
      'mac1',
      'agent-a',
    );
    expect(result).toEqual([]);
  });

  test('preserves existing mentions and appends new one', () => {
    const existing = [{ id: 'other', kind: 'agent' as const, name: 'x', start: 99, end: 100 }];
    const result = planMentionMigration(
      [msg({ id: 'm3', body: '@mac1 hi', meta: { mentions: existing } })],
      'mac1',
      'agent-a',
    );
    expect(result[0]?.meta.mentions).toHaveLength(2);
    expect(result[0]?.meta.mentions?.find((m) => m.id === 'agent-a')).toBeDefined();
  });

  test('idempotent: re-running over already-migrated message yields nothing', () => {
    const original = [msg({ id: 'm1', body: '@mac1 hi', meta: {} })];
    const once = planMentionMigration(original, 'mac1', 'agent-a');
    const twice = planMentionMigration(
      [{ ...original[0]!, meta: once[0]!.meta } as MessageRecord],
      'mac1',
      'agent-a',
    );
    expect(twice).toEqual([]);
  });

  test('matches name case-insensitively, keeps body-cased name in mention', () => {
    const result = planMentionMigration(
      [msg({ id: 'm4', body: '@Mac1 hi', meta: {} })],
      'mac1',
      'agent-a',
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.meta.mentions?.[0]?.name).toBe('Mac1');
    expect(result[0]?.meta.mentions?.[0]?.id).toBe('agent-a');
  });

  test('multiple @oldName in one body all backfilled', () => {
    const result = planMentionMigration(
      [msg({ id: 'm5', body: '@mac1 问 @mac1 答', meta: {} })],
      'mac1',
      'agent-a',
    );
    expect(result[0]?.meta.mentions).toHaveLength(2);
  });
});
