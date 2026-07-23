import { describe, expect, test } from 'vitest';

import { evaluateTaskDecomposability } from '../src/task-decomposition-policy.js';
import type {
  ExecutableSubtaskCoverageResult,
  SkillCoverageUnionResult,
} from '../src/task-coverage-policy.js';

const coverageOk: SkillCoverageUnionResult = { covered: ['a', 'b'], uncovered: [] };
const coverageGap: SkillCoverageUnionResult = { covered: ['a'], uncovered: ['b'] };
const allocatable: ExecutableSubtaskCoverageResult = { kind: 'fully_allocatable' };
const unallocatable: ExecutableSubtaskCoverageResult = {
  kind: 'unallocatable_subtasks_present',
  unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'no_candidate' }],
};

describe('evaluateTaskDecomposability', () => {
  test('atomicityHint=atomic → not_decomposable（AC#4 不强拆，短路）', () => {
    const result = evaluateTaskDecomposability({
      atomicityHint: 'atomic',
      coverage: coverageGap,
      allocatability: unallocatable,
    });
    expect(result).toEqual({ kind: 'not_decomposable', reason: 'atomicity_hint' });
  });

  test('decomposable + coverage 全覆盖 + 全可分配 → decomposable', () => {
    const result = evaluateTaskDecomposability({
      atomicityHint: 'decomposable',
      coverage: coverageOk,
      allocatability: allocatable,
    });
    expect(result).toEqual({ kind: 'decomposable' });
  });

  test('decomposable + 仅 coverage gap → union_coverage_gap（携带 uncoveredSkills）', () => {
    const result = evaluateTaskDecomposability({
      atomicityHint: 'decomposable',
      coverage: coverageGap,
      allocatability: allocatable,
    });
    expect(result).toEqual({
      kind: 'needs_user_adjustment',
      reason: 'union_coverage_gap',
      uncoveredSkills: ['b'],
    });
  });

  test('decomposable + 仅不可分配子 Task → unallocatable_subtasks（携带诊断）', () => {
    const result = evaluateTaskDecomposability({
      atomicityHint: 'decomposable',
      coverage: coverageOk,
      allocatability: unallocatable,
    });
    expect(result).toEqual({
      kind: 'needs_user_adjustment',
      reason: 'unallocatable_subtasks',
      unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'no_candidate' }],
    });
  });

  test('decomposable + coverage gap + 不可分配 → coverage_and_allocation（携带两者）', () => {
    const result = evaluateTaskDecomposability({
      atomicityHint: 'decomposable',
      coverage: coverageGap,
      allocatability: unallocatable,
    });
    expect(result).toEqual({
      kind: 'needs_user_adjustment',
      reason: 'coverage_and_allocation',
      uncoveredSkills: ['b'],
      unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'no_candidate' }],
    });
  });

  test('atomic 短路优先级高于一切：即使 coverage+alloc 全绿也 not_decomposable', () => {
    const result = evaluateTaskDecomposability({
      atomicityHint: 'atomic',
      coverage: coverageOk,
      allocatability: allocatable,
    });
    expect(result).toEqual({ kind: 'not_decomposable', reason: 'atomicity_hint' });
  });
});
