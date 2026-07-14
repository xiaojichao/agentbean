import { createHash } from 'node:crypto';
import type {
  AgentInvocationIntentV1,
  AgentInvocationRecordDto,
  AgentInvocationStatus,
  AgentInvocationViewDto,
  AcceptanceCriterionDto,
  DependencyResultRefDto,
  DispatchStatus,
  ManagementRunDto,
} from '../../../../../packages/contracts/src/index.js';
import {
  canonicalizeAgentInvocationIntent,
  resolveInvocationIdempotency,
} from '../../../../../packages/domain/src/index.js';
import type { InvocationDispatchAttemptRecord, ManagementRepositories } from '../management-repositories.js';
import type {
  DispatchMutationResult,
  DispatchRepository,
  ManagementDispatchRepositories,
  ServerNextRepositories,
} from '../repositories.js';
import {
  appendManagementEventInTransaction,
  authorizeManagementWrite,
  ManagementConflictError,
  type LeaseAuthorityInput,
} from './management-kernel.js';

type TerminalDispatchStatus = Extract<DispatchStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;

export class InvocationGatewayError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface InvocationGatewayDependencies {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}

export interface InvokeAgentInput {
  readonly authority: LeaseAuthorityInput;
  readonly frozenTargetAgentId: string;
  readonly allowedTargetAgentIds: readonly string[];
  readonly idempotencyKey: string;
  readonly intent: AgentInvocationIntentV1;
}

export interface InvokeTaskAgentInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly objective: string;
  readonly attachmentIds: readonly string[];
  readonly deadlineAt?: number;
}

