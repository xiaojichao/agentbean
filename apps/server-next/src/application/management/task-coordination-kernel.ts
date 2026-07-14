import type {
  AcceptanceCriterionDto,
  ManagementEventV1,
  ManagementEventPayloadMapV1,
  SubtaskAcceptanceV1,
  TaskStatus,
} from '../../../../../packages/contracts/src/index.js';
import {
  authorizeTaskRevision,
  evaluateSubtaskAcceptance,
  evaluateTaskDag,
  evaluateTaskRevisionChange,
} from '../../../../../packages/domain/src/index.js';
import type { TaskRecord } from '../repositories.js';
import type { ManagementEventRecord } from '../management-repositories.js';
import type {
  TaskAcceptanceCriterionRecord,
  TaskClaimLeaseRecord,
  TaskCoordinationRecord,
} from '../task-coordination-repositories.js';
import type {
  TaskCoordinationTransactionRepositories,
  TaskCoordinationUnitOfWork,
} from '../task-coordination-unit-of-work.js';
import {
  appendManagementEventInTransaction,
  appendValidatedManagementEventInTransaction,
  authorizeManagementWrite,
  ManagementConflictError,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import {
  hashManagementCommandInput,
  parsePhase1ManagementEvent,
  parseTaskCoordinationManagementEvent,
} from './management-event-validator.js';

type TransactionRepositories = TaskCoordinationTransactionRepositories;
type TaskCoordinationEventType =
  | 'task-created' | 'task-revised' | 'task-state-changed'
  | 'task-published-for-claim' | 'task-assigned' | 'claim-invalidated'
  | 'task-acceptance-decided' | 'root-delivery-submitted';

interface CommandReplay {
  readonly events: readonly ManagementEventRecord[];
  readonly lastSequence: number;
}

export interface TaskCoordinationKernelDependencies {
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

export interface TaskCoordinationCommandInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
}

export interface CreateRootCoordinationInput extends TaskCoordinationCommandInput {
  readonly taskId: string;
  readonly claimPolicy: 'open' | 'targeted';
  readonly requiredCapabilities: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly maxAttempts: number;
}

export interface CreateSubtasksInput extends TaskCoordinationCommandInput {
  readonly parentTaskId: string;
  readonly subtasks: readonly {
    readonly taskId: string;
    readonly clientKey: string;
    readonly title: string;
    readonly description?: string;
    readonly claimPolicy: 'open' | 'targeted';
    readonly targetAgentId?: string;
    readonly requiredCapabilities: readonly string[];
    readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
    readonly maxAttempts: number;
  }[];
}

export interface ReviseTaskInput extends TaskCoordinationCommandInput {
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly dependencyTaskIds?: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly claimPolicy: 'open' | 'targeted';
  readonly assigneeId?: string;
  readonly maxAttempts: number;
  readonly reasonCode: string;
}

export function createTaskCoordinationKernel(
  dependencies: TaskCoordinationKernelDependencies,
) {
  const { unitOfWork, clock, ids } = dependencies;

  return {
    async createRootCoordination(input: CreateRootCoordinationInput) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({
          command: 'create-root-coordination', taskId: input.taskId,
          claimPolicy: input.claimPolicy, requiredCapabilities: input.requiredCapabilities,
          acceptanceCriteria: input.acceptanceCriteria, maxAttempts: input.maxAttempts,
        });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-created');
          return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
            taskGraphRevision: replay.lastSequence,
            disposition: 'existing' as const };
        }
        if (run.rootTaskId !== input.taskId) conflict('TASK_ROOT_MISMATCH');
        const task = await requireTask(repositories, input.taskId);
        if (task.teamId !== run.teamId) conflict('TASK_TEAM_MISMATCH');
        if (await repositories.coordination.coordinations.getByTaskId(input.taskId)) {
          conflict('TASK_COORDINATION_ALREADY_EXISTS');
        }
        validateNewCoordination({ objective: objectiveOf(task), criteria: input.acceptanceCriteria,
          dependencyTaskIds: [], claimPolicy: input.claimPolicy, assigneeId: task.assigneeId,
          requiredCapabilities: input.requiredCapabilities, maxAttempts: input.maxAttempts });
        const coordination: TaskCoordinationRecord = {
          schemaVersion: 1, taskId: task.id, teamId: task.teamId, managementRunId: run.id,
          rootTaskId: task.id, nodeKind: 'root', reviewPolicy: 'human',
          claimPolicy: input.claimPolicy, requiredCapabilities: [...input.requiredCapabilities],
          taskRevision: task.revision, attempt: 1, maxAttempts: input.maxAttempts,
          createdAt: now, updatedAt: now,
        };
        await repositories.coordination.coordinations.create(coordination);
        await createCriteria(repositories, task.id, task.revision, input.acceptanceCriteria);
        await validateRunDag(repositories, run);
        const event = await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-created', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
          payload: { taskId: task.id, taskRevision: task.revision },
        }, now, ids, commandHash);
        return { taskId: task.id, taskRevision: task.revision,
          taskGraphRevision: event.event.sequence,
          disposition: 'created' as const };
      });
    },

    async createSubtasks(input: CreateSubtasksInput) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'create-subtasks',
          parentTaskId: input.parentTaskId, subtasks: input.subtasks });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const taskIds = replay.events.map((record) => record.event)
            .filter((event): event is Extract<ManagementEventV1, { type: 'task-created' }> =>
              event.type === 'task-created')
            .map((event) => event.payload.taskId);
          return { taskIds, taskGraphRevision: replay.lastSequence, disposition: 'existing' as const };
        }
        if (input.subtasks.length === 0) conflict('TASK_SUBTASKS_EMPTY');
        if (new Set(input.subtasks.map((draft) => draft.taskId)).size !== input.subtasks.length
          || new Set(input.subtasks.map((draft) => draft.clientKey)).size !== input.subtasks.length) {
          conflict('TASK_SUBTASKS_DUPLICATE');
        }
        const parentTask = await requireTask(repositories, input.parentTaskId);
        const parent = await requireCoordinationForRun(repositories, input.parentTaskId, run.id);
        const rootTaskId = parent.rootTaskId ?? parent.taskId;
        const tasks: TaskRecord[] = [];
        for (const [index, draft] of input.subtasks.entries()) {
          const assigneeId = draft.claimPolicy === 'targeted' ? draft.targetAgentId : undefined;
          validateNewCoordination({ objective: draft.description ?? draft.title,
            criteria: draft.acceptanceCriteria, dependencyTaskIds: [],
            claimPolicy: draft.claimPolicy, assigneeId,
            requiredCapabilities: draft.requiredCapabilities, maxAttempts: draft.maxAttempts });
          const task = await repositories.tasks.create({
            id: draft.taskId, teamId: run.teamId, title: draft.title,
            ...(draft.description ? { description: draft.description } : {}), status: 'todo',
            creatorId: parentTask.creatorId, ...(assigneeId ? { assigneeId } : {}),
            ...(parentTask.channelId ? { channelId: parentTask.channelId } : {}),
            tags: [], sortOrder: parentTask.sortOrder + index + 1, createdAt: now, updatedAt: now,
          });
          const coordination: TaskCoordinationRecord = {
            schemaVersion: 1, taskId: task.id, teamId: run.teamId, managementRunId: run.id,
            rootTaskId, parentTaskId: parent.taskId, nodeKind: 'subtask', reviewPolicy: 'manager',
            claimPolicy: draft.claimPolicy, requiredCapabilities: [...draft.requiredCapabilities],
            taskRevision: task.revision, attempt: 1, maxAttempts: draft.maxAttempts,
            createdAt: now, updatedAt: now,
          };
          await repositories.coordination.coordinations.create(coordination);
          await createCriteria(repositories, task.id, task.revision, draft.acceptanceCriteria);
          tasks.push(task);
        }
        await validateRunDag(repositories, run);
        let taskGraphRevision = 0;
        for (const [index, task] of tasks.entries()) {
          const event = await appendTaskEvent(repositories, {
            managementRunId: run.id, type: 'task-created', actorKind: 'manager',
            actorId: input.authority.workerId,
            idempotencyKey: index === 0 ? input.idempotencyKey : `${input.idempotencyKey}:${task.id}`,
            payload: { taskId: task.id, parentTaskId: parent.taskId, taskRevision: task.revision },
          }, now, ids, commandHash);
          taskGraphRevision = event.event.sequence;
        }
        return { taskIds: tasks.map((task) => task.id), taskGraphRevision,
          disposition: 'created' as const };
      });
    },

    async addDependency(input: TaskCoordinationCommandInput & {
      taskId: string; dependencyTaskId: string; expectedTaskRevision: number;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'add-dependency',
          taskId: input.taskId, dependencyTaskId: input.dependencyTaskId,
          expectedTaskRevision: input.expectedTaskRevision });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) return replayTaskRevisionResult(replay);
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireCoordinationForRun(repositories, input.taskId, run.id);
        await requireCoordinationForRun(repositories, input.dependencyTaskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        const dependencies = await repositories.coordination.dependencies.list(task.id);
        if (dependencies.some((edge) => edge.dependencyTaskId === input.dependencyTaskId)) {
          conflict('TASK_DEPENDENCY_ALREADY_EXISTS');
        }
        const revised = await reviseInTransaction(repositories, run, task, coordination, {
          objective: objectiveOf(task), acceptanceCriteria: activeCriteria(
            await repositories.coordination.criteria.list(task.id), task.revision),
          dependencyTaskIds: [...dependencies.map((edge) => edge.dependencyTaskId), input.dependencyTaskId],
          claimPolicy: coordination.claimPolicy, assigneeId: task.assigneeId,
          requiredCapabilities: coordination.requiredCapabilities, maxAttempts: coordination.maxAttempts,
        }, now);
        const event = await appendRevisionEvent(repositories, run.id, input.authority.workerId,
          input.idempotencyKey, commandHash, revised, 'dependency_added', now, ids);
        const invalidated = await invalidateCapturedClaim(repositories, run.id, input.authority.workerId,
          `${input.idempotencyKey}:claim-invalidated`, commandHash, revised.claim, 'TASK_REVISED', now, ids);
        return { taskId: revised.task.id, taskRevision: revised.task.revision,
          taskGraphRevision: invalidated?.event.sequence ?? event.event.sequence,
          disposition: 'updated' as const };
      });
    },

    async reviseTask(input: ReviseTaskInput) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'revise-task', taskId: input.taskId,
          expectedTaskRevision: input.expectedTaskRevision, objective: input.objective,
          acceptanceCriteria: input.acceptanceCriteria, dependencyTaskIds: input.dependencyTaskIds,
          requiredCapabilities: input.requiredCapabilities, claimPolicy: input.claimPolicy,
          assigneeId: input.assigneeId, maxAttempts: input.maxAttempts, reasonCode: input.reasonCode });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) return replayRevisionResult(replay);
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireCoordinationForRun(repositories, input.taskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        const dependencyTaskIds = input.dependencyTaskIds
          ?? (await repositories.coordination.dependencies.list(task.id)).map((edge) => edge.dependencyTaskId);
        const revised = await reviseInTransaction(repositories, run, task, coordination, {
          objective: input.objective, acceptanceCriteria: input.acceptanceCriteria,
          dependencyTaskIds, claimPolicy: input.claimPolicy, assigneeId: input.assigneeId,
          requiredCapabilities: input.requiredCapabilities, maxAttempts: input.maxAttempts,
        }, now);
        if (!revised.changed) conflict('TASK_REVISION_UNCHANGED');
        const event = await appendRevisionEvent(repositories, run.id, input.authority.workerId,
          input.idempotencyKey, commandHash, revised, input.reasonCode, now, ids);
        const invalidated = await invalidateCapturedClaim(repositories, run.id, input.authority.workerId,
          `${input.idempotencyKey}:claim-invalidated`, commandHash, revised.claim, 'TASK_REVISED', now, ids);
        return { taskId: revised.task.id, taskRevision: revised.task.revision,
          criterionIds: revised.criterionIds,
          taskGraphRevision: invalidated?.event.sequence ?? event.event.sequence,
          disposition: 'updated' as const };
      });
    },

    async invalidateClaim(input: TaskCoordinationCommandInput & {
      taskId: string; expectedTaskRevision: number; reasonCode: string;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'invalidate-claim',
          taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision,
          reasonCode: input.reasonCode });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'claim-invalidated');
          return { taskId: event.payload.taskId, taskGraphRevision: replay.lastSequence,
            disposition: 'existing' as const };
        }
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireCoordinationForRun(repositories, input.taskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        const claim = await repositories.coordination.claimLeases.getCurrent({
          taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
        });
        if (!claim) conflict('TASK_CLAIM_NOT_FOUND');
        const event = await invalidateCapturedClaim(repositories, run.id, input.authority.workerId,
          input.idempotencyKey, commandHash, claim, input.reasonCode, now, ids);
        return { taskId: task.id, taskGraphRevision: event!.event.sequence,
          disposition: 'updated' as const };
      });
    },

    async publishForClaim(input: TaskCoordinationCommandInput & {
      taskId: string; expectedTaskRevision: number;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'publish-for-claim',
          taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-published-for-claim');
          return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
            status: 'todo' as const,
            taskGraphRevision: replay.lastSequence, disposition: 'existing' as const };
        }
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireSubtaskCoordination(repositories, input.taskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        if (task.status !== 'todo') conflict('TASK_NOT_PUBLISHABLE');
        await requireDependenciesDone(repositories, task.id);
        const currentCriteria = activeCriteria(
          await repositories.coordination.criteria.list(task.id), task.revision);
        const dependencyTaskIds = (await repositories.coordination.dependencies.list(task.id))
          .map((edge) => edge.dependencyTaskId);
        let currentTask = task;
        let currentCoordination = coordination;
        let baseKey = input.idempotencyKey;
        let taskGraphRevision = 0;
        if (coordination.claimPolicy !== 'open' || task.assigneeId !== undefined) {
          const revised = await reviseInTransaction(repositories, run, task, coordination, {
            objective: objectiveOf(task), acceptanceCriteria: currentCriteria, dependencyTaskIds,
            claimPolicy: 'open', requiredCapabilities: coordination.requiredCapabilities,
            maxAttempts: coordination.maxAttempts,
          }, now);
          const revisionEvent = await appendRevisionEvent(repositories, run.id,
            input.authority.workerId, baseKey, commandHash, revised, 'published_for_claim', now, ids);
          const invalidated = await invalidateCapturedClaim(repositories, run.id,
            input.authority.workerId, `${baseKey}:claim-invalidated`, commandHash,
            revised.claim, 'TASK_REVISED', now, ids);
          currentTask = revised.task;
          currentCoordination = revised.coordination;
          taskGraphRevision = invalidated?.event.sequence ?? revisionEvent.event.sequence;
          baseKey = `${baseKey}:published`;
        }
        const published = await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-published-for-claim', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: baseKey,
          payload: { taskId: currentTask.id, taskRevision: currentTask.revision,
            requiredCapabilities: currentCoordination.requiredCapabilities },
        }, now, ids, commandHash);
        taskGraphRevision = published.event.sequence;
        return { taskId: currentTask.id, taskRevision: currentTask.revision,
          status: currentTask.status, taskGraphRevision, disposition: 'updated' as const };
      });
    },

    async assignTask(input: TaskCoordinationCommandInput & {
      taskId: string; agentId: string; expectedTaskRevision: number;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'assign-task',
          taskId: input.taskId, agentId: input.agentId,
          expectedTaskRevision: input.expectedTaskRevision });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-assigned');
          return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
            agentId: event.payload.agentId,
            taskGraphRevision: replay.lastSequence, disposition: 'existing' as const };
        }
        if (!input.agentId) conflict('TASK_ASSIGNEE_INVALID');
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireSubtaskCoordination(repositories, input.taskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        if (task.status !== 'todo') conflict('TASK_NOT_ASSIGNABLE');
        if (coordination.claimPolicy === 'targeted' && task.assigneeId === input.agentId) {
          conflict('TASK_ALREADY_ASSIGNED');
        }
        await requireDependenciesDone(repositories, task.id);
        const revised = await reviseInTransaction(repositories, run, task, coordination, {
          objective: objectiveOf(task), acceptanceCriteria: activeCriteria(
            await repositories.coordination.criteria.list(task.id), task.revision),
          dependencyTaskIds: (await repositories.coordination.dependencies.list(task.id))
            .map((edge) => edge.dependencyTaskId),
          claimPolicy: 'targeted', assigneeId: input.agentId,
          requiredCapabilities: coordination.requiredCapabilities, maxAttempts: coordination.maxAttempts,
        }, now);
        const revisionEvent = await appendRevisionEvent(repositories, run.id,
          input.authority.workerId, input.idempotencyKey, commandHash, revised,
          'targeted_assignment', now, ids);
        await invalidateCapturedClaim(repositories, run.id,
          input.authority.workerId, `${input.idempotencyKey}:claim-invalidated`, commandHash,
          revised.claim, 'TASK_REVISED', now, ids);
        const assigned = await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-assigned', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: `${input.idempotencyKey}:assigned`,
          payload: { taskId: revised.task.id, taskRevision: revised.task.revision,
            agentId: input.agentId },
        }, now, ids, commandHash);
        return { taskId: revised.task.id, taskRevision: revised.task.revision,
          agentId: input.agentId, taskGraphRevision: assigned.event.sequence,
          disposition: 'updated' as const };
      });
    },

    async transitionTaskState(input: TaskCoordinationCommandInput & {
      taskId: string; expectedTaskRevision: number; from: TaskStatus; to: TaskStatus;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'transition-task-state',
          taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision,
          from: input.from, to: input.to });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-state-changed');
          return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
            status: event.payload.to, taskGraphRevision: replay.lastSequence,
            disposition: 'existing' as const };
        }
        if (input.from === input.to) conflict('TASK_STATE_UNCHANGED');
        const task = await requireTask(repositories, input.taskId);
        await requireCoordinationForRun(repositories, input.taskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        if (task.status !== input.from) conflict('TASK_STATE_CONFLICT');
        const updated = await repositories.tasks.update({ taskId: task.id,
          changes: { status: input.to, updatedAt: now } });
        if (!updated) conflict('TASK_NOT_FOUND');
        const event = await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-state-changed', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
          payload: { taskId: task.id, taskRevision: task.revision, from: input.from, to: input.to },
        }, now, ids, commandHash);
        return { taskId: updated.id, taskRevision: updated.revision, status: updated.status,
          taskGraphRevision: event.event.sequence,
          disposition: 'updated' as const };
      });
    },

    async waitForTasks(input: { managementRunId: string; taskIds: readonly string[] }) {
      return unitOfWork.run(async (repositories) => {
        const run = await repositories.management.runs.getById(input.managementRunId);
        if (!run) conflict('MANAGEMENT_RUN_NOT_FOUND');
        if (input.taskIds.length === 0 || new Set(input.taskIds).size !== input.taskIds.length) {
          conflict('TASK_WAIT_SET_INVALID');
        }
        const readyTaskIds: string[] = [];
        const waitingTaskIds: string[] = [];
        for (const taskId of input.taskIds) {
          const task = await requireTask(repositories, taskId);
          await requireCoordinationForRun(repositories, taskId, run.id);
          if (task.status === 'in_review' || task.status === 'done' || task.status === 'closed') {
            readyTaskIds.push(task.id);
          } else {
            waitingTaskIds.push(task.id);
          }
        }
        return { readyTaskIds, waitingTaskIds };
      });
    },

    async retryTask(input: TaskCoordinationCommandInput & {
      taskId: string; expectedTaskRevision: number; reasonCode: string;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'retry-task',
          taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision,
          reasonCode: input.reasonCode });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-state-changed');
          const coordination = await requireCoordinationForRun(repositories, event.payload.taskId, run.id);
          return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
            attempt: coordination.attempt, disposition: 'existing' as const };
        }
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireSubtaskCoordination(repositories, input.taskId, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        if (task.status !== 'in_review') conflict('TASK_RETRY_STATE_CONFLICT');
        const claim = await repositories.coordination.claimLeases.getCurrent({
          taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
        });
        const waitingForUser = coordination.attempt >= coordination.maxAttempts
          || requiresHumanIntervention(input.reasonCode);
        const nextAttempt = waitingForUser ? coordination.attempt : coordination.attempt + 1;
        const updatedCoordination = nextAttempt === coordination.attempt ? coordination
          : await repositories.coordination.coordinations.update({
            expectedTaskRevision: task.revision,
            record: { ...coordination, attempt: nextAttempt, updatedAt: now },
          });
        if (!updatedCoordination) conflict('TASK_COORDINATION_REVISION_CONFLICT');
        const updated = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'todo', updatedAt: now } });
        if (!updated) conflict('TASK_NOT_FOUND');
        const event = await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-state-changed', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
          payload: { taskId: task.id, taskRevision: task.revision, from: 'in_review', to: 'todo' },
        }, now, ids, commandHash);
        await invalidateCapturedClaim(repositories, run.id, input.authority.workerId,
          `${input.idempotencyKey}:claim-invalidated`, commandHash, claim,
          input.reasonCode, now, ids);
        if (waitingForUser) {
          await moveRunToWaitingForUser(repositories, run, input.authority.workerId,
            `${input.idempotencyKey}:waiting`, input.reasonCode, now, ids);
        }
        return { taskId: task.id, taskRevision: task.revision,
          attempt: updatedCoordination.attempt, disposition: 'updated' as const };
      });
    },

    async acceptSubtask(input: TaskCoordinationCommandInput & {
      acceptance: SubtaskAcceptanceV1;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'accept-subtask',
          acceptance: input.acceptance });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-acceptance-decided');
          const task = await requireTask(repositories, event.payload.taskId);
          return { taskId: task.id, taskRevision: task.revision,
            status: task.status === 'done' ? 'done' as const : 'in_review' as const,
            disposition: 'existing' as const };
        }
        const acceptance = input.acceptance;
        if (acceptance.decidedBy !== 'manager') conflict('TASK_ACCEPTANCE_ACTOR_MISMATCH');
        const task = await requireTask(repositories, acceptance.taskId);
        const coordination = await requireSubtaskCoordination(repositories, task.id, run.id);
        assertExpectedRevision(task.revision, acceptance.expectedTaskRevision);
        if (coordination.attempt !== acceptance.taskAttempt) conflict('TASK_ATTEMPT_CONFLICT');
        if (task.status !== 'in_review') conflict('TASK_ACCEPTANCE_STATE_CONFLICT');
        const delivery = await repositories.coordination.deliveries.getById(acceptance.deliveryId);
        if (!delivery || delivery.taskId !== task.id || delivery.taskRevision !== task.revision
          || delivery.taskAttempt !== coordination.attempt
          || delivery.claimLeaseId !== acceptance.claimLeaseId) {
          conflict('TASK_DELIVERY_AUTHORITY_MISMATCH');
        }
        const claim = await repositories.coordination.claimLeases.getById(acceptance.claimLeaseId);
        if (!claim || claim.taskId !== task.id || claim.taskRevision !== task.revision
          || claim.taskAttempt !== coordination.attempt) conflict('TASK_CLAIM_AUTHORITY_MISMATCH');
        const currentClaim = await repositories.coordination.claimLeases.getCurrent({
          taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
        });
        if (claim.status !== 'active' || claim.expiresAt <= now || currentClaim?.id !== claim.id) {
          conflict('TASK_CLAIM_NOT_ACTIVE');
        }
        if (await repositories.coordination.acceptances.getCanonicalByDelivery(delivery.id)) {
          conflict('TASK_ACCEPTANCE_ALREADY_DECIDED');
        }
        if (acceptance.decision === 'accepted') {
          const criteria = (await repositories.coordination.criteria.list(task.id))
            .filter((criterion) => criterion.introducedRevision <= task.revision
              && (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision));
          const snapshots = (await repositories.coordination.evidenceSnapshots.listByTask(task.id))
            .filter((snapshot) => snapshot.taskRevision === task.revision
              && snapshot.taskAttempt === coordination.attempt
              && snapshot.invocationId === delivery.invocationId);
          const evidenceRefs = acceptance.criteriaResults.flatMap((result) => result.evidenceRefs);
          const evidenceFacts = snapshots.flatMap((snapshot) => {
            const ref = evidenceRefs.find((candidate) => snapshot.kind === candidate.kind
              && snapshot.sourceId === candidate.id && snapshot.snapshotHash === candidate.snapshotHash
              && snapshot.snapshotRevision === candidate.snapshotRevision
              && snapshot.capturedAt === candidate.capturedAt);
            return ref ? [{ ref, available: true, visible: true,
              currentSnapshotHash: snapshot.snapshotHash }] : [];
          });
          if (evaluateSubtaskAcceptance({ criteria, criteriaResults: acceptance.criteriaResults,
            evidenceSnapshots: evidenceFacts, highRisk: false, conflictingEvidence: false }).kind !== 'accepted') {
            conflict('TASK_ACCEPTANCE_POLICY_REJECTED');
          }
        }
        await repositories.coordination.acceptances.create({ ...acceptance,
          id: ids.nextId(), teamId: run.teamId, decisionVersion: 1, canonical: true });
        const status = acceptance.decision === 'accepted' ? 'done' as const : 'in_review' as const;
        if (status === 'done') {
          const updated = await repositories.tasks.update({ taskId: task.id,
            changes: { status, updatedAt: now } });
          if (!updated) conflict('TASK_NOT_FOUND');
        }
        await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-acceptance-decided', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
          payload: { taskId: task.id, acceptance },
        }, now, ids, commandHash);
        if (status === 'done') {
          await appendTaskEvent(repositories, {
            managementRunId: run.id, type: 'task-state-changed', actorKind: 'manager',
            actorId: input.authority.workerId, idempotencyKey: `${input.idempotencyKey}:state`,
            payload: { taskId: task.id, taskRevision: task.revision, from: 'in_review', to: 'done' },
          }, now, ids, commandHash);
        }
        return { taskId: task.id, taskRevision: task.revision, status,
          disposition: 'updated' as const };
      });
    },

    async reportBlocked(input: TaskCoordinationCommandInput & {
      taskId: string; expectedTaskRevision: number; reasonCode: string;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'report-blocked',
          taskId: input.taskId, expectedTaskRevision: input.expectedTaskRevision,
          reasonCode: input.reasonCode });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-state-changed');
          return { taskId: event.payload.taskId, status: 'todo' as const,
            reportedAt: event.createdAt, disposition: 'existing' as const };
        }
        const task = await requireTask(repositories, input.taskId);
        const coordination = await requireSubtaskCoordination(repositories, task.id, run.id);
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        if (task.status !== 'in_progress') conflict('TASK_BLOCKED_STATE_CONFLICT');
        const claim = await repositories.coordination.claimLeases.getCurrent({
          taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
        });
        const waitingForUser = coordination.attempt >= coordination.maxAttempts
          || requiresHumanIntervention(input.reasonCode);
        if (!waitingForUser) {
          const updatedCoordination = await repositories.coordination.coordinations.update({
            expectedTaskRevision: task.revision,
            record: { ...coordination, attempt: coordination.attempt + 1, updatedAt: now },
          });
          if (!updatedCoordination) conflict('TASK_COORDINATION_REVISION_CONFLICT');
        }
        const updated = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'todo', updatedAt: now } });
        if (!updated) conflict('TASK_NOT_FOUND');
        const event = await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-state-changed', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
          payload: { taskId: task.id, taskRevision: task.revision, from: 'in_progress', to: 'todo' },
        }, now, ids, commandHash);
        await invalidateCapturedClaim(repositories, run.id, input.authority.workerId,
          `${input.idempotencyKey}:claim-invalidated`, commandHash, claim,
          input.reasonCode, now, ids);
        if (waitingForUser) {
          await moveRunToWaitingForUser(repositories, run, input.authority.workerId,
            `${input.idempotencyKey}:waiting`, input.reasonCode, now, ids);
        }
        return { taskId: task.id, status: 'todo' as const,
          reportedAt: event.event.createdAt, disposition: 'updated' as const };
      });
    },

    async recordInvocationFailure(input: {
      managementRunId: string;
      invocationId: string;
      reasonCode: string;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await repositories.management.runs.getById(input.managementRunId);
        if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          return { disposition: 'ignored' as const };
        }
        const invocation = await repositories.management.invocations.getById(input.invocationId);
        const context = invocation?.intent.taskContext;
        if (!invocation || invocation.managementRunId !== run.id || !context) {
          return { disposition: 'ignored' as const };
        }
        const coordination = await repositories.coordination.coordinations.getByTaskId(context.taskId);
        if (!coordination || coordination.nodeKind !== 'subtask'
          || coordination.managementRunId !== run.id) {
          return { disposition: 'ignored' as const };
        }
        const task = await repositories.tasks.getById(context.taskId);
        if (!task || task.revision !== context.taskRevision
          || coordination.attempt !== context.taskAttempt
          || coordination.taskRevision !== task.revision) {
          return { disposition: 'stale' as const };
        }
        const idempotencyKey = `invocation-failure:${invocation.id}`;
        const commandHash = hashManagementCommandInput({ command: 'record-invocation-failure',
          invocationId: invocation.id, reasonCode: input.reasonCode });
        const replay = await findReplay(repositories, run.id, idempotencyKey, commandHash);
        if (replay) {
          return { disposition: 'existing' as const, taskId: task.id,
            taskRevision: task.revision, attempt: coordination.attempt,
            waitingForUser: run.status === 'waiting_for_user' };
        }
        if (task.status !== 'in_progress') return { disposition: 'ignored' as const };
        const invocationCount = (await repositories.management.invocations.listByRun(run.id)).length;
        const waitingForUser = coordination.attempt >= coordination.maxAttempts
          || invocationCount >= run.budget.maxExternalInvocations
          || requiresHumanIntervention(input.reasonCode);
        const nextAttempt = waitingForUser ? coordination.attempt : coordination.attempt + 1;
        if (nextAttempt !== coordination.attempt) {
          const updatedCoordination = await repositories.coordination.coordinations.update({
            expectedTaskRevision: task.revision,
            record: { ...coordination, attempt: nextAttempt, updatedAt: now },
          });
          if (!updatedCoordination) conflict('TASK_COORDINATION_REVISION_CONFLICT');
        }
        const updatedTask = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'todo', updatedAt: now } });
        if (!updatedTask) conflict('TASK_NOT_FOUND');
        await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-state-changed', actorKind: 'system',
          actorId: 'system', idempotencyKey,
          payload: { taskId: task.id, taskRevision: task.revision,
            from: 'in_progress', to: 'todo' },
        }, now, ids, commandHash);
        const claim = await repositories.coordination.claimLeases.getById(context.claimLeaseId);
        if (claim?.status === 'active') {
          await invalidateCapturedClaim(repositories, run.id, 'system',
            `${idempotencyKey}:claim-invalidated`, commandHash, claim,
            input.reasonCode, now, ids, 'system');
        }
        if (waitingForUser) {
          const reasonCode = invocationCount >= run.budget.maxExternalInvocations
            ? 'TASK_INVOCATION_BUDGET_EXHAUSTED' : input.reasonCode;
          await moveRunToWaitingForUser(repositories, run, 'system',
            `${idempotencyKey}:waiting`, reasonCode, now, ids, 'system');
        }
        return { disposition: 'updated' as const, taskId: task.id,
          taskRevision: task.revision, attempt: nextAttempt, waitingForUser };
      });
    },

    async getRootDeliveryReadiness(input: { managementRunId: string }) {
      return unitOfWork.run(async (repositories) => {
        const run = await repositories.management.runs.getById(input.managementRunId);
        if (!run) conflict('MANAGEMENT_RUN_NOT_FOUND');
        return inspectRootDeliveryReadiness(repositories, run);
      });
    },

    async submitRootDelivery(input: TaskCoordinationCommandInput & {
      messageId: string;
      contributingInvocationIds: readonly string[];
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await authorizeCommand(repositories, input.authority, now);
        const commandHash = hashManagementCommandInput({ command: 'submit-root-delivery',
          messageId: input.messageId,
          contributingInvocationIds: [...input.contributingInvocationIds].sort() });
        const replay = await findReplay(repositories, run.id, input.idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'root-delivery-submitted');
          return { deliveryMessageId: event.payload.messageId,
            status: 'in_review' as const, disposition: 'existing' as const };
        }
        const readiness = await inspectRootDeliveryReadiness(repositories, run);
        if (!sameStrings(readiness.contributingInvocationIds, input.contributingInvocationIds)) {
          conflict('MANAGEMENT_ROOT_DELIVERY_CONTRIBUTIONS_INCOMPLETE');
        }
        const task = await requireTask(repositories, readiness.rootTaskId);
        if (task.status !== 'in_progress') conflict('MANAGEMENT_ROOT_TASK_STATUS_CONFLICT');
        const updated = await repositories.tasks.update({ taskId: task.id,
          changes: { status: 'in_review', updatedAt: now } });
        if (!updated) conflict('TASK_NOT_FOUND');
        await appendValidatedManagementEventInTransaction(repositories.management, {
          managementRunId: run.id, type: 'root-delivery-submitted', actorKind: 'manager',
          actorId: input.authority.workerId, idempotencyKey: input.idempotencyKey,
          payload: { messageId: input.messageId,
            contributingInvocationIds: [...readiness.contributingInvocationIds] },
        }, now, ids, { payloadHash: commandHash, parseEvent: parsePhase1ManagementEvent });
        await repositories.management.runs.update({ ...run, status: 'in_review', updatedAt: now });
        return { deliveryMessageId: input.messageId, status: 'in_review' as const,
          disposition: 'updated' as const };
      });
    },

    async reopenRootTaskFromHuman(input: {
      managementRunId: string;
      taskId: string;
      userId: string;
      expectedTaskRevision: number;
    }) {
      return unitOfWork.run(async (repositories) => {
        const now = clock.now();
        const run = await repositories.management.runs.getById(input.managementRunId);
        if (!run || run.rootTaskId !== input.taskId) conflict('MANAGEMENT_ROOT_TASK_MISMATCH');
        const task = await requireTask(repositories, input.taskId);
        const idempotencyKey = `root-reopened:${task.id}:${input.expectedTaskRevision}`;
        const commandHash = hashManagementCommandInput({ command: 'reopen-root-task',
          taskId: task.id, expectedTaskRevision: input.expectedTaskRevision, userId: input.userId });
        const replay = await findReplay(repositories, run.id, idempotencyKey, commandHash);
        if (replay) {
          const event = requireReplayEvent(replay, 'task-revised');
          return { task: await requireTask(repositories, event.payload.taskId),
            disposition: 'existing' as const };
        }
        const coordination = await requireCoordinationForRun(repositories, task.id, run.id);
        if (coordination.nodeKind !== 'root') conflict('TASK_ROOT_REQUIRED');
        assertExpectedRevision(task.revision, input.expectedTaskRevision);
        if (run.status !== 'in_review' || task.status !== 'in_review') {
          conflict('MANAGEMENT_ROOT_TASK_NOT_IN_REVIEW');
        }
        if (task.revision === Number.MAX_SAFE_INTEGER) conflict('TASK_REVISION_OVERFLOW');
        const nextRevision = task.revision + 1;
        const updatedTask = await repositories.tasks.updateAtRevision({ taskId: task.id,
          expectedRevision: task.revision, nextRevision,
          changes: { status: 'in_progress', updatedAt: now } });
        if (!updatedTask) conflict('TASK_REVISION_CONFLICT');
        const updatedCoordination = await repositories.coordination.coordinations.update({
          expectedTaskRevision: task.revision,
          record: { ...coordination, taskRevision: nextRevision, attempt: 1, updatedAt: now },
        });
        if (!updatedCoordination) conflict('TASK_COORDINATION_REVISION_CONFLICT');
        const criteria = activeCriteria(
          await repositories.coordination.criteria.list(task.id), task.revision);
        await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-revised', actorKind: 'human',
          actorId: input.userId, idempotencyKey,
          payload: { taskId: task.id, previousRevision: task.revision,
            taskRevision: nextRevision, criterionIds: criteria.map((criterion) => criterion.id),
            reasonCode: 'HUMAN_REJECTED_ROOT_DELIVERY' },
        }, now, ids, commandHash);
        await appendTaskEvent(repositories, {
          managementRunId: run.id, type: 'task-state-changed', actorKind: 'human',
          actorId: input.userId, idempotencyKey: `${idempotencyKey}:state`,
          payload: { taskId: task.id, taskRevision: nextRevision,
            from: 'in_review', to: 'in_progress' },
        }, now, ids, commandHash);
        await repositories.management.runs.update({ ...run, status: 'running', updatedAt: now });
        return { task: updatedTask, disposition: 'updated' as const };
      });
    },
  };
}

