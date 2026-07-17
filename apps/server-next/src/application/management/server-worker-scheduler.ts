import type {
  ManagementLeaseAcquireAckV1,
  ManagementLeaseAcquireV1,
  ManagementLeaseOfferV1,
  ManagementLeaseReleaseAckV1,
  ManagementLeaseReleaseV1,
  ManagementLeaseRenewAckV1,
  ManagementLeaseRenewV1,
  ManagementWorkerAbortV1,
  ManagementWorkerFailureV1,
  ManagerPlacementPolicyDto,
} from '../../../../../packages/contracts/src/index.js';
import { inspectManagerLease, type ManagementPreflight } from '../../../../../packages/domain/src/index.js';
import type { ManagementRepositories } from '../management-repositories.js';
import { ManagementConflictError, type createManagementKernel } from './management-kernel.js';
import type { ServerWorkerPool } from './server-worker-pool.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;

export interface ServerWorkerSchedulerDependencies {
  readonly pool: ServerWorkerPool;
  readonly management: ManagementRepositories;
  readonly kernel: ManagementKernel;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly leaseTokens: { nextToken(): string };
  readonly leaseTtlMs?: number;
  readonly defaultOfferTimeoutMs?: number;
}

export interface ScheduleServerManagementRunInput {
  readonly managementRunId: string;
  readonly profileId: string;
  readonly offerTimeoutMs?: number;
}

