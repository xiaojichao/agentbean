import { beforeEach, describe, expect, it } from 'vitest';
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
});