async function authorizeCommand(repositories: TransactionRepositories,
  authority: LeaseAuthorityInput, now: number) {
  if (!authority.managementRunId) conflict('MANAGEMENT_RUN_NOT_FOUND');
  await authorizeManagementWrite(repositories.management, authority, now);
  const run = await repositories.management.runs.getById(authority.managementRunId);
  if (!run) conflict('MANAGEMENT_RUN_NOT_FOUND');
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    conflict('MANAGEMENT_RUN_TERMINAL');
  }
  if (!run.rootTaskId) conflict('MANAGEMENT_ROOT_TASK_REQUIRED');
  return run;
}

async function findReplay(repositories: TransactionRepositories, managementRunId: string,
  idempotencyKey: string, commandHash: string) {
  if (!idempotencyKey) conflict('TASK_COMMAND_INVALID');
  const events = await repositories.management.events.list(managementRunId);
  const base = events.find(({ event }) => event.idempotencyKey === idempotencyKey);
  if (!base) return null;
  if (base.payloadHash !== commandHash) conflict('TASK_COMMAND_IDEMPOTENCY_CONFLICT');
  const commandEvents = events.filter((record) =>
    (record.event.idempotencyKey === idempotencyKey
      || record.event.idempotencyKey.startsWith(`${idempotencyKey}:`))
    && record.payloadHash === commandHash);
  return { events: commandEvents,
    lastSequence: commandEvents.at(-1)?.event.sequence ?? base.event.sequence };
}

