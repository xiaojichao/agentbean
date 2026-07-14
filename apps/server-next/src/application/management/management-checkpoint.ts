import type {
  ManagementCheckpointContextHintsV1,
  ManagementCheckpointV1,
} from '../../../../../packages/contracts/src/index.js';
import { evaluateManagementCheckpoint, type ManagementCheckpointFacts } from '../../../../../packages/domain/src/index.js';
import type { ManagementRepositories, ManagementRunRecord } from '../management-repositories.js';
import type { TaskRepository } from '../repositories.js';
import type { TaskCoordinationRepositories } from '../task-coordination-repositories.js';
import type { TaskCoordinationUnitOfWork } from '../task-coordination-unit-of-work.js';
import type { ManagementUnitOfWork } from '../management-unit-of-work.js';
import {
  appendManagementEventInTransaction,
  authorizeManagementWrite,
  type LeaseAuthorityInput,
} from './management-kernel.js';

export interface ManagementCheckpointDependencies {
  readonly unitOfWork: ManagementUnitOfWork;
  readonly taskCoordinationUnitOfWork?: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

export function createManagementCheckpointService(dependencies: ManagementCheckpointDependencies) {
  return {
    save(input: {
      authority: LeaseAuthorityInput;
      idempotencyKey: string;
      contextHints: ManagementCheckpointContextHintsV1;
    }): Promise<ManagementCheckpointV1> {
      const save = (repositories: ManagementRepositories, phase2?: {
        tasks: TaskRepository; coordination: TaskCoordinationRepositories;
      }) => saveCheckpoint(dependencies, repositories, input, phase2);
      return dependencies.taskCoordinationUnitOfWork
        ? dependencies.taskCoordinationUnitOfWork.run((repositories) => save(repositories.management, {
            tasks: repositories.tasks, coordination: repositories.coordination,
          }))
        : dependencies.unitOfWork.run((repositories) => save(repositories));
    },
  };
}

async function saveCheckpoint(
  dependencies: ManagementCheckpointDependencies,
  repositories: ManagementRepositories,
  input: {
    authority: LeaseAuthorityInput;
    idempotencyKey: string;
    contextHints: ManagementCheckpointContextHintsV1;
  },
  phase2?: { tasks: TaskRepository; coordination: TaskCoordinationRepositories },
): Promise<ManagementCheckpointV1> {
  const now = dependencies.clock.now();
  await authorizeManagementWrite(repositories, input.authority, now);
  const run = await requireRun(repositories, input.authority.managementRunId);
  const latest = await repositories.checkpoints.getLatest(run.id);
  const existingEvent = (await repositories.events.list(run.id))
    .find(({ event }) => event.idempotencyKey === input.idempotencyKey);
  if (existingEvent) {
    if (existingEvent.event.type !== 'checkpoint-updated') throw new Error('CHECKPOINT_IDEMPOTENCY_CONFLICT');
    const existingCheckpoint = await repositories.checkpoints.get({ managementRunId: run.id,
      revision: existingEvent.event.payload.checkpointRevision });
    if (!existingCheckpoint) throw new Error('CHECKPOINT_IDEMPOTENCY_CONFLICT');
    return existingCheckpoint;
  }
  const revision = (latest?.revision ?? 0) + 1;
  const eventsBefore = await repositories.events.list(run.id);
  const nextSequence = (eventsBefore.at(-1)?.event.sequence ?? 0) + 1;
  const checkpointEvent = await appendManagementEventInTransaction(repositories, {
    managementRunId: run.id, type: 'checkpoint-updated', actorKind: 'manager',
    actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
    payload: { checkpointRevision: revision, lastEventSequence: nextSequence },
  }, now, dependencies.ids);
  if (checkpointEvent.event.type !== 'checkpoint-updated') throw new Error('CHECKPOINT_EVENT_TYPE_MISMATCH');
  const existingAfterReplay = await repositories.checkpoints.getLatest(run.id);
  if (existingAfterReplay && existingAfterReplay.revision >= checkpointEvent.event.payload.checkpointRevision) {
    return existingAfterReplay;
  }
  const facts = await collectManagementCheckpointFacts(repositories, run, phase2);
  const checkpoint: ManagementCheckpointV1 = { schemaVersion: 1, managementRunId: run.id,
    revision, authoritative: toManagementCheckpointAuthoritative(facts),
    contextHints: input.contextHints, updatedAt: now };
  await repositories.checkpoints.put(checkpoint);
  await repositories.runs.update({ ...run, checkpointRevision: revision, updatedAt: now });
  return checkpoint;
}

export async function collectManagementCheckpointFacts(
  repositories: ManagementRepositories,
  run: ManagementRunRecord,
  phase2?: {
    readonly tasks: TaskRepository;
    readonly coordination: TaskCoordinationRepositories;
  },
): Promise<ManagementCheckpointFacts> {
  const events = await repositories.events.list(run.id);
  const invocations = await repositories.invocations.listByRun(run.id);
  const waitingInvocationIds: string[] = [];
  const completedInvocationIds: string[] = [];
  for (const invocation of invocations) {
    const attempts = await repositories.dispatchAttempts.list(invocation.id);
    const latest = attempts.at(-1);
    if (latest && ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(latest.status)) {
      completedInvocationIds.push(invocation.id);
    } else {
      waitingInvocationIds.push(invocation.id);
    }
  }
  const terminalRun = ['completed', 'failed', 'cancelled'].includes(run.status);
  const coordinations = phase2
    ? await phase2.coordination.coordinations.listByManagementRun(run.id)
    : [];
  const taskSnapshots = await Promise.all(coordinations.map(async (coordination) => {
    const task = await phase2!.tasks.getById(coordination.taskId);
    if (!task || task.teamId !== run.teamId) throw new Error('CHECKPOINT_TASK_NOT_FOUND');
    const claim = await phase2!.coordination.claimLeases.getCurrent({
      taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
    });
    return {
      taskId: task.id,
      taskRevision: task.revision,
      taskAttempt: coordination.attempt,
      status: task.status,
      ...(claim ? { claimLeaseId: claim.id } : {}),
    };
  }));
  taskSnapshots.sort((left, right) => left.taskId.localeCompare(right.taskId));
  const activeClaimLeaseIds = taskSnapshots.flatMap((task) => task.claimLeaseId ? [task.claimLeaseId] : []);
  const openTaskIds = phase2 && taskSnapshots.length > 0
    ? taskSnapshots.filter((task) => !['done', 'closed'].includes(task.status)).map((task) => task.taskId)
    : !terminalRun && run.rootTaskId ? [run.rootTaskId] : [];
  return {
    managementRunId: run.id,
    lastEventSequence: events.at(-1)?.event.sequence ?? 0,
    taskGraphRevision: taskSnapshots.length > 0
      ? Math.max(...taskSnapshots.map((task) => task.taskRevision))
      : maxTaskRevision(events.map(({ event }) => event.payload)),
    openTaskIds: terminalRun ? [] : openTaskIds,
    waitingInvocationIds,
    completedInvocationIds,
    // Phase 1 has no authoritative Memory repository yet. Fail closed instead
    // of treating an Invocation intent reference as proof that a capsule exists.
    validMemoryCapsuleIds: [],
    ...(phase2 && taskSnapshots.length > 0 ? { taskSnapshots, activeClaimLeaseIds } : {}),
  };
}

export function restoreOrRebuildManagementCheckpoint(input: {
  checkpoint: ManagementCheckpointV1;
  facts: ManagementCheckpointFacts;
  objective: string;
  now: number;
}): { kind: 'usable'; checkpoint: ManagementCheckpointV1 } | { kind: 'rebuilt'; checkpoint: ManagementCheckpointV1; reasons: readonly string[] } {
  const decision = evaluateManagementCheckpoint({ checkpoint: input.checkpoint, facts: input.facts });
  const exactMismatch = !sameSet(input.checkpoint.authoritative.openTaskIds, input.facts.openTaskIds)
    || !sameSet(input.checkpoint.authoritative.waitingInvocationIds, input.facts.waitingInvocationIds)
    || !sameSet(input.checkpoint.authoritative.completedInvocationIds, input.facts.completedInvocationIds)
    || !sameSet(input.checkpoint.authoritative.memoryCapsuleIds, input.facts.validMemoryCapsuleIds)
    || JSON.stringify(input.checkpoint.authoritative.taskSnapshots ?? []) !== JSON.stringify(input.facts.taskSnapshots ?? [])
    || !sameSet(input.checkpoint.authoritative.activeClaimLeaseIds ?? [], input.facts.activeClaimLeaseIds ?? []);
  if (decision.kind === 'usable' && !exactMismatch) return { kind: 'usable', checkpoint: input.checkpoint };
  const reasons: string[] = decision.kind === 'rebuild_required' ? [...decision.reasons] : [];
  if (exactMismatch) reasons.push('authoritative-set-mismatch');
  return {
    kind: 'rebuilt',
    reasons,
    checkpoint: {
      schemaVersion: 1,
      managementRunId: input.facts.managementRunId,
      revision: input.checkpoint.revision,
      authoritative: toManagementCheckpointAuthoritative(input.facts),
      contextHints: {
        objective: input.objective,
        planSummary: '',
        completedInvocationSummaries: [],
        unresolvedQuestions: [],
      },
      updatedAt: input.now,
    },
  };
}

export function toManagementCheckpointAuthoritative(facts: ManagementCheckpointFacts): ManagementCheckpointV1['authoritative'] {
  return {
    lastEventSequence: facts.lastEventSequence,
    taskGraphRevision: facts.taskGraphRevision,
    openTaskIds: [...facts.openTaskIds],
    waitingInvocationIds: [...facts.waitingInvocationIds],
    completedInvocationIds: [...facts.completedInvocationIds],
    memoryCapsuleIds: [...facts.validMemoryCapsuleIds],
    ...(facts.taskSnapshots ? { taskSnapshots: structuredClone(facts.taskSnapshots) } : {}),
    ...(facts.activeClaimLeaseIds ? { activeClaimLeaseIds: [...facts.activeClaimLeaseIds] } : {}),
  };
}
function maxTaskRevision(payloads: readonly unknown[]): number { let max = 0; for (const value of payloads) { if (value && typeof value === 'object') { const revision = (value as Record<string, unknown>).taskRevision; if (Number.isSafeInteger(revision)) max = Math.max(max, revision as number); } } return max; }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item)); }
async function requireRun(repositories: ManagementRepositories, id: string): Promise<ManagementRunRecord> { const run = await repositories.runs.getById(id); if (!run) throw new Error('MANAGEMENT_RUN_NOT_FOUND'); return run; }
