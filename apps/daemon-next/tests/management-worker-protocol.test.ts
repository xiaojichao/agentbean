import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import {
  createManagementWorkerProtocol,
  type ManagementWorkerProtocolSocket,
} from '../src/management-worker-protocol';

function createSocketHarness() {
  const handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void>>();
  let reconnect: (() => Promise<void>) | undefined;
  let disconnect: (() => Promise<void>) | undefined;
  const emitWithAck = vi.fn(async (event: string) => {
    if (event === AGENT_EVENTS.managementWorker.register) {
      return { schemaVersion: 1, ok: true, workerId: 'worker-1', protocolVersion: 1 };
    }
    return { schemaVersion: 1, ok: false, errorCode: 'UNAVAILABLE', retryable: true };
  });
  const socket: ManagementWorkerProtocolSocket = {
    connected: true,
    emitWithAck,
    on: (event, handler) => { handlers.set(event, handler); },
    off: (event) => { handlers.delete(event); },
    onReconnect: (handler) => { reconnect = handler; },
    onDisconnect: (handler) => { disconnect = handler; },
  };
  return { socket, emitWithAck, handlers, reconnect: () => reconnect, disconnect: () => disconnect };
}

describe('management worker protocol', () => {
  test('注册只发送 capability，不发送模型 secret', async () => {
    const harness = createSocketHarness();
    const protocol = createManagementWorkerProtocol({
      socket: harness.socket,
      workerInstanceId: 'instance-1',
      profileId: 'profile-1',
      runtimeVersion: '0.1.0',
    });

    await protocol.start({
      credentialStatus: 'production_ready',
      providerId: 'provider-1',
      modelId: 'model-1',
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }, {
      reserveLeaseOffer: () => true,
      onLeaseOffer: vi.fn(),
      onDisconnect: vi.fn(),
    });

    const registerPayload = harness.emitWithAck.mock.calls[0]?.[1];
    expect(registerPayload).toMatchObject({
      schemaVersion: 2,
      workerInstanceId: 'instance-1',
      profileId: 'profile-1',
      supportedProtocolVersions: [1, 2],
      supportedPhases: [1, 2],
      credentialStatus: 'production_ready',
      providerId: 'provider-1',
      modelId: 'model-1',
    });
    expect(JSON.stringify(registerPayload)).not.toMatch(/apiKey|secret|leaseToken/);
  });

  test('offer 先 ACK 接收，再异步进入 WorkerHost；断线与重连重新注册可测', async () => {
    const harness = createSocketHarness();
    const onLeaseOffer = vi.fn(async () => undefined);
    const onDisconnect = vi.fn(async () => undefined);
    const onReconnect = vi.fn(async () => undefined);
    const protocol = createManagementWorkerProtocol({
      socket: harness.socket,
      workerInstanceId: 'instance-1', profileId: 'profile-1', runtimeVersion: '0.1.0',
    });
    await protocol.start({
      credentialStatus: 'test_only', providerId: 'provider-1', modelId: 'model-1',
      capacity: { maxConcurrentLeases: 1, activeLeaseCount: 0 },
    }, { reserveLeaseOffer: () => true, onLeaseOffer, onDisconnect, onReconnect });

    const ack = vi.fn();
    await harness.handlers.get(AGENT_EVENTS.managementWorker.leaseOffer)?.({
      schemaVersion: 1, offerId: 'offer-1', managementRunId: 'run-1', workerId: 'worker-1', offerExpiresAt: 100,
    }, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
    expect(onLeaseOffer).toHaveBeenCalledTimes(1);

    await harness.disconnect()?.();
    await harness.reconnect()?.();
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(harness.emitWithAck).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledWith('worker-1');
  });

  test('Phase 2 Task request 使用 V2 result parser，拒绝错误 phase 回包', async () => {
    const harness = createSocketHarness();
    harness.emitWithAck.mockImplementation(async (event, payload) => {
      if (event === AGENT_EVENTS.managementWorker.toolRequest) {
        const request = payload as { commandId: string; managementRunId: string; workerId: string; toolCallId: string };
        return { schemaVersion: 2, managementPhase: 2,
          commandId: request.commandId, managementRunId: request.managementRunId,
          workerId: request.workerId, toolCallId: request.toolCallId,
          toolName: 'tasks.wait', ok: true,
          output: { readyTaskIds: ['task-1'], waitingTaskIds: [], taskSnapshots: [
            { taskId: 'task-1', taskRevision: 1, taskAttempt: 1, status: 'done' },
          ] } };
      }
      return { schemaVersion: 1, ok: true, workerId: 'worker-1', protocolVersion: 1 };
    });
    const protocol = createManagementWorkerProtocol({ socket: harness.socket,
      workerInstanceId: 'instance-1', profileId: 'profile-1', runtimeVersion: '0.1.0' });
    const result = await protocol.executeTool({ schemaVersion: 2, managementPhase: 2,
      commandId: 'command-1', managementRunId: 'run-1', workerId: 'worker-1',
      toolCallId: 'call-1', toolName: 'tasks.wait', leaseToken: 'token', fencingToken: 1,
      idempotencyKey: 'wait-1', input: { taskIds: ['task-1'] } });
    expect(result).toMatchObject({ schemaVersion: 2, managementPhase: 2, ok: true,
      output: { readyTaskIds: ['task-1'] } });
  });
});
