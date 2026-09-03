import { describe, expect, test, vi } from 'vitest';
import {
  AGENT_EVENTS,
  type TaskClaimExpiredV1,
  type TaskClaimOfferV1,
} from '../../../packages/contracts/src/index';
import type { SocketLike } from '../src/transport/socket-handlers';
import {
  createTaskClaimSocketDelivery,
  type TaskClaimSocketDeliveryPort,
} from '../src/transport/task-claim-socket-delivery';

describe('Task claim socket delivery', () => {
  test('delivers prepared Offers to online Device sockets and counts only positive ACKs', async () => {
    const offers = [
      taskOffer('offer-1', 'agent-1', 'device-1'),
      taskOffer('offer-2', 'agent-2', 'device-2'),
      taskOffer('offer-3', 'agent-3', 'device-3'),
      taskOffer('offer-4', 'agent-4', 'device-offline'),
    ];
    const port = taskClaimPort({ prepareOffers: vi.fn(async () => offers) });
    const accepted = agentSocket({ ok: true });
    const rejected = agentSocket({ ok: false });
    const timedOut = agentSocket(new Error('timeout'));
    const sockets = new Map<string, SocketLike>([
      ['device-1', accepted.socket],
      ['device-2', rejected.socket],
      ['device-3', timedOut.socket],
    ]);
    const delivery = createTaskClaimSocketDelivery(
      port,
      (deviceId) => sockets.get(deviceId),
      { offerTimeoutMs: 321 },
    );

    await expect(delivery.offerTaskClaims('task-1', {
      allowedAgentIds: ['agent-1', 'agent-2'],
      projectStageAuto: true,
    })).resolves.toEqual({ taskId: 'task-1', offered: 4, accepted: 1 });

    expect(port.prepareOffers).toHaveBeenCalledWith('task-1', {
      allowedAgentIds: ['agent-1', 'agent-2'],
      projectStageAuto: true,
    });
    expect(accepted.timeout).toHaveBeenCalledWith(321);
    expect(accepted.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.offer, offers[0]);
    expect(rejected.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.offer, offers[1]);
    expect(timedOut.emitWithAck).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.offer, offers[2]);
  });

  test('revalidates the current Agent Device for each expired Claim notice', async () => {
    const expired = [
      taskClaimExpired('lease-1', 'task-1', 'agent-1'),
      taskClaimExpired('lease-2', 'task-1', 'agent-2'),
      taskClaimExpired('lease-3', 'task-2', 'agent-missing'),
    ];
    const resolveCandidates = vi.fn(async (taskId: string) => ({
      taskId,
      taskRevision: 1,
      taskAttempt: 1,
      ancestorAgentIds: [],
      candidates: taskId === 'task-1'
        ? [
            { agentId: 'agent-1', deviceId: 'device-1', eligible: true, diagnosticCodes: [], missingCapabilities: [] },
            { agentId: 'agent-2', deviceId: 'device-2', eligible: true, diagnosticCodes: [], missingCapabilities: [] },
          ]
        : [],
    }));
    const port = taskClaimPort({
      expireClaims: vi.fn(async () => expired),
      resolveCandidates,
    });
    const first = agentSocket({ ok: true });
    const second = agentSocket({ ok: true });
    const sockets = new Map<string, SocketLike>([
      ['device-1', first.socket],
      ['device-2', second.socket],
    ]);
    const delivery = createTaskClaimSocketDelivery(port, (deviceId) => sockets.get(deviceId));

    await expect(delivery.expireTaskClaims()).resolves.toEqual(expired);

    expect(resolveCandidates).toHaveBeenCalledTimes(3);
    expect(resolveCandidates).toHaveBeenNthCalledWith(1, 'task-1');
    expect(resolveCandidates).toHaveBeenNthCalledWith(2, 'task-1');
    expect(resolveCandidates).toHaveBeenNthCalledWith(3, 'task-2');
    expect(first.emit).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.expired, expired[0]);
    expect(second.emit).toHaveBeenCalledWith(AGENT_EVENTS.taskClaim.expired, expired[1]);
  });

  test('keeps Task Claim delivery optional when no Broker is configured', async () => {
    const resolveAgentSocket = vi.fn();
    const delivery = createTaskClaimSocketDelivery(undefined, resolveAgentSocket);

    await expect(delivery.offerTaskClaims('task-1')).resolves.toEqual({
      taskId: 'task-1',
      offered: 0,
      accepted: 0,
    });
    await expect(delivery.expireTaskClaims()).resolves.toEqual([]);
    expect(resolveAgentSocket).not.toHaveBeenCalled();
  });
});

function taskClaimPort(
  overrides: Partial<TaskClaimSocketDeliveryPort> = {},
): TaskClaimSocketDeliveryPort {
  return {
    prepareOffers: async () => [],
    expireClaims: async () => [],
    resolveCandidates: async (taskId) => ({
      taskId,
      taskRevision: 1,
      taskAttempt: 1,
      ancestorAgentIds: [],
      candidates: [],
    }),
    ...overrides,
  };
}

function taskOffer(offerId: string, agentId: string, deviceId: string): TaskClaimOfferV1 {
  return {
    schemaVersion: 1,
    offerId,
    deviceId,
    taskId: 'task-1',
    taskRevision: 1,
    taskAttempt: 1,
    agentId,
    requiredCapabilities: ['code-review'],
    offerExpiresAt: 1_000,
  };
}

function taskClaimExpired(
  claimLeaseId: string,
  taskId: string,
  agentId: string,
): TaskClaimExpiredV1 {
  return {
    schemaVersion: 1,
    claimLeaseId,
    taskId,
    agentId,
    expiredAt: 1_000,
  };
}

function agentSocket(ack: unknown) {
  const emit = vi.fn();
  const emitWithAck = ack instanceof Error
    ? vi.fn().mockRejectedValue(ack)
    : vi.fn().mockResolvedValue(ack);
  const timeout = vi.fn(() => ({ emitWithAck }));
  const socket: SocketLike = { on: vi.fn(), emit, timeout };
  return { socket, emit, emitWithAck, timeout };
}
