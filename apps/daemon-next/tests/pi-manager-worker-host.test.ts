import { describe, expect, test, vi } from 'vitest';
import type { ManagementRuntimeFactory, ManagementSession } from '@agentbean/pi-management-runtime';
import { createPiManagerWorkerHost } from '../src/pi-manager-worker-host';
import type { PiManagerWorkerProtocol, PiManagerWorkerProtocolHandlers } from '../src/management-worker-protocol';

function createProtocolHarness() {
  let handlers: PiManagerWorkerProtocolHandlers | undefined;
  const protocol: PiManagerWorkerProtocol = {
    start: vi.fn(async (_capability, nextHandlers) => {
      handlers = nextHandlers;
      return { workerId: 'worker-1' };
    }),
    stop: vi.fn(),
    acquireLease: vi.fn(async () => ({
      schemaVersion: 1, ok: true, managementRunId: 'run-1', workerId: 'worker-1',
      leaseToken: 'raw-lease-token', fencingToken: 1, acquiredAt: 100, expiresAt: 10_000,
    })),
    renewLease: vi.fn(async (input) => ({
      schemaVersion: 1, ok: true, managementRunId: input.managementRunId,
      workerId: input.workerId, fencingToken: input.fencingToken, expiresAt: 20_000,
    })),
    releaseLease: vi.fn(),
    abortLease: vi.fn(async (input) => ({
      schemaVersion: 1, ok: true, managementRunId: input.managementRunId,
      workerId: input.workerId, fencingToken: input.fencingToken, releasedAt: 200,
    })),
    fetchCheckpoint: vi.fn(async () => ({
      schemaVersion: 1,
      managementRunId: 'run-1',
      workerId: 'worker-1',
      context: {
        schemaVersion: 1,
        teamId: 'team-1',
        channelId: 'channel-1',
        rootMessageId: 'message-1',
        frozenTarget: { agentId: 'agent-1', kind: 'custom' },
        visibleThread: {
          revision: 1,
          messages: [{ id: 'message-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1 }],
        },
      },
      checkpoint: {
        schemaVersion: 1,
        managementRunId: 'run-1',
        revision: 1,
        authoritative: {
          lastEventSequence: 3,
          taskGraphRevision: 0,
          openTaskIds: [], waitingInvocationIds: [], completedInvocationIds: [], memoryCapsuleIds: [],
        },
        contextHints: {
          objective: '完成目标', planSummary: '', completedInvocationSummaries: [], unresolvedQuestions: [],
        },
        updatedAt: 5,
      },
    })),
    executeTool: vi.fn(),
    replayOutbox: vi.fn(),
  };
  return { protocol, handlers: () => handlers };
}

describe('PiManagerWorkerHost', () => {
  test('一个 lease 创建一个 typed-context PI Session；断线立即 abort/dispose 并清除 lease', async () => {
    const { protocol, handlers } = createProtocolHarness();
    let keepPromptActive: (() => void) | undefined;
    const session: ManagementSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { keepPromptActive = resolve; })), steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(),
      abort: vi.fn(async () => undefined), waitForIdle: vi.fn(), subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const runtimeFactory: ManagementRuntimeFactory = { createSession: vi.fn(async () => session) };
    const outbox = { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) };
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({
        credentialStatus: 'production_ready', providerId: 'provider-1', modelId: 'model-1',
        apiKey: 'model-secret', baseUrl: 'https://model.invalid/v1',
      }) },
      createRuntimeFactory: () => runtimeFactory,
      outbox,
      now: () => 100,
    });

    await host.start();
    const offer = {
      schemaVersion: 1, offerId: 'offer-1', managementRunId: 'run-1', workerId: 'worker-1', offerExpiresAt: 1_000,
    } as const;
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    await handlers()!.onLeaseOffer(offer);

    expect(runtimeFactory.createSession).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'managed',
      context: expect.objectContaining({
        scope: expect.objectContaining({ managementRunId: 'run-1' }),
        checkpoint: expect.objectContaining({ revision: 1, lastEventSequence: 3 }),
      }),
    }));
    expect(session.prompt).toHaveBeenCalledWith({ text: '完成目标' });

    await handlers()!.onDisconnect();
    expect(session.abort).toHaveBeenCalledWith('worker-disconnected');
    expect(session.dispose).toHaveBeenCalledTimes(1);
    expect(host.activeLeaseCount()).toBe(0);
    expect(JSON.stringify(outbox)).not.toContain('raw-lease-token');
    keepPromptActive?.();
  });

  test('credential unavailable 时仍注册 fail-closed capability，但拒绝 lease offer', async () => {
    const { protocol, handlers } = createProtocolHarness();
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'unavailable' }) },
      createRuntimeFactory: vi.fn(),
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
    });

    await host.start();

    expect(protocol.start).toHaveBeenCalledWith(expect.objectContaining({
      credentialStatus: 'unavailable',
    }), expect.any(Object));
    expect(handlers()!.reserveLeaseOffer({
      schemaVersion: 1, offerId: 'offer-1', managementRunId: 'run-1', workerId: 'worker-1', offerExpiresAt: Date.now() + 1_000,
    })).toBe(false);
  });

  test('maxConcurrentLeases=1 时同步预留已接受 offer，拒绝并发超卖', async () => {
    const { protocol, handlers } = createProtocolHarness();
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({
        credentialStatus: 'production_ready', providerId: 'provider-1', modelId: 'model-1',
        apiKey: 'model-secret', baseUrl: 'https://model.invalid/v1',
      }) },
      createRuntimeFactory: () => ({ createSession: vi.fn() }),
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
      now: () => 100,
    });
    await host.start();
    const first = {
      schemaVersion: 1 as const, offerId: 'offer-1', managementRunId: 'run-1', workerId: 'worker-1', offerExpiresAt: 1_000,
    };
    const second = { ...first, offerId: 'offer-2', managementRunId: 'run-2' };

    expect(handlers()!.reserveLeaseOffer(first)).toBe(true);
    expect(handlers()!.reserveLeaseOffer(second)).toBe(false);
  });

  test('从 authoritative DAG checkpoint 恢复 Phase 2 exact tools，重连后继续同一 Run 而不重建 DAG', async () => {
    const { protocol, handlers } = createProtocolHarness();
    vi.mocked(protocol.fetchCheckpoint).mockResolvedValue({
      schemaVersion: 1, managementRunId: 'run-1', workerId: 'worker-1',
      context: { schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1',
        rootMessageId: 'message-1', rootTaskId: 'root-task',
        frozenTarget: { agentId: 'agent-1', kind: 'custom' },
        visibleThread: { revision: 1, messages: [{ id: 'message-1', senderKind: 'human',
          senderId: 'user-1', body: '继续 DAG', createdAt: 1 }] } },
      checkpoint: { schemaVersion: 1, managementRunId: 'run-1', revision: 3,
        authoritative: { lastEventSequence: 8, taskGraphRevision: 2,
          openTaskIds: ['root-task', 'child-task'], waitingInvocationIds: [],
          completedInvocationIds: [], memoryCapsuleIds: [], activeClaimLeaseIds: ['claim-1'],
          taskSnapshots: [
            { taskId: 'child-task', taskRevision: 2, taskAttempt: 1, status: 'in_progress', claimLeaseId: 'claim-1' },
            { taskId: 'root-task', taskRevision: 1, taskAttempt: 1, status: 'todo' },
          ] },
        contextHints: { objective: '继续 DAG', planSummary: 'child active',
          completedInvocationSummaries: [], unresolvedQuestions: [] }, updatedAt: 100 },
    });
    vi.mocked(protocol.executeTool).mockImplementation(async (request) => ({
      schemaVersion: 2, managementPhase: 2, commandId: request.commandId,
      managementRunId: request.managementRunId, workerId: request.workerId,
      toolCallId: request.toolCallId, toolName: 'tasks.wait', ok: true,
      output: { readyTaskIds: [], waitingTaskIds: ['child-task'] },
    }));
    let executeTool: Parameters<Parameters<typeof createPiManagerWorkerHost>[0]['createRuntimeFactory']>[0]['toolExecutor'] | undefined;
    const sessions: ManagementSession[] = [];
    const runtimeFactory: ManagementRuntimeFactory = { createSession: vi.fn(async () => {
      const session: ManagementSession = { prompt: vi.fn(() => new Promise<void>(() => undefined)),
        steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(), abort: vi.fn(), waitForIdle: vi.fn(),
        subscribe: vi.fn(() => () => undefined), dispose: vi.fn() };
      sessions.push(session);
      return session;
    }) };
    const host = createPiManagerWorkerHost({ profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'production_ready',
        providerId: 'provider-1', modelId: 'model-1', apiKey: 'secret', baseUrl: 'https://model.invalid' }) },
      createRuntimeFactory: (input) => { executeTool = input.toolExecutor; return runtimeFactory; },
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
      now: () => 100 });
    await host.start();
    const offer = { schemaVersion: 1 as const, offerId: 'offer-1', managementRunId: 'run-1',
      workerId: 'worker-1', offerExpiresAt: 1_000 };
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    await handlers()!.onLeaseOffer(offer);
    expect(runtimeFactory.createSession).toHaveBeenLastCalledWith(expect.objectContaining({
      context: expect.objectContaining({ schemaVersion: 2, managementPhase: 2,
        scope: expect.objectContaining({ rootTaskId: 'root-task' }) }),
    }));
    await expect(executeTool!({ toolCallId: 'wait-1', name: 'tasks.wait',
      scope: { kind: 'managed', managementRunId: 'run-1', teamId: 'team-1', channelId: 'channel-1',
        rootMessageId: 'message-1', rootTaskId: 'root-task' }, input: { taskIds: ['child-task'] },
      metadata: { name: 'tasks.wait', effect: 'read', phase: 2, inputSchemaVersion: 1 } }))
      .resolves.toEqual({ text: JSON.stringify({ readyTaskIds: [], waitingTaskIds: ['child-task'] }) });
    expect(protocol.executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      schemaVersion: 2, managementPhase: 2, toolName: 'tasks.wait', leaseToken: 'raw-lease-token',
    }));

    await handlers()!.onDisconnect();
    await handlers()!.onReconnect?.('worker-1');
    const resumedOffer = { ...offer, offerId: 'offer-2' };
    expect(handlers()!.reserveLeaseOffer(resumedOffer)).toBe(true);
    await handlers()!.onLeaseOffer(resumedOffer);
    expect(runtimeFactory.createSession).toHaveBeenCalledTimes(2);
    expect(protocol.executeTool).not.toHaveBeenCalledWith(expect.objectContaining({ toolName: 'tasks.create_subtasks' }));
    expect(sessions).toHaveLength(2);
  });
});
