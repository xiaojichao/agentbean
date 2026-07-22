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
 * 完整六种协调意图（#707）。
 * - no_action/system_reply/clarification_required：会话型，#706 已实现，始终 applied（不受开关影响）。
 * - agent_request/tracked_task/task_followup：副作用型，#707 由服务端策略门禁决定 applied/suggested/blocked。
 * 其他任何模型输出一律 fail closed（AC#2）。
 */
export type ChannelCoordinationIntent =
  | 'no_action'
  | 'system_reply'
  | 'clarification_required'
  | 'agent_request'
  | 'tracked_task'
  | 'task_followup';

/** Decision 终态：resolved = 模型给出合法意图；failed = 永久错误或重试耗尽（AC#5/AC#6）。 */
export type ChannelCoordinationOutcome = 'resolved' | 'failed';

/**
 * 服务端策略门禁对 proposed Decision 的裁决（#707, AC#8 审计状态）。
 * - proposed：模型原始提议（门禁前；infra 失败的 failed Decision 留空）。
 * - applied：门禁放行并执行了副作用。
 * - suggested：门禁建议但不自动执行（如自动协调关闭，AC#5）。
 * - blocked：门禁拒绝（高风险/不可逆/敏感/扩作用域/频道归档，AC#7）。
 */
export type ChannelCoordinationGateStatus = 'proposed' | 'suggested' | 'applied' | 'blocked';

/** 风险分级：high = 不可逆/敏感/扩作用域，门禁始终 blocked（AC#7）。 */
export type ChannelCoordinationRiskLevel = 'low' | 'high';

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
  /** 服务端门禁裁决（AC#8）；failed（infra）时为 null。 */
  readonly gateStatus: ChannelCoordinationGateStatus | null;
  /** 门禁评估的风险（副作用意图）；会话意图/failed 时为 null。 */
  readonly riskLevel: ChannelCoordinationRiskLevel | null;
  /** 副作用意图的目标描述（tracked_task/agent_request/task_followup）；其余为 null。 */
  readonly objective: string | null;
  /** agent_request 的显式目标 agent（来自 @Agent）；其余为 null。 */
  readonly targetAgentId: ID | null;
  /** tracked_task/agent_request 创建的 Task 或 task_followup 关联的 Task；其余为 null。 */
  readonly linkedTaskId: ID | null;
  /** blocked 时的短原因码；其余为 null。 */
  readonly blockingReason: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/**
 * Team PI 自动协调开关的产品投影（#707）。
 * 刻意只暴露 autoCoordinationEnabled —— 不含 mode/Phase/placement/Provider/Model/budget（AC#1）。
 * 旧 ManagementPolicy 仅供旧 Run 恢复读取，不再是 Team 产品设置。
 */
export interface TeamPiPolicyDto {
  readonly autoCoordinationEnabled: boolean;
}

export interface GetTeamPiPolicyInput {
  readonly teamId: ID;
  readonly userId: ID;
}

export interface UpdateTeamPiPolicyInput {
  readonly teamId: ID;
  readonly userId: ID;
  readonly autoCoordinationEnabled: boolean;
}
