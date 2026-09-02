import { assessCoordinationRisk } from '../../../../packages/domain/src/index.js';
import { createChannelCollaborationPromotionHooks } from './channel-collaboration-task-handler.js';
import type { AgentExposureService } from './agent-exposure-service.js';
import {
  createMessageRouteAnalysisService,
  type MessageRouteAnalysisServiceDependencies,
} from './message-route-analysis-service.js';
import { createPromotionGateHandler } from './promotion-gate-handler.js';
import type { createPromotionModesService } from './promotion-modes-service.js';
import type { ServerNextRepositories } from './repositories.js';

export type ChannelWorkIntakePiAnalyzer = NonNullable<
  MessageRouteAnalysisServiceDependencies['analyzeWithPi']
>;

export interface ChannelWorkIntake {
  /** Message commit 已完成；异步绑定 authority epoch 并唤醒 durable intake consumer。 */
  wakeAfterMessageCommitted(input: {
    readonly teamId: string;
    readonly messageId: string;
    readonly clientMessageId: string | null;
  }): void;
  /** 由 Server host tick 恢复 deferred / lease-expired intake。 */
  processPending(limit?: number): ReturnType<
    ReturnType<typeof createMessageRouteAnalysisService>['processPending']
  >;
}

export interface CreateChannelWorkIntakeInput {
  readonly repositories: Pick<
    ServerNextRepositories,
    'agents' | 'channelCoordinationUnitOfWork' | 'taskCoordination' | 'taskCoordinationUnitOfWork'
  >;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly getCapabilityDirectory: AgentExposureService['getCapabilityDirectory'];
  readonly promotionModesForTeam: (
    teamId: string,
  ) => ReturnType<typeof createPromotionModesService>;
  readonly analyzeWithPi?: ChannelWorkIntakePiAnalyzer;
  readonly isDeviceRuntimeDisconnected?: (deviceId: string) => boolean;
  readonly onTasksPublished?: (
    taskIds: readonly string[],
  ) => Promise<{ readonly offered: number }>;
  readonly bindMessageAuthorityEpoch: (input: {
    readonly teamId: string;
    readonly messageId: string;
    readonly clientMessageId: string | null;
  }) => Promise<void>;
  readonly assertPiCommandsAllowed: (teamId: string) => Promise<void>;
  readonly assertMessageRouteAuthorityCurrent: (
    teamId: string,
    messageId: string,
  ) => Promise<void>;
}

/**
 * Channel Work Intake 的唯一 in-process module。
 *
 * Message delivery 只负责提交 Message/Inbox/route analysis；本 module 从已提交
 * analysis 开始，统一完成 intent analysis、Server authority、Promotion gate、
 * replay fence 与 Offer wake，不把这些顺序约束泄漏给 usecases composition root。
 */
