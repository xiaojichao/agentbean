// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useAgentBeanStore } from '../lib/store';
import type { ChatMessage } from '../lib/schema';

function makeMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm1', channelId: 'c1', senderKind: 'human', senderId: 'u1',
    body: 'hi', createdAt: 1000, ...overrides,
  };
}

describe('applyDispatchStatus', () => {
  beforeEach(() => {
    useAgentBeanStore.setState({
      messagesByChannel: {
        c1: [makeMsg({ id: 'm1' }), makeMsg({ id: 'm2', body: 'second' })],
      },
    });
  });

  it('updates dispatchStatus and dispatchId on the matching message', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'running', 'd1');
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs[0].dispatchStatus).toBe('running');
    expect(msgs[0].dispatchId).toBe('d1');
  });

  it('leaves other messages untouched', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'running', 'd1');
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs[1].dispatchStatus).toBeUndefined();
    expect(msgs[1].dispatchId).toBeUndefined();
  });

  it('can update dispatchStatus alone (no dispatchId change when omitted)', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'running', 'd1');
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'm1', 'cancelled');
    const msg = useAgentBeanStore.getState().messagesByChannel.c1[0];
    expect(msg.dispatchStatus).toBe('cancelled');
    expect(msg.dispatchId).toBe('d1');
  });

  it('is a no-op when the channel or message is absent', () => {
    useAgentBeanStore.getState().applyDispatchStatus('c1', 'missing', 'running', 'dx');
    useAgentBeanStore.getState().applyDispatchStatus('other', 'm1', 'running', 'dy');
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs[0].dispatchStatus).toBeUndefined();
  });

  it('dedupes echoed messages without clearing dispatch state', () => {
    useAgentBeanStore.getState().appendMessage(makeMsg({ id: 'm1', dispatchStatus: 'queued', dispatchId: 'd1' }));
    useAgentBeanStore.getState().appendMessage(makeMsg({ id: 'm1', body: 'server echo' }));
    const msgs = useAgentBeanStore.getState().messagesByChannel.c1;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({
      id: 'm1',
      body: 'server echo',
      dispatchStatus: 'queued',
      dispatchId: 'd1',
    });
  });
});

// --- ConversationPage dispatch-status listener ---

const handlers: Record<string, ((payload: unknown) => void)[]> = {};
const emitMock = vi.fn();
const mockSocket = {
  connected: true,
  on: vi.fn((event: string, handler: (payload: unknown) => void) => {
    (handlers[event] ??= []).push(handler);
  }),
  off: vi.fn((event: string, handler: (payload: unknown) => void) => {
    handlers[event] = (handlers[event] ?? []).filter((h) => h !== handler);
  }),
  emit: emitMock,
};

vi.mock('@/lib/socket', () => ({
  getWebSocket: () => mockSocket,
  agentEvents: () => ({ subscribe: () => {}, onSnapshot: () => () => {}, onStatus: () => () => {} }),
  channelEvents: () => ({ subscribe: () => {} }),
  dmEvents: () => ({ list: async () => ({ ok: true, dms: [] }), onSnapshot: () => () => {} }),
}));

import { ConversationPage } from '../components/conversation-page';
import { ChannelInput } from '../components/channel-input';

afterEach(() => {
  cleanup();
  for (const k of Object.keys(handlers)) delete handlers[k];
  emitMock.mockReset();
});

describe('ConversationPage dispatch-status listener', () => {
  it('updates the matching message on message:dispatch-status', async () => {
    useAgentBeanStore.setState({
      currentTeamId: 't1',
      channels: [{ id: 'c1', name: 'general', createdAt: 0 }],
      dms: [],
      agents: {},
      messagesByChannel: {
        c1: [{ id: 'm1', channelId: 'c1', senderKind: 'human', senderId: 'u1', body: 'hi', createdAt: 0 }],
      },
    });
    render(<ConversationPage channelId="c1" mode="channel" />);
    await waitFor(() => expect(emitMock).toHaveBeenCalledWith('channel:join', { channelId: 'c1' }));

    for (const h of handlers['message:dispatch-status'] ?? []) {
      h({ id: 'd1', messageId: 'm1', channelId: 'c1', status: 'running' });
    }
    expect(useAgentBeanStore.getState().messagesByChannel.c1[0].dispatchStatus).toBe('running');

    // other channel's dispatch-status is ignored
    for (const h of handlers['message:dispatch-status'] ?? []) {
      h({ id: 'd2', messageId: 'm9', channelId: 'other', status: 'running' });
    }
    expect(useAgentBeanStore.getState().messagesByChannel.c1).toHaveLength(1);
  });
});

describe('ChannelInput dispatch ack handling', () => {
  it('stores the sent message with dispatch status from the message:send ack', async () => {
    useAgentBeanStore.setState({
      messagesByChannel: {},
      outbox: {},
    });
    emitMock.mockImplementation((event: string, _payload: unknown, ack?: (payload: unknown) => void) => {
      if (event === 'message:send') {
        ack?.({
          ok: true,
          message: makeMsg({ id: 'm9', body: 'run please' }),
          dispatches: [{ id: 'd9', messageId: 'm9', status: 'queued' }],
        });
      }
    });

    render(<ChannelInput channelId="c1" />);
    fireEvent.change(screen.getByPlaceholderText(/输入消息/), { target: { value: 'run please' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => {
      expect(useAgentBeanStore.getState().messagesByChannel.c1?.[0]).toMatchObject({
        id: 'm9',
        dispatchStatus: 'queued',
        dispatchId: 'd9',
      });
    });
  });
});
