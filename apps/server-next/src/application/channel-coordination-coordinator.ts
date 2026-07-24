/**
 * Server Channel Coordinator（#706 / 切片 A）。
 *
 * 异步消费 Channel Coordination Job：用 Job pins 的 Active PI Model 调用模型，
 * 对一条人类频道消息产出六种协调 Decision，并在服务端重新执行权限、风险与频道状态门禁；
 * 只有 applied 的低风险动作才会创建 Task，suggested/blocked 只保留审计与必要说明。
 *
 * 故障原则（AC#1/AC#5/AC#6）：
 * - 不依赖用户 Device 在线，无本地文件/Shell/Workspace/Device-Memory 能力，只调模型 adapter。
 * - 模型 timeout/401/429/5xx/非法 JSON/非法输出 只影响 Job/Decision 状态；原消息始终展示。
 * - 重试耗尽或模型不可用 → failed Decision，不发系统消息、不建 Task/Offer/Claim/Memory、不回落 direct。
 * 幂等（AC#7）：Job 已有 Decision 或已终态 → 跳过；decisions.job_id UNIQUE 是硬兜底。
 */

import {
  createOpenAiCompatibleManagementModelAdapter,
  ManagementModelAdapterError,
  type ManagementModelRequest,
  type ManagementModelResponse,
} from '@agentbean/pi-management-runtime';
import {
  COORDINATION_DIAGNOSTIC,
  COORDINATION_GATE_REASON,
  DEFAULT_COORDINATION_BASE_DELAY_MS,
  DEFAULT_MAX_COORDINATION_ATTEMPTS,
  PI_COORDINATION_SIDE_EFFECT_INTENTS,
  PI_COORDINATION_SYSTEM_PROMPT,
  PI_COORDINATION_SYSTEM_SENDER_ID,
  type CoordinationErrorKind,
  type CoordinationGateVerdict,
  type CoordinationParseResult,
  type PiCoordinationIntent,
  assessCoordinationRisk,
  evaluateCoordinationGate,
  parseCoordinationResponse,
  planCoordinationRetry,
  resolveTaskFollowupBinding,
} from '../../../../packages/domain/src/index.js';
import type {
  ActiveMemoryAttributionDto,
  AgentStatus,
  ChannelCoordinationDecisionRecord,
  ChannelCoordinationDecisionUsage,
  ChannelCoordinationGateStatus,
  ChannelCoordinationJobRecord,
  CoordinationSystemMessageAction,
  CoordinationSystemMessageMeta,
  ID,
  MessageMetaDto,
} from '../../../../packages/contracts/src/index.js';
import type {
  ChannelCoordinationDecisionRepository,
  ChannelCoordinationJobRepository,
  ChannelCoordinationUnitOfWork,
} from './channel-coordination-unit-of-work.js';
import type {
  AgentRepository,
  ChannelRepository,
  MessageRepository,
  TeamPiPolicyRepository,
  TeamRepository,
} from './repositories.js';
import type { ActiveMemoryContextResolver } from './active-memory-context-resolver.js';

/** PI Provider 解析目标的最小依赖（仅 resolveInvocationTarget，避免引入完整服务类型）。 */
export interface CoordinatorModelResolver {
  resolveInvocationTarget(input: {
    readonly cardId: ID;
    readonly revisionId: ID;
  }): Promise<
    | {
        readonly kind: 'available';
        readonly config: {
          readonly baseUrl: string;
          readonly modelId: string;
          readonly timeoutMs: number;
          readonly maxOutputTokens: number;
        };
        readonly apiKey: string;
        readonly modelId: string;
      }
    | { readonly kind: 'unavailable'; readonly diagnosticCode: string }
  >;
}

export interface ChannelCoordinatorDependencies {
  readonly jobs: ChannelCoordinationJobRepository;
  readonly decisions: ChannelCoordinationDecisionRepository;
  readonly unitOfWork: ChannelCoordinationUnitOfWork;
  readonly messages: MessageRepository;
  readonly channels: ChannelRepository;
  readonly teams: TeamRepository;
  readonly agents: AgentRepository;
  readonly teamPolicy: TeamPiPolicyRepository;
  readonly modelResolver: CoordinatorModelResolver;
  /** #720 Active Memory Context 解析器（AC#8 共享接缝）。 */
  readonly memoryContextResolver: ActiveMemoryContextResolver;
  readonly clock: { now(): number };
  readonly ids: { nextId(): string };
  readonly fetch?: typeof fetch;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly processingTimeoutMs?: number;
}

