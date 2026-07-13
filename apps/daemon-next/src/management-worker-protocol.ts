import type {
  ManagementCheckpointFetchV1,
  ManagementCheckpointResultV1,
  ManagementLeaseAcquireAckV1,
  ManagementLeaseOfferV1,
  ManagementLeaseReleaseAckV1,
  ManagementLeaseReleaseV1,
  ManagementLeaseRenewAckV1,
  ManagementLeaseRenewV1,
  ManagementOutboxReplayAckV1,
  ManagementOutboxReplayV1,
  ManagementWorkerAbortV1,
  ManagementWorkerRegisterV1,
  ManagementWorkerToolRequestV1,
  ManagementWorkerToolResultV1,
} from '../../../packages/contracts/src/index.js';
import { AGENT_EVENTS, parseManagementWorkerPayload, safeParseManagementWorkerPayload } from '../../../packages/contracts/src/index.js';

export interface ManagementWorkerProtocolSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  off?(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  onReconnect?(handler: () => Promise<void>): void;
  onDisconnect?(handler: () => Promise<void>): void;
}

export type ManagementWorkerCapabilityInput = Pick<
  ManagementWorkerRegisterV1,
  'credentialStatus' | 'providerId' | 'modelId' | 'capacity'
>;

export interface PiManagerWorkerProtocolHandlers {
  reserveLeaseOffer(offer: ManagementLeaseOfferV1): boolean;
  onLeaseOffer(offer: ManagementLeaseOfferV1): Promise<void>;
  onDisconnect(): Promise<void>;
  onReconnect?(workerId: string): Promise<void>;
}

export interface PiManagerWorkerProtocol {
  start(capability: ManagementWorkerCapabilityInput, handlers: PiManagerWorkerProtocolHandlers): Promise<{ workerId: string }>;
  stop(): Promise<void> | void;
  acquireLease(offer: ManagementLeaseOfferV1): Promise<ManagementLeaseAcquireAckV1>;
  renewLease(input: ManagementLeaseRenewV1): Promise<ManagementLeaseRenewAckV1>;
  releaseLease(input: ManagementLeaseReleaseV1): Promise<ManagementLeaseReleaseAckV1>;
  abortLease(input: ManagementWorkerAbortV1): Promise<ManagementLeaseReleaseAckV1>;
  fetchCheckpoint(input: ManagementCheckpointFetchV1): Promise<ManagementCheckpointResultV1>;
  executeTool(input: ManagementWorkerToolRequestV1): Promise<ManagementWorkerToolResultV1>;
  replayOutbox(input: ManagementOutboxReplayV1): Promise<ManagementOutboxReplayAckV1>;
}

export interface CreateManagementWorkerProtocolInput {
  readonly socket: ManagementWorkerProtocolSocket;
  readonly workerInstanceId: string;
  readonly profileId: string;
  readonly runtimeVersion: string;
  readonly ackTimeoutMs?: number;
  readonly toolAckTimeoutMs?: number;
}