function requireReplayEvent<T extends TaskCoordinationEventType>(replay: CommandReplay, type: T) {
  const event = replay.events.find((record) => record.event.type === type)?.event;
  if (!event) conflict('TASK_COMMAND_RESULT_MISSING');
  return event as Extract<ManagementEventV1, { type: T }>;
}

function replayRevisionResult(replay: CommandReplay) {
  const event = requireReplayEvent(replay, 'task-revised');
  return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
    criterionIds: event.payload.criterionIds, taskGraphRevision: replay.lastSequence,
    disposition: 'existing' as const };
}

function replayTaskRevisionResult(replay: CommandReplay) {
  const event = requireReplayEvent(replay, 'task-revised');
  return { taskId: event.payload.taskId, taskRevision: event.payload.taskRevision,
    taskGraphRevision: replay.lastSequence, disposition: 'existing' as const };
}

async function appendTaskEvent<T extends TaskCoordinationEventType>(
  repositories: TransactionRepositories,
  input: { managementRunId: string; type: T;
    actorKind: 'manager' | 'system' | 'human'; actorId: string;
    idempotencyKey: string; payload: ManagementEventPayloadMapV1[T] },
  now: number,
  ids: { nextId(): string },
  commandHash: string,
) {
  return appendValidatedManagementEventInTransaction(repositories.management, input, now, ids, {
    payloadHash: commandHash, parseEvent: parseTaskCoordinationManagementEvent,
  });
}

