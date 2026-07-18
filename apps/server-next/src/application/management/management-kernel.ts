import { createHash } from 'node:crypto';
import type {
  AutoPlacementResolutionDto,
  ManagementBudgetDto,
  ManagementEventPayloadMapV1,
  ManagementEventTypeV1,
  ManagementRunDto,
  ManagerPlacementPolicyDto,
} from '../../../../../packages/contracts/src/index.js';
import {
  authorizeManagerLeaseWrite,
  evaluateManagerLeaseAcquire,
  evaluateManagerLeaseRelease,
  evaluateManagerLeaseRenew,
  inspectManagerLease,
  type ManagerLeaseAuthorizationFailure,
  type ManagerLeaseAuthorizationProof,
  type ManagerLeaseHost,
} from '../../../../../packages/domain/src/index.js';
import type { ManagementEventRecord, ManagementRepositories } from '../management-repositories.js';
import type { ManagementRunRecord } from '../management-repositories.js';
import type { ManagementUnitOfWork } from '../management-unit-of-work.js';
import {
  hashManagementEventPayload,
  parseMemoryToolManagementEvent,
  parsePhase1ManagementEvent,
} from './management-event-validator.js';

export class ManagementConflictError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface ManagementKernelDependencies {
  readonly repositories: ManagementRepositories;
  readonly unitOfWork: ManagementUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

export interface CreateOrResumeManagementRunInput {
  readonly teamId: string;
  readonly initiatedByUserId?: string;
  readonly channelId: string;
  readonly rootTaskId?: string;
  readonly rootMessageId: string;
  readonly frozenTarget?: ManagementRunDto['frozenTarget'];
  readonly requestKey: string;
  readonly requestHash: string;
  readonly placementPolicy: ManagerPlacementPolicyDto;
  readonly budget: ManagementBudgetDto;
  readonly managementPhase?: 1 | 2 | 3;
  /** placement='auto' 的解析结果（#647）：随 run-started 事件冻结；幂等重放不重复写入。 */
  readonly autoPlacement?: AutoPlacementResolutionDto;
}

export interface LeaseAuthorityInput {
  readonly managementRunId: string;
  readonly workerId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export interface RecordMemoryToolReceiptInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
  readonly toolName: 'memory.create_capsule' | 'memory.propose_candidate' | 'memory.link_sources';
  readonly resultReferenceId: string;
  readonly requestHash: string;
  readonly output: NonNullable<ManagementEventPayloadMapV1['memory-tool-completed']['output']>;
}

export interface InspectMemoryToolReceiptInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
  readonly toolName: 'memory.create_capsule' | 'memory.propose_candidate' | 'memory.link_sources';
  readonly requestHash: string;
}

export type InspectMemoryToolReceiptResult = { readonly disposition: 'new' } | {
  readonly disposition: 'existing';
  readonly resultReferenceId: string;
  readonly output: NonNullable<ManagementEventPayloadMapV1['memory-tool-completed']['output']>;
};

