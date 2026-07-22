/**
 * #710 Agent 候选资格纯规则。
 *
 * 职责：用 Exposure 公开 capability/skill 做 hard 过滤与 coverage 计算，取代
 * 旧「把 agent.skills 名当 capability」的消费（task-claim-broker / collaboration-service）。
 * 无 server 依赖、无 IO，可单测。
 *
 * 约定：调用方（service/broker）负责从 Exposure active 投影取出 exposedCapabilities
 * 并先减去 Team restriction，再传入本模块。本模块只做纯集合运算。
 */
import {
  type AgentEligibilityUnknownCause,
  type EligibilityReasonCodeValue,
  ELIGIBILITY_REASON_CODE,
  eligibilityUnknownCauseReasonCode,
} from '@agentbean/contracts';

export interface CapabilityMatchInput {
  readonly exposedCapabilities: readonly string[];
  readonly requiredCapabilities: readonly string[];
}

export interface CapabilityMatchResult {
  /** required 中未被 exposed 覆盖的 capability（去重，保留顺序）。空 = 全部满足。 */
  readonly missing: readonly string[];
}

/** required 减 exposed；大小写不敏感；去重保序。 */
export function evaluateCapabilityMatch(input: CapabilityMatchInput): CapabilityMatchResult {
  const exposed = new Set(input.exposedCapabilities.map((c) => c.toLowerCase()));
  const missing: string[] = [];
  for (const raw of input.requiredCapabilities) {
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    if (exposed.has(lower)) continue;
    if (!missing.includes(lower)) missing.push(lower);
  }
  return { missing };
}

export interface SkillCoverageInput {
  readonly exposedSkills: readonly string[];
  readonly requiredSkills?: readonly string[];
}

export interface SkillCoverageResult {
  readonly covered: readonly string[];
  readonly missing: readonly string[];
}

/** required 与 exposed 的交集/差集（大小写不敏感；去重保序）。 */
export function evaluateSkillCoverage(input: SkillCoverageInput): SkillCoverageResult {
  const exposed = new Set(input.exposedSkills.map((s) => s.toLowerCase()));
  const required = input.requiredSkills ?? [];
  const covered: string[] = [];
  const missing: string[] = [];
  for (const raw of required) {
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    if (exposed.has(lower)) {
      if (!covered.includes(lower)) covered.push(lower);
    } else if (!missing.includes(lower)) {
      missing.push(lower);
    }
  }
  return { covered, missing };
}

export interface PreferredSkillCandidate {
  readonly agentId: string;
  readonly exposedSkills: readonly string[];
}

/**
 * preferred Skill 排序 hook（切片 C 候选排序）。
 * 按命中 preferred 的数量降序；相同则保持原顺序（稳定）。reliability 维度后续接入，
 * 届时作为次级 key，不影响本函数的 preferred 主排序。
 */
export function rankByPreferredSkills<T extends PreferredSkillCandidate>(
  candidates: readonly T[],
  preferredSkills: readonly string[],
): readonly T[] {
  const preferred = new Set(preferredSkills.map((s) => s.toLowerCase()));
  if (preferred.size === 0) return candidates;
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      score: candidate.exposedSkills.filter((s) => preferred.has(s.toLowerCase())).length,
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.candidate);
}

// ─────────────────────────────────────────────────────────────────────────────
// #711 候选判断：可解释资格、unknown 态、skill-id 校验、硬指定与合格候选排序。
//
// 安全模型（AC#4）：Agent 内部 skill inventory 永不进入 PI。唯一可信来源是当前
// Team 的有效 active Exposure Manifest。当该声明不可得（未声明/过期/不可达）时，
// 一律判 unknown 并把每项要求标 undeclared —— 绝不报 missing，否则等于推断 Agent
// 内部缺失，违反 exposure 安全合同。调用方（server）负责把 active projection 是否
// 存在/过期/可达压成下面的判别联合；本模块只消费已解析态（深度模块边界，无 IO）。
// ─────────────────────────────────────────────────────────────────────────────

/** 资格判定三态。not_qualified=公开声明明确缺失硬门槛；unknown=无法获得有效声明。 */
export type AgentEligibilityState = 'qualified' | 'not_qualified' | 'unknown';

/**
 * 单项硬要求匹配状态。`undeclared` 仅在 unknown 态出现，表示「无法判定」——它不等于
 * 缺失，也不等于存在；coverage 视图据此显示「未声明/未知」（AC#4）。
 */
