import { createHash } from 'node:crypto';
import type {
  ManagementCheckpointFetchV1,
  ManagementCheckpointResultV1,
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
import type { ManagementAccessAuditRecord, ManagementRepositories } from '../management-repositories.js';
import type { MessageRepository, ServerNextRepositories } from '../repositories.js';
import type { TaskCoordinationUnitOfWork } from '../task-coordination-unit-of-work.js';
import { ManagementConflictError, type createManagementKernel } from './management-kernel.js';
import {
  collectManagementCheckpointFacts,
  restoreOrRebuildManagementCheckpoint,
  toManagementCheckpointAuthoritative,
  type ManagementCheckpointMemoryCapsules,
} from './management-checkpoint.js';
import type {
  ManagementToolExecutor,
  ManagementToolRequest,
  ManagementToolResult,
} from './management-tool-executor.js';
import type { ServerWorkerPool } from './server-worker-pool.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;

export interface ServerWorkerSchedulerDependencies {
  readonly pool: ServerWorkerPool;
  readonly management: ManagementRepositories;
  readonly messages?: MessageRepository;
  readonly taskCoordinationUnitOfWork?: TaskCoordinationUnitOfWork;
  readonly memoryCapsules?: ManagementCheckpointMemoryCapsules;
  readonly repositories?: ServerNextRepositories;
  readonly executeTool?: ManagementToolExecutor;
  readonly kernel: ManagementKernel;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly leaseTokens: { nextToken(): string };
  readonly leaseTtlMs?: number;
  readonly defaultOfferTimeoutMs?: number;
  readonly queueTimeoutMs?: number;
}

export interface ScheduleServerManagementRunInput {
  readonly managementRunId: string;
  readonly profileId: string;
  readonly offerTimeoutMs?: number;
}

export type ScheduleServerManagementRunResult = ManagementWorkerFailureV1 | {
  readonly ok: true;
  readonly offerId: string;
  readonly workerId: string;
  readonly workerPoolId: string;
  readonly profileId: string;
  readonly offerExpiresAt: number;
};

interface PendingServerOffer {
  readonly offerId: string;
  readonly managementRunId: string;
  readonly workerId: string;
  readonly workerInstanceId: string;
  readonly connectionId: string;
  readonly workerPoolId: string;
  readonly profileId: string;
  readonly offerExpiresAt: number;
  readonly offerTimeoutMs: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_OFFER_TIMEOUT_MS = 10_000;
const DEFAULT_QUEUE_TIMEOUT_MS = 5 * 60_000;

export function createServerWorkerScheduler(dependencies: ServerWorkerSchedulerDependencies) {
  const leaseTtlMs = dependencies.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const defaultOfferTimeoutMs = dependencies.defaultOfferTimeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
  const queueTimeoutMs = dependencies.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS;
  const pendingOffers = new Map<string, PendingServerOffer>();
  const pendingOfferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const recoveryPendingRunIds = new Set<string>();
  const queuedSchedules = new Map<string, ScheduleServerManagementRunInput>();
  const queueDeadlineByRunId = new Map<string, number>();
  const queueTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const schedulingByRun = new Map<string, Promise<ScheduleServerManagementRunResult>>();
  let drainingQueue = false;

  return {
    async registerWorker(input: Parameters<ServerWorkerPool['registerWorker']>[0]) {
      await recoverExpiredWorkerReservations();
      const registered = dependencies.pool.registerWorker(input);
      if (registered.ok) await drainQueue();
      return registered;
    },

    disconnect(connectionId: string) {
      const endpoint = dependencies.pool.workerForConnection(connectionId);
      for (const [offerId, offer] of pendingOffers) {
        if (offer.connectionId !== connectionId) continue;
        clearPendingOffer(offerId);
        dependencies.pool.releaseCapacity({
          workerId: offer.workerId,
          managementRunId: offer.managementRunId,
        });
        queueSchedule(offer);
      }
      const disconnected = dependencies.pool.disconnect(connectionId);
      if (endpoint) {
        for (const managementRunId of disconnected.activeManagementRunIds) {
          recoveryPendingRunIds.add(managementRunId);
          queuedSchedules.set(managementRunId, {
            managementRunId,
            profileId: endpoint.profileId,
          });
          resetQueueDeadline(managementRunId);
          void armRecovery(managementRunId);
        }
      }
      return disconnected;
    },

    async managementPreflight(input: {
      readonly placementPolicy: ManagerPlacementPolicyDto;
      readonly managementPhase: 2 | 3;
      readonly targetAvailable: boolean;
    }): Promise<{ preflight: ManagementPreflight; profileId?: string }> {
      await recoverExpiredWorkerReservations();
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

    scheduleManagementRun,

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
        clearPendingOffer(input.offerId);
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: offer.managementRunId });
        queueSchedule(offer);
        void drainQueue();
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
        clearPendingOffer(input.offerId);
        queuedSchedules.delete(offer.managementRunId);
        clearQueueDeadline(offer.managementRunId);
        recoveryPendingRunIds.delete(offer.managementRunId);
        clearRecoveryTimer(offer.managementRunId);
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
        clearPendingOffer(input.offerId);
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: offer.managementRunId });
        return schedulerFailure(error);
      }
    },

    async renewLease(connectionId: string, input: ManagementLeaseRenewV1): Promise<ManagementLeaseRenewAckV1> {
      const worker = dependencies.pool.workerForConnection(connectionId);
      if (!worker || worker.workerId !== input.workerId) {
        return failure('MANAGEMENT_WORKER_CONNECTION_MISMATCH', false, 'NOT_AUTHORIZED');
      }
      if (recoveryPendingRunIds.has(input.managementRunId)) {
        return failure('MANAGEMENT_WORKER_RECOVERY_PENDING', false, 'NOT_AUTHORIZED');
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

    async fetchCheckpoint(
      connectionId: string,
      input: ManagementCheckpointFetchV1,
    ): Promise<ManagementCheckpointResultV1> {
      const worker = dependencies.pool.workerForConnection(connectionId);
      if (!worker || worker.workerId !== input.workerId) {
        throw new ManagementConflictError('MANAGEMENT_WORKER_CONNECTION_MISMATCH');
      }
      if (recoveryPendingRunIds.has(input.managementRunId)) {
        throw new ManagementConflictError('MANAGEMENT_WORKER_RECOVERY_PENDING');
      }
      await dependencies.kernel.authorizeWrite(input);
      const run = await dependencies.management.runs.getById(input.managementRunId);
      if (!run || run.placementPolicy.placement !== 'managed') {
        throw new ManagementConflictError('MANAGEMENT_RUN_NOT_FOUND');
      }
      if (!dependencies.messages) {
        throw new ManagementConflictError('MANAGEMENT_CONTEXT_REPOSITORY_UNAVAILABLE');
      }
      const rootMessage = await dependencies.messages.getById(run.rootMessageId);
      if (!rootMessage || rootMessage.teamId !== run.teamId || rootMessage.channelId !== run.channelId) {
        throw new ManagementConflictError('MANAGEMENT_ROOT_MESSAGE_NOT_FOUND');
      }
      const messages = await dependencies.messages.listByThread({
        channelId: run.channelId,
        threadId: run.rootMessageId,
        limit: 200,
      });
      const snapshot = dependencies.taskCoordinationUnitOfWork
        ? await dependencies.taskCoordinationUnitOfWork.run(async (repositories) => ({
            latest: await repositories.management.checkpoints.getLatest(run.id),
            facts: await collectManagementCheckpointFacts(repositories.management, run, {
              tasks: repositories.tasks,
              coordination: repositories.coordination,
            }),
          }))
        : {
            latest: await dependencies.management.checkpoints.getLatest(run.id),
            facts: await collectManagementCheckpointFacts(dependencies.management, run),
          };
      const now = dependencies.clock.now();
      const facts = dependencies.memoryCapsules
        ? {
            ...snapshot.facts,
            validMemoryCapsuleIds: await dependencies.memoryCapsules.listValidMemoryCapsuleIds({
              teamId: run.teamId,
              managementRunId: run.id,
              now,
            }),
          }
        : snapshot.facts;
      const restored = snapshot.latest
        ? restoreOrRebuildManagementCheckpoint({
            checkpoint: snapshot.latest,
            facts,
            objective: rootMessage.body,
            now,
          })
        : undefined;
      const checkpoint = restored?.checkpoint ?? {
        schemaVersion: 1 as const,
        managementRunId: run.id,
        revision: run.checkpointRevision,
        authoritative: toManagementCheckpointAuthoritative(facts),
        contextHints: {
          objective: rootMessage.body,
          planSummary: '',
          completedInvocationSummaries: [],
          unresolvedQuestions: [],
        },
        updatedAt: now,
      };
      const includeCheckpoint = !snapshot.latest
        || restored?.kind === 'rebuilt'
        || input.knownCheckpointRevision !== checkpoint.revision;
      const managementPhase = 'managementPhase' in run ? run.managementPhase : 1;
      return {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: worker.workerId,
        context: {
          schemaVersion: 1,
          managementPhase,
          teamId: run.teamId,
          channelId: run.channelId,
          rootMessageId: run.rootMessageId,
          ...(run.rootTaskId ? { rootTaskId: run.rootTaskId } : {}),
          ...(run.frozenTarget ? { frozenTarget: run.frozenTarget } : {}),
          visibleThread: {
            revision: messages.at(-1)?.updatedAt ?? messages.at(-1)?.createdAt ?? 0,
            messages: messages.map((message) => ({
              id: message.id,
              senderKind: message.senderKind,
              senderId: message.senderId,
              body: message.body,
              createdAt: message.createdAt,
            })),
          },
        },
        ...(includeCheckpoint ? { checkpoint } : {}),
      };
    },

    async executeTool(
      connectionId: string,
      input: ManagementToolRequest,
    ): Promise<ManagementToolResult> {
      const worker = dependencies.pool.workerForConnection(connectionId);
      if (!worker || worker.workerId !== input.workerId) {
        return toolFailure(input, 'MANAGEMENT_WORKER_CONNECTION_MISMATCH');
      }
      if (recoveryPendingRunIds.has(input.managementRunId)) {
        return toolFailure(input, 'MANAGEMENT_WORKER_RECOVERY_PENDING');
      }
      const run = await dependencies.management.runs.getById(input.managementRunId);
      const lease = await dependencies.management.leases.get(input.managementRunId);
      const leaseStatus = inspectManagerLease(lease ?? undefined, dependencies.clock.now());
      if (!run || leaseStatus.kind !== 'active' || leaseStatus.lease.workerId !== worker.workerId) {
        return toolFailure(input, 'MANAGEMENT_WORKER_RUN_MISMATCH');
      }
      if (!dependencies.repositories || !dependencies.executeTool) {
        return toolFailure(input, 'SERVER_WORKER_CONTEXT_NOT_CONFIGURED');
      }

      const userId = run.initiatedByUserId;
      const denied = async (diagnosticCode: string) => {
        const previous = await dependencies.management.accessAudits.list(run.id);
        if ((diagnosticCode === 'SERVER_WORKER_TEAM_FORBIDDEN'
          || diagnosticCode === 'SERVER_WORKER_CHANNEL_FORBIDDEN')
          && previous.some((audit) => audit.decision === 'allowed')) {
          await appendAccessAudit({
            managementRunId: run.id,
            userId: userId ?? 'unknown',
            teamId: run.teamId,
            scopeType: 'channel',
            scopeId: run.channelId,
            action: 'permission-change',
            decision: 'denied',
            diagnosticCode,
          });
        }
        await appendAccessAudit({
          managementRunId: run.id,
          userId: userId ?? 'unknown',
          teamId: run.teamId,
          scopeType: 'channel',
          scopeId: run.channelId,
          action: 'access',
          decision: 'denied',
          diagnosticCode,
        });
        return toolFailure(input, diagnosticCode);
      };
      if (!userId) return denied('SERVER_WORKER_INITIATING_USER_REQUIRED');
      if (!await dependencies.repositories.teams.isMember(run.teamId, userId)) {
        return denied('SERVER_WORKER_TEAM_FORBIDDEN');
      }
      const channel = await dependencies.repositories.channels.getById(run.channelId);
      if (!channel || channel.teamId !== run.teamId) {
        return denied('SERVER_WORKER_CHANNEL_SCOPE_MISMATCH');
      }
      if ((channel.kind === 'direct' || channel.visibility === 'private')
        && !channel.humanMemberIds.includes(userId)) {
        return denied('SERVER_WORKER_CHANNEL_FORBIDDEN');
      }
      const rootMessage = await dependencies.repositories.messages.getById(run.rootMessageId);
      if (!rootMessage || rootMessage.teamId !== run.teamId || rootMessage.channelId !== run.channelId) {
        return denied('SERVER_WORKER_ROOT_MESSAGE_SCOPE_MISMATCH');
      }
      if (run.rootTaskId) {
        const task = await dependencies.repositories.tasks.getById(run.rootTaskId);
        if (!task || task.teamId !== run.teamId || task.channelId !== run.channelId) {
          return denied('SERVER_WORKER_ROOT_TASK_SCOPE_MISMATCH');
        }
      }

      await appendAccessAudit({
        managementRunId: run.id, userId, teamId: run.teamId,
        scopeType: 'channel', scopeId: run.channelId,
        action: 'access', decision: 'allowed',
      });
      const result = await dependencies.executeTool(input);
      if (result.ok) {
        await appendAccessAudit({
          managementRunId: run.id, userId, teamId: run.teamId,
          scopeType: 'channel', scopeId: run.channelId,
          action: 'transmit', decision: 'allowed',
          projectionHash: createHash('sha256').update(JSON.stringify(result.output)).digest('hex'),
        });
      }
      return result;
    },
  };

  async function appendAccessAudit(
    record: Omit<ManagementAccessAuditRecord, 'id' | 'createdAt'>,
  ): Promise<void> {
    await dependencies.management.accessAudits.append({
      id: dependencies.ids.nextId(),
      createdAt: dependencies.clock.now(),
      ...record,
    });
  }

  function scheduleManagementRun(
    input: ScheduleServerManagementRunInput,
  ): Promise<ScheduleServerManagementRunResult> {
    const existing = schedulingByRun.get(input.managementRunId);
    if (existing) return existing;
    const operation = performScheduleManagementRun(input).finally(() => {
      if (schedulingByRun.get(input.managementRunId) === operation) {
        schedulingByRun.delete(input.managementRunId);
      }
    });
    schedulingByRun.set(input.managementRunId, operation);
    return operation;
  }

  async function performScheduleManagementRun(
    input: ScheduleServerManagementRunInput,
  ): Promise<ScheduleServerManagementRunResult> {
      await recoverExpiredWorkerReservations();
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
      if (leaseStatus.kind === 'active') return failure('MANAGEMENT_RUN_LEASE_ACTIVE', true);
      if (leaseStatus.kind === 'invalid') return failure('MANAGEMENT_RUN_LEASE_INVALID', false);
      if (leaseStatus.kind === 'expired') await dependencies.kernel.expireLease({ managementRunId: run.id });
      if (queuedSchedules.has(run.id)) {
        const queueDeadline = queueDeadlineByRunId.get(run.id);
        if (queueDeadline !== undefined && queueDeadline <= now && await expireQueuedRun(run.id)) {
          return failure('SERVER_WORKER_QUEUE_TIMEOUT', false);
        }
      }
      for (const [offerId, offer] of pendingOffers) {
        if (offer.offerExpiresAt <= now) {
          clearPendingOffer(offerId);
          dependencies.pool.releaseCapacity({ workerId: offer.workerId, managementRunId: offer.managementRunId });
          queueSchedule(offer);
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
        queuedSchedules.set(run.id, input);
        ensureQueueDeadline(run.id);
        return failure(reserved.reasonCode, true);
      }
      queuedSchedules.delete(run.id);
      clearQueueDeadline(run.id);
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
        offerTimeoutMs: timeoutMs,
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
          clearPendingOffer(offerId);
          dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: run.id });
          return failure('MANAGEMENT_WORKER_OFFER_REJECTED', true);
        }
      } catch {
        clearPendingOffer(offerId);
        dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: run.id });
        return failure('MANAGEMENT_WORKER_OFFER_TIMEOUT', true);
      }
      if (pendingOffers.get(offerId) === offer) scheduleOfferExpiry(offer);
      return {
        ok: true as const,
        offerId,
        workerId: worker.workerId,
        workerPoolId: worker.workerPoolId,
        profileId: worker.profileId,
        offerExpiresAt,
      };
  }

  async function releaseLease(
    connectionId: string,
    input: ManagementLeaseReleaseV1 | ManagementWorkerAbortV1,
  ): Promise<ManagementLeaseReleaseAckV1> {
    const worker = dependencies.pool.workerForConnection(connectionId);
    if (!worker || worker.workerId !== input.workerId) {
      return failure('MANAGEMENT_WORKER_CONNECTION_MISMATCH', false, 'NOT_AUTHORIZED');
    }
    if (recoveryPendingRunIds.has(input.managementRunId)) {
      return failure('MANAGEMENT_WORKER_RECOVERY_PENDING', false, 'NOT_AUTHORIZED');
    }
    try {
      const lease = await dependencies.kernel.releaseLease(input);
      dependencies.pool.releaseCapacity({ workerId: worker.workerId, managementRunId: input.managementRunId });
      queuedSchedules.delete(input.managementRunId);
      clearQueueDeadline(input.managementRunId);
      clearRecoveryTimer(input.managementRunId);
      await drainQueue();
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

  function clearPendingOffer(offerId: string): void {
    pendingOffers.delete(offerId);
    const timer = pendingOfferTimers.get(offerId);
    if (timer !== undefined) clearTimeout(timer);
    pendingOfferTimers.delete(offerId);
  }

  function clearRecoveryTimer(managementRunId: string): void {
    const timer = recoveryTimers.get(managementRunId);
    if (timer !== undefined) clearTimeout(timer);
    recoveryTimers.delete(managementRunId);
  }

  async function armRecovery(managementRunId: string): Promise<void> {
    clearRecoveryTimer(managementRunId);
    const lease = await dependencies.management.leases.get(managementRunId);
    if (!lease || lease.releasedAt !== undefined) return;
    const timer = setTimeout(() => {
      recoveryTimers.delete(managementRunId);
      void dependencies.kernel.expireLease({ managementRunId })
        .then(() => drainQueue())
        .catch(() => undefined);
    }, Math.max(0, lease.expiresAt - dependencies.clock.now()));
    timer.unref?.();
    recoveryTimers.set(managementRunId, timer);
  }

  async function recoverExpiredWorkerReservations(): Promise<void> {
    const expired = dependencies.pool.expireStaleWorkerReservations();
    for (const worker of expired) {
      for (const [offerId, offer] of pendingOffers) {
        if (offer.workerId === worker.workerId) clearPendingOffer(offerId);
      }
      for (const managementRunId of worker.activeManagementRunIds) {
        recoveryPendingRunIds.add(managementRunId);
        queuedSchedules.set(managementRunId, {
          managementRunId,
          profileId: worker.profileId,
        });
        resetQueueDeadline(managementRunId);
        await armRecovery(managementRunId);
      }
    }
  }

  function queueSchedule(offer: PendingServerOffer): void {
    queuedSchedules.set(offer.managementRunId, {
      managementRunId: offer.managementRunId,
      profileId: offer.profileId,
      offerTimeoutMs: offer.offerTimeoutMs,
    });
    resetQueueDeadline(offer.managementRunId);
  }

  function ensureQueueDeadline(managementRunId: string): void {
    if (queueDeadlineByRunId.has(managementRunId)) return;
    queueDeadlineByRunId.set(managementRunId, dependencies.clock.now() + queueTimeoutMs);
    armQueueTimer(managementRunId);
  }

  function armQueueTimer(managementRunId: string): void {
    const deadline = queueDeadlineByRunId.get(managementRunId);
    if (deadline === undefined) return;
    const timer = setTimeout(() => {
      queueTimers.delete(managementRunId);
      const current = queueDeadlineByRunId.get(managementRunId);
      if (current === undefined) return;
      if (dependencies.clock.now() < current) {
        // 时钟与 timer 错位(测试手动拨钟或时钟回拨):按剩余时间重新 arm
        armQueueTimer(managementRunId);
        return;
      }
      void expireQueuedRun(managementRunId)
        .then((expired) => { if (expired) void drainQueue(); })
        .catch(() => undefined);
    }, Math.max(0, deadline - dependencies.clock.now()));
    timer.unref?.();
    queueTimers.set(managementRunId, timer);
  }

  function resetQueueDeadline(managementRunId: string): void {
    clearQueueDeadline(managementRunId);
    ensureQueueDeadline(managementRunId);
  }

  function clearQueueDeadline(managementRunId: string): void {
    queueDeadlineByRunId.delete(managementRunId);
    const timer = queueTimers.get(managementRunId);
    if (timer !== undefined) clearTimeout(timer);
    queueTimers.delete(managementRunId);
  }

  async function expireQueuedRun(managementRunId: string): Promise<boolean> {
    if (!queuedSchedules.has(managementRunId)) return false;
    const queueDeadline = queueDeadlineByRunId.get(managementRunId);
    if (queueDeadline === undefined || dependencies.clock.now() < queueDeadline) return false;
    const lease = await dependencies.management.leases.get(managementRunId);
    const leaseStatus = inspectManagerLease(lease ?? undefined, dependencies.clock.now());
    if (leaseStatus.kind === 'active') {
      // lease 仍有效:接管窗口由 lease 生命周期决定,排队超时顺延一个窗口
      resetQueueDeadline(managementRunId);
      return false;
    }
    queuedSchedules.delete(managementRunId);
    clearQueueDeadline(managementRunId);
    recoveryPendingRunIds.delete(managementRunId);
    clearRecoveryTimer(managementRunId);
    dependencies.pool.dropCapacityRequest(managementRunId);
    try {
      await dependencies.kernel.failRun({
        managementRunId,
        errorCode: 'SERVER_WORKER_QUEUE_TIMEOUT',
        idempotencyKey: `run-queue-timeout:${managementRunId}`,
      });
    } catch {
      // run 已被并发路径置为终态或删除:failRun 终态门幂等,无需处理
    }
    return true;
  }

  function scheduleOfferExpiry(offer: PendingServerOffer): void {
    const timer = setTimeout(() => {
      if (pendingOffers.get(offer.offerId) !== offer) return;
      clearPendingOffer(offer.offerId);
      dependencies.pool.releaseCapacity({ workerId: offer.workerId, managementRunId: offer.managementRunId });
      queueSchedule(offer);
      void drainQueue();
    }, Math.max(0, offer.offerExpiresAt - dependencies.clock.now()));
    timer.unref?.();
    pendingOfferTimers.set(offer.offerId, timer);
  }

  async function drainQueue(): Promise<void> {
    if (drainingQueue) return;
    drainingQueue = true;
    try {
      for (const [managementRunId, input] of [...queuedSchedules]) {
        const result = await scheduleManagementRun(input);
        if (result.ok) continue;
        if (result.diagnosticCode === 'SERVER_WORKER_CAPACITY_EXHAUSTED') break;
        if (!result.retryable) {
          queuedSchedules.delete(managementRunId);
          clearQueueDeadline(managementRunId);
          recoveryPendingRunIds.delete(managementRunId);
          clearRecoveryTimer(managementRunId);
          dependencies.pool.dropCapacityRequest(managementRunId);
        }
      }
    } finally {
      drainingQueue = false;
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

function toolFailure(
  input: ManagementToolRequest,
  diagnosticCode: string,
): ManagementToolResult {
  return {
    schemaVersion: input.schemaVersion,
    ...('managementPhase' in input ? { managementPhase: input.managementPhase } : {}),
    commandId: input.commandId,
    managementRunId: input.managementRunId,
    workerId: input.workerId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    ok: false,
    errorCode: 'NOT_AUTHORIZED',
    diagnosticCode,
    retryable: false,
  } as ManagementToolResult;
}
