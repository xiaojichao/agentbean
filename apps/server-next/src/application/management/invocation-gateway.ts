import { createHash } from 'node:crypto';
import type {
  AgentInvocationIntent,
  AgentInvocationIntentV1,
  AgentInvocationRecordDto,
  AgentInvocationStatus,
  AgentInvocationViewDto,
  AcceptanceCriterionDto,
  DependencyResultRefDto,
  DispatchStatus,
  FrozenProjectInputItemDto,
  MemoryCapsuleRefDto,
  ProjectDocumentInputSetItemV1,
  ProjectStageStableInputDto,
} from '../../../../../packages/contracts/src/index.js';
import {
  canonicalizeAgentInvocationIntent,
  resolveInvocationIdempotency,
} from '../../../../../packages/domain/src/index.js';
import type { InvocationDispatchAttemptRecord, ManagementRepositories, ManagementRunRecord } from '../management-repositories.js';
import type { MemoryRepositories } from '../memory-repositories.js';
import type {
  DispatchMutationResult,
  DispatchRepository,
  ManagementDispatchRepositories,
  ServerNextRepositories,
} from '../repositories.js';
import { resolveProjectStageExecutionGate } from '../project-stage-execution-gate.js';
import { resolveProjectStageStableInputs } from '../project-stage-advance-service.js';
import {
  appendManagementEventInTransaction,
  authorizeManagementWrite,
  ManagementConflictError,
  type LeaseAuthorityInput,
} from './management-kernel.js';

type TerminalDispatchStatus = Extract<DispatchStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;

/**
 * #822 AC#5：Invocation 启动前复算项目阶段门禁。
 * 依赖或必需输入未满足时 fail closed，且不保存需要人工修复的阻塞状态。
 */
async function assertProjectStageExecutionAllowed(
  repositories: ServerNextRepositories,
  taskId: string,
): Promise<void> {
  const task = await repositories.tasks.getById(taskId);
  if (!task) return;
  const gate = await resolveProjectStageExecutionGate(repositories, task);
  if (gate.blocked) throw new InvocationGatewayError('INVOCATION_PROJECT_STAGE_BLOCKED');
}

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
  readonly intent: AgentInvocationIntent;
}

export interface InvokeTaskAgentInput {
  readonly authority: LeaseAuthorityInput;
  readonly idempotencyKey: string;
  readonly taskId: string;
  readonly expectedTaskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: string;
  readonly targetAgentId?: string;
  readonly objective: string;
  readonly attachmentIds: readonly string[];
  readonly memoryCapsuleRef?: MemoryCapsuleRefDto;
  readonly deadlineAt?: number;
}

export type InvokeClaimedProjectStageInput = Omit<InvokeTaskAgentInput, 'authority'> & {
  readonly managementRunId: string;
};