export type CapabilityMatchStatus = 'covered' | 'missing' | 'undeclared';
export type SkillMatchStatus = 'covered' | 'missing' | 'undeclared';

/**
 * Agent 当前公开声明的解析态。
 * - `current`：存在当前有效且可达的 active manifest，附公开 capability/skill 名。
 * - `unknown`：未声明 / 已过期 / 无法获得当前响应，不再推断内部存在与否。
 */
export type AgentEligibilityManifest =
  | {
      readonly status: 'current';
      readonly capabilities: readonly string[];
      readonly skills: readonly string[];
    }
  | { readonly status: 'unknown'; readonly cause: AgentEligibilityUnknownCause };

export interface AgentEligibilityInput {
  readonly manifest: AgentEligibilityManifest;
  /** availability 投影：只影响排序（AC#3）与硬指定离线确认（AC#6），不影响 reason 语义。 */
  readonly available: boolean;
  readonly requiredCapabilities: readonly string[];
  readonly requiredSkills: readonly string[];
  readonly preferredSkills?: readonly string[];
}

export interface CapabilityMatchReason {
  readonly name: string;
  readonly status: CapabilityMatchStatus;
}
export interface SkillMatchReason {
  readonly name: string;
  readonly status: SkillMatchStatus;
}
export interface PreferredSkillMatch {
  readonly name: string;
  readonly matched: boolean;
}

export interface AgentEligibilityResult {
  readonly state: AgentEligibilityState;
  readonly available: boolean;
  readonly capabilities: readonly CapabilityMatchReason[];
  readonly requiredSkills: readonly SkillMatchReason[];
  readonly preferredSkills: readonly PreferredSkillMatch[];
  /** not_qualified 时汇总缺失硬门槛（lowercase 去重保序）；qualified/unknown 时为空。 */
  readonly missingHardRequirements: readonly string[];
  /** 人类可读判定码（AC#7 视图/审计），仅含公开名与状态，不含内部信息。 */
  readonly reasonCode: EligibilityReasonCodeValue;
}

