import { describe, expect, it } from 'vitest';
import { messagesForVisibleConversations, visibleConversationIds } from '../lib/chat-scope';

describe('chat scope filters', () => {
  it('keeps activity and saved messages inside the current team conversations', () => {
    const ids = visibleConversationIds([{ id: 'new-team-all' }], [{ id: 'new-team-dm' }]);
    const messages = [
      { id: 'old', channelId: 'old-team-all' },
      { id: 'all', channelId: 'new-team-all' },
      { id: 'dm', channelId: 'new-team-dm' },
    ];

    expect(messagesForVisibleConversations(messages, ids).map((msg) => msg.id)).toEqual(['all', 'dm']);
  });

  it('does not show stale messages before the current team channels are loaded', () => {
    expect(messagesForVisibleConversations([{ id: 'old', channelId: 'old-team-all' }], new Set()).map((msg) => msg.id)).toEqual([]);
  });
});
