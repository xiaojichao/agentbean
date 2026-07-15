import { createHash } from 'node:crypto';
import type {
  AgentInvocationStatus,
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
import type { ManagementRunRecord } from '../management-repositories.js';
import { createInvocationGateway } from './invocation-gateway.js';
import type { createManagementKernel } from './management-kernel.js';
import type { createTaskCoordinationKernel } from './task-coordination-kernel.js';
import type { createSubtaskAcceptanceService } from './subtask-acceptance-service.js';
import { createSubtaskDeliveryService, deliveryOutput } from './subtask-delivery-service.js';
import { createCollaborationService } from './collaboration-service.js';

type ManagementKernel = ReturnType<typeof createManagementKernel>;
type TaskCoordinationKernel = ReturnType<typeof createTaskCoordinationKernel>;
type SubtaskAcceptanceService = ReturnType<typeof createSubtaskAcceptanceService>;
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
export type AnyToolHandlers = Omit<ToolHandlers, 'agents.invoke'>
  & Omit<Phase2ToolHandlers, 'agents.invoke'>
  & { 'agents.invoke'?: ToolHandler<'agents.invoke'> | Phase2ToolHandler<'agents.invoke'> };

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
  readonly phase2Handlers?: Phase2ToolHandlers;
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
      const selectedHandlers = 'managementPhase' in request ? input.phase2Handlers ?? input.handlers : input.handlers;
      const handler = (selectedHandlers as Partial<Record<string,
        (value: ManagementToolRequest) => Promise<unknown>>>)[request.toolName];
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
        errorCode: unauthorized ? 'NOT_AUTHORIZED'
          : diagnosticCode.endsWith('_UNAVAILABLE') ? 'UNAVAILABLE'
          : isConflictDiagnostic(diagnosticCode) ? 'CONFLICT' : 'INVALID_REQUEST',
        diagnosticCode,
        retryable: false,
      } as ManagementToolResult;
    }
  };
}