export type CoordinationJobOutcome =
  | { readonly kind: 'not_found' }
  | { readonly kind: 'already_decided'; readonly decision: ChannelCoordinationDecisionRecord }
  | { readonly kind: 'terminal'; readonly status: ChannelCoordinationJobRecord['status'] }
  | { readonly kind: 'resolved'; readonly decision: ChannelCoordinationDecisionRecord }
  | { readonly kind: 'failed'; readonly decision: ChannelCoordinationDecisionRecord }
  | { readonly kind: 'retry_wait'; readonly nextRetryAt: number }
  | { readonly kind: 'not_runnable'; readonly status: ChannelCoordinationJobRecord['status'] };

export interface CoordinationCycleSummary {
  readonly processed: number;
  readonly outcomes: readonly CoordinationJobOutcome[];
}

// Adapter 仅做单次无状态 respond；sessionContext 不被读取，仅满足类型（与 pi-provider-production-test 同模式）。
const EMPTY_SESSION_CONTEXT = {
  schemaVersion: 1 as const,
  mode: 'managed' as const,
  scope: {
    kind: 'managed' as const,
    managementRunId: 'pi-coordinator',
    teamId: 'system',
    channelId: 'system',
    rootMessageId: 'coordinator',
  },
  visibleMessages: [],
  visibleCheckpoint: { revision: 0, lastEventSequence: 0, objective: 'coordinator', planSummary: 'coordinator' },
};