async function appendRevisionEvent(repositories: TransactionRepositories, managementRunId: string,
  actorId: string, idempotencyKey: string, commandHash: string,
  revised: RevisionResult, reasonCode: string, now: number, ids: { nextId(): string }) {
  return appendTaskEvent(repositories, {
    managementRunId, type: 'task-revised', actorKind: 'manager', actorId, idempotencyKey,
    payload: { taskId: revised.task.id, previousRevision: revised.previousRevision,
      taskRevision: revised.task.revision, criterionIds: revised.criterionIds, reasonCode },
  }, now, ids, commandHash);
}

interface RevisionInput {
  objective: string;
  acceptanceCriteria: readonly AcceptanceCriterionDto[];
  dependencyTaskIds: readonly string[];
  claimPolicy: 'open' | 'targeted';
  assigneeId?: string;
  requiredCapabilities: readonly string[];
  maxAttempts: number;
}

interface RevisionResult {
  changed: boolean;
  previousRevision: number;
  task: TaskRecord;
  coordination: TaskCoordinationRecord;
  criterionIds: readonly string[];
  claim: TaskClaimLeaseRecord | null;
}

async function reviseInTransaction(repositories: TransactionRepositories,
  run: Awaited<ReturnType<TransactionRepositories['management']['runs']['getById']>> & {},
  task: TaskRecord, coordination: TaskCoordinationRecord, next: RevisionInput,
  now: number): Promise<RevisionResult> {
  validateCapabilities(next.requiredCapabilities);
  if (!Number.isSafeInteger(next.maxAttempts) || next.maxAttempts <= 0) conflict('TASK_MAX_ATTEMPTS_INVALID');
  const allCriteria = await repositories.coordination.criteria.list(task.id);
  const currentCriteria = activeCriteria(allCriteria, task.revision);
  const currentDependencies = (await repositories.coordination.dependencies.list(task.id))
    .map((edge) => edge.dependencyTaskId);
  const decision = evaluateTaskRevisionChange({
    currentRevision: task.revision, expectedRevision: task.revision,
    current: { objective: objectiveOf(task), acceptanceCriteria: currentCriteria,
      dependencyTaskIds: currentDependencies, claimPolicy: coordination.claimPolicy,
      assigneeId: task.assigneeId },
    next: { objective: next.objective, acceptanceCriteria: next.acceptanceCriteria,
      dependencyTaskIds: next.dependencyTaskIds, claimPolicy: next.claimPolicy,
      assigneeId: next.assigneeId },
    retiredCriterionIds: allCriteria.filter((criterion) => criterion.retiredRevision !== undefined)
      .map((criterion) => criterion.id),
  });
  if (decision.kind === 'rejected') conflict(`TASK_REVISION_${code(decision.reason)}`);
  const extendedChanged = !sameStrings(coordination.requiredCapabilities,
    next.requiredCapabilities) || coordination.maxAttempts !== next.maxAttempts;
  if (decision.kind === 'unchanged' && !extendedChanged) {
    return { changed: false, previousRevision: task.revision, task, coordination,
      criterionIds: currentCriteria.map((criterion) => criterion.id), claim: null };
  }
  if (task.revision === Number.MAX_SAFE_INTEGER) conflict('TASK_REVISION_OVERFLOW');
  const nextRevision = task.revision + 1;
  const claim = await repositories.coordination.claimLeases.getCurrent({
    taskId: task.id, taskRevision: task.revision, taskAttempt: coordination.attempt,
  });
  const nextIds = new Set(next.acceptanceCriteria.map((criterion) => criterion.id));
  for (const criterion of currentCriteria) {
    if (!nextIds.has(criterion.id)) {
      const retired = await repositories.coordination.criteria.retire({
        taskId: task.id, criterionId: criterion.id, retiredRevision: nextRevision,
      });
      if (!retired) conflict('TASK_CRITERION_RETIRE_CONFLICT');
    }
  }
  const currentById = new Map(currentCriteria.map((criterion) => [criterion.id, criterion]));
  for (const [position, criterion] of next.acceptanceCriteria.entries()) {
    if (currentById.has(criterion.id)) {
      await repositories.coordination.criteria.updatePosition({ taskId: task.id,
        criterionId: criterion.id, position });
    } else {
      await repositories.coordination.criteria.create({ ...criterion, taskId: task.id,
        introducedRevision: nextRevision, position });
    }
  }
  const nextDependencies = new Set(next.dependencyTaskIds);
  for (const dependencyTaskId of currentDependencies) {
    if (!nextDependencies.has(dependencyTaskId)) {
      await repositories.coordination.dependencies.delete({ taskId: task.id, dependencyTaskId });
    }
  }
  for (const dependencyTaskId of next.dependencyTaskIds) {
    if (!currentDependencies.includes(dependencyTaskId)) {
      await requireCoordinationForRun(repositories, dependencyTaskId, coordination.managementRunId);
      await repositories.coordination.dependencies.create({ taskId: task.id,
        dependencyTaskId, taskRevision: nextRevision });
    }
  }
  const updatedTask = await repositories.tasks.updateAtRevision({
    taskId: task.id, expectedRevision: task.revision, nextRevision,
    changes: { description: next.objective, assigneeId: next.assigneeId, updatedAt: now },
  });
  if (!updatedTask) conflict('TASK_REVISION_CONFLICT');
  const updatedCoordination = await repositories.coordination.coordinations.update({
    expectedTaskRevision: task.revision,
    record: { ...coordination, claimPolicy: next.claimPolicy,
      requiredCapabilities: [...next.requiredCapabilities], maxAttempts: next.maxAttempts,
      taskRevision: nextRevision, attempt: 1, updatedAt: now },
  });
  if (!updatedCoordination) conflict('TASK_COORDINATION_REVISION_CONFLICT');
  await validateRunDag(repositories, run);
  return { changed: true, previousRevision: task.revision, task: updatedTask,
    coordination: updatedCoordination, criterionIds: next.acceptanceCriteria.map((criterion) => criterion.id),
    claim };
}