export function createManagementKernel(dependencies: ManagementKernelDependencies) {
  const { repositories, unitOfWork, clock, ids } = dependencies;

  async function inspectMemoryToolReceiptInTransaction(
    transactionRepositories: ManagementRepositories,
    input: InspectMemoryToolReceiptInput,
  ): Promise<InspectMemoryToolReceiptResult> {
    await authorizeManagementWrite(transactionRepositories, input.authority, clock.now());
    const existing = (await transactionRepositories.events.list(input.authority.managementRunId))
      .find(({ event }) => event.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.event.type !== 'memory-tool-completed'
        || existing.event.payload.toolName !== input.toolName
        || existing.event.payload.requestHash !== input.requestHash) {
        throw new ManagementConflictError('MANAGEMENT_EVENT_IDEMPOTENCY_CONFLICT');
      }
      if (existing.event.payload.output === undefined) {
        throw new ManagementConflictError('MEMORY_TOOL_RECEIPT_OUTPUT_UNAVAILABLE');
      }
      return { disposition: 'existing', resultReferenceId: existing.event.payload.resultReferenceId,
        output: structuredClone(existing.event.payload.output) };
    }
    const run = await requireRun(transactionRepositories, input.authority.managementRunId);
    assertMemoryToolRunWritable(run);
    return { disposition: 'new' };
  }

  async function recordMemoryToolReceiptInTransaction(
    transactionRepositories: ManagementRepositories,
    input: RecordMemoryToolReceiptInput,
  ): Promise<ManagementEventRecord> {
    const now = clock.now();
    await authorizeManagementWrite(transactionRepositories, input.authority, now);
    const payload = { toolName: input.toolName, resultReferenceId: input.resultReferenceId,
      requestHash: input.requestHash, output: structuredClone(input.output) } as const;
    const payloadHash = hashManagementEventPayload({ type: 'memory-tool-completed', payload });
    const existing = (await transactionRepositories.events.list(input.authority.managementRunId))
      .find(({ event }) => event.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.event.type === 'memory-tool-completed' && existing.payloadHash === payloadHash) return existing;
      throw new ManagementConflictError('MANAGEMENT_EVENT_IDEMPOTENCY_CONFLICT');
    }
    const run = await requireRun(transactionRepositories, input.authority.managementRunId);
    assertMemoryToolRunWritable(run);
    return appendValidatedManagementEventInTransaction(transactionRepositories, {
      managementRunId: input.authority.managementRunId,
      type: 'memory-tool-completed', actorKind: 'manager', actorId: input.authority.workerId,
      idempotencyKey: input.idempotencyKey, payload,
    }, now, ids, { payloadHash, parseEvent: parseMemoryToolManagementEvent });
  }

  return {
    async createOrResumeRun(input: CreateOrResumeManagementRunInput): Promise<{ run: ManagementRunRecord; disposition: 'created' | 'existing' }> {
      return unitOfWork.run(async (transactionRepositories) => {
        if (!input.requestKey || !input.requestHash) throw new ManagementConflictError('MANAGEMENT_REQUEST_INVALID');
        const existing = await transactionRepositories.reservations.getByRequestKey({ teamId: input.teamId, requestKey: input.requestKey });
        if (existing) {
          if (existing.requestHash !== input.requestHash) throw new ManagementConflictError('MANAGEMENT_REQUEST_CONFLICT');
          const run = await transactionRepositories.runs.getById(existing.managementRunId);
          if (!run) throw new ManagementConflictError('MANAGEMENT_RESERVATION_ORPHANED');
          return { run, disposition: 'existing' as const };
        }

        const now = clock.now();
        const managementRunId = ids.nextId();
        const eventId = ids.nextId();
        if ((input.managementPhase === 2 || input.managementPhase === 3) && !input.rootTaskId) {
          throw new ManagementConflictError('MANAGEMENT_ROOT_TASK_REQUIRED');
        }
        const common = {
          id: managementRunId,
          teamId: input.teamId,
          initiatedByUserId: input.initiatedByUserId,
          channelId: input.channelId,
          rootTaskId: input.rootTaskId,
          rootMessageId: input.rootMessageId,
          frozenTarget: input.frozenTarget,
          mode: 'managed' as const,
          status: 'queued' as const,
          placementPolicy: input.placementPolicy,
          checkpointRevision: 0,
          budget: input.budget,
          createdAt: now,
          updatedAt: now,
        };
        const run: ManagementRunRecord = input.managementPhase === 2
          ? { schemaVersion: 2, managementPhase: 2, ...common, rootTaskId: input.rootTaskId!,
              ...(input.frozenTarget ? {
                mainAgentId: input.frozenTarget.agentId,
                activeAgentId: input.frozenTarget.agentId,
              } : {}),
              collaborationMode: input.frozenTarget ? 'single-agent' : 'manager-orchestrated' }
          : input.managementPhase === 3
          ? { schemaVersion: 2, managementPhase: 3, ...common, rootTaskId: input.rootTaskId!,
              ...(input.frozenTarget ? {
                mainAgentId: input.frozenTarget.agentId,
                activeAgentId: input.frozenTarget.agentId,
              } : {}),
              collaborationMode: input.frozenTarget ? 'single-agent' : 'manager-orchestrated' }
          : { schemaVersion: 1, ...common };
        const event = parsePhase1ManagementEvent({
          schemaVersion: 1,
          id: eventId,
          managementRunId,
          sequence: 1,
          type: 'run-started',
          actorKind: 'system',
          idempotencyKey: `run-started:${input.requestKey}`,
          payload: { rootMessageId: input.rootMessageId, ...(input.rootTaskId && { rootTaskId: input.rootTaskId }), mode: 'managed',
            ...(input.autoPlacement && { autoPlacement: input.autoPlacement }) },
          createdAt: now,
        });
        await transactionRepositories.reservations.create({ id: ids.nextId(), teamId: input.teamId, requestKey: input.requestKey, requestHash: input.requestHash, managementRunId, createdAt: now });
        await transactionRepositories.runs.create(run);
        await transactionRepositories.events.append({ event, payloadHash: hashManagementEventPayload(event) });
        return { run, disposition: 'created' as const };
      });
    },

    async acquireLease(input: { managementRunId: string; workerId: string; host: ManagerLeaseHost; leaseToken: string; ttlMs: number }) {
      return unitOfWork.run(async (transactionRepositories) => {
        if (!input.leaseToken) throw new ManagementConflictError('LEASE_INVALID_LEASE_STATE');
        const run = await requireRun(transactionRepositories, input.managementRunId);
        if (isTerminalRun(run)) throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
        const now = clock.now();
        const tokenHash = hashSecret(input.leaseToken);
        const currentLease = (await transactionRepositories.leases.get(input.managementRunId)) ?? undefined;
        const decision = evaluateManagerLeaseAcquire({
          current: currentLease,
          managementRunId: input.managementRunId,
          workerId: input.workerId,
          host: input.host,
          leaseTokenHash: tokenHash,
          leaseFingerprint: tokenHash.slice(0, 16),
          now,
          ttlMs: input.ttlMs,
        });
        if (decision.kind === 'rejected') throw new ManagementConflictError(`LEASE_${decision.reason.toUpperCase().replaceAll('-', '_')}`);
        if (decision.kind === 'existing') return { lease: decision.lease, disposition: 'existing' as const };
        if ((decision.reason === 'expired-same-host' || decision.reason === 'expired-cross-host') && currentLease) {
          await appendManagementEventInTransaction(transactionRepositories, {
            managementRunId: input.managementRunId,
            type: 'worker-lost',
            actorKind: 'system',
            idempotencyKey: `worker-lost:${currentLease.fencingToken}`,
            payload: {
              workerId: currentLease.workerId,
              lastHeartbeatAt: currentLease.heartbeatAt,
              reasonCode: 'LEASE_EXPIRED',
            },
          }, now, ids);
        }
        await transactionRepositories.leases.put(decision.lease);
        await transactionRepositories.runs.update({ ...run, status: 'running', activeWorkerId: input.workerId, updatedAt: now });
        await appendManagementEventInTransaction(transactionRepositories, {
          managementRunId: input.managementRunId,
          type: 'worker-leased',
          actorKind: 'system',
          idempotencyKey: `worker-leased:${decision.lease.fencingToken}`,
          payload: { workerId: input.workerId, leaseFingerprint: decision.lease.leaseFingerprint, expiresAt: decision.lease.expiresAt },
        }, now, ids);
        return { lease: decision.lease, disposition: 'granted' as const };
      });
    },

    async renewLease(input: LeaseAuthorityInput & { ttlMs: number }) {
      return unitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        const run = await requireRun(transactionRepositories, input.managementRunId);
        if (isTerminalRun(run)) throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
        const lease = (await transactionRepositories.leases.get(input.managementRunId)) ?? undefined;
        const decision = evaluateManagerLeaseRenew({ lease, proof: proof(input), now, ttlMs: input.ttlMs });
        if (decision.kind === 'rejected') throw leaseError(decision.reason);
        await transactionRepositories.leases.put(decision.lease);
        return decision.lease;
      });
    },

    async releaseLease(input: LeaseAuthorityInput & { reasonCode: string }) {
      return unitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        const lease = (await transactionRepositories.leases.get(input.managementRunId)) ?? undefined;
        const decision = evaluateManagerLeaseRelease({ lease, proof: proof(input), now });
        if (decision.kind === 'rejected') throw leaseError(decision.reason);
        if (decision.kind === 'already-released') return decision.lease;
        const run = await requireRun(transactionRepositories, input.managementRunId);
        await transactionRepositories.leases.put(decision.lease);
        const preserveStatus = isTerminalRun(run) || run.status === 'in_review' || run.status === 'waiting_for_user';
        await transactionRepositories.runs.update({ ...run, status: preserveStatus ? run.status : 'recovering', activeWorkerId: undefined, updatedAt: now });
        await appendManagementEventInTransaction(transactionRepositories, {
          managementRunId: input.managementRunId,
          type: 'worker-lost',
          actorKind: 'system',
          idempotencyKey: `worker-lost:${decision.lease.fencingToken}`,
          payload: { workerId: input.workerId, lastHeartbeatAt: decision.lease.heartbeatAt, reasonCode: input.reasonCode },
        }, now, ids);
        return decision.lease;
      });
    },

    async expireLease(input: { managementRunId: string; reasonCode?: string }) {
      return unitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        const lease = await transactionRepositories.leases.get(input.managementRunId);
        if (!lease || inspectManagerLease(lease, now).kind !== 'expired') {
          return { expired: false as const, lease };
        }
        const run = await requireRun(transactionRepositories, input.managementRunId);
        await appendManagementEventInTransaction(transactionRepositories, {
          managementRunId: input.managementRunId,
          type: 'worker-lost',
          actorKind: 'system',
          idempotencyKey: `worker-lost:${lease.fencingToken}`,
          payload: {
            workerId: lease.workerId,
            lastHeartbeatAt: lease.heartbeatAt,
            reasonCode: input.reasonCode ?? 'LEASE_EXPIRED',
          },
        }, now, ids);
        if (!isTerminalRun(run)) {
          await transactionRepositories.runs.update({ ...run, status: 'recovering', activeWorkerId: undefined, updatedAt: now });
        }
        return { expired: true as const, lease };
      });
    },

    async appendEvent<T extends ManagementEventTypeV1>(input: {
      authority: LeaseAuthorityInput;
      type: T;
      actorKind: 'manager' | 'agent' | 'human';
      actorId?: string;
      idempotencyKey: string;
      causationEventId?: string;
      payload: ManagementEventPayloadMapV1[T];
    }): Promise<ManagementEventRecord> {
      return unitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        await authorizeManagementWrite(transactionRepositories, input.authority, now);
        const run = await requireRun(transactionRepositories, input.authority.managementRunId);
        if (isTerminalRun(run)) {
          const events = await transactionRepositories.events.list(run.id);
          const existing = events.find(({ event }) => event.idempotencyKey === input.idempotencyKey);
          const candidateHash = hashManagementEventPayload({ type: input.type, payload: input.payload } as Pick<ReturnType<typeof parsePhase1ManagementEvent>, 'type' | 'payload'>);
          if (existing && existing.event.type === input.type && existing.payloadHash === candidateHash) return existing;
          throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
        }
        const record = await appendManagementEventInTransaction(transactionRepositories, {
          managementRunId: input.authority.managementRunId,
          type: input.type,
          actorKind: input.actorKind,
          actorId: input.actorId,
          idempotencyKey: input.idempotencyKey,
          causationEventId: input.causationEventId,
          payload: input.payload,
        }, now, ids);
        await applyRunProjection(transactionRepositories, record, now);
        return record;
      });
    },

    async authorizeWrite(authority: LeaseAuthorityInput): Promise<void> {
      await authorizeManagementWrite(repositories, authority, clock.now());
    },

    async inspectMemoryToolReceipt(input: InspectMemoryToolReceiptInput): Promise<InspectMemoryToolReceiptResult> {
      return unitOfWork.run((transactionRepositories) =>
        inspectMemoryToolReceiptInTransaction(transactionRepositories, input));
    },

    async inspectMemoryToolReceiptInTransaction(
      transactionRepositories: ManagementRepositories,
      input: InspectMemoryToolReceiptInput,
    ): Promise<InspectMemoryToolReceiptResult> {
      return inspectMemoryToolReceiptInTransaction(transactionRepositories, input);
    },

    async recordMemoryToolReceipt(input: RecordMemoryToolReceiptInput): Promise<ManagementEventRecord> {
      return unitOfWork.run((transactionRepositories) =>
        recordMemoryToolReceiptInTransaction(transactionRepositories, input));
    },

    async recordMemoryToolReceiptInTransaction(
      transactionRepositories: ManagementRepositories,
      input: RecordMemoryToolReceiptInput,
    ): Promise<ManagementEventRecord> {
      return recordMemoryToolReceiptInTransaction(transactionRepositories, input);
    },

    async recordInvocationTerminal(input: {
      managementRunId: string;
      dispatchId: string;
      status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
      deliveryMessageId?: string;
      actorId?: string;
      errorCode?: string;
    }): Promise<ManagementRunRecord> {
      return unitOfWork.run(async (transactionRepositories) => {
        const run = await requireRun(transactionRepositories, input.managementRunId);
        if (isTerminalRun(run)) return run;
        if (input.status === 'succeeded' && run.rootTaskId) return run;
        const now = clock.now();
        const record = input.status === 'succeeded'
          ? await appendManagementEventInTransaction(transactionRepositories, {
              managementRunId: run.id,
              type: 'run-completed',
              actorKind: 'agent',
              ...(input.actorId ? { actorId: input.actorId } : {}),
              idempotencyKey: `run-terminal:${input.dispatchId}:succeeded`,
              payload: { deliveryMessageId: requireValue(input.deliveryMessageId, 'MANAGEMENT_DELIVERY_MESSAGE_REQUIRED') },
            }, now, ids)
          : input.status === 'cancelled'
            ? await appendManagementEventInTransaction(transactionRepositories, {
                managementRunId: run.id,
                type: 'run-cancelled',
                actorKind: input.actorId ? 'human' : 'system',
                ...(input.actorId ? { actorId: input.actorId } : {}),
                idempotencyKey: `run-terminal:${input.dispatchId}:cancelled`,
                payload: { reasonCode: input.errorCode ?? 'INVOCATION_CANCELLED', cancelledBy: input.actorId ?? 'system' },
              }, now, ids)
            : await appendManagementEventInTransaction(transactionRepositories, {
                managementRunId: run.id,
                type: 'run-failed',
                actorKind: 'system',
                idempotencyKey: `run-terminal:${input.dispatchId}:${input.status}`,
                payload: { errorCode: input.errorCode ?? (input.status === 'timed_out' ? 'DISPATCH_TIMEOUT' : 'DISPATCH_FAILED'), recoverable: false },
              }, now, ids);
        await applyRunProjection(transactionRepositories, record, now);
        return requireRun(transactionRepositories, run.id);
      });
    },

    async completeRunFromHumanTask(input: {
      managementRunId: string;
      taskId: string;
      userId: string;
      deliveryMessageId: string;
    }): Promise<ManagementRunRecord> {
      return unitOfWork.run(async (transactionRepositories) => {
        const run = await requireRun(transactionRepositories, input.managementRunId);
        if (run.rootTaskId !== input.taskId) throw new ManagementConflictError('MANAGEMENT_ROOT_TASK_MISMATCH');
        if (isTerminalRun(run)) return run;
        if (run.status !== 'in_review') throw new ManagementConflictError('MANAGEMENT_RUN_NOT_IN_REVIEW');
        const now = clock.now();
        const record = await appendManagementEventInTransaction(transactionRepositories, {
          managementRunId: run.id,
          type: 'run-completed',
          actorKind: 'human',
          actorId: input.userId,
          idempotencyKey: `run-completed:task:${input.taskId}`,
          payload: { completedTaskId: input.taskId, deliveryMessageId: input.deliveryMessageId },
        }, now, ids);
        await applyRunProjection(transactionRepositories, record, now);
        return requireRun(transactionRepositories, run.id);
      });
    },

    async failRun(input: {
      managementRunId: string;
      errorCode: string;
      idempotencyKey: string;
    }): Promise<ManagementRunRecord> {
      return unitOfWork.run(async (transactionRepositories) => {
        const run = await requireRun(transactionRepositories, input.managementRunId);
        if (isTerminalRun(run)) return run;
        const now = clock.now();
        const record = await appendManagementEventInTransaction(transactionRepositories, {
          managementRunId: run.id,
          type: 'run-failed',
          actorKind: 'system',
          idempotencyKey: input.idempotencyKey,
          payload: { errorCode: input.errorCode, recoverable: false },
        }, now, ids);
        await applyRunProjection(transactionRepositories, record, now);
        return requireRun(transactionRepositories, run.id);
      });
    },
  };
}

