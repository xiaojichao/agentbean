import { evaluateProjectStageAdvance } from '../../../../packages/domain/src/index.js';
import type {
  ProjectStageClaimGranted,
  TaskClaimBroker,
} from './management/task-claim-broker.js';
import { resolveProjectStageExecutionGate } from './project-stage-execution-gate.js';
import {
  filterStrictProjectStageAgentIds,
  hasActiveProjectStageInvocation,
  resolveProjectStageStableInputs,
} from './project-stage-advance-service.js';
import type { ServerNextRepositories } from './repositories.js';

export interface ProjectStageAutoAdvanceOutcome {
  readonly taskId: string;
  readonly kind: 'waiting' | 'suggest' | 'offered' | 'claimed';
  readonly reason?: string;
  readonly targetAgentIds: readonly string[];
}

/**
 * 事件驱动的 #829 自动推进器。
 *
 * 它只负责“是否发 Offer”；Agent 的明确接受、Claim 与 Invocation 继续走既有公开协议。
 * 因而在 Agent 接受前不会写 active owner，也不会直接创建 Invocation。
 */
export function createProjectStageAutoAdvance(input: {
  readonly repositories: ServerNextRepositories;
  readonly broker: TaskClaimBroker;
  readonly piHealthy: () => Promise<boolean>;
  readonly emitTaskOffers: (
    taskId: string,
    options: { readonly allowedAgentIds: readonly string[]; readonly projectStageAuto: true },
  ) => Promise<void>;
  readonly invokeClaimedProjectStage: (claim: ProjectStageClaimGranted) => Promise<void>;
  readonly now: () => number;
}) {
  return {
    async advanceChannel(scope: {
      teamId: string;
      channelId: string;
    }): Promise<readonly ProjectStageAutoAdvanceOutcome[]> {
      const channel = await input.repositories.channels.getById(scope.channelId);
      if (!channel || channel.teamId !== scope.teamId) return [];
      const [policy, piHealthy, stages, edges] = await Promise.all([
        input.repositories.teamPiPolicy.getOrDefault(scope.teamId),
        input.piHealthy(),
        input.repositories.channelProjects.listStages(scope),
        input.repositories.channelProjects.listEdges(scope),
      ]);
      const outcomes: ProjectStageAutoAdvanceOutcome[] = [];
      for (const stage of stages) {
        if (!edges.some((edge) => edge.downstreamStageId === stage.id)) continue;
        const task = await input.repositories.tasks.getById(stage.taskId);
        const coordination = await input.repositories.taskCoordination.coordinations
          .getByTaskId(stage.taskId);
        if (!task || !coordination || task.teamId !== scope.teamId
          || task.channelId !== scope.channelId) continue;
        const gate = await resolveProjectStageExecutionGate(input.repositories, task);
        const stable = await resolveProjectStageStableInputs(input.repositories, task);
        const resolution = await input.broker.resolveCandidates(task.id);
        const brokerEligibleAgentIds = resolution.candidates
          .filter((candidate) => candidate.eligible)
          .map((candidate) => candidate.agentId);
        const eligibleAgentIds = await filterStrictProjectStageAgentIds(input.repositories, {
          teamId: task.teamId,
          candidateAgentIds: brokerEligibleAgentIds,
          requiredCapabilities: coordination.requiredCapabilities,
          ...(stable.inputs.some((item) => item.kind === 'document_revision')
            ? { requiredProjectDocumentInputSetVersion: 1 }
            : {}),
          now: input.now(),
        });
        const claim = await input.repositories.taskCoordination.claimLeases.getCurrent({
          taskId: task.id,
          taskRevision: task.revision,
          taskAttempt: coordination.attempt,
        });
        const activeInvocation = await hasActiveProjectStageInvocation(
          input.repositories,
          task,
          coordination,
        );
        const projectStageFence = stable.stageId
          ? `agentbean:project-stage-fence:${JSON.stringify({
            stageId: stable.stageId,
            inputs: stable.inputs,
          })}`
          : null;
        const taskOffers = await input.repositories.taskCoordination.offers.listByTask(task.id);
        const acceptedClaimOffer = claim
          ? taskOffers.find((offer) =>
            offer.taskRevision === task.revision
            && offer.taskAttempt === coordination.attempt
            && offer.agentId === claim.agentId
            && offer.status === 'accepted'
            && offer.response?.kind === 'accepted'
            && offer.response.respondedAt === claim.acquiredAt
            && offer.objective.constraints.includes('agentbean:project-stage-auto'))
          : undefined;
        const claimInputFenceCurrent = !claim || (
          projectStageFence !== null
          && acceptedClaimOffer?.objective.inputs.includes(projectStageFence) === true
        );
        const activeOffers = taskOffers
          .filter((offer) => offer.taskRevision === task.revision
            && offer.taskAttempt === coordination.attempt
            && offer.status === 'open'
            && offer.offerExpiresAt > input.now()
            && offer.objective.constraints.includes('agentbean:project-stage-auto'));
        const decision = evaluateProjectStageAdvance({
          channelWritable: channel.archivedAt == null,
          piHealthy,
          autoCoordinationEnabled: policy.autoCoordinationEnabled,
          taskStatus: task.status,
          taskRevision: task.revision,
          stageTaskRevision: stage.taskRevision,
          coordinationTaskRevision: coordination.taskRevision,
          claimStatus: claim
            ? claim.status === 'active' && claim.expiresAt > input.now() && claimInputFenceCurrent
              ? 'active'
              : 'stale'
            : 'none',
          ...(claim ? { claimedAgentId: claim.agentId } : {}),
          invocationStatus: activeInvocation ? 'active' : 'none',
          executionGateAllowed: !gate.blocked,
          requiredInputCount: stable.requiredRuleCount,
          stableInputCount: stable.satisfiedRuleKeys.length,
          stableInputFenceCurrent: true,
          eligibleAgentIds,
        });
        if (activeOffers.length > 0) {
          const activeAgentIds = activeOffers.map((offer) => offer.agentId).sort();
          const expectedAgentIds = decision.kind === 'publish_offer'
            ? [...decision.targetAgentIds].sort()
            : [];
          const fencesCurrent = projectStageFence !== null && activeOffers.every((offer) =>
            offer.objective.inputs.includes(projectStageFence));
          if (fencesCurrent
            && JSON.stringify(activeAgentIds) === JSON.stringify(expectedAgentIds)) {
            outcomes.push({
              taskId: task.id,
              kind: 'offered',
              targetAgentIds: activeAgentIds,
            });
            continue;
          }
          await Promise.all(activeOffers.map((offer) =>
            input.repositories.taskCoordination.offers.updateStatus({
              id: offer.id,
              expectedStatus: 'open',
              status: 'invalidated',
              response: null,
              now: input.now(),
            })));
        }
        if (decision.kind === 'publish_offer') {
          await input.emitTaskOffers(task.id, {
            allowedAgentIds: decision.targetAgentIds,
            projectStageAuto: true,
          });
          outcomes.push({
            taskId: task.id,
            kind: 'offered',
            targetAgentIds: decision.targetAgentIds,
          });
        } else if (decision.kind === 'suggest') {
          outcomes.push({
            taskId: task.id,
            kind: 'suggest',
            targetAgentIds: decision.targetAgentIds,
          });
        } else if (decision.kind === 'create_invocation') {
          if (!claim) throw new Error('PROJECT_STAGE_ACTIVE_CLAIM_MISSING');
          await input.invokeClaimedProjectStage({
            managementRunId: coordination.managementRunId,
            taskId: task.id,
            taskRevision: task.revision,
            taskAttempt: coordination.attempt,
            claimLeaseId: claim.id,
            targetAgentId: decision.targetAgentId,
            objective: task.description ?? task.title,
          });
          outcomes.push({
            taskId: task.id,
            kind: 'claimed',
            targetAgentIds: [decision.targetAgentId],
          });
        } else {
          outcomes.push({
            taskId: task.id,
            kind: 'waiting',
            reason: decision.reason,
            targetAgentIds: [],
          });
        }
      }
      return outcomes;
    },
  };
}
