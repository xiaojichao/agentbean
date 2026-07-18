// Phase 4 第二阶段切片4（#649）：Run 用量从既有 management events 派生。
// 计数口径与 budget enforcement 对齐（evaluateTaskDag / invocations 记录数），
// 纯派生不建表；输入只依赖事件 type 与 task-created payload 的 taskId/parentTaskId。

export interface ManagementUsageEvent {
  readonly type: string;
  readonly payload?: {
    readonly taskId?: string;
    readonly parentTaskId?: string;
  };
}

export interface ManagementRunUsage {
  readonly subtaskCount: number;
  readonly externalInvocationCount: number;
  readonly maxDepthReached: number;
}

/** 从 run 的 management events 派生用量计数（root 深度 1；无 root 事件则深度 0）。 */
export function deriveManagementRunUsage(events: readonly ManagementUsageEvent[]): ManagementRunUsage {
  const depthByTaskId = new Map<string, number>();
  let subtaskCount = 0;
  let externalInvocationCount = 0;

  // task-created 乱序到达也能算对：先建 parent 索引，再惰性求深度（带环防御）。
  const parentByTaskId = new Map<string, string | undefined>();
  for (const event of events) {
    if (event.type === 'task-created' && event.payload?.taskId) {
      if (!parentByTaskId.has(event.payload.taskId)) {
        parentByTaskId.set(event.payload.taskId, event.payload.parentTaskId);
        if (event.payload.parentTaskId) subtaskCount += 1;
      }
    } else if (event.type === 'invocation-created') {
      externalInvocationCount += 1;
    }
  }

  const computeDepth = (taskId: string, visiting: Set<string>): number => {
    const cached = depthByTaskId.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 1; // 环防御：截断（数据正常时不可达）
    const parent = parentByTaskId.get(taskId);
    const depth = parent === undefined || !parentByTaskId.has(parent)
      ? 1
      : 1 + computeDepth(parent, new Set([...visiting, taskId]));
    depthByTaskId.set(taskId, depth);
    return depth;
  };

  let maxDepthReached = 0;
  for (const taskId of parentByTaskId.keys()) {
    maxDepthReached = Math.max(maxDepthReached, computeDepth(taskId, new Set()));
  }
  return { subtaskCount, externalInvocationCount, maxDepthReached };
}
