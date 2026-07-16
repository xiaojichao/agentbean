import {
  parseManagementWorkerPayload,
  parseManagementWorkerRegisterV2,
  type ManagementWorkerFailureV1,
  type ManagementWorkerRegisterV1,
  type ManagementWorkerRegisterV2,
} from '../../../../../packages/contracts/src/index.js';

type ManagementWorkerCapability = ManagementWorkerRegisterV1 | ManagementWorkerRegisterV2;

export interface ServerWorkerPoolDependencies {
  readonly workerPoolId: string;
  readonly providerCredentialRef: string;
  readonly heartbeatTimeoutMs?: number;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

interface RegisteredServerWorker {
  readonly workerId: string;
  readonly workerInstanceId: string;
  readonly workerPoolId: string;
  readonly profileId: string;
  connectionId: string;
  connected: boolean;
  capability: ManagementWorkerCapability;
  untrackedActiveLeaseCount: number;
  lastHeartbeatAt: number;
  readonly activeManagementRunIds: Set<string>;
}

interface QueuedCapacityRequest {
  readonly managementRunId: string;
  readonly teamId: string;
  readonly profileId: string;
  readonly enqueuedAt: number;
  readonly reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED';
}

export function createServerWorkerPool(dependencies: ServerWorkerPoolDependencies) {
  const heartbeatTimeoutMs = dependencies.heartbeatTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs <= 0) {
    throw new Error('Server Worker heartbeat timeout must be a positive integer');
  }
  const workersById = new Map<string, RegisteredServerWorker>();
  const workersByIdentity = new Map<string, RegisteredServerWorker>();
  const workerIdByConnection = new Map<string, string>();
  const workerIdByManagementRun = new Map<string, string>();
  const staleWorkerIdByManagementRun = new Map<string, string>();
  const capacityRequestByManagementRun = new Map<string, Omit<QueuedCapacityRequest, 'enqueuedAt' | 'reasonCode'>>();
  const queueByManagementRun = new Map<string, QueuedCapacityRequest>();

  function registerWorker(input: { readonly connectionId: string; readonly capability: ManagementWorkerCapability }) {
    const capability = parseCapability(input.capability);
    if (!capability) return failure('INVALID_REQUEST', 'SERVER_WORKER_CAPABILITY_INVALID', false);
    if (capability.host?.kind !== 'server') {
      return failure('NOT_AUTHORIZED', 'SERVER_WORKER_HOST_REQUIRED', false);
    }
    if (capability.host.workerPoolId !== dependencies.workerPoolId) {
      return failure('NOT_AUTHORIZED', 'SERVER_WORKER_POOL_MISMATCH', false);
    }
    if (capability.providerCredentialRef !== dependencies.providerCredentialRef) {
      return failure('NOT_AUTHORIZED', 'SERVER_WORKER_CREDENTIAL_REFERENCE_MISMATCH', false);
    }
    if (capability.credentialStatus !== 'production_ready') {
      return failure('UNAVAILABLE', 'SERVER_WORKER_CREDENTIAL_UNAVAILABLE', true);
    }
    if (capability.capacity.maxConcurrentLeases < 1
      || capability.capacity.activeLeaseCount < 0
      || capability.capacity.activeLeaseCount > capability.capacity.maxConcurrentLeases) {
      return failure('INVALID_REQUEST', 'SERVER_WORKER_CAPACITY_INVALID', false);
    }

    const identity = JSON.stringify([dependencies.workerPoolId, capability.profileId, capability.workerInstanceId]);
    const existing = workersByIdentity.get(identity);
    if (existing
      && existing.capability.capacity.maxConcurrentLeases !== capability.capacity.maxConcurrentLeases) {
      return failure('CONFLICT', 'SERVER_WORKER_FIXED_CAPACITY_MISMATCH', false);
    }
    const worker: RegisteredServerWorker = existing ?? {
      workerId: dependencies.ids.nextId(),
      workerInstanceId: capability.workerInstanceId,
      workerPoolId: dependencies.workerPoolId,
      profileId: capability.profileId,
      connectionId: input.connectionId,
      connected: true,
      capability,
      untrackedActiveLeaseCount: capability.capacity.activeLeaseCount,
      lastHeartbeatAt: dependencies.clock.now(),
      activeManagementRunIds: new Set(),
    };
    if (existing) workerIdByConnection.delete(existing.connectionId);
    worker.connectionId = input.connectionId;
    worker.connected = true;
    worker.capability = capability;
    worker.untrackedActiveLeaseCount = Math.max(
      0,
      capability.capacity.activeLeaseCount - worker.activeManagementRunIds.size,
    );
    worker.lastHeartbeatAt = dependencies.clock.now();
    workersById.set(worker.workerId, worker);
    workersByIdentity.set(identity, worker);
    workerIdByConnection.set(input.connectionId, worker.workerId);
    return { schemaVersion: 1 as const, ok: true as const, workerId: worker.workerId, protocolVersion: 1 as const };
  }

