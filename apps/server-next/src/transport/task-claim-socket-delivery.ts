import {
  AGENT_EVENTS,
  type TaskClaimExpiredV1,
} from '../../../../packages/contracts/src/index.js';
import type { TaskClaimBroker } from '../application/management/task-claim-broker.js';
import type { SocketLike } from './socket-handlers.js';

const DEFAULT_TASK_CLAIM_OFFER_TIMEOUT_MS = 5_000;

export interface TaskClaimOfferOptions {
  readonly allowedAgentIds?: readonly string[];
  readonly projectStageAuto?: boolean;
}

export interface TaskClaimSocketDeliveryPort extends Pick<
  TaskClaimBroker,
  'prepareOffers' | 'expireClaims' | 'resolveCandidates'
> {}

export interface TaskClaimSocketDelivery {
  offerTaskClaims(
    taskId: string,
    options?: TaskClaimOfferOptions,
  ): Promise<{ taskId: string; offered: number; accepted: number }>;
  expireTaskClaims(): Promise<readonly TaskClaimExpiredV1[]>;
}

export interface TaskClaimSocketDeliveryOptions {
  readonly offerTimeoutMs?: number;
}

/**
 * Task Offer 与 Claim expiry 的唯一 Agent Socket delivery owner。
 *
 * Broker 负责权威 eligibility/Offer/Claim 事实；本 module 只负责把已准备事实
 * 定向交给当前在线 Device Socket，并解释 transport ACK/timeout。
 */
export function createTaskClaimSocketDelivery(
  port: TaskClaimSocketDeliveryPort | undefined,
  resolveAgentSocket: (deviceId: string) => SocketLike | undefined,
  options: TaskClaimSocketDeliveryOptions = {},
): TaskClaimSocketDelivery {
  const offerTimeoutMs = options.offerTimeoutMs ?? DEFAULT_TASK_CLAIM_OFFER_TIMEOUT_MS;

  return {
    async offerTaskClaims(taskId, offerOptions) {
      if (!port) return { taskId, offered: 0, accepted: 0 };

      const offers = await port.prepareOffers(taskId, offerOptions);
      const acknowledgements = await Promise.all(offers.map(async (offer) => {
        const socket = resolveAgentSocket(offer.deviceId);
        const ackSocket = socket?.timeout?.(offerTimeoutMs) ?? socket;
        if (!ackSocket?.emitWithAck) return 0;
        try {
          const ack = await ackSocket.emitWithAck(AGENT_EVENTS.taskClaim.offer, offer);
          return isPositiveAck(ack) ? 1 : 0;
        } catch {
          // Offer timeout only rejects this candidate; no execution has started.
          return 0;
        }
      }));
      return {
        taskId,
        offered: offers.length,
        accepted: acknowledgements.reduce<number>((total, accepted) => total + accepted, 0),
      };
    },

    async expireTaskClaims() {
      if (!port) return [];

      const expired = await port.expireClaims();
      for (const notice of expired) {
        const resolution = await port.resolveCandidates(notice.taskId);
        const deviceId = resolution.candidates
          .find((candidate) => candidate.agentId === notice.agentId)?.deviceId;
        if (deviceId) {
          resolveAgentSocket(deviceId)?.emit?.(AGENT_EVENTS.taskClaim.expired, notice);
        }
      }
      return expired;
    },
  };
}

function isPositiveAck(ack: unknown): boolean {
  return Boolean(ack && typeof ack === 'object' && (ack as { ok?: unknown }).ok === true);
}
