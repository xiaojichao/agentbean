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
  ManagementOutboxReplayAckV1,
  ManagementOutboxReplayV1,
  ManagementWorkerAbortV1,
  ManagementWorkerFailureV1,
  ManagementWorkerRegisterAckV1,
  ManagementWorkerRegisterV1,
  ManagementWorkerRegisterV2,
  ManagementWorkerToolRequestV1,
  ManagementWorkerToolResultV1,
  Phase2TaskToolRequestV2,
  Phase2TaskToolResultV2,
} from '../../../../../packages/contracts/src/index.js';
import { inspectManagerLease } from '../../../../../packages/domain/src/index.js';
import type { ManagementPreflight } from '../../../../../packages/domain/src/index.js';
import type { ManagerPlacementPolicyDto } from '../../../../../packages/contracts/src/index.js';
import type { DeviceRepository, MessageRepository } from '../repositories.js';
import type { ManagementRepositories } from '../management-repositories.js';
import type { TaskCoordinationUnitOfWork } from '../task-coordination-unit-of-work.js';
import { ManagementConflictError, type createManagementKernel } from './management-kernel.js';
import { collectManagementCheckpointFacts, restoreOrRebuildManagementCheckpoint, toManagementCheckpointAuthoritative } from './management-checkpoint.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;
type ManagementToolRequest = ManagementWorkerToolRequestV1 | Phase2TaskToolRequestV2;
type ManagementToolResult = ManagementWorkerToolResultV1 | Phase2TaskToolResultV2;
type ManagementToolExecutor = (request: ManagementToolRequest) => Promise<ManagementToolResult>;
type ManagementWorkerCapability = ManagementWorkerRegisterV1 | ManagementWorkerRegisterV2;

export interface ManagementWorkerOfferTransport {
  emitLeaseOffer(payload: ManagementLeaseOfferV1, timeoutMs: number): Promise<unknown>;
}

export interface DeviceWorkerSchedulerDependencies {
  readonly devices: DeviceRepository;
  readonly messages?: MessageRepository;
  readonly management: ManagementRepositories;
  readonly taskCoordinationUnitOfWork?: TaskCoordinationUnitOfWork;
  readonly kernel: ManagementKernel;
  readonly executeTool: ManagementToolExecutor;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly leaseTokens: { nextToken(): string };
  readonly leaseTtlMs?: number;
  readonly defaultOfferTimeoutMs?: number;
}

export interface RegisterManagementWorkerInput {
  readonly connectionId: string;
  readonly deviceId?: string;
  readonly capability: ManagementWorkerCapability;
  readonly transport: ManagementWorkerOfferTransport;
}

export interface ScheduleManagementRunInput {
  readonly managementRunId: string;
  readonly profileId: string;
  readonly offerTimeoutMs?: number;
}

export type ScheduleManagementRunResult = {
  readonly ok: true;
  readonly offerId: string;
  readonly workerId: string;
  readonly deviceId: string;
  readonly profileId: string;
  readonly offerExpiresAt: number;
} | ManagementWorkerFailureV1;

interface RegisteredWorker {
  readonly workerId: string;
  readonly workerInstanceId: string;
  readonly deviceId: string;
  readonly teamId: string;
  readonly profileId: string;
  connectionId: string;
  connected: boolean;
  capability: ManagementWorkerCapability;
  transport: ManagementWorkerOfferTransport;
  readonly activeRunIds: Set<string>;
}

interface PendingOffer {
  readonly offerId: string;
  readonly managementRunId: string;
  readonly workerId: string;
  readonly workerInstanceId: string;
  readonly connectionId: string;
  readonly offerExpiresAt: number;
}

const DEFAULT_LEASE_TTL_MS = 5 * 60_000;
const DEFAULT_OFFER_TIMEOUT_MS = 10_000;

