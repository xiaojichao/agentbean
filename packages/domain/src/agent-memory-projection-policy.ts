/**
 * #718 Team-scoped Agent Memory 投影纯策略。
 *
 * 职责：投影内容校验、发布窗口校验、Team opt-in 的 fail-closed 消费判定。
 * 无 server 依赖、无 IO，可单测。镜像 agent-exposure-policy.ts / formal-memory-policy.ts 风格。
 *
 * 安全要点（AC#1/AC#3/AC#5/AC#7）：
 * - 内容校验拒绝非法 kind（只允许 4 类 FormalMemoryKind）、空/超长 content、非法 tag。
 * - opt-in 默认 opted-out，revision fence 不匹配时 fail-closed（不消费）。
 * - 全程不接触 Device-local 原文/Agent 内部 Session——投影内容由 owner 手动录入。
 */
import { FORMAL_MEMORY_KINDS, type FormalMemoryKind, type MemorySourceKind, type MemorySourceRefDto } from '@agentbean/contracts';

/** 字段长度上界（与 sanitize 一致）。 */
export const AGENT_MEMORY_PROJECTION_CONTENT_MAX = 8000;
export const AGENT_MEMORY_PROJECTION_SUMMARY_MAX = 600;
export const AGENT_MEMORY_PROJECTION_TAG_MAX = 48;
export const AGENT_MEMORY_PROJECTION_TAGS_MAX = 16;
export const AGENT_MEMORY_PROJECTION_SOURCE_REFS_MAX = 16;

export const AGENT_MEMORY_PROJECTION_ERROR = {
  INVALID_KIND: 'AGENT_MEMORY_PROJECTION_INVALID_KIND',
  INVALID_CONTENT: 'AGENT_MEMORY_PROJECTION_INVALID_CONTENT',
  INVALID_SUMMARY: 'AGENT_MEMORY_PROJECTION_INVALID_SUMMARY',
  INVALID_TAG: 'AGENT_MEMORY_PROJECTION_INVALID_TAG',
  TOO_MANY_TAGS: 'AGENT_MEMORY_PROJECTION_TOO_MANY_TAGS',
  INVALID_SOURCE_REF: 'AGENT_MEMORY_PROJECTION_INVALID_SOURCE_REF',
  TOO_MANY_SOURCE_REFS: 'AGENT_MEMORY_PROJECTION_TOO_MANY_SOURCE_REFS',
  INVALID_VALIDITY: 'AGENT_MEMORY_PROJECTION_INVALID_VALIDITY',
} as const;
export type AgentMemoryProjectionErrorCode =
  (typeof AGENT_MEMORY_PROJECTION_ERROR)[keyof typeof AGENT_MEMORY_PROJECTION_ERROR];

/** 合法 sourceKind 集合（与 management-memory MemorySourceKind 对齐）。 */
const VALID_SOURCE_KINDS = new Set<string>([
  'message', 'task', 'artifact', 'workspace-run', 'invocation', 'memory', 'manual', 'local-summary',
]);

export interface AgentMemoryProjectionValidatedContent {
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly validFrom: number;
  readonly validUntil: number | null;
}

export type AgentMemoryProjectionValidationResult =
  | { readonly ok: true; readonly content: AgentMemoryProjectionValidatedContent }
  | { readonly ok: false; readonly code: AgentMemoryProjectionErrorCode; readonly message: string };

/** 文本 sanitize：去控制字符、折叠首尾空白。空或超长返回 null（fail-closed，不截断）。 */
function sanitizeBoundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

/**
 * Tag 规范化与校验：lowercase、只允许 [a-z0-9-]、不以 - 开头/结尾、不含连续 --。
 * 与 0015 migration 的 memory_tags CHECK 对齐。非法返回 null。
 */
function normalizeTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase().trim();
  if (!lower) return null;
  if (lower.length > AGENT_MEMORY_PROJECTION_TAG_MAX) return null;
  if (!/^[a-z0-9-]+$/.test(lower)) return null;
  if (lower.startsWith('-') || lower.endsWith('-')) return null;
  if (lower.includes('--')) return null;
  return lower;
}

/**
 * 校验投影内容（来自不可信 socket 输入）。
 * 成功返回 sanitize 后的确定性内容；任何非法字段 fail-closed。
 * 不设 validFrom 默认值——由 service 用 clock.now() 提供；此处仅在两者都给定时校验区间。
 */
