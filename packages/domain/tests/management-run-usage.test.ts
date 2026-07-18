import { describe, expect, test } from 'vitest';

import { deriveManagementRunUsage, type ManagementUsageEvent } from '../src/index.js';

// Phase 4 第二阶段切片4（#649）：Run 用量从既有 management events 派生（不建表）。
// 计数口径与 budget enforcement 对齐：
// - 子任务数 ↔ evaluateTaskDag 的 maxFanOut/maxOpenTasks（task-created 且带 parentTaskId）
// - 外部调用数 ↔ invocations 记录数（invocation-created 事件数）
// - 深度峰值 ↔ evaluateTaskDag 的 maxDepth（task-created 的 parent 链最深值，root 深度 1）

function taskCreated(taskId: string, parentTaskId?: string): ManagementUsageEvent {
  return { type: 'task-created', payload: { taskId, ...(parentTaskId ? { parentTaskId } : {}) } };
}

describe('deriveManagementRunUsage', () => {
  test('空 run（无事件）→ 全零', () => {
    expect(deriveManagementRunUsage([])).toEqual({
      subtaskCount: 0, externalInvocationCount: 0, maxDepthReached: 0,
    });
  });

  test('无子任务（仅 root task-created）→ 子任务 0、深度 1', () => {
    expect(deriveManagementRunUsage([taskCreated('root')])).toEqual({
      subtaskCount: 0, externalInvocationCount: 0, maxDepthReached: 1,
    });
  });

  test('单链 root→a→b → 子任务 2、深度 3', () => {
    expect(deriveManagementRunUsage([
      taskCreated('root'),
      taskCreated('a', 'root'),
      taskCreated('b', 'a'),
    ])).toMatchObject({ subtaskCount: 2, maxDepthReached: 3 });
  });

  test('多分支取峰值：root→{a,b}、a→c → 子任务 3、深度 3（非宽度）', () => {
    expect(deriveManagementRunUsage([
      taskCreated('root'),
      taskCreated('a', 'root'),
      taskCreated('b', 'root'),
      taskCreated('c', 'a'),
    ])).toMatchObject({ subtaskCount: 3, maxDepthReached: 3 });
  });

  test('事件乱序（子先于父到达）仍算对深度', () => {
    expect(deriveManagementRunUsage([
      taskCreated('b', 'a'),
      taskCreated('a', 'root'),
      taskCreated('root'),
    ])).toMatchObject({ subtaskCount: 2, maxDepthReached: 3 });
  });

  test('外部调用数 = invocation-created 计数（与 enforcement 的 invocations 记录数一致）', () => {
    const events: ManagementUsageEvent[] = [
      taskCreated('root'),
      { type: 'invocation-created', payload: {} },
      { type: 'invocation-created', payload: {} },
      { type: 'dispatch-attempt-completed', payload: {} },
      { type: 'run-completed', payload: {} },
    ];
    expect(deriveManagementRunUsage(events)).toMatchObject({ externalInvocationCount: 2 });
  });

  test('无关事件类型不影响计数', () => {
    const events: ManagementUsageEvent[] = [
      taskCreated('root'),
      { type: 'checkpoint-updated', payload: {} },
      { type: 'worker-leased', payload: {} },
      { type: 'memory-tool-completed', payload: {} },
    ];
    expect(deriveManagementRunUsage(events)).toEqual({
      subtaskCount: 0, externalInvocationCount: 0, maxDepthReached: 1,
    });
  });
});