export function createInvocationGateway(dependencies: InvocationGatewayDependencies) {
  const { repositories, clock, ids } = dependencies;

  return {
    async invokeTask(input: InvokeTaskAgentInput): Promise<{ disposition: 'created' | 'existing'; view: AgentInvocationViewDto }> {
      return repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        await authorizeManagementWrite(transactionRepositories.management, input.authority, now);
        const run = await requireRun(transactionRepositories.management, input.authority.managementRunId);
        if (!input.idempotencyKey) throw new InvocationGatewayError('INVOCATION_IDEMPOTENCY_KEY_INVALID');
        if (!input.objective.trim()) throw new InvocationGatewayError('INVOCATION_OBJECTIVE_INVALID');
        if (input.deadlineAt !== undefined && input.deadlineAt <= now) {
          throw new InvocationGatewayError('INVOCATION_DEADLINE_EXPIRED');
        }
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
        }

        const existing = await transactionRepositories.management.invocations.getByIdempotencyKey({
          managementRunId: run.id,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          assertTaskInvocationReplay(existing, input);
          return { disposition: 'existing' as const,
            view: await deriveInvocationView(transactionRepositories.management,
              transactionRepositories.dispatches, existing) };
        }

        const authority = await resolveTaskInvocationAuthority(transactionRepositories, run, input, now);
        const agent = await repositories.agents.getById(authority.targetAgentId);
        if (!agent || agent.deletedAt !== undefined || !agent.visibleTeamIds.includes(run.teamId)) {
          throw new InvocationGatewayError('INVOCATION_TARGET_FORBIDDEN');
        }
        const targetKind = agent.category === 'agentos-hosted' ? 'agentos-hosted' as const : 'custom' as const;
        const intent: AgentInvocationIntentV1 = {
          schemaVersion: 1,
          teamId: run.teamId,
          channelId: run.channelId,
          targetAgentId: authority.targetAgentId,
          targetKind,
          objective: input.objective.trim(),
          taskContext: {
            taskId: input.taskId,
            ...(authority.rootTaskId && { rootTaskId: authority.rootTaskId }),
            taskRevision: input.expectedTaskRevision,
            taskAttempt: input.taskAttempt,
            claimLeaseId: input.claimLeaseId,
          },
          acceptanceCriteria: authority.acceptanceCriteria,
          dependencyResults: authority.dependencyResults,
          attachmentIds: [...input.attachmentIds],
          ...(input.deadlineAt !== undefined && { deadlineAt: input.deadlineAt }),
        };
        const intentHash = hashIntent(intent);

        await assertNoActiveTaskAttempt(transactionRepositories, run.id, input.taskId,
          input.expectedTaskRevision, input.taskAttempt);
        await validateAuthoritativeTarget(repositories, intent, run);
        const invocation: AgentInvocationRecordDto = {
          schemaVersion: 1, id: ids.nextId(), managementRunId: run.id, intent, intentHash,
          idempotencyKey: input.idempotencyKey, createdAt: now,
        };
        const attempt = await createAttempt(transactionRepositories.management,
          transactionRepositories.dispatches, invocation, 1, now, ids);
        await appendManagementEventInTransaction(transactionRepositories.management, {
          managementRunId: run.id,
          type: 'invocation-created',
          actorKind: 'manager',
          actorId: input.authority.workerId,
          idempotencyKey: `invocation-created:${invocation.id}`,
          payload: { invocationId: invocation.id, intentHash, taskRevision: input.expectedTaskRevision },
        }, now, ids);
        await appendAttemptStartedEvent(transactionRepositories.management, invocation, attempt,
          input.authority.workerId, now, ids);
        return { disposition: 'created' as const,
          view: await deriveInvocationView(transactionRepositories.management,
            transactionRepositories.dispatches, invocation) };
      });
    },

    async invoke(input: InvokeAgentInput): Promise<{ disposition: 'created' | 'existing'; view: AgentInvocationViewDto }> {
      const intentHash = hashIntent(input.intent);
      return repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        await authorizeManagementWrite(transactionRepositories.management, input.authority, now);
        const run = await requireRun(transactionRepositories.management, input.authority.managementRunId);
        validateFrozenIntent(input, run);
        if (!input.idempotencyKey) throw new InvocationGatewayError('INVOCATION_IDEMPOTENCY_KEY_INVALID');

        const existing = await transactionRepositories.management.invocations.getByIdempotencyKey({
          managementRunId: run.id,
          idempotencyKey: input.idempotencyKey,
        });
        const idempotency = resolveInvocationIdempotency({
          existing: existing ? {
            invocationId: existing.id,
            managementRunId: existing.managementRunId,
            idempotencyKey: existing.idempotencyKey,
            intentHash: existing.intentHash,
          } : undefined,
          requestedManagementRunId: run.id,
          requestedIdempotencyKey: input.idempotencyKey,
          requestedIntentHash: intentHash,
        });
        if (idempotency.kind === 'conflict') throw new InvocationGatewayError('INVOCATION_IDEMPOTENCY_CONFLICT');
        if (idempotency.kind === 'existing') {
          return {
            disposition: 'existing' as const,
            view: await deriveInvocationView(transactionRepositories.management, transactionRepositories.dispatches, existing!),
          };
        }

        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
        }

        await validateAuthoritativeTarget(repositories, input.intent, run);
        const invocation: AgentInvocationRecordDto = {
          schemaVersion: 1,
          id: ids.nextId(),
          managementRunId: run.id,
          intent: input.intent,
          intentHash,
          idempotencyKey: input.idempotencyKey,
          createdAt: now,
        };
        const attempt = await createAttempt(transactionRepositories.management, transactionRepositories.dispatches, invocation, 1, now, ids);
        await appendManagementEventInTransaction(transactionRepositories.management, {
          managementRunId: run.id,
          type: 'invocation-created',
          actorKind: 'manager',
          actorId: input.authority.workerId,
          idempotencyKey: `invocation-created:${invocation.id}`,
          payload: {
            invocationId: invocation.id,
            intentHash,
            ...(input.intent.taskContext && { taskRevision: input.intent.taskContext.taskRevision }),
          },
        }, now, ids);
        await appendAttemptStartedEvent(transactionRepositories.management, invocation, attempt, input.authority.workerId, now, ids);
        return {
          disposition: 'created' as const,
          view: await deriveInvocationView(transactionRepositories.management, transactionRepositories.dispatches, invocation),
        };
      });
    },

    async retry(input: { authority: LeaseAuthorityInput; invocationId: string }): Promise<AgentInvocationViewDto> {
      return repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        await authorizeManagementWrite(transactionRepositories.management, input.authority, now);
        const run = await requireWritableRun(transactionRepositories.management, input.authority.managementRunId);
        const invocation = await transactionRepositories.management.invocations.getById(input.invocationId);
        if (!invocation || invocation.managementRunId !== run.id) throw new InvocationGatewayError('INVOCATION_NOT_FOUND');
        const attempts = await transactionRepositories.management.dispatchAttempts.list(invocation.id);
        const latest = attempts.at(-1);
        if (!latest) throw new InvocationGatewayError('INVOCATION_ATTEMPT_NOT_FOUND');
        const latestDispatch = await transactionRepositories.dispatches.getById(latest.dispatchId);
        if (!latestDispatch) throw new InvocationGatewayError('INVOCATION_DISPATCH_NOT_FOUND');
        if (isActive(latestDispatch.status)) throw new InvocationGatewayError('INVOCATION_ACTIVE_ATTEMPT');

        await validateAuthoritativeTarget(repositories, invocation.intent, run);
        const attempt = await createAttempt(transactionRepositories.management, transactionRepositories.dispatches, invocation, latest.attemptNumber + 1, now, ids);
        await appendAttemptStartedEvent(transactionRepositories.management, invocation, attempt, input.authority.workerId, now, ids);
        return deriveInvocationView(transactionRepositories.management, transactionRepositories.dispatches, invocation);
      });
    },

    async completeAttempt(input: {
      dispatchId: string;
      status: TerminalDispatchStatus;
      error?: string;
      actorKind?: 'system' | 'agent' | 'human';
      actorId?: string;
    }): Promise<DispatchMutationResult> {
      return repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
        const attempt = await transactionRepositories.management.dispatchAttempts.getByDispatchId(input.dispatchId);
        if (!attempt) throw new InvocationGatewayError('INVOCATION_ATTEMPT_NOT_FOUND');
        const invocation = await transactionRepositories.management.invocations.getById(attempt.invocationId);
        if (!invocation) throw new InvocationGatewayError('INVOCATION_NOT_FOUND');
        const dispatch = await transactionRepositories.dispatches.getById(input.dispatchId);
        if (!dispatch) throw new InvocationGatewayError('INVOCATION_DISPATCH_NOT_FOUND');
        const now = clock.now();

        if (!isActive(dispatch.status) && dispatch.status !== 'timed_out') {
          if (dispatch.status !== input.status) throw new InvocationGatewayError('INVOCATION_ATTEMPT_TERMINAL_CONFLICT');
          await persistTerminalAttempt(transactionRepositories.management, invocation, attempt, input, now, ids);
          return { dispatch, changed: false };
        }
        const mutation = await mutateDispatchTerminal(transactionRepositories.dispatches, input, now);
        if (!mutation) throw new InvocationGatewayError('INVOCATION_DISPATCH_NOT_FOUND');
        if (!mutation.changed && mutation.dispatch.status !== input.status) {
          throw new InvocationGatewayError('INVOCATION_ATTEMPT_TERMINAL_CONFLICT');
        }
        await persistTerminalAttempt(transactionRepositories.management, invocation, attempt, input, now, ids);
        return mutation;
      });
    },

    async getView(invocationId: string): Promise<AgentInvocationViewDto> {
      const invocation = await repositories.management.invocations.getById(invocationId);
      if (!invocation) throw new InvocationGatewayError('INVOCATION_NOT_FOUND');
      return deriveInvocationView(repositories.management, repositories.dispatches, invocation);
    },
  };
}

