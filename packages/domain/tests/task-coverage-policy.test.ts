import { describe, expect, test } from 'vitest';

import {
  evaluateExecutableSubtaskCoverage,
  evaluateSkillCoverageUnion,
} from '../src/task-coverage-policy.js';

describe('evaluateSkillCoverageUnion', () => {
  test('空根 requiredSkills → uncovered 为空（仅 Capability 任务无 coverage 要求）', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: [],
      subtaskRequiredSkills: [['a'], ['b']],
    });
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toEqual([]);
  });

  test('子 Task skills 并集完全覆盖根 → uncovered 为空', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['a', 'b', 'c'],
      subtaskRequiredSkills: [['a', 'b'], ['c']],
    });
    expect(result.covered).toEqual(['a', 'b', 'c']);
    expect(result.uncovered).toEqual([]);
  });

  test('子 Task skills 并集部分覆盖根 → uncovered 列出缺失', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['a', 'b', 'c'],
      subtaskRequiredSkills: [['a']],
    });
    expect(result.covered).toEqual(['a']);
    expect(result.uncovered).toEqual(['b', 'c']);
  });

  test('大小写不敏感：根 [A,B] 与子 [a,b] 匹配', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['A', 'B'],
      subtaskRequiredSkills: [['a'], ['b']],
    });
    expect(result.covered).toEqual(['a', 'b']);
    expect(result.uncovered).toEqual([]);
  });

  test('根 requiredSkills 去重保序', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['a', 'b', 'a'],
      subtaskRequiredSkills: [['a', 'b']],
    });
    expect(result.covered).toEqual(['a', 'b']);
    expect(result.uncovered).toEqual([]);
  });

  test('子 Task 声明根未要求的 skill（over-cover）不影响 uncovered', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['a'],
      subtaskRequiredSkills: [['a', 'x', 'y']],
    });
    expect(result.covered).toEqual(['a']);
    expect(result.uncovered).toEqual([]);
  });

  test('空子 Task 列表 + 非空根 → 全 uncovered', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['a', 'b'],
      subtaskRequiredSkills: [],
    });
    expect(result.covered).toEqual([]);
    expect(result.uncovered).toEqual(['a', 'b']);
  });

  test('子 Task 空数组（skill 声明为空）不贡献覆盖', () => {
    const result = evaluateSkillCoverageUnion({
      rootRequiredSkills: ['a', 'b'],
      subtaskRequiredSkills: [['a'], []],
    });
    expect(result.covered).toEqual(['a']);
    expect(result.uncovered).toEqual(['b']);
  });
});

describe('evaluateExecutableSubtaskCoverage', () => {
  test('空可执行子 Task 列表 → fully_allocatable', () => {
    const result = evaluateExecutableSubtaskCoverage({ executableSubtasks: [] });
    expect(result.kind).toBe('fully_allocatable');
  });

  test('每个可执行子 Task 至少一个 qualified 候选 → fully_allocatable', () => {
    const result = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 's1', candidateEligibility: [{ state: 'qualified' }, { state: 'not_qualified' }] },
        { subtaskKey: 's2', candidateEligibility: [{ state: 'qualified' }] },
      ],
    });
    expect(result.kind).toBe('fully_allocatable');
  });

  test('无候选 → no_candidate', () => {
    const result = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [{ subtaskKey: 's1', candidateEligibility: [] }],
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'no_candidate' }],
    });
  });

  test('候选全 not_qualified → no_qualified_candidate', () => {
    const result = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 's1', candidateEligibility: [{ state: 'not_qualified' }, { state: 'not_qualified' }] },
      ],
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'no_qualified_candidate' }],
    });
  });

  test('候选全 unknown → all_unknown（fail-closed，不可分配）', () => {
    const result = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 's1', candidateEligibility: [{ state: 'unknown' }, { state: 'unknown' }] },
      ],
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'all_unknown' }],
    });
  });

  test('unknown + not_qualified 混合（无 qualified）→ no_qualified_candidate（非全 unknown）', () => {
    const result = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 's1', candidateEligibility: [{ state: 'unknown' }, { state: 'not_qualified' }] },
      ],
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [{ subtaskKey: 's1', cause: 'no_qualified_candidate' }],
    });
  });

  test('多个不可分配子 Task 全部按序列出', () => {
    const result = evaluateExecutableSubtaskCoverage({
      executableSubtasks: [
        { subtaskKey: 's1', candidateEligibility: [] },
        { subtaskKey: 's2', candidateEligibility: [{ state: 'unknown' }] },
        { subtaskKey: 's3', candidateEligibility: [{ state: 'qualified' }] },
      ],
    });
    expect(result).toEqual({
      kind: 'unallocatable_subtasks_present',
      unallocatableSubtasks: [
        { subtaskKey: 's1', cause: 'no_candidate' },
        { subtaskKey: 's2', cause: 'all_unknown' },
      ],
    });
  });
});