export function createInvocationGateway(dependencies: InvocationGatewayDependencies) {
  const { repositories, clock, ids } = dependencies;

  const invokeTaskAs = async (
    input: InvokeClaimedProjectStageInput,
    actorId: string,
    leaseAuthority?: LeaseAuthorityInput,
  ): Promise<{ disposition: 'created' | 'existing'; view: AgentInvocationViewDto }> =>
    repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        if (leaseAuthority) {
          await authorizeManagementWrite(transactionRepositories.management, leaseAuthority, now);
        }
        const run = await requireRun(transactionRepositories.management, input.managementRunId);
        if (!input.idempotencyKey) throw new InvocationGatewayError('INVOCATION_IDEMPOTENCY_KEY_INVALID');
        if (!input.objective.trim()) throw new InvocationGatewayError('INVOCATION_OBJECTIVE_INVALID');
        if (input.deadlineAt !== undefined && input.deadlineAt <= now) {
          throw new InvocationGatewayError('INVOCATION_DEADLINE_EXPIRED');
        }
        if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
          throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
        }

        const taskForStableInputs = await repositories.tasks.getById(input.taskId);
        const stableResolution = taskForStableInputs
          ? await resolveProjectStageStableInputs(repositories, taskForStableInputs)
          : { stageId: undefined, requiredRuleCount: 0, satisfiedRuleKeys: [], inputs: [] };
        const stableArtifactIds = stableResolution.inputs
          .filter((item): item is Extract<ProjectStageStableInputDto, { kind: 'artifact_version' }> =>
            item.kind === 'artifact_version')
          .map((item) => item.artifactId);
        const normalizedInput: Omit<InvokeTaskAgentInput, 'authority'> = {
          ...input,
          attachmentIds: [...new Set([...input.attachmentIds, ...stableArtifactIds])],
        };
        const existing = await transactionRepositories.management.invocations.getByIdempotencyKey({
          managementRunId: run.id,
          idempotencyKey: input.idempotencyKey,
        });
        if (existing) {
          assertTaskInvocationReplay(existing, normalizedInput);
          await validateAuthoritativeTarget(repositories, existing.intent, run, now);
          return { disposition: 'existing' as const,
            view: await deriveInvocationView(transactionRepositories.management,
              transactionRepositories.dispatches, existing) };
        }

        const authority = await resolveTaskInvocationAuthority(transactionRepositories, run, normalizedInput, now);
        if (input.targetAgentId !== undefined && input.targetAgentId !== authority.targetAgentId) {
          throw new InvocationGatewayError('INVOCATION_TARGET_CLAIM_MISMATCH');
        }
        const agent = await repositories.agents.getById(authority.targetAgentId);
        if (!agent || agent.deletedAt !== undefined || !agent.visibleTeamIds.includes(run.teamId)) {
          throw new InvocationGatewayError('INVOCATION_TARGET_FORBIDDEN');
        }
        const targetKind = agent.category === 'agentos-hosted' ? 'agentos-hosted' as const : 'custom' as const;
        // #1064 AC7：从 claim 关联的 accepted Offer 取冻结输入（发送时刻解析的具体
        // artifactVersionId + review/finalization basis），写入 immutable intent——
        // 执行期间不重新解析 current/final，上游版本变化不改变本事实。
        const claimFrozenInputs = await resolveClaimFrozenInputs(repositories, {
          taskId: input.taskId,
          taskRevision: input.expectedTaskRevision,
          taskAttempt: input.taskAttempt,
          agentId: authority.targetAgentId,
        });
        const baseIntent: AgentInvocationIntentV1 = {
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
          attachmentIds: [...normalizedInput.attachmentIds],
          ...(stableResolution.stageId && {
            projectStageInputFence: {
              stageId: stableResolution.stageId,
              inputs: stableResolution.inputs,
            },
          }),
          ...(claimFrozenInputs.length > 0 ? { frozenInputs: claimFrozenInputs } : {}),
          ...(input.memoryCapsuleRef && { memoryCapsuleRef: input.memoryCapsuleRef }),
          ...(input.deadlineAt !== undefined && { deadlineAt: input.deadlineAt }),
        };
        const intent = await attachProjectDocumentInputSet(
          repositories,
          baseIntent,
          run,
          stableResolution.inputs,
        );
        const intentHash = hashIntent(intent);

        await assertNoActiveTaskAttempt(transactionRepositories, run.id, input.taskId,
          input.expectedTaskRevision, input.taskAttempt);
        await validateAuthoritativeTarget(repositories, intent, run, now);
        await assertProjectStageExecutionAllowed(repositories, input.taskId);
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
          actorId,
          idempotencyKey: `invocation-created:${invocation.id}`,
          payload: { invocationId: invocation.id, intentHash, taskRevision: input.expectedTaskRevision },
        }, now, ids);
        await appendAttemptStartedEvent(transactionRepositories.management, invocation, attempt,
          actorId, now, ids);
        return { disposition: 'created' as const,
          view: await deriveInvocationView(transactionRepositories.management,
            transactionRepositories.dispatches, invocation) };
      });

  const retryAs = async (
    input: { managementRunId: string; invocationId: string },
    actorId: string,
    leaseAuthority?: LeaseAuthorityInput,
  ): Promise<AgentInvocationViewDto> =>
    repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
      const now = clock.now();
      if (leaseAuthority) {
        await authorizeManagementWrite(transactionRepositories.management, leaseAuthority, now);
      }
      const run = await requireWritableRun(
        transactionRepositories.management,
        input.managementRunId,
      );
      const invocation = await transactionRepositories.management.invocations.getById(input.invocationId);
      if (!invocation || invocation.managementRunId !== run.id) {
        throw new InvocationGatewayError('INVOCATION_NOT_FOUND');
      }
      await validateAuthoritativeTarget(repositories, invocation.intent, run, now);
      if (invocation.intent.taskContext) {
        await assertProjectStageExecutionAllowed(repositories, invocation.intent.taskContext.taskId);
      }
      const attempts = await transactionRepositories.management.dispatchAttempts.list(invocation.id);
      const latest = attempts.at(-1);
      if (!latest) throw new InvocationGatewayError('INVOCATION_ATTEMPT_NOT_FOUND');
      const latestDispatch = await transactionRepositories.dispatches.getById(latest.dispatchId);
      if (!latestDispatch) throw new InvocationGatewayError('INVOCATION_DISPATCH_NOT_FOUND');
      if (isActive(latestDispatch.status)) throw new InvocationGatewayError('INVOCATION_ACTIVE_ATTEMPT');

      const attempt = await createAttempt(
        transactionRepositories.management,
        transactionRepositories.dispatches,
        invocation,
        latest.attemptNumber + 1,
        now,
        ids,
      );
      await appendAttemptStartedEvent(
        transactionRepositories.management,
        invocation,
        attempt,
        actorId,
        now,
        ids,
      );
      return deriveInvocationView(
        transactionRepositories.management,
        transactionRepositories.dispatches,
        invocation,
      );
    });

  return {
    async invokeTask(input: InvokeTaskAgentInput): Promise<{ disposition: 'created' | 'existing'; view: AgentInvocationViewDto }> {
      const { authority, ...request } = input;
      return invokeTaskAs({
        ...request,
        managementRunId: authority.managementRunId,
      }, authority.workerId, authority);
    },

    async invokeClaimedProjectStage(
      input: InvokeClaimedProjectStageInput,
    ): Promise<{ disposition: 'created' | 'existing'; view: AgentInvocationViewDto }> {
      return invokeTaskAs(input, 'pi-manager-auto');
    },

    async retryClaimedProjectStage(input: {
      managementRunId: string;
      invocationId: string;
    }): Promise<AgentInvocationViewDto> {
      return retryAs(input, 'pi-manager-auto');
    },

    async invoke(input: InvokeAgentInput): Promise<{ disposition: 'created' | 'existing'; view: AgentInvocationViewDto }> {
      return repositories.managementDispatchUnitOfWork.run(async (transactionRepositories) => {
        const now = clock.now();
        await authorizeManagementWrite(transactionRepositories.management, input.authority, now);
        const run = await requireRun(transactionRepositories.management, input.authority.managementRunId);
        const intent = await attachProjectDocumentInputSet(repositories, input.intent, run);
        validateFrozenIntent({ ...input, intent }, run);
        const intentHash = hashIntent(intent);
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

        await validateAuthoritativeTarget(repositories, intent, run, now);
        const invocation: AgentInvocationRecordDto = {
          schemaVersion: 1,
          id: ids.nextId(),
          managementRunId: run.id,
          intent,
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
            ...(intent.taskContext && { taskRevision: intent.taskContext.taskRevision }),
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
      return retryAs({
        managementRunId: input.authority.managementRunId,
        invocationId: input.invocationId,
      }, input.authority.workerId, input.authority);
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
  run: ManagementRunRecord,
  input: Omit<InvokeTaskAgentInput, 'authority'>,
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
  input: Omit<InvokeTaskAgentInput, 'authority'>): void {
  const context = existing.intent.taskContext;
  const sameAttachments = existing.intent.attachmentIds.length === input.attachmentIds.length
    && existing.intent.attachmentIds.every((id, index) => id === input.attachmentIds[index]);
  if (!context || context.taskId !== input.taskId
    || context.taskRevision !== input.expectedTaskRevision
    || context.taskAttempt !== input.taskAttempt
    || context.claimLeaseId !== input.claimLeaseId
    || (input.targetAgentId !== undefined && existing.intent.targetAgentId !== input.targetAgentId)
    || existing.intent.objective !== input.objective.trim()
    || existing.intent.deadlineAt !== input.deadlineAt
    || !sameMemoryCapsuleRef(existing.intent.memoryCapsuleRef, input.memoryCapsuleRef)
    || !sameAttachments) {
    throw new InvocationGatewayError('INVOCATION_IDEMPOTENCY_CONFLICT');
  }
}

function sameMemoryCapsuleRef(
  existing: MemoryCapsuleRefDto | undefined,
  requested: MemoryCapsuleRefDto | undefined,
): boolean {
  if (existing === undefined && requested === undefined) return true;
  if (existing === undefined || requested === undefined) return false;
  return existing.schemaVersion === requested.schemaVersion
    && existing.id === requested.id
    && existing.teamId === requested.teamId
    && existing.managementRunId === requested.managementRunId
    && existing.taskId === requested.taskId
    && existing.contentHash === requested.contentHash
    && existing.authorizationDecisionId === requested.authorizationDecisionId
    && existing.expiresAt === requested.expiresAt
    && existing.targetAgentId === requested.targetAgentId;
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

async function validateAuthoritativeTarget(
  repositories: ServerNextRepositories,
  intent: AgentInvocationIntent,
  run: ManagementRunRecord,
  now: number,
): Promise<void> {
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
  if (intent.schemaVersion === 2) {
    const version = intent.projectDocumentInputSet.contractVersion;
    if (!agent.projectDocumentInputSetVersions?.includes(version)) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_AGENT_CAPABILITY_MISSING');
    }
    const device = agent.deviceId
      ? await repositories.devices.getById(agent.deviceId)
      : null;
    if (device?.status !== 'online'
      || !device.capabilities?.projectDocumentInputSetVersions?.includes(version)) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_DEVICE_CAPABILITY_MISSING');
    }
    await validateProjectDocumentInputSet(repositories, intent, run);
  }
  await validateMemoryCapsuleRef(
    repositories.memory,
    intent.memoryCapsuleRef,
    run,
    intent.taskContext?.taskId,
    intent.targetAgentId,
    now,
  );
  for (const artifactId of intent.attachmentIds) {
    const artifact = await repositories.artifacts.getForTeam({ teamId: intent.teamId, artifactId });
    if (!artifact || artifact.channelId !== intent.channelId) throw new InvocationGatewayError('INVOCATION_ATTACHMENT_FORBIDDEN');
  }
  if (intent.taskContext) {
    const task = await repositories.tasks.getById(intent.taskContext.taskId);
    if (!task || task.teamId !== intent.teamId || task.channelId !== intent.channelId) throw new InvocationGatewayError('INVOCATION_TASK_FORBIDDEN');
    if (run.rootTaskId && intent.taskContext.rootTaskId !== run.rootTaskId) throw new InvocationGatewayError('INVOCATION_ROOT_TASK_MISMATCH');
    const hasProjectStageFence = intent.projectStageInputFence !== undefined;
    if ((intent.schemaVersion === 2 || hasProjectStageFence)
      && task.revision !== intent.taskContext.taskRevision) {
      throw new InvocationGatewayError('INVOCATION_TASK_REVISION_STALE');
    }
    if (hasProjectStageFence) {
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      if (!coordination || coordination.teamId !== intent.teamId || coordination.managementRunId !== run.id) {
        throw new InvocationGatewayError('INVOCATION_TASK_FORBIDDEN');
      }
      if (coordination.taskRevision !== intent.taskContext.taskRevision) {
        throw new InvocationGatewayError('INVOCATION_TASK_REVISION_STALE');
      }
      if (coordination.attempt !== intent.taskContext.taskAttempt) {
        throw new InvocationGatewayError('INVOCATION_TASK_ATTEMPT_STALE');
      }
      if (task.status !== 'in_progress') throw new InvocationGatewayError('INVOCATION_TASK_NOT_ACTIVE');
      const claim = await repositories.taskCoordination.claimLeases.getById(intent.taskContext.claimLeaseId);
      const currentClaim = await repositories.taskCoordination.claimLeases.getCurrent({
        taskId: task.id,
        taskRevision: intent.taskContext.taskRevision,
        taskAttempt: intent.taskContext.taskAttempt,
      });
      if (!claim || !currentClaim || claim.id !== currentClaim.id
        || claim.status !== 'active' || claim.expiresAt <= now
        || claim.teamId !== intent.teamId || claim.taskId !== task.id
        || claim.taskRevision !== intent.taskContext.taskRevision
        || claim.taskAttempt !== intent.taskContext.taskAttempt
        || claim.agentId !== intent.targetAgentId || task.assigneeId !== claim.agentId) {
        throw new InvocationGatewayError('INVOCATION_CLAIM_STALE');
      }
    }
    const stable = await resolveProjectStageStableInputs(repositories, task);
    if (stable.satisfiedRuleKeys.length !== stable.requiredRuleCount) {
      throw new InvocationGatewayError('INVOCATION_PROJECT_INPUT_STALE');
    }
    const expectedFence = stable.stageId
      ? { stageId: stable.stageId, inputs: stable.inputs }
      : undefined;
    if (JSON.stringify(intent.projectStageInputFence) !== JSON.stringify(expectedFence)) {
      throw new InvocationGatewayError('INVOCATION_PROJECT_INPUT_STALE');
    }
  }
}

async function validateMemoryCapsuleRef(
  memory: MemoryRepositories,
  requested: MemoryCapsuleRefDto | undefined,
  run: ManagementRunRecord,
  taskId: string | undefined,
  targetAgentId: string,
  now: number,
): Promise<void> {
  if (!requested) return;
  const stored = await memory.capsuleRefs.getById({ teamId: run.teamId, id: requested.id });
  if (!stored
    || requested.schemaVersion !== 1
    || stored.deniedAt !== undefined
    || stored.expiresAt <= now
    || requested.teamId !== run.teamId
    || requested.managementRunId !== run.id
    || requested.taskId !== taskId
    || requested.targetAgentId !== targetAgentId
    || stored.managementRunId !== requested.managementRunId
    || stored.taskId !== requested.taskId
    || stored.targetAgentId !== requested.targetAgentId
    || stored.contentHash !== requested.contentHash
    || stored.authorizationDecisionId !== requested.authorizationDecisionId
    || stored.expiresAt !== requested.expiresAt) {
    throw new InvocationGatewayError('INVOCATION_MEMORY_CAPSULE_REF_INVALID');
  }
}

function validateFrozenIntent(input: InvokeAgentInput, run: ManagementRunRecord): void {
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

function hashIntent(intent: AgentInvocationIntent): string {
  return createHash('sha256').update(canonicalizeAgentInvocationIntent(intent)).digest('hex');
}

/**
 * #1064 AC7：从 claim 关联的 accepted Offer 取冻结输入。
 * claim 与 offer 无直接外键（既有模型）；用 taskId+agentId+taskRevision 定位
 * 该 claim 对应的 accepted offer（acceptance 时冻结的 frozenInputs 原样继承）。
 * 无冻结输入（普通 subtask 路径）→ []（向后兼容，不改变既有 intent）。
 */
async function resolveClaimFrozenInputs(
  repositories: ServerNextRepositories,
  input: { taskId: string; taskRevision: number; taskAttempt: number; agentId: string },
): Promise<readonly FrozenProjectInputItemDto[]> {
  const offers = await repositories.taskCoordination.offers.listByTask(input.taskId);
  // 按 taskAttempt 精确匹配当前 claim 对应的 accepted offer：remediation 翻 attempt 后
  // 旧 attempt 的 accepted offer 不得遮蔽当前 claim 的冻结输入。
  const accepted = offers.find((offer) =>
    offer.agentId === input.agentId
    && offer.taskRevision === input.taskRevision
    && offer.taskAttempt === input.taskAttempt
    && offer.status === 'accepted');
  return accepted?.frozenInputs ?? [];
}

async function attachProjectDocumentInputSet(
  repositories: ServerNextRepositories,
  intent: AgentInvocationIntent,
  run: ManagementRunRecord,
  stableInputs: readonly ProjectStageStableInputDto[] = [],
): Promise<AgentInvocationIntent> {
  const stableDocuments = stableInputs.filter(
    (item): item is Extract<ProjectStageStableInputDto, { kind: 'document_revision' }> =>
      item.kind === 'document_revision',
  );
  if (stableDocuments.length > 0) {
    return attachStableProjectDocuments(repositories, intent, stableDocuments);
  }
  const referenceSet = await repositories.projectReferenceSets.getByMessageId({
    teamId: run.teamId,
    channelId: run.channelId,
    messageId: run.rootMessageId,
  });
  if (!referenceSet) {
    if (intent.schemaVersion === 2) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
    return intent;
  }
  const items: ProjectDocumentInputSetItemV1[] = [];
  for (const selection of referenceSet.selections) {
    for (const item of selection.items) {
      if (item.kind !== 'document_revision') continue;
      const document = await repositories.channelDocuments.getForTeam({
        teamId: run.teamId,
        channelId: run.channelId,
        documentId: item.documentId!,
      });
      const revision = await repositories.channelDocuments.getRevision({
        documentId: item.documentId!,
        revisionId: item.revisionId!,
      });
      if (!document || !revision
        || revision.artifact.teamId !== run.teamId
        || revision.artifact.channelId !== run.channelId) {
        throw new InvocationGatewayError('INVOCATION_INPUT_SET_REVISION_FORBIDDEN');
      }
      if (!revision.artifact.sha256) {
        throw new InvocationGatewayError('INVOCATION_INPUT_SET_CHECKSUM_UNAVAILABLE');
      }
      const displayName = item.filename ?? document.filename;
      items.push({
        documentId: item.documentId!,
        baseRevisionId: item.revisionId!,
        revisionNumber: item.revisionNumber!,
        artifactId: revision.artifact.id,
        displayName,
        summary: selection.bundleName
          ? `${selection.sourceKind}:${selection.bundleName}`
          : selection.sourceKind,
        relativePath: `documents/${String(items.length + 1).padStart(3, '0')}-${safeInputName(displayName)}`,
        mimeType: revision.artifact.mimeType,
        sizeBytes: revision.artifact.sizeBytes,
        sha256: revision.artifact.sha256,
        source: {
          referenceSetId: referenceSet.id,
          selectionId: selection.id,
          selectionSourceKind: selection.sourceKind,
          ...(selection.bundleId ? { bundleId: selection.bundleId } : {}),
          ...(selection.bundleName ? { bundleName: selection.bundleName } : {}),
        },
      });
    }
  }
  if (items.length === 0) {
    if (intent.schemaVersion === 2) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
    return intent;
  }
  const id = `project-document-input-set:${createHash('sha256')
    .update(`${referenceSet.id}:${intent.targetAgentId}:1`)
    .digest('hex')
    .slice(0, 24)}`;
  const projectDocumentInputSet = {
    id,
    contractVersion: 1 as const,
    required: true as const,
    referenceSetId: referenceSet.id,
    items,
  };
  if (intent.schemaVersion === 2) {
    if (canonicalizeAgentInvocationIntent({
      ...intent,
      projectDocumentInputSet,
    }) !== canonicalizeAgentInvocationIntent(intent)) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
    return intent;
  }
  return {
    ...intent,
    schemaVersion: 2,
    projectDocumentInputSet,
  };
}

async function attachStableProjectDocuments(
  repositories: ServerNextRepositories,
  intent: AgentInvocationIntent,
  stableDocuments: readonly Extract<ProjectStageStableInputDto, { kind: 'document_revision' }>[],
): Promise<AgentInvocationIntent> {
  const referenceSetId = `project-stage:${intent.taskContext?.taskId}:${intent.taskContext?.taskRevision}`;
  const items: ProjectDocumentInputSetItemV1[] = [];
  for (const stable of stableDocuments) {
    const document = await repositories.channelDocuments.getForTeam({
      teamId: intent.teamId,
      channelId: intent.channelId,
      documentId: stable.documentId,
    });
    const revision = await repositories.channelDocuments.getRevision({
      documentId: stable.documentId,
      revisionId: stable.revisionId,
    });
    if (!document || !revision
      || revision.artifact.id !== stable.artifactId
      || revision.artifact.teamId !== intent.teamId
      || revision.artifact.channelId !== intent.channelId
      || !revision.artifact.sha256) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REVISION_FORBIDDEN');
    }
    items.push({
      documentId: stable.documentId,
      baseRevisionId: stable.revisionId,
      revisionNumber: stable.revisionNumber,
      artifactId: stable.artifactId,
      displayName: document.filename,
      summary: `project-stage:${stable.upstreamStageId}:${stable.key}`,
      relativePath: `documents/${String(items.length + 1).padStart(3, '0')}-${safeInputName(document.filename)}`,
      mimeType: revision.artifact.mimeType,
      sizeBytes: revision.artifact.sizeBytes,
      sha256: revision.artifact.sha256,
      source: {
        referenceSetId,
        selectionId: `project-stage-input:${stable.edgeId}:${stable.key}`,
        selectionSourceKind: 'document',
        bundleId: stable.bundleId,
      },
    });
  }
  const projectDocumentInputSet = {
    id: `project-document-input-set:${createHash('sha256')
      .update(`${referenceSetId}:${intent.targetAgentId}:1:${items.map((item) => item.baseRevisionId).join(':')}`)
      .digest('hex')
      .slice(0, 24)}`,
    contractVersion: 1 as const,
    required: true as const,
    referenceSetId,
    items,
  };
  if (intent.schemaVersion === 2) {
    if (canonicalizeAgentInvocationIntent({ ...intent, projectDocumentInputSet })
      !== canonicalizeAgentInvocationIntent(intent)) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
    return intent;
  }
  return { ...intent, schemaVersion: 2, projectDocumentInputSet };
}

async function validateProjectDocumentInputSet(
  repositories: ServerNextRepositories,
  intent: Extract<AgentInvocationIntent, { schemaVersion: 2 }>,
  run: ManagementRunRecord,
): Promise<void> {
  const inputSet = intent.projectDocumentInputSet;
  if (inputSet.contractVersion !== 1 || !inputSet.required || inputSet.items.length === 0) {
    throw new InvocationGatewayError('INVOCATION_INPUT_SET_INVALID');
  }
  if (inputSet.referenceSetId.startsWith('project-stage:')) {
    const task = intent.taskContext
      ? await repositories.tasks.getById(intent.taskContext.taskId)
      : null;
    if (!task || task.revision !== intent.taskContext?.taskRevision) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
    const current = await resolveProjectStageStableInputs(repositories, task);
    const currentDocuments = current.inputs.filter(
      (item): item is Extract<ProjectStageStableInputDto, { kind: 'document_revision' }> =>
        item.kind === 'document_revision',
    );
    if (currentDocuments.length !== inputSet.items.length
      || inputSet.items.some((item) => !currentDocuments.some((candidate) =>
        candidate.documentId === item.documentId
        && candidate.revisionId === item.baseRevisionId
        && candidate.artifactId === item.artifactId))) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
  } else {
    const referenceSet = await repositories.projectReferenceSets.getByMessageId({
      teamId: intent.teamId,
      channelId: intent.channelId,
      messageId: run.rootMessageId,
    });
    if (!referenceSet || referenceSet.id !== inputSet.referenceSetId) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REFERENCE_STALE');
    }
  }
  for (const item of inputSet.items) {
    const document = await repositories.channelDocuments.getForTeam({
      teamId: intent.teamId,
      channelId: intent.channelId,
      documentId: item.documentId,
    });
    const revision = await repositories.channelDocuments.getRevision({
      documentId: item.documentId,
      revisionId: item.baseRevisionId,
    });
    if (!document || !revision
      || revision.artifact.id !== item.artifactId
      || revision.artifact.teamId !== intent.teamId
      || revision.artifact.channelId !== intent.channelId
      || revision.artifact.sha256 !== item.sha256
      || revision.artifact.sizeBytes !== item.sizeBytes) {
      throw new InvocationGatewayError('INVOCATION_INPUT_SET_REVISION_FORBIDDEN');
    }
  }
}

function safeInputName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^-+|-+$/g, '') || 'document.md';
}

async function requireRun(management: ManagementRepositories, managementRunId: string): Promise<ManagementRunRecord> {
  const run = await management.runs.getById(managementRunId);
  if (!run) throw new InvocationGatewayError('MANAGEMENT_RUN_NOT_FOUND');
  return run;
}

async function requireWritableRun(management: ManagementRepositories, managementRunId: string): Promise<ManagementRunRecord> {
  const run = await requireRun(management, managementRunId);
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    throw new ManagementConflictError('MANAGEMENT_RUN_TERMINAL');
  }
  return run;
}

function isActive(status: DispatchStatus): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}
