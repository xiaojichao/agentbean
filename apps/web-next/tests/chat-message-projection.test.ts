import { describe, expect, test } from 'vitest';
import type { ChatMessage } from '../lib/schema';
import {
  projectChatViewMessages,
  taskIdForStatusMessageDeepLink,
  taskStatusMessagesForTask,
} from '../lib/chat-message-projection';
import { shouldHideSystemMessage } from '../lib/system-messages';

function message(input: Partial<ChatMessage> & Pick<ChatMessage, 'id'>): ChatMessage {
  return {
    channelId: 'channel-1',
    senderKind: 'human',
    senderId: 'user-1',
    body: input.id,
    createdAt: 1,
    ...input,
  };
}

describe('Web chat-view message projection', () => {
  const root = message({
    id: 'root-1',
    meta: { kind: 'task-created', taskId: 'task-1' },
  });
  const firstStatus = message({
    id: 'status-1',
    senderKind: 'system',
    senderId: null,
    threadId: 'root-1',
    createdAt: 2,
    meta: { kind: 'task-status-updated', taskId: 'task-1', status: 'in_progress' },
  });
  const reply = message({ id: 'reply-1', threadId: 'root-1', createdAt: 3 });
  const legacyClaim = message({
    id: 'claim-1',
    senderKind: 'agent',
    senderId: 'agent-1',
    threadId: 'root-1',
    createdAt: 3,
    meta: { kind: 'task-claim-confirmed', taskId: 'task-1', dispatchId: 'dispatch-1' },
  });
  const secondStatus = message({
    id: 'status-2',
    senderKind: 'system',
    senderId: null,
    createdAt: 4,
    metaJson: JSON.stringify({ kind: 'task-status-updated', taskId: 'task-1', status: 'in_review' }),
  });

  test('状态事件不进入频道主线、Thread 回复与回复计数，但普通消息保留', () => {
    const raw = [root, firstStatus, legacyClaim, reply, secondStatus];
    const projected = projectChatViewMessages(raw);

    expect(projected.map((item) => item.id)).toEqual(['root-1', 'reply-1']);
    expect(projected.filter((item) => item.threadId === 'root-1')).toHaveLength(1);
    expect(raw).toHaveLength(5);
    expect(shouldHideSystemMessage(firstStatus)).toBe(false);
  });

  test('TaskDetail 从原始消息集合恢复连续状态历史并保留顺序', () => {
    expect(taskStatusMessagesForTask(
      [secondStatus, root, firstStatus],
      'task-1',
    ).map((item) => item.id)).toEqual(['status-2', 'status-1']);
    expect(taskStatusMessagesForTask([firstStatus], 'task-2')).toEqual([]);
  });

  test('隐藏状态事件的历史 message 深链仍可解析对应 Task', () => {
    const raw = [root, firstStatus];
    expect(taskIdForStatusMessageDeepLink(raw, 'status-1')).toBe('task-1');
    expect(taskIdForStatusMessageDeepLink(raw, 'root-1')).toBeNull();
  });
});
