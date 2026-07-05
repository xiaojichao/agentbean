import type { TaskStatus } from './task-status';

export interface TaskMessageSummaryTask {
  title: string;
  description: string | null;
  status: TaskStatus;
  updatedAt: number;
}

export interface TaskMessageSummary {
  label: string;
  title: string;
  description: string | null;
  assigneeName: string;
  status: TaskStatus;
  updatedAt: number | null;
}

export function taskMessageSummary(input: {
  task: TaskMessageSummaryTask | null | undefined;
  taskNumber?: number;
  assigneeName: string;
  fallbackBody: string;
}): TaskMessageSummary {
  const title = input.task?.title.trim() || input.fallbackBody.trim() || '未命名任务';
  const description = input.task?.description?.trim() || null;
  return {
    label: input.taskNumber ? `#${input.taskNumber}` : '#任务',
    title,
    description: description && description !== title ? description : null,
    assigneeName: input.assigneeName,
    status: input.task?.status ?? 'todo',
    updatedAt: input.task?.updatedAt ?? null,
  };
}
