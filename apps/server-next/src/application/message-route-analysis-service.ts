import { classifyDeterministicMessageRoute } from '../../../../packages/domain/src/index.js';
import type { ChannelCoordinationUnitOfWork } from './channel-coordination-unit-of-work.js';
import type { MessageRouteAnalysisRecord, MessageRouteKind } from './message-tracer-repositories.js';

export interface MessageRoutePiProposal {
  readonly routeKind: MessageRouteKind;
  readonly riskLevel: 'low' | 'high';
  readonly targetAgentIds: readonly string[];
  readonly requiredCapabilityIds: readonly string[];
  readonly subtasks?: readonly {
    readonly title: string;
    readonly objective: string;
    readonly targetAgentId: string;
    readonly requiredCapabilityIds: readonly string[];
    readonly acceptanceCriteria: readonly string[];
    /** Zero-based indexes into this proposal's subtask list; only earlier nodes are valid. */
    readonly dependsOnSubtaskIndexes?: readonly number[];
  }[];
  readonly diagnosticCode?: string;
}

export interface MessageRouteAnalysisServiceDependencies {
  readonly unitOfWork: ChannelCoordinationUnitOfWork;
  readonly clock: { now(): number };
  readonly retryDelayMs?: number;
  readonly processingLeaseMs?: number;
  /** PI adapter 只返回 proposal；Server 在本服务中校验 target scope/risk 后才授权。 */
  readonly analyzeWithPi?: (input: {
    readonly analysis: MessageRouteAnalysisRecord;
    readonly body: string;
    readonly channelAgentIds: readonly string[];
  }) => Promise<MessageRoutePiProposal | { readonly unavailable: true; readonly diagnosticCode: string }>;
  /** 唯一 promotion/dispatch seam；返回已建立的 root/direct Task id。 */
  readonly applyAuthorizedRoute?: (input: {
    readonly analysis: MessageRouteAnalysisRecord;
    readonly senderId: string;
    readonly body: string;
    readonly routeKind: Exclude<MessageRouteKind, 'chat_only' | 'clarification'>;
    readonly riskLevel: 'low';
    readonly targetAgentIds: readonly string[];
    readonly requiredCapabilityIds: readonly string[];
    readonly subtasks: NonNullable<MessageRoutePiProposal['subtasks']>;
    readonly intentSource: 'pi' | 'deterministic_fallback';
  }) => Promise<{ readonly linkedTaskId: string }>;
}