async function resolveTaskInvocationAuthority(
  repositories: ManagementDispatchRepositories,
  run: ManagementRunDto,
  input: InvokeTaskAgentInput,
  now: number,
): Promise<{
  targetAgentId: string;
  rootTaskId?: string;
  acceptanceCriteria: AcceptanceCriterionDto[];
  dependencyResults: DependencyResultRefDto[];
}> {
  const task = await repositories.tasks.getById(input.taskId);
  const coordination = await repositories.coordination.coordinations.getByTaskId(input.taskId);
  if (!task || !coordination || task.teamId !== run.teamId || task.channelId !== run.channelId
    || coordination.teamId !== run.teamId || coordination.managementRunId !== run.id) {
    throw new InvocationGatewayError('INVOCATION_TASK_FORBIDDEN');
  }
  if (task.revision !== input.expectedTaskRevision
    || coordination.taskRevision !== input.expectedTaskRevision) {
    throw new InvocationGatewayError('INVOCATION_TASK_REVISION_STALE');
  }
  if (coordination.attempt !== input.taskAttempt) {
    throw new InvocationGatewayError('INVOCATION_TASK_ATTEMPT_STALE');
  }
  if (task.status !== 'in_progress') throw new InvocationGatewayError('INVOCATION_TASK_NOT_ACTIVE');
  const claim = await repositories.coordination.claimLeases.getById(input.claimLeaseId);
  const currentClaim = await repositories.coordination.claimLeases.getCurrent({
    taskId: input.taskId, taskRevision: input.expectedTaskRevision, taskAttempt: input.taskAttempt,
  });
  if (!claim || !currentClaim || currentClaim.id !== claim.id || claim.id !== input.claimLeaseId
    || claim.status !== 'active' || claim.expiresAt <= now || claim.teamId !== run.teamId
    || claim.taskId !== input.taskId || claim.taskRevision !== input.expectedTaskRevision
    || claim.taskAttempt !== input.taskAttempt || task.assigneeId !== claim.agentId) {
    throw new InvocationGatewayError('INVOCATION_CLAIM_STALE');
  }
  const rootTaskId = coordination.rootTaskId ?? (coordination.nodeKind === 'root' ? task.id : undefined);
  if (run.rootTaskId && rootTaskId !== run.rootTaskId) {
    throw new InvocationGatewayError('INVOCATION_ROOT_TASK_MISMATCH');
  }
  const criteria = (await repositories.coordination.criteria.list(task.id))
    .filter((criterion) => criterion.introducedRevision <= task.revision
      && (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision))
    .map(({ taskId: _taskId, introducedRevision: _introducedRevision,
      retiredRevision: _retiredRevision, position: _position, ...criterion }) => criterion);
  const dependencyResults: DependencyResultRefDto[] = [];
  for (const dependency of await repositories.coordination.dependencies.list(task.id)) {
    const dependencyTask = await repositories.tasks.getById(dependency.dependencyTaskId);
    const dependencyCoordination = await repositories.coordination.coordinations
      .getByTaskId(dependency.dependencyTaskId);
    if (!dependencyTask || !dependencyCoordination || dependencyTask.status !== 'done') {
      throw new InvocationGatewayError('INVOCATION_DEPENDENCIES_NOT_READY');
    }
    const deliveries = (await repositories.coordination.deliveries.listByTask(dependencyTask.id))
      .filter((delivery) => delivery.taskRevision === dependencyTask.revision
        && delivery.taskAttempt === dependencyCoordination.attempt)
      .reverse();
    let accepted: { delivery: (typeof deliveries)[number]; resultRevision: number } | undefined;
    for (const delivery of deliveries) {
      const acceptance = await repositories.coordination.acceptances.getCanonicalByDelivery(delivery.id);
      if (acceptance?.decision === 'accepted') {
        accepted = { delivery, resultRevision: acceptance.decisionVersion };
        break;
      }
    }
    if (!accepted) throw new InvocationGatewayError('INVOCATION_DEPENDENCIES_NOT_READY');
    const evidence = [...accepted.delivery.evidenceRefs,
      ...accepted.delivery.claims.flatMap((claimItem) => claimItem.evidenceRefs)];
    dependencyResults.push({
      invocationId: accepted.delivery.invocationId,
      resultRevision: accepted.resultRevision,
      artifactIds: [...new Set(evidence.filter((ref) => ref.kind === 'artifact').map((ref) => ref.id))],
      ...(evidence.find((ref) => ref.kind === 'workspace-run')?.id
        ? { workspaceRunId: evidence.find((ref) => ref.kind === 'workspace-run')!.id }
        : {}),
    });
  }
  return {
    targetAgentId: claim.agentId,
    ...(rootTaskId && { rootTaskId }),
    acceptanceCriteria: criteria,
    dependencyResults,
  };
}

