import type { DispatchRecord, MessageRecord, ServerNextRepositories, TaskRecord } from './repositories.js';

/** 普通讨论串补交只继承唯一的原 Task；多任务讨论串不能用“最近一个”猜归属。 */
export async function resolveDirectDispatchTask(
  repositories: ServerNextRepositories,
  dispatch: DispatchRecord,
  origin: MessageRecord | null,
): Promise<TaskRecord | null> {
  if (!origin || origin.teamId !== dispatch.teamId || origin.channelId !== dispatch.channelId) return null;
  if (typeof origin.meta?.taskId === 'string') {
    const task = await repositories.tasks.getById(origin.meta.taskId);
    return task?.teamId === dispatch.teamId && (!task.channelId || task.channelId === dispatch.channelId)
      ? task : null;
  }
  if (!origin.threadId || origin.threadId === origin.id) return null;
  const threadId = origin.threadId;

  return repositories.taskCoordinationUnitOfWork.run(async (transaction) => {
    const root = await transaction.messages.getById(threadId);
    if (!root || root.teamId !== dispatch.teamId || root.channelId !== dispatch.channelId
      || typeof root.meta?.taskId !== 'string') return null;
    // 达到读取上限时不能证明候选唯一，保留无绑定状态。
    const history = await transaction.messages.listThreadBefore({
      channelId: dispatch.channelId, threadId, beforeMessageId: origin.id, limit: 200,
    });
    if (history.length >= 200) return null;
    const taskIds = new Set<string>([root.meta.taskId]);
    for (const message of history) {
      if (message.teamId !== dispatch.teamId || message.channelId !== dispatch.channelId) return null;
      if (typeof message.meta?.taskId === 'string') taskIds.add(message.meta.taskId);
      const coordination = message.meta?.coordination;
      if (coordination && typeof coordination === 'object' && 'taskId' in coordination
        && typeof coordination.taskId === 'string') taskIds.add(coordination.taskId);
    }
    if (taskIds.size !== 1) return null;
    const taskId = root.meta.taskId;
    const task = await transaction.tasks.getById(taskId);
    if (!task || task.teamId !== dispatch.teamId || task.channelId !== dispatch.channelId
      || ['done', 'closed', 'cancelled'].includes(task.status)
      || (task.assigneeId && task.assigneeId !== dispatch.agentId)
      || await transaction.coordination.coordinations.getByTaskId(taskId)
      || await transaction.management.runs.getByRootTaskId(taskId)) return null;
    // 冻结到发起本次 Dispatch 的消息，后续查询/重连不再根据变化中的线程重新选 Task。
    const linked = await transaction.messages.setTaskIdIfAbsent({ messageId: origin.id, taskId });
    return linked?.taskId === taskId ? task : null;
  });
}
