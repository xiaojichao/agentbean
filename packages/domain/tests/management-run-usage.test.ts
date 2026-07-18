import { describe, expect, test } from 'vitest';

import { deriveManagementRunUsage, type ManagementUsageEvent } from '../src/index.js';

// Phase 4 第二阶段切片4（#649）：Run 用量从既有 management events 派生（不建表）。
// 计数口径与 budget enforcement 逐维对齐（#660/#661 修复）：
// - maxFanOut ↔ evaluateTaskDag 的 limits.maxFanOut（budget.maxSubtasks 的实际 enforcement 维度：
//   单父子节点数峰值，而非 DAG 总节点数——宽 DAG 总数合法超 maxSubtasks 不得误报）
// - maxDepthReached ↔ evaluateTaskDag 的 depthOf（0-based 边深，root=0，拒绝条件 depthOf > maxDepth：
//   合法满链 maxDepth+1 个节点得到 maxDepthReached === maxDepth，不得误报）
// - externalInvocationCount ↔ invocations 记录数（invocation-created 事件数）

function taskCreated(taskId: string, parentTaskId?: string): ManagementUsageEvent {
  return { type: 'task-created', payload: { taskId, ...(parentTaskId ? { parentTaskId } : {}) } };
}

describe('deriveManagementRunUsage', () => {
  test('空 run（无事件）→ 全零', () => {
    expect(deriveManagementRunUsage([])).toEqual({
      maxFanOut: 0, externalInvocationCount: 0, maxDepthReached: 0,
    });
  });

  test('无子任务（仅 root task-created）→ 扇出 0、深度 0（root 边深为 0）', () => {
    expect(deriveManagementRunUsage([taskCreated('root')])).toEqual({
      maxFanOut: 0, externalInvocationCount: 0, maxDepthReached: 0,
    });
  });

  test('单链 root→a→b → 扇出 1、深度 2（0-based 边深，同 evaluateTaskDag depthOf）', () => {
    expect(deriveManagementRunUsage([
      taskCreated('root'),
      taskCreated('a', 'root'),
      taskCreated('b', 'a'),
    ])).toMatchObject({ maxFanOut: 1, maxDepthReached: 2 });
  });

  test('多分支取峰值：root→{a,b}、a→c → 扇出 2（root 的子节点数）、深度 2', () => {
    expect(deriveManagementRunUsage([
      taskCreated('root'),
      taskCreated('a', 'root'),
      taskCreated('b', 'root'),
      taskCreated('c', 'a'),
    ])).toMatchObject({ maxFanOut: 2, maxDepthReached: 2 });
  });

  test('宽 DAG：扇出峰值 ≠ 总节点数（root→{a,b}、a→{c,d,e} 共 5 子节点，峰值为 a 的 3）', () => {
    expect(deriveManagementRunUsage([
      taskCreated('root'),
      taskCreated('a', 'root'),
      taskCreated('b', 'root'),
      taskCreated('c', 'a'),
      taskCreated('d', 'a'),
      taskCreated('e', 'a'),
    ])).toMatchObject({ maxFanOut: 3, maxDepthReached: 2 });
  });

  test('事件乱序（子先于父到达）仍算对深度与扇出', () => {
    expect(deriveManagementRunUsage([
      taskCreated('b', 'a'),
      taskCreated('a', 'root'),
      taskCreated('root'),
    ])).toMatchObject({ maxFanOut: 1, maxDepthReached: 2 });
  });

  test('enforcement 口径边界：maxDepth=3 的合法满链 root→a→b→c → maxDepthReached=3（== maxDepth 不超限）', () => {
    // evaluateTaskDag 拒绝条件为 depthOf > maxDepth，链 root→a→b→c 的 depthOf(c)=3 合法；
    // usage 必须同样报 3，否则展示层（> maxDepth 标红）会把合法满负载误报为超限（#660）。
    expect(deriveManagementRunUsage([
      taskCreated('root'),
      taskCreated('a', 'root'),
      taskCreated('b', 'a'),
      taskCreated('c', 'b'),
    ])).toMatchObject({ maxDepthReached: 3 });
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
      maxFanOut: 0, externalInvocationCount: 0, maxDepthReached: 0,
    });
  });
});