function assertTaskInvocationReplay(existing: AgentInvocationRecordDto,
  input: InvokeTaskAgentInput): void {
  const context = existing.intent.taskContext;
  const sameAttachments = existing.intent.attachmentIds.length === input.attachmentIds.length
    && existing.intent.attachmentIds.every((id, index) => id === input.attachmentIds[index]);
  if (!context || context.taskId !== input.taskId
    || context.taskRevision !== input.expectedTaskRevision
    || context.taskAttempt !== input.taskAttempt
    || context.claimLeaseId !== input.claimLeaseId
    || existing.intent.objective !== input.objective.trim()
    || existing.intent.deadlineAt !== input.deadlineAt
    || !sameAttachments) {
    throw new InvocationGatewayError('INVOCATION_IDEMPOTENCY_CONFLICT');
  }
}

async function assertNoActiveTaskAttempt(
  repositories: ManagementDispatchRepositories,
  managementRunId: string,
  taskId: string,
  taskRevision: number,
  taskAttempt: number,
): Promise<void> {
  const invocations = await repositories.management.invocations.listByRun(managementRunId);
  for (const invocation of invocations) {
    const context = invocation.intent.taskContext;
    if (context?.taskId !== taskId || context.taskRevision !== taskRevision
      || context.taskAttempt !== taskAttempt) continue;
    const view = await deriveInvocationView(repositories.management, repositories.dispatches, invocation);
    if (view.activeDispatchId) throw new InvocationGatewayError('INVOCATION_TASK_ATTEMPT_ACTIVE');
  }
}