  function heartbeat(input: {
    readonly connectionId: string;
    readonly workerInstanceId: string;
    readonly activeLeaseCount: number;
  }) {
    const workerId = workerIdByConnection.get(input.connectionId);
    const worker = workerId ? workersById.get(workerId) : undefined;
    if (!worker || worker.connectionId !== input.connectionId || !worker.connected) {
      return failure('NOT_AUTHORIZED', 'SERVER_WORKER_CONNECTION_STALE', false);
    }
    if (worker.workerInstanceId !== input.workerInstanceId) {
      return failure('NOT_AUTHORIZED', 'SERVER_WORKER_INSTANCE_MISMATCH', false);
    }
    if (!Number.isSafeInteger(input.activeLeaseCount) || input.activeLeaseCount < 0
      || input.activeLeaseCount > worker.capability.capacity.maxConcurrentLeases) {
      return failure('INVALID_REQUEST', 'SERVER_WORKER_CAPACITY_INVALID', false);
    }
    worker.untrackedActiveLeaseCount = Math.max(0, input.activeLeaseCount - worker.activeManagementRunIds.size);
    worker.lastHeartbeatAt = dependencies.clock.now();
    return {
      schemaVersion: 1 as const,
      ok: true as const,
      workerId: worker.workerId,
      connected: true as const,
      activeLeaseCount: input.activeLeaseCount,
      lastHeartbeatAt: worker.lastHeartbeatAt,
    };
  }

  function disconnect(connectionId: string): { readonly workerId?: string; readonly activeManagementRunIds: readonly string[] } {
    const workerId = workerIdByConnection.get(connectionId);
    if (!workerId) return { activeManagementRunIds: [] };
    workerIdByConnection.delete(connectionId);
    const worker = workersById.get(workerId);
    if (!worker || worker.connectionId !== connectionId) return { activeManagementRunIds: [] };
    worker.connected = false;
    const activeManagementRunIds = requeueWorkerReservations(worker, dependencies.clock.now());
    return { workerId, activeManagementRunIds };
  }

  function requestCapacity(input: {
    readonly managementRunId: string;
    readonly teamId: string;
    readonly profileId: string;
  }) {
    expireStaleWorkers();
    const assignedWorkerId = workerIdByManagementRun.get(input.managementRunId);
    if (assignedWorkerId) return assignment(input.managementRunId, requireWorker(assignedWorkerId));
    const capacityRequest = capacityRequestByManagementRun.get(input.managementRunId) ?? input;
    capacityRequestByManagementRun.set(input.managementRunId, capacityRequest);
    const candidates = [...workersById.values()].filter((worker) =>
      worker.connected
      && worker.profileId === input.profileId
      && effectiveActiveLeaseCount(worker) < worker.capability.capacity.maxConcurrentLeases,
    );
    candidates.sort((left, right) => {
      const load = effectiveActiveLeaseCount(left) / left.capability.capacity.maxConcurrentLeases
        - effectiveActiveLeaseCount(right) / right.capability.capacity.maxConcurrentLeases;
      return load || left.workerId.localeCompare(right.workerId);
    });
    const worker = candidates[0];
    if (!worker) {
      const queued = queueByManagementRun.get(input.managementRunId) ?? {
        ...capacityRequest,
        enqueuedAt: dependencies.clock.now(),
        reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED' as const,
      };
      queueByManagementRun.set(input.managementRunId, queued);
      return { kind: 'queued' as const, ...queued };
    }
    queueByManagementRun.delete(input.managementRunId);
    staleWorkerIdByManagementRun.delete(input.managementRunId);
    worker.activeManagementRunIds.add(input.managementRunId);
    workerIdByManagementRun.set(input.managementRunId, worker.workerId);
    return assignment(input.managementRunId, worker);
  }

