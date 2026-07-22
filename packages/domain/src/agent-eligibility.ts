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
