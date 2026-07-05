import { describe, expect, test } from 'vitest';
import { shouldHideTaskSystemMessage } from '../lib/task-system-messages';
import type { ChatMessage } from '../lib/schema';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    channelId: 'channel-1',
    senderKind: 'system',
    senderId: null,
    body: '',
    createdAt: 1,
    ...overrides,
  };
}

describe('shouldHideTaskSystemMessage', () => {
  test('hides task-created noise because the task message/card already represents it', () => {
    expect(shouldHideTaskSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'task-created' }),
    }))).toBe(true);
  });

  test('keeps task-status-updated events visible in the channel flow', () => {
    expect(shouldHideTaskSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'task-status-updated', status: 'done', taskNumber: 3 }),
    }))).toBe(false);
  });

  test('keeps non-task and malformed system messages visible', () => {
    expect(shouldHideTaskSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'message-edit-fail' }),
    }))).toBe(false);
    expect(shouldHideTaskSystemMessage(message({ metaJson: '{' }))).toBe(false);
    expect(shouldHideTaskSystemMessage(message({ senderKind: 'human', senderId: 'user-1' }))).toBe(false);
  });
});
