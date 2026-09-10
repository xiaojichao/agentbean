import { beforeEach, describe, expect, test } from 'vitest';
import { useAgentBeanStore } from '../lib/store';
import { mergeOlderChannelMessages } from '../lib/channel-history';
import type { ChatMessage } from '../lib/schema';

const message = (id: string, createdAt: number): ChatMessage => ({
  id, createdAt, channelId: 'channel', senderKind: 'human', senderId: 'user', body: id,
});

describe('channel history pages', () => {
  beforeEach(() => useAgentBeanStore.setState({ messagesByChannel: {}, channelHistoryByChannel: {}, currentTeamId: 'team' }));

  test('prepends equal-time messages in server order and keeps newer live values for duplicates', () => {
    const live = { ...message('live', 10), body: 'latest edit', dispatchStatus: 'running' as const };
    const page = [message('older', 10), message('live', 10), message('older', 10)];
    expect(mergeOlderChannelMessages([live], page)).toEqual([message('older', 10), live]);
  });

  test('a new history snapshot does not discard loaded pages or reset their cursor', () => {
    const store = useAgentBeanStore.getState();
    store.applyChannelHistory('channel', [message('recent', 20)], { hasMore: true, nextBeforeMessageId: 'recent' });
    store.prependChannelHistory('channel', [message('older', 10)], { hasMore: true, nextBeforeMessageId: 'older' });
    store.appendMessage(message('new-live', 30));
    store.applyChannelHistory('channel', [{ ...message('recent', 20), body: 'edited' }], { hasMore: true, nextBeforeMessageId: 'recent' });
    expect(useAgentBeanStore.getState().messagesByChannel.channel).toEqual([
      message('older', 10), { ...message('recent', 20), body: 'edited' }, message('new-live', 30),
    ]);
    expect(useAgentBeanStore.getState().channelHistoryByChannel.channel)
      .toEqual({ loadedOlder: true, hasMore: true, nextBeforeMessageId: 'older' });
  });

  test('end of history survives refresh and team changes clear both data and cursor', () => {
    const store = useAgentBeanStore.getState();
    store.prependChannelHistory('channel', [message('first', 1)], { hasMore: false, nextBeforeMessageId: null });
    store.applyChannelHistory('channel', [message('last', 20)], { hasMore: true, nextBeforeMessageId: 'last' });
    expect(useAgentBeanStore.getState().channelHistoryByChannel.channel.hasMore).toBe(false);
    store.setCurrentTeamId('other');
    expect(useAgentBeanStore.getState().messagesByChannel).toEqual({});
    expect(useAgentBeanStore.getState().channelHistoryByChannel).toEqual({});
  });
});
