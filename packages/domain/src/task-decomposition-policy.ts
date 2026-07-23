/**
 * #715 Task 可拆分性判断 —— 纯规则（切片 C 规划期决策层，AC#4）。
 *
 * 职责：在 PI 把根 Task 拆成子 Task 前，判定该工作是否允许拆分，以及拆分后是否
 * 存在完整候选。组合消费 task-coverage-policy 的两个结果，不重新计算覆盖/分配。
 *
 * 关键不变量（ADR 0021）：
 * - 「语义/安全/事务不可拆分」是 PI 模型的客观判断（domain 无文本理解能力），由调用方
 *   以 `atomicityHint: 'atomic'` 传入；domain 据此返回 not_decomposable（不强拆），即使
 *   覆盖/分配失败也短路。与 reviewPolicy / highRisk 同样的「调用方传标记、domain 裁决」分离。
 * - 「无完整候选 → 请求用户调整」由结构性信号判定：coverage 有 uncovered skill，或
 *   存在不可分配的可执行子 Task。两种都失败时合并诊断（coverage_and_allocation）。
 * - 不做技能重叠启发式推断原子性（不可测、违反纯函数边界）。
 *
 * 无 server 依赖、无 IO。
 */

import type {
  ExecutableSubtaskCoverageResult,
  SkillCoverageUnionResult,
  UnallocatableSubtask,
} from './task-coverage-policy.js';

// ── AC#4：可拆分性裁决 ──

/**
 * 调用方提供的原子性提示。PI 模型拥有 objective 文本与领域上下文，是唯一能判定
 * 「语义/安全/事务不可拆分」的层；domain 只消费该信号。
 */
export type TaskAtomicityHint = 'atomic' | 'decomposable';

export interface TaskDecomposabilityInput {
  readonly atomicityHint: TaskAtomicityHint;
  /** AC#1 结果：子 Task skills 并集 vs 根 coverage target。 */
  readonly coverage: SkillCoverageUnionResult;
  /** AC#2 结果：可执行子 Task 是否都有 qualified 候选。 */
  readonly allocatability: ExecutableSubtaskCoverageResult;
}

export type TaskNotDecomposableReason = 'atomicity_hint';

export type TaskNeedsUserAdjustmentReason =
  | 'union_coverage_gap' // 子 Task skills 并集未覆盖根 coverage
  | 'unallocatable_subtasks' // 存在无可分配 qualified 候选的可执行子 Task
  | 'coverage_and_allocation'; // 两者同时失败

export type TaskDecomposabilityDecision =
  | { readonly kind: 'decomposable' }
  | { readonly kind: 'not_decomposable'; readonly reason: TaskNotDecomposableReason }
  | {
      readonly kind: 'needs_user_adjustment';
      readonly reason: TaskNeedsUserAdjustmentReason;
      readonly uncoveredSkills?: readonly string[];
      readonly unallocatableSubtasks?: readonly UnallocatableSubtask[];
    };

/**
 * AC#4：判定根 Task 是否可拆分、拆分后是否存在完整候选。
 *
 * 决策顺序：
 * 1. atomicityHint='atomic' → not_decomposable（AC#4「不可拆分 → 不强拆」，短路）。
 * 2. coverage 有 uncovered 且存在不可分配子 Task → coverage_and_allocation（携带两者诊断）。
 * 3. 仅 coverage 有 uncovered → union_coverage_gap。
 * 4. 仅存在不可分配子 Task → unallocatable_subtasks。
 * 5. 否则 → decomposable。
 */
export function evaluateTaskDecomposability(input: TaskDecomposabilityInput): TaskDecomposabilityDecision {
  if (input.atomicityHint === 'atomic') {
    return { kind: 'not_decomposable', reason: 'atomicity_hint' };
  }
  const hasCoverageGap = input.coverage.uncovered.length > 0;
  const unallocatableSubtasks: readonly UnallocatableSubtask[] =
    input.allocatability.kind === 'unallocatable_subtasks_present'
      ? input.allocatability.unallocatableSubtasks
      : [];
  const hasUnallocatable = unallocatableSubtasks.length > 0;

  if (hasCoverageGap && hasUnallocatable) {
    return {
      kind: 'needs_user_adjustment',
      reason: 'coverage_and_allocation',
      uncoveredSkills: input.coverage.uncovered,
      unallocatableSubtasks,
    };
  }
  if (hasCoverageGap) {
    return {
      kind: 'needs_user_adjustment',
      reason: 'union_coverage_gap',
      uncoveredSkills: input.coverage.uncovered,
    };
  }
  if (hasUnallocatable) {
    return {
      kind: 'needs_user_adjustment',
      reason: 'unallocatable_subtasks',
      unallocatableSubtasks,
    };
  }
  return { kind: 'decomposable' };
}