export async function appendManagementEventInTransaction<T extends ManagementEventTypeV1>(
  repositories: ManagementRepositories,
  input: { managementRunId: string; type: T; actorKind: 'system' | 'manager' | 'agent' | 'human'; actorId?: string; idempotencyKey: string; causationEventId?: string; payload: ManagementEventPayloadMapV1[T] },
  now: number,
  ids: { nextId(): string },
): Promise<ManagementEventRecord> {
  const payloadHash = hashManagementEventPayload({
    type: input.type,
    payload: input.payload,
  } as Pick<ReturnType<typeof parsePhase1ManagementEvent>, 'type' | 'payload'>);
  return appendValidatedManagementEventInTransaction(
    repositories,
    input,
    now,
    ids,
    { payloadHash, parseEvent: parsePhase1ManagementEvent },
  );
}

export async function appendValidatedManagementEventInTransaction<T extends ManagementEventTypeV1>(
  repositories: ManagementRepositories,
  input: { managementRunId: string; type: T; actorKind: 'system' | 'manager' | 'agent' | 'human'; actorId?: string; idempotencyKey: string; causationEventId?: string; payload: ManagementEventPayloadMapV1[T] },
  now: number,
  ids: { nextId(): string },
  validation: { payloadHash: string; parseEvent(input: unknown): ReturnType<typeof parsePhase1ManagementEvent> },
): Promise<ManagementEventRecord> {
  const events = await repositories.events.list(input.managementRunId);
  const existing = events.find(({ event }) => event.idempotencyKey === input.idempotencyKey);
  if (existing) {
    if (existing.event.type === input.type && existing.payloadHash === validation.payloadHash) return existing;
    throw new ManagementConflictError('MANAGEMENT_EVENT_IDEMPOTENCY_CONFLICT');
  }
  const event = validation.parseEvent({
    schemaVersion: 1,
    id: ids.nextId(),
    managementRunId: input.managementRunId,
    sequence: (events.at(-1)?.event.sequence ?? 0) + 1,
    type: input.type,
    actorKind: input.actorKind,
    ...(input.actorId && { actorId: input.actorId }),
    idempotencyKey: input.idempotencyKey,
    ...(input.causationEventId && { causationEventId: input.causationEventId }),
    payload: input.payload,
    createdAt: now,
  });
  return repositories.events.append({ event, payloadHash: validation.payloadHash });
}

