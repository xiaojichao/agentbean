// Phase 4 第二阶段切片4（#649）：Run 用量从既有 management events 派生。
// 纯派生不建表；输入只依赖事件 type 与 task-created payload 的 taskId/parentTaskId。
// 计数口径与 budget enforcement（evaluateTaskDag / invocations 记录数）逐维对齐（#660/#661 修复）：
// - maxFanOut ↔ limits.maxFanOut（budget.maxSubtasks 的实际 enforcement 维度，单父子节点数峰值）；
//   修复前用 DAG 子节点总数对照 maxSubtasks，宽 DAG 合法状态下常态误报超限。
// - maxDepthReached ↔ evaluateTaskDag 的 depthOf（0-based 边深，root=0，拒绝条件 depthOf > maxDepth）；
//   修复前用 1-based 节点数，合法满链（maxDepth+1 节点）显示 maxDepth+1/maxDepth 误报超限。
// - externalInvocationCount ↔ invocations 记录数（invocation-created 一 invocation 一事件，幂等键锁死）。

export interface ManagementUsageEvent {
  readonly type: string;
  readonly payload?: {
    readonly taskId?: string;
    readonly parentTaskId?: string;
  };
}

export interface ManagementRunUsage {
  /** 单父扇出峰值（与 budget.maxSubtasks 的 maxFanOut enforcement 口径对齐）。 */
  readonly maxFanOut: number;
  readonly externalInvocationCount: number;
  /** 最深节点的边深（root=0，与 evaluateTaskDag depthOf 口径对齐；无事件则 0）。 */
  readonly maxDepthReached: number;
}

/** 从 run 的 management events 派生用量计数（口径与 budget enforcement 对齐，见文件头注释）。 */
export function deriveManagementRunUsage(events: readonly ManagementUsageEvent[]): ManagementRunUsage {
  const depthByTaskId = new Map<string, number>();
  let externalInvocationCount = 0;

  // task-created 乱序到达也能算对：先建 parent 索引，再惰性求深度（带环防御）。
  const parentByTaskId = new Map<string, string | undefined>();
  for (const event of events) {
    if (event.type === 'task-created' && event.payload?.taskId) {
      if (!parentByTaskId.has(event.payload.taskId)) {
        parentByTaskId.set(event.payload.taskId, event.payload.parentTaskId);
      }
    } else if (event.type === 'invocation-created') {
      externalInvocationCount += 1;
    }
  }

  // 0-based 边深（root=0）：与 evaluateTaskDag 的 depthOf 逐节点一致，
  // 合法满链（maxDepth+1 个节点）得到 maxDepthReached === maxDepth，不误报超限。
  const computeDepth = (taskId: string, visiting: Set<string>): number => {
    const cached = depthByTaskId.get(taskId);
    if (cached !== undefined) return cached;
    if (visiting.has(taskId)) return 0; // 环防御：截断（数据正常时不可达）
    const parent = parentByTaskId.get(taskId);
    const depth = parent === undefined || !parentByTaskId.has(parent)
      ? 0
      : 1 + computeDepth(parent, new Set([...visiting, taskId]));
    depthByTaskId.set(taskId, depth);
    return depth;
  };

  // 单父扇出峰值：与 limits.maxFanOut 同维度（宽 DAG 的总节点数合法超过 maxSubtasks，
  // 但任一单父的子节点数不会——enforcement 逐父拒绝）。
  const childCountByParentId = new Map<string, number>();
  for (const parent of parentByTaskId.values()) {
    if (parent === undefined) continue;
    childCountByParentId.set(parent, (childCountByParentId.get(parent) ?? 0) + 1);
  }

  let maxDepthReached = 0;
  let maxFanOut = 0;
  for (const taskId of parentByTaskId.keys()) {
    maxDepthReached = Math.max(maxDepthReached, computeDepth(taskId, new Set()));
  }
  for (const count of childCountByParentId.values()) {
    maxFanOut = Math.max(maxFanOut, count);
  }
  return { maxFanOut, externalInvocationCount, maxDepthReached };
}