export function createDeviceWorkerScheduler(dependencies: DeviceWorkerSchedulerDependencies) {
  const leaseTtlMs = dependencies.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const defaultOfferTimeoutMs = dependencies.defaultOfferTimeoutMs ?? DEFAULT_OFFER_TIMEOUT_MS;
  const workersById = new Map<string, RegisteredWorker>();
  const workersByIdentity = new Map<string, RegisteredWorker>();
  const workerIdByConnection = new Map<string, string>();
  const pendingOffers = new Map<string, PendingOffer>();

  return {
    async registerWorker(input: RegisterManagementWorkerInput): Promise<ManagementWorkerRegisterAckV1> {
      if (!input.deviceId) return failure('MANAGEMENT_WORKER_DEVICE_HELLO_REQUIRED', false);
      const device = await dependencies.devices.getById(input.deviceId);
      if (!device || device.status !== 'online') return failure('MANAGEMENT_WORKER_DEVICE_OFFLINE', true);
      if (!device.profileId || device.profileId !== input.capability.profileId) {
        return failure('MANAGEMENT_WORKER_PROFILE_MISMATCH', false);
      }
      const identity = workerIdentity(device.teamId, device.id, input.capability.profileId, input.capability.workerInstanceId);
      const existing = workersByIdentity.get(identity);
      const worker: RegisteredWorker = existing ?? {
        workerId: dependencies.ids.nextId(),
        workerInstanceId: input.capability.workerInstanceId,
        deviceId: device.id,
        teamId: device.teamId,
        profileId: input.capability.profileId,
        connectionId: input.connectionId,
        connected: true,
        capability: input.capability,
        transport: input.transport,
        activeRunIds: new Set<string>(),
      };
      if (existing) workerIdByConnection.delete(existing.connectionId);
      worker.connectionId = input.connectionId;
      worker.connected = true;
      worker.capability = input.capability;
      worker.transport = input.transport;
      workersById.set(worker.workerId, worker);
      workersByIdentity.set(identity, worker);
      workerIdByConnection.set(input.connectionId, worker.workerId);
      return { schemaVersion: 1, ok: true, workerId: worker.workerId, protocolVersion: 1 };
    },

    disconnect(connectionId: string): { workerId?: string; activeRunIds: readonly string[] } {
      const workerId = workerIdByConnection.get(connectionId);
      if (!workerId) return { activeRunIds: [] };
      workerIdByConnection.delete(connectionId);
      const worker = workersById.get(workerId);
      if (!worker || worker.connectionId !== connectionId) return { activeRunIds: [] };
      worker.connected = false;
      for (const [offerId, offer] of pendingOffers) {
        if (offer.connectionId === connectionId) pendingOffers.delete(offerId);
      }
      return { workerId, activeRunIds: [...worker.activeRunIds] };
    },

    async managementPreflight(input: {
      teamId: string;
      deviceId: string;
      profileId: string;
      placementPolicy: ManagerPlacementPolicyDto;
      targetAvailable: boolean;
    }): Promise<ManagementPreflight> {
      const placementAllowed = input.placementPolicy.placement !== 'managed'
        && (!input.placementPolicy.allowedDeviceIds || input.placementPolicy.allowedDeviceIds.includes(input.deviceId));
      const candidates = [...workersById.values()].filter((worker) =>
        worker.connected
        && worker.teamId === input.teamId
        && worker.deviceId === input.deviceId
        && worker.profileId === input.profileId
        && effectiveActiveLeaseCount(worker) < worker.capability.capacity.maxConcurrentLeases,
      );
      return {
        workerAvailable: candidates.length > 0,
        credentialAvailable: candidates.some((worker) => credentialReady(worker.capability, input.placementPolicy.requireLocalModelCredentials)),
        placementAllowed,
        budgetAvailable: true,
        targetAvailable: input.targetAvailable,
      };
    },

    async managementPhase2Preflight(input: {
      teamId: string;
      placementPolicy: ManagerPlacementPolicyDto;
      targetAvailable: boolean;
    }): Promise<{ preflight: ManagementPreflight; profileId?: string }> {
      const teamWorkers = [...workersById.values()].filter((worker) =>
        worker.connected
        && worker.teamId === input.teamId
        && supportsManagementPhase(worker.capability, 2)
        && effectiveActiveLeaseCount(worker) < worker.capability.capacity.maxConcurrentLeases,
      );
      const allowedWorkers = teamWorkers.filter((worker) =>
        input.placementPolicy.placement !== 'managed'
        && (!input.placementPolicy.allowedDeviceIds
          || input.placementPolicy.allowedDeviceIds.includes(worker.deviceId)),
      );
      const availableWorkers: RegisteredWorker[] = [];
      for (const worker of allowedWorkers) {
        const device = await dependencies.devices.getById(worker.deviceId);
        if (device?.status === 'online' && device.teamId === input.teamId
          && device.profileId === worker.profileId) availableWorkers.push(worker);
      }
      availableWorkers.sort(compareWorkers);
      const selected = availableWorkers.find((worker) =>
        credentialReady(worker.capability, input.placementPolicy.requireLocalModelCredentials));
      return {
        preflight: {
          workerAvailable: availableWorkers.length > 0,
          credentialAvailable: Boolean(selected),
          placementAllowed: allowedWorkers.length > 0,
          budgetAvailable: true,
          targetAvailable: input.targetAvailable,
        },
        ...(selected ? { profileId: selected.profileId } : {}),
      };
    },

    async scheduleManagementRun(input: ScheduleManagementRunInput): Promise<ScheduleManagementRunResult> {
      const run = await dependencies.management.runs.getById(input.managementRunId);
      if (!run) return failure('MANAGEMENT_RUN_NOT_FOUND', false);
      if (isTerminal(run.status)) return failure('MANAGEMENT_RUN_TERMINAL', false);
      if (run.placementPolicy.placement === 'managed') return failure('MANAGEMENT_DEVICE_PLACEMENT_NOT_ALLOWED', false);
      const now = dependencies.clock.now();
      const currentLease = await dependencies.management.leases.get(run.id);
      const leaseStatus = inspectManagerLease(currentLease ?? undefined, now);
      if (leaseStatus.kind === 'active') return failure('MANAGEMENT_RUN_LEASE_ACTIVE', false);
      if (leaseStatus.kind === 'invalid') return failure('MANAGEMENT_RUN_LEASE_INVALID', false);
      if (leaseStatus.kind === 'expired') await dependencies.kernel.expireLease({ managementRunId: run.id });
      for (const [offerId, offer] of pendingOffers) {
        if (offer.offerExpiresAt <= now) {
          pendingOffers.delete(offerId);
          continue;
        }
        if (offer.managementRunId === run.id) return failure('MANAGEMENT_RUN_OFFER_PENDING', true);
      }

      await removeExpiredCapacity(workersById.values(), dependencies.management, now);
      const candidates: RegisteredWorker[] = [];
      for (const worker of workersById.values()) {
        if (!worker.connected || worker.teamId !== run.teamId || worker.profileId !== input.profileId) continue;
        if (!supportsManagementPhase(worker.capability, 'managementPhase' in run ? run.managementPhase : 1)) continue;
        if (currentLease && (worker.deviceId !== currentLease.host.deviceId || worker.profileId !== currentLease.host.profileId)) continue;
        if (run.placementPolicy.allowedDeviceIds && !run.placementPolicy.allowedDeviceIds.includes(worker.deviceId)) continue;
        if (!credentialReady(worker.capability, run.placementPolicy.requireLocalModelCredentials)) continue;
        if (run.placementPolicy.preferredProvider && worker.capability.providerId !== run.placementPolicy.preferredProvider) continue;
        if (run.placementPolicy.preferredModel && worker.capability.modelId !== run.placementPolicy.preferredModel) continue;
        const device = await dependencies.devices.getById(worker.deviceId);
        if (!device || device.status !== 'online' || device.teamId !== run.teamId || device.profileId !== input.profileId) continue;
        if (effectiveActiveLeaseCount(worker) >= worker.capability.capacity.maxConcurrentLeases) continue;
        candidates.push(worker);
      }
      candidates.sort(compareWorkers);
      const worker = candidates[0];
      if (!worker) return failure('MANAGEMENT_WORKER_UNAVAILABLE', true);

      const timeoutMs = normalizePositiveDuration(input.offerTimeoutMs ?? defaultOfferTimeoutMs);
      if (!timeoutMs) return failure('MANAGEMENT_WORKER_OFFER_TIMEOUT_INVALID', false);
      const offerId = dependencies.ids.nextId();
      const offerExpiresAt = now + timeoutMs;
      const offer: PendingOffer = {
        offerId,
        managementRunId: run.id,
        workerId: worker.workerId,
        workerInstanceId: worker.workerInstanceId,
        connectionId: worker.connectionId,
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
        const ack = await worker.transport.emitLeaseOffer(payload, timeoutMs);
        if (ack && typeof ack === 'object' && (ack as { ok?: unknown }).ok === false) {
          pendingOffers.delete(offerId);
          return failure('MANAGEMENT_WORKER_OFFER_REJECTED', true);
        }
      } catch {
        pendingOffers.delete(offerId);
        return failure('MANAGEMENT_WORKER_OFFER_TIMEOUT', true);
      }
      return { ok: true, offerId, workerId: worker.workerId, deviceId: worker.deviceId, profileId: worker.profileId, offerExpiresAt };
    },

    async acquireLease(connectionId: string, input: ManagementLeaseAcquireV1): Promise<ManagementLeaseAcquireAckV1> {
      const offer = pendingOffers.get(input.offerId);
      if (!offer) return failure('MANAGEMENT_WORKER_OFFER_NOT_FOUND', false);
      if (offer.connectionId !== connectionId || offer.workerInstanceId !== input.workerInstanceId) {
        return failure('MANAGEMENT_WORKER_OFFER_MISMATCH', false);
      }
      const worker = workersById.get(offer.workerId);
      if (!worker || !worker.connected || worker.connectionId !== connectionId) {
        return failure('MANAGEMENT_WORKER_DISCONNECTED', true);
      }
      const now = dependencies.clock.now();
      if (now >= offer.offerExpiresAt) {
        pendingOffers.delete(input.offerId);
        return failure('MANAGEMENT_WORKER_OFFER_EXPIRED', true);
      }
      const leaseToken = dependencies.leaseTokens.nextToken();
      try {
        const acquired = await dependencies.kernel.acquireLease({
          managementRunId: offer.managementRunId,
          workerId: worker.workerId,
          host: { deviceId: worker.deviceId, profileId: worker.profileId },
          leaseToken,
          ttlMs: leaseTtlMs,
        });
        pendingOffers.delete(input.offerId);
        worker.activeRunIds.add(offer.managementRunId);
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
        return schedulerFailure(error);
      }
    },

    async renewLease(connectionId: string, input: ManagementLeaseRenewV1): Promise<ManagementLeaseRenewAckV1> {
      const worker = connectedWorker(connectionId, input.workerId, workersById, workerIdByConnection);
      if (!worker) return failure('MANAGEMENT_WORKER_CONNECTION_MISMATCH', false);
      try {
        const lease = await dependencies.kernel.renewLease({ ...input, ttlMs: leaseTtlMs });
        worker.activeRunIds.add(input.managementRunId);
        return { schemaVersion: 1, ok: true, managementRunId: input.managementRunId, workerId: input.workerId, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt };
      } catch (error) {
        return schedulerFailure(error);
      }
    },

    async releaseLease(connectionId: string, input: ManagementLeaseReleaseV1): Promise<ManagementLeaseReleaseAckV1> {
      return releaseWorkerLease(connectionId, input, dependencies, workersById, workerIdByConnection);
    },

    async abortLease(connectionId: string, input: ManagementWorkerAbortV1): Promise<ManagementLeaseReleaseAckV1> {
      return releaseWorkerLease(connectionId, input, dependencies, workersById, workerIdByConnection);
    },

    async executeTool(connectionId: string, input: ManagementToolRequest): Promise<ManagementToolResult> {
      const worker = connectedWorker(connectionId, input.workerId, workersById, workerIdByConnection);
      if (!worker) return toolFailure(input, 'MANAGEMENT_WORKER_CONNECTION_MISMATCH');
      const lease = await dependencies.management.leases.get(input.managementRunId);
      const leaseStatus = inspectManagerLease(lease ?? undefined, dependencies.clock.now());
      if (!worker.activeRunIds.has(input.managementRunId)
        || leaseStatus.kind !== 'active'
        || leaseStatus.lease.workerId !== worker.workerId) {
        return toolFailure(input, 'MANAGEMENT_WORKER_RUN_MISMATCH');
      }
      return dependencies.executeTool(input);
    },

    async fetchCheckpoint(connectionId: string, input: ManagementCheckpointFetchV1): Promise<ManagementCheckpointResultV1> {
      const worker = connectedWorker(connectionId, input.workerId, workersById, workerIdByConnection);
      if (!worker) throw new ManagementConflictError('MANAGEMENT_WORKER_CONNECTION_MISMATCH');
      await dependencies.kernel.authorizeWrite(input);
      const run = await dependencies.management.runs.getById(input.managementRunId);
      if (!run || run.teamId !== worker.teamId) throw new ManagementConflictError('MANAGEMENT_RUN_NOT_FOUND');
      if (!dependencies.messages) throw new ManagementConflictError('MANAGEMENT_CONTEXT_REPOSITORY_UNAVAILABLE');
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
              tasks: repositories.tasks, coordination: repositories.coordination,
            }),
          }))
        : {
            latest: await dependencies.management.checkpoints.getLatest(run.id),
            facts: await collectManagementCheckpointFacts(dependencies.management, run),
          };
      const latest = snapshot.latest;
      const checkpoint = latest
        ? restoreOrRebuildManagementCheckpoint({
            checkpoint: latest,
            facts: snapshot.facts,
            objective: rootMessage.body,
            now: dependencies.clock.now(),
          }).checkpoint
        : {
            schemaVersion: 1 as const,
            managementRunId: run.id,
            revision: run.checkpointRevision,
            authoritative: toManagementCheckpointAuthoritative(snapshot.facts),
            contextHints: {
              objective: rootMessage.body,
              planSummary: '', completedInvocationSummaries: [], unresolvedQuestions: [],
            },
            updatedAt: dependencies.clock.now(),
          };
      return {
        schemaVersion: 1,
        managementRunId: run.id,
        workerId: worker.workerId,
        context: {
          schemaVersion: 1,
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
        ...(checkpoint && input.knownCheckpointRevision !== checkpoint.revision ? { checkpoint } : {}),
      };
    },

    async replayOutbox(connectionId: string, input: ManagementOutboxReplayV1): Promise<ManagementOutboxReplayAckV1> {
      const base = {
        schemaVersion: 1 as const,
        commandId: input.commandId,
        managementRunId: input.managementRunId,
        idempotencyKey: input.idempotencyKey,
      };
      const worker = connectedWorker(connectionId, input.workerId, workersById, workerIdByConnection);
      if (!worker) return { ...base, disposition: 'rejected' };
      try {
        await dependencies.kernel.authorizeWrite(input);
      } catch {
        return { ...base, disposition: 'rejected' };
      }
      const invocation = await dependencies.management.invocations.getByIdempotencyKey({
        managementRunId: input.managementRunId,
        idempotencyKey: input.idempotencyKey,
      });
      if (invocation) return { ...base, disposition: 'existing', resultReferenceId: invocation.id };
      const handoff = await dependencies.management.handoffs.getByIdempotencyKey({
        managementRunId: input.managementRunId,
        idempotencyKey: input.idempotencyKey,
      });
      if (handoff) return { ...base, disposition: 'existing', resultReferenceId: handoff.id };
      const event = (await dependencies.management.events.list(input.managementRunId))
        .find((record) => record.event.idempotencyKey === input.idempotencyKey);
      return event
        ? { ...base, disposition: 'existing', resultReferenceId: event.event.id }
        : { ...base, disposition: 'rejected' };
    },
  };
}

