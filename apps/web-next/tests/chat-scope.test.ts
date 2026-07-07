import { describe, expect, test } from 'vitest';
import { activityConversationIds, inboxActivityMessages, isTopLevelAgentReply, markMessagesDone, mergeChannelHistory, setMessageDone } from '../lib/chat-scope';

const human = { senderKind: 'human', senderId: 'u', body: '' } as const;

describe('activityConversationIds', () => {
  test('静音频道状态尚未加载时不暴露活动 scope', () => {
    const ids = activityConversationIds(new Set(['c1', 'c2']), new Set(['c2']), false);
    expect([...ids]).toEqual([]);
  });

  test('静音频道状态加载后排除 muted channel', () => {
    const ids = activityConversationIds(new Set(['c1', 'c2', 'dm1']), new Set(['c2']));
    expect([...ids].sort()).toEqual(['c1', 'dm1']);
  });
});

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

describe('markMessagesDone', () => {
  test('把当前活动消息合并进已有 doneIds，而不是替换旧状态', () => {
    const done = markMessagesDone(new Set(['muted-read']), [{ id: 'visible-1' }, { id: 'visible-2' }]);
    expect([...done].sort()).toEqual(['muted-read', 'visible-1', 'visible-2']);
  });
});

describe('setMessageDone', () => {
  test('可把单条消息标记为已读/完成', () => {
    const done = setMessageDone(new Set(['old']), 'message-1', true);
    expect([...done].sort()).toEqual(['message-1', 'old']);
  });

  test('可把单条消息重新标记为未读', () => {
    const done = setMessageDone(new Set(['message-1', 'old']), 'message-1', false);
    expect([...done]).toEqual(['old']);
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

  test('找不到 origin 且有顶层 replyScope → true（history 截断时仍显示频道顶层 agent 回复）', () => {
    expect(isTopLevelAgentReply(
      { id: 'agent-1', threadId: 'root-1', senderKind: 'agent', meta: { replyScope: 'channel' } },
      undefined,
    )).toBe(true);
  });

  test('找不到 origin 且没有顶层信号 → false（旧讨论串回复不误提到主时间线）', () => {
    expect(isTopLevelAgentReply(
      { id: 'agent-1', threadId: 'root-1', senderKind: 'agent' },
      undefined,
    )).toBe(false);
  });

  test('找不到 origin 时可从 metaJson 读取顶层 replyScope', () => {
    expect(isTopLevelAgentReply(
      { id: 'agent-1', threadId: 'root-1', senderKind: 'agent', metaJson: '{"replyScope":"channel"}' },
      undefined,
    )).toBe(true);
  });
});

describe('mergeChannelHistory', () => {
  test('保留客户端 running dispatchStatus（服务端 history 未带该字段）', () => {
    const merged = mergeChannelHistory(
      [{ id: 'm1' }],
      [{ id: 'm1', dispatchStatus: 'running', dispatchId: 'd1' }],
    );
    expect(merged).toEqual([{ id: 'm1', dispatchStatus: 'running', dispatchId: 'd1' }]);
  });

  test('服务端带 dispatchStatus 时以服务端为准', () => {
    const merged = mergeChannelHistory(
      [{ id: 'm1', dispatchStatus: 'succeeded' }],
      [{ id: 'm1', dispatchStatus: 'running', dispatchId: 'd1' }],
    );
    expect(merged[0]).toEqual({ id: 'm1', dispatchStatus: 'succeeded', dispatchId: 'd1' });
  });

  test('服务端新增消息直接收入，既有消息保留客户端 dispatchState', () => {
    const merged = mergeChannelHistory(
      [{ id: 'm1' }, { id: 'm2' }],
      [{ id: 'm1', dispatchStatus: 'running', dispatchId: 'd1' }],
    );
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(merged[0].dispatchStatus).toBe('running');
  });

  test('客户端有但服务端 history 没有的终态消息被丢弃（history 为权威集合）', () => {
    const merged = mergeChannelHistory(
      [{ id: 'm1' }],
      [{ id: 'm1' }, { id: 'm-old', dispatchStatus: 'succeeded' }],
    );
    expect(merged.map((m) => m.id)).toEqual(['m1']);
  });

  test('客户端有但服务端 history 没有的 pending dispatch 消息在窗口内会保留', () => {
    const merged = mergeChannelHistory(
      [{ id: 'm2', createdAt: 200 }],
      [{ id: 'm1', createdAt: 300, dispatchStatus: 'running', dispatchId: 'd1' }],
    );
    expect(merged).toEqual([
      { id: 'm2', createdAt: 200 },
      { id: 'm1', createdAt: 300, dispatchStatus: 'running', dispatchId: 'd1' },
    ]);
  });

  test('客户端有但服务端 history 没有的旧 pending dispatch 消息会被截断窗口清掉', () => {
    const merged = mergeChannelHistory(
      [{ id: 'm2', createdAt: 200 }],
      [{ id: 'm1', createdAt: 100, dispatchStatus: 'running', dispatchId: 'd1' }],
    );
    expect(merged).toEqual([{ id: 'm2', createdAt: 200 }]);
  });

  test('保留搜索跳转拉回的旧 thread context 消息', () => {
    const merged = mergeChannelHistory(
      [{ id: 'latest', createdAt: 1000 }],
      [
        { id: 'root', createdAt: 100, meta: { __contextLoaded: true } },
        { id: 'reply', createdAt: 120, meta: { __contextLoaded: true } },
      ],
    );
    expect(merged.map((m) => m.id)).toEqual(['root', 'reply', 'latest']);
  });
});
