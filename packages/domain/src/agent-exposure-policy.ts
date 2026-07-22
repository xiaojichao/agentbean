/**
 * #710 Agent Exposure 纯策略。
 *
 * 职责：Manifest 内容校验、发布窗口校验、Team restriction 的 fail-closed 收紧规则。
 * 无 server 依赖、无 IO，可单测。镜像 pi-coordination-policy.ts / memory-policy.ts 风格。
 *
 * 安全要点（AC#4/AC#6）：
 * - 内容校验拒绝非法/越权字段；capability 名唯一、非空、有界。
 * - restriction 只能禁用 active manifest 已暴露的 operation（evaluateRestriction fail-closed）。
 * - 全程不接触 sourcePath/adapterKind/scope——这些在契约层已被排除。
 */
import type {
  AgentExposureAvailabilityDto,
  AgentExposureCapabilityDto,
  AgentExposureConstraintDto,
  AgentExposureSkillDto,
} from '@agentbean/contracts';

/** 字段长度上界（与 sanitize 一致）。 */
export const AGENT_EXPOSURE_NAME_MAX = 64;
export const AGENT_EXPOSURE_DESCRIPTION_MAX = 300;
export const AGENT_EXPOSURE_CONSTRAINT_KIND_MAX = 48;
/** 单个 Manifest 的 capability/skill 数量软上界，防止滥用。 */
export const AGENT_EXPOSURE_ITEMS_MAX = 128;

export const AGENT_EXPOSURE_ERROR = {
  EMPTY_CAPABILITIES: 'AGENT_EXPOSURE_EMPTY_CAPABILITIES',
  DUPLICATE_CAPABILITY: 'AGENT_EXPOSURE_DUPLICATE_CAPABILITY',
  INVALID_CAPABILITY_NAME: 'AGENT_EXPOSURE_INVALID_CAPABILITY_NAME',
  INVALID_CAPABILITY_DESCRIPTION: 'AGENT_EXPOSURE_INVALID_CAPABILITY_DESCRIPTION',
  DUPLICATE_SKILL: 'AGENT_EXPOSURE_DUPLICATE_SKILL',
  INVALID_SKILL_NAME: 'AGENT_EXPOSURE_INVALID_SKILL_NAME',
  INVALID_SKILL_DESCRIPTION: 'AGENT_EXPOSURE_INVALID_SKILL_DESCRIPTION',
  INVALID_CONSTRAINT: 'AGENT_EXPOSURE_INVALID_CONSTRAINT',
  INVALID_AVAILABILITY: 'AGENT_EXPOSURE_INVALID_AVAILABILITY',
  INVALID_VALIDITY: 'AGENT_EXPOSURE_INVALID_VALIDITY',
  TOO_MANY_ITEMS: 'AGENT_EXPOSURE_TOO_MANY_ITEMS',
  RESTRICTION_REFERENCES_UNKNOWN_CAPABILITY: 'AGENT_EXPOSURE_RESTRICTION_UNKNOWN_CAPABILITY',
  RESTRICTION_REFERENCES_UNKNOWN_SKILL: 'AGENT_EXPOSURE_RESTRICTION_UNKNOWN_SKILL',
} as const;
export type AgentExposureErrorCode =
  (typeof AGENT_EXPOSURE_ERROR)[keyof typeof AGENT_EXPOSURE_ERROR];

export interface AgentExposureValidatedContent {
  readonly capabilities: readonly AgentExposureCapabilityDto[];
  readonly skills: readonly AgentExposureSkillDto[];
  readonly constraints: readonly AgentExposureConstraintDto[];
  readonly availability: AgentExposureAvailabilityDto;
  readonly validFrom: number;
  readonly validUntil: number | null;
}

export type AgentExposureValidationResult =
  | { readonly ok: true; readonly content: AgentExposureValidatedContent }
  | { readonly ok: false; readonly code: AgentExposureErrorCode; readonly message: string };

/** 名称 sanitize：去控制字符、折叠首尾空白。空或超长（>max）返回 null（fail-closed，不截断）。 */
function sanitizeBoundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