  function releaseCapacity(input: { readonly workerId: string; readonly managementRunId: string }) {
    if (workerIdByManagementRun.get(input.managementRunId) !== input.workerId) {
      if (staleWorkerIdByManagementRun.get(input.managementRunId) !== input.workerId
        || !queueByManagementRun.has(input.managementRunId)) return { released: false as const };
      staleWorkerIdByManagementRun.delete(input.managementRunId);
      queueByManagementRun.delete(input.managementRunId);
      capacityRequestByManagementRun.delete(input.managementRunId);
      return { released: true as const };
    }
    workerIdByManagementRun.delete(input.managementRunId);
    workersById.get(input.workerId)?.activeManagementRunIds.delete(input.managementRunId);
    capacityRequestByManagementRun.delete(input.managementRunId);
    staleWorkerIdByManagementRun.delete(input.managementRunId);
    return { released: true as const };
  }

  function snapshot() {
    return {
      workers: [...workersById.values()].map((worker) => ({
        workerId: worker.workerId,
        workerInstanceId: worker.workerInstanceId,
        workerPoolId: worker.workerPoolId,
        profileId: worker.profileId,
        connected: worker.connected,
        runtimeVersion: worker.capability.runtimeVersion,
        supportedProtocolVersions: [...worker.capability.supportedProtocolVersions],
        supportedPhases: [...worker.capability.supportedPhases],
        providerId: worker.capability.providerId,
        modelId: worker.capability.modelId,
        providerCredentialRef: worker.capability.providerCredentialRef,
        capacity: {
          maxConcurrentLeases: worker.capability.capacity.maxConcurrentLeases,
          activeLeaseCount: effectiveActiveLeaseCount(worker),
        },
        lastHeartbeatAt: worker.lastHeartbeatAt,
      })),
      queue: [...queueByManagementRun.values()],
    };
  }

  function expireStaleWorkers(): readonly string[] {
    const now = dependencies.clock.now();
    const expiredWorkerIds: string[] = [];
    for (const worker of workersById.values()) {
      if (!worker.connected || now < worker.lastHeartbeatAt
        || now - worker.lastHeartbeatAt < heartbeatTimeoutMs) continue;
      worker.connected = false;
      if (workerIdByConnection.get(worker.connectionId) === worker.workerId) {
        workerIdByConnection.delete(worker.connectionId);
      }
      requeueWorkerReservations(worker, now);
      expiredWorkerIds.push(worker.workerId);
    }
    return expiredWorkerIds;
  }

  function requireWorker(workerId: string): RegisteredServerWorker {
    const worker = workersById.get(workerId);
    if (!worker) throw new Error('Server Worker reservation references a missing Worker');
    return worker;
  }

  function requeueWorkerReservations(worker: RegisteredServerWorker, enqueuedAt: number): readonly string[] {
    const activeManagementRunIds = [...worker.activeManagementRunIds];
    for (const managementRunId of activeManagementRunIds) {
      workerIdByManagementRun.delete(managementRunId);
      staleWorkerIdByManagementRun.set(managementRunId, worker.workerId);
      const capacityRequest = capacityRequestByManagementRun.get(managementRunId);
      if (capacityRequest) {
        queueByManagementRun.set(managementRunId, {
          ...capacityRequest,
          enqueuedAt,
          reasonCode: 'SERVER_WORKER_CAPACITY_EXHAUSTED',
        });
      }
    }
    worker.activeManagementRunIds.clear();
    return activeManagementRunIds;
  }

  return { registerWorker, heartbeat, disconnect, expireStaleWorkers, requestCapacity, releaseCapacity, snapshot };
}

export type ServerWorkerPool = ReturnType<typeof createServerWorkerPool>;

function parseCapability(value: ManagementWorkerCapability): ManagementWorkerCapability | undefined {
  try {
    return value.schemaVersion === 1
      ? parseManagementWorkerPayload('register', value)
      : parseManagementWorkerRegisterV2(value);
  } catch {
    return undefined;
  }
}

function effectiveActiveLeaseCount(worker: RegisteredServerWorker): number {
  return worker.untrackedActiveLeaseCount + worker.activeManagementRunIds.size;
}

function assignment(managementRunId: string, worker: RegisteredServerWorker) {
  return {
    kind: 'assigned' as const,
    managementRunId,
    workerId: worker.workerId,
    workerPoolId: worker.workerPoolId,
    profileId: worker.profileId,
  };
}

function failure(
  errorCode: ManagementWorkerFailureV1['errorCode'],
  diagnosticCode: string,
  retryable: boolean,
): ManagementWorkerFailureV1 {
  return { schemaVersion: 1, ok: false, errorCode, diagnosticCode, retryable };
}
