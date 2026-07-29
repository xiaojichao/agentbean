import { createHash } from 'node:crypto';

import {
  authorizeManagerLeaseWrite,
  evaluateManagerLeaseAcquire,
  evaluateManagerLeaseRelease,
  inspectManagerLease,
} from '../../../../../packages/domain/src/index.js';
import type { TaskCoordinationTransactionRepositories, TaskCoordinationUnitOfWork } from '../task-coordination-unit-of-work.js';
import {
  appendManagementEventInTransaction,
  ManagementConflictError,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import { hashManagementCheckpointAuthoritative } from './management-checkpoint.js';

interface PiOrchestrationRuntimeDependencies {
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

type PiOrchestrationCommand = {
  readonly kind: 'wait';
  readonly reasonCode: string;
  readonly eligibleAt: number;
  readonly deadline?: { readonly kind: string; readonly dueAt: number };
};

export interface CommitPiOrchestrationCommandInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
  readonly expectedRunRevision: number;
  readonly expectedSchedulingRevision: number;
  readonly command: PiOrchestrationCommand;
  /**
   * #925 等后续切片在同一个 trusted application UoW 内提交 Task/DAG 事实的组合接缝。
   * transport 不得传入 callback；本切片只证明事务边界，不定义 DAG/Offer 细节。
   */
  readonly applyTaskChanges?: (
    repositories: TaskCoordinationTransactionRepositories,
  ) => Promise<void>;
}

export function createPiOrchestrationRuntime(dependencies: PiOrchestrationRuntimeDependencies) {
  return {
    async dequeueRunnable(input: {
      readonly workerId: string;
      readonly workerPoolId: string;
      readonly profileId: string;
      readonly leaseToken: string;
      readonly ttlMs: number;
    }) {
      return dependencies.unitOfWork.run(async (repositories) => {
        const now = dependencies.clock.now();
        const candidates = await repositories.management.scheduling.listRunnable(now);
        for (const scheduling of candidates) {
          const run = await repositories.management.runs.getById(scheduling.managementRunId);
          if (!run || !run.rootTaskId || run.recoveryState === 'recovery_pending' || isTerminal(run.status)) continue;
          const claim = await repositories.management.orchestrationClaims.getByRunId(run.id);
          if (!claim || claim.state !== 'active' || claim.rootTaskId !== run.rootTaskId) continue;
          const currentLease = await repositories.management.leases.get(run.id);
          const leaseStatus = inspectManagerLease(currentLease ?? undefined, now);
          if (leaseStatus.kind === 'active' || leaseStatus.kind === 'invalid') continue;
          const tokenHash = sha256(input.leaseToken);
          const decision = evaluateManagerLeaseAcquire({
            current: currentLease ?? undefined,
            managementRunId: run.id,
            workerId: input.workerId,
            host: { kind: 'server', workerPoolId: input.workerPoolId, profileId: input.profileId },
            leaseTokenHash: tokenHash,
            leaseFingerprint: tokenHash.slice(0, 16),
            now,
            ttlMs: input.ttlMs,
          });
          if (decision.kind === 'rejected') continue;
          if (decision.kind === 'existing') {
            return {
              managementRunId: run.id,
              rootTaskId: run.rootTaskId,
              runRevision: orchestrationRevision(run),
              lease: decision.lease,
            };
          }
          if (currentLease && (leaseStatus.kind === 'expired' || leaseStatus.kind === 'released')) {
            await appendManagementEventInTransaction(repositories.management, {
              managementRunId: run.id,
              type: 'worker-lost',
              actorKind: 'system',
              idempotencyKey: `worker-lost:${currentLease.fencingToken}`,
              payload: {
                workerId: currentLease.workerId,
                lastHeartbeatAt: currentLease.heartbeatAt,
                reasonCode: leaseStatus.kind === 'expired' ? 'LEASE_EXPIRED' : 'LEASE_RELEASED',
              },
            }, now, dependencies.ids);
          }
          const runRevision = orchestrationRevision(run) + 1;
          await repositories.management.leases.put(decision.lease);
          await repositories.management.runs.update({
            ...run,
            status: 'running',
            activeWorkerId: input.workerId,
            orchestrationRevision: runRevision,
            recoveryState: 'healthy',
            updatedAt: now,
          });
          await appendManagementEventInTransaction(repositories.management, {
            managementRunId: run.id,
            type: 'worker-leased',
            actorKind: 'system',
            idempotencyKey: `worker-leased:${decision.lease.fencingToken}`,
            payload: {
              workerId: input.workerId,
              leaseFingerprint: decision.lease.leaseFingerprint,
              expiresAt: decision.lease.expiresAt,
            },
          }, now, dependencies.ids);
          return {
            managementRunId: run.id,
            rootTaskId: run.rootTaskId,
            runRevision,
            lease: decision.lease,
          };
        }
        return null;
      });
    },

    async commitCommand(input: CommitPiOrchestrationCommandInput) {
      const commandHash = hashCommand(input);
      return dependencies.unitOfWork.run(async (repositories) => {
        const existing = await repositories.management.commandReceipts.getByIdempotencyKey({
          managementRunId: input.authority.managementRunId,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          if (existing.commandHash !== commandHash) {
            throw new ManagementConflictError('PI_COMMAND_IDEMPOTENCY_CONFLICT');
          }
          return {
            disposition: 'replayed' as const,
            receiptId: existing.id,
            runRevision: existing.runRevision,
            schedulingRevision: existing.schedulingRevision,
            eventSequence: existing.eventSequence,
          };
        }

        const now = dependencies.clock.now();
        const run = await requireRun(repositories, input.authority.managementRunId);
        if (run.recoveryState === 'recovery_pending') {
          throw new ManagementConflictError('PI_ORCHESTRATION_RECOVERY_PENDING');
        }
        const scheduling = await requireScheduling(repositories, run.id);
        const lease = await requireAuthorizedLease(repositories, input.authority, now);
        if (orchestrationRevision(run) !== input.expectedRunRevision) {
          throw new ManagementConflictError('PI_RUN_REVISION_CONFLICT');
        }
        if (scheduling.revision !== input.expectedSchedulingRevision) {
          throw new ManagementConflictError('PI_SCHEDULING_REVISION_CONFLICT');
        }

        await input.applyTaskChanges?.(repositories);

        const nextRunRevision = orchestrationRevision(run) + 1;
        const nextSchedulingRevision = scheduling.revision + 1;
        const receiptId = dependencies.ids.nextId();
        const nextScheduling = {
          ...scheduling,
          state: 'waiting' as const,
          eligibleAt: input.command.eligibleAt,
          revision: nextSchedulingRevision,
          waitingReason: input.command.reasonCode,
          updatedAt: now,
        };

        const released = evaluateManagerLeaseRelease({
          lease,
          proof: leaseProof(input.authority),
          now,
        });
        if (released.kind === 'rejected') throw leaseConflict(released.reason);
        await repositories.management.leases.put(released.lease);
        const deadline = input.command.deadline;
        if (deadline) {
          const current = (await repositories.management.deadlines.list(run.id))
            .find((item) => item.kind === deadline.kind);
          await repositories.management.deadlines.put({
            managementRunId: run.id,
            kind: deadline.kind,
            dueAt: deadline.dueAt,
            state: 'active',
            revision: (current?.revision ?? 0) + 1,
            createdAt: current?.createdAt ?? now,
            updatedAt: now,
          });
        }

        await repositories.management.scheduling.update(nextScheduling);
        await repositories.management.runs.update({
          ...run,
          status: 'waiting_for_agents',
          activeWorkerId: undefined,
          orchestrationRevision: nextRunRevision,
          recoveryState: 'healthy',
          updatedAt: now,
        });
        const event = await appendManagementEventInTransaction(repositories.management, {
          managementRunId: run.id,
          type: 'orchestration-command-committed',
          actorKind: 'manager',
          actorId: input.authority.workerId,
          idempotencyKey: `pi-command:${input.idempotencyKey}`,
          payload: {
            commandName: input.command.kind,
            runRevision: nextRunRevision,
            schedulingRevision: nextSchedulingRevision,
            receiptId,
          },
        }, now, dependencies.ids);
        await repositories.management.attemptAudits.append({
          id: dependencies.ids.nextId(),
          managementRunId: run.id,
          commandName: input.command.kind,
          idempotencyKey: input.idempotencyKey,
          workerId: input.authority.workerId,
          fencingToken: input.authority.fencingToken,
          decision: 'applied',
          createdAt: now,
        });
        await repositories.management.commandReceipts.create({
          id: receiptId,
          managementRunId: run.id,
          idempotencyKey: input.idempotencyKey,
          commandHash,
          outcome: 'applied',
          runRevision: nextRunRevision,
          schedulingRevision: nextSchedulingRevision,
          eventSequence: event.event.sequence,
          createdAt: now,
        });
        await repositories.management.outbox.create({
          id: dependencies.ids.nextId(),
          managementRunId: run.id,
          receiptId,
          eventSequence: event.event.sequence,
          state: 'pending',
          createdAt: now,
        });
        return {
          disposition: 'applied' as const,
          receiptId,
          runRevision: nextRunRevision,
          schedulingRevision: nextSchedulingRevision,
          eventSequence: event.event.sequence,
        };
      });
    },

    async wakeWaiting(input: {
      readonly managementRunId: string;
      readonly idempotencyKey: string;
      readonly expectedRunRevision: number;
      readonly expectedSchedulingRevision: number;
      readonly eligibleAt: number;
    }) {
      const commandHash = hashWakeCommand(input);
      return dependencies.unitOfWork.run(async (repositories) => {
        const existing = await repositories.management.commandReceipts.getByIdempotencyKey({
          managementRunId: input.managementRunId,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          if (existing.commandHash !== commandHash) {
            throw new ManagementConflictError('PI_COMMAND_IDEMPOTENCY_CONFLICT');
          }
          return {
            disposition: 'replayed' as const,
            receiptId: existing.id,
            runRevision: existing.runRevision,
            schedulingRevision: existing.schedulingRevision,
            eventSequence: existing.eventSequence,
          };
        }

        const now = dependencies.clock.now();
        const run = await requireRun(repositories, input.managementRunId);
        if (run.recoveryState === 'recovery_pending') {
          throw new ManagementConflictError('PI_ORCHESTRATION_RECOVERY_PENDING');
        }
        const claim = await repositories.management.orchestrationClaims.getByRunId(run.id);
        if (!claim || claim.state !== 'active' || claim.rootTaskId !== run.rootTaskId) {
          throw new ManagementConflictError('PI_ORCHESTRATION_CLAIM_NOT_ACTIVE');
        }
        const scheduling = await requireScheduling(repositories, run.id);
        if (scheduling.state !== 'waiting') {
          throw new ManagementConflictError('PI_SCHEDULING_NOT_WAITING');
        }
        if (orchestrationRevision(run) !== input.expectedRunRevision) {
          throw new ManagementConflictError('PI_RUN_REVISION_CONFLICT');
        }
        if (scheduling.revision !== input.expectedSchedulingRevision) {
          throw new ManagementConflictError('PI_SCHEDULING_REVISION_CONFLICT');
        }

        const nextRunRevision = orchestrationRevision(run) + 1;
        const nextSchedulingRevision = scheduling.revision + 1;
        const receiptId = dependencies.ids.nextId();
        await repositories.management.scheduling.update({
          ...scheduling,
          state: 'runnable',
          eligibleAt: input.eligibleAt,
          enqueuedAt: now,
          revision: nextSchedulingRevision,
          waitingReason: undefined,
          updatedAt: now,
        });
        await repositories.management.runs.update({
          ...run,
          status: 'queued',
          activeWorkerId: undefined,
          orchestrationRevision: nextRunRevision,
          recoveryState: 'healthy',
          updatedAt: now,
        });
        const event = await appendManagementEventInTransaction(repositories.management, {
          managementRunId: run.id,
          type: 'orchestration-command-committed',
          actorKind: 'system',
          idempotencyKey: `pi-command:${input.idempotencyKey}`,
          payload: {
            commandName: 'wake',
            runRevision: nextRunRevision,
            schedulingRevision: nextSchedulingRevision,
            receiptId,
          },
        }, now, dependencies.ids);
        await repositories.management.attemptAudits.append({
          id: dependencies.ids.nextId(),
          managementRunId: run.id,
          commandName: 'wake',
          idempotencyKey: input.idempotencyKey,
          decision: 'applied',
          createdAt: now,
        });
        await repositories.management.commandReceipts.create({
          id: receiptId,
          managementRunId: run.id,
          idempotencyKey: input.idempotencyKey,
          commandHash,
          outcome: 'applied',
          runRevision: nextRunRevision,
          schedulingRevision: nextSchedulingRevision,
          eventSequence: event.event.sequence,
          createdAt: now,
        });
        await repositories.management.outbox.create({
          id: dependencies.ids.nextId(),
          managementRunId: run.id,
          receiptId,
          eventSequence: event.event.sequence,
          state: 'pending',
          createdAt: now,
        });
        return {
          disposition: 'applied' as const,
          receiptId,
          runRevision: nextRunRevision,
          schedulingRevision: nextSchedulingRevision,
          eventSequence: event.event.sequence,
        };
      });
    },

    async reconcileRun(input: { readonly managementRunId: string; readonly objective: string }) {
      return dependencies.unitOfWork.run(async (repositories) => {
        const run = await requireRun(repositories, input.managementRunId);
        const scheduling = await requireScheduling(repositories, run.id);
        if (run.recoveryState === 'recovery_pending' || scheduling.state === 'recovery_pending') {
          return {
            kind: 'recovery_pending' as const,
            reasonCode: scheduling.waitingReason ?? 'RECOVERY_PENDING',
          };
        }
        const checkpoint = await repositories.management.checkpoints.getLatest(run.id);
        if (!checkpoint) return { kind: 'healthy' as const };
        const events = await repositories.management.events.list(run.id);
        const latestEventSequence = events.at(-1)?.event.sequence ?? 0;
        const currentRunRevision = orchestrationRevision(run);
        const authoritative = checkpoint.authoritative;
        const impossibleReason = checkpoint.managementRunId !== run.id
          ? 'CHECKPOINT_RUN_MISMATCH'
          : Number(checkpoint.schemaVersion) !== 1 || (authoritative.eventSchemaVersion !== undefined
            && Number(authoritative.eventSchemaVersion) !== 1)
            ? 'CHECKPOINT_SCHEMA_UNSUPPORTED'
            : authoritative.contentHash !== undefined
              && authoritative.contentHash !== hashManagementCheckpointAuthoritative(authoritative)
              ? 'CHECKPOINT_HASH_MISMATCH'
              : authoritative.runRevision !== undefined && authoritative.runRevision > currentRunRevision
                ? 'CHECKPOINT_FUTURE_RUN_REVISION'
                : authoritative.lastEventSequence > latestEventSequence
                  ? 'CHECKPOINT_FUTURE_EVENT_SEQUENCE'
                  : undefined;
        if (!impossibleReason) {
          const rebuildReasons = [
            ...(authoritative.contentHash === undefined ? ['checkpoint-hash-missing'] : []),
            ...(authoritative.eventSchemaVersion === undefined ? ['checkpoint-schema-missing'] : []),
            ...(authoritative.runRevision === undefined
              ? ['run-revision-missing']
              : authoritative.runRevision < currentRunRevision ? ['run-revision-stale'] : []),
            ...(authoritative.lastEventSequence < latestEventSequence ? ['event-sequence-stale'] : []),
          ];
          return rebuildReasons.length === 0
            ? { kind: 'healthy' as const }
            : { kind: 'rebuild_required' as const, reasons: rebuildReasons };
        }
        const now = dependencies.clock.now();
        const reasonCode = impossibleReason;
        const runRevision = orchestrationRevision(run) + 1;
        const schedulingRevision = scheduling.revision + 1;
        await repositories.management.runs.update({
          ...run,
          orchestrationRevision: runRevision,
          recoveryState: 'recovery_pending',
          activeWorkerId: undefined,
          status: 'recovering',
          updatedAt: now,
        });
        await repositories.management.scheduling.update({
          ...scheduling,
          state: 'recovery_pending',
          revision: schedulingRevision,
          waitingReason: reasonCode,
          updatedAt: now,
        });
        const event = await appendManagementEventInTransaction(repositories.management, {
          managementRunId: run.id,
          type: 'orchestration-recovery-pending',
          actorKind: 'system',
          idempotencyKey: `pi-recovery-pending:${runRevision}:${reasonCode}`,
          payload: { runRevision, schedulingRevision, reasonCode },
        }, now, dependencies.ids);
        await repositories.management.outbox.create({
          id: dependencies.ids.nextId(),
          managementRunId: run.id,
          eventSequence: event.event.sequence,
          state: 'pending',
          createdAt: now,
        });
        return { kind: 'recovery_pending' as const, reasonCode };
      });
    },
  };
}

async function requireRun(repositories: TaskCoordinationTransactionRepositories, managementRunId: string) {
  const run = await repositories.management.runs.getById(managementRunId);
  if (!run) throw new ManagementConflictError('MANAGEMENT_RUN_NOT_FOUND');
  if (!run.rootTaskId) throw new ManagementConflictError('MANAGEMENT_ROOT_TASK_REQUIRED');
  return run;
}

async function requireScheduling(repositories: TaskCoordinationTransactionRepositories, managementRunId: string) {
  const scheduling = await repositories.management.scheduling.get(managementRunId);
  if (!scheduling) throw new ManagementConflictError('PI_SCHEDULING_NOT_FOUND');
  return scheduling;
}

async function requireAuthorizedLease(
  repositories: TaskCoordinationTransactionRepositories,
  authority: LeaseAuthorityInput,
  now: number,
) {
  const lease = await repositories.management.leases.get(authority.managementRunId);
  const decision = authorizeManagerLeaseWrite({
    lease: lease ?? undefined,
    proof: leaseProof(authority),
    now,
  });
  if (decision.kind === 'rejected') throw leaseConflict(decision.reason);
  return decision.lease;
}

function orchestrationRevision(run: { readonly orchestrationRevision?: number }): number {
  return run.orchestrationRevision ?? 0;
}

function leaseProof(authority: LeaseAuthorityInput) {
  return {
    managementRunId: authority.managementRunId,
    workerId: authority.workerId,
    presentedLeaseTokenHash: sha256(authority.leaseToken),
    fencingToken: authority.fencingToken,
  };
}

function leaseConflict(reason: string): ManagementConflictError {
  return new ManagementConflictError(`LEASE_${reason.toUpperCase().replaceAll('-', '_')}`);
}

function hashCommand(input: CommitPiOrchestrationCommandInput): string {
  return sha256(JSON.stringify({
    managementRunId: input.authority.managementRunId,
    workerId: input.authority.workerId,
    fencingToken: input.authority.fencingToken,
    idempotencyKey: input.idempotencyKey,
    expectedRunRevision: input.expectedRunRevision,
    expectedSchedulingRevision: input.expectedSchedulingRevision,
    command: input.command,
  }));
}

function hashWakeCommand(input: {
  readonly managementRunId: string;
  readonly idempotencyKey: string;
  readonly expectedRunRevision: number;
  readonly expectedSchedulingRevision: number;
  readonly eligibleAt: number;
}): string {
  return sha256(JSON.stringify({
    managementRunId: input.managementRunId,
    idempotencyKey: input.idempotencyKey,
    expectedRunRevision: input.expectedRunRevision,
    expectedSchedulingRevision: input.expectedSchedulingRevision,
    command: { kind: 'wake', eligibleAt: input.eligibleAt },
  }));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
