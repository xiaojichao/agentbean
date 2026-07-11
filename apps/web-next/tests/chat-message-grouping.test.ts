import { describe, expect, test } from 'vitest';
import { isMessageGroupContinuation } from '../lib/chat-message-grouping';
import type { ChatMessage } from '../lib/schema';

function message(input: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
  return {
    channelId: 'channel-1',
    senderKind: 'human',
    senderId: 'user-1',
    body: input.id,
    ...input,
  };
}

describe('chat message visual grouping', () => {
  test('groups adjacent messages from the same sender inside the display window', () => {
    expect(isMessageGroupContinuation(
      message({ id: 'first', createdAt: 1_000 }),
      message({ id: 'second', createdAt: 16_000 }),
    )).toBe(true);
  });

  test('starts a new group when sender, channel, or message kind changes', () => {
    const first = message({ id: 'first', createdAt: 1_000 });

    expect(isMessageGroupContinuation(first, message({ id: 'other-user', createdAt: 2_000, senderId: 'user-2' }))).toBe(false);
    expect(isMessageGroupContinuation(first, message({ id: 'other-channel', createdAt: 2_000, channelId: 'channel-2' }))).toBe(false);
    expect(isMessageGroupContinuation(first, message({ id: 'system', createdAt: 2_000, senderKind: 'system', senderId: null }))).toBe(false);
  });

  test('starts a new group after 15 seconds of silence', () => {
    expect(isMessageGroupContinuation(
      message({ id: 'first', createdAt: 1_000 }),
      message({ id: 'later', createdAt: 16_001 }),
    )).toBe(false);
  });
});
