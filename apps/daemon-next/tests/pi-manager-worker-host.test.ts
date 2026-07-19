import { describe, expect, test, vi } from 'vitest';
import type { ManagementRuntimeFactory, ManagementSession } from '@agentbean/pi-management-runtime';
import { checkpointManagementPhase, createPiManagerWorkerHost } from '../src/pi-manager-worker-host';
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
  test('旧 V2 checkpoint 通过 rootTaskId 且省略 frozenTarget 恢复 Phase 2', async () => {
    const baseline = await createProtocolHarness().protocol.fetchCheckpoint({
      schemaVersion: 1, managementRunId: 'run-1', workerId: 'worker-1',
      leaseToken: 'raw-lease-token', fencingToken: 1,
    });
    expect(checkpointManagementPhase({ ...baseline, context: {
      ...baseline.context, rootTaskId: 'root-task', frozenTarget: undefined,
    } })).toBe(2);
    expect(checkpointManagementPhase(baseline)).toBe(1);
  });

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

  test('beginDrain 拒绝新 offer 并等待活动 lease 自然完成，不 abort session', async () => {
    const { protocol, handlers } = createProtocolHarness();
    let finishPrompt: (() => void) | undefined;
    const session: ManagementSession = {
      prompt: vi.fn(() => new Promise<void>((resolve) => { finishPrompt = resolve; })),
      steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(), abort: vi.fn(), waitForIdle: vi.fn(),
      subscribe: vi.fn(() => () => undefined), dispose: vi.fn(),
    };
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({
        credentialStatus: 'production_ready', providerId: 'provider-1', modelId: 'model-1',
        apiKey: 'secret', baseUrl: 'https://model.invalid',
      }) },
      createRuntimeFactory: () => ({ createSession: vi.fn(async () => session) }),
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
      now: () => 100,
    });
    await host.start();
    const offer = {
      schemaVersion: 1 as const, offerId: 'offer-1', managementRunId: 'run-1',
      workerId: 'worker-1', offerExpiresAt: 1_000,
    };
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    await handlers()!.onLeaseOffer(offer);
    expect(host.activeLeaseCount()).toBe(1);

    const draining = host.beginDrain(1000);
    expect(handlers()!.reserveLeaseOffer({ ...offer, offerId: 'offer-2', managementRunId: 'run-2' })).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
    finishPrompt?.();
    await draining;

    expect(session.abort).not.toHaveBeenCalled();
    expect(host.activeLeaseCount()).toBe(0);
  });

  test('beginDrain waits for an accepted offer ACK and aborts the acquired lease instead of starting it', async () => {
    const { protocol, handlers } = createProtocolHarness();
    let resolveAcquire: ((value: Awaited<ReturnType<PiManagerWorkerProtocol['acquireLease']>>) => void) | undefined;
    vi.mocked(protocol.acquireLease).mockImplementation(() => new Promise((resolve) => { resolveAcquire = resolve; }));
    const createSession = vi.fn();
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'production_ready',
        providerId: 'provider-1', modelId: 'model-1', apiKey: 'secret', baseUrl: 'https://model.invalid' }) },
      createRuntimeFactory: () => ({ createSession }),
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
      now: () => 100,
    });
    await host.start();
    const offer = { schemaVersion: 1 as const, offerId: 'offer-1', managementRunId: 'run-1',
      workerId: 'worker-1', offerExpiresAt: 1_000 };
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    const accepting = handlers()!.onLeaseOffer(offer);
    const draining = host.beginDrain(1_000);
    expect(host.activeLeaseCount()).toBe(1);

    resolveAcquire?.({ schemaVersion: 1, ok: true, managementRunId: 'run-1', workerId: 'worker-1',
      leaseToken: 'lease-token', fencingToken: 1, acquiredAt: 100, expiresAt: 10_000 });
    await Promise.all([accepting, draining]);

    expect(createSession).not.toHaveBeenCalled();
    expect(protocol.abortLease).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'worker-draining' }));
    expect(host.activeLeaseCount()).toBe(0);
  });

  test('stop cancels a drain loop that is waiting on a durable outbox', async () => {
    const { protocol } = createProtocolHarness();
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'unavailable' }) },
      createRuntimeFactory: vi.fn(),
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 1) },
    });
    await host.start();
    const draining = host.beginDrain(60_000);
    await host.stop();
    await expect(draining).resolves.toBeUndefined();
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

  test('存在未解析 Memory outbox 时阻止恢复新 Session', async () => {
    const { protocol, handlers } = createProtocolHarness();
    vi.mocked(protocol.replayOutbox).mockRejectedValue(new Error('ack timeout'));
    const runtimeFactory: ManagementRuntimeFactory = { createSession: vi.fn() };
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'production_ready',
        providerId: 'provider-1', modelId: 'model-1', apiKey: 'secret', baseUrl: 'https://model.invalid' }) },
      createRuntimeFactory: () => runtimeFactory,
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => [{
        schemaVersion: 1 as const, managementRunId: 'run-1', commandId: 'memory-command',
        idempotencyKey: 'memory-key', requestHash: 'memory-hash',
        toolName: 'memory.create_capsule' as const, createdAt: 1,
      }]), size: vi.fn(() => 1) },
      now: () => 100,
    });
    await host.start();
    const offer = { schemaVersion: 1 as const, offerId: 'offer-1', managementRunId: 'run-1',
      workerId: 'worker-1', offerExpiresAt: 1_000 };
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    await handlers()!.onLeaseOffer(offer);

    expect(runtimeFactory.createSession).not.toHaveBeenCalled();
    expect(protocol.abortLease).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'session-start-failed',
    }));
    expect(host.activeLeaseCount()).toBe(0);
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

  test('Phase 1 checkpoint 遇到非零 Task graph revision 时 fail-closed', async () => {
    const { protocol, handlers } = createProtocolHarness();
    const baseline = await createProtocolHarness().protocol.fetchCheckpoint({
      schemaVersion: 1, managementRunId: 'run-1', workerId: 'worker-1',
      leaseToken: 'raw-lease-token', fencingToken: 1,
    });
    if (!baseline.checkpoint) throw new Error('TEST_CHECKPOINT_REQUIRED');
    vi.mocked(protocol.fetchCheckpoint).mockResolvedValue({
      ...baseline,
      checkpoint: {
        ...baseline.checkpoint,
        authoritative: { ...baseline.checkpoint.authoritative, taskGraphRevision: 1 },
      },
    });
    const runtimeFactory: ManagementRuntimeFactory = { createSession: vi.fn() };
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'production_ready',
        providerId: 'provider-1', modelId: 'model-1', apiKey: 'secret', baseUrl: 'https://model.invalid' }) },
      createRuntimeFactory: () => runtimeFactory,
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
      now: () => 100,
    });
    await host.start();
    const offer = { schemaVersion: 1 as const, offerId: 'offer-1', managementRunId: 'run-1',
      workerId: 'worker-1', offerExpiresAt: 1_000 };
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    await handlers()!.onLeaseOffer(offer);

    expect(runtimeFactory.createSession).not.toHaveBeenCalled();
    expect(protocol.abortLease).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'session-start-failed',
    }));
    expect(host.activeLeaseCount()).toBe(0);
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
      output: { readyTaskIds: [], waitingTaskIds: ['child-task'], taskSnapshots: [
        { taskId: 'child-task', taskRevision: 2, taskAttempt: 1,
          status: 'in_progress', claimLeaseId: 'claim-1', claimedAgentId: 'agent-1' },
      ] },
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
        scope: expect.objectContaining({ rootTaskId: 'root-task' }),
        checkpoint: expect.objectContaining({ taskGraphRevision: 2,
          openTaskIds: ['root-task', 'child-task'], activeClaimLeaseIds: ['claim-1'],
          taskSnapshots: expect.arrayContaining([expect.objectContaining({ taskId: 'child-task',
            taskRevision: 2, taskAttempt: 1, claimLeaseId: 'claim-1' })]) }),
      }),
    }));
    await expect(executeTool!({ toolCallId: 'wait-1', name: 'tasks.wait',
      scope: { kind: 'managed', managementRunId: 'run-1', teamId: 'team-1', channelId: 'channel-1',
        rootMessageId: 'message-1', rootTaskId: 'root-task' }, input: { taskIds: ['child-task'] },
      metadata: { name: 'tasks.wait', effect: 'read', phase: 2, inputSchemaVersion: 1 } }))
      .resolves.toEqual({ text: JSON.stringify({ readyTaskIds: [], waitingTaskIds: ['child-task'],
        taskSnapshots: [{ taskId: 'child-task', taskRevision: 2, taskAttempt: 1,
          status: 'in_progress', claimLeaseId: 'claim-1', claimedAgentId: 'agent-1' }] }) });
    expect(protocol.executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      schemaVersion: 2, managementPhase: 2, toolName: 'tasks.wait', leaseToken: 'raw-lease-token',
    }));

    vi.mocked(protocol.executeTool).mockResolvedValueOnce({
      schemaVersion: 2, managementPhase: 2, commandId: 'run-1:invoke-1',
      managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'invoke-1',
      toolName: 'agents.invoke', ok: true, output: { invocationId: 'invocation-1', status: 'succeeded' },
    });
    await expect(executeTool!({ toolCallId: 'invoke-1', name: 'agents.invoke',
      scope: { kind: 'managed', managementRunId: 'run-1', teamId: 'team-1', channelId: 'channel-1',
        rootMessageId: 'message-1', rootTaskId: 'root-task' },
      input: { taskId: 'child-task', expectedTaskRevision: 2, taskAttempt: 1,
        claimLeaseId: 'claim-1', objective: '执行 child', attachmentIds: [] },
      metadata: { name: 'agents.invoke', effect: 'write', phase: 2, inputSchemaVersion: 1 } }))
      .resolves.toEqual({ text: JSON.stringify({ invocationId: 'invocation-1', status: 'succeeded' }) });
    expect(protocol.executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      schemaVersion: 2, managementPhase: 2, toolName: 'agents.invoke', leaseToken: 'raw-lease-token',
      input: expect.objectContaining({ taskId: 'child-task', claimLeaseId: 'claim-1' }),
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

  test('从显式 Phase 3 checkpoint 恢复 V3 Session 并调用 Memory tool', async () => {
    const { protocol, handlers } = createProtocolHarness();
    const baseline = await protocol.fetchCheckpoint({ schemaVersion: 1, managementRunId: 'run-1',
      workerId: 'worker-1', leaseToken: 'raw-lease-token', fencingToken: 1 });
    vi.mocked(protocol.fetchCheckpoint).mockResolvedValue({
      ...baseline,
      context: { ...baseline.context, managementPhase: 3, rootTaskId: 'root-task' },
      checkpoint: baseline.checkpoint ? { ...baseline.checkpoint,
        authoritative: { ...baseline.checkpoint.authoritative, taskGraphRevision: 1,
          openTaskIds: ['root-task'], memoryCapsuleIds: ['capsule-1'], taskSnapshots: [
            { taskId: 'root-task', taskRevision: 1, taskAttempt: 1, status: 'todo' },
          ] } } : undefined,
    });
    vi.mocked(protocol.executeTool).mockResolvedValue({
      schemaVersion: 2, managementPhase: 3, commandId: 'run-1:search-1',
      managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'search-1',
      toolName: 'memory.search', ok: true, output: { matches: [] },
    });
    let executeTool: Parameters<Parameters<typeof createPiManagerWorkerHost>[0]['createRuntimeFactory']>[0]['toolExecutor'] | undefined;
    const session: ManagementSession = { prompt: vi.fn(() => new Promise<void>(() => undefined)),
      steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(), abort: vi.fn(), waitForIdle: vi.fn(),
      subscribe: vi.fn(() => () => undefined), dispose: vi.fn() };
    const runtimeFactory: ManagementRuntimeFactory = { createSession: vi.fn(async () => session) };
    const outbox = { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) };
    const host = createPiManagerWorkerHost({ profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({ credentialStatus: 'production_ready',
        providerId: 'provider-1', modelId: 'model-1', apiKey: 'secret', baseUrl: 'https://model.invalid' }) },
      createRuntimeFactory: (input) => { executeTool = input.toolExecutor; return runtimeFactory; },
      outbox,
      now: () => 100 });
    await host.start();
    const offer = { schemaVersion: 1 as const, offerId: 'offer-3', managementRunId: 'run-1',
      workerId: 'worker-1', offerExpiresAt: 1_000 };
    expect(handlers()!.reserveLeaseOffer(offer)).toBe(true);
    await handlers()!.onLeaseOffer(offer);
    expect(runtimeFactory.createSession).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ schemaVersion: 2, managementPhase: 3,
        checkpoint: expect.objectContaining({ memoryCapsuleIds: ['capsule-1'] }) }),
    }));

    await expect(executeTool!({ toolCallId: 'search-1', name: 'memory.search',
      scope: { kind: 'managed', managementRunId: 'run-1', teamId: 'team-1', channelId: 'channel-1',
        rootMessageId: 'message-1', rootTaskId: 'root-task' },
      input: { targetAgentId: 'agent-1', query: 'q', limit: 5 },
      metadata: { name: 'memory.search', effect: 'read', phase: 3, inputSchemaVersion: 1 } }))
      .resolves.toEqual({ text: JSON.stringify({ matches: [] }) });
    expect(protocol.executeTool).toHaveBeenLastCalledWith(expect.objectContaining({
      schemaVersion: 2, managementPhase: 3, toolName: 'memory.search',
      idempotencyKey: 'run-1:search-1',
    }));

    vi.mocked(protocol.executeTool).mockResolvedValueOnce({
      schemaVersion: 2, managementPhase: 3, commandId: 'run-1:capsule-1',
      managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'capsule-1',
      toolName: 'memory.create_capsule', ok: false, errorCode: 'CONFLICT',
      diagnosticCode: 'MANAGEMENT_RUN_TERMINAL', retryable: false,
    });
    await expect(executeTool!({ toolCallId: 'capsule-1', name: 'memory.create_capsule',
      scope: { kind: 'managed', managementRunId: 'run-1', teamId: 'team-1', channelId: 'channel-1',
        rootMessageId: 'message-1', rootTaskId: 'root-task' },
      input: { targetAgentId: 'agent-1', prompt: '目标', limit: 3 },
      metadata: { name: 'memory.create_capsule', effect: 'write', phase: 3, inputSchemaVersion: 1 } }))
      .resolves.toEqual({ isError: true, text: JSON.stringify({ error: 'MANAGEMENT_RUN_TERMINAL' }) });
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'memory.create_capsule', idempotencyKey: 'run-1:capsule-1',
    }));
    expect(outbox.remove).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'memory.create_capsule', idempotencyKey: 'run-1:capsule-1',
    }));
  });
});
