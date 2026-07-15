import { createHash } from 'node:crypto';
import type {
  AgentCollaborationProposalRecordDto,
  AgentCollaborationProposalV1,
  AgentHandoffRecordDto,
  AgentHandoffStatus,
  ManagementEventPayloadMapV1,
  Phase2ManagementWorkerToolInputMapV1,
} from '../../../../../packages/contracts/src/index.js';
import {
  evaluateContinuationOwnerTransition,
  resolveCollaborationIdempotency,
  wouldCreateContinuationLoop,
} from '../../../../../packages/domain/src/index.js';
import type { ServerNextRepositories } from '../repositories.js';
import { createInvocationGateway } from './invocation-gateway.js';
import {
  appendValidatedManagementEventInTransaction,
  authorizeManagementWrite,
  type LeaseAuthorityInput,
} from './management-kernel.js';
import {
  hashManagementCommandInput,
  hashManagementEventPayload,
  parseCollaborationManagementEvent,
} from './management-event-validator.js';

type HandoffRequest = Phase2ManagementWorkerToolInputMapV1['handoffs.request'];
type TerminalStatus = Extract<AgentHandoffStatus, 'returned' | 'failed' | 'cancelled' | 'timed_out'>;

export function createCollaborationService(input: {
  readonly repositories: ServerNextRepositories;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
}) {
  const { repositories, clock, ids } = input;
  const gateway = createInvocationGateway({ repositories, clock, ids });

  return {
    async listAvailableAgents(request: { managementRunId: string; capabilityQuery?: string; includeBusy?: boolean }) {
      const run = await requireRun(repositories, request.managementRunId);
      const channel = await repositories.channels.getById(run.channelId);
      if (!channel || channel.teamId !== run.teamId || channel.archivedAt) throw new Error('HANDOFF_CHANNEL_FORBIDDEN');
      const query = request.capabilityQuery?.trim().toLowerCase();
      return (await repositories.agents.listVisibleInTeam(run.teamId))
        .flatMap((agent) => {
          const capabilities = ['dispatch'];
          const skills = (agent.skills ?? []).map((skill) => skill.name);
          if (agent.deletedAt !== undefined
            || (channel.dmTargetAgentId !== agent.id && !channel.agentMemberIds.includes(agent.id))
            || (!request.includeBusy && agent.status === 'busy')
            || (query && !capabilities.some((capability) => capability.includes(query))
              && !skills.some((skill) => skill.toLowerCase().includes(query)))) return [];
          return [{ agentId: agent.id, name: agent.name,
            kind: agent.category === 'agentos-hosted' ? 'agentos-hosted' as const : 'custom' as const,
            status: normalizeStatus(agent.status), capabilities, skills, channelMember: true }];
        });
    },

    async recordProposals(request: {
      readonly dispatchId: string;
      readonly agentId: string;
      readonly proposals: readonly AgentCollaborationProposalV1[];
    }): Promise<AgentCollaborationProposalRecordDto[]> {
      const attempt = await repositories.management.dispatchAttempts.getByDispatchId(request.dispatchId);
      if (!attempt) throw new Error('HANDOFF_SOURCE_ATTEMPT_NOT_FOUND');
      const invocation = await repositories.management.invocations.getById(attempt.invocationId);
      if (!invocation || invocation.intent.targetAgentId !== request.agentId) throw new Error('HANDOFF_SOURCE_INVOCATION_FORBIDDEN');
      const run = await requireRun(repositories, invocation.managementRunId);
      const records: AgentCollaborationProposalRecordDto[] = [];
      for (const proposal of request.proposals) {
        if (proposal.sourceInvocationId !== invocation.id || proposal.sourceAgentId !== request.agentId) {
          throw new Error('HANDOFF_PROPOSAL_SOURCE_MISMATCH');
        }
        if (!sameTaskContext(proposal.sourceTaskContext, invocation.intent.taskContext)) {
          throw new Error('HANDOFF_PROPOSAL_FENCE_MISMATCH');
        }
        await requireEligibleTarget(repositories, run, proposal.toAgentId, false);
        if (proposal.sourceTaskContext
          && !(await isTaskFenceCurrent(repositories, run.id, proposal.sourceTaskContext, clock.now()))) {
          throw new Error('HANDOFF_PROPOSAL_STALE');
        }
        const proposalHash = hashManagementCommandInput(proposal);
        const idempotencyKey = `proposal:${invocation.id}:${proposalHash}`;
        const existing = await repositories.management.collaborationProposals.getByIdempotencyKey({
          managementRunId: run.id, idempotencyKey,
        });
        const decision = resolveCollaborationIdempotency({ existing: existing ? {
          id: existing.id, managementRunId: existing.managementRunId,
          idempotencyKey: existing.idempotencyKey, payloadHash: existing.proposalHash,
        } : undefined, requestedManagementRunId: run.id, requestedIdempotencyKey: idempotencyKey,
        requestedPayloadHash: proposalHash });
        if (decision.kind === 'conflict') throw new Error('HANDOFF_PROPOSAL_IDEMPOTENCY_CONFLICT');
        if (decision.kind === 'existing') { records.push(existing!); continue; }
        const record: AgentCollaborationProposalRecordDto = { schemaVersion: 1, id: ids.nextId(),
          managementRunId: run.id, proposal, proposalHash, idempotencyKey, createdAt: clock.now() };
        await repositories.managementUnitOfWork.run(async (management) => {
          await management.collaborationProposals.create(record);
          await appendCollaborationEvent(management, { managementRunId: run.id,
            type: 'handoff-proposed', actorKind: 'agent', actorId: request.agentId,
            idempotencyKey: `handoff-proposed:${record.id}`, payload: {
              proposalId: record.id, sourceInvocationId: invocation.id,
              sourceAgentId: request.agentId, toAgentId: proposal.toAgentId, kind: proposal.kind,
              ...(proposal.sourceTaskContext ? { taskId: proposal.sourceTaskContext.taskId,
                taskRevision: proposal.sourceTaskContext.taskRevision,
                claimLeaseId: proposal.sourceTaskContext.claimLeaseId } : {}), proposalHash,
            } }, clock.now(), ids);
        });
        records.push(record);
      }
      return records;
    },

    async requestHandoff(request: HandoffRequest & {
      readonly authority: LeaseAuthorityInput;
      readonly idempotencyKey: string;
    }) {
      const now = clock.now();
      await authorizeManagementWrite(repositories.management, request.authority, now);
      const run = await requireRun(repositories, request.authority.managementRunId);
      if (run.schemaVersion !== 2) throw new Error('HANDOFF_PHASE_2_REQUIRED');
      const proposal = request.sourceProposalId
        ? await repositories.management.collaborationProposals.getById(request.sourceProposalId)
        : null;
      if ((request.sourceProposalId || request.sourceInvocationId) && (!proposal
        || proposal.managementRunId !== run.id
        || proposal.proposal.sourceInvocationId !== request.sourceInvocationId
        || proposal.proposal.toAgentId !== request.toAgentId
        || proposal.proposal.kind !== request.kind
        || proposal.proposal.objective !== request.objective
        || proposal.proposal.reason !== request.reason
        || proposal.proposal.returnMode !== request.returnMode
        || proposal.proposal.deadlineAt !== request.deadlineAt
        || hashManagementCommandInput(proposal.proposal.acceptanceCriteria)
          !== hashManagementCommandInput(request.acceptanceCriteria))) {
        throw new Error('HANDOFF_PROPOSAL_MISMATCH');
      }
      const existing = await repositories.management.handoffs.getByIdempotencyKey({
        managementRunId: run.id, idempotencyKey: request.idempotencyKey });
      const fromAgentId = existing?.intent.fromAgentId
        ?? proposal?.proposal.sourceAgentId ?? run.activeAgentId ?? run.mainAgentId;
      const contextRefs = proposal ? proposal.proposal.contextRefs
        .filter((ref) => request.contextRefIds.includes(ref.id)) : [];
      const dependencyResults = proposal ? proposal.proposal.dependencyResults
        .filter((ref) => request.dependencyInvocationIds.includes(ref.invocationId)) : [];
      if (!proposal && (request.contextRefIds.length > 0 || request.dependencyInvocationIds.length > 0)) {
        throw new Error('HANDOFF_CONTEXT_CAPSULE_REQUIRED');
      }
      if (proposal && (contextRefs.length !== request.contextRefIds.length
        || dependencyResults.length !== request.dependencyInvocationIds.length
        || request.attachmentIds.some((id) => !proposal.proposal.attachmentIds.includes(id)))) {
        throw new Error('HANDOFF_PROPOSAL_CONTEXT_MISMATCH');
      }
      const intent = { schemaVersion: 1 as const, managementRunId: run.id,
        ...(proposal ? { sourceProposalId: proposal.id,
          sourceInvocationId: proposal.proposal.sourceInvocationId } : {}),
        ...(fromAgentId ? { fromAgentId } : {}), toAgentId: request.toAgentId,
        kind: request.kind, objective: request.objective.trim(), reason: request.reason.trim(),
        contextRefs, dependencyResults, acceptanceCriteria: [...request.acceptanceCriteria],
        attachmentIds: [...request.attachmentIds], returnMode: request.returnMode,
        ...(request.deadlineAt !== undefined ? { deadlineAt: request.deadlineAt } : {}) };
      const intentHash = hashManagementCommandInput(intent);
      const decision = resolveCollaborationIdempotency({ existing: existing ? {
        id: existing.id, managementRunId: existing.managementRunId,
        idempotencyKey: existing.idempotencyKey, payloadHash: existing.intentHash,
      } : undefined, requestedManagementRunId: run.id,
      requestedIdempotencyKey: request.idempotencyKey, requestedPayloadHash: intentHash });
      if (decision.kind === 'conflict') throw new Error('HANDOFF_IDEMPOTENCY_CONFLICT');
      if (decision.kind === 'existing' && existing?.invocationId) {
        const invocation = await repositories.management.invocations.getById(existing.invocationId);
        if (!invocation) throw new Error('HANDOFF_INVOCATION_NOT_FOUND');
        return { handoff: existing, invocation, view: await gateway.getView(invocation.id),
          disposition: 'existing' as const };
      }
      if (decision.kind === 'existing' && existing?.status !== 'requested') {
        throw new Error('HANDOFF_RECOVERY_CONFLICT');
      }
      if (existing) {
        const recoveredInvocation = await repositories.management.invocations.getByIdempotencyKey({
          managementRunId: run.id,
          idempotencyKey: `${request.idempotencyKey}:invocation`,
        });
        if (recoveredInvocation) {
          const recoveredHandoff = { ...existing, invocationId: recoveredInvocation.id, updatedAt: now };
          await repositories.managementUnitOfWork.run(async (management) => {
            await management.handoffs.update(recoveredHandoff);
            await appendCollaborationEvent(management, { managementRunId: run.id,
              type: 'handoff-dispatched', actorKind: 'manager', actorId: request.authority.workerId,
              idempotencyKey: `handoff-dispatched:${existing.id}`, payload: {
                handoffId: existing.id, invocationId: recoveredInvocation.id,
              } }, now, ids);
          });
          return { handoff: recoveredHandoff, invocation: recoveredInvocation,
            view: await gateway.getView(recoveredInvocation.id), disposition: 'existing' as const };
        }
      }
      if (intent.deadlineAt !== undefined && intent.deadlineAt <= now) {
        throw new Error('HANDOFF_DEADLINE_EXPIRED');
      }
      const target = await requireEligibleTarget(repositories, run, request.toAgentId, true);
      if (proposal?.proposal.sourceTaskContext
        && !(await (existing
          ? isTaskRevisionFenceCurrent(repositories, run.id, proposal.proposal.sourceTaskContext)
          : isTaskFenceCurrent(repositories, run.id, proposal.proposal.sourceTaskContext, now)))) {
        throw new Error('HANDOFF_PROPOSAL_STALE');
      }
      const invocations = await repositories.management.invocations.listByRun(run.id);
      if (invocations.length >= run.budget.maxExternalInvocations) throw new Error('HANDOFF_BUDGET_CONFLICT');
      const prior = (await repositories.management.handoffs.listByRun(run.id))
        .filter((item) => item.id !== existing?.id);
      if (prior.some((item) => !isTerminalHandoffStatus(item.status))) {
        throw new Error('HANDOFF_SERIAL_CONFLICT');
      }
      if (prior.length >= run.budget.maxSubtasks
        || (request.kind === 'continuation'
          && prior.filter((item) => item.intent.kind === 'continuation').length >= run.budget.maxDepth)) {
        throw new Error('HANDOFF_BUDGET_CONFLICT');
      }
      if (request.kind === 'continuation' && wouldCreateContinuationLoop({ fromAgentId,
        toAgentId: request.toAgentId, priorEdges: prior.map((item) => ({
          fromAgentId: item.intent.fromAgentId, toAgentId: item.intent.toAgentId,
          kind: item.intent.kind === 'continuation' ? 'continuation' : 'consult',
        })) })) throw new Error('HANDOFF_LOOP_CONFLICT');
      let handoff: AgentHandoffRecordDto = existing ?? { schemaVersion: 1, id: ids.nextId(),
        managementRunId: run.id, intent, intentHash, idempotencyKey: request.idempotencyKey,
        status: 'requested', createdAt: now, updatedAt: now };
      if (!existing) {
        await repositories.managementUnitOfWork.run(async (management) => {
          await management.handoffs.create(handoff);
          await appendCollaborationEvent(management, { managementRunId: run.id,
            type: 'handoff-requested', actorKind: 'manager', actorId: request.authority.workerId,
            idempotencyKey: `handoff-requested:${handoff.id}`, payload: {
              handoffId: handoff.id, ...(proposal ? { sourceProposalId: proposal.id,
                sourceInvocationId: proposal.proposal.sourceInvocationId } : {}),
              ...(fromAgentId ? { fromAgentId } : {}), toAgentId: request.toAgentId,
              kind: request.kind, objectiveHash: sha256(intent.objective),
            } }, now, ids);
        });
      }
      let invoked: Awaited<ReturnType<typeof gateway.invoke>>;
      try {
        invoked = await gateway.invoke({ authority: request.authority,
          frozenTargetAgentId: request.toAgentId, allowedTargetAgentIds: [request.toAgentId],
          idempotencyKey: `${request.idempotencyKey}:invocation`, intent: {
            schemaVersion: 1, teamId: run.teamId, channelId: run.channelId,
            targetAgentId: request.toAgentId,
            targetKind: target.category === 'agentos-hosted' ? 'agentos-hosted' : 'custom',
            objective: intent.objective,
            ...(proposal?.proposal.sourceTaskContext ? { taskContext: proposal.proposal.sourceTaskContext } : {}),
            acceptanceCriteria: intent.acceptanceCriteria, dependencyResults: intent.dependencyResults,
            attachmentIds: intent.attachmentIds,
            ...(intent.deadlineAt !== undefined ? { deadlineAt: intent.deadlineAt } : {}),
          } });
      } catch (error) {
        await repositories.management.handoffs.update({ ...handoff, status: 'failed', updatedAt: clock.now() });
        throw error;
      }
      handoff = { ...handoff, invocationId: invoked.view.id, updatedAt: clock.now() };
      await repositories.managementUnitOfWork.run(async (management) => {
        await management.handoffs.update(handoff);
        await appendCollaborationEvent(management, { managementRunId: run.id,
          type: 'handoff-dispatched', actorKind: 'manager', actorId: request.authority.workerId,
          idempotencyKey: `handoff-dispatched:${handoff.id}`, payload: {
            handoffId: handoff.id, invocationId: invoked.view.id,
          } }, clock.now(), ids);
      });
      const invocation = await repositories.management.invocations.getById(invoked.view.id);
      if (!invocation) throw new Error('HANDOFF_INVOCATION_NOT_FOUND');
      return { handoff, invocation, view: invoked.view, disposition: invoked.disposition };
    },

    async recordAccepted(request: { dispatchId: string }) {
      return updateFromDispatch(repositories, clock, ids, request.dispatchId, 'accepted', []);
    },

    async recordTerminal(request: {
      dispatchId: string;
      status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
      artifactIds: readonly string[];
    }) {
      return updateFromDispatch(repositories, clock, ids, request.dispatchId,
        request.status === 'succeeded' ? 'returned' : request.status, request.artifactIds);
    },

    async getHandoff(handoffId: string) {
      return repositories.management.handoffs.getById(handoffId);
    },
  };
}

