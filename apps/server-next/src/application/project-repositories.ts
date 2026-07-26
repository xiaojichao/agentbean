import type { ChannelProjectOverviewDto, ID, UnixMs } from '../../../../packages/contracts/src/index.js';

export interface ChannelProjectProfileRecord {
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

export interface ProjectStageRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  taskId: ID;
  taskRevision: number;
  name: string;
  goal: string;
  ownerId: ID;
  reviewerIds: ID[];
  acceptanceCriteria: string[];
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ChannelProjectMutationRecord {
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  requestFingerprint: string;
  profileId: ID;
  stageId: ID;
  resultRevision: number;
  resultOverview: ChannelProjectOverviewDto;
  createdAt: UnixMs;
}

export type CreateInitialProjectStageResult =
  | { kind: 'created' | 'replayed'; mutation: ChannelProjectMutationRecord }
  | { kind: 'revision_conflict' }
  | { kind: 'idempotency_conflict' };

export interface ChannelProjectRepository {
  getProfile(input: { teamId: ID; channelId: ID }): Promise<ChannelProjectProfileRecord | null>;
  listStages(input: { teamId: ID; channelId: ID }): Promise<ProjectStageRecord[]>;
  getMutation(input: {
    teamId: ID;
    channelId: ID;
    idempotencyKey: string;
  }): Promise<ChannelProjectMutationRecord | null>;
  createInitialStage(input: {
    expectedRevision: number;
    profile: ChannelProjectProfileRecord;
    stage: ProjectStageRecord;
    mutation: ChannelProjectMutationRecord;
  }): Promise<CreateInitialProjectStageResult>;
}
