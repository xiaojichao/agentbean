import { createHash } from 'node:crypto';
import type {
  AgentInvocationStatus,
  ManagementRunDto,
  ManagementWorkerToolRequestV1,
  ManagementWorkerToolResultV1,
  Phase1ManagementWorkerToolName,
  Phase1ManagementWorkerToolOutputMapV1,
  Phase2ManagementWorkerToolInputMapV1,
  Phase2ManagementWorkerToolOutputMapV1,
  Phase2TaskToolRequestV2,
  Phase2TaskToolResultV2,
} from '../../../../../packages/contracts/src/index.js';
import type { MessageRecord, ServerNextRepositories } from '../repositories.js';
import { createInvocationGateway } from './invocation-gateway.js';
import type { createManagementKernel } from './management-kernel.js';
import type { createTaskCoordinationKernel } from './task-coordination-kernel.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;
type TaskCoordinationKernel = ReturnType<typeof createTaskCoordinationKernel>;
type ManagementToolRequest = ManagementWorkerToolRequestV1 | Phase2TaskToolRequestV2;
type ManagementToolResult = ManagementWorkerToolResultV1 | Phase2TaskToolResultV2;
type ToolHandler<K extends Phase1ManagementWorkerToolName> = (
  input: Extract<ManagementWorkerToolRequestV1, { toolName: K }>,
) => Promise<Phase1ManagementWorkerToolOutputMapV1[K]>;
export type ToolHandlers = { [K in Phase1ManagementWorkerToolName]?: ToolHandler<K> };
type Phase2ToolHandler<K extends keyof Phase2ManagementWorkerToolInputMapV1> = (
  input: Extract<Phase2TaskToolRequestV2, { toolName: K }>,
) => Promise<Phase2ManagementWorkerToolOutputMapV1[K]>;
export type Phase2ToolHandlers = {
  [K in keyof Phase2ManagementWorkerToolInputMapV1]?: Phase2ToolHandler<K>;
};
export type AnyToolHandlers = ToolHandlers & Phase2ToolHandlers;

const readTools = new Set<string>([
  'context.get_root_message',
  'context.get_root_task',
  'context.get_visible_thread',
  'context.get_management_state',
  'agents.list_capabilities',
  'agents.get_status',
  'tasks.wait',
]);

export function createManagementToolExecutor(input: {
  readonly kernel: ManagementKernel;
  readonly handlers: AnyToolHandlers;
}) {
  return async (request: ManagementToolRequest): Promise<ManagementToolResult> => {
    const base = {
      schemaVersion: request.schemaVersion,
      ...('managementPhase' in request ? { managementPhase: 2 as const } : {}),
      commandId: request.commandId,
      managementRunId: request.managementRunId,
      workerId: request.workerId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
    };
    try {
      if (!readTools.has(request.toolName)) {
        if (!('leaseToken' in request) || !('fencingToken' in request)) throw new Error('MISSING_WRITE_AUTHORITY');
        await input.kernel.authorizeWrite({
          managementRunId: request.managementRunId,
          workerId: request.workerId,
          leaseToken: request.leaseToken,
          fencingToken: request.fencingToken,
        });
      }
      const handler = input.handlers[request.toolName] as ((value: ManagementToolRequest) => Promise<unknown>) | undefined;
      if (!handler) {
        return { ...base, ok: false, errorCode: 'UNAVAILABLE', diagnosticCode: 'TOOL_NOT_WIRED', retryable: false } as ManagementToolResult;
      }
      const output = await handler(request);
      return { ...base, ok: true, output } as ManagementToolResult;
    } catch (error) {
      const code = error instanceof Error ? error.message : 'UNKNOWN';
      const unauthorized = code.startsWith('LEASE_') || code === 'MISSING_WRITE_AUTHORITY';
      const diagnosticCode = /^[A-Z0-9_:-]{1,80}$/.test(code) ? code : 'TOOL_EXECUTION_FAILED';
      return {
        ...base,
        ok: false,
        errorCode: unauthorized ? 'NOT_AUTHORIZED' : isConflictDiagnostic(diagnosticCode) ? 'CONFLICT' : 'INVALID_REQUEST',
        diagnosticCode,
        retryable: false,
      } as ManagementToolResult;
    }
  };
}