/** lowercase + 去重 + 保序；忽略非字符串项。 */
function dedupeLower(values: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/**
 * AC#2/AC#4 核心：对单个 Agent 做 hard 过滤并产出可解释理由。
 * - required Capability/Skill 缺失任一 → state=not_qualified（不进入合格候选）。
 * - 声明不可得（unknown manifest）→ state=unknown，每项要求 undeclared，绝不 missing。
 * - preferred Skill 只产出命中信息，永不改变 state（AC#3 preferred 仅排序）。
 */
export function evaluateAgentEligibility(input: AgentEligibilityInput): AgentEligibilityResult {
  const preferredSkills = input.preferredSkills ?? [];

  if (input.manifest.status === 'unknown') {
    return {
      state: 'unknown',
      available: input.available,
      capabilities: dedupeLower(input.requiredCapabilities).map((name) => ({
        name,
        status: 'undeclared',
      })),
      requiredSkills: dedupeLower(input.requiredSkills).map((name) => ({
        name,
        status: 'undeclared',
      })),
      preferredSkills: dedupeLower(preferredSkills).map((name) => ({ name, matched: false })),
      missingHardRequirements: [],
      reasonCode: eligibilityUnknownCauseReasonCode(input.manifest.cause),
    };
  }

  const capSet = new Set(input.manifest.capabilities.map((c) => c.toLowerCase()));
  const skillSet = new Set(input.manifest.skills.map((s) => s.toLowerCase()));

  const capabilities = dedupeLower(input.requiredCapabilities).map((name) => ({
    name,
    status: capSet.has(name) ? ('covered' as const) : ('missing' as const),
  }));
  const requiredSkills = dedupeLower(input.requiredSkills).map((name) => ({
    name,
    status: skillSet.has(name) ? ('covered' as const) : ('missing' as const),
  }));
  const preferredMatches = dedupeLower(preferredSkills).map((name) => ({
    name,
    matched: skillSet.has(name),
  }));

  const missingHardRequirements = [
    ...capabilities.filter((c) => c.status === 'missing').map((c) => c.name),
    ...requiredSkills.filter((s) => s.status === 'missing').map((s) => s.name),
  ];

  return {
    state: missingHardRequirements.length === 0 ? 'qualified' : 'not_qualified',
    available: input.available,
    capabilities,
    requiredSkills,
    preferredSkills: preferredMatches,
    missingHardRequirements,
    reasonCode:
      missingHardRequirements.length === 0
        ? ELIGIBILITY_REASON_CODE.QUALIFIED
        : ELIGIBILITY_REASON_CODE.MISSING_HARD_REQUIREMENT,
  };
}

// ── AC#5：PI 只能引用当前 Team Manifest 中真实稳定 Skill ID（fail-closed） ──

export interface ValidateProposedSkillIdsInput {
  readonly proposedSkillIds: readonly string[];
  /** 当前 Team 所有 active manifest 的 skill 名并集（PI 唯一可引用集合）。 */
  readonly activeManifestSkillIds: readonly string[];
}
export interface ValidateProposedSkillIdsResult {
  readonly ok: boolean;
  /** proposed 中不在任何 active manifest 的 skill id（lowercase 去重保序）。 */
  readonly unknownSkillIds: readonly string[];
}

/**
 * AC#5：PI（模型）提议的 required/preferred Skill 必须真实存在于当前 Team Manifest。
 * 引用任何不存在的 skill 名 → fail-closed（ok=false），防止 PI 凭空创造 skill。
 * 空 active 集合时，任何提议都判未知（不能要求无人声明的 skill）。
 */
export function validateProposedSkillIds(
  input: ValidateProposedSkillIdsInput,
): ValidateProposedSkillIdsResult {
  const active = new Set(input.activeManifestSkillIds.map((s) => s.toLowerCase()));
  const unknownSkillIds = dedupeLower(input.proposedSkillIds).filter((name) => !active.has(name));
  return { ok: unknownSkillIds.length === 0, unknownSkillIds };
}

// ── AC#6：用户硬指定 Agent 时不静默改派 ──

export type HardSpecifyResolution = 'eligible' | 'needs_confirmation' | 'ineligible';

export interface ResolveHardSpecifiedTargetInput {
  /** 来自 evaluateAgentEligibility 的判定（仅需 state + available）。 */
  readonly eligibility: { readonly state: AgentEligibilityState; readonly available: boolean };
  readonly isHardSpecified: boolean;
}

/**
 * AC#6：显式 @Agent（硬指定）永不静默改派。
 * - 硬指定 + 完全胜任（qualified 且可用）→ eligible。
 * - 硬指定 + 否则（skill 未声明/缺失/离线）→ needs_confirmation：保留目标，向用户请求确认。
 * - 非硬指定：仅完全胜任者 eligible，其余 ineligible（移出合格候选，不进入自动派发）。
 */
export function resolveHardSpecifiedTarget(
  input: ResolveHardSpecifiedTargetInput,
): HardSpecifyResolution {
  const fullyCapable = input.eligibility.state === 'qualified' && input.eligibility.available;
  if (input.isHardSpecified) return fullyCapable ? 'eligible' : 'needs_confirmation';
  return fullyCapable ? 'eligible' : 'ineligible';
}

// ── AC#3：preferred Skill / Experience / 负载 / 可用性 仅在合格候选间排序 ──

export interface QualifiedCandidate extends PreferredSkillCandidate {
  readonly available: boolean;
  /** 当前 Team 经验分（越高越优）；缺省 0。 */
  readonly experienceScore?: number;
  /** 负载分（越高=越空闲越好）；缺省 0。 */
  readonly loadScore?: number;
}

/**
 * AC#3：在已通过资格过滤的候选间稳定排序。
 * 主序 preferred skill 命中数，次序 可用 → 经验 → 负载，末序 原序（稳定）。
 * 本函数不做资格过滤——调用方先用 evaluateAgentEligibility 过出合格候选（AC#3「只在合格候选间排序」）。
 */
export function rankQualifiedCandidates<T extends QualifiedCandidate>(
  candidates: readonly T[],
  preferredSkills: readonly string[],
): readonly T[] {
  const preferred = new Set(preferredSkills.map((s) => s.toLowerCase()));
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      hits: candidate.exposedSkills.filter((s) => preferred.has(s.toLowerCase())).length,
      available: candidate.available ? 1 : 0,
      experience: candidate.experienceScore ?? 0,
      load: candidate.loadScore ?? 0,
    }))
    .sort(
      (a, b) =>
        b.hits - a.hits ||
        b.available - a.available ||
        b.experience - a.experience ||
        b.load - a.load ||
        a.index - b.index,
    )
    .map((entry) => entry.candidate);
}
