import type { ID, UnixMs } from './common.js';

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';

export interface TaskDto {
  id: ID;
  teamId: ID;
  title: string;
  description?: string;
  status: TaskStatus;
  creatorId: ID;
  assigneeId?: ID;
  channelId?: ID;
  tags: string[];
  sortOrder: number;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface TaskListInputDto {
  userId?: ID;
  teamId: ID;
  channelId?: ID;
}

export interface TaskCreateInputDto {
  userId?: ID;
  teamId: ID;
  title: string;
  description?: string;
  channelId?: ID;
  assigneeId?: ID;
  tags?: string[];
}

export interface TaskUpdateInputDto {
  userId?: ID;
  teamId: ID;
  taskId: ID;
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  assigneeId?: ID | null;
  channelId?: ID | null;
  tags?: string[];
  sortOrder?: number;
}