interface PendingServerOffer {
  readonly offerId: string;
  readonly managementRunId: string;
  readonly workerId: string;
  readonly workerInstanceId: string;
  readonly connectionId: string;
  readonly workerPoolId: string;
  readonly profileId: string;
  readonly offerExpiresAt: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_OFFER_TIMEOUT_MS = 10_000;

export function createServerWorkerScheduler(dependencies: ServerWorkerSchedulerDependencies) {
  const leaseTtlMs = dependencies.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const defaultOfferTimeoutMs = dependencies.defaultOfferTimeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
  const pendingOffers = new Map<string, PendingServerOffer>();

  return {
    disconnect(connectionId: string) {
      for (const [offerId, offer] of pendingOffers) {
        if (offer.connectionId !== connectionId) continue;
        pendingOffers.delete(offerId);
        dependencies.pool.releaseCapacity({
          workerId: offer.workerId,
          managementRunId: offer.managementRunId,
        });
      }
      return dependencies.pool.disconnect(connectionId);
    },

    async managementPreflight(input: {
      readonly placementPolicy: ManagerPlacementPolicyDto;
      readonly managementPhase: 2 | 3;
      readonly targetAvailable: boolean;
    }): Promise<{ preflight: ManagementPreflight; profileId?: string }> {
      const placementAllowed = input.placementPolicy.placement === 'managed'
        && input.placementPolicy.allowServerContext === true
        && input.placementPolicy.requireLocalModelCredentials === false;
      const selected = placementAllowed
        ? dependencies.pool.selectWorker({
            managementPhase: input.managementPhase,
            ...(input.placementPolicy.preferredProvider
              ? { preferredProvider: input.placementPolicy.preferredProvider } : {}),
            ...(input.placementPolicy.preferredModel
              ? { preferredModel: input.placementPolicy.preferredModel } : {}),
          })
        : undefined;
      return {
        preflight: {
          workerAvailable: Boolean(selected),
          credentialAvailable: Boolean(selected),
          placementAllowed,
          budgetAvailable: true,
          targetAvailable: input.targetAvailable,
        },
        ...(selected ? { profileId: selected.profileId } : {}),
      };
    },

    async scheduleManagementRun(input: ScheduleServerManagementRunInput) {
      const run = await dependencies.management.runs.getById(input.managementRunId);
      if (!run) return failure('MANAGEMENT_RUN_NOT_FOUND', false);
      const managementPhase = 'managementPhase' in run ? run.managementPhase : 1;
      if (run.placementPolicy.placement !== 'managed') {
        return failure('MANAGEMENT_SERVER_PLACEMENT_REQUIRED', false, 'NOT_AUTHORIZED');
      }
      if (managementPhase < 2 || !run.rootTaskId) {
        return failure('MANAGEMENT_SERVER_ROOT_TASK_REQUIRED', false);
      }
      if (isTerminal(run.status)) return failure('MANAGEMENT_RUN_TERMINAL', false);
      const now = dependencies.clock.now();
      const currentLease = await dependencies.management.leases.get(run.id);
      const leaseStatus = inspectManagerLease(currentLease ?? undefined, now);
      if (leaseStatus.kind === 'active') return failure('MANAGEMENT_RUN_LEASE_ACTIVE', false);
      if (leaseStatus.kind === 'invalid') return failure('MANAGEMENT_RUN_LEASE_INVALID', false);
      if (leaseStatus.kind === 'expired') await dependencies.kernel.expireLease({ managementRunId: run.id });
      for (const [offerId, offer] of pendingOffers) {
        if (offer.offerExpiresAt <= now) {
          pendingOffers.delete(offerId);
          dependencies.pool.releaseCapacity({ workerId: offer.workerId, managementRunId: offer.managementRunId });
          continue;
        }
        if (offer.managementRunId === run.id) return failure('MANAGEMENT_RUN_OFFER_PENDING', true);
      }

      const reserved = dependencies.pool.requestCapacity({
        managementRunId: run.id,
        teamId: run.teamId,
        profileId: input.profileId,
        managementPhase,
        requireOfferTransport: true,
        ...(run.placementPolicy.preferredProvider
          ? { preferredProvider: run.placementPolicy.preferredProvider } : {}),
        ...(run.placementPolicy.preferredModel
          ? { preferredModel: run.placementPolicy.preferredModel } : {}),
      });
      if (reserved.kind === 'queued') {
        return failure(reserved.reasonCode, true);
      }
      const worker = dependencies.pool.getWorker(reserved.workerId);
      if (!worker || worker.workerId !== reserved.workerId) {
        dependencies.pool.releaseCapacity({ workerId: reserved.workerId, managementRunId: run.id });
        return failure('SERVER_WORKER_CONNECTION_STALE', true);
      }
      const timeoutMs = normalizePositiveDuration(input.offerTimeoutMs ?? defaultOfferTimeoutMs);
      if (!timeoutMs) {
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: run.id });
        return failure('MANAGEMENT_WORKER_OFFER_TIMEOUT_INVALID', false);
      }
      const offerId = dependencies.ids.nextId();
      const offerExpiresAt = now + timeoutMs;
      const offer: PendingServerOffer = {
        offerId,
        managementRunId: run.id,
        workerId: worker.workerId,
        workerInstanceId: worker.workerInstanceId,
        connectionId: worker.connectionId,
        workerPoolId: worker.workerPoolId,
        profileId: worker.profileId,
        offerExpiresAt,
      };
      const payload: ManagementLeaseOfferV1 = {
        schemaVersion: 1,
        offerId,
        managementRunId: run.id,
        workerId: worker.workerId,
        offerExpiresAt,
      };
      pendingOffers.set(offerId, offer);
      try {
        const ack = await dependencies.pool.emitLeaseOffer({ workerId: worker.workerId, payload, timeoutMs });
        if (ack && typeof ack === 'object' && (ack as { ok?: unknown }).ok === false) {
          pendingOffers.delete(offerId);
          dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: run.id });
          return failure('MANAGEMENT_WORKER_OFFER_REJECTED', true);
        }
      } catch {
        pendingOffers.delete(offerId);
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: run.id });
        return failure('MANAGEMENT_WORKER_OFFER_TIMEOUT', true);
      }
      return {
        ok: true as const,
        offerId,
        workerId: worker.workerId,
        workerPoolId: worker.workerPoolId,
        profileId: worker.profileId,
        offerExpiresAt,
      };
    },

    async acquireLease(connectionId: string, input: ManagementLeaseAcquireV1): Promise<ManagementLeaseAcquireAckV1> {
      const offer = pendingOffers.get(input.offerId);
      if (!offer) return failure('MANAGEMENT_WORKER_OFFER_NOT_FOUND', false);
      const worker = dependencies.pool.workerForConnection(connectionId);
      if (!worker || worker.workerId !== offer.workerId
        || worker.workerInstanceId !== input.workerInstanceId
        || worker.connectionId !== offer.connectionId) {
        return failure('MANAGEMENT_WORKER_OFFER_MISMATCH', false, 'NOT_AUTHORIZED');
      }
      const now = dependencies.clock.now();
      if (now >= offer.offerExpiresAt) {
        pendingOffers.delete(input.offerId);
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: offer.managementRunId });
        return failure('MANAGEMENT_WORKER_OFFER_EXPIRED', true);
      }
      const leaseToken = dependencies.leaseTokens.nextToken();
      try {
        const acquired = await dependencies.kernel.acquireLease({
          managementRunId: offer.managementRunId,
          workerId: worker.workerId,
          host: { kind: 'server', workerPoolId: worker.workerPoolId, profileId: worker.profileId },
          leaseToken,
          ttlMs: leaseTtlMs,
        });
        pendingOffers.delete(input.offerId);
        return {
          schemaVersion: 1,
          ok: true,
          managementRunId: offer.managementRunId,
          workerId: worker.workerId,
          leaseToken,
          fencingToken: acquired.lease.fencingToken,
          acquiredAt: acquired.lease.acquiredAt,
          expiresAt: acquired.lease.expiresAt,
        };
      } catch (error) {
        pendingOffers.delete(input.offerId);
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: offer.managementRunId });
        return schedulerFailure(error);
      }
    },

    async renewLease(connectionId: string, input: ManagementLeaseRenewV1): Promise<ManagementLeaseRenewAckV1> {
      const worker = dependencies.pool.workerForConnection(connectionId);
      if (!worker || worker.workerId !== input.workerId) {
        return failure('MANAGEMENT_WORKER_CONNECTION_MISMATCH', false, 'NOT_AUTHORIZED');
      }
      try {
        const lease = await dependencies.kernel.renewLease({ ...input, ttlMs: leaseTtlMs });
        return {
          schemaVersion: 1,
          ok: true,
          managementRunId: input.managementRunId,
          workerId: input.workerId,
          fencingToken: lease.fencingToken,
          expiresAt: lease.expiresAt,
        };
      } catch (error) {
        return schedulerFailure(error);
      }
    },

    async releaseLease(connectionId: string, input: ManagementLeaseReleaseV1): Promise<ManagementLeaseReleaseAckV1> {
      return releaseLease(connectionId, input);
    },

    async abortLease(connectionId: string, input: ManagementWorkerAbortV1): Promise<ManagementLeaseReleaseAckV1> {
      return releaseLease(connectionId, input);
    },
  };

  async function releaseLease(
    connectionId: string,
    input: ManagementLeaseReleaseV1 | ManagementWorkerAbortV1,
  ): Promise<ManagementLeaseReleaseAckV1> {
    const worker = dependencies.pool.workerForConnection(connectionId);
    if (!worker || worker.workerId !== input.workerId) {
      return failure('MANAGEMENT_WORKER_CONNECTION_MISMATCH', false, 'NOT_AUTHORIZED');
    }
    try {
      const lease = await dependencies.kernel.releaseLease(input);
      dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: input.managementRunId });
      return {
        schemaVersion: 1,
        ok: true,
        managementRunId: input.managementRunId,
        workerId: input.workerId,
        fencingToken: lease.fencingToken,
        releasedAt: lease.releasedAt ?? dependencies.clock.now(),
      };
    } catch (error) {
      return schedulerFailure(error);
    }
  }
}

export type ServerWorkerScheduler = ReturnType<typeof createServerWorkerScheduler>;

function normalizePositiveDuration(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function schedulerFailure(error: unknown): ManagementWorkerFailureV1 {
  const diagnosticCode = error instanceof ManagementConflictError
    ? error.code
    : 'MANAGEMENT_WORKER_INTERNAL_ERROR';
  const unauthorized = diagnosticCode.startsWith('LEASE_');
  return failure(
    diagnosticCode,
    diagnosticCode.includes('ACTIVE') || diagnosticCode.includes('TIMEOUT'),
    unauthorized ? 'NOT_AUTHORIZED' : diagnosticCode.includes('CONFLICT') ? 'CONFLICT' : 'INVALID_REQUEST',
  );
}

function failure(
  diagnosticCode: string,
  retryable: boolean,
  errorCode: ManagementWorkerFailureV1['errorCode'] = 'UNAVAILABLE',
): ManagementWorkerFailureV1 {
  return { schemaVersion: 1, ok: false, errorCode, diagnosticCode, retryable };
}
