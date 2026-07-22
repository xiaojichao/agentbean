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
  assessCoordinationRisk,
  evaluateCoordinationGate,
  parseCoordinationResponse,
  planCoordinationRetry,
} from '../../../../packages/domain/src/index.js';
import type {
  ChannelCoordinationDecisionRecord,
  ChannelCoordinationDecisionUsage,
  ChannelCoordinationGateStatus,
  ChannelCoordinationJobRecord,
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

  function buildRequest(humanMessageBody: string): ManagementModelRequest {
    return {
      systemPrompt: PI_COORDINATION_SYSTEM_PROMPT,
      sessionContext: EMPTY_SESSION_CONTEXT as never,
      messages: [{ role: 'user', content: [{ type: 'text', text: humanMessageBody }] }],
      tools: [],
    };
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

  /** 依据意图 + 门禁裁决组装面向 Team 的系统协调消息正文（null = 不发消息）。 */
  function coordinationSystemMessageBody(
    parsed: Extract<CoordinationParseResult, { kind: 'resolved' }>,
    verdict: CoordinationGateVerdict,
  ): string | null {
    if (
      verdict.status === 'blocked' &&
      (verdict.reason === COORDINATION_GATE_REASON.CHANNEL_ARCHIVED ||
        verdict.reason === COORDINATION_GATE_REASON.SENDER_NOT_AUTHORIZED)
    ) {
      return null;
    }
    if (verdict.status === 'blocked') {
      const objective = parsed.objective ?? '';
      return `已拦截（需确认或目标已失效）：${objective}`;
    }
    switch (parsed.intent) {
      case 'system_reply':
      case 'clarification_required':
        return parsed.text;
      case 'no_action':
        return null;
    }
    const objective = parsed.objective ?? '';
    if (verdict.status === 'suggested') return `PI 建议（自动协调未开启，需确认后执行）：${objective}`;
    // applied 副作用意图
    switch (parsed.intent) {
      case 'tracked_task':
        return `已创建跟踪任务：${objective}`;
      case 'agent_request':
        return `已记录 Agent 请求：${objective}`;
      case 'task_followup':
        return `已记录任务跟进：${objective}`;
      default:
        return null;
    }
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
      readonly riskLevel: ChannelCoordinationDecisionRecord['riskLevel'];
      readonly gateStatus: ChannelCoordinationGateStatus;
    },
    now: number,
  ): Promise<CoordinationJobOutcome> {
    const decisionId = deps.ids.nextId();
    const isSideEffect = PI_COORDINATION_SIDE_EFFECT_INTENTS.has(parsed.intent);
    const blockingReason = verdict.status === 'blocked' ? verdict.reason : null;
    return deps.unitOfWork.run(async (transaction) => {
      let systemMessageId: ID | null = null;
      let linkedTaskId: ID | null = null;

      const messageBody = coordinationSystemMessageBody(parsed, verdict);
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
          meta: { coordination: { decisionId, intent: parsed.intent, gateStatus: ctx.gateStatus, jobId: job.id } },
        });
        systemMessageId = message.id;
      }

      // applied 副作用意图：tracked_task/agent_request 建 Task；task_followup MVP 仅记录（关联留后续）。
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
        gateStatus: ctx.gateStatus,
        riskLevel: ctx.riskLevel,
        objective: isSideEffect ? parsed.objective : null,
        targetAgentId: parsed.intent === 'agent_request' ? ctx.targetAgentId : null,
        linkedTaskId,
        blockingReason,
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
      response = await adapter.respond(buildRequest(humanMessage.body), { callCount: 1 });
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
    const targetScopeValid = !needsScopedTarget || Boolean(
      targetAgent && targetAgent.visibleTeamIds.includes(job.teamId),
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
        riskLevel: assessedRisk,
        gateStatus: verdict.status,
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
