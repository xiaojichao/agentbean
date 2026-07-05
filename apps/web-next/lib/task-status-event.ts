import { isTaskStatus, type TaskStatus } from './task-status';

const TASK_STATUS_UPDATED_KIND = 'task-status-updated';

export interface TaskStatusEventSummary {
  taskId: string | null;
  status: TaskStatus;
  label: string;
}

export function taskStatusEventSummary(meta: Record<string, unknown>): TaskStatusEventSummary | null {
  if (meta.kind !== TASK_STATUS_UPDATED_KIND) return null;
  const status = typeof meta.status === 'string' && isTaskStatus(meta.status) ? meta.status : 'todo';
  const taskId = typeof meta.taskId === 'string' && meta.taskId.trim() ? meta.taskId : null;
  const label = typeof meta.taskNumber === 'number'
    ? `#${meta.taskNumber}`
    : typeof meta.taskTitle === 'string' && meta.taskTitle.trim()
      ? `「${meta.taskTitle.trim()}」`
      : '#任务';
  return { taskId, status, label };
}

export function taskRootIdFromMessageMeta(meta: Record<string, unknown>): string | null {
  if (meta.kind === TASK_STATUS_UPDATED_KIND) return null;
  return typeof meta.taskId === 'string' && meta.taskId.trim() ? meta.taskId : null;
}
