import type { MessageRepository, NewTaskRecord, TaskRecord, TaskRepository } from './repositories.js';

/** 在调用方的事务中使用：一个来源消息只保留一个 Task，竞争失败的候选不能成为孤立待办。 */
export async function createOrReuseMessageTask(
  repositories: { messages: MessageRepository; tasks: TaskRepository },
  messageId: string,
  candidate: NewTaskRecord,
): Promise<TaskRecord> {
  const message = await repositories.messages.getById(messageId);
  if (!message || message.teamId !== candidate.teamId || message.channelId !== candidate.channelId) {
    throw new Error('MESSAGE_TASK_SCOPE_CONFLICT');
  }
  const validate = (task: TaskRecord | null): TaskRecord => {
    if (!task || task.teamId !== candidate.teamId || task.channelId !== candidate.channelId) {
      throw new Error('MESSAGE_TASK_LINK_CONFLICT');
    }
    return task;
  };
  const existingId = typeof message.meta?.taskId === 'string' ? message.meta.taskId : null;
  if (existingId) return validate(await repositories.tasks.getById(existingId));

  const existingCandidate = await repositories.tasks.getById(candidate.id);
  const task = existingCandidate ? validate(existingCandidate) : await repositories.tasks.create(candidate);
  const link = await repositories.messages.setTaskIdIfAbsent({ messageId, taskId: task.id });
  if (!link || link.taskId !== task.id) {
    if (!existingCandidate) await repositories.tasks.delete({ taskId: task.id });
    if (!link) throw new Error('MESSAGE_TASK_LINK_CONFLICT');
    return validate(await repositories.tasks.getById(link.taskId));
  }
  return task;
}
