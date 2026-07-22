import type { ID, UnixMs } from './common.js';

export type ChannelCoordinationJobStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ChannelCoordinationActiveModelSnapshot =
  | { readonly availability: 'unavailable' }
  | {
      readonly availability: 'available';
      readonly cardId: ID;
      readonly revisionId: ID;
      readonly modelId: string;
    };

/** Server-internal durable work item. Never project activeModel to Team/Web DTOs. */
export interface ChannelCoordinationJobRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly messageId: ID;
  readonly idempotencyKey: string;
  readonly status: ChannelCoordinationJobStatus;
  readonly attempt: number;
  readonly nextRetryAt: UnixMs | null;
  readonly activeModel: ChannelCoordinationActiveModelSnapshot;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/**
 * 首期允许的三种无副作用协调意图（#706 / 切片 A）。
 * 其他任何模型输出一律 fail closed（AC#2）；agent_request/tracked_task/task_followup 属后续切片。
 */
export type ChannelCoordinationIntent = 'no_action' | 'system_reply' | 'clarification_required';

/** Decision 终态：resolved = 模型给出合法意图；failed = 永久错误或重试耗尽（AC#5/AC#6）。 */
export type ChannelCoordinationOutcome = 'resolved' | 'failed';

/**
 * Provider 返回的 Token Usage。null 表示未知（AC#8）。
 * 不含费用/单价/账单/配额；Team 永远看不到 Provider/Model 身份。
 */
export interface ChannelCoordinationDecisionUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/**
 * 一条人类频道消息的协调结论。一 Job 一 Decision（job_id UNIQUE，AC#7）。
 * 只保存短理由码与必要结构化字段，绝不保存完整思维链、完整 prompt 或敏感工具输出（AC#4）。
 * 服务端内部记录，永不投影到 Team/Web DTO（AC#8）。
 */
export interface ChannelCoordinationDecisionRecord {
  readonly id: ID;
  readonly jobId: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly messageId: ID;
  readonly outcome: ChannelCoordinationOutcome;
  /** resolved 时为三种意图之一；failed 时为 null。 */
  readonly intent: ChannelCoordinationIntent | null;
  /** 模型自给的短理由码（resolved 时）。已 sanitize，非完整思维链。 */
  readonly reasonCode: string | null;
  /** system_reply/clarification_required 的展示文本；no_action/failed 时为 null。 */
  readonly replyText: string | null;
  readonly usage: ChannelCoordinationDecisionUsage;
  /** 产生该 Decision 时调用的 pinned Active PI Model 快照。 */
  readonly pinnedModel: ChannelCoordinationActiveModelSnapshot;
  /** 模型返回的 model id（服务端内部诊断用，不投影给 Team）。 */
  readonly responseModel: string | null;
  /** 基础设施失败诊断码（failed 时）；resolved 时为 null。 */
  readonly diagnosticCode: string | null;
  /** 产生该 Decision 的尝试序号（1-based）。 */
  readonly attempt: number;
  /** 关联的系统协调消息 id（system_reply/clarification_required 时）；其余为 null。 */
  readonly systemMessageId: ID | null;
  readonly idempotencyKey: string;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}