export function createChannelCoordinator(deps: ChannelCoordinatorDependencies) {
  const fetchFn = deps.fetch ?? fetch;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_COORDINATION_ATTEMPTS;
  const baseDelayMs = deps.baseDelayMs ?? DEFAULT_COORDINATION_BASE_DELAY_MS;
  // Provider timeout 最高允许 10 分钟；lease 必须更长，避免合法慢调用被其他 worker 重领。
  const processingTimeoutMs = deps.processingTimeoutMs ?? 11 * 60_000;

  function buildRequest(humanMessageBody: string, memorySection: string): ManagementModelRequest {
    const systemPrompt = memorySection
      ? `${PI_COORDINATION_SYSTEM_PROMPT}\n\n${memorySection}`
      : PI_COORDINATION_SYSTEM_PROMPT;
    return {
      systemPrompt,
      sessionContext: EMPTY_SESSION_CONTEXT as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: humanMessageBody }] }],
      tools: [],
    };
  }

  /** 合并二次检索（agent_request projection）的 attribution 到初始 attribution（AC#4）。 */
  function mergeAttribution(
    base: ActiveMemoryAttributionDto | null,
    extra: ActiveMemoryAttributionDto,
  ): ActiveMemoryAttributionDto | null {
    if (extra.entries.length === 0) return base;
    if (!base) return extra;
    const seen = new Set(base.entries.map((entry) => `${entry.source}:${entry.id}`));
    const entries = [...base.entries];
    for (const entry of extra.entries) {
      const key = `${entry.source}:${entry.id}`;
      if (!seen.has(key)) {
        entries.push(entry);
        seen.add(key);
      }
    }
    return { schemaVersion: 1, entries, contextHash: base.contextHash };
  }

  function mapAdapterError(error: unknown): CoordinationErrorKind {
    if (error instanceof ManagementModelAdapterError) {
      switch (error.code) {
        case 'MANAGEMENT_MODEL_AUTHENTICATION_FAILED':
          return 'auth';
        case 'MANAGEMENT_MODEL_TIMEOUT':
          return 'timeout';
        case 'MANAGEMENT_MODEL_RATE_LIMITED':
          return 'rate_limit';
        case 'MANAGEMENT_MODEL_SERVER_FAILED':
          return 'server';
        case 'MANAGEMENT_MODEL_NETWORK_FAILED':
          return 'network';
        case 'MANAGEMENT_MODEL_RESPONSE_INVALID':
          return 'invalid_output';
        case 'MANAGEMENT_MODEL_RESPONSE_INVALID_JSON':
          return 'invalid_json';
        case 'MANAGEMENT_MODEL_TOOL_CALL_INVALID':
          return 'invalid_output';
        case 'MANAGEMENT_MODEL_ABORTED':
          return 'aborted';
        case 'MANAGEMENT_MODEL_RESPONSE_REJECTED':
          return 'rejected';
        case 'MANAGEMENT_MODEL_REQUEST_INVALID':
          return 'request_invalid';
        default:
          return 'unknown';
      }
    }
    return 'unknown';
  }

  function errorKindForInvalidParse(result: Extract<CoordinationParseResult, { kind: 'invalid' }>): CoordinationErrorKind {
    return result.code === COORDINATION_DIAGNOSTIC.MODEL_INVALID_JSON ? 'invalid_json' : 'invalid_output';
  }

  function toUsage(inputTokens: number | null, outputTokens: number | null): ChannelCoordinationDecisionUsage {
    return { inputTokens, outputTokens };
  }

  /** 硬目标判定（AC#6）：显式 @Agent / 明确作为任务。 */
  function computeExplicitTarget(meta: MessageMetaDto | undefined): boolean {
    if (meta?.asTask === true) return true;
    return Boolean(meta?.mentions?.some((mention) => mention.kind === 'agent'));
  }

  /** 把模型给的 targetAgentName 解析为已 @提及 的 agentId（若匹配）。 */
  function resolveTargetAgentId(
    parsed: Extract<CoordinationParseResult, { kind: 'resolved' }>,
    meta: MessageMetaDto | undefined,
  ): ID | null {
    if (parsed.intent !== 'agent_request') return null;
    const agentMentions = meta?.mentions?.filter((mention) => mention.kind === 'agent') ?? [];
    const match = parsed.targetAgentName
      ? agentMentions.find((mention) => mention.name === parsed.targetAgentName)
      : agentMentions.length === 1 ? agentMentions[0] : undefined;
    return match?.id ?? null;
  }

  /** 目标 Agent 上下文：agent_request 不可见/不可用/无法确认三分的判定输入（AC#5）。 */
  interface CoordinationTargetContext {
    readonly agentId: ID | null;
    readonly name: string | null;
    readonly status: AgentStatus | null;
    readonly needsScopedTarget: boolean;
    readonly scopeValid: boolean;
  }

  /** 目标异常分类（统一 body/action 判别，AC#5 三分）。null = 无目标异常。 */
  type TargetAnomaly = 'out_of_scope' | 'unavailable' | 'unresolvable';

  /** 视为「不可用」的状态：PI 在消息中请求用户决定，但不阻止硬目标建 Task（约束 3）。 */
  function isAgentUnavailable(status: AgentStatus | null): boolean {
    return status === 'offline' || status === 'connecting' || status === 'error';
  }

  /** 把目标上下文分类为单一异常种类（agent_request 专属；其余意图返回 null）。 */
  function classifyTargetAnomaly(
    target: CoordinationTargetContext | null,
    intent: PiCoordinationIntent,
  ): TargetAnomaly | null {
    if (intent !== 'agent_request' || !target) return null;
    if (target.agentId === null && target.needsScopedTarget) return 'unresolvable';
    if (target.agentId !== null && !target.scopeValid) return 'out_of_scope';
    if (isAgentUnavailable(target.status)) return 'unavailable';
    return null;
  }

  /** 依据意图 + 门禁裁决 + 目标异常组装面向 Team 的系统协调消息正文（null = 不发消息）。 */
  function coordinationSystemMessageBody(
    parsed: Extract<CoordinationParseResult, { kind: 'resolved' }>,
    verdict: CoordinationGateVerdict,
    target: CoordinationTargetContext | null,
  ): string | null {
    const objective = parsed.objective ?? '';
    const name = target?.name ?? '未指定';
    const anomaly = classifyTargetAnomaly(target, parsed.intent);
    // 归档/无权限：不发系统消息（无面向用户的内容可说）。
    if (
      verdict.status === 'blocked' &&
      (verdict.reason === COORDINATION_GATE_REASON.CHANNEL_ARCHIVED ||
        verdict.reason === COORDINATION_GATE_REASON.SENDER_NOT_AUTHORIZED)
    ) {
      return null;
    }
    if (verdict.status === 'blocked') {
      // 目标异常都请求用户决定（AC#5）：无法确认 → 指定；不在作用域 → 加入/改派/取消。
      if (anomaly === 'unresolvable') {
        return `无法确认目标 Agent「${name}」，已拦截：${objective}。请指定目标 Agent 或取消。`;
      }
      if (anomaly === 'out_of_scope') {
        return `目标 Agent「${name}」不在当前频道或作用域，已拦截：${objective}。请将其加入频道、改派或取消。`;
      }
      // 高风险等其他 blocked。
      return `已拦截（需确认或目标已失效）：${objective}`;
    }
    switch (parsed.intent) {
      case 'system_reply':
      case 'clarification_required':
        return parsed.text;
      case 'no_action':
        return null;
    }
    if (verdict.status === 'suggested') return `PI 建议（自动协调未开启，需确认后执行）：${objective}`;
    switch (parsed.intent) {
      case 'tracked_task':
        return `已创建跟踪任务：${objective}`;
      case 'task_followup':
        return `已记录任务跟进：${objective}`;
      case 'agent_request':
        // 目标不可用 → applied 仍建 Task，但消息请求用户决定（等待/改派/取消），不静默改派。
        if (anomaly === 'unavailable') {
          return `目标 Agent「${name}」当前不可用，已创建请求任务。你可等待其上线、改派或取消。`;
        }
        return `已记录 Agent 请求：${objective}`;
      default:
        return null;
    }
  }

  /** 把门禁裁决 + 目标异常映射为可操作场景（AC#5），供 web 渲染决策点；null = 普通通知。 */
  function pickCoordinationAction(
    parsed: Extract<CoordinationParseResult, { kind: 'resolved' }>,
    verdict: CoordinationGateVerdict,
    target: CoordinationTargetContext | null,
  ): CoordinationSystemMessageAction | null {
    const anomaly = classifyTargetAnomaly(target, parsed.intent);
    if (verdict.status === 'suggested') return 'confirm_suggested';
    if (verdict.status === 'blocked') {
      // 目标异常（不可见/无法确认）→ 请求用户指定有效目标（AC#5）。
      if (anomaly === 'unresolvable' || anomaly === 'out_of_scope') return 'specify_target';
      return 'confirm_high_risk';
    }
    if (anomaly === 'unavailable') return 'confirm_offline_target';
    return null;
  }

  /**
   * #709 收集线程内可解析的 Task id（meta.taskId + coordination 系统消息的 meta.coordination.taskId），
   * 去重，按时序最早在前。强绑定证据的统一来源（Task 讨论串 / 回复 Task 系统消息 / 明确引用）。
   */
  function collectThreadTaskIds(messages: readonly { readonly meta?: MessageMetaDto }[]): ID[] {
    const ids: ID[] = [];
    const seen = new Set<ID>();
    for (const message of messages) {
      const meta = message.meta as Record<string, unknown> | undefined;
      const coordination = meta?.coordination as Record<string, unknown> | undefined;
      for (const candidate of [meta?.taskId, coordination?.taskId]) {
        if (typeof candidate === 'string' && !seen.has(candidate)) {
          seen.add(candidate);
          ids.push(candidate);
        }
      }
    }
    return ids;
  }

  /** 应用门禁裁决：applied 执行副作用（建 Task/系统消息），suggested/blocked 仅发说明消息，不执行副作用。 */
  async function finalizeGateDecision(
    job: ChannelCoordinationJobRecord,
    attempt: number,
    parsed: Extract<CoordinationParseResult, { kind: 'resolved' }>,
    verdict: CoordinationGateVerdict,
    usage: ChannelCoordinationDecisionUsage,
    responseModel: string | null,
    ctx: {
      readonly threadId: ID;
      readonly senderId: ID;
      readonly targetAgentId: ID | null;
      readonly targetAgentName: string | null;
      readonly targetStatus: AgentStatus | null;
      readonly needsScopedTarget: boolean;
      readonly targetScopeValid: boolean;
      readonly riskLevel: ChannelCoordinationDecisionRecord['riskLevel'];
      readonly gateStatus: ChannelCoordinationGateStatus;
      readonly memoryAttribution: ActiveMemoryAttributionDto | null;
    },
    now: number,
  ): Promise<CoordinationJobOutcome> {
    const decisionId = deps.ids.nextId();
    const isSideEffect = PI_COORDINATION_SIDE_EFFECT_INTENTS.has(parsed.intent);
    return deps.unitOfWork.run(async (transaction) => {
      let linkedTaskId: ID | null = null;
      // #709 task_followup 证据关联可覆盖门禁裁决（仅收紧 applied/suggested→blocked，从不放松）。
      let effectiveVerdict: CoordinationGateVerdict = verdict;
      let effectiveGateStatus: ChannelCoordinationGateStatus = ctx.gateStatus;
      let effectiveAction: CoordinationSystemMessageAction | null = null;
      let followupCandidateTaskIds: ID[] | null = null;

      // applied 副作用意图：tracked_task/agent_request 先建 Task 拿 linkedTaskId，
      // 使系统消息 meta 能携带 taskId（AC#4）。事务原子，重排不影响外部可观察状态。
      if (verdict.status === 'applied' && (parsed.intent === 'tracked_task' || parsed.intent === 'agent_request')) {
        const taskId = deps.ids.nextId();
        const task = await transaction.tasks.create({
          id: taskId,
          teamId: job.teamId,
          title: parsed.objective ?? job.messageId,
          status: 'todo',
          creatorId: ctx.senderId,
          channelId: job.channelId,
          tags: [],
          sortOrder: now,
          createdAt: now,
          updatedAt: now,
        });
        linkedTaskId = task.id;
        await transaction.messages.setTaskIdIfAbsent({ messageId: job.messageId, taskId: task.id });
      }

      // #709 task_followup 证据关联：用 resolveTaskFollowupBinding 判定强绑定/弱建议/需确认/无候选。
      // 仅在门禁未 blocked 时处理（服从高风险/归档/无权限硬门禁）；binding 只收紧、不放松。
      if (parsed.intent === 'task_followup' && verdict.status !== 'blocked') {
        const threadMessages = await transaction.messages.listByThread({
          channelId: job.channelId,
          threadId: ctx.threadId,
          limit: 50,
        });
        const threadTaskIds = collectThreadTaskIds(threadMessages);
        const channelActiveTasks = (await transaction.tasks.list({
          teamId: job.teamId,
          channelIds: [job.channelId],
          includeGlobal: false,
        }))
          .filter((task) => task.status !== 'done' && task.status !== 'closed')
          .map((task) => ({ taskId: task.id, objective: task.title }));
        const binding = resolveTaskFollowupBinding({
          threadTaskIds,
          channelActiveTasks,
          followupObjective: parsed.objective ?? '',
        });
        if (binding.kind === 'strong') {
          // AC1 强绑定：直接关联 + 标记上一有效 Decision superseded。
          linkedTaskId = binding.taskId;
          await transaction.messages.setTaskIdIfAbsent({ messageId: job.messageId, taskId: binding.taskId });
          await transaction.decisions.markSupersededByLinkedTask({
            taskId: binding.taskId,
            byDecisionId: decisionId,
            now,
          });
        } else if (binding.kind === 'suggested') {
          // AC2 弱建议（可撤销）：关联到唯一明显匹配，action 提示用户可撤销。
          linkedTaskId = binding.taskId;
          await transaction.messages.setTaskIdIfAbsent({ messageId: job.messageId, taskId: binding.taskId });
          effectiveAction = 'confirm_suggested';
        } else if (binding.kind === 'needs_confirmation') {
          // AC3 多候选/重大变化：强制 blocked，请求用户在候选中确认。
          effectiveVerdict = { status: 'blocked', reason: 'TASK_FOLLOWUP_NEEDS_CONFIRMATION' };
          effectiveGateStatus = 'blocked';
          followupCandidateTaskIds = [...binding.candidates];
        }
      }

      // 组装系统消息正文 + 可操作场景（目标三分：不可见/离线/无法确认, AC#5）。
      const targetCtx: CoordinationTargetContext = {
        agentId: ctx.targetAgentId,
        name: ctx.targetAgentName,
        status: ctx.targetStatus,
        needsScopedTarget: ctx.needsScopedTarget,
        scopeValid: ctx.targetScopeValid,
      };
      const messageBody = coordinationSystemMessageBody(parsed, effectiveVerdict, targetCtx);
      const action = effectiveAction ?? pickCoordinationAction(parsed, effectiveVerdict, targetCtx);

      // 构建完整 meta（含 taskId + 目标信息 + action）；绝不携带 provider/model 身份（AC#4）。
      const coordinationMeta: CoordinationSystemMessageMeta = {
        decisionId,
        jobId: job.id,
        intent: parsed.intent,
        gateStatus: effectiveGateStatus,
        taskId: linkedTaskId,
        riskLevel: ctx.riskLevel,
        targetAgentId: parsed.intent === 'agent_request' ? ctx.targetAgentId : null,
        targetAgentName: parsed.intent === 'agent_request' ? ctx.targetAgentName : null,
        targetStatus: parsed.intent === 'agent_request' ? ctx.targetStatus : null,
        action,
        followupCandidateTaskIds,
      };

      let systemMessageId: ID | null = null;
      if (messageBody) {
        const message = await transaction.messages.append({
          id: deps.ids.nextId(),
          teamId: job.teamId,
          channelId: job.channelId,
          threadId: ctx.threadId,
          senderKind: 'system',
          senderId: PI_COORDINATION_SYSTEM_SENDER_ID,
          body: messageBody,
          createdAt: now,
          meta: { coordination: coordinationMeta },
        });
        systemMessageId = message.id;
      }

      const decision: ChannelCoordinationDecisionRecord = {
        id: decisionId,
        jobId: job.id,
        teamId: job.teamId,
        channelId: job.channelId,
        messageId: job.messageId,
        outcome: 'resolved',
        intent: parsed.intent,
        reasonCode: parsed.reasonCode,
        replyText: parsed.intent === 'no_action' ? null : parsed.text,
        usage,
        pinnedModel: job.activeModel,
        responseModel,
        diagnosticCode: null,
        attempt,
        systemMessageId,
        gateStatus: effectiveGateStatus,
        riskLevel: ctx.riskLevel,
        objective: isSideEffect ? parsed.objective : null,
        targetAgentId: parsed.intent === 'agent_request' ? ctx.targetAgentId : null,
        linkedTaskId,
        blockingReason: effectiveVerdict.status === 'blocked' ? effectiveVerdict.reason : null,
        supersededByDecisionId: null,
        memoryAttribution: ctx.memoryAttribution,
        idempotencyKey: `decision:${job.id}`,
        createdAt: now,
        updatedAt: now,
      };
      await transaction.decisions.create(decision);
      await transaction.jobs.updateState({
        jobId: job.id,
        status: 'completed',
        attempt,
        nextRetryAt: null,
        updatedAt: now,
      });
      return { kind: 'resolved' as const, decision };
    });
  }

  async function finalizeFailed(
    job: ChannelCoordinationJobRecord,
    attempt: number,
    diagnosticCode: string,
    usage: ChannelCoordinationDecisionUsage,
    responseModel: string | null,
    now: number,
  ): Promise<CoordinationJobOutcome> {
    const decisionId = deps.ids.nextId();
    return deps.unitOfWork.run(async (transaction) => {
      const decision: ChannelCoordinationDecisionRecord = {
        id: decisionId,
        jobId: job.id,
        teamId: job.teamId,
        channelId: job.channelId,
        messageId: job.messageId,
        outcome: 'failed',
        intent: null,
        reasonCode: null,
        replyText: null,
        usage,
        pinnedModel: job.activeModel,
        responseModel,
        diagnosticCode,
        attempt,
        systemMessageId: null,
        gateStatus: null,
        riskLevel: null,
        objective: null,
        targetAgentId: null,
        linkedTaskId: null,
        blockingReason: null,
        supersededByDecisionId: null,
        // task 4 正式接入：resolved Decision 写真实 memoryAttribution；当前占位 null。
        memoryAttribution: null,
        idempotencyKey: `decision:${job.id}`,
        createdAt: now,
        updatedAt: now,
      };
      await transaction.decisions.create(decision);
      await transaction.jobs.updateState({
        jobId: job.id,
        status: 'failed',
        attempt,
        nextRetryAt: null,
        updatedAt: now,
      });
      return { kind: 'failed' as const, decision };
    });
  }

  /** 把瞬态/永久错误交给重试策略：retry → job retry_wait；fail → failed Decision（无系统消息）。 */
  async function handleUnrecoverable(
    job: ChannelCoordinationJobRecord,
    attempt: number,
    errorKind: CoordinationErrorKind,
    usage: ChannelCoordinationDecisionUsage,
    responseModel: string | null,
    now: number,
  ): Promise<CoordinationJobOutcome> {
    const retry = planCoordinationRetry({ attempt, errorKind, maxAttempts, baseDelayMs, now });
    if (retry.kind === 'retry') {
      await deps.jobs.updateState({
        jobId: job.id,
        status: 'retry_wait',
        attempt,
        nextRetryAt: retry.nextRetryAt,
        updatedAt: now,
      });
      return { kind: 'retry_wait', nextRetryAt: retry.nextRetryAt };
    }
    return finalizeFailed(job, attempt, retry.diagnosticCode, usage, responseModel, now);
  }

  async function processJob(jobId: ID, nowOverride?: number): Promise<CoordinationJobOutcome> {
    let job = await deps.jobs.getById(jobId);
    if (!job) return { kind: 'not_found' };

    // 幂等（AC#7）：已有 Decision 或 Job 已终态 → 跳过。
    const existing = await deps.decisions.getByJobId(jobId);
    if (existing) return { kind: 'already_decided', decision: existing };
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      return { kind: 'terminal', status: job.status };
    }

    const now = nowOverride ?? deps.clock.now();
    const humanMessage = await deps.messages.getById(job.messageId);
    if (!humanMessage) {
      await deps.jobs.updateState({
        jobId: job.id,
        status: 'failed',
        attempt: job.attempt,
        nextRetryAt: null,
        updatedAt: now,
      });
      return { kind: 'terminal', status: 'failed' };
    }

    // #720 Active Memory Context（AC#1/2/8）：buildRequest 前解析最小可见 memory，失败降级为空（不阻塞协调）。
    let memoryAttribution: ActiveMemoryAttributionDto | null = null;
    let memorySection = '';
    try {
      const memoryResult = await deps.memoryContextResolver.resolve({
        teamId: job.teamId,
        channelId: job.channelId,
        messageId: job.messageId,
        senderUserId: humanMessage.senderId,
        prompt: humanMessage.body,
        includeAgentProjections: false,
      });
      memorySection = memoryResult.renderedSection;
      memoryAttribution = memoryResult.attribution;
    } catch {
      memoryAttribution = null;
    }

    const claimed = await deps.jobs.claimForProcessing({
      jobId: job.id,
      now,
      runningBefore: now - processingTimeoutMs,
    });
    if (!claimed) {
      const decided = await deps.decisions.getByJobId(jobId);
      if (decided) return { kind: 'already_decided', decision: decided };
      const latest = await deps.jobs.getById(jobId);
      if (!latest) return { kind: 'not_found' };
      if (latest.status === 'completed' || latest.status === 'failed' || latest.status === 'cancelled') {
        return { kind: 'terminal', status: latest.status };
      }
      return { kind: 'not_runnable', status: latest.status };
    }
    job = claimed;
    const attempt = job.attempt;
    if (attempt > maxAttempts) {
      return finalizeFailed(
        job,
        attempt,
        COORDINATION_DIAGNOSTIC.MODEL_UNKNOWN,
        toUsage(null, null),
        null,
        now,
      );
    }

    // 解析 pinned Active PI Model（跨 Global DB）。
    if (job.activeModel.availability !== 'available') {
      return finalizeFailed(job, attempt, COORDINATION_DIAGNOSTIC.ACTIVE_MODEL_UNAVAILABLE, toUsage(null, null), null, now);
    }
    let target: Awaited<ReturnType<CoordinatorModelResolver['resolveInvocationTarget']>>;
    try {
      target = await deps.modelResolver.resolveInvocationTarget({
        cardId: job.activeModel.cardId,
        revisionId: job.activeModel.revisionId,
      });
    } catch {
      return handleUnrecoverable(job, attempt, 'unknown', toUsage(null, null), null, now);
    }
    if (target.kind === 'unavailable') {
      return finalizeFailed(job, attempt, target.diagnosticCode, toUsage(null, null), null, now);
    }

    // 调用模型（生产同路径 adapter）。
    let response: ManagementModelResponse;
    try {
      const adapter = createOpenAiCompatibleManagementModelAdapter({
        id: `pi-coordinator:${job.id}:${target.modelId}`,
        apiKey: target.apiKey,
        baseUrl: target.config.baseUrl,
        modelId: target.config.modelId,
        timeoutMs: target.config.timeoutMs,
        maxOutputTokens: target.config.maxOutputTokens,
        // 不强制 response metadata：usage 缺失 → null（unknown, AC#8）而非报错。
        fetch: fetchFn,
      });
      response = await adapter.respond(buildRequest(humanMessage.body, memorySection), { callCount: 1 });
    } catch (error) {
      return handleUnrecoverable(job, attempt, mapAdapterError(error), toUsage(null, null), null, now);
    }

    const usage = toUsage(response.usage.inputTokens, response.usage.outputTokens);
    const responseModel = response.responseModel || null;
    const parsed = parseCoordinationResponse({
      finishReason: response.finishReason,
      textContents: response.content
        .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
        .map((item) => item.text),
    });

    if (parsed.kind === 'invalid') {
      // 模型输出非法（非法 JSON/意图/缺文本）→ 当瞬态错误走重试策略（AC#2/AC#5）。
      return handleUnrecoverable(job, attempt, errorKindForInvalidParse(parsed), usage, responseModel, now);
    }

    // 服务端策略门禁（#707）：模型只提议(proposed)，此处重新校验风险/开关/显式目标/频道状态，裁决 applied/suggested/blocked。
    const channel = await deps.channels.getById(job.channelId);
    const channelArchived = !channel || channel.teamId !== job.teamId || channel.archivedAt != null;
    const policy = await deps.teamPolicy.getOrDefault(job.teamId);
    const explicitTarget = computeExplicitTarget(humanMessage.meta);
    const targetAgentId = resolveTargetAgentId(parsed, humanMessage.meta);
    // AC#4: agent_request 时按需二次检索目标 Agent 投影（不全量注入 prompt，仅追加 attribution）。
    if (parsed.kind === 'resolved' && parsed.intent === 'agent_request' && targetAgentId) {
      try {
        const agentMemory = await deps.memoryContextResolver.resolve({
          teamId: job.teamId,
          channelId: job.channelId,
          messageId: job.messageId,
          senderUserId: humanMessage.senderId,
          prompt: humanMessage.body,
          targetAgentId,
          includeAgentProjections: true,
        });
        memoryAttribution = mergeAttribution(memoryAttribution, agentMemory.attribution);
      } catch {
        /* 二次检索失败保持初始 attribution */
      }
    }
    const senderRole = await deps.teams.getMemberRole(job.teamId, humanMessage.senderId);
    const senderAuthorized = Boolean(
      senderRole &&
      humanMessage.teamId === job.teamId &&
      humanMessage.channelId === job.channelId &&
      channel &&
      (channel.visibility !== 'private' || channel.humanMemberIds.includes(humanMessage.senderId)),
    );
    const targetAgent = targetAgentId ? await deps.agents.getById(targetAgentId) : null;
    const hasExplicitAgentMention = Boolean(
      humanMessage.meta?.mentions?.some((mention) => mention.kind === 'agent'),
    );
    const needsScopedTarget = parsed.intent === 'agent_request' &&
      (hasExplicitAgentMention || parsed.targetAgentName !== null);
    const targetInChannel = Boolean(
      targetAgentId &&
      channel &&
      channel.agentMemberIds.includes(targetAgentId),
    );
    const targetScopeValid = !needsScopedTarget || Boolean(
      targetAgent && targetAgent.visibleTeamIds.includes(job.teamId) && targetInChannel,
    );
    const isSideEffect = PI_COORDINATION_SIDE_EFFECT_INTENTS.has(parsed.intent);
    const assessedRisk = isSideEffect
      ? assessCoordinationRisk({ modelRisk: parsed.risk, objective: parsed.objective })
      : null;
    const verdict = evaluateCoordinationGate({
      intent: parsed.intent,
      risk: assessedRisk,
      explicitTarget,
      autoCoordinationEnabled: policy.autoCoordinationEnabled,
      channelArchived,
      senderAuthorized,
      targetScopeValid,
    });
    return finalizeGateDecision(
      job,
      attempt,
      parsed,
      verdict,
      usage,
      responseModel,
      {
        threadId: humanMessage.threadId ?? humanMessage.id,
        senderId: humanMessage.senderId,
        targetAgentId,
        targetAgentName: parsed.targetAgentName,
        targetStatus: targetAgent?.status ?? null,
        needsScopedTarget,
        targetScopeValid,
        riskLevel: assessedRisk,
        gateStatus: verdict.status,
        memoryAttribution,
      },
      now,
    );
  }

  /** 取所有到期可消费 Job，串行处理（避免并发同 Job）。预期失败已在 processJob 内转为 failed Decision；未预期异常冒泡，交由上层 driver 处理。 */
  async function runCoordinationCycle(input?: { now?: number; limit?: number }): Promise<CoordinationCycleSummary> {
    const now = input?.now ?? deps.clock.now();
    const limit = input?.limit ?? 50;
    const runnable = await deps.jobs.listRunnable({ now, runningBefore: now - processingTimeoutMs, limit });
    const outcomes: CoordinationJobOutcome[] = [];
    for (const job of runnable) {
      outcomes.push(await processJob(job.id, now));
    }
    return { processed: runnable.length, outcomes };
  }

  return {
    processJob,
    runCoordinationCycle,
  };
}

export type ChannelCoordinator = ReturnType<typeof createChannelCoordinator>;