export function createChannelWorkIntake(
  input: CreateChannelWorkIntakeInput,
): ChannelWorkIntake {
  const { repositories, clock, ids } = input;
  const routeAnalysis = createMessageRouteAnalysisService({
    unitOfWork: repositories.channelCoordinationUnitOfWork,
    clock,
    ...(input.analyzeWithPi ? { analyzeWithPi: input.analyzeWithPi } : {}),
    async applyAuthorizedRoute(route) {
      const candidates = [];
      for (const agentId of route.targetAgentIds) {
        const agent = await repositories.agents.getById(agentId);
        if (!agent) throw new Error('MESSAGE_ROUTE_AGENT_NOT_FOUND');
        candidates.push({ agentId, agentName: agent.name });
      }

      const riskObjective = [
        route.body,
        ...route.requiredCapabilityIds,
        ...route.subtasks.flatMap((subtask) => [
          subtask.title,
          subtask.objective,
          ...subtask.requiredCapabilityIds,
        ]),
      ].join('\n');
      if (assessCoordinationRisk({ modelRisk: route.riskLevel, objective: riskObjective }) !== 'low') {
        throw new Error('MESSAGE_ROUTE_HIGH_RISK_REQUIRES_HUMAN');
      }

      const directoryResult = await input.getCapabilityDirectory({
        teamId: route.analysis.teamId,
        channelId: route.analysis.channelId,
      });
      if (!directoryResult.ok) throw new Error('MESSAGE_ROUTE_CAPABILITY_DIRECTORY_UNAVAILABLE');
      const directoryByAgent = new Map(
        directoryResult.directory.entries.map((entry) => [entry.agentId, entry]),
      );
      const targetDeviceIds: string[] = [];
      for (const targetAgentId of route.targetAgentIds) {
        const directoryEntry = directoryByAgent.get(targetAgentId);
        if (!directoryEntry) throw new Error('MESSAGE_ROUTE_TARGET_NOT_FOUND');
        if (!directoryEntry.available) throw new Error('MESSAGE_ROUTE_TARGET_UNAVAILABLE');
        const targetAgent = await repositories.agents.getById(targetAgentId);
        if (!targetAgent?.deviceId) throw new Error('MESSAGE_ROUTE_TARGET_UNAVAILABLE');
        targetDeviceIds.push(targetAgent.deviceId);
      }

      if (route.intentSource === 'pi' && route.subtasks.length === 0) {
        throw new Error('MESSAGE_ROUTE_SUBTASKS_REQUIRED');
      }
      const subtasks = route.intentSource === 'pi'
        ? route.subtasks.map((subtask) => {
            const directoryEntry = directoryByAgent.get(subtask.targetAgentId);
            if (!directoryEntry) throw new Error('MESSAGE_ROUTE_SUBTASK_TARGET_NOT_FOUND');
            const capabilityNameById = new Map(directoryEntry.capabilities.map((capability) => [
              capability.registry.capabilityId,
              capability.name,
            ]));
            const requiredCapabilities = subtask.requiredCapabilityIds.map((capabilityId) => {
              const name = capabilityNameById.get(capabilityId);
              if (!name) throw new Error('MESSAGE_ROUTE_SUBTASK_CAPABILITY_NOT_FOUND');
              return name;
            });
            return {
              title: subtask.title,
              objective: subtask.objective,
              targetAgentId: subtask.targetAgentId,
              requiredCapabilities,
              acceptanceCriteria: subtask.acceptanceCriteria,
              dependsOnSubtaskIndexes: subtask.dependsOnSubtaskIndexes ?? [],
            };
          })
        : undefined;
      const hooks = createChannelCollaborationPromotionHooks({
        requesterId: route.senderId,
        objective: route.body.trim(),
        candidates,
        ...(subtasks ? { subtasks } : {}),
        ids,
      });
      const objectiveSnapshot = {
        schemaVersion: 1 as const,
        objective: route.body.trim(),
        scope: `channel:${route.analysis.channelId}:agents:${route.targetAgentIds.join(',')}`,
        riskLevel: 'low' as const,
      };
      const freshnessBasis = {
        schemaVersion: 1 as const,
        sourceLineage: {
          kind: 'message' as const,
          id: route.analysis.messageId,
          revision: route.analysis.messageRevision,
        },
      };
      const revalidateTargetRuntimeConnection = () => {
        if (targetDeviceIds.some(
          (deviceId) => input.isDeviceRuntimeDisconnected?.(deviceId) === true,
        )) {
          throw new Error('MESSAGE_ROUTE_TARGET_UNAVAILABLE');
        }
      };

      let promotion;
      if (route.intentSource === 'pi') {
        await input.assertPiCommandsAllowed(route.analysis.teamId);
        await input.assertMessageRouteAuthorityCurrent(
          route.analysis.teamId,
          route.analysis.messageId,
        );
        const configuredRollout = await repositories.taskCoordinationUnitOfWork.run(
          (tx) => tx.promotion.semanticRollout.get(route.analysis.teamId),
        );
        if (configuredRollout) {
          throw new Error('MESSAGE_ROUTE_SEMANTIC_ROLLOUT_REQUIRES_REVIEW');
        }
        promotion = await input.promotionModesForTeam(route.analysis.teamId).applyTeamPolicy({
          requesterId: route.senderId,
          channelId: route.analysis.channelId,
          rootMessageId: route.analysis.messageId,
          ruleId: 'pi-message-route-v1',
          orchestrationNeed: true,
          objectiveSnapshot,
          freshnessBasis,
          idempotencyKey: `message-route:${route.analysis.id}`,
          revalidateAdditionalAuthorityInTransaction: async (context) => {
            const currentRollout = await context.repositories.promotion.semanticRollout
              .get(route.analysis.teamId);
            if (currentRollout) {
              throw new Error('MESSAGE_ROUTE_SEMANTIC_ROLLOUT_FRESHNESS_CONFLICT');
            }
            revalidateTargetRuntimeConnection();
          },
          onAppliedInTransaction: hooks.onAppliedInTransaction,
          onConvergedInTransaction: hooks.onConvergedInTransaction,
        });
      } else {
        promotion = await createPromotionGateHandler({
          teamId: route.analysis.teamId,
          requesterId: route.senderId,
          unitOfWork: repositories.taskCoordinationUnitOfWork,
          clock,
          ids,
          onAppliedInTransaction: async (context) => {
            revalidateTargetRuntimeConnection();
            await hooks.onAppliedInTransaction(context);
          },
          onConvergedInTransaction: async (context) => {
            revalidateTargetRuntimeConnection();
            await hooks.onConvergedInTransaction(context);
          },
        }).promoteToTask({
          schemaVersion: 1,
          commandName: 'promote-to-task',
          commandSchemaVersion: 1,
          idempotencyKey: `message-route:${route.analysis.id}`,
          causationRef: {
            kind: 'message',
            id: route.analysis.messageId,
            revision: route.analysis.messageRevision,
          },
        }, {
          triggerKind: 'human-structured',
          channelId: route.analysis.channelId,
          rootMessageId: route.analysis.messageId,
          objectiveSnapshot,
          freshnessBasis,
        });
      }

      if (promotion.outcome !== 'applied' && promotion.outcome !== 'replayed') {
        throw new Error(promotion.stableCode);
      }
      const promotionResult = 'result' in promotion ? promotion.result : undefined;
      let projected = hooks.getResult();
      if (!projected && promotionResult?.rootTaskId && promotionResult.managementRunId) {
        const coordinations = await repositories.taskCoordination.coordinations
          .listByManagementRun(promotionResult.managementRunId);
        projected = {
          rootTaskId: promotionResult.rootTaskId,
          managementRunId: promotionResult.managementRunId,
          subtaskIds: coordinations
            .filter((coordination) => coordination.nodeKind === 'subtask'
              && coordination.parentTaskId === promotionResult.rootTaskId)
            .map((coordination) => coordination.taskId)
            .sort(),
        };
      }
      if (!projected) throw new Error('MESSAGE_ROUTE_PROMOTION_NOT_APPLIED');

      // Exact-idempotency receipt replay 会在 Promotion hooks 之前返回；任何 Offer 发布前
      // 再读一次实时连接 fence，覆盖 crash/retry 后的 replay 路径。
      revalidateTargetRuntimeConnection();
      if (projected.subtaskIds.length > 0) {
        if (!input.onTasksPublished) {
          throw new Error('MESSAGE_ROUTE_OFFER_PUBLICATION_UNAVAILABLE');
        }
        await input.onTasksPublished(projected.subtaskIds);
      }
      return { linkedTaskId: projected.rootTaskId };
    },
  });

  return {
    processPending: routeAnalysis.processPending,
    wakeAfterMessageCommitted(message) {
      // Message ACK 只依赖持久化提交；PI、Promotion 与 Offer 留给 durable consumer。
      void input.bindMessageAuthorityEpoch(message)
        .then(() => routeAnalysis.processPending(1))
        .catch(() => undefined);
    },
  };
}