async function invalidateCapturedClaim(repositories: TransactionRepositories,
  managementRunId: string, actorId: string, idempotencyKey: string, commandHash: string,
  claim: TaskClaimLeaseRecord | null, reasonCode: string, now: number,
  ids: { nextId(): string }, actorKind: 'manager' | 'system' = 'manager') {
  if (!claim) return null;
  const invalidated = await repositories.coordination.claimLeases.update({
    id: claim.id, expectedStatus: 'active', status: 'invalidated',
    heartbeatAt: claim.heartbeatAt, expiresAt: claim.expiresAt, releasedAt: now,
  });
  if (!invalidated) conflict('TASK_CLAIM_INVALIDATION_CONFLICT');
  const invalidatedInvocationIds = (await repositories.management.invocations.listByRun(managementRunId))
    .filter((invocation) => invocation.intent.taskContext?.claimLeaseId === claim.id)
    .map((invocation) => invocation.id).sort();
  return appendTaskEvent(repositories, {
    managementRunId, type: 'claim-invalidated', actorKind, actorId, idempotencyKey,
    payload: { taskId: claim.taskId, previousTaskRevision: claim.taskRevision,
      claimLeaseId: claim.id, invalidatedInvocationIds, reasonCode },
  }, now, ids, commandHash);
}