export async function authorizeManagementWrite(repositories: ManagementRepositories, authority: LeaseAuthorityInput, now: number): Promise<void> {
  const lease = (await repositories.leases.get(authority.managementRunId)) ?? undefined;
  const decision = authorizeManagerLeaseWrite({ lease, proof: proof(authority), now });
  if (decision.kind === 'rejected') throw leaseError(decision.reason);
}

async function applyRunProjection(repositories: ManagementRepositories, record: ManagementEventRecord, now: number): Promise<void> {
  const run = await requireRun(repositories, record.event.managementRunId);
  const terminal = record.event.type === 'run-completed' ? 'completed' : record.event.type === 'run-failed' ? 'failed' : record.event.type === 'run-cancelled' ? 'cancelled' : undefined;
  const status = terminal
    ?? (record.event.type === 'waiting-for-user'
      ? 'waiting_for_user'
      : record.event.type === 'root-delivery-submitted'
        ? 'in_review'
        : run.status);
  if (status !== run.status) await repositories.runs.update({ ...run, status, updatedAt: now, ...(terminal && { completedAt: now }) });
}

async function requireRun(repositories: ManagementRepositories, managementRunId: string): Promise<ManagementRunRecord> {
  const run = await repositories.runs.getById(managementRunId);
  if (!run) throw new ManagementConflictError('MANAGEMENT_RUN_NOT_FOUND');
  return run;
}

function proof(input: LeaseAuthorityInput): ManagerLeaseAuthorizationProof {
  return { managementRunId: input.managementRunId, workerId: input.workerId, presentedLeaseTokenHash: hashSecret(input.leaseToken), fencingToken: input.fencingToken };
}
function hashSecret(secret: string): string { return createHash('sha256').update(secret).digest('hex'); }
function leaseError(reason: ManagerLeaseAuthorizationFailure): ManagementConflictError { return new ManagementConflictError(`LEASE_${reason.toUpperCase().replaceAll('-', '_')}`); }
function isTerminalRun(run: ManagementRunRecord): boolean { return run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled'; }

function assertMemoryToolRunWritable(run: ManagementRunRecord): void {
  if (isTerminalRun(run)) throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
}
function requireValue(value: string | undefined, code: string): string { if (!value) throw new ManagementConflictError(code); return value; }
