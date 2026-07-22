/**
 * PI Channel Coordination 纯策略（#706 / 切片 A）。
 *
 * 职责：意图请求的系统提示词、fail-closed 响应解析、模型失败归一化与重试分类。
 * 无 server 依赖、无 IO，可单测。镜像 pi-provider-policy.ts / pi-provider-test-policy.ts 风格。
 *
 * 设计要点：
 * - 首期仅 no_action/system_reply/clarification_required 三种无副作用意图；其他输出 fail closed（AC#2）。
 * - 意图以「文本内单行 JSON」承载，而非 tool call：adapter 的 tool 名是封闭联合类型，无法自定义
 *   pi_coordinate 工具；AC#5 也把「非法 JSON」列为显式失败模式。
 * - Decision 只存短理由码与结构化字段，绝不存完整思维链/prompt/敏感输出（AC#4）。
 */

/** 首期允许的三种意图。 */
export const PI_COORDINATION_INTENTS = [
  'no_action',
  'system_reply',
  'clarification_required',
] as const;
export type PiCoordinationIntent = (typeof PI_COORDINATION_INTENTS)[number];

/**
 * 系统协调身份的固定 senderId（AC#3）。
 * PI 不成为 Team 成员、不伪装外部 Agent，仅以 AgentBean 系统协调者身份保存消息。
 */
export const PI_COORDINATION_SYSTEM_SENDER_ID = 'pi-coordinator';

/**
 * 模型系统提示词：作为 AgentBean PI 协调者，对一条人类频道消息分类为三种意图之一，
 * 并以单行 JSON 回复（无 markdown 代码围栏）。
 */
export const PI_COORDINATION_SYSTEM_PROMPT = [
  'You are the AgentBean PI Channel Coordinator.',
  'Read one human channel message and decide the single best coordination intent.',
  'You have no file, shell, workspace, device or team-member capabilities. You only reason about intent.',
  'Respond with EXACTLY one JSON object on a single line, no markdown fences, no prose:',
  '{"intent":"<one of no_action|system_reply|clarification_required>","reasonCode":"<short snake_case reason>","text":"<reply or clarification>"}',
  '- no_action: greeting, chat, discussion, or anything needing no PI action. "text" may be empty.',
  '- system_reply: a short factual/status reply the PI should post as the system coordinator. "text" is required.',
  '- clarification_required: the request is ambiguous or lacks a usable target; "text" asks one concise clarifying question. "text" is required.',
  'Keep reasonCode <= 48 chars, ASCII snake_case. Keep text concise (<= 800 chars). Output JSON only.',
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
    }
  | { readonly kind: 'invalid'; readonly code: CoordinationDiagnosticCode };

/**
 * fail-closed 解析模型响应（AC#2/AC#5）。
 * 合法 = finishReason 'stop' + 恰好一段文本 + 可解析对象 + 合法 intent，
 * 且 system_reply/clarification_required 必须有非空 text。任何偏离 → invalid。
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
  if (intent !== 'no_action' && !text) {
    return { kind: 'invalid', code: COORDINATION_DIAGNOSTIC.MODEL_INVALID_OUTPUT };
  }
  return {
    kind: 'resolved',
    intent,
    reasonCode,
    text: intent === 'no_action' ? null : text,
  };
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
