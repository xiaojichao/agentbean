import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS, type TaskClaimOfferV1 } from '../../../packages/contracts/src/index.js';
import {
  createTaskClaimProtocol,
  type ManagementWorkerProtocolSocket,
} from '../src/management-worker-protocol.js';

function createSocketHarness(respondAck?: unknown) {
  const handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void>>();
  let reconnect: (() => Promise<void>) | undefined;
  let disconnect: (() => Promise<void>) | undefined;
  const emitWithAck = vi.fn(async (event: string) => {
    if (event === AGENT_EVENTS.taskClaim.acquire) {
      return {
        schemaVersion: 1, ok: true,
        lease: { schemaVersion: 1, claimLeaseId: 'lease-1', taskId: 'task-1', taskRevision: 1,
          taskAttempt: 1, agentId: 'agent-1', leaseToken: 'raw-token', fencingToken: 1,
          acquiredAt: 10, expiresAt: 110 },
        execution: { schemaVersion: 1, managementRunId: 'run-1', taskId: 'task-1', taskRevision: 1,
          taskAttempt: 1, title: 'Task', objective: 'Objective', acceptanceCriteria: [],
          dependencyTaskIds: [] },
      };
    }
    if (event === AGENT_EVENTS.taskClaim.respond) {
      return respondAck ?? {
        kind: 'claim_granted',
        lease: { schemaVersion: 1, claimLeaseId: 'lease-1', taskId: 'task-1', taskRevision: 1,
          taskAttempt: 1, agentId: 'agent-1', leaseToken: 'raw-token', fencingToken: 1,
          acquiredAt: 10, expiresAt: 110 },
        execution: { schemaVersion: 1, managementRunId: 'run-1', taskId: 'task-1', taskRevision: 1,
          taskAttempt: 1, title: 'Task', objective: 'Objective', acceptanceCriteria: [],
          dependencyTaskIds: [] },
      };
    }
    if (event === AGENT_EVENTS.taskClaim.renew) return { schemaVersion: 1, ok: true, expiresAt: 210 };
    return { schemaVersion: 1, ok: true, releasedAt: 100 };
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

describe('task claim protocol', () => {
  test('offer ACK 仅可响应；accepted 经 respondToOffer 交付 authority（新路径，不再 auto-acquire，AC#3/AC#7）', async () => {
    const harness = createSocketHarness(); // respond → claim_granted
    const onClaimed = vi.fn(async () => undefined);
    const protocol = createTaskClaimProtocol({ socket: harness.socket });
    // 未提供 decideOfferResponse → 默认 accepted（过渡默认）。
    await protocol.start({ deviceId: 'device-1' }, { onClaimed });
    const ack = vi.fn();
    await harness.handlers.get(AGENT_EVENTS.taskClaim.offer)?.(offer(), ack);

    expect(ack).toHaveBeenCalledWith({ schemaVersion: 1, ok: true });
    expect(harness.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.respond, {
      schemaVersion: 1, offerId: 'offer-1', agentId: 'agent-1', kind: 'accepted',
    });
    // AC#7：不再无条件 auto-acquire（新路径走 respond）。
    expect(harness.emitWithAck).not.toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.acquire, expect.anything());
    expect(onClaimed).toHaveBeenCalledWith(expect.objectContaining({
      ok: true, lease: expect.objectContaining({ leaseToken: 'raw-token' }),
    }));
    expect(harness.emitWithAck.mock.calls.some(([event]) => event === AGENT_EVENTS.dispatch.accepted)).toBe(false);
  });

  test('legacy offer 无持久化（respond→OFFER_INVALID）时回退旧 acquire（C-2b-ii 兼容路径）', async () => {
    const harness = createSocketHarness({
      kind: 'not_accepted', reason: 'offer_invalid', diagnosticCode: 'TASK_CLAIM_OFFER_INVALID',
    });
    const onClaimed = vi.fn(async () => undefined);
    const protocol = createTaskClaimProtocol({ socket: harness.socket });
    await protocol.start({ deviceId: 'device-1' }, { onClaimed });
    const ack = vi.fn();
    await harness.handlers.get(AGENT_EVENTS.taskClaim.offer)?.(offer(), ack);

    expect(ack).toHaveBeenCalledWith({ schemaVersion: 1, ok: true });
    expect(harness.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.respond, expect.objectContaining({ kind: 'accepted' }));
    // 回退旧 acquire → claim_granted
    expect(harness.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.acquire, {
      schemaVersion: 1, offerId: 'offer-1', agentId: 'agent-1',
    });
    expect(onClaimed).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  test('decideOfferResponse 返回 rejected → 发 rejected 响应，不 claim、不回退 acquire（AC#5）', async () => {
    const harness = createSocketHarness();
    const onClaimed = vi.fn(async () => undefined);
    const protocol = createTaskClaimProtocol({ socket: harness.socket });
    await protocol.start({ deviceId: 'device-1' }, {
      decideOfferResponse: () => ({ kind: 'rejected', detail: 'busy' }), onClaimed,
    });
    const ack = vi.fn();
    await harness.handlers.get(AGENT_EVENTS.taskClaim.offer)?.(offer(), ack);

    expect(ack).toHaveBeenCalledWith({ schemaVersion: 1, ok: true });
    expect(harness.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.respond, {
      schemaVersion: 1, offerId: 'offer-1', agentId: 'agent-1', kind: 'rejected', detail: 'busy',
    });
    expect(harness.emitWithAck).not.toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.acquire, expect.anything());
    expect(onClaimed).not.toHaveBeenCalled();
  });

  test('错误 device 时 fail closed，断线/重连/过期可观测', async () => {
    const harness = createSocketHarness();
    const onDisconnect = vi.fn(async () => undefined);
    const onReconnect = vi.fn(async () => undefined);
    const onExpired = vi.fn(async () => undefined);
    const protocol = createTaskClaimProtocol({ socket: harness.socket });
    await protocol.start({ deviceId: 'device-1' }, {
      onClaimed: vi.fn(), onDisconnect, onReconnect, onExpired,
    });
    const ack = vi.fn();
    await harness.handlers.get(AGENT_EVENTS.taskClaim.offer)?.({ ...offer(), deviceId: 'device-2' }, ack);
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false,
      diagnosticCode: 'TASK_CLAIM_AGENT_NOT_READY' }));
    expect(harness.emitWithAck).not.toHaveBeenCalled();

    await harness.handlers.get(AGENT_EVENTS.taskClaim.expired)?.({ schemaVersion: 1,
      claimLeaseId: 'lease-1', taskId: 'task-1', agentId: 'agent-1', expiredAt: 110 });
    await harness.disconnect()?.();
    await harness.reconnect()?.();
    expect(onExpired).toHaveBeenCalledOnce();
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  test('renew/release 使用同一 claim authority', async () => {
    const harness = createSocketHarness();
    const protocol = createTaskClaimProtocol({ socket: harness.socket });
    const authority = { schemaVersion: 1 as const, claimLeaseId: 'lease-1', taskId: 'task-1',
      taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', leaseToken: 'raw-token', fencingToken: 1 };
    await expect(protocol.renew(authority)).resolves.toEqual({ schemaVersion: 1, ok: true, expiresAt: 210 });
    await expect(protocol.release({ ...authority, reasonCode: 'COMPLETED' })).resolves.toEqual({
      schemaVersion: 1, ok: true, releasedAt: 100,
    });
  });
});

function offer(): TaskClaimOfferV1 {
  return { schemaVersion: 1, offerId: 'offer-1', deviceId: 'device-1', taskId: 'task-1',
    taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', requiredCapabilities: [], offerExpiresAt: 100 };
}
