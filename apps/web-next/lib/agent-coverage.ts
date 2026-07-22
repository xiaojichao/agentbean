/**
 * #710 PI Team coverage 缺口纯计算（web-next 约定：只测纯函数）。
 * 与 domain evaluateCapabilityMatch 同语义的 web 本地版（web 不直接依赖 domain 包）。
 */
import {
  type AgentEligibilityUnknownCause,
  ELIGIBILITY_REASON_CODE,
  eligibilityUnknownCauseReasonCode,
} from '@agentbean/contracts';

export interface CoverageGapInput {
  readonly exposed: readonly string[];
  readonly disabled: readonly string[];
  readonly required: readonly string[];
}

export interface CoverageGapResult {
  /** 生效能力 = exposed 减 disabled（大小写不敏感）。 */
  readonly effective: readonly string[];
  /** required 中未被生效能力覆盖的（缺口，大小写不敏感，去重保序）。 */
  readonly missing: readonly string[];
}

export function computeCoverageGap(input: CoverageGapInput): CoverageGapResult {
  const disabledSet = new Set(input.disabled.map((entry) => entry.toLowerCase()));
  const effective = input.exposed.filter((entry) => !disabledSet.has(entry.toLowerCase()));
  const effectiveSet = new Set(effective.map((entry) => entry.toLowerCase()));
  const missing: string[] = [];
  for (const requirement of input.required) {
    const lower = requirement.toLowerCase();
    if (!effectiveSet.has(lower) && !missing.includes(lower)) missing.push(lower);
  }
  return { effective, missing };
}

// ── #711 AC#7：coverage 视图展示合格/不合格理由（不泄漏内部） ──
//
// web 本地版，与 domain evaluateAgentEligibility 同语义（web 不直接依赖 domain 包），
// 复用 contracts 的 canonical ELIGIBILITY_REASON_CODE，保证 server 投影与 web 渲染一致。
// 安全要点（AC#4/AC#7）：只消费公开 capability/skill 名；unknown 态一律 undeclared，
// 绝不报 missing（否则等于推断 Agent 内部缺失）。返回结构仅含公开字段。

export type AgentEligibilityViewState = 'qualified' | 'not_qualified' | 'unknown';
export type CapabilityMatchStatusView = 'covered' | 'missing' | 'undeclared';
export type SkillMatchStatusView = 'covered' | 'missing' | 'undeclared';

export interface AgentEligibilityViewInput {
  /** 是否存在当前有效且可达的 active manifest；false → unknown（AC#4）。 */
  readonly hasCurrentManifest: boolean;
  /** unknown 时的成因（AC#4）；缺省 undeclared。server 投影可传 expired/unreachable。 */
  readonly unknownCause?: AgentEligibilityUnknownCause;
  readonly available: boolean;
  /** 生效公开能力/技能（exposed 减 disabled，由 computeCoverageGap 等先算好）。 */
  readonly effectiveCapabilities: readonly string[];
  readonly effectiveSkills: readonly string[];
  readonly requiredCapabilities: readonly string[];
  readonly requiredSkills: readonly string[];
  readonly preferredSkills?: readonly string[];
}

export interface AgentEligibilityView {
  readonly state: AgentEligibilityViewState;
  readonly available: boolean;
  readonly capabilities: readonly { readonly name: string; readonly status: CapabilityMatchStatusView }[];
  readonly requiredSkills: readonly { readonly name: string; readonly status: SkillMatchStatusView }[];
  readonly preferredSkills: readonly { readonly name: string; readonly matched: boolean }[];
  readonly missingHardRequirements: readonly string[];
  readonly reasonCode: string;
}

function dedupeLower(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of values) {
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return out;
}

/**
 * 计算单 Agent 对一组任务要求的资格判定与理由（AC#7）。
 * - 缺当前声明 → unknown，每项 undeclared，不推断 missing（AC#4）。
 * - 任一硬能力/技能缺失 → not_qualified。
 * - preferred 只产出命中信息，不改 state。
 */
export function computeAgentEligibilityView(input: AgentEligibilityViewInput): AgentEligibilityView {
  const preferredSkills = input.preferredSkills ?? [];

  if (!input.hasCurrentManifest) {
    return {
      state: 'unknown',
      available: input.available,
      capabilities: dedupeLower(input.requiredCapabilities).map((name) => ({
        name,
        status: 'undeclared',
      })),
      requiredSkills: dedupeLower(input.requiredSkills).map((name) => ({ name, status: 'undeclared' })),
      preferredSkills: dedupeLower(preferredSkills).map((name) => ({ name, matched: false })),
      missingHardRequirements: [],
      reasonCode: eligibilityUnknownCauseReasonCode(input.unknownCause ?? 'undeclared'),
    };
  }

  const capSet = new Set(input.effectiveCapabilities.map((c) => c.toLowerCase()));
  const skillSet = new Set(input.effectiveSkills.map((s) => s.toLowerCase()));

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