export type DeviceWorkerScheduler = ReturnType<typeof createDeviceWorkerScheduler>;

async function releaseWorkerLease(
  connectionId: string,
  input: ManagementLeaseReleaseV1 | ManagementWorkerAbortV1,
  dependencies: DeviceWorkerSchedulerDependencies,
  workersById: Map<string, RegisteredWorker>,
  workerIdByConnection: Map<string, string>,
): Promise<ManagementLeaseReleaseAckV1> {
  const worker = connectedWorker(connectionId, input.workerId, workersById, workerIdByConnection);
  if (!worker) return failure('MANAGEMENT_WORKER_CONNECTION_MISMATCH', false);
  try {
    const lease = await dependencies.kernel.releaseLease(input);
    worker.activeRunIds.delete(input.managementRunId);
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

function connectedWorker(
  connectionId: string,
  workerId: string,
  workersById: Map<string, RegisteredWorker>,
  workerIdByConnection: Map<string, string>,
): RegisteredWorker | undefined {
  if (workerIdByConnection.get(connectionId) !== workerId) return undefined;
  const worker = workersById.get(workerId);
  return worker?.connected && worker.connectionId === connectionId ? worker : undefined;
}

async function removeExpiredCapacity(
  workers: Iterable<RegisteredWorker>,
  management: ManagementRepositories,
  now: number,
): Promise<void> {
  for (const worker of workers) {
    for (const runId of worker.activeRunIds) {
      const lease = await management.leases.get(runId);
      if (inspectManagerLease(lease ?? undefined, now).kind !== 'active') worker.activeRunIds.delete(runId);
    }
  }
}

function effectiveActiveLeaseCount(worker: RegisteredWorker): number {
  return Math.max(worker.capability.capacity.activeLeaseCount, worker.activeRunIds.size);
}

function credentialReady(capability: ManagementWorkerCapability, requireProduction: boolean): boolean {
  return requireProduction
    ? capability.credentialStatus === 'production_ready'
    : capability.credentialStatus !== 'unavailable';
}

function supportsManagementPhase(capability: ManagementWorkerCapability, phase: 1 | 2): boolean {
  return capability.supportedPhases.some((candidate) => candidate === phase);
}

function compareWorkers(left: RegisteredWorker, right: RegisteredWorker): number {
  const leftLoad = effectiveActiveLeaseCount(left) / left.capability.capacity.maxConcurrentLeases;
  const rightLoad = effectiveActiveLeaseCount(right) / right.capability.capacity.maxConcurrentLeases;
  return leftLoad - rightLoad || left.deviceId.localeCompare(right.deviceId) || left.workerId.localeCompare(right.workerId);
}

function workerIdentity(teamId: string, deviceId: string, profileId: string, workerInstanceId: string): string {
  return [teamId, deviceId, profileId, workerInstanceId].join('\u0000');
}

function normalizePositiveDuration(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function schedulerFailure(error: unknown): ManagementWorkerFailureV1 {
  const diagnosticCode = error instanceof ManagementConflictError
    ? error.code
    : error instanceof Error && /^[A-Z0-9_:-]{1,100}$/.test(error.message)
      ? error.message
      : 'MANAGEMENT_WORKER_INTERNAL_ERROR';
  const unauthorized = diagnosticCode.startsWith('LEASE_');
  return failure(diagnosticCode, diagnosticCode.includes('ACTIVE') || diagnosticCode.includes('TIMEOUT'), unauthorized ? 'NOT_AUTHORIZED' : diagnosticCode.includes('CONFLICT') ? 'CONFLICT' : 'INVALID_REQUEST');
}

function failure(
  diagnosticCode: string,
  retryable: boolean,
  errorCode: ManagementWorkerFailureV1['errorCode'] = 'UNAVAILABLE',
): ManagementWorkerFailureV1 {
  return { schemaVersion: 1, ok: false, errorCode, diagnosticCode, retryable };
}

function toolFailure(input: ManagementToolRequest, diagnosticCode: string): ManagementToolResult {
  return {
    schemaVersion: input.schemaVersion,
    ...('managementPhase' in input ? { managementPhase: 2 as const } : {}),
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
