import { describe, expect, it } from 'vitest';

import {
  MANAGEMENT_TOOL_NAMES,
  createManagementRuntimeFactory,
  type ManagementModelAdapter,
  type ManagementModelRequest,
  type ManagementRuntimeEvent,
} from '../src/index.js';
import { cleanupFailedSession, isNoopCompactionError } from '../src/pi-session-adapter.js';

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
        return { content: [{ type: 'text', text: responses[index++] ?? 'ack' }] };
      },
    },
  };
}

describe('PI management session adapter', () => {
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
    const session = await factory.createSession({
      systemPrompt: { id: 'manager', version: 1, content: 'Manage this AgentBean run.' },
    });
    const unsubscribe = session.subscribe((event) => events.push(event));

    await session.prompt({ text: 'plan' });
    await session.waitForIdle();

    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]?.systemPrompt).toBe('Manage this AgentBean run.');
    expect(model.requests[0]?.tools.map((tool) => tool.name)).toEqual([...MANAGEMENT_TOOL_NAMES]);
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
        return { content: [{ type: 'text', text: `response-${calls}` }] };
      },
    };
    const session = await createManagementRuntimeFactory({
      model,
      toolExecutor: async () => ({ text: 'unused' }),
    }).createSession({ systemPrompt: { id: 'manager', version: 1, content: 'Manage.' } });

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
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
      toolExecutor: async () => ({ text: 'unused' }),
    });
    const first = await factory.createSession({ systemPrompt: { id: 'manager-a', version: 1, content: 'A' } });
    const second = await factory.createSession({ systemPrompt: { id: 'manager-b', version: 1, content: 'B' } });

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