async function moveRunToWaitingForUser(
  repositories: TransactionRepositories,
  run: NonNullable<Awaited<ReturnType<TransactionRepositories['management']['runs']['getById']>>>,
  actorId: string,
  idempotencyKey: string,
  reasonCode: string,
  now: number,
  ids: { nextId(): string },
  actorKind: 'manager' | 'system' = 'manager',
) {
  await appendManagementEventInTransaction(repositories.management, {
    managementRunId: run.id, type: 'waiting-for-user', actorKind, actorId,
    idempotencyKey, payload: { reasonCode },
  }, now, ids);
  if (run.status !== 'waiting_for_user') {
    await repositories.management.runs.update({ ...run, status: 'waiting_for_user', updatedAt: now });
  }
}

async function inspectRootDeliveryReadiness(
  repositories: TransactionRepositories,
  run: NonNullable<Awaited<ReturnType<TransactionRepositories['management']['runs']['getById']>>>,
) {
  if (!run.rootTaskId) conflict('MANAGEMENT_ROOT_TASK_REQUIRED');
  const root = await requireCoordinationForRun(repositories, run.rootTaskId, run.id);
  if (root.nodeKind !== 'root') conflict('TASK_ROOT_REQUIRED');
  const coordinations = await repositories.coordination.coordinations.listByManagementRun(run.id);
  const subtasks = coordinations.filter((coordination) => coordination.nodeKind === 'subtask');
  if (subtasks.length === 0) conflict('MANAGEMENT_ROOT_DELIVERY_SUBTASKS_REQUIRED');
  const parentTaskIds = new Set(subtasks.map((coordination) => coordination.parentTaskId)
    .filter((taskId): taskId is string => taskId !== undefined));
  const leaves = subtasks.filter((coordination) => !parentTaskIds.has(coordination.taskId));
  const contributingInvocationIds: string[] = [];
  for (const coordination of subtasks) {
    await requireDependenciesDone(repositories, coordination.taskId);
  }
  for (const leaf of leaves) {
    const task = await requireTask(repositories, leaf.taskId);
    if (task.status !== 'done' || task.revision !== leaf.taskRevision) {
      conflict('MANAGEMENT_ROOT_DELIVERY_LEAF_NOT_ACCEPTED');
    }
    const deliveries = (await repositories.coordination.deliveries.listByTask(task.id))
      .filter((delivery) => delivery.taskRevision === task.revision
        && delivery.taskAttempt === leaf.attempt)
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    let acceptedInvocationId: string | undefined;
    for (const delivery of deliveries) {
      const acceptance = await repositories.coordination.acceptances.getCanonicalByDelivery(delivery.id);
      if (acceptance?.decision === 'accepted'
        && acceptance.expectedTaskRevision === task.revision
        && acceptance.taskAttempt === leaf.attempt
        && acceptance.claimLeaseId === delivery.claimLeaseId) {
        acceptedInvocationId = delivery.invocationId;
        break;
      }
    }
    if (!acceptedInvocationId) conflict('MANAGEMENT_ROOT_DELIVERY_ACCEPTANCE_MISSING');
    const invocation = await repositories.management.invocations.getById(acceptedInvocationId);
    if (!invocation || invocation.managementRunId !== run.id) {
      conflict('MANAGEMENT_ROOT_DELIVERY_INVOCATION_FORBIDDEN');
    }
    contributingInvocationIds.push(acceptedInvocationId);
  }
  return { rootTaskId: run.rootTaskId,
    contributingInvocationIds: [...new Set(contributingInvocationIds)].sort() };
}