export function createManagementWorkerProtocol(
  input: CreateManagementWorkerProtocolInput,
): PiManagerWorkerProtocol {
  const ackTimeoutMs = normalizeTimeout(input.ackTimeoutMs ?? 10_000);
  const toolAckTimeoutMs = normalizeTimeout(input.toolAckTimeoutMs ?? 6 * 60_000);
  let capability: ManagementWorkerCapabilityInput | undefined;
  let handlers: PiManagerWorkerProtocolHandlers | undefined;
  let workerId: string | undefined;
  let started = false;

  const leaseOfferHandler = async (payload: unknown, ack?: (result: unknown) => void) => {
    const parsed = safeParseManagementWorkerPayload('lease-offer', payload);
    if (!parsed.ok || !handlers?.reserveLeaseOffer(parsed.value)) {
      ack?.({ ok: false, errorCode: 'UNAVAILABLE' });
      return;
    }
    ack?.({ ok: true });
    try {
      await handlers.onLeaseOffer(parsed.value);
    } catch {
      // Lease acquisition/session startup owns its own fail-closed cleanup.
    }
  };

  async function register(): Promise<string> {
    if (!capability) throw new Error('MANAGEMENT_WORKER_CAPABILITY_MISSING');
    const payload: ManagementWorkerRegisterV1 = {
      schemaVersion: 1,
      workerInstanceId: input.workerInstanceId,
      profileId: input.profileId,
      runtimeVersion: input.runtimeVersion,
      supportedProtocolVersions: [1],
      supportedPhases: [1],
      ...capability,
    };
    const ack = parseManagementWorkerPayload(
      'register-ack',
      await emitWithTimeout(input.socket, AGENT_EVENTS.managementWorker.register, payload, ackTimeoutMs),
    );
    if (!ack.ok) throw new Error(ack.diagnosticCode ?? 'MANAGEMENT_WORKER_REGISTER_REJECTED');
    workerId = ack.workerId;
    return workerId;
  }

  return {
    async start(nextCapability, nextHandlers) {
      capability = structuredClone(nextCapability);
      handlers = nextHandlers;
      if (!started) {
        started = true;
        input.socket.on(AGENT_EVENTS.managementWorker.leaseOffer, leaseOfferHandler);
        input.socket.onDisconnect?.(async () => {
          if (!started) return;
          workerId = undefined;
          try {
            await handlers?.onDisconnect();
          } catch {
            // A disconnect callback cannot restore transport authority; keep the protocol stopped locally.
          }
        });
        input.socket.onReconnect?.(async () => {
          if (!started) return;
          try {
            const reconnectedWorkerId = await register();
            await handlers?.onReconnect?.(reconnectedWorkerId);
          } catch {
            workerId = undefined;
            try {
              await handlers?.onDisconnect();
            } catch {
              // Re-registration remains fail closed; the next reconnect may retry.
            }
          }
        });
      }
      try {
        return { workerId: await register() };
      } catch (error) {
        started = false;
        input.socket.off?.(AGENT_EVENTS.managementWorker.leaseOffer, leaseOfferHandler);
        throw error;
      }
    },
    stop() {
      started = false;
      workerId = undefined;
      input.socket.off?.(AGENT_EVENTS.managementWorker.leaseOffer, leaseOfferHandler);
    },
    async acquireLease(offer) {
      return parseManagementWorkerPayload('lease-acquire-ack', await emitWithTimeout(
        input.socket,
        AGENT_EVENTS.managementWorker.leaseAcquire,
        { schemaVersion: 1, offerId: offer.offerId, workerInstanceId: input.workerInstanceId },
        ackTimeoutMs,
      ));
    },
    async renewLease(payload) {
      return parseManagementWorkerPayload('lease-renew-ack', await emitWithTimeout(
        input.socket, AGENT_EVENTS.managementWorker.leaseRenew, payload, ackTimeoutMs,
      ));
    },
    async releaseLease(payload) {
      return parseManagementWorkerPayload('lease-release-ack', await emitWithTimeout(
        input.socket, AGENT_EVENTS.managementWorker.leaseRelease, payload, ackTimeoutMs,
      ));
    },
    async abortLease(payload) {
      return parseManagementWorkerPayload('lease-release-ack', await emitWithTimeout(
        input.socket, AGENT_EVENTS.managementWorker.abort, payload, ackTimeoutMs,
      ));
    },
    async fetchCheckpoint(payload) {
      return parseManagementWorkerPayload('checkpoint-result', await emitWithTimeout(
        input.socket, AGENT_EVENTS.managementWorker.checkpointFetch, payload, ackTimeoutMs,
      ));
    },
    async executeTool(payload) {
      return parseManagementWorkerPayload('tool-result', await emitWithTimeout(
        input.socket, AGENT_EVENTS.managementWorker.toolRequest, payload, toolAckTimeoutMs,
      ));
    },
    async replayOutbox(payload) {
      return parseManagementWorkerPayload('outbox-replay-ack', await emitWithTimeout(
        input.socket, AGENT_EVENTS.managementWorker.outboxReplay, payload, ackTimeoutMs,
      ));
    },
  };
}

async function emitWithTimeout(
  socket: ManagementWorkerProtocolSocket,
  event: string,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  if (!socket.connected) throw new Error('MANAGEMENT_WORKER_DISCONNECTED');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      socket.emitWithAck(event, payload),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('MANAGEMENT_WORKER_ACK_TIMEOUT')), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('MANAGEMENT_WORKER_ACK_TIMEOUT_INVALID');
  return value;
}