export function createPhase2ManagementToolHandlers(input: {
  readonly kernel: TaskCoordinationKernel;
}): Phase2ToolHandlers {
  const { kernel } = input;
  return {
    'tasks.create_subtasks': async (request) => {
      const created = await kernel.createSubtasks({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        parentTaskId: request.input.parentTaskId,
        subtasks: request.input.subtasks.map((draft) => ({
          ...draft,
          taskId: deterministicTaskId(request.managementRunId, request.input.parentTaskId, draft.clientKey),
        })),
      });
      return { taskIds: created.taskIds, taskGraphRevision: created.taskGraphRevision };
    },
    'tasks.add_dependency': async (request) => {
      const added = await kernel.addDependency({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        ...request.input,
      });
      return { taskId: added.taskId, taskRevision: added.taskRevision,
        taskGraphRevision: added.taskGraphRevision };
    },
    'tasks.publish_for_claim': async (request) => {
      const published = await kernel.publishForClaim({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        ...request.input,
      });
      return { taskId: published.taskId, taskRevision: published.taskRevision, status: 'todo' };
    },
    'tasks.assign': async (request) => {
      const assigned = await kernel.assignTask({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        ...request.input,
      });
      return { taskId: assigned.taskId, taskRevision: assigned.taskRevision, agentId: assigned.agentId };
    },
    'tasks.wait': async (request) => kernel.waitForTasks({
      managementRunId: request.managementRunId, taskIds: request.input.taskIds,
    }),
    'tasks.retry': async (request) => {
      const retried = await kernel.retryTask({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        ...request.input,
      });
      return { taskId: retried.taskId, taskRevision: retried.taskRevision, attempt: retried.attempt };
    },
    'tasks.accept_subtask': async (request) => {
      const accepted = await kernel.acceptSubtask({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        acceptance: request.input.acceptance,
      });
      return { taskId: accepted.taskId, taskRevision: accepted.taskRevision, status: accepted.status };
    },
    'tasks.report_blocked': async (request) => {
      const blocked = await kernel.reportBlocked({
        authority: authority(request), idempotencyKey: request.idempotencyKey,
        ...request.input,
      });
      return { taskId: blocked.taskId, status: blocked.status, reportedAt: blocked.reportedAt };
    },
  };
}

