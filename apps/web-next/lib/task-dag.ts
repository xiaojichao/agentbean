import type { TaskDagNodeViewDto, TaskDagViewDto } from '@agentbean/contracts';

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