async function updateFromDispatch(
  repositories: ServerNextRepositories,
  clock: { now(): number },
  ids: { nextId(): string },
  dispatchId: string,
  status: 'accepted' | TerminalStatus,
  artifactIds: readonly string[],
) {
  const attempt = await repositories.management.dispatchAttempts.getByDispatchId(dispatchId);
  if (!attempt) return null;
  const initialHandoff = await repositories.management.handoffs.getByInvocationId(attempt.invocationId);
  if (!initialHandoff) return null;
  const initialRun = await requireRun(repositories, initialHandoff.managementRunId);
  if (initialRun.schemaVersion !== 2) return initialHandoff;
  const invocation = await repositories.management.invocations.getById(attempt.invocationId);
  if (!invocation) throw new Error('HANDOFF_INVOCATION_NOT_FOUND');
  const now = clock.now();
  const taskFenceCurrent = !invocation.intent.taskContext
    || await isTaskRevisionFenceCurrent(repositories, initialRun.id, invocation.intent.taskContext);
  return repositories.managementUnitOfWork.run(async (management) => {
    const handoff = await management.handoffs.getById(initialHandoff.id);
    const run = await management.runs.getById(initialRun.id);
    if (!handoff || !run || run.schemaVersion !== 2) return handoff;
    if (handoff.status === status || (status === 'accepted' && handoff.status === 'running')
      || isTerminalHandoffStatus(handoff.status)) return handoff;
    const updated: AgentHandoffRecordDto = { ...handoff, status,
      ...(status === 'accepted' ? { acceptedAt: now } : {}), updatedAt: now };
    const transition = handoff.intent.kind === 'continuation'
      ? evaluateContinuationOwnerTransition({ currentAgentId: run.activeAgentId,
        sourceAgentId: handoff.intent.fromAgentId ?? run.mainAgentId,
        targetAgentId: handoff.intent.toAgentId, status, taskFenceCurrent })
      : { kind: 'unchanged' as const };
    await management.handoffs.update(updated);
    if (status !== 'accepted') {
      await appendCollaborationEvent(management, { managementRunId: run.id,
        type: 'handoff-returned', actorKind: 'system',
        idempotencyKey: `handoff-returned:${handoff.id}:${status}`, payload: {
          handoffId: handoff.id, invocationId: invocation.id,
          status: status === 'returned' ? 'succeeded' : status,
          resultRevision: attempt.attemptNumber, artifactIds: [...artifactIds],
        } }, now, ids);
    }
    if (transition.kind === 'changed') {
      await management.runs.update({ ...run, activeAgentId: transition.nextAgentId,
        collaborationMode: 'handoff', updatedAt: now });
      await appendCollaborationEvent(management, { managementRunId: run.id,
        type: 'active-agent-changed', actorKind: 'system',
        idempotencyKey: `active-agent-changed:${handoff.id}:${status}`, payload: {
          ...(run.activeAgentId ? { previousAgentId: run.activeAgentId } : {}),
          ...(transition.nextAgentId ? { nextAgentId: transition.nextAgentId } : {}),
          handoffId: handoff.id, reasonCode: transition.reasonCode,
        } }, now, ids);
    }
    return updated;
  });
}

