export interface TaskDagNode {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly dependencyTaskIds: readonly string[];
  readonly isTerminal: boolean;
}

export interface TaskDagLimits {
  readonly maxDepth: number;
  readonly maxFanOut: number;
  readonly maxOpenTasks: number;
}

export interface TaskDagInvocationBudget {
  readonly consumed: number;
  readonly reserved: number;
  readonly limit: number;
}

export interface EvaluateTaskDagInput {
  readonly rootTaskId: string;
  readonly nodes: readonly TaskDagNode[];
  readonly limits: TaskDagLimits;
  readonly invocationBudget: TaskDagInvocationBudget;
}

export type TaskDagRejection =
  | 'invalid-limit'
  | 'invalid-task'
  | 'invalid-root'
  | 'duplicate-task'
  | 'parent-not-found'
  | 'dependency-not-found'
  | 'duplicate-dependency'
  | 'self-dependency'
  | 'parent-cycle'
  | 'dependency-cycle'
  | 'max-depth-exceeded'
  | 'max-fan-out-exceeded'
  | 'max-open-tasks-exceeded'
  | 'invocation-budget-exceeded';

export type TaskDagDecision =
  | { readonly kind: 'valid' }
  | { readonly kind: 'rejected'; readonly reason: TaskDagRejection };

function isSafeNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validBoundaries(input: EvaluateTaskDagInput): boolean {
  return isSafeNonNegativeInteger(input.limits.maxDepth)
    && isSafeNonNegativeInteger(input.limits.maxFanOut)
    && isSafeNonNegativeInteger(input.limits.maxOpenTasks)
    && isSafeNonNegativeInteger(input.invocationBudget.consumed)
    && isSafeNonNegativeInteger(input.invocationBudget.reserved)
    && isSafeNonNegativeInteger(input.invocationBudget.limit)
    && Number.isSafeInteger(input.invocationBudget.consumed + input.invocationBudget.reserved);
}

function hasCycle(
  nodes: readonly TaskDagNode[],
  adjacent: (node: TaskDagNode) => readonly string[],
  byId: ReadonlyMap<string, TaskDagNode>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (taskId: string): boolean => {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    const node = byId.get(taskId);
    if (!node) return false;
    visiting.add(taskId);
    for (const nextId of adjacent(node)) {
      if (visit(nextId)) return true;
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  };

  return nodes.some((node) => visit(node.taskId));
}

export function evaluateTaskDag(input: EvaluateTaskDagInput): TaskDagDecision {
  if (!validBoundaries(input)) return { kind: 'rejected', reason: 'invalid-limit' };

  const byId = new Map<string, TaskDagNode>();
  for (const node of input.nodes) {
    if (node.taskId.length === 0) return { kind: 'rejected', reason: 'invalid-task' };
    if (byId.has(node.taskId)) return { kind: 'rejected', reason: 'duplicate-task' };
    byId.set(node.taskId, node);
  }

  const root = byId.get(input.rootTaskId);
  if (!root || root.parentTaskId !== undefined
    || input.nodes.some((node) => node.taskId !== input.rootTaskId && node.parentTaskId === undefined)) {
    return { kind: 'rejected', reason: 'invalid-root' };
  }

  for (const node of input.nodes) {
    if (node.parentTaskId !== undefined && !byId.has(node.parentTaskId)) {
      return { kind: 'rejected', reason: 'parent-not-found' };
    }
    const dependencyIds = new Set<string>();
    for (const dependencyTaskId of node.dependencyTaskIds) {
      if (dependencyTaskId === node.taskId) return { kind: 'rejected', reason: 'self-dependency' };
      if (!byId.has(dependencyTaskId)) return { kind: 'rejected', reason: 'dependency-not-found' };
      if (dependencyIds.has(dependencyTaskId)) {
        return { kind: 'rejected', reason: 'duplicate-dependency' };
      }
      dependencyIds.add(dependencyTaskId);
    }
  }

  if (hasCycle(input.nodes, (node) => node.parentTaskId ? [node.parentTaskId] : [], byId)) {
    return { kind: 'rejected', reason: 'parent-cycle' };
  }
  if (hasCycle(input.nodes, (node) => node.dependencyTaskIds, byId)) {
    return { kind: 'rejected', reason: 'dependency-cycle' };
  }

  const depthById = new Map<string, number>();
  const depthOf = (node: TaskDagNode): number => {
    const known = depthById.get(node.taskId);
    if (known !== undefined) return known;
    const depth = node.parentTaskId === undefined ? 0 : depthOf(byId.get(node.parentTaskId)!) + 1;
    depthById.set(node.taskId, depth);
    return depth;
  };
  if (input.nodes.some((node) => depthOf(node) > input.limits.maxDepth)) {
    return { kind: 'rejected', reason: 'max-depth-exceeded' };
  }

  const childCounts = new Map<string, number>();
  for (const node of input.nodes) {
    if (node.parentTaskId === undefined) continue;
    const count = (childCounts.get(node.parentTaskId) ?? 0) + 1;
    if (count > input.limits.maxFanOut) {
      return { kind: 'rejected', reason: 'max-fan-out-exceeded' };
    }
    childCounts.set(node.parentTaskId, count);
  }

  if (input.nodes.filter((node) => node.taskId !== input.rootTaskId && !node.isTerminal).length
    > input.limits.maxOpenTasks) {
    return { kind: 'rejected', reason: 'max-open-tasks-exceeded' };
  }
  if (input.invocationBudget.consumed + input.invocationBudget.reserved > input.invocationBudget.limit) {
    return { kind: 'rejected', reason: 'invocation-budget-exceeded' };
  }
  return { kind: 'valid' };
}