async function validateAuthoritativeTarget(repositories: ServerNextRepositories, intent: AgentInvocationIntentV1, run: ManagementRunDto): Promise<void> {
  const team = await repositories.teams.getById(intent.teamId);
  if (!team) throw new InvocationGatewayError('INVOCATION_TEAM_NOT_FOUND');
  const channel = await repositories.channels.getById(intent.channelId);
  if (!channel || channel.teamId !== intent.teamId || channel.archivedAt) throw new InvocationGatewayError('INVOCATION_CHANNEL_FORBIDDEN');
  if (channel.dmTargetAgentId !== intent.targetAgentId && !channel.agentMemberIds.includes(intent.targetAgentId)) {
    throw new InvocationGatewayError('INVOCATION_TARGET_FORBIDDEN');
  }
  const agent = await repositories.agents.getById(intent.targetAgentId);
  if (!agent || agent.deletedAt !== undefined || !agent.visibleTeamIds.includes(intent.teamId)) throw new InvocationGatewayError('INVOCATION_TARGET_FORBIDDEN');
  const actualKind = agent.category === 'agentos-hosted' ? 'agentos-hosted' : 'custom';
  if (actualKind !== intent.targetKind) throw new InvocationGatewayError('INVOCATION_TARGET_KIND_MISMATCH');
  for (const artifactId of intent.attachmentIds) {
    const artifact = await repositories.artifacts.getForTeam({ teamId: intent.teamId, artifactId });
    if (!artifact || artifact.channelId !== intent.channelId) throw new InvocationGatewayError('INVOCATION_ATTACHMENT_FORBIDDEN');
  }
  if (intent.taskContext) {
    const task = await repositories.tasks.getById(intent.taskContext.taskId);
    if (!task || task.teamId !== intent.teamId || task.channelId !== intent.channelId) throw new InvocationGatewayError('INVOCATION_TASK_FORBIDDEN');
    if (run.rootTaskId && intent.taskContext.rootTaskId !== run.rootTaskId) throw new InvocationGatewayError('INVOCATION_ROOT_TASK_MISMATCH');
  }
}

function validateFrozenIntent(input: InvokeAgentInput, run: ManagementRunDto): void {
  if (input.intent.targetAgentId !== input.frozenTargetAgentId) throw new InvocationGatewayError('INVOCATION_FROZEN_TARGET_MISMATCH');
  if (!input.allowedTargetAgentIds.includes(input.intent.targetAgentId)) throw new InvocationGatewayError('INVOCATION_TARGET_FORBIDDEN');
  if (input.intent.teamId !== run.teamId) throw new InvocationGatewayError('INVOCATION_TEAM_MISMATCH');
  if (input.intent.channelId !== run.channelId) throw new InvocationGatewayError('INVOCATION_CHANNEL_MISMATCH');
  if (!input.intent.objective.trim()) throw new InvocationGatewayError('INVOCATION_OBJECTIVE_INVALID');
}

async function createAttempt(
  management: ManagementRepositories,
  dispatches: DispatchRepository,
  invocation: AgentInvocationRecordDto,
  attemptNumber: number,
  now: number,
  ids: { nextId(): string },
): Promise<InvocationDispatchAttemptRecord> {
  if (attemptNumber === 1) await management.invocations.create(invocation);
  const dispatchId = ids.nextId();
  await dispatches.create({
    id: dispatchId,
    teamId: invocation.intent.teamId,
    channelId: invocation.intent.channelId,
    messageId: (await requireRun(management, invocation.managementRunId)).rootMessageId,
    agentId: invocation.intent.targetAgentId,
    status: 'queued',
    requestId: `management:${invocation.id}:${attemptNumber}`,
    prompt: invocation.intent.objective,
    createdAt: now,
    updatedAt: now,
  });
  return management.dispatchAttempts.create({
    id: ids.nextId(), invocationId: invocation.id, dispatchId, attemptNumber, status: 'queued', startedAt: now,
  });
}