export function createPhase2CollaborationToolHandlers(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly onDispatchCreated: (dispatchId: string) => Promise<void> | void;
  readonly pollIntervalMs?: number;
}): Pick<Phase2ToolHandlers, 'agents.list_available' | 'handoffs.request' | 'handoffs.await_result'> {
  const service = createCollaborationService(input);
  const gateway = createInvocationGateway(input);
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const emittedDispatchIds = new Set<string>();
  return {
    'agents.list_available': async (request) => ({ agents: await service.listAvailableAgents({
      managementRunId: request.managementRunId,
      ...request.input,
    }) }),
    'handoffs.request': async (request) => {
      const requested = await service.requestHandoff({ authority: authority(request),
        idempotencyKey: request.idempotencyKey, ...request.input });
      const activeDispatchId = requested.view.activeDispatchId;
      const activeDispatch = activeDispatchId
        ? await input.repositories.dispatches.getById(activeDispatchId)
        : null;
      if (activeDispatchId && requested.handoff.status === 'requested'
        && activeDispatch?.status === 'queued' && !emittedDispatchIds.has(activeDispatchId)) {
        try {
          await input.onDispatchCreated(activeDispatchId);
          emittedDispatchIds.add(activeDispatchId);
        } catch {
          await gateway.completeAttempt({ dispatchId: activeDispatchId,
            status: 'failed', error: 'MANAGEMENT_DISPATCH_EMIT_FAILED', actorKind: 'system' });
          await service.recordTerminal({ dispatchId: activeDispatchId,
            status: 'failed', artifactIds: [] });
          throw new Error('MANAGEMENT_DISPATCH_EMIT_FAILED');
        }
      }
      return { handoffId: requested.handoff.id, invocationId: requested.invocation.id,
        status: requested.handoff.status };
    },
    'handoffs.await_result': async (request) => {
      for (;;) {
        const handoff = await service.getHandoff(request.input.handoffId);
        if (!handoff || handoff.managementRunId !== request.managementRunId || !handoff.invocationId) {
          throw new Error('HANDOFF_NOT_FOUND');
        }
        if (['returned', 'rejected', 'failed', 'cancelled', 'timed_out'].includes(handoff.status)
          || (request.input.timeoutAt !== undefined && input.clock.now() >= request.input.timeoutAt)) {
          return { handoffId: handoff.id, invocationId: handoff.invocationId, status: handoff.status };
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    },
  };
}

export function createPhase2ManagementToolHandlers(input: {
  readonly kernel: TaskCoordinationKernel;
  readonly acceptanceService: SubtaskAcceptanceService;
  readonly onTaskPublished?: (taskId: string) => Promise<void> | void;
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
      await input.onTaskPublished?.(published.taskId);
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
      const accepted = await input.acceptanceService.decide({
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

export function createPhase2InvocationToolHandlers(input: {
  readonly repositories: ServerNextRepositories;
  readonly kernel: ManagementKernel;
  readonly taskCoordinationKernel?: TaskCoordinationKernel;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly onDispatchCreated: (dispatchId: string) => Promise<void> | void;
  readonly pollIntervalMs?: number;
  readonly terminalTimeoutMs?: number;
}): Pick<Phase2ToolHandlers, 'agents.invoke'> {
  const { repositories, kernel, clock, ids } = input;
  const gateway = createInvocationGateway({ repositories, clock, ids });
  const deliveryService = createSubtaskDeliveryService({
    unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids,
  });
  const pollIntervalMs = input.pollIntervalMs ?? 50;
  const terminalTimeoutMs = input.terminalTimeoutMs ?? 5 * 60_000;
  return {
    'agents.invoke': async (request) => {
      const run = await requireRun(repositories, request.managementRunId);
      const invoked = await gateway.invokeTask({
        authority: authority(request),
        idempotencyKey: request.idempotencyKey,
        ...request.input,
      });
      if (invoked.disposition === 'created') {
        const dispatchId = invoked.view.activeDispatchId;
        if (!dispatchId) throw new Error('MANAGEMENT_ACTIVE_DISPATCH_MISSING');
        try {
          await input.onDispatchCreated(dispatchId);
        } catch {
          await gateway.completeAttempt({ dispatchId, status: 'failed',
            error: 'MANAGEMENT_DISPATCH_EMIT_FAILED', actorKind: 'system' });
          if (input.taskCoordinationKernel) {
            await input.taskCoordinationKernel.recordInvocationFailure({
              managementRunId: run.id, invocationId: invoked.view.id,
              reasonCode: 'MANAGEMENT_DISPATCH_EMIT_FAILED',
            });
          } else {
            await kernel.recordInvocationTerminal({ managementRunId: run.id, dispatchId,
              status: 'failed', errorCode: 'MANAGEMENT_DISPATCH_EMIT_FAILED' });
          }
          throw new Error('MANAGEMENT_DISPATCH_EMIT_FAILED');
        }
      }
      const terminal = await waitForInvocationDelivery({
        repositories, gateway, run, invocationId: invoked.view.id,
        timeoutAt: Math.min(request.input.deadlineAt ?? Number.POSITIVE_INFINITY,
          Date.now() + terminalTimeoutMs),
        pollIntervalMs,
      });
      if (terminal.status !== 'succeeded') return { invocationId: terminal.id, status: terminal.status };
      const dispatchId = terminal.dispatchAttempts.at(-1)?.dispatchId;
      const message = await findAgentDelivery(repositories, run, dispatchId);
      if (!message || !dispatchId) throw new Error('MANAGEMENT_AGENT_DELIVERY_MISSING');
      const artifacts = (await repositories.artifacts.listByMessage(message.id))
        .filter((artifact) => artifact.dispatchId === dispatchId)
        .sort((left, right) => left.id.localeCompare(right.id));
      const workspaceRuns = (await repositories.workspaceRuns.listByDispatch(dispatchId))
        .sort((left, right) => left.id.localeCompare(right.id));
      const delivered = await deliveryService.submit({ authority: authority(request),
        idempotencyKey: `${request.idempotencyKey}:delivery`, taskId: request.input.taskId,
        expectedTaskRevision: request.input.expectedTaskRevision,
        taskAttempt: request.input.taskAttempt, claimLeaseId: request.input.claimLeaseId,
        invocationId: terminal.id, summary: message.body,
        locators: [{ kind: 'message', id: message.id },
          ...artifacts.map((artifact) => ({ kind: 'artifact' as const, id: artifact.id })),
          ...workspaceRuns.map((workspaceRun) => ({ kind: 'workspace-run' as const, id: workspaceRun.id })),
          { kind: 'invocation', id: terminal.id }, { kind: 'task', id: request.input.taskId }],
      });
      return { invocationId: terminal.id, status: terminal.status,
        ...deliveryOutput(delivered.delivery) };
    },
  };
}

export function createPhase1ManagementToolHandlers(input: {
  readonly repositories: ServerNextRepositories;
  readonly kernel: ManagementKernel;
  readonly taskCoordinationKernel?: TaskCoordinationKernel;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly onDispatchCreated: (dispatchId: string) => Promise<void> | void;
  readonly pollIntervalMs?: number;
  readonly terminalTimeoutMs?: number;
}): ToolHandlers {
  const { repositories, kernel, clock, ids } = input;
  const gateway = createInvocationGateway({ repositories, clock, ids });
  const collaborationService = createCollaborationService({ repositories, clock, ids });
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
      if (run.schemaVersion !== 2) {
        return { status: run.status, checkpointRevision: run.checkpointRevision,
          lastEventSequence: events.at(-1)?.event.sequence ?? 0 };
      }
      const [proposals, handoffs] = await Promise.all([
        repositories.management.collaborationProposals.listByRun(run.id),
        repositories.management.handoffs.listByRun(run.id),
      ]);
      return { status: run.status, checkpointRevision: run.checkpointRevision,
        lastEventSequence: events.at(-1)?.event.sequence ?? 0,
        ...(run.mainAgentId ? { mainAgentId: run.mainAgentId } : {}),
        ...(run.activeAgentId ? { activeAgentId: run.activeAgentId } : {}),
        ...(run.collaborationMode ? { collaborationMode: run.collaborationMode } : {}),
        collaborationProposals: proposals.map(({ id: proposalId, proposal }) => ({
          proposalId, sourceInvocationId: proposal.sourceInvocationId,
          sourceAgentId: proposal.sourceAgentId, toAgentId: proposal.toAgentId,
          kind: proposal.kind, objective: proposal.objective, reason: proposal.reason,
          contextRefIds: proposal.contextRefs.map((ref) => ref.id),
          dependencyInvocationIds: proposal.dependencyResults.map((ref) => ref.invocationId),
          attachmentIds: [...proposal.attachmentIds],
          acceptanceCriteria: [...proposal.acceptanceCriteria], returnMode: proposal.returnMode,
          ...(proposal.deadlineAt !== undefined ? { deadlineAt: proposal.deadlineAt } : {}),
        })),
        handoffs: handoffs.map((handoff) => ({ handoffId: handoff.id,
          ...(handoff.invocationId ? { invocationId: handoff.invocationId } : {}),
          ...(handoff.intent.fromAgentId ? { fromAgentId: handoff.intent.fromAgentId } : {}),
          toAgentId: handoff.intent.toAgentId, kind: handoff.intent.kind, status: handoff.status })),
      };
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
        const handoff = await repositories.management.handoffs.getByInvocationId(invocation.id);
        await gateway.completeAttempt({
          dispatchId: view.activeDispatchId,
          status: 'cancelled',
          actorKind: 'system',
        });
        if (handoff) {
          await collaborationService.recordTerminal({ dispatchId: view.activeDispatchId,
            status: 'cancelled', artifactIds: [] });
        } else {
          await kernel.recordInvocationTerminal({
            managementRunId: request.managementRunId,
            dispatchId: view.activeDispatchId,
            status: 'cancelled',
            errorCode: request.input.reasonCode,
          });
        }
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
      const rootCoordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      const coordinatedRoot = rootCoordination?.nodeKind === 'root'
        && rootCoordination.managementRunId === run.id;
      if (coordinatedRoot) {
        if (!input.taskCoordinationKernel) {
          throw new Error('MANAGEMENT_TASK_COORDINATION_KERNEL_UNAVAILABLE');
        }
        const readiness = await input.taskCoordinationKernel.getRootDeliveryReadiness({
          managementRunId: run.id,
        });
        if (!sameIds(readiness.contributingInvocationIds, invocationIds)) {
          throw new Error('MANAGEMENT_ROOT_DELIVERY_CONTRIBUTIONS_INCOMPLETE');
        }
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
      if (coordinatedRoot) {
        const submitted = await input.taskCoordinationKernel!.submitRootDelivery({
          authority: authority(request), idempotencyKey: request.idempotencyKey,
          messageId: delivery.id, contributingInvocationIds: invocationIds,
        });
        return { deliveryMessageId: submitted.deliveryMessageId, status: submitted.status };
      }
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

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
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

async function requireRun(repositories: ServerNextRepositories, managementRunId: string): Promise<ManagementRunRecord> {
  const run = await repositories.management.runs.getById(managementRunId);
  if (!run) throw new Error('MANAGEMENT_RUN_NOT_FOUND');
  return run;
}

function requireRunFrozenTarget(run: ManagementRunRecord): NonNullable<ManagementRunRecord['frozenTarget']> {
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
  run: ManagementRunRecord;
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

async function hasAgentDelivery(repositories: ServerNextRepositories, run: ManagementRunRecord, dispatchId: string | undefined): Promise<boolean> {
  return (await findAgentDelivery(repositories, run, dispatchId)) !== null;
}

async function findAgentDelivery(repositories: ServerNextRepositories, run: ManagementRunRecord,
  dispatchId: string | undefined): Promise<MessageRecord | null> {
  if (!dispatchId) return null;
  const messages = await repositories.messages.listByThread({ channelId: run.channelId, threadId: run.rootMessageId, limit: 200 });
  return messages.find((message) => message.senderKind === 'agent'
    && message.meta?.dispatchId === dispatchId) ?? null;
}

function isTerminalInvocation(status: AgentInvocationStatus): status is Extract<AgentInvocationStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'> {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'timed_out';
}

async function messageForCommand(repositories: ServerNextRepositories, run: ManagementRunRecord, commandId: string) {
  const messages = await repositories.messages.listByThread({ channelId: run.channelId, threadId: run.rootMessageId, limit: 200 });
  return messages.find((message) => message.meta?.managementCommandId === commandId) ?? null;
}