function normalizeAvailability(value: unknown): AgentExposureAvailabilityDto | null {
  if (value === undefined || value === null) return { status: 'available' };
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const status = (value as { status?: unknown }).status;
  if (status === 'available') return { status: 'available' };
  if (status === 'unavailable') {
    const reason = sanitizeBoundedText((value as { reason?: unknown }).reason, AGENT_EXPOSURE_DESCRIPTION_MAX);
    return reason ? { status: 'unavailable', reason } : { status: 'unavailable' };
  }
  return null;
}

/**
 * 校验 Manifest 内容（来自不可信 socket 输入）。
 * 成功返回 sanitize 后的确定性内容；任何非法字段 fail-closed。
 * 不设置 validFrom 默认值——由 service 用 clock.now() 提供；此处仅在两者都给定时校验区间。
 */
export function parseAgentExposureContent(raw: unknown): AgentExposureValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.EMPTY_CAPABILITIES, message: 'Invalid exposure payload' };
  }
  const obj = raw as Record<string, unknown>;
  const capabilities = obj.capabilities;
  const skills = obj.skills;
  if (!Array.isArray(capabilities)) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.EMPTY_CAPABILITIES, message: 'capabilities must be an array' };
  }
  if (!Array.isArray(skills)) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_SKILL_NAME, message: 'skills must be an array' };
  }
  if (capabilities.length < 1) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.EMPTY_CAPABILITIES, message: 'At least one capability required' };
  }
  if (capabilities.length > AGENT_EXPOSURE_ITEMS_MAX || skills.length > AGENT_EXPOSURE_ITEMS_MAX) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.TOO_MANY_ITEMS, message: 'Too many exposure items' };
  }

  const seenCap = new Set<string>();
  const cleanCaps: AgentExposureCapabilityDto[] = [];
  for (const item of capabilities) {
    const name = sanitizeBoundedText((item as { name?: unknown })?.name, AGENT_EXPOSURE_NAME_MAX);
    const description = sanitizeBoundedText(
      (item as { description?: unknown })?.description,
      AGENT_EXPOSURE_DESCRIPTION_MAX,
    );
    if (!name) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_CAPABILITY_NAME, message: 'Invalid capability name' };
    }
    if (!description) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_CAPABILITY_DESCRIPTION, message: 'Invalid capability description' };
    }
    const key = name.toLowerCase();
    if (seenCap.has(key)) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.DUPLICATE_CAPABILITY, message: `Duplicate capability: ${name}` };
    }
    seenCap.add(key);
    cleanCaps.push({ name, description });
  }

  const seenSkill = new Set<string>();
  const cleanSkills: AgentExposureSkillDto[] = [];
  for (const item of skills) {
    const name = sanitizeBoundedText((item as { name?: unknown })?.name, AGENT_EXPOSURE_NAME_MAX);
    const description = sanitizeBoundedText(
      (item as { description?: unknown })?.description,
      AGENT_EXPOSURE_DESCRIPTION_MAX,
    );
    if (!name) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_SKILL_NAME, message: 'Invalid skill name' };
    }
    if (!description) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_SKILL_DESCRIPTION, message: 'Invalid skill description' };
    }
    const key = name.toLowerCase();
    if (seenSkill.has(key)) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.DUPLICATE_SKILL, message: `Duplicate skill: ${name}` };
    }
    seenSkill.add(key);
    cleanSkills.push({ name, description });
  }

  const rawConstraints = obj.constraints;
  const cleanConstraints: AgentExposureConstraintDto[] = [];
  if (rawConstraints !== undefined && rawConstraints !== null) {
    if (!Array.isArray(rawConstraints)) {
      return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_CONSTRAINT, message: 'constraints must be an array' };
    }
    for (const item of rawConstraints) {
      const kind = sanitizeBoundedText((item as { kind?: unknown })?.kind, AGENT_EXPOSURE_CONSTRAINT_KIND_MAX);
      const description = sanitizeBoundedText(
        (item as { description?: unknown })?.description,
        AGENT_EXPOSURE_DESCRIPTION_MAX,
      );
      if (!kind || !description) {
        return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_CONSTRAINT, message: 'Invalid constraint' };
      }
      cleanConstraints.push({ kind, description });
    }
  }

  const availability = normalizeAvailability(obj.availability);
  if (!availability) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_AVAILABILITY, message: 'Invalid availability' };
  }

  const validFrom = obj.validFrom;
  const validUntil = obj.validUntil;
  if ((validFrom !== undefined && typeof validFrom !== 'number') ||
      (validUntil !== undefined && validUntil !== null && typeof validUntil !== 'number')) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_VALIDITY, message: 'Invalid validity window' };
  }
  if (typeof validFrom === 'number' && validUntil !== null && typeof validUntil === 'number' && validUntil <= validFrom) {
    return { ok: false, code: AGENT_EXPOSURE_ERROR.INVALID_VALIDITY, message: 'validUntil must be after validFrom' };
  }

  return {
    ok: true,
    content: {
      capabilities: cleanCaps,
      skills: cleanSkills,
      constraints: cleanConstraints,
      availability,
      validFrom: typeof validFrom === 'number' ? validFrom : 0,
      validUntil: validUntil === undefined ? null : (validUntil as number | null),
    },
  };
}

