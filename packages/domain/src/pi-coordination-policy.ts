/**
 * PI Channel Coordination 纯策略（#706 + #707）。
 *
 * 职责：意图请求的系统提示词、fail-closed 响应解析、模型失败归一化与重试分类、服务端策略门禁。
 * 无 server 依赖、无 IO，可单测。镜像 pi-provider-policy.ts / pi-provider-test-policy.ts 风格。
 *
 * 设计要点：
 * - 六种意图：no_action/system_reply/clarification_required（会话型，始终 applied）+
 *   agent_request/tracked_task/task_followup（副作用型，由 evaluateCoordinationGate 裁决）。
 * - 意图以「文本内单行 JSON」承载，而非 tool call：adapter 的 tool 名是封闭联合类型，无法自定义
 *   pi_coordinate 工具；AC#5 也把「非法 JSON」列为显式失败模式。
 * - 模型只能产 proposed Decision；Server 重新校验风险/开关/显式目标（AC#4/AC#5/AC#6/AC#7）。
 * - Decision 只存短理由码与结构化字段，绝不存完整思维链/prompt/敏感输出（AC#4/AC#8）。
 */

/** 完整六种协调意图。 */
export const PI_COORDINATION_INTENTS = [
  'no_action',
  'system_reply',
  'clarification_required',
  'agent_request',
  'tracked_task',
  'task_followup',
] as const;
export type PiCoordinationIntent = (typeof PI_COORDINATION_INTENTS)[number];

/** 会话型意图：不受自动协调开关影响，始终 applied。 */
export const PI_COORDINATION_CONVERSATIONAL_INTENTS: ReadonlySet<PiCoordinationIntent> = new Set([
  'no_action',
  'system_reply',
  'clarification_required',
]);

/** 副作用型意图：由服务端门禁裁决 applied/suggested/blocked。 */
export const PI_COORDINATION_SIDE_EFFECT_INTENTS: ReadonlySet<PiCoordinationIntent> = new Set([
  'agent_request',
  'tracked_task',
  'task_followup',
]);

export type PiCoordinationRiskLevel = 'low' | 'high';

/** 副作用意图的高风险判定阈值（objective 文本上限）。 */
const OBJECTIVE_MAX = 600;

/**
 * 服务端风险兜底词表。模型的 risk 只是提议，不能把明显的破坏性、敏感数据或扩作用域动作降为 low。
 * 这里不尝试理解任意自然语言，只负责把高置信度信号提升为 high；不确定项仍交给用户确认流程。
 */
const HIGH_RISK_OBJECTIVE_PATTERNS = [
  /(?:删除|销毁|清空|擦除|永久移除).{0,24}(?:生产|数据库|数据|文件|记录|账号|账户|仓库)/i,
  /(?:导出|公开|发布|外发|共享).{0,24}(?:密码|密钥|令牌|凭证|隐私|敏感|身份证|银行卡|生产数据)/i,
  /(?:跨团队|跨\s*team|全局范围|扩大.{0,8}作用域)/i,
  /\b(?:delete|drop|destroy|wipe|erase|purge)\b.{0,40}\b(?:production|database|data|file|record|account|repository)\b/i,
  /\b(?:export|publish|expose|share)\b.{0,40}\b(?:password|secret|api\s*key|token|credential|private|sensitive|production\s+data)\b/i,
  /\b(?:cross[- ]team|global scope|expand(?:ing)? scope)\b/i,
] as const;

/** 模型风险与服务端高置信度规则取更高值，防止模型把明显高风险目标误报为 low。 */
export function assessCoordinationRisk(input: {
  readonly modelRisk: PiCoordinationRiskLevel | null;
  readonly objective: string | null;
}): PiCoordinationRiskLevel | null {
  if (input.modelRisk === null) return null;
  if (input.modelRisk === 'high') return 'high';
  const objective = input.objective ?? '';
  return HIGH_RISK_OBJECTIVE_PATTERNS.some((pattern) => pattern.test(objective)) ? 'high' : 'low';
}

/**
 * 系统协调身份的固定 senderId（AC#3）。
 * PI 不成为 Team 成员、不伪装外部 Agent，仅以 AgentBean 系统协调者身份保存消息。
 */
export const PI_COORDINATION_SYSTEM_SENDER_ID = 'pi-coordinator';

/**
 * 模型系统提示词：作为 AgentBean PI 协调者，对一条人类频道消息分类为六种意图之一，
 * 并以单行 JSON 回复（无 markdown 代码围栏）。模型只「提议」(proposed)；服务端门禁最终裁决。
 */
