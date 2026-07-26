import { describe, expect, test } from 'vitest';

import { projectStageTaskProjection } from '../src/project-stage-policy.js';

describe('Project Stage Task 聚合', () => {
  test.each([
    ['todo', 'pending', ['task_not_started']],
    ['in_progress', 'active', []],
    ['in_review', 'in_review', ['review_pending']],
    ['done', 'complete', []],
    ['closed', 'complete', []],
  ] as const)('只从 canonical TaskStatus %s 派生 %s', (taskStatus, aggregateStatus, reasonCodes) => {
    const projection = projectStageTaskProjection({ taskId: 'task-1', taskStatus });
    expect(projection.aggregateStatus).toBe(aggregateStatus);
    expect(projection.blockingReasons.map((reason) => reason.code)).toEqual(reasonCodes);
  });

  test('未完成依赖和审核事实覆盖基础 Task 投影并给出可解释阻塞', () => {
    expect(projectStageTaskProjection({
      taskId: 'task-1',
      taskStatus: 'done',
      dependencies: [{ taskId: 'dependency-1', status: 'in_progress' }],
      reviewDecision: 'rejected',
    })).toEqual({
      aggregateStatus: 'in_review',
      blockingReasons: [
        { code: 'dependency_incomplete', taskId: 'task-1', dependencyTaskId: 'dependency-1' },
        { code: 'review_rejected', taskId: 'task-1' },
      ],
    });
  });
});
