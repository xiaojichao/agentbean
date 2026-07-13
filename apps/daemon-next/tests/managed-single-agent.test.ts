import { describe, expect, test, vi } from 'vitest';
import type { ManagementRuntimeFactory, ManagementSession, ManagementToolExecutor } from '@agentbean/pi-management-runtime';
import { createPiManagerWorkerHost } from '../src/pi-manager-worker-host';
import type { PiManagerWorkerProtocol, PiManagerWorkerProtocolHandlers } from '../src/management-worker-protocol';

describe('Phase 1 managed 单 Agent daemon 垂直链路', () => {
  test('PI 调用 agents.invoke 后，prompt 完成会释放 lease 且不 abort 已完成 session', async () => {
    let handlers: PiManagerWorkerProtocolHandlers | undefined;
    const protocol: PiManagerWorkerProtocol = {
      start: vi.fn(async (_capability, nextHandlers) => {
        handlers = nextHandlers;
        return { workerId: 'worker-1' };
      }),
      stop: vi.fn(),
      acquireLease: vi.fn(async () => ({
        schemaVersion: 1, ok: true, managementRunId: 'run-1', workerId: 'worker-1',
        leaseToken: 'lease-token', fencingToken: 1, acquiredAt: 10, expiresAt: 10_000,
      })),
      renewLease: vi.fn(),
      releaseLease: vi.fn(async (input) => ({
        schemaVersion: 1, ok: true, managementRunId: input.managementRunId,
        workerId: input.workerId, fencingToken: input.fencingToken, releasedAt: 20,
      })),
      abortLease: vi.fn(),
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
            messages: [{ id: 'message-1', senderKind: 'human', senderId: 'user-1', body: '执行目标', createdAt: 1 }],
          },
        },
      })),
      executeTool: vi.fn(async (request) => ({
        schemaVersion: 1,
        commandId: request.commandId,
        managementRunId: request.managementRunId,
        workerId: request.workerId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        ok: true,
        output: { invocationId: 'invocation-1', status: 'succeeded' },
      } as Awaited<ReturnType<PiManagerWorkerProtocol['executeTool']>>)),
      replayOutbox: vi.fn(),
    };
    let executeTool: ManagementToolExecutor | undefined;
    const session: ManagementSession = {
      prompt: vi.fn(async () => {
        const result = await executeTool!({
          toolCallId: 'tool-1',
          name: 'agents.invoke',
          scope: { kind: 'managed', managementRunId: 'run-1', teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1' },
          input: { objective: '执行目标', attachmentIds: [] },
          metadata: { name: 'agents.invoke', effect: 'write', phase: 1, inputSchemaVersion: 1 },
        });
        expect(result.isError).not.toBe(true);
      }),
      steer: vi.fn(), followUp: vi.fn(), compact: vi.fn(), abort: vi.fn(), waitForIdle: vi.fn(),
      subscribe: vi.fn(() => () => undefined), dispose: vi.fn(async () => undefined),
    };
    const runtimeFactory: ManagementRuntimeFactory = { createSession: vi.fn(async () => session) };
    const host = createPiManagerWorkerHost({
      profileId: 'profile-1', runtimeVersion: '0.1.0', protocol,
      credentialProvider: { resolve: async () => ({
        credentialStatus: 'production_ready', providerId: 'provider-1', modelId: 'model-1', apiKey: 'secret',
      }) },
      createRuntimeFactory: (input) => {
        executeTool = input.toolExecutor;
        return runtimeFactory;
      },
      outbox: { enqueue: vi.fn(), remove: vi.fn(), list: vi.fn(() => []), size: vi.fn(() => 0) },
      now: () => 100,
    });

    await host.start();
    const offer = { schemaVersion: 1, offerId: 'offer-1', managementRunId: 'run-1', workerId: 'worker-1', offerExpiresAt: 1_000 } as const;
    expect(handlers!.reserveLeaseOffer(offer)).toBe(true);
    await handlers!.onLeaseOffer(offer);
    await vi.waitFor(() => expect(host.activeLeaseCount()).toBe(0));

    expect(protocol.executeTool).toHaveBeenCalledTimes(1);
    expect(protocol.releaseLease).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'session-completed' }));
    expect(protocol.abortLease).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(session.dispose).toHaveBeenCalledTimes(1);
  });
});