export const PI_COORDINATION_SYSTEM_PROMPT = [
  'You are the AgentBean PI Channel Coordinator.',
  'Read one human channel message and PROPOSE the single best coordination intent. The server re-validates everything.',
  'You have no file, shell, workspace, device or team-member capabilities. You only reason about intent.',
  'Respond with EXACTLY one JSON object on a single line, no markdown fences, no prose:',
  '{"intent":"...","reasonCode":"<short snake_case>","risk":"low|high","objective":"<short goal>","targetAgentName":"<optional>","text":"<optional reply>"}',
  '- no_action: greeting, chat, discussion. "text" may be empty. risk/objective omitted.',
  '- system_reply: a short factual/status reply. "text" required. risk/objective omitted.',
  '- clarification_required: ask one concise clarifying question. "text" required. risk/objective omitted.',
  '- tracked_task: the message needs persistent tracking/delivery. "risk" and "objective" required.',
  '- task_followup: relates to an existing tracked task. "risk" and "objective" required.',
  '- agent_request: asks a specific agent to do something. "risk" and "objective" required; "targetAgentName" when an agent is @-mentioned.',
  'risk="high" ONLY for irreversible, sensitive-data, or scope-expanding actions; otherwise "low".',
  'Keep reasonCode <= 48 chars ASCII snake_case. objective <= 300 chars. text <= 800 chars. Output JSON only.',
].join('\n');

/** 基础设施失败诊断码（区别于模型自给的 reasonCode）。 */
export const COORDINATION_DIAGNOSTIC = {
  ACTIVE_MODEL_UNAVAILABLE: 'ACTIVE_MODEL_UNAVAILABLE',
  MODEL_AUTH_ERROR: 'MODEL_AUTH_ERROR',
  MODEL_TIMEOUT: 'MODEL_TIMEOUT',
  MODEL_RATE_LIMIT: 'MODEL_RATE_LIMIT',
  MODEL_SERVER_ERROR: 'MODEL_SERVER_ERROR',
  MODEL_NETWORK_ERROR: 'MODEL_NETWORK_ERROR',
  MODEL_INVALID_OUTPUT: 'MODEL_INVALID_OUTPUT',
  MODEL_INVALID_JSON: 'MODEL_INVALID_JSON',
  MODEL_ABORTED: 'MODEL_ABORTED',
  MODEL_REJECTED: 'MODEL_REJECTED',
  MODEL_REQUEST_INVALID: 'MODEL_REQUEST_INVALID',
  MODEL_UNKNOWN: 'MODEL_UNKNOWN',
} as const;
export type CoordinationDiagnosticCode =
  (typeof COORDINATION_DIAGNOSTIC)[keyof typeof COORDINATION_DIAGNOSTIC];

/**
 * 模型调用失败的归一化错误种类。
 * 由 server 从 adapter（@agentbean/pi-management-runtime）的错误码映射而来，
 * 使本 domain 层不必依赖 adapter 包。
 */
export type CoordinationErrorKind =
  | 'auth'
  | 'timeout'
  | 'rate_limit'
  | 'server'
  | 'network'
  | 'invalid_output'
  | 'invalid_json'
  | 'aborted'
  | 'rejected'
  | 'request_invalid'
  | 'unknown';

export const DEFAULT_MAX_COORDINATION_ATTEMPTS = 3;
export const DEFAULT_COORDINATION_BASE_DELAY_MS = 1000;

const REASON_CODE_MAX = 64;
const REPLY_TEXT_MAX = 2000;

/** reasonCode sanitize：限长，仅允许字母/数字/中文等可见字符，空白折叠为下划线。 */
export function sanitizeCoordinationReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, REASON_CODE_MAX);
  if (!trimmed) return null;
  if (!/^[\p{L}\p{N}_.:\- ]+$/u.test(trimmed)) return null;
  return trimmed.replace(/\s+/g, '_');
}

/** 展示文本 sanitize：限长，去除控制字符（保留换行/制表符外的可见内容）。 */
export function sanitizeCoordinationReplyText(value: unknown, max = REPLY_TEXT_MAX): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, max);
  return cleaned || null;
}

/** 副作用意图的 objective sanitize：限长，去控制字符。 */
export function sanitizeCoordinationObjective(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, OBJECTIVE_MAX);
  return cleaned || null;
}

/** targetAgentName sanitize：限长，仅可见字符。 */
export function sanitizeCoordinationTargetAgentName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, 128);
  return cleaned || null;
}

/** 从模型文本中提取 JSON：容忍单层 ```json 围栏，其余情况原样交给 JSON.parse（fail closed）。 */
function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const inner = fenced?.[1];
  return inner ? inner.trim() : trimmed;
}

/** 模型响应的最小投影，使 domain 不依赖 adapter 类型。 */
export interface CoordinationResponseProjection {
  readonly finishReason: string;
  readonly textContents: readonly string[];
}

