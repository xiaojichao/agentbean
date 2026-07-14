import type { ManagementEventPayloadMapV1, SubtaskDeliveryV1 } from '../../../../../packages/contracts/src/index.js';
import type { SubtaskDeliveryRecord } from '../task-coordination-repositories.js';
import type { TaskCoordinationTransactionRepositories, TaskCoordinationUnitOfWork } from '../task-coordination-unit-of-work.js';
import {
  appendValidatedManagementEventInTransaction,
  authorizeManagementWrite,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import { hashManagementCommandInput, parseTaskCoordinationManagementEvent } from './management-event-validator.js';
import type { EvidenceLocator } from './evidence-snapshot-service.js';
import { createEvidenceSnapshotService } from './evidence-snapshot-service.js';

export interface SubmitSubtaskDeliveryInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly invocationId: string;
  readonly summary: string;
  readonly locators: readonly EvidenceLocator[];
}

export function createSubtaskDeliveryService(input: {
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}) {
  const snapshots = createEvidenceSnapshotService({ ids: input.ids });
  return {
    async submit(command: SubmitSubtaskDeliveryInput): Promise<{
      readonly delivery: SubtaskDeliveryRecord;
      readonly disposition: 'created' | 'existing';
    }> {
      return input.unitOfWork.run(async (repositories) => {
        const now = input.clock.now();
        const run = await authorize(repositories, command.authority, now);
        if (!command.idempotencyKey || !command.summary.trim()) {
          throw new Error('SUBTASK_DELIVERY_INPUT_INVALID');
        }
        const commandHash = hashManagementCommandInput({ command: 'submit-subtask-delivery',
          taskId: command.taskId, expectedTaskRevision: command.expectedTaskRevision,
          taskAttempt: command.taskAttempt, claimLeaseId: command.claimLeaseId,
          invocationId: command.invocationId, summary: command.summary, locators: command.locators });
        const replay = await repositories.coordination.deliveries.getByIdempotencyKey({
          taskId: command.taskId, idempotencyKey: command.idempotencyKey,
        });
        if (replay) {
          const events = await repositories.management.events.list(run.id);
          const event = events.find((candidate) => candidate.event.idempotencyKey === command.idempotencyKey);
          if (!event || event.payloadHash !== commandHash || replay.invocationId !== command.invocationId) {
            throw new Error('SUBTASK_DELIVERY_IDEMPOTENCY_CONFLICT');
          }
          return { delivery: replay, disposition: 'existing' as const };
        }
        const task = await repositories.tasks.getById(command.taskId);
        if (!task || task.teamId !== run.teamId || task.channelId !== run.channelId) {
          throw new Error('SUBTASK_DELIVERY_TASK_NOT_FOUND');
        }
        if (task.revision !== command.expectedTaskRevision) throw new Error('SUBTASK_DELIVERY_TASK_REVISION_CONFLICT');
        if (task.status !== 'in_progress') throw new Error('SUBTASK_DELIVERY_TASK_STATE_CONFLICT');
        const coordination = await repositories.coordination.coordinations.getByTaskId(task.id);
        if (!coordination || coordination.nodeKind !== 'subtask'
          || coordination.managementRunId !== run.id
          || coordination.taskRevision !== task.revision || coordination.attempt !== command.taskAttempt) {
          throw new Error('SUBTASK_DELIVERY_TASK_AUTHORITY_MISMATCH');
        }
        const claim = await repositories.coordination.claimLeases.getById(command.claimLeaseId);
        const currentClaim = await repositories.coordination.claimLeases.getCurrent({
          taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
        });
        if (!claim || claim.id !== currentClaim?.id || claim.taskId !== task.id
          || claim.taskRevision !== task.revision || claim.taskAttempt !== coordination.attempt
          || claim.status !== 'active' || claim.expiresAt <= now) {
          throw new Error('SUBTASK_DELIVERY_CLAIM_NOT_CURRENT');
        }
        const invocation = await repositories.management.invocations.getById(command.invocationId);
        if (!invocation || invocation.intent.targetAgentId !== claim.agentId) {
          throw new Error('SUBTASK_DELIVERY_INVOCATION_AGENT_MISMATCH');
        }
        const evidence = await snapshots.capture(repositories, {
          teamId: run.teamId, channelId: run.channelId, managementRunId: run.id,
          taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
          claimLeaseId: claim.id, invocationId: command.invocationId,
        }, command.locators, now);
        const delivery: SubtaskDeliveryRecord = {
          schemaVersion: 1,
          id: input.ids.nextId(),
          teamId: run.teamId,
          taskId: task.id,
          taskRevision: task.revision,
          taskAttempt: coordination.attempt,
          claimLeaseId: claim.id,
          invocationId: command.invocationId,
          summary: command.summary,
          claims: [{ statement: command.summary, evidenceRefs: evidence.refs }],
          evidenceRefs: evidence.refs,
          idempotencyKey: command.idempotencyKey,
          createdAt: now,
        };
        await repositories.coordination.deliveries.create(delivery);
        const updated = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'in_review', updatedAt: now } });
        if (!updated) throw new Error('SUBTASK_DELIVERY_TASK_NOT_FOUND');
        await appendTaskEvent(repositories, { managementRunId: run.id, type: 'subtask-delivered',
          actorKind: 'agent', actorId: claim.agentId, idempotencyKey: command.idempotencyKey,
          payload: { deliveryId: delivery.id, taskId: task.id, taskRevision: task.revision,
            taskAttempt: coordination.attempt, claimLeaseId: claim.id,
            invocationId: command.invocationId } }, now, input.ids, commandHash);
        await appendTaskEvent(repositories, { managementRunId: run.id, type: 'task-state-changed',
          actorKind: 'agent', actorId: claim.agentId, idempotencyKey: `${command.idempotencyKey}:state`,
          payload: { taskId: task.id, taskRevision: task.revision,
            from: 'in_progress', to: 'in_review' } }, now, input.ids, commandHash);
        return { delivery, disposition: 'created' as const };
      });
    },
  };
}

async function authorize(repositories: TaskCoordinationTransactionRepositories,
  authority: LeaseAuthorityInput, now: number) {
  await authorizeManagementWrite(repositories.management, authority, now);
  const run = await repositories.management.runs.getById(authority.managementRunId);
  if (!run) throw new Error('MANAGEMENT_RUN_NOT_FOUND');
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw new Error('MANAGEMENT_RUN_TERMINAL');
  }
  return run;
}

async function appendTaskEvent<T extends 'subtask-delivered' | 'task-state-changed'>(
  repositories: TaskCoordinationTransactionRepositories,
  event: { managementRunId: string; type: T; actorKind: 'agent'; actorId: string;
    idempotencyKey: string; payload: ManagementEventPayloadMapV1[T] },
  now: number,
  ids: { nextId(): string },
  commandHash: string,
) {
  return appendValidatedManagementEventInTransaction(repositories.management, event, now, ids, {
    payloadHash: commandHash,
    parseEvent: parseTaskCoordinationManagementEvent,
  });
}

export function deliveryOutput(delivery: SubtaskDeliveryV1) {
  return { deliveryId: delivery.id, evidenceRefs: delivery.evidenceRefs };
}
