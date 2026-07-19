import { describe, expect, it } from 'vitest';

import {
  PHASE_1_MANAGEMENT_TOOL_NAMES,
  createManagementRuntimeFactory,
  type ManagementModelAdapter,
  type ManagementModelRequest,
  type ManagementRuntimeEvent,
} from '../src/index.js';
import { cleanupFailedSession, isNoopCompactionError } from '../src/pi-session-adapter.js';

function textResponse(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
    },
    finishReason: 'stop' as const,
    responseModel: 'deterministic-model',
  };
}

function managedSessionInput(id: string, content: string) {
  return {
    systemPrompt: { id, version: 1, content },
    mode: 'managed' as const,
    context: {
      schemaVersion: 1 as const,
      scope: {
        kind: 'managed' as const,
        managementRunId: `run-${id}`,
        teamId: 'team-1',
        channelId: 'channel-1',
        rootMessageId: `message-${id}`,
      },
      frozenTarget: { agentId: 'agent-1', kind: 'custom' as const },
      visibleThread: { revision: 1, messages: [] },
    },
  };
}

function deterministicModel(responses: string[] = ['ack']): {
  adapter: ManagementModelAdapter;
  requests: ManagementModelRequest[];
} {
  const requests: ManagementModelRequest[] = [];
  let index = 0;
  return {
    requests,
    adapter: {
      id: 'phase-0-deterministic',
      async respond(request) {
        requests.push(request);
        return textResponse(responses[index++] ?? 'ack');
      },
    },
  };
}

