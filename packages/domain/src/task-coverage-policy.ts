/**
 * #715 多 Agent Skill coverage 与整图可分配性 —— 纯规则（切片 C 规划期决策层）。
 *
 * 职责：在 PI 把根 Task 拆成子 Task 树后、发布 Offer 前，提供两个可单测的结构性校验：
 * - AC#1 `evaluateSkillCoverageUnion`：根 Task 声明的总体 Skill coverage（根 requiredSkills）
 *   是否被多个子 Task 的 requiredSkills 并集联合覆盖（ADR 0021）。
 * - AC#2 `evaluateExecutableSubtaskCoverage`：每个可执行（叶子）子 Task 是否都有
 *   至少一个 qualified 候选 Agent，使「单节点责任完整」（ADR 0021 / #711 eligibility）。
 *
 * 关键不变量：
 * - 复用根节点 TaskCoordinationDto.requiredSkills 作为总体 coverage target（ADR 0021，
 *   不新增字段）。本函数不关心根/子来源，只消费 string[]。
 * - 大小写不敏感：所有 skill 名称小写折叠后比较（与 agent-eligibility.ts 一致）。
 * - fail-closed：候选全 unknown 时记为 all_unknown（不可分配），与 evaluateOfferAcceptance
 *   的 unknown → agent_not_qualified 一致；unknown 永不判为可分配。
 * - 空根 requiredSkills 合法：仅 Capability 任务无 skill coverage 要求，uncovered=[]。
 *
 * 无 server 依赖、无 IO。下游 task-decomposition-policy 组合消费本模块结果。
 */

import type { AgentEligibilityState } from './agent-eligibility.js';

// ── AC#1：跨子 Task 联合覆盖 ──

export interface SkillCoverageUnionInput {
  /** 根 Task 声明的总体 Skill coverage target（根 TaskCoordinationDto.requiredSkills）。 */
  readonly rootRequiredSkills: readonly string[];
  /** 每个可执行子 Task 的 requiredSkills；其并集需覆盖根 coverage。 */
  readonly subtaskRequiredSkills: readonly (readonly string[])[];
}

export interface SkillCoverageUnionResult {
  /** 被至少一个子 Task 覆盖的根 skill（小写、去重保序）。 */
  readonly covered: readonly string[];
  /** 未被任何子 Task 覆盖的根 skill（小写、去重保序）。空 = 联合覆盖完整。 */
  readonly uncovered: readonly string[];
}

/**
 * AC#1：判定子 Task skills 并集是否覆盖根 coverage target。
 * 小写折叠后求子 Task 并集，遍历根 requiredSkills 分 covered/uncovered（去重保序）。
 * 空根 → uncovered=[]（合法，仅 Capability 任务）。子 Task 声明根未要求的 skill（over-cover）
 * 不影响 uncovered（只校验根 coverage 是否被覆盖）。
 */
export function evaluateSkillCoverageUnion(input: SkillCoverageUnionInput): SkillCoverageUnionResult {
  const subtaskUnion = new Set<string>();
  for (const group of input.subtaskRequiredSkills) {
    for (const raw of group) {
      if (typeof raw === 'string' && raw.length > 0) subtaskUnion.add(raw.toLowerCase());
    }
  }
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const raw of input.rootRequiredSkills) {
    if (typeof raw !== 'string') continue;
    const lower = raw.toLowerCase();
    if (subtaskUnion.has(lower)) {
      if (!covered.includes(lower)) covered.push(lower);
    } else if (!uncovered.includes(lower)) {
      uncovered.push(lower);
    }
  }
  return { covered, uncovered };
}

// ── AC#2：整图可执行子 Task 可分配性 ──

export interface ExecutableSubtaskCandidateView {
  readonly subtaskKey: string;
  /** 该子 Task 的每个候选 Agent 的 eligibility state（来自 evaluateAgentEligibility）。 */
  readonly candidateEligibility: readonly { readonly state: AgentEligibilityState }[];
}

export interface ExecutableSubtaskCoverageInput {
  readonly executableSubtasks: readonly ExecutableSubtaskCandidateView[];
}

export type UnallocatableCause =
  | 'no_candidate' // 无任何候选 Agent
  | 'no_qualified_candidate' // 有候选但无 qualified（含纯 not_qualified，或 unknown+not_qualified 混合）
  | 'all_unknown'; // 候选全 unknown（fail-closed：未知不分配）

export interface UnallocatableSubtask {
  readonly subtaskKey: string;
  readonly cause: UnallocatableCause;
}

export type ExecutableSubtaskCoverageResult =
  | { readonly kind: 'fully_allocatable' }
  | {
      readonly kind: 'unallocatable_subtasks_present';
      readonly unallocatableSubtasks: readonly UnallocatableSubtask[];
    };

/**
 * AC#2：判定每个可执行子 Task 是否都有至少一个 qualified 候选。
 * - 有候选且含 qualified → 该节点可分配。
 * - 无候选 → no_candidate。
 * - 无 qualified 且全 unknown → all_unknown（fail-closed，未知不分配）。
 * - 无 qualified 且含 not_qualified → no_qualified_candidate。
 * 全部可执行节点可分配 → fully_allocatable；否则按原顺序列出不可分配节点。
 */
export function evaluateExecutableSubtaskCoverage(
  input: ExecutableSubtaskCoverageInput,
): ExecutableSubtaskCoverageResult {
  const unallocatable: UnallocatableSubtask[] = [];
  for (const subtask of input.executableSubtasks) {
    const candidates = subtask.candidateEligibility;
    if (candidates.length === 0) {
      unallocatable.push({ subtaskKey: subtask.subtaskKey, cause: 'no_candidate' });
      continue;
    }
    if (candidates.some((c) => c.state === 'qualified')) continue;
    const allUnknown = candidates.every((c) => c.state === 'unknown');
    unallocatable.push({
      subtaskKey: subtask.subtaskKey,
      cause: allUnknown ? 'all_unknown' : 'no_qualified_candidate',
    });
  }
  if (unallocatable.length === 0) return { kind: 'fully_allocatable' };
  return { kind: 'unallocatable_subtasks_present', unallocatableSubtasks: unallocatable };
}
