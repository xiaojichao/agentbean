import { describe, expect, test } from 'vitest';

import {
  authorizeTaskRevision,
  evaluateTaskRevisionChange,
  type EvaluateTaskRevisionChangeInput,
  type TaskRevisionSemanticState,
} from '../src/index.js';

const current: TaskRevisionSemanticState = {
  objective: '完成研究并提交报告',
  acceptanceCriteria: [{
    id: 'criterion-1',
    description: '报告包含来源',
    evidenceRequired: true,
    allowedEvidenceKinds: ['artifact', 'message'],
  }],
  dependencyTaskIds: ['dependency-1'],
  claimPolicy: 'open',
};

function input(
  overrides: Partial<EvaluateTaskRevisionChangeInput> = {},
): EvaluateTaskRevisionChangeInput {
  return {
    currentRevision: 2,
    expectedRevision: 2,
    current,
    next: current,
    retiredCriterionIds: [],
    ...overrides,
  };
}

describe('Phase 2 Task revision policy', () => {
  test('semantic no-op preserves revision and criterion identity', () => {
    expect(evaluateTaskRevisionChange(input({
      next: {
        ...current,
        dependencyTaskIds: ['dependency-1'],
        acceptanceCriteria: [{
          ...current.acceptanceCriteria[0]!,
          allowedEvidenceKinds: ['message', 'artifact'],
        }],
      },
    }))).toEqual({ kind: 'unchanged', revision: 2 });
  });

  test.each([
    ['objective', { ...current, objective: '修改后的目标' }],
    ['dependency', { ...current, dependencyTaskIds: ['dependency-2'] }],
    ['claim policy', { ...current, claimPolicy: 'targeted', assigneeId: 'agent-1' }],
  ] as const)('%s semantic change increments the revision', (_name, next) => {
    expect(evaluateTaskRevisionChange(input({ next }))).toEqual({
      kind: 'revised',
      revision: 3,
      retiredCriterionIds: [],
    });
  });

  test('changed criterion semantics require a new identity', () => {
    expect(evaluateTaskRevisionChange(input({
      next: {
        ...current,
        acceptanceCriteria: [{
          ...current.acceptanceCriteria[0]!,
          description: '报告包含两个来源',
        }],
      },
    }))).toEqual({ kind: 'rejected', reason: 'criterion-id-reused' });

    expect(evaluateTaskRevisionChange(input({
      next: {
        ...current,
        acceptanceCriteria: [{
          ...current.acceptanceCriteria[0]!,
          id: 'criterion-2',
          description: '报告包含两个来源',
        }],
      },
    }))).toEqual({
      kind: 'revised',
      revision: 3,
      retiredCriterionIds: ['criterion-1'],
    });
  });

  test('removed criterion identities become retired and cannot be reused', () => {
    expect(evaluateTaskRevisionChange(input({
      next: { ...current, acceptanceCriteria: [] },
    }))).toEqual({
      kind: 'revised',
      revision: 3,
      retiredCriterionIds: ['criterion-1'],
    });
    expect(evaluateTaskRevisionChange(input({
      retiredCriterionIds: ['criterion-retired'],
      next: {
        ...current,
        acceptanceCriteria: [{
          ...current.acceptanceCriteria[0]!,
          id: 'criterion-retired',
        }],
      },
    }))).toEqual({ kind: 'rejected', reason: 'retired-criterion-id-reused' });
  });

  test('duplicate current or next criterion IDs fail closed', () => {
    const duplicate = [
      current.acceptanceCriteria[0]!,
      current.acceptanceCriteria[0]!,
    ];
    expect(evaluateTaskRevisionChange(input({
      current: { ...current, acceptanceCriteria: duplicate },
    }))).toEqual({ kind: 'rejected', reason: 'invalid-criterion-identity' });
    expect(evaluateTaskRevisionChange(input({
      next: { ...current, acceptanceCriteria: duplicate },
    }))).toEqual({ kind: 'rejected', reason: 'invalid-criterion-identity' });
  });

  test('optimistic revision conflicts distinguish stale and future writers', () => {
    expect(evaluateTaskRevisionChange(input({ expectedRevision: 1 })))
      .toEqual({ kind: 'rejected', reason: 'stale-revision' });
    expect(evaluateTaskRevisionChange(input({ expectedRevision: 3 })))
      .toEqual({ kind: 'rejected', reason: 'future-revision' });
  });

  test('invalid and overflowing revisions fail closed', () => {
    expect(evaluateTaskRevisionChange(input({ currentRevision: 0, expectedRevision: 0 })))
      .toEqual({ kind: 'rejected', reason: 'invalid-revision' });
    expect(evaluateTaskRevisionChange(input({
      currentRevision: Number.MAX_SAFE_INTEGER,
      expectedRevision: Number.MAX_SAFE_INTEGER,
      next: { ...current, objective: 'changed' },
    }))).toEqual({ kind: 'rejected', reason: 'revision-overflow' });
  });

  test('authority is valid only for the exact current revision', () => {
    expect(authorizeTaskRevision({ currentRevision: 3, presentedRevision: 3 }))
      .toEqual({ kind: 'authorized', revision: 3 });
    expect(authorizeTaskRevision({ currentRevision: 3, presentedRevision: 2 }))
      .toEqual({ kind: 'rejected', reason: 'stale-revision' });
    expect(authorizeTaskRevision({ currentRevision: 3, presentedRevision: 4 }))
      .toEqual({ kind: 'rejected', reason: 'future-revision' });
  });
});