type CollaborationEventType = 'handoff-proposed' | 'handoff-requested' | 'handoff-dispatched'
  | 'handoff-returned' | 'active-agent-changed';

async function appendCollaborationEvent<T extends CollaborationEventType>(
  management: ServerNextRepositories['management'],
  event: { managementRunId: string; type: T; actorKind: 'system' | 'manager' | 'agent' | 'human';
    actorId?: string; idempotencyKey: string; payload: ManagementEventPayloadMapV1[T] },
  now: number,
  ids: { nextId(): string },
) {
  const payloadHash = hashManagementEventPayload({ type: event.type, payload: event.payload } as never);
  return appendValidatedManagementEventInTransaction(management, event, now, ids,
    { payloadHash, parseEvent: parseCollaborationManagementEvent });
}

async function requireRun(repositories: ServerNextRepositories, managementRunId: string) {
  const run = await repositories.management.runs.getById(managementRunId);
  if (!run) throw new Error('MANAGEMENT_RUN_NOT_FOUND');
  return run;
}

async function requireEligibleTarget(
  repositories: ServerNextRepositories,
  run: Awaited<ReturnType<typeof requireRun>>,
  agentId: string,
  requireOnline: boolean,
) {
  const channel = await repositories.channels.getById(run.channelId);
  const agent = await repositories.agents.getById(agentId);
  if (!channel || channel.teamId !== run.teamId || channel.archivedAt || !agent
    || agent.deletedAt !== undefined || !agent.visibleTeamIds.includes(run.teamId)
    || (channel.dmTargetAgentId !== agentId && !channel.agentMemberIds.includes(agentId))) {
    throw new Error('HANDOFF_TARGET_FORBIDDEN');
  }
  if (requireOnline && agent.status !== 'online' && agent.status !== 'busy') {
    throw new Error('HANDOFF_TARGET_UNAVAILABLE');
  }
  return agent;
}

