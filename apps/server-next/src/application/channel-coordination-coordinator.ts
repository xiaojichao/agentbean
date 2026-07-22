/**
 * Server Channel Coordinator（#706 / 切片 A）。
 *
 * 异步消费 Channel Coordination Job：用 Job pins 的 Active PI Model 调用模型，
 * 对一条人类频道消息产出 no_action/system_reply/clarification_required Decision，
 * 并（仅 reply/clarify）以 AgentBean 系统协调身份保存一条系统消息。
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
  DEFAULT_COORDINATION_BASE_DELAY_MS,
  DEFAULT_MAX_COORDINATION_ATTEMPTS,
  PI_COORDINATION_SYSTEM_PROMPT,
  PI_COORDINATION_SYSTEM_SENDER_ID,
  type CoordinationErrorKind,
  type CoordinationParseResult,
  parseCoordinationResponse,
  planCoordinationRetry,
} from '../../../../packages/domain/src/index.js';
import type {
  ChannelCoordinationDecisionRecord,
  ChannelCoordinationDecisionUsage,
  ChannelCoordinationJobRecord,
  ID,
} from '../../../../packages/contracts/src/index.js';
import type {
  ChannelCoordinationDecisionRepository,
  ChannelCoordinationJobRepository,
  ChannelCoordinationUnitOfWork,
} from './channel-coordination-unit-of-work.js';
import type { MessageRepository } from './repositories.js';

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

  async function finalizeResolved(
    job: ChannelCoordinationJobRecord,
    attempt: number,
    parsed: Extract<CoordinationParseResult, { kind: 'resolved' }>,
    usage: ChannelCoordinationDecisionUsage,
    responseModel: string | null,
    threadId: ID,
    now: number,
  ): Promise<CoordinationJobOutcome> {
    const decisionId = deps.ids.nextId();
    const wantsSystemMessage = parsed.intent === 'system_reply' || parsed.intent === 'clarification_required';
    return deps.unitOfWork.run(async (transaction) => {
      let systemMessageId: ID | null = null;
      if (wantsSystemMessage && parsed.text) {
        const message = await transaction.messages.append({
          id: deps.ids.nextId(),
          teamId: job.teamId,
          channelId: job.channelId,
          threadId,
          senderKind: 'system',
          senderId: PI_COORDINATION_SYSTEM_SENDER_ID,
          body: parsed.text,
          createdAt: now,
          meta: { coordination: { decisionId, intent: parsed.intent, jobId: job.id } },
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

    return finalizeResolved(
      job,
      attempt,
      parsed,
      usage,
      responseModel,
      humanMessage.threadId ?? humanMessage.id,
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
