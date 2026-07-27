import { evaluateProjectStageAdvance } from '@agentbean/domain';
import type { TaskClaimBroker } from './management/task-claim-broker.js';
import { resolveProjectStageExecutionGate } from './project-stage-execution-gate.js';
import { resolveProjectStageStableInputs } from './project-stage-advance-service.js';
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
  readonly emitTaskOffers: (taskId: string) => Promise<void>;
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
        const eligibleAgentIds = resolution.candidates
          .filter((candidate) => candidate.eligible)
          .map((candidate) => candidate.agentId);
        const claim = await input.repositories.taskCoordination.claimLeases.getCurrent({
          taskId: task.id,
          taskRevision: task.revision,
          taskAttempt: coordination.attempt,
        });
        const activeInvocation = (await input.repositories.management.invocations
          .listByRun(coordination.managementRunId))
          .some((invocation) => invocation.intent.taskContext?.taskId === task.id
            && invocation.intent.taskContext.taskRevision === task.revision);
        const activeOffer = (await input.repositories.taskCoordination.offers.listByTask(task.id))
          .find((offer) => offer.taskRevision === task.revision
            && offer.taskAttempt === coordination.attempt
            && offer.status === 'open'
            && offer.offerExpiresAt > input.now());
        if (activeOffer) {
          outcomes.push({
            taskId: task.id,
            kind: 'offered',
            targetAgentIds: [activeOffer.agentId],
          });
          continue;
        }
        const decision = evaluateProjectStageAdvance({
          channelWritable: channel.archivedAt == null,
          piHealthy,
          autoCoordinationEnabled: policy.autoCoordinationEnabled,
          taskStatus: task.status,
          taskRevision: task.revision,
          stageTaskRevision: stage.taskRevision,
          coordinationTaskRevision: coordination.taskRevision,
          claimStatus: claim
            ? claim.status === 'active' && claim.expiresAt > input.now() ? 'active' : 'stale'
            : 'none',
          ...(claim ? { claimedAgentId: claim.agentId } : {}),
          invocationStatus: activeInvocation ? 'active' : 'none',
          executionGateAllowed: !gate.blocked,
          requiredInputCount: stable.requiredRuleCount,
          stableInputCount: stable.satisfiedRuleKeys.length,
          stableInputFenceCurrent: true,
          eligibleAgentIds,
        });
        if (decision.kind === 'publish_offer') {
          await input.emitTaskOffers(task.id);
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