// ── Team restriction 收紧规则（AC#4） ──

export interface EvaluateRestrictionInput {
  readonly activeCapabilities: readonly string[];
  readonly activeSkills: readonly string[];
  readonly disabledCapabilities: readonly string[];
  readonly disabledSkills: readonly string[];
}

export type EvaluateRestrictionResult =
  | { readonly ok: true; readonly disabledCapabilities: readonly string[]; readonly disabledSkills: readonly string[] }
  | { readonly ok: false; readonly code: AgentExposureErrorCode; readonly message: string };

/**
 * AC#4 核心：Team Owner/Admin 只能禁用 active manifest 已暴露的 operation。
 * 引用任何未公开 capability/skill → fail-closed（禁止借 restriction 新增或越权）。
 * 同时去重并保留首次出现顺序。
 */
export function evaluateRestriction(input: EvaluateRestrictionInput): EvaluateRestrictionResult {
  const activeCapSet = new Set(input.activeCapabilities.map((c) => c.toLowerCase()));
  const activeSkillSet = new Set(input.activeSkills.map((s) => s.toLowerCase()));

  const dedupCap: string[] = [];
  for (const name of input.disabledCapabilities) {
    if (typeof name !== 'string') continue;
    const lower = name.toLowerCase();
    if (!activeCapSet.has(lower)) {
      return {
        ok: false,
        code: AGENT_EXPOSURE_ERROR.RESTRICTION_REFERENCES_UNKNOWN_CAPABILITY,
        message: `Cannot disable unpublished capability: ${name}`,
      };
    }
    if (!dedupCap.includes(lower)) dedupCap.push(lower);
  }

  const dedupSkill: string[] = [];
  for (const name of input.disabledSkills) {
    if (typeof name !== 'string') continue;
    const lower = name.toLowerCase();
    if (!activeSkillSet.has(lower)) {
      return {
        ok: false,
        code: AGENT_EXPOSURE_ERROR.RESTRICTION_REFERENCES_UNKNOWN_SKILL,
        message: `Cannot disable unpublished skill: ${name}`,
      };
    }
    if (!dedupSkill.includes(lower)) dedupSkill.push(lower);
  }

  return { ok: true, disabledCapabilities: dedupCap, disabledSkills: dedupSkill };
}

// ── 发布窗口校验 ──

export type PublishWindowResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: AgentExposureErrorCode; readonly message: string };

/**
 * 发布时校验有效期窗口：若 validUntil 已过期（<= now），拒绝发布。
 * draft 创建时可能 validUntil 在未来，但 owner 拖延发布导致过期时不应上线。
 */
export function evaluatePublishWindow(input: {
  readonly validFrom: number;
  readonly validUntil: number | null;
  readonly now: number;
}): PublishWindowResult {
  if (input.validUntil !== null && input.validUntil <= input.now) {
    return {
      ok: false,
      code: AGENT_EXPOSURE_ERROR.INVALID_VALIDITY,
      message: 'Manifest validUntil already expired at publish time',
    };
  }
  return { ok: true };
}