export function createPhase1ManagementToolHandlers(input: {
  readonly repositories: ServerNextRepositories;
  readonly kernel: ManagementKernel;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly onDispatchCreated: (dispatchId: string) => Promise<void> | void;
  readonly pollIntervalMs?: number;
  readonly terminalTimeoutMs?: number;
}): ToolHandlers {
  const { repositories, kernel, clock, ids } = input;
  const gateway = createInvocationGateway({ repositories, clock, ids });
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const terminalTimeoutMs = input.terminalTimeoutMs ?? 5 * 60_000;

  return {
    'context.get_root_message': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const message = await repositories.messages.getById(run.rootMessageId);
      if (!message) throw new Error('MANAGEMENT_ROOT_MESSAGE_NOT_FOUND');
      return { message: visibleMessage(message) };
    },
    'context.get_root_task': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const task = run.rootTaskId ? await repositories.tasks.getById(run.rootTaskId) : null;
      return {
        task: task ? { id: task.id, title: task.title, status: task.status, revision: task.updatedAt } : null,
      };
    },
    'context.get_visible_thread': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const messages = await repositories.messages.listByThread({
        channelId: run.channelId,
        threadId: run.rootMessageId,
        limit: 200,
      });
      return { revision: messages.at(-1)?.updatedAt ?? messages.at(-1)?.createdAt ?? 0, messages: messages.map(visibleMessage) };
    },
    'context.get_management_state': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const events = await repositories.management.events.list(run.id);
      return { status: run.status, checkpointRevision: run.checkpointRevision, lastEventSequence: events.at(-1)?.event.sequence ?? 0 };
    },
    'agents.list_capabilities': async (request) => {
      const target = await requireFrozenTarget(repositories, request.managementRunId);
      return { agentId: target.agentId, kind: target.kind, capabilities: ['dispatch'] };
    },
    'agents.get_status': async (request) => {
      const target = await requireFrozenTarget(repositories, request.managementRunId);
      const agent = await repositories.agents.getById(target.agentId);
      const status = agent?.status === 'online' || agent?.status === 'offline' || agent?.status === 'busy'
        ? agent.status
        : 'unknown';
      return { agentId: target.agentId, status };
    },
    'agents.invoke': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const target = requireRunFrozenTarget(run);
      const task = run.rootTaskId ? await repositories.tasks.getById(run.rootTaskId) : null;
      const invoked = await gateway.invoke({
        authority: authority(request),
        frozenTargetAgentId: target.agentId,
        allowedTargetAgentIds: [target.agentId],
        idempotencyKey: request.idempotencyKey,
        intent: {
          schemaVersion: 1,
          teamId: run.teamId,
          channelId: run.channelId,
          targetAgentId: target.agentId,
          targetKind: target.kind,
          objective: request.input.objective,
          ...(task ? {
            taskContext: {
              taskId: task.id,
              rootTaskId: run.rootTaskId,
              taskRevision: task.updatedAt,
              taskAttempt: 1,
              claimLeaseId: `management:${run.id}`,
            },
          } : {}),
          acceptanceCriteria: [],
          dependencyResults: [],
          attachmentIds: [...request.input.attachmentIds],
          ...(request.input.deadlineAt ? { deadlineAt: request.input.deadlineAt } : {}),
        },
      });
      if (invoked.disposition === 'created') {
        const dispatchId = invoked.view.activeDispatchId;
        if (!dispatchId) throw new Error('MANAGEMENT_ACTIVE_DISPATCH_MISSING');
        try {
          await input.onDispatchCreated(dispatchId);
        } catch {
          await gateway.completeAttempt({
            dispatchId,
            status: 'failed',
            error: 'MANAGEMENT_DISPATCH_EMIT_FAILED',
            actorKind: 'system',
          });
          await kernel.recordInvocationTerminal({
            managementRunId: run.id,
            dispatchId,
            status: 'failed',
            errorCode: 'MANAGEMENT_DISPATCH_EMIT_FAILED',
          });
          throw new Error('MANAGEMENT_DISPATCH_EMIT_FAILED');
        }
      }
      const terminal = await waitForInvocationDelivery({
        repositories,
        gateway,
        run,
        invocationId: invoked.view.id,
        timeoutAt: Math.min(request.input.deadlineAt ?? Number.POSITIVE_INFINITY, Date.now() + terminalTimeoutMs),
        pollIntervalMs,
      });
      return { invocationId: terminal.id, status: terminal.status };
    },
    'agents.cancel_invocation': async (request) => {
      const invocation = await repositories.management.invocations.getById(request.input.invocationId);
      if (!invocation || invocation.managementRunId !== request.managementRunId) throw new Error('INVOCATION_NOT_FOUND');
      let view = await gateway.getView(invocation.id);
      if (view.activeDispatchId) {
        await gateway.completeAttempt({
          dispatchId: view.activeDispatchId,
          status: 'cancelled',
          actorKind: 'system',
        });
        await kernel.recordInvocationTerminal({
          managementRunId: request.managementRunId,
          dispatchId: view.activeDispatchId,
          status: 'cancelled',
          errorCode: request.input.reasonCode,
        });
        view = await gateway.getView(invocation.id);
      }
      if (!isTerminalInvocation(view.status)) throw new Error('INVOCATION_ACTIVE_ATTEMPT');
      return { invocationId: view.id, status: view.status };
    },
    'channel.post_management_status': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const existing = await messageForCommand(repositories, run, request.commandId);
      const message = existing ?? await repositories.messages.append({
        id: ids.nextId(),
        teamId: run.teamId,
        channelId: run.channelId,
        threadId: run.rootMessageId,
        senderKind: 'system',
        senderId: 'system',
        body: request.input.statusCode,
        createdAt: clock.now(),
        meta: { kind: 'management-status', managementRunId: run.id, managementCommandId: request.commandId },
      });
      return { messageId: message.id };
    },
    'user.request_input': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const existing = await messageForCommand(repositories, run, request.commandId);
      const message = existing ?? await repositories.messages.append({
        id: ids.nextId(),
        teamId: run.teamId,
        channelId: run.channelId,
        threadId: run.rootMessageId,
        senderKind: 'system',
        senderId: 'system',
        body: request.input.question,
        createdAt: clock.now(),
        meta: { kind: 'management-question', managementRunId: run.id, managementCommandId: request.commandId },
      });
      await kernel.appendEvent({
        authority: authority(request),
        type: 'waiting-for-user',
        actorKind: 'manager',
        actorId: request.workerId,
        idempotencyKey: request.idempotencyKey,
        payload: { reasonCode: 'MANAGER_REQUESTED_INPUT', questionMessageId: message.id },
      });
      return { questionMessageId: message.id };
    },
    'review.submit_root_delivery': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      if (!run.rootTaskId) throw new Error('MANAGEMENT_ROOT_TASK_REQUIRED');
      const task = await repositories.tasks.getById(run.rootTaskId);
      if (!task || task.teamId !== run.teamId || task.channelId !== run.channelId) throw new Error('MANAGEMENT_ROOT_TASK_NOT_FOUND');
      if (!request.input.body.trim()) throw new Error('MANAGEMENT_DELIVERY_BODY_INVALID');
      const invocationIds = [...new Set(request.input.contributingInvocationIds)];
      if (invocationIds.length === 0 || invocationIds.length !== request.input.contributingInvocationIds.length) {
        throw new Error('MANAGEMENT_DELIVERY_INVOCATIONS_INVALID');
      }
      for (const invocationId of invocationIds) {
        const invocation = await repositories.management.invocations.getById(invocationId);
        if (!invocation || invocation.managementRunId !== run.id) throw new Error('MANAGEMENT_DELIVERY_INVOCATION_FORBIDDEN');
        const view = await gateway.getView(invocationId);
        if (view.status !== 'succeeded') throw new Error('MANAGEMENT_DELIVERY_INVOCATION_INCOMPLETE');
      }
      const existing = await messageForCommand(repositories, run, request.commandId);
      const delivery = existing ?? await repositories.messages.append({
        id: ids.nextId(),
        teamId: run.teamId,
        channelId: run.channelId,
        threadId: run.rootMessageId,
        senderKind: 'system',
        senderId: 'system',
        body: request.input.body.trim(),
        createdAt: clock.now(),
        meta: {
          kind: 'management-delivery',
          managementRunId: run.id,
          managementCommandId: request.commandId,
          taskId: task.id,
          contributingInvocationIds: invocationIds,
        },
      });
      if (task.status === 'in_progress') {
        await repositories.tasks.update({ taskId: task.id, changes: { status: 'in_review', updatedAt: clock.now() } });
      } else if (task.status !== 'in_review') {
        throw new Error('MANAGEMENT_ROOT_TASK_STATUS_CONFLICT');
      }
      await kernel.appendEvent({
        authority: authority(request),
        type: 'root-delivery-submitted',
        actorKind: 'manager',
        actorId: request.workerId,
        idempotencyKey: request.idempotencyKey,
        payload: { messageId: delivery.id, contributingInvocationIds: invocationIds },
      });
      return { deliveryMessageId: delivery.id, status: 'in_review' };
    },
  };
}

