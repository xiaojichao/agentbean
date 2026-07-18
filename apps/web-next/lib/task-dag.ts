import type { TaskDagNodeViewDto, TaskDagViewDto } from '@agentbean/contracts';

/** #649：Run 用量/预算对照的展示格式化；任一维度超限（>上限）时 exceeded=true 供 UI 标红。
 *  #660/#661：usage 各维度与 budget enforcement 同口径（扇出峰值↔maxSubtasks、0-based 边深↔maxDepth），
 *  等于上限是合法满负载（enforcement 拒绝条件为严格大于），不得标红。 */
export function formatTaskDagUsage(
  usage: TaskDagViewDto['usage'],
  budget: TaskDagViewDto['budget'],
): { text: string; exceeded: boolean } | null {
  if (!usage || !budget) return null;
  const exceeded = usage.maxFanOut > budget.maxSubtasks
    || usage.externalInvocationCount > budget.maxExternalInvocations
    || usage.maxDepthReached > budget.maxDepth;
  return {
    text: `子任务峰值 ${usage.maxFanOut}/${budget.maxSubtasks} · 外部调用 ${usage.externalInvocationCount}/${budget.maxExternalInvocations} · 深度 ${usage.maxDepthReached}/${budget.maxDepth}`,
    exceeded,
  };
}

export function acceptTaskDagSnapshot(
  current: TaskDagViewDto | null,
  incoming: TaskDagViewDto,
): TaskDagViewDto {
  if (!current || current.rootTaskId !== incoming.rootTaskId) return incoming;
  if (incoming.graphRevision !== current.graphRevision) {
    return incoming.graphRevision > current.graphRevision ? incoming : current;
  }
  const incomingByTaskId = new Map(incoming.nodes.map((node) => [node.task.id, node]));
  for (const currentNode of current.nodes) {
    const incomingNode = incomingByTaskId.get(currentNode.task.id);
    if (!incomingNode || incomingNode.taskRevision < currentNode.taskRevision) return current;
    if (incomingNode.taskRevision === currentNode.taskRevision
      && incomingNode.task.updatedAt < currentNode.task.updatedAt) return current;
  }
  return incoming;
}

export function orderedTaskDagNodes(dag: TaskDagViewDto): TaskDagNodeViewDto[] {
  const byParent = new Map<string, TaskDagNodeViewDto[]>();
  for (const node of dag.nodes) {
    const parentId = node.coordination.parentTaskId ?? '';
    byParent.set(parentId, [...(byParent.get(parentId) ?? []), node]);
  }
  for (const nodes of byParent.values()) {
    nodes.sort((left, right) => left.task.createdAt - right.task.createdAt || left.task.id.localeCompare(right.task.id));
  }
  const result: TaskDagNodeViewDto[] = [];
  const visit = (node: TaskDagNodeViewDto) => {
    result.push(node);
    for (const child of byParent.get(node.task.id) ?? []) visit(child);
  };
  const root = dag.nodes.find((node) => node.task.id === dag.rootTaskId);
  if (root) visit(root);
  for (const node of dag.nodes) {
    if (!result.includes(node)) visit(node);
  }
  return result;
}