describe('PI management session adapter', () => {
  it('rejects missing or conflicting managed and shadow session scopes', async () => {
    const factory = createManagementRuntimeFactory({
      model: deterministicModel().adapter,
      toolExecutor: async () => ({ text: 'unused' }),
    });

    await expect(factory.createSession({
      systemPrompt: { id: 'manager', version: 1, content: 'Manage.' },
    } as never)).rejects.toThrow('P1_SESSION_CONTEXT_INVALID');
    await expect(factory.createSession({
      systemPrompt: { id: 'manager', version: 1, content: 'Manage.' },
      mode: 'shadow',
      context: {
        schemaVersion: 1,
        scope: {
          kind: 'managed',
          managementRunId: 'run-conflict',
          teamId: 'team-1',
          channelId: 'channel-1',
          rootMessageId: 'message-1',
        },
        frozenTarget: { agentId: 'agent-1', kind: 'custom' },
        visibleThread: { revision: 1, messages: [] },
      },
    })).rejects.toThrow('P1_SESSION_CONTEXT_INVALID');
  });

  it('passes an immutable AgentBean session context snapshot to the provider', async () => {
    const model = deterministicModel();
    const context = {
      schemaVersion: 1 as const,
      scope: {
        kind: 'managed' as const,
        managementRunId: 'run-context',
        teamId: 'team-context',
        channelId: 'channel-context',
        rootMessageId: 'message-context',
      },
      frozenTarget: { agentId: 'agent-context', kind: 'custom' as const },
      visibleThread: {
        revision: 3,
        messages: [{
          id: 'visible-message',
          senderKind: 'human' as const,
          senderId: 'user-context',
          body: 'visible body',
          createdAt: 123,
        }],
      },
    };
    const factory = createManagementRuntimeFactory({
      model: model.adapter,
      toolExecutor: async () => ({ text: 'unused' }),
    });
    const session = await factory.createSession({
      systemPrompt: { id: 'manager', version: 1, content: 'Manage this AgentBean run.' },
      mode: 'managed',
      context,
    });
    context.visibleThread.messages[0]!.body = 'mutated after session creation';

    await session.prompt({ text: 'plan' });
    await session.waitForIdle();

    expect(model.requests[0]?.sessionContext).toEqual({
      schemaVersion: 1,
      scope: {
        kind: 'managed',
        managementRunId: 'run-context',
        teamId: 'team-context',
        channelId: 'channel-context',
        rootMessageId: 'message-context',
      },
      frozenTarget: { agentId: 'agent-context', kind: 'custom' },
      visibleThread: {
        revision: 3,
        messages: [{
          id: 'visible-message',
          senderKind: 'human',
          senderId: 'user-context',
          body: 'visible body',
          createdAt: 123,
        }],
      },
    });
    await session.dispose();
  });

  it('publishes AgentBean-owned provider telemetry on assistant events', async () => {
    const events: ManagementRuntimeEvent[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'provider-adapter',
        async respond() {
          return {
            content: [{ type: 'text', text: 'done' }],
            usage: {
              inputTokens: 12,
              outputTokens: 5,
              cacheReadTokens: 3,
              cacheWriteTokens: 2,
              totalTokens: 22,
            },
            finishReason: 'stop',
            responseModel: 'provider-model-v1',
          };
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession(managedSessionInput('telemetry', 'Manage.'));
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'respond' });
    await session.waitForIdle();

    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      telemetry: {
        usage: {
          inputTokens: 12,
          outputTokens: 5,
          cacheReadTokens: 3,
          cacheWriteTokens: 2,
          totalTokens: 22,
        },
        finishReason: 'stop',
        responseModel: 'provider-model-v1',
      },
    });
    await session.dispose();
  });

  it('never copies provider error secrets into runtime events', async () => {
    const secret = 'provider-secret-must-not-leak';
    const events: ManagementRuntimeEvent[] = [];
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'secret-error-provider',
        async respond() {
          throw new Error(`upstream rejected ${secret}`);
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession(managedSessionInput('secret-error', 'Manage.'));
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'trigger provider error' });
    await session.waitForIdle();

    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain('upstream rejected');
    await session.dispose();
  });

  it('maps malformed provider telemetry to a safe AgentBean failure', async () => {
    const events: ManagementRuntimeEvent[] = [];
    let toolCalls = 0;
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'malformed-provider',
        async respond() {
          return {
            content: [{ type: 'text', text: 'must not be accepted' }],
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 999,
            },
            finishReason: 'stop',
            responseModel: 'untrusted-model-name',
          };
        },
      },
      toolExecutor: async () => {
        toolCalls += 1;
        return { text: 'unused' };
      },
    }).createSession(managedSessionInput('malformed-telemetry', 'Manage.'));
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'respond' });
    await session.waitForIdle();

    expect(toolCalls).toBe(0);
    expect(events).toContainEqual({
      type: 'message',
      role: 'assistant',
      telemetry: {
        usage: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          totalTokens: null,
        },
        finishReason: 'error',
        responseModel: 'malformed-provider',
      },
    });
    expect(JSON.stringify(events)).not.toContain('must not be accepted');
    expect(JSON.stringify(events)).not.toContain('untrusted-model-name');
    await session.dispose();
  });

  it('rejects malformed provider content before it reaches PI or a tool executor', async () => {
    const events: ManagementRuntimeEvent[] = [];
    let toolCalls = 0;
    const session = await createManagementRuntimeFactory({
      model: {
        id: 'malformed-content-provider',
        async respond() {
          return {
            content: [{ type: 'text', text: 42 }],
            usage: {
              inputTokens: 1,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1,
            },
            finishReason: 'stop',
            responseModel: 'untrusted-content-model',
          } as never;
        },
      },
      toolExecutor: async () => {
        toolCalls += 1;
        return { text: 'unused' };
      },
    }).createSession(managedSessionInput('malformed-content', 'Manage.'));
    session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'respond' });
    await session.waitForIdle();

    expect(toolCalls).toBe(0);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'message',
      role: 'assistant',
      telemetry: expect.objectContaining({
        finishReason: 'error',
        responseModel: 'malformed-content-provider',
      }),
    }));
    expect(JSON.stringify(events)).not.toContain('untrusted-content-model');
    await session.dispose();
  });

  it('only maps PI explicit no-op compaction errors to not_needed', () => {
    expect(isNoopCompactionError(new Error('Nothing to compact (session too small)'))).toBe(true);
    expect(isNoopCompactionError(new Error('Already compacted'))).toBe(true);
    expect(isNoopCompactionError(new Error('Compaction cancelled'))).toBe(false);
    expect(isNoopCompactionError(new Error('provider token failure while compacting message'))).toBe(false);
  });

  it('preserves failed-session cleanup when abort itself throws', async () => {
    const calls: string[] = [];
    await cleanupFailedSession({
      async abort() {
        calls.push('abort');
        throw new Error('abort failed');
      },
      dispose() {
        calls.push('dispose');
      },
    }, () => calls.push('unregister'));
    expect(calls).toEqual(['abort', 'dispose', 'unregister']);
  });

  it('creates a real PI session behind AgentBean-only types and normalizes events', async () => {
    const model = deterministicModel();
    const events: ManagementRuntimeEvent[] = [];
    const factory = createManagementRuntimeFactory({
      model: model.adapter,
      toolExecutor: async () => ({ text: 'unused' }),
    });
    const session = await factory.createSession(managedSessionInput('manager', 'Manage this AgentBean run.'));
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'plan' });
    await session.waitForIdle();

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.systemPrompt).toBe('Manage this AgentBean run.');
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([...PHASE_1_MANAGEMENT_TOOL_NAMES]);
    expect(events.some((event) => event.type === 'lifecycle' && event.phase === 'agent_start')).toBe(true);
    expect(events.some((event) => event.type === 'message' && event.role === 'assistant')).toBe(true);
    expect(events.some((event) => event.type === 'unsupported')).toBe(true);
    for (const event of events) {
      expect(event).not.toHaveProperty('raw');
      expect(JSON.stringify(event)).not.toContain('Manage this AgentBean run.');
    }

    unsubscribe();
    await session.dispose();
  });

  it('supports steer, followUp, abort, compaction, and idempotent disposal', async () => {
    let release!: () => void;
    const firstResponse = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const model: ManagementModelAdapter = {
      id: 'phase-0-queued-messages',
      async respond() {
        calls += 1;
        if (calls === 1) await firstResponse;
        return textResponse(`response-${calls}`);
      },
    };
    const session = await createManagementRuntimeFactory({
      model,
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession(managedSessionInput('manager', 'Manage.'));

    const prompt = session.prompt({ text: 'start' });
    await Promise.resolve();
    await session.steer({ text: 'steer' });
    await session.followUp({ text: 'follow-up' });
    release();
    await prompt;
    await session.waitForIdle();

    expect(calls).toBeGreaterThanOrEqual(2);
    await expect(session.compact()).resolves.toMatchObject({ compacted: false, reason: 'not_needed' });
    await session.abort('phase-0-test');
    await Promise.all([session.dispose(), session.dispose()]);
  });

  it('aborts an active provider call and isolates concurrent sessions', async () => {
    const callCounts: number[] = [];
    let activeSignal: AbortSignal | undefined;
    let started!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const factory = createManagementRuntimeFactory({
      model: {
        id: 'concurrent-sessions',
        async respond(request, state) {
          callCounts.push(state.callCount);
          if (!activeSignal) {
            activeSignal = request.signal;
            started();
            await new Promise<void>((_resolve, reject) => {
              request.signal?.addEventListener('abort', () => reject(new Error('aborted by test')), { once: true });
            });
          }
          return textResponse('ok');
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    });
    const first = await factory.createSession(managedSessionInput('manager-a', 'A'));
    const second = await factory.createSession(managedSessionInput('manager-b', 'B'));

    const activePrompt = first.prompt({ text: 'block' });
    await activeStarted;
    await first.abort('lease-lost');
    await activePrompt;
    await second.prompt({ text: 'independent' });
    await second.waitForIdle();

    expect(activeSignal?.aborted).toBe(true);
    expect(callCounts).toEqual([1, 1]);
    await Promise.all([first.dispose(), second.dispose()]);
  });
});
