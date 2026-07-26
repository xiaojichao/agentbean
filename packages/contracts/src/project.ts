import type { ID, UnixMs } from './common.js';
import type { TaskDto } from './task.js';

export type ProjectStageAggregateStatus = 'pending' | 'active' | 'in_review' | 'complete';

export interface ProjectStageBlockingReasonDto {
  code:
    | 'task_not_started'
    | 'dependency_incomplete'
    | 'review_pending'
    | 'review_rejected'
    | 'review_needs_human';
  taskId: ID;
  dependencyTaskId?: ID;
}

export interface ChannelProjectProfileDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  projectLeadId: ID;
  defaultReviewerIds: ID[];
  revision: number;
  createdBy: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ProjectStageDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  name: string;
  goal: string;
  ownerId: ID;
  reviewerIds: ID[];
  acceptanceCriteria: string[];
  task: TaskDto;
  aggregateStatus: ProjectStageAggregateStatus;
  blockingReasons: ProjectStageBlockingReasonDto[];
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ChannelProjectOverviewDto {
  profile: ChannelProjectProfileDto;
  stages: ProjectStageDto[];
  archived: boolean;
}

export interface GetChannelProjectOverviewInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
}

export interface CreateInitialProjectStageInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  expectedRevision: number;
  idempotencyKey: string;
  projectLeadId: ID;
  defaultReviewerIds: ID[];
  stage: {
    name: string;
    goal: string;
    ownerId: ID;
    reviewerIds: ID[];
    acceptanceCriteria: string[];
    taskId: ID;
  };
}