/** 可恢复 consumer：Message 提交成功与 PI/Promotion 成败解耦，失败保留 deferred 后重试。 */
export function createMessageRouteAnalysisService(deps: MessageRouteAnalysisServiceDependencies) {
  const retryDelayMs = deps.retryDelayMs ?? 30_000;
  const processingLeaseMs = deps.processingLeaseMs ?? 30_000;
  let analyzeWithPi = deps.analyzeWithPi;

  async function processPending(limit = 20): Promise<MessageRouteAnalysisRecord[]> {
    const now = deps.clock.now();
    const runnable = await deps.unitOfWork.run((tx) => tx.routes.listRunnable({
      now,
      runningBefore: now - processingLeaseMs,
      limit,
    }));
    const results: MessageRouteAnalysisRecord[] = [];
    for (const candidate of runnable) {
      const claimed = await deps.unitOfWork.run((tx) => tx.routes.claimForProcessing({
        id: candidate.id,
        now: deps.clock.now(),
        runningBefore: deps.clock.now() - processingLeaseMs,
      }));
      if (!claimed) continue;
      results.push(await processClaimed(claimed));
    }
    return results;
  }

  async function processClaimed(analysis: MessageRouteAnalysisRecord): Promise<MessageRouteAnalysisRecord> {
    const context = await deps.unitOfWork.run(async (tx) => ({
      message: await tx.messages.getById(analysis.messageId),
      channel: await tx.channels.getById(analysis.channelId),
    }));
    if (!context.message || !context.channel
      || context.message.teamId !== analysis.teamId
      || context.channel.teamId !== analysis.teamId
      || context.channel.archivedAt != null) {
      return update(analysis, {
        status: 'failed', diagnosticCode: 'MESSAGE_ROUTE_SOURCE_INVALID',
      });
    }

    const fallback = classifyDeterministicMessageRoute({
      body: context.message.body,
      channelAgentIds: context.channel.agentMemberIds,
    });
    if (fallback.kind === 'low_risk_collective') {
      return applyRoute(analysis, context.message.senderId, context.message.body, {
        routeKind: 'collaboration',
        riskLevel: 'low',
        targetAgentIds: fallback.targetAgentIds,
        requiredCapabilityIds: [],
      }, 'deterministic_fallback');
    }

    if (!analyzeWithPi) {
      return update(analysis, {
        status: 'deferred',
        nextRetryAt: deps.clock.now() + retryDelayMs,
        diagnosticCode: 'PI_ROUTE_ANALYZER_UNAVAILABLE',
      });
    }
    const proposal = await analyzeWithPi({
      analysis,
      body: context.message.body,
      channelAgentIds: [...context.channel.agentMemberIds].sort(),
    });
    if ('unavailable' in proposal) {
      return update(analysis, {
        status: 'deferred',
        nextRetryAt: deps.clock.now() + retryDelayMs,
        diagnosticCode: proposal.diagnosticCode,
      });
    }
    const allowedTargets = new Set(context.channel.agentMemberIds);
    if (proposal.targetAgentIds.some((agentId) => !allowedTargets.has(agentId))) {
      return update(analysis, { status: 'failed', diagnosticCode: 'PI_ROUTE_TARGET_OUT_OF_SCOPE' });
    }
    if (proposal.routeKind === 'chat_only' || proposal.routeKind === 'clarification') {
      return update(analysis, {
        status: 'resolved', routeKind: proposal.routeKind, intentSource: 'pi',
        riskLevel: proposal.riskLevel, targetAgentIds: proposal.targetAgentIds,
        requiredCapabilityIds: proposal.requiredCapabilityIds,
        diagnosticCode: proposal.diagnosticCode ?? null,
      });
    }
    if (proposal.riskLevel !== 'low') {
      return update(analysis, {
        status: 'resolved', routeKind: 'clarification', intentSource: 'pi', riskLevel: 'high',
        diagnosticCode: 'PI_ROUTE_HIGH_RISK_REQUIRES_HUMAN',
      });
    }
    return applyRoute(analysis, context.message.senderId, context.message.body, proposal, 'pi');
  }

  async function applyRoute(
    analysis: MessageRouteAnalysisRecord,
    senderId: string,
    body: string,
    route: MessageRoutePiProposal,
    intentSource: 'pi' | 'deterministic_fallback',
  ): Promise<MessageRouteAnalysisRecord> {
    if (!deps.applyAuthorizedRoute || route.riskLevel !== 'low'
      || route.routeKind === 'chat_only' || route.routeKind === 'clarification') {
      return update(analysis, {
        status: 'deferred', nextRetryAt: deps.clock.now() + retryDelayMs,
        diagnosticCode: 'MESSAGE_ROUTE_APPLIER_UNAVAILABLE',
      });
    }
    try {
      const applied = await deps.applyAuthorizedRoute({
        analysis, senderId, body, routeKind: route.routeKind, riskLevel: 'low',
        targetAgentIds: route.targetAgentIds,
        requiredCapabilityIds: route.requiredCapabilityIds,
        subtasks: route.subtasks ?? [],
        intentSource,
      });
      return update(analysis, {
        status: 'resolved', routeKind: route.routeKind, intentSource, riskLevel: 'low',
        targetAgentIds: route.targetAgentIds, requiredCapabilityIds: route.requiredCapabilityIds,
        linkedTaskId: applied.linkedTaskId, diagnosticCode: null,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'MESSAGE_ROUTE_HIGH_RISK_REQUIRES_HUMAN') {
        return update(analysis, {
          status: 'resolved', routeKind: 'clarification', intentSource, riskLevel: 'high',
          diagnosticCode: error.message,
        });
      }
      return update(analysis, {
        status: 'deferred', nextRetryAt: deps.clock.now() + retryDelayMs,
        diagnosticCode: error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : 'MESSAGE_ROUTE_APPLY_FAILED',
      });
    }
  }

  async function update(
    analysis: MessageRouteAnalysisRecord,
    patch: Partial<Omit<MessageRouteAnalysisRecord, 'id' | 'teamId' | 'channelId' | 'messageId' | 'messageRevision' | 'attempt' | 'createdAt' | 'updatedAt'>>,
  ): Promise<MessageRouteAnalysisRecord> {
    const updated = await deps.unitOfWork.run((tx) => tx.routes.update({
      id: analysis.id,
      expectedStatus: 'running',
      status: patch.status ?? analysis.status,
      nextRetryAt: patch.nextRetryAt ?? null,
      routeKind: patch.routeKind ?? null,
      intentSource: patch.intentSource ?? null,
      riskLevel: patch.riskLevel ?? null,
      targetAgentIds: patch.targetAgentIds ?? [],
      requiredCapabilityIds: patch.requiredCapabilityIds ?? [],
      linkedTaskId: patch.linkedTaskId ?? null,
      diagnosticCode: patch.diagnosticCode ?? null,
      now: deps.clock.now(),
    }));
    if (!updated) throw new Error('MESSAGE_ROUTE_STATE_CONFLICT');
    return updated;
  }

  return {
    processPending,
    bindPiAnalyzer(handler: NonNullable<MessageRouteAnalysisServiceDependencies['analyzeWithPi']>) {
      analyzeWithPi = handler;
    },
  };
}

export type MessageRouteAnalysisService = ReturnType<typeof createMessageRouteAnalysisService>;