async function appendAttemptStartedEvent(
  management: ManagementRepositories,
  invocation: AgentInvocationRecordDto,
  attempt: InvocationDispatchAttemptRecord,
  workerId: string,
  now: number,
  ids: { nextId(): string },
): Promise<void> {
  await appendManagementEventInTransaction(management, {
    managementRunId: invocation.managementRunId,
    type: 'dispatch-attempt-started',
    actorKind: 'manager',
    actorId: workerId,
    idempotencyKey: `dispatch-attempt-started:${attempt.dispatchId}`,
    payload: { invocationId: invocation.id, dispatchId: attempt.dispatchId, attemptNumber: attempt.attemptNumber },
  }, now, ids);
}

async function persistTerminalAttempt(
  management: ManagementRepositories,
  invocation: AgentInvocationRecordDto,
  attempt: InvocationDispatchAttemptRecord,
  input: { dispatchId: string; status: TerminalDispatchStatus; actorKind?: 'system' | 'agent' | 'human'; actorId?: string },
  now: number,
  ids: { nextId(): string },
): Promise<void> {
  await management.dispatchAttempts.update({ ...attempt, status: input.status, completedAt: attempt.completedAt ?? now });
  await appendManagementEventInTransaction(management, {
    managementRunId: invocation.managementRunId,
    type: 'dispatch-attempt-completed',
    actorKind: input.actorKind ?? 'system',
    ...(input.actorId && { actorId: input.actorId }),
    idempotencyKey: `dispatch-attempt-completed:${input.dispatchId}:${input.status}`,
    payload: { invocationId: invocation.id, dispatchId: input.dispatchId, attemptNumber: attempt.attemptNumber, status: input.status },
  }, now, ids);
}

async function mutateDispatchTerminal(
  dispatches: DispatchRepository,
  input: { dispatchId: string; status: TerminalDispatchStatus; error?: string },
  now: number,
): Promise<DispatchMutationResult | null> {
  switch (input.status) {
    case 'succeeded': return dispatches.markSucceeded({ dispatchId: input.dispatchId, completedAt: now });
    case 'failed': return dispatches.markFailed({ dispatchId: input.dispatchId, error: input.error ?? 'DISPATCH_FAILED', completedAt: now });
    case 'cancelled': return dispatches.markCancelled({ dispatchId: input.dispatchId, completedAt: now });
    case 'timed_out': return dispatches.markTimedOut({ dispatchId: input.dispatchId, error: input.error ?? 'DISPATCH_TIMEOUT', completedAt: now });
  }
}

async function deriveInvocationView(
  management: ManagementRepositories,
  dispatches: DispatchRepository,
  invocation: AgentInvocationRecordDto,
): Promise<AgentInvocationViewDto> {
  const attempts = await management.dispatchAttempts.list(invocation.id);
  const canonicalAttempts = await Promise.all(attempts.map(async (attempt) => {
    const dispatch = await dispatches.getById(attempt.dispatchId);
    if (!dispatch) throw new InvocationGatewayError('INVOCATION_DISPATCH_NOT_FOUND');
    return { dispatchId: dispatch.id, attemptNumber: attempt.attemptNumber, status: dispatch.status };
  }));
  const latest = canonicalAttempts.at(-1);
  return {
    ...invocation,
    status: deriveStatus(latest?.status),
    dispatchAttempts: canonicalAttempts,
    ...(latest && isActive(latest.status) && { activeDispatchId: latest.dispatchId }),
  };
}

function deriveStatus(status: DispatchStatus | undefined): AgentInvocationStatus {
  if (!status || status === 'queued' || status === 'sent') return 'pending';
  if (status === 'accepted' || status === 'running') return 'running';
  return status;
}

function hashIntent(intent: AgentInvocationIntentV1): string {
  return createHash('sha256').update(canonicalizeAgentInvocationIntent(intent)).digest('hex');
}

async function requireRun(management: ManagementRepositories, managementRunId: string): Promise<ManagementRunDto> {
  const run = await management.runs.getById(managementRunId);
  if (!run) throw new InvocationGatewayError('MANAGEMENT_RUN_NOT_FOUND');
  return run;
}

async function requireWritableRun(management: ManagementRepositories, managementRunId: string): Promise<ManagementRunDto> {
  const run = await requireRun(management, managementRunId);
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
  }
  return run;
}

function isActive(status: DispatchStatus): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}