function authority(request: {
  managementRunId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
}) {
  return {
    managementRunId: request.managementRunId,
    workerId: request.workerId,
    leaseToken: request.leaseToken,
    fencingToken: request.fencingToken,
  };
}

function deterministicTaskId(managementRunId: string, parentTaskId: string, clientKey: string): string {
  return `task-${createHash('sha256').update(`${managementRunId}\u0000${parentTaskId}\u0000${clientKey}`).digest('hex').slice(0, 24)}`;
}

function isConflictDiagnostic(code: string): boolean {
  return code.includes('CONFLICT') || code.includes('STALE') || code.includes('FUTURE')
    || code.includes('ALREADY_') || code.endsWith('_ACTIVE');
}

async function requireRun(repositories: ServerNextRepositories, managementRunId: string): Promise<ManagementRunDto> {
  const run = await repositories.management.runs.getById(managementRunId);
  if (!run) throw new Error('MANAGEMENT_RUN_NOT_FOUND');
  return run;
}

function requireRunFrozenTarget(run: ManagementRunDto): NonNullable<ManagementRunDto['frozenTarget']> {
  if (!run.frozenTarget) throw new Error('MANAGEMENT_FROZEN_TARGET_MISSING');
  return run.frozenTarget;
}

async function requireFrozenTarget(repositories: ServerNextRepositories, managementRunId: string) {
  return requireRunFrozenTarget(await requireRun(repositories, managementRunId));
}

function visibleMessage(message: MessageRecord) {
  return {
    id: message.id,
    senderKind: message.senderKind,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
  };
}

async function waitForInvocationDelivery(input: {
  repositories: ServerNextRepositories;
  gateway: ReturnType<typeof createInvocationGateway>;
  run: ManagementRunDto;
  invocationId: string;
  timeoutAt: number;
  pollIntervalMs: number;
}) {
  while (Date.now() <= input.timeoutAt) {
    const view = await input.gateway.getView(input.invocationId);
    if (isTerminalInvocation(view.status)) {
      if (view.status !== 'succeeded' || await hasAgentDelivery(input.repositories, input.run, view.dispatchAttempts.at(-1)?.dispatchId)) {
        return view;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, input.pollIntervalMs));
  }
  throw new Error('MANAGEMENT_INVOCATION_WAIT_TIMEOUT');
}

async function hasAgentDelivery(repositories: ServerNextRepositories, run: ManagementRunDto, dispatchId: string | undefined): Promise<boolean> {
  if (!dispatchId) return false;
  const messages = await repositories.messages.listByThread({ channelId: run.channelId, threadId: run.rootMessageId, limit: 200 });
  return messages.some((message) => message.senderKind === 'agent' && message.meta?.dispatchId === dispatchId);
}

function isTerminalInvocation(status: AgentInvocationStatus): status is Extract<AgentInvocationStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'> {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timed_out';
}

async function messageForCommand(repositories: ServerNextRepositories, run: ManagementRunDto, commandId: string) {
  const messages = await repositories.messages.listByThread({ channelId: run.channelId, threadId: run.rootMessageId, limit: 200 });
  return messages.find((message) => message.meta?.managementCommandId === commandId) ?? null;
}
