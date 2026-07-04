import { describe, expect, test } from 'vitest';
import { inboxActivityMessages, isTopLevelAgentReply } from '../lib/chat-scope';

const human = { senderKind: 'human', senderId: 'u', body: '' } as const;

describe('inboxActivityMessages', () => {
  test('只保留 visible channel 的消息', () => {
    const result = inboxActivityMessages(
      [
        { id: 'm1', channelId: 'c1', createdAt: 1, ...human },
        { id: 'm2', channelId: 'c2', createdAt: 2, ...human },
      ],
      new Set(['c1']),
    );
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  test('过滤 system 消息', () => {
    const result = inboxActivityMessages(
      [
        { id: 'sys', channelId: 'c1', createdAt: 1, senderKind: 'system', senderId: null, body: '' },
        { id: 'm2', channelId: 'c1', createdAt: 2, ...human },
      ],
      new Set(['c1']),
    );
    expect(result.map((m) => m.id)).toEqual(['m2']);
  });

  test('按 createdAt 降序', () => {
    const result = inboxActivityMessages(
      [
        { id: 'old', channelId: 'c1', createdAt: 1, ...human },
        { id: 'new', channelId: 'c1', createdAt: 5, ...human },
      ],
      new Set(['c1']),
    );
    expect(result.map((m) => m.id)).toEqual(['new', 'old']);
  });

  test('尊重 limit', () => {
    const msgs = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`, channelId: 'c1', createdAt: i, ...human,
    }));
    expect(inboxActivityMessages(msgs, new Set(['c1']), 3).map((m) => m.id)).toEqual(['m4', 'm3', 'm2']);
  });

  test('visibleIds 为空返回空', () => {
    expect(inboxActivityMessages(
      [{ id: 'm1', channelId: 'c1', createdAt: 1, ...human }],
      new Set(),
    )).toEqual([]);
  });

  test('limit 默认 80', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      id: `m${i}`, channelId: 'c1', createdAt: i, ...human,
    }));
    expect(inboxActivityMessages(msgs, new Set(['c1']))).toHaveLength(80);
  });
});

describe('isTopLevelAgentReply', () => {
  test('agent 回复且 origin 是顶层 root → true（应进主时间线）', () => {
    expect(isTopLevelAgentReply(
      { id: 'agent-1', threadId: 'root-1', senderKind: 'agent' },
      { id: 'root-1', threadId: 'root-1', senderKind: 'human' },
    )).toBe(true);
  });

  test('agent 回复但 origin 在显式讨论串 → false（仍嵌套）', () => {
    expect(isTopLevelAgentReply(
      { id: 'agent-2', threadId: 'thread-root', senderKind: 'agent' },
      { id: 'reply-1', threadId: 'thread-root', senderKind: 'human' },
    )).toBe(false);
  });

  test('非 agent 消息 → false', () => {
    expect(isTopLevelAgentReply(
      { id: 'human-2', threadId: 'root-1', senderKind: 'human' },
      { id: 'root-1', threadId: 'root-1', senderKind: 'human' },
    )).toBe(false);
  });

  test('找不到 origin → false（保守嵌套，保持默认行为）', () => {
    expect(isTopLevelAgentReply(
      { id: 'agent-1', threadId: 'root-1', senderKind: 'agent' },
      undefined,
    )).toBe(false);
  });
});