async function isTaskFenceCurrent(
  repositories: ServerNextRepositories,
  managementRunId: string,
  context: NonNullable<AgentCollaborationProposalV1['sourceTaskContext']>,
  now: number,
) {
  const [task, coordination, claim, currentClaim] = await Promise.all([
    repositories.tasks.getById(context.taskId),
    repositories.taskCoordination.coordinations.getByTaskId(context.taskId),
    repositories.taskCoordination.claimLeases.getById(context.claimLeaseId),
    repositories.taskCoordination.claimLeases.getCurrent({
      taskId: context.taskId,
      taskRevision: context.taskRevision,
      taskAttempt: context.taskAttempt,
    }),
  ]);
  return Boolean(task && coordination && claim && currentClaim?.id === claim.id
    && coordination.managementRunId === managementRunId
    && task.revision === context.taskRevision && coordination.taskRevision === context.taskRevision
    && coordination.attempt === context.taskAttempt && claim.taskId === context.taskId
    && claim.taskRevision === context.taskRevision && claim.taskAttempt === context.taskAttempt
    && claim.status === 'active' && claim.expiresAt > now);
}

async function isTaskRevisionFenceCurrent(
  repositories: ServerNextRepositories,
  managementRunId: string,
  context: NonNullable<AgentCollaborationProposalV1['sourceTaskContext']>,
) {
  const [task, coordination] = await Promise.all([
    repositories.tasks.getById(context.taskId),
    repositories.taskCoordination.coordinations.getByTaskId(context.taskId),
  ]);
  return Boolean(task && coordination
    && coordination.managementRunId === managementRunId
    && task.revision === context.taskRevision
    && coordination.taskRevision === context.taskRevision
    && coordination.attempt === context.taskAttempt);
}

function sameTaskContext(
  left: AgentCollaborationProposalV1['sourceTaskContext'],
  right: AgentCollaborationProposalV1['sourceTaskContext'],
) {
  return left === right || Boolean(left && right
    && left.taskId === right.taskId
    && left.rootTaskId === right.rootTaskId
    && left.taskRevision === right.taskRevision
    && left.taskAttempt === right.taskAttempt
    && left.claimLeaseId === right.claimLeaseId);
}

function normalizeStatus(status: string): 'online' | 'busy' | 'offline' | 'unknown' {
  return status === 'online' || status === 'busy' || status === 'offline' ? status : 'unknown';
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function isTerminalHandoffStatus(status: AgentHandoffStatus) {
  return status === 'returned' || status === 'rejected' || status === 'failed'
    || status === 'cancelled' || status === 'timed_out';
}