export type CoordinationParseResult =
  | {
      readonly kind: 'resolved';
      readonly intent: PiCoordinationIntent;
      readonly reasonCode: string | null;
      readonly text: string | null;
      readonly risk: PiCoordinationRiskLevel | null;
      readonly objective: string | null;
      readonly targetAgentName: string | null;
    }
  | { readonly kind: 'invalid'; readonly code: CoordinationDiagnosticCode };

/**
 * fail-closed 解析模型响应（AC#2/AC#5）。
 * 合法 = finishReason 'stop' + 恰好一段文本 + 可解析对象 + 合法 intent。
 * - 会话型（no_action/system_reply/clarification_required）：reply/clarify 需 text；no_action 可无。
 * - 副作用型（agent_request/tracked_task/task_followup）：必须 risk(low|high) + objective；text 可选。
 * 任何偏离 → invalid（可重试 fail closed）。
 */
export function parseCoordinationResponse(
  response: CoordinationResponseProjection,
): CoordinationParseResult {
  if (response.finishReason !== 'stop') {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  if (response.textContents.length !== 1) {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  const rawText = response.textContents[0];
  if (!rawText) {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonPayload(rawText));
  } catch {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_JSON };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj.intent !== 'string' ||
    !PI_COORDINATION_INTENTS.includes(obj.intent as PiCoordinationIntent)
  ) {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  const intent = obj.intent as PiCoordinationIntent;
  const reasonCode = sanitizeCoordinationReasonCode(obj.reasonCode);
  const text = sanitizeCoordinationReplyText(obj.text);
  const objective = sanitizeCoordinationObjective(obj.objective);
  const targetAgentName = sanitizeCoordinationTargetAgentName(obj.targetAgentName);

  if (PI_COORDINATION_CONVERSATIONAL_INTENTS.has(intent)) {
    if (intent !== 'no_action' && !text) {
      return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
    }
    return {
      kind: 'resolved',
      intent,
      reasonCode,
      text: intent === 'no_action' ? null : text,
      risk: null,
      objective: null,
      targetAgentName: null,
    };
  }

  // 副作用型：必须 risk + objective。
  if (obj.risk !== 'low' && obj.risk !== 'high') {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  if (!objective) {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  return {
    kind: 'resolved',
    intent,
    reasonCode,
    text,
    risk: obj.risk,
    objective,
    targetAgentName,
  };
}

// ── 服务端策略门禁（#707, AC#4/AC#5/AC#6/AC#7） ──

export interface CoordinationGateInput {
  readonly intent: PiCoordinationIntent;
  readonly risk: PiCoordinationRiskLevel | null;
  /** 硬目标：显式 @Agent / 明确作为任务 / 用户已确认。不被开关静默吞（AC#6）。 */
  readonly explicitTarget: boolean;
  readonly autoCoordinationEnabled: boolean;
  readonly channelArchived: boolean;
  /** 消费时重新校验发送者仍有 Team/频道权限。 */
  readonly senderAuthorized?: boolean;
  /** agent_request 的显式目标仍在当前 Team 可见作用域内。 */
  readonly targetScopeValid?: boolean;
}

export type CoordinationGateVerdict =
  | { readonly status: 'applied'; readonly reason: string }
  | { readonly status: 'suggested'; readonly reason: string }
  | { readonly status: 'blocked'; readonly reason: string };

export const COORDINATION_GATE_REASON = {
  CONVERSATIONAL_ALWAYS_APPLIED: 'CONVERSATIONAL_ALWAYS_APPLIED',
  SENDER_NOT_AUTHORIZED: 'SENDER_NOT_AUTHORIZED',
  TARGET_AGENT_OUT_OF_SCOPE: 'TARGET_AGENT_OUT_OF_SCOPE',
  CHANNEL_ARCHIVED: 'CHANNEL_ARCHIVED',
  HIGH_RISK_REQUIRES_CONFIRMATION: 'HIGH_RISK_REQUIRES_CONFIRMATION',
  EXPLICIT_TARGET_NOT_SILENCED: 'EXPLICIT_TARGET_NOT_SILENCED',
  AUTO_COORDINATION_ENABLED: 'AUTO_COORDINATION_ENABLED',
  AUTO_COORDINATION_DISABLED_SUGGESTED: 'AUTO_COORDINATION_DISABLED_SUGGESTED',
} as const;

/**
 * 服务端策略门禁：模型只提议，此处最终裁决副作用型意图的 applied/suggested/blocked。
 * - 会话型意图始终 applied（不受开关影响）。
 * - 频道归档 → blocked。
 * - 高风险（不可逆/敏感/扩作用域）→ blocked（AC#7），无论开关。
 * - 硬目标（显式 @Agent/作为任务/用户确认）且低风险 → applied（不被吞, AC#6）。
 * - 自动协调开 + 低风险 → applied。
 * - 自动协调关 + 非硬目标 → suggested（不执行, AC#5）。
 */
export function evaluateCoordinationGate(input: CoordinationGateInput): CoordinationGateVerdict {
  if (input.senderAuthorized === false) {
    return { status: 'blocked', reason: COORDINATION_GATE_REASON.SENDER_NOT_AUTHORIZED };
  }
  if (input.channelArchived) {
    return { status: 'blocked', reason: COORDINATION_GATE_REASON.CHANNEL_ARCHIVED };
  }
  if (input.targetScopeValid === false) {
    return { status: 'blocked', reason: COORDINATION_GATE_REASON.TARGET_AGENT_OUT_OF_SCOPE };
  }
  if (PI_COORDINATION_CONVERSATIONAL_INTENTS.has(input.intent)) {
    return { status: 'applied', reason: COORDINATION_GATE_REASON.CONVERSATIONAL_ALWAYS_APPLIED };
  }
  if (input.risk === 'high') {
    return { status: 'blocked', reason: COORDINATION_GATE_REASON.HIGH_RISK_REQUIRES_CONFIRMATION };
  }
  if (input.explicitTarget) {
    return { status: 'applied', reason: COORDINATION_GATE_REASON.EXPLICIT_TARGET_NOT_SILENCED };
  }
  if (input.autoCoordinationEnabled) {
    return { status: 'applied', reason: COORDINATION_GATE_REASON.AUTO_COORDINATION_ENABLED };
  }
  return { status: 'suggested', reason: COORDINATION_GATE_REASON.AUTO_COORDINATION_DISABLED_SUGGESTED };
}

/** errorKind 是否瞬态可重试。 */
export function isTransientCoordinationError(kind: CoordinationErrorKind): boolean {
  return (
    kind === 'timeout' ||
    kind === 'rate_limit' ||
    kind === 'server' ||
    kind === 'network' ||
    kind === 'invalid_output' ||
    kind === 'invalid_json'
  );
}

/** 把归一化 errorKind 映射为诊断码（用于终态 failed Decision）。 */
export function coordinationDiagnosticForErrorKind(
  kind: CoordinationErrorKind,
): CoordinationDiagnosticCode {
  switch (kind) {
    case 'auth':
      return COORDINATION_DIAGNOSTIC.MODEL_AUTH_ERROR;
    case 'timeout':
      return COORDINATION_DIAGNOSTIC.MODEL_TIMEOUT;
    case 'rate_limit':
      return COORDINATION_DIAGNOSTIC.MODEL_RATE_LIMIT;
    case 'server':
      return COORDINATION_DIAGNOSTIC.MODEL_SERVER_ERROR;
    case 'network':
      return COORDINATION_DIAGNOSTIC.MODEL_NETWORK_ERROR;
    case 'invalid_output':
      return COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT;
    case 'invalid_json':
      return COORDINATION_DIAGNOSTIC.MODEL_INVALID_JSON;
    case 'aborted':
      return COORDINATION_DIAGNOSTIC.MODEL_ABORTED;
    case 'rejected':
      return COORDINATION_DIAGNOSTIC.MODEL_REJECTED;
    case 'request_invalid':
      return COORDINATION_DIAGNOSTIC.MODEL_REQUEST_INVALID;
    default:
      return COORDINATION_DIAGNOSTIC.MODEL_UNKNOWN;
  }
}

export interface PlanCoordinationRetryInput {
  /** 刚失败的尝试序号（1-based）。 */
  readonly attempt: number;
  readonly errorKind: CoordinationErrorKind;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly now: number;
}

export type CoordinationRetryDecision =
  | { readonly kind: 'retry'; readonly nextAttempt: number; readonly nextRetryAt: number }
  | { readonly kind: 'fail'; readonly diagnosticCode: CoordinationDiagnosticCode };

/**
 * 重试策略（AC#5/AC#6）。
 * 永久错误（auth/aborted/rejected/request_invalid/unknown）立即失败；
 * 瞬态错误在 maxAttempts 内指数退避重试（base * 2^(attempt-1)），超出则失败。
 * 失败诊断码反映最终失败原因（重试耗尽时即最后一次瞬态错误码）。
 */
export function planCoordinationRetry(
  input: PlanCoordinationRetryInput,
): CoordinationRetryDecision {
  const diagnosticCode = coordinationDiagnosticForErrorKind(input.errorKind);
  if (!isTransientCoordinationError(input.errorKind)) {
    return { kind: 'fail', diagnosticCode };
  }
  if (input.attempt >= input.maxAttempts) {
    return { kind: 'fail', diagnosticCode };
  }
  const nextAttempt = input.attempt + 1;
  const delay = input.baseDelayMs * 2 ** (input.attempt - 1);
  return { kind: 'retry', nextAttempt, nextRetryAt: input.now + delay };
}
