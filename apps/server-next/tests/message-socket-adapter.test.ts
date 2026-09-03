import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeSuccess, type DispatchRequestDto } from '../../../packages/contracts/src/index.js';
import {
  createMessageSocketAdapter,
  type MessageDispatchPort,
} from '../src/transport/message-socket-adapter.js';

describe('MessageSocketAdapter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('fans out committed message facts and emits each dispatch through its narrow port', async () => {
    const getDispatchRequest = vi.fn(async ({ dispatchId }: { dispatchId: string }) =>
      makeSuccess({ request: dispatchRequest(dispatchId) }));
    const dispatch = vi.fn();
    const calls: string[] = [];
    const afterMessageSend = vi.fn(async () => { calls.push('message'); });
    const afterProjectReferencesUpdated = vi.fn(async () => { calls.push('references'); });
    const afterTaskMutation = vi.fn(async () => { calls.push('task'); });
    const afterDispatchMutation = vi.fn(async () => { calls.push('dispatch'); });
    const adapter = createMessageSocketAdapter(
      { getDispatchRequest } satisfies MessageDispatchPort,
      {
        dispatch,
        afterMessageSend,
        afterProjectReferencesUpdated,
        afterTaskMutation,
        afterDispatchMutation,
      },
    );
    const payload = { channelId: 'channel-1', body: 'ship it' };
    const result = {
      ok: true,
      message: {
        id: 'message-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        body: 'ship it',
      },
      referenceSet: { id: 'reference-set-1' },
      task: { id: 'task-1' },
      dispatches: [dispatchAck('dispatch-1')],
    };

    await adapter.handleMutation('send', payload, result);

    expect(afterMessageSend).toHaveBeenCalledWith(payload, result);
    expect(afterProjectReferencesUpdated).toHaveBeenCalledWith({
      teamId: 'team-1',
      channelId: 'channel-1',
      referenceSet: result.referenceSet,
    });
    expect(afterTaskMutation).toHaveBeenCalledWith(payload, result);
    expect(afterDispatchMutation).toHaveBeenCalledWith('message-send', payload, result);
    expect(calls).toEqual(['message', 'references', 'task', 'dispatch']);
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith(dispatchRequest('dispatch-1'));
    });
  });

  test('only projects frozen references from a successful send ack that contains a reference set', async () => {
    const afterMessageSend = vi.fn();
    const afterProjectReferencesUpdated = vi.fn();
    const adapter = createMessageSocketAdapter(
      { getDispatchRequest: vi.fn() } as unknown as MessageDispatchPort,
      { afterMessageSend, afterProjectReferencesUpdated },
    );

    await adapter.handleMutation('send', {}, { ok: false, error: 'VALIDATION_ERROR' });
    await adapter.handleMutation('send', {}, {
      ok: true,
      message: { id: 'message-1', body: 'plain message' },
      dispatches: [],
    });
    await adapter.handleMutation('send', {}, {
      ok: true,
      message: { id: 'message-2', body: 'missing committed scope' },
      referenceSet: { id: 'reference-set-1' },
      dispatches: [],
    });

    expect(afterMessageSend).toHaveBeenCalledTimes(3);
    expect(afterProjectReferencesUpdated).not.toHaveBeenCalled();
  });

  test('preserves edit, delete, and convert-to-task projection order', async () => {
    const calls: string[] = [];
    const adapter = createMessageSocketAdapter(
      { getDispatchRequest: vi.fn() } as unknown as MessageDispatchPort,
      {
        afterMessageSend: async () => { calls.push('message'); },
        afterMemoryMutation: async () => { calls.push('memory'); },
        afterTaskMutation: async () => { calls.push('task'); },
      },
    );

    await adapter.handleMutation('edit', {}, { ok: true });
    expect(calls.splice(0)).toEqual(['message']);

    await adapter.handleMutation('delete', {}, { ok: true });
    expect(calls.splice(0)).toEqual(['message', 'memory']);

    await adapter.handleMutation('convert-to-task', {}, { ok: true });
    expect(calls.splice(0)).toEqual(['task', 'message']);
  });

  test('keeps independent quiet windows for concurrent dispatches', async () => {
    vi.useFakeTimers();
    const getDispatchRequest = vi.fn(async ({ dispatchId }: { dispatchId: string }) =>
      makeSuccess({ request: dispatchRequest(dispatchId) }));
    const dispatch = vi.fn();
    const adapter = createMessageSocketAdapter(
      { getDispatchRequest } satisfies MessageDispatchPort,
      { dispatch, dispatchRequestCoalesceMs: 100 },
    );

    await adapter.handleMutation('send', {}, successWithDispatch('dispatch-1'));
    await vi.advanceTimersByTimeAsync(50);
    await adapter.handleMutation('send', {}, successWithDispatch('dispatch-2'));

    await vi.advanceTimersByTimeAsync(50);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenNthCalledWith(1, dispatchRequest('dispatch-1'));

    await vi.advanceTimersByTimeAsync(50);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(2, dispatchRequest('dispatch-2'));
  });

  test('claim-capable dispatch bypasses the quiet window and cancelled dispatch stays silent', async () => {
    vi.useFakeTimers();
    const getDispatchRequest = vi.fn(async ({ dispatchId }: { dispatchId: string }) =>
      makeSuccess({ request: dispatchRequest(dispatchId) }));
    const dispatch = vi.fn();
    const adapter = createMessageSocketAdapter(
      { getDispatchRequest } satisfies MessageDispatchPort,
      {
        dispatch,
        dispatchRequestCoalesceMs: 100,
        shouldUseDispatchClaim: (request) => request.agentId === 'agent-dispatch-claim',
      },
    );

    await adapter.handleMutation('send', {}, successWithDispatch('dispatch-claim', 'agent-dispatch-claim'));
    await vi.waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        ...dispatchRequest('dispatch-claim', 'agent-dispatch-claim'),
        claimRequired: true,
      });
    });

    await adapter.handleMutation('send', {}, successWithDispatch('dispatch-cancel'));
    adapter.cancelPendingDispatch('dispatch-cancel');
    await vi.advanceTimersByTimeAsync(100);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

function successWithDispatch(dispatchId: string, agentId = `agent-${dispatchId}`) {
  return {
    ok: true,
    message: { id: `message-${dispatchId}`, body: 'hello' },
    dispatches: [dispatchAck(dispatchId, agentId)],
  };
}

function dispatchAck(dispatchId: string, agentId = `agent-${dispatchId}`) {
  return {
    id: dispatchId,
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: `message-${dispatchId}`,
    agentId,
    requestId: `request-${dispatchId}`,
  };
}

function dispatchRequest(dispatchId: string, agentId = `agent-${dispatchId}`): DispatchRequestDto & { id: string } {
  return {
    id: dispatchId,
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: `message-${dispatchId}`,
    agentId,
    requestId: `request-${dispatchId}`,
    prompt: 'hello',
  };
}