async function validateRunDag(repositories: TransactionRepositories,
  run: NonNullable<Awaited<ReturnType<TransactionRepositories['management']['runs']['getById']>>>) {
  if (!run.rootTaskId) conflict('MANAGEMENT_ROOT_TASK_REQUIRED');
  const coordinations = await repositories.coordination.coordinations.listByManagementRun(run.id);
  const nodes = await Promise.all(coordinations.map(async (coordination) => {
    const task = await requireTask(repositories, coordination.taskId);
    const dependencies = await repositories.coordination.dependencies.list(coordination.taskId);
    return { taskId: task.id, parentTaskId: coordination.parentTaskId,
      dependencyTaskIds: dependencies.map((edge) => edge.dependencyTaskId),
      isTerminal: task.status === 'done' || task.status === 'closed' };
  }));
  const invocationCount = (await repositories.management.invocations.listByRun(run.id)).length;
  const decision = evaluateTaskDag({ rootTaskId: run.rootTaskId, nodes,
    limits: { maxDepth: run.budget.maxDepth, maxFanOut: run.budget.maxSubtasks,
      maxOpenTasks: run.budget.maxSubtasks },
    invocationBudget: { consumed: invocationCount, reserved: 0,
      limit: run.budget.maxExternalInvocations } });
  if (decision.kind === 'rejected') conflict(`TASK_DAG_${code(decision.reason)}`);
}