export function parseAgentMemoryProjectionContent(raw: unknown): AgentMemoryProjectionValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_CONTENT, message: 'Invalid projection payload' };
  }
  const obj = raw as Record<string, unknown>;

  // kind：只允许 4 类 FormalMemoryKind（AC#1：projection content is product-typed）。
  if (typeof obj.kind !== 'string' || !FORMAL_MEMORY_KINDS.includes(obj.kind as FormalMemoryKind)) {
    return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_KIND, message: 'kind must be one of fact/decision/rule/preference' };
  }
  const kind = obj.kind as FormalMemoryKind;

  // content：非空、有界。
  const content = sanitizeBoundedText(obj.content, AGENT_MEMORY_PROJECTION_CONTENT_MAX);
  if (!content) {
    return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_CONTENT, message: 'content must be a non-empty bounded string' };
  }

  // summary：可选，给定时须合法。
  let summary: string | undefined;
  if (obj.summary !== undefined && obj.summary !== null) {
    const cleaned = sanitizeBoundedText(obj.summary, AGENT_MEMORY_PROJECTION_SUMMARY_MAX);
    if (!cleaned) {
      return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_SUMMARY, message: 'summary must be a bounded string' };
    }
    summary = cleaned;
  }

  // tags：可选数组，每个须合法；任一非法整条拒绝（fail-closed）；去重保序。
  let tags: readonly string[] = [];
  if (obj.tags !== undefined && obj.tags !== null) {
    if (!Array.isArray(obj.tags)) {
      return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_TAG, message: 'tags must be an array' };
    }
    if (obj.tags.length > AGENT_MEMORY_PROJECTION_TAGS_MAX) {
      return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.TOO_MANY_TAGS, message: 'Too many tags' };
    }
    const seen = new Set<string>();
    const cleanTags: string[] = [];
    for (const raw of obj.tags) {
      const tag = normalizeTag(raw);
      if (!tag) {
        return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_TAG, message: `Invalid tag: ${String(raw)}` };
      }
      if (!seen.has(tag)) {
        seen.add(tag);
        cleanTags.push(tag);
      }
    }
    tags = cleanTags;
  }

  // sourceRefs：可选数组，结构校验；任一非法整条拒绝。
  let sourceRefs: readonly MemorySourceRefDto[] = [];
  if (obj.sourceRefs !== undefined && obj.sourceRefs !== null) {
    if (!Array.isArray(obj.sourceRefs)) {
      return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_SOURCE_REF, message: 'sourceRefs must be an array' };
    }
    if (obj.sourceRefs.length > AGENT_MEMORY_PROJECTION_SOURCE_REFS_MAX) {
      return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.TOO_MANY_SOURCE_REFS, message: 'Too many sourceRefs' };
    }
    const cleanRefs: MemorySourceRefDto[] = [];
    for (const ref of obj.sourceRefs) {
      if (!ref || typeof ref !== 'object') {
        return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_SOURCE_REF, message: 'Invalid sourceRef' };
      }
      const r = ref as Record<string, unknown>;
      const sourceKindRaw = typeof r.sourceKind === 'string' && VALID_SOURCE_KINDS.has(r.sourceKind) ? r.sourceKind : null;
      const sourceId = sanitizeBoundedText(r.sourceId, 256);
      const snapshotHash = sanitizeBoundedText(r.snapshotHash, 256);
      if (!sourceKindRaw || !sourceId || !snapshotHash) {
        return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_SOURCE_REF, message: 'Invalid sourceRef fields' };
      }
      cleanRefs.push({ schemaVersion: 1, sourceKind: sourceKindRaw as MemorySourceKind, sourceId, snapshotHash });
    }
    sourceRefs = cleanRefs;
  }

  // validity：类型 + 区间。
  const validFrom = obj.validFrom;
  const validUntil = obj.validUntil;
  if ((validFrom !== undefined && typeof validFrom !== 'number') ||
      (validUntil !== undefined && validUntil !== null && typeof validUntil !== 'number')) {
    return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_VALIDITY, message: 'Invalid validity window' };
  }
  if (typeof validFrom === 'number' && validUntil !== null && typeof validUntil === 'number' && validUntil <= validFrom) {
    return { ok: false, code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_VALIDITY, message: 'validUntil must be after validFrom' };
  }

  return {
    ok: true,
    content: {
      kind,
      content,
      summary,
      tags,
      sourceRefs,
      validFrom: typeof validFrom === 'number' ? validFrom : 0,
      validUntil: validUntil === undefined ? null : (validUntil as number | null),
    },
  };
}

// ── 发布窗口校验 ──

export type ProjectionPublishWindowResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AgentMemoryProjectionErrorCode; readonly message: string };

/**
 * 发布时校验有效期窗口：若 validUntil 已过期（<= now），拒绝发布。
 * draft 创建时可能 validUntil 在未来，但 owner 拖延发布导致过期时不应上线。
 */
export function evaluateProjectionPublishWindow(input: {
  readonly validFrom: number;
  readonly validUntil: number | null;
  readonly now: number;
}): ProjectionPublishWindowResult {
  if (input.validUntil !== null && input.validUntil <= input.now) {
    return {
      ok: false,
      code: AGENT_MEMORY_PROJECTION_ERROR.INVALID_VALIDITY,
      message: 'Projection validUntil already expired at publish time',
    };
  }
  return { ok: true };
}

// ── Team opt-in 消费判定（AC#3/AC#5/AC#7） ──

export interface EvaluateTeamAgentMemoryOptInInput {
  /** 当前 active projection id；无 active 时为 null。 */
  readonly activeProjectionId: string | null;
  /** Team opt-in 记录；无记录为 null（默认 opted-out）。 */
  readonly optIn: { readonly projectionId: string; readonly enabled: boolean } | null;
}

export interface EvaluateTeamAgentMemoryOptInResult {
  /** 是否可消费：仅当 active 存在 + opt-in enabled + projectionId 匹配（revision fence）。 */
  readonly consumable: boolean;
}

/**
 * AC#3/AC#5/AC#7 核心：Team 只在显式 opt-in 且 opt-in 锁定的 projection 仍是当前 active
 * 时才消费投影。任一条件不满足 fail-closed（consumable=false）：
 * - 无 active projection（owner 未发布或已 withdrawn）
 * - 无 opt-in 记录（默认 opted-out，AC#5 明确授权）
 * - opt-in disabled（Team admin 停用，AC#3）
 * - opt-in projectionId 与当前 active 不符（revision fence：projection supersede 后旧 opt-in 失效，AC#7）
 */
export function evaluateTeamAgentMemoryOptIn(input: EvaluateTeamAgentMemoryOptInInput): EvaluateTeamAgentMemoryOptInResult {
  if (!input.activeProjectionId) return { consumable: false };
  if (!input.optIn) return { consumable: false };
  if (!input.optIn.enabled) return { consumable: false };
  if (input.optIn.projectionId !== input.activeProjectionId) return { consumable: false };
  return { consumable: true };
}
