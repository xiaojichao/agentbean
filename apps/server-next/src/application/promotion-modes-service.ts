import { createHash } from 'node:crypto';

import type {
  AgentOrchestrationEscalationV1,
  PromotionProposalActionV1,
  PromotionProposalV1,
  PromotionFreshnessBasisV1,
  SemanticPromotionEvaluationV1,
  SemanticPromotionRolloutStateV1,
  TeamPromotionPolicyV1,
} from '../../../../packages/contracts/src/index.js';
import {
  evaluateAgentOrchestrationEscalation,
  evaluatePromotionProposalTransition,
  evaluateSemanticPromotionPath,
  evaluateTeamPromotionPolicy,
  type SemanticPromotionExclusion,
} from '../../../../packages/domain/src/index.js';
import { createPromotionGateHandler } from './promotion-gate-handler.js';
import type {
  PromotionProposalRecord,
  PromotionProposalActionReceiptRecord,
} from './promotion-gate-repositories.js';
import type {
  TaskCoordinationTransactionRepositories,
  TaskCoordinationUnitOfWork,
} from './task-coordination-unit-of-work.js';

interface PromotionSuccessContext {
  readonly repositories: TaskCoordinationTransactionRepositories;
  readonly rootTaskId: string;
  readonly managementRunId: string;
  readonly sourceRelationId: string;
  readonly rootMessageId: string;
  readonly now: number;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function lineageKey(teamId: string, lineage: { readonly kind: string; readonly id: string }): string {
  return `${teamId}:${lineage.kind}:${lineage.id}`;
}

function proposalView(record: PromotionProposalRecord, authorizationToken: string): PromotionProposalV1 {
  return {
    schemaVersion: 1,
    id: record.id,
    teamId: record.teamId,
    channelId: record.channelId,
    sourceLineage: JSON.parse(record.sourceLineageJson) as PromotionProposalV1['sourceLineage'],
    ...(record.sourceRevision === null ? {} : { sourceRevision: record.sourceRevision }),
    requesterId: record.requesterId,
    approverId: record.approverId,
    objectiveSnapshot: JSON.parse(record.objectiveSnapshotJson) as PromotionProposalV1['objectiveSnapshot'],
    status: record.status,
    revision: record.revision,
    authorizationToken,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface PromotionModesServiceDependencies {
  readonly teamId: string;
  readonly unitOfWork: TaskCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly issueAuthorizationToken: (input: {
    readonly proposalId: string;
    readonly revision: number;
    readonly approverId: string;
    readonly expiresAt: number;
  }) => string;
  /** Server-side Human review authority；不得由 proposal payload 自报。 */
  readonly canApproveProposal: (input: {
    readonly teamId: string;
    readonly userId: string;
  }) => Promise<boolean>;
  /** Targeted Offer 必须冻结当前 active Agent Exposure manifest revision。 */
  readonly resolveActiveManifestRevision: (input: {
    readonly teamId: string;
    readonly agentId: string;
    readonly now: number;
  }) => Promise<number | null>;
  readonly targetedOfferTtlMs?: number;
}

export function createPromotionModesService(dependencies: PromotionModesServiceDependencies) {
  const { teamId, unitOfWork, clock, ids } = dependencies;

  async function evaluateSemantic(input: {
    readonly channelId: string;
    readonly requesterId: string;
    readonly approverId: string;
    readonly exclusion?: SemanticPromotionExclusion;
    readonly evaluation?: SemanticPromotionEvaluationV1;
    readonly evaluatorFailed?: boolean;
    readonly proposalTtlMs?: number;
    /** Agent 越界升级的安全强制路径；不受可观测性 rollout 开关影响。 */
    readonly forceProposal?: boolean;
  }) {
    return unitOfWork.run(async (repos) => {
      const rolloutState = await repos.promotion.semanticRollout.get(teamId);
      const rollout = input.forceProposal ? 'proposal-only' : (rolloutState?.mode ?? 'off');
      const path = evaluateSemanticPromotionPath({
        rollout,
        ...(input.exclusion ? { exclusion: input.exclusion } : {}),
        ...(input.evaluation ? { evaluation: input.evaluation } : {}),
        ...(input.evaluatorFailed ? { evaluatorFailed: true } : {}),
      });
      if (path.kind === 'not-evaluated') return { path };
      const source = input.evaluation?.sourceLineage;
      const key = source ? lineageKey(teamId, source) : `${teamId}:evaluation-unavailable:${ids.nextId()}`;
      const now = clock.now();
      await repos.promotion.evaluations.create({
        id: ids.nextId(),
        teamId,
        channelId: input.channelId,
        sourceLineageKey: key,
        rollout,
        pathKind: path.kind,
        evaluationJson: input.evaluation ? JSON.stringify(input.evaluation) : null,
        createdAt: now,
      });
      if (path.kind !== 'show-proposal') return { path };

      if (path.evaluation.sourceLineage.kind !== 'message') {
        return { path, stableCode: 'SEMANTIC_PROPOSAL_MESSAGE_SOURCE_REQUIRED' };
      }
      const sourceMessage = await repos.messages.getById(path.evaluation.sourceLineage.id);
      if (!sourceMessage || sourceMessage.teamId !== teamId || sourceMessage.channelId !== input.channelId
        || sourceMessage.senderKind !== 'human' || sourceMessage.senderId !== input.requesterId) {
        return { path, stableCode: 'SEMANTIC_PROPOSAL_SOURCE_SCOPE_MISMATCH' };
      }
      if (!await dependencies.canApproveProposal({ teamId, userId: input.approverId })) {
        return { path, stableCode: 'SEMANTIC_PROPOSAL_APPROVER_NOT_AUTHORIZED' };
      }

      const existing = await repos.promotion.proposals.getOpenBySourceLineageKey(key);
      if (existing) {
        const token = dependencies.issueAuthorizationToken({
          proposalId: existing.id,
          revision: existing.revision,
          approverId: existing.approverId,
          expiresAt: existing.expiresAt,
        });
        if (hash(token) !== existing.authorizationTokenHash) {
          return { path, stableCode: 'SEMANTIC_PROPOSAL_TOKEN_UNAVAILABLE' };
        }
        return {
          path,
          proposal: proposalView(existing, token),
          disposition: 'existing' as const,
        };
      }

      const proposalId = ids.nextId();
      const expiresAt = now + (input.proposalTtlMs ?? 24 * 60 * 60 * 1_000);
      const token = dependencies.issueAuthorizationToken({
        proposalId,
        revision: 1,
        approverId: input.approverId,
        expiresAt,
      });
      const proposal: PromotionProposalRecord = {
        id: proposalId,
        teamId,
        channelId: input.channelId,
        sourceLineageKey: key,
        sourceLineageJson: JSON.stringify(path.evaluation.sourceLineage),
        sourceRevision: path.evaluation.sourceRevision ?? null,
        requesterId: input.requesterId,
        approverId: input.approverId,
        objectiveSnapshotJson: JSON.stringify(path.evaluation.objectiveSnapshot),
        status: 'open',
        revision: 1,
        authorizationTokenHash: hash(token),
        expiresAt,
        rootTaskId: null,
        managementRunId: null,
        createdAt: now,
        updatedAt: now,
      };
      await repos.promotion.proposals.create(proposal);
      return {
        path,
        proposal: proposalView(proposal, token),
        disposition: 'created' as const,
      };
    });
  }

  async function actOnProposal(input: {
    readonly actorId?: string;
    readonly systemActor?: boolean;
    readonly action: PromotionProposalActionV1;
  }) {
    const authoritySubject = input.systemActor ? 'system' : (input.actorId ?? '');
    const commandHash = hash(JSON.stringify(input.action));
    const replay = await unitOfWork.run(async (repos) =>
      repos.promotion.proposals.getActionReceiptByIdempotencyKey(input.action.idempotencyKey));
    if (replay) {
      if (replay.authoritySubject !== authoritySubject) {
        return { outcome: 'rejected' as const, stableCode: 'PROPOSAL_AUTHORITY_MISMATCH' };
      }
      if (replay.commandHash !== commandHash) {
        return { outcome: 'conflict' as const, stableCode: 'PROPOSAL_IDEMPOTENCY_CONFLICT' };
      }
      return JSON.parse(replay.resultJson) as {
        readonly outcome: 'applied' | 'no_op';
        readonly stableCode: string;
        readonly rootTaskId?: string;
        readonly managementRunId?: string;
      };
    }

    const proposal = await unitOfWork.run(async (repos) =>
      repos.promotion.proposals.getById(input.action.proposalId));
    if (!proposal || proposal.teamId !== teamId) {
      return { outcome: 'rejected' as const, stableCode: 'PROPOSAL_NOT_FOUND' };
    }
    if ((input.action.action === 'accept' || input.action.action === 'reject')
      && (!input.actorId || !await dependencies.canApproveProposal({ teamId, userId: input.actorId }))) {
      return { outcome: 'rejected' as const, stableCode: 'PROPOSAL_APPROVER_NOT_AUTHORIZED' };
    }
    const now = clock.now();
    const decision = evaluatePromotionProposalTransition({
      proposal: proposalView(proposal, input.action.authorizationToken),
      action: input.action.action,
      expectedRevision: input.action.expectedRevision,
      ...(input.actorId ? { actorId: input.actorId } : {}),
      tokenMatches: hash(input.action.authorizationToken) === proposal.authorizationTokenHash,
      now,
      ...(input.systemActor ? { systemActor: true } : {}),
    });
    if (decision.kind === 'rejected' || decision.kind === 'conflict') {
      return {
        outcome: decision.kind,
        stableCode: decision.reason.toUpperCase().replace(/-/g, '_'),
      };
    }
    if (decision.kind === 'no-op') {
      return {
        outcome: 'no_op' as const,
        stableCode: 'PROPOSAL_ACTION_ALREADY_APPLIED',
        ...(proposal.rootTaskId ? { rootTaskId: proposal.rootTaskId } : {}),
        ...(proposal.managementRunId ? { managementRunId: proposal.managementRunId } : {}),
      };
    }

    if (input.action.action !== 'accept') {
      return unitOfWork.run(async (repos) => {
        const updated = await repos.promotion.proposals.updateStatus({
          proposalId: proposal.id,
          expectedRevision: proposal.revision,
          status: decision.nextStatus,
          updatedAt: now,
        });
        if (!updated) return { outcome: 'conflict' as const, stableCode: 'PROPOSAL_REVISION_CHANGED' };
        const result = { outcome: 'applied' as const, stableCode: `PROPOSAL_${decision.nextStatus.toUpperCase()}` };
        await createProposalActionReceipt(repos.promotion.proposals, {
          ids,
          proposalId: proposal.id,
          action: input.action,
          commandHash,
          authoritySubject,
          result,
          now,
        });
        return result;
      });
    }

    let acceptedResult: { rootTaskId: string; managementRunId: string } | undefined;
    const finishAccept = async (context: PromotionSuccessContext) => {
      const updated = await context.repositories.promotion.proposals.updateStatus({
        proposalId: proposal.id,
        expectedRevision: proposal.revision,
        status: 'accepted',
        rootTaskId: context.rootTaskId,
        managementRunId: context.managementRunId,
        updatedAt: context.now,
      });
      if (!updated) throw new Error('PROPOSAL_REVISION_CHANGED');
      acceptedResult = { rootTaskId: context.rootTaskId, managementRunId: context.managementRunId };
      await createProposalActionReceipt(context.repositories.promotion.proposals, {
        ids,
        proposalId: proposal.id,
        action: input.action,
        commandHash,
        authoritySubject,
        result: {
          outcome: 'applied',
          stableCode: 'PROPOSAL_ACCEPTED',
          rootTaskId: context.rootTaskId,
          managementRunId: context.managementRunId,
        },
        now: context.now,
      });
    };
    const handler = createPromotionGateHandler({
      teamId,
      requesterId: proposal.requesterId,
      unitOfWork,
      clock,
      ids,
      trustedTriggerKinds: ['proposal-accept'],
      onAppliedInTransaction: finishAccept,
      onConvergedInTransaction: finishAccept,
    });
    let response;
    try {
      response = await handler.promoteToTask({
      schemaVersion: 1,
      commandName: 'promote-to-task',
      commandSchemaVersion: 1,
      idempotencyKey: `proposal-accept:${proposal.id}:${input.action.idempotencyKey}`,
    }, {
      triggerKind: 'proposal-accept',
      channelId: proposal.channelId,
      objectiveSnapshot: JSON.parse(proposal.objectiveSnapshotJson) as PromotionProposalV1['objectiveSnapshot'],
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: JSON.parse(proposal.sourceLineageJson) as PromotionProposalV1['sourceLineage'],
        ...(proposal.sourceRevision === null ? {} : { sourceRevision: proposal.sourceRevision }),
      },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'PROPOSAL_REVISION_CHANGED') {
        return { outcome: 'conflict' as const, stableCode: 'PROPOSAL_REVISION_CHANGED' };
      }
      throw error;
    }
    if (response.outcome !== 'applied' && response.outcome !== 'replayed') {
      return { outcome: response.outcome, stableCode: response.stableCode };
    }
    return {
      outcome: 'applied' as const,
      stableCode: 'PROPOSAL_ACCEPTED',
      rootTaskId: acceptedResult?.rootTaskId ?? response.result?.rootTaskId,
      managementRunId: acceptedResult?.managementRunId ?? response.result?.managementRunId,
    };
  }

  async function upsertTeamPolicy(policy: TeamPromotionPolicyV1) {
    if (policy.teamId !== teamId) throw new Error('TEAM_PROMOTION_POLICY_SCOPE_MISMATCH');
    const result = await unitOfWork.run(async (repos) => repos.promotion.teamPolicy.upsert(policy));
    if (!result) throw new Error('TEAM_PROMOTION_POLICY_REVISION_CONFLICT');
    return result;
  }

  async function upsertSemanticRollout(state: SemanticPromotionRolloutStateV1) {
    if (state.teamId !== teamId) throw new Error('SEMANTIC_PROMOTION_ROLLOUT_SCOPE_MISMATCH');
    const result = await unitOfWork.run(async (repos) => repos.promotion.semanticRollout.upsert(state));
    if (!result) throw new Error('SEMANTIC_PROMOTION_ROLLOUT_REVISION_CONFLICT');
    return result;
  }

  async function applyTeamPolicy(input: {
    readonly requesterId: string;
    readonly channelId: string;
    readonly rootMessageId?: string;
    readonly ruleId: string;
    readonly orchestrationNeed: boolean;
    readonly exclusion?: SemanticPromotionExclusion;
    readonly objectiveSnapshot: PromotionProposalV1['objectiveSnapshot'];
    readonly freshnessBasis: PromotionFreshnessBasisV1;
    readonly idempotencyKey: string;
    readonly revalidateAdditionalAuthorityInTransaction?: (context: PromotionSuccessContext) => Promise<void>;
    readonly onAppliedInTransaction?: (context: PromotionSuccessContext) => Promise<void>;
    readonly onConvergedInTransaction?: (context: PromotionSuccessContext) => Promise<void>;
  }) {
    const policy = await unitOfWork.run(async (repos) => repos.promotion.teamPolicy.get(teamId));
    if (!policy) return { outcome: 'rejected' as const, stableCode: 'TEAM_PROMOTION_POLICY_NOT_FOUND' };
    const decision = evaluateTeamPromotionPolicy({
      policy,
      ruleId: input.ruleId,
      orchestrationNeed: input.orchestrationNeed,
      ...(input.exclusion ? { exclusion: input.exclusion } : {}),
    });
    if (decision.kind !== 'direct-promotion') {
      return { outcome: 'rejected' as const, stableCode: decision.reason.toUpperCase().replace(/-/g, '_') };
    }
    if (input.freshnessBasis.sourceLineage.kind !== 'message') {
      return { outcome: 'rejected' as const, stableCode: 'TEAM_POLICY_MESSAGE_SOURCE_REQUIRED' };
    }
    const sourceMessage = await unitOfWork.run(async (repos) =>
      repos.messages.getById(input.freshnessBasis.sourceLineage.id));
    if (!sourceMessage || sourceMessage.teamId !== teamId || sourceMessage.channelId !== input.channelId
      || sourceMessage.senderKind !== 'human' || sourceMessage.senderId !== input.requesterId) {
      return { outcome: 'rejected' as const, stableCode: 'TEAM_POLICY_SOURCE_SCOPE_MISMATCH' };
    }
    const revalidatePolicy = async (context: PromotionSuccessContext) => {
      const current = await context.repositories.promotion.teamPolicy.get(teamId);
      const currentDecision = current && current.revision === policy.revision
        ? evaluateTeamPromotionPolicy({
            policy: current,
            ruleId: input.ruleId,
            orchestrationNeed: input.orchestrationNeed,
            ...(input.exclusion ? { exclusion: input.exclusion } : {}),
          })
        : null;
      if (currentDecision?.kind !== 'direct-promotion') {
        throw new Error('TEAM_PROMOTION_POLICY_FRESHNESS_CONFLICT');
      }
    };
    const onApplied = async (context: PromotionSuccessContext) => {
      await revalidatePolicy(context);
      await input.revalidateAdditionalAuthorityInTransaction?.(context);
      await input.onAppliedInTransaction?.(context);
    };
    const onConverged = async (context: PromotionSuccessContext) => {
      await revalidatePolicy(context);
      await input.revalidateAdditionalAuthorityInTransaction?.(context);
      await input.onConvergedInTransaction?.(context);
    };
    try {
      return await createPromotionGateHandler({
      teamId,
      requesterId: input.requesterId,
      unitOfWork,
      clock,
      ids,
      trustedTriggerKinds: ['team-policy'],
      onAppliedInTransaction: onApplied,
      onConvergedInTransaction: onConverged,
      }).promoteToTask({
      schemaVersion: 1,
      commandName: 'promote-to-task',
      commandSchemaVersion: 1,
      idempotencyKey: `team-policy:${policy.revision}:${input.idempotencyKey}`,
    }, {
      triggerKind: 'team-policy',
      channelId: input.channelId,
      ...(input.rootMessageId ? { rootMessageId: input.rootMessageId } : {}),
      objectiveSnapshot: input.objectiveSnapshot,
      freshnessBasis: input.freshnessBasis,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'TEAM_PROMOTION_POLICY_FRESHNESS_CONFLICT') {
        return { outcome: 'conflict' as const, stableCode: error.message };
      }
      throw error;
    }
  }

  async function escalateAgent(input: {
    readonly escalation: AgentOrchestrationEscalationV1;
    readonly idempotencyKey: string;
    readonly approverId: string;
  }) {
    const simple = input.escalation.simpleRequest;
    if (simple && simple.targetAgentId !== input.escalation.agentId) {
      return { outcome: 'rejected' as const, stableCode: 'SIMPLE_REQUEST_TARGET_MISMATCH' };
    }
    const dispatch = simple
      ? await unitOfWork.run(async (repos) => repos.dispatches.getById(simple.dispatchId))
      : null;
    const decision = evaluateAgentOrchestrationEscalation({
      escalation: input.escalation,
      ...(dispatch ? { responsibleAgentId: dispatch.agentId } : {}),
    });
    if (decision.kind === 'rejected') {
      return { outcome: 'rejected' as const, stableCode: decision.reason.toUpperCase().replace(/-/g, '_') };
    }
    if (decision.kind === 'proposal-required') {
      const evaluation: SemanticPromotionEvaluationV1 = {
        schemaVersion: 1,
        sourceLineage: input.escalation.freshnessBasis.sourceLineage,
        ...(input.escalation.freshnessBasis.sourceRevision === undefined
          ? {}
          : { sourceRevision: input.escalation.freshnessBasis.sourceRevision }),
        verdict: 'proposal',
        objectiveSnapshot: input.escalation.objectiveSnapshot,
        rationaleCode: 'AGENT_ESCALATION_EXPANDS_AUTHORIZATION',
      };
      return evaluateSemantic({
        channelId: input.escalation.channelId,
        requesterId: dispatch?.messageId
          ? await resolveRequesterId(unitOfWork, dispatch.messageId)
          : input.approverId,
        approverId: input.approverId,
        evaluation,
        forceProposal: true,
      });
    }
    if (!simple || !dispatch) {
      return { outcome: 'rejected' as const, stableCode: 'SIMPLE_REQUEST_REQUIRED' };
    }
    const sourceMessage = await unitOfWork.run(async (repos) => repos.messages.getById(simple.messageId));
    if (!sourceMessage || sourceMessage.id !== dispatch.messageId || sourceMessage.teamId !== teamId
      || sourceMessage.channelId !== input.escalation.channelId
      || sourceMessage.senderKind !== 'human') {
      return { outcome: 'rejected' as const, stableCode: 'SIMPLE_REQUEST_SCOPE_MISMATCH' };
    }
    const applyHandoff = async (context: PromotionSuccessContext) => {
      const current = await context.repositories.dispatches.getById(simple.dispatchId);
      if (!current || current.messageId !== simple.messageId || current.agentId !== input.escalation.agentId
        || !['queued', 'sent', 'accepted', 'running'].includes(current.status)) {
        throw new Error('SIMPLE_REQUEST_EXECUTION_RIGHT_NOT_CURRENT');
      }
      const cancelled = await context.repositories.dispatches.markCancelled({
        dispatchId: current.id,
        completedAt: context.now,
      });
      if (!cancelled?.changed) throw new Error('SIMPLE_REQUEST_FENCE_CONFLICT');
      const invocationAttempt = await context.repositories.management.dispatchAttempts
        .getByDispatchId(current.id);
      if (invocationAttempt && ['queued', 'sent', 'accepted', 'running'].includes(invocationAttempt.status)) {
        await context.repositories.management.dispatchAttempts.update({
          ...invocationAttempt,
          status: 'cancelled',
          completedAt: context.now,
        });
      }
      const task = await context.repositories.tasks.getById(context.rootTaskId);
      const coordination = await context.repositories.coordination.coordinations
        .getByTaskId(context.rootTaskId);
      if (!task || !coordination) throw new Error('PROMOTION_ROOT_COORDINATION_NOT_FOUND');
      const offerManifestRevision = await dependencies.resolveActiveManifestRevision({
        teamId,
        agentId: input.escalation.agentId,
        now: context.now,
      });
      if (offerManifestRevision === null) throw new Error('TARGET_AGENT_MANIFEST_NOT_ACTIVE');
      const offerId = ids.nextId();
      const offerTtlMs = dependencies.targetedOfferTtlMs ?? 5 * 60 * 1_000;
      await context.repositories.coordination.offers.create({
        id: offerId,
        teamId,
        taskId: context.rootTaskId,
        agentId: input.escalation.agentId,
        taskRevision: task.revision,
        taskAttempt: coordination.attempt,
        manifestRevision: offerManifestRevision,
        objective: {
          objective: input.escalation.objectiveSnapshot.objective,
          inputs: [],
          deliverables: [],
          constraints: ['original-mention-target-agent'],
          riskLevel: input.escalation.objectiveSnapshot.riskLevel === 'low' ? 'low' : 'high',
          requiredCapabilities: [...coordination.requiredCapabilities],
          requiredSkills: [...(coordination.requiredSkills ?? [])],
          preferredSkills: [...(coordination.preferredSkills ?? [])],
        },
        offerTtlMs,
        offerExpiresAt: context.now + offerTtlMs,
        hardSpecified: true,
        requirementConfirmation: false,
        status: 'open',
        response: null,
        createdAt: context.now,
        updatedAt: context.now,
      });
      await context.repositories.promotion.handoffs.create({
        id: ids.nextId(),
        teamId,
        sourceMessageId: simple.messageId,
        sourceDispatchId: simple.dispatchId,
        targetAgentId: input.escalation.agentId,
        rootTaskId: context.rootTaskId,
        managementRunId: context.managementRunId,
        status: 'applied',
        targetedOfferRequired: true,
        targetedOfferId: offerId,
        materialJson: JSON.stringify({
          kind: 'unaccepted-handoff-material',
          dispatchId: current.id,
          ...(invocationAttempt ? { invocationId: invocationAttempt.invocationId } : {}),
          statusBeforeFence: current.status,
          promptHash: hash(current.prompt),
        }),
        createdAt: context.now,
      });
    };
    let response;
    try {
      response = await createPromotionGateHandler({
      teamId,
      requesterId: sourceMessage.senderId,
      unitOfWork,
      clock,
      ids,
      trustedTriggerKinds: ['agent-escalation'],
      onAppliedInTransaction: applyHandoff,
      onConvergedInTransaction: applyHandoff,
      }).promoteToTask({
      schemaVersion: 1,
      commandName: 'promote-to-task',
      commandSchemaVersion: 1,
      idempotencyKey: `agent-escalation:${input.idempotencyKey}`,
    }, {
      triggerKind: 'agent-escalation',
      channelId: input.escalation.channelId,
      rootMessageId: simple.messageId,
      objectiveSnapshot: input.escalation.objectiveSnapshot,
      freshnessBasis: input.escalation.freshnessBasis,
      });
    } catch (error) {
      const stableCode = error instanceof Error ? error.message : '';
      if (stableCode === 'TARGET_AGENT_MANIFEST_NOT_ACTIVE') {
        return { outcome: 'rejected' as const, stableCode };
      }
      if (stableCode === 'SIMPLE_REQUEST_EXECUTION_RIGHT_NOT_CURRENT'
        || stableCode === 'SIMPLE_REQUEST_FENCE_CONFLICT'
        || stableCode.startsWith('PROMOTION_UNIQUE:')) {
        return { outcome: 'conflict' as const, stableCode: stableCode.startsWith('PROMOTION_UNIQUE:')
          ? 'SIMPLE_REQUEST_HANDOFF_CONFLICT'
          : stableCode };
      }
      throw error;
    }
    return response;
  }

  return {
    evaluateSemantic,
    actOnProposal,
    upsertSemanticRollout,
    upsertTeamPolicy,
    applyTeamPolicy,
    escalateAgent,
  };
}

async function resolveRequesterId(unitOfWork: TaskCoordinationUnitOfWork, messageId: string): Promise<string> {
  return unitOfWork.run(async (repos) => {
    const message = await repos.messages.getById(messageId);
    return message?.senderKind === 'human' ? message.senderId : '';
  });
}

async function createProposalActionReceipt(
  repository: {
    createActionReceipt(input: PromotionProposalActionReceiptRecord): Promise<PromotionProposalActionReceiptRecord>;
  },
  input: {
    readonly ids: { nextId(): string };
    readonly proposalId: string;
    readonly action: PromotionProposalActionV1;
    readonly commandHash: string;
    readonly authoritySubject: string;
    readonly result: unknown;
    readonly now: number;
  },
): Promise<void> {
  await repository.createActionReceipt({
    id: input.ids.nextId(),
    proposalId: input.proposalId,
    authoritySubject: input.authoritySubject,
    idempotencyKey: input.action.idempotencyKey,
    action: input.action.action,
    commandHash: input.commandHash,
    outcome: 'applied',
    resultJson: JSON.stringify(input.result),
    createdAt: input.now,
  });
}