function validateNewCoordination(input: { objective: string;
  criteria: readonly AcceptanceCriterionDto[]; dependencyTaskIds: readonly string[];
  claimPolicy: 'open' | 'targeted'; assigneeId?: string;
  requiredCapabilities: readonly string[]; maxAttempts: number }) {
  validateCapabilities(input.requiredCapabilities);
  if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts <= 0) {
    conflict('TASK_MAX_ATTEMPTS_INVALID');
  }
  const decision = evaluateTaskRevisionChange({ currentRevision: 1, expectedRevision: 1,
    current: { objective: input.objective, acceptanceCriteria: input.criteria,
      dependencyTaskIds: input.dependencyTaskIds, claimPolicy: input.claimPolicy,
      assigneeId: input.assigneeId },
    next: { objective: input.objective, acceptanceCriteria: input.criteria,
      dependencyTaskIds: input.dependencyTaskIds, claimPolicy: input.claimPolicy,
      assigneeId: input.assigneeId }, retiredCriterionIds: [] });
  if (decision.kind === 'rejected') conflict(`TASK_REVISION_${code(decision.reason)}`);
}

function validateCapabilities(capabilities: readonly string[]) {
  if (capabilities.some((capability) => capability.length === 0)
    || new Set(capabilities).size !== capabilities.length) {
    conflict('TASK_CAPABILITIES_INVALID');
  }
}

async function createCriteria(repositories: TransactionRepositories, taskId: string,
  revision: number, criteria: readonly AcceptanceCriterionDto[]) {
  for (const [position, criterion] of criteria.entries()) {
    await repositories.coordination.criteria.create({ ...criterion, taskId,
      introducedRevision: revision, position });
  }
}

function activeCriteria(criteria: readonly TaskAcceptanceCriterionRecord[], revision: number) {
  return criteria.filter((criterion) => criterion.introducedRevision <= revision
    && (criterion.retiredRevision === undefined || criterion.retiredRevision > revision));
}

async function requireDependenciesDone(repositories: TransactionRepositories, taskId: string) {
  for (const dependency of await repositories.coordination.dependencies.list(taskId)) {
    const task = await requireTask(repositories, dependency.dependencyTaskId);
    if (task.status !== 'done') conflict('TASK_DEPENDENCIES_NOT_READY');
  }
}

async function requireTask(repositories: TransactionRepositories, taskId: string) {
  const task = await repositories.tasks.getById(taskId);
  if (!task) conflict('TASK_NOT_FOUND');
  return task;
}

async function requireCoordination(repositories: TransactionRepositories, taskId: string) {
  const coordination = await repositories.coordination.coordinations.getByTaskId(taskId);
  if (!coordination) conflict('TASK_COORDINATION_NOT_FOUND');
  return coordination;
}

async function requireCoordinationForRun(repositories: TransactionRepositories, taskId: string,
  managementRunId: string) {
  const coordination = await requireCoordination(repositories, taskId);
  if (coordination.managementRunId !== managementRunId) conflict('TASK_MANAGEMENT_RUN_MISMATCH');
  return coordination;
}

async function requireSubtaskCoordination(repositories: TransactionRepositories, taskId: string,
  managementRunId: string) {
  const coordination = await requireCoordinationForRun(repositories, taskId, managementRunId);
  if (coordination.nodeKind !== 'subtask') conflict('TASK_SUBTASK_REQUIRED');
  return coordination;
}

function assertExpectedRevision(currentRevision: number, expectedRevision: number) {
  const decision = authorizeTaskRevision({ currentRevision, presentedRevision: expectedRevision });
  if (decision.kind === 'rejected') {
    const reason = decision.reason === 'stale-revision' ? 'STALE'
      : decision.reason === 'future-revision' ? 'FUTURE' : 'INVALID';
    conflict(`TASK_REVISION_${reason}`);
  }
}

function objectiveOf(task: TaskRecord): string { return task.description ?? task.title; }
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
function requiresHumanIntervention(reasonCode: string): boolean {
  const codeValue = reasonCode.toUpperCase();
  return ['NO_CANDIDATE', 'NO_CANDIDATES', 'BUDGET_EXHAUSTED', 'EVIDENCE_CONFLICT',
    'RESULT_CONFLICT', 'CONFLICTING_RESULT', 'USER_CANCELLED']
    .some((token) => codeValue.includes(token));
}
function code(value: string): string { return value.toUpperCase().replaceAll('-', '_'); }
function conflict(codeValue: string): never { throw new ManagementConflictError(codeValue); }
