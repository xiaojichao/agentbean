import { describe, expect, test } from 'vitest';

import {
  evaluateTaskDag,
  type EvaluateTaskDagInput,
  type TaskDagNode,
} from '../src/index.js';

const limits = {
  maxDepth: 3,
  maxFanOut: 8,
  maxOpenTasks: 20,
};

function node(
  taskId: string,
  overrides: Partial<TaskDagNode> = {},
): TaskDagNode {
  return {
    taskId,
    dependencyTaskIds: [],
    isTerminal: false,
    ...overrides,
  };
}

function input(overrides: Partial<EvaluateTaskDagInput> = {}): EvaluateTaskDagInput {
  return {
    rootTaskId: 'root',
    nodes: [
      node('root'),
      node('research', { parentTaskId: 'root' }),
      node('write', { parentTaskId: 'root', dependencyTaskIds: ['research'] }),
    ],
    limits,
    invocationBudget: { consumed: 2, reserved: 1, limit: 4 },
    ...overrides,
  };
}

describe('Phase 2 Task DAG policy', () => {
  test('accepts an acyclic graph inside every configured boundary', () => {
    expect(evaluateTaskDag(input())).toEqual({ kind: 'valid' });
  });

  test.each([
    [[node('root'), node('root')], 'duplicate-task'],
    [[node('root'), node('child', { parentTaskId: 'missing' })], 'parent-not-found'],
    [[node('root', { dependencyTaskIds: ['missing'] })], 'dependency-not-found'],
    [[node('root', { dependencyTaskIds: ['root'] })], 'self-dependency'],
  ] as const)('rejects malformed graph identity: %s', (nodes, reason) => {
    expect(evaluateTaskDag(input({ nodes }))).toEqual({ kind: 'rejected', reason });
  });

  test('requires exactly one explicit root', () => {
    expect(evaluateTaskDag(input({ rootTaskId: 'missing' })))
      .toEqual({ kind: 'rejected', reason: 'invalid-root' });
    expect(evaluateTaskDag(input({
      nodes: [node('root'), node('orphan-root')],
    }))).toEqual({ kind: 'rejected', reason: 'invalid-root' });
  });

  test('rejects parent cycles', () => {
    expect(evaluateTaskDag(input({
      nodes: [
        node('root'),
        node('a', { parentTaskId: 'b' }),
        node('b', { parentTaskId: 'a' }),
      ],
    }))).toEqual({ kind: 'rejected', reason: 'parent-cycle' });
  });

  test('rejects dependency cycles', () => {
    expect(evaluateTaskDag(input({
      nodes: [
        node('root'),
        node('a', { parentTaskId: 'root', dependencyTaskIds: ['b'] }),
        node('b', { parentTaskId: 'root', dependencyTaskIds: ['c'] }),
        node('c', { parentTaskId: 'root', dependencyTaskIds: ['a'] }),
      ],
    }))).toEqual({ kind: 'rejected', reason: 'dependency-cycle' });
  });

  test('allows depth three and rejects depth four', () => {
    const depthThree = [
      node('root'),
      node('level-1', { parentTaskId: 'root' }),
      node('level-2', { parentTaskId: 'level-1' }),
      node('level-3', { parentTaskId: 'level-2' }),
    ];
    expect(evaluateTaskDag(input({ nodes: depthThree }))).toEqual({ kind: 'valid' });
    expect(evaluateTaskDag(input({
      nodes: [...depthThree, node('level-4', { parentTaskId: 'level-3' })],
    }))).toEqual({ kind: 'rejected', reason: 'max-depth-exceeded' });
  });

  test('allows eight direct children and rejects nine', () => {
    const children = Array.from({ length: 9 }, (_, index) => node(`child-${index}`, {
      parentTaskId: 'root',
    }));
    expect(evaluateTaskDag(input({ nodes: [node('root'), ...children.slice(0, 8)] })))
      .toEqual({ kind: 'valid' });
    expect(evaluateTaskDag(input({ nodes: [node('root'), ...children] })))
      .toEqual({ kind: 'rejected', reason: 'max-fan-out-exceeded' });
  });

  test('counts only unfinished tasks against the open-node limit', () => {
    const twentyChildren = Array.from({ length: 20 }, (_, index) => node(`open-${index}`, {
      parentTaskId: 'root',
    }));
    const openLimit = { ...limits, maxFanOut: 21 };
    expect(evaluateTaskDag(input({
      nodes: [node('root'), ...twentyChildren, node('done', {
        parentTaskId: 'root',
        isTerminal: true,
      })],
      limits: openLimit,
    }))).toEqual({ kind: 'valid' });
    expect(evaluateTaskDag(input({
      nodes: [node('root'), ...twentyChildren, node('overflow', { parentTaskId: 'root' })],
      limits: openLimit,
    }))).toEqual({ kind: 'rejected', reason: 'max-open-tasks-exceeded' });
  });

  test('fails closed when consumed plus reserved Invocations exceed the budget', () => {
    expect(evaluateTaskDag(input({
      invocationBudget: { consumed: 3, reserved: 1, limit: 4 },
    }))).toEqual({ kind: 'valid' });
    expect(evaluateTaskDag(input({
      invocationBudget: { consumed: 3, reserved: 2, limit: 4 },
    }))).toEqual({ kind: 'rejected', reason: 'invocation-budget-exceeded' });
  });

  test('invalid limits and counters fail closed', () => {
    expect(evaluateTaskDag(input({
      limits: { ...limits, maxDepth: -1 },
    }))).toEqual({ kind: 'rejected', reason: 'invalid-limit' });
    expect(evaluateTaskDag(input({
      invocationBudget: { consumed: -1, reserved: 0, limit: 4 },
    }))).toEqual({ kind: 'rejected', reason: 'invalid-limit' });
  });
});
