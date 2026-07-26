import type { ID, UnixMs } from './common.js';
import type { ArtifactDto } from './artifact.js';
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

/**
 * #823 逻辑产物 lineage 来源种类。
 * `project_version` 指向同频道内的既有产物版本；`artifact` 指向同频道内可见的不可变 Artifact 输入。
 */
export type ProjectArtifactLineageKind = 'project_version' | 'artifact';

export interface ProjectArtifactLineageRefDto {
  kind: ProjectArtifactLineageKind;
  refId: ID;
}

/**
 * #823 产物版本来源。Stage/Task 来自显式指定的 Stage 绑定；
 * message/workspaceRun 由 Server 从 Artifact 自身的持久化事实读取，不接受客户端提交；
 * invocation 为可选显式引用，由 Server 复验作用域。
 */
export interface ProjectArtifactVersionSourceDto {
  stageId: ID;
  taskId: ID;
  taskRevision: number;
  messageId?: ID;
  workspaceRunId?: ID;
  invocationId?: ID;
}

export interface ProjectArtifactVersionDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  versionNumber: number;
  artifact: ArtifactDto;
  source: ProjectArtifactVersionSourceDto;
  lineage: ProjectArtifactLineageRefDto[];
  promotedBy: ID;
  createdAt: UnixMs;
}

export interface ProjectArtifactCollectionDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  /** 逻辑产物名称：稳定身份，由项目负责人显式声明，不从文件名或目录推断。 */
  name: string;
  /** 逻辑产物业务类型：显式声明，不从 mime 或 pathKind 推断。 */
  kind: string;
  revision: number;
  /** current version 指针；集合创建时即指向首个版本。 */
  currentVersionId: ID;
  versions: ProjectArtifactVersionDto[];
  createdBy: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ProjectArtifactLibraryDto {
  collections: ProjectArtifactCollectionDto[];
  archived: boolean;
}

export interface ListProjectArtifactCollectionsInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
}

export interface PromoteArtifactToProjectVersionInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  /** 被提升的既有不可变 Artifact；必须在同一 Team/Channel 且对频道成员可见。 */
  artifactId: ID;
  /** 版本所属 Stage；Server 据此解析 Task 与 Task revision。 */
  stageId: ID;
  /** 追加到既有集合时必填；缺省表示创建新的逻辑产物集合。 */
  collectionId?: ID;
  /** 追加到既有集合时必填的 revision fence。 */
  expectedCollectionRevision?: number;
  /** 创建新集合时必填。 */
  collection?: {
    name: string;
    kind: string;
  };
  /** 可选 lineage：显式声明本版本基于哪些既有版本或输入产生。 */
  lineage?: ProjectArtifactLineageRefDto[];
  /** 可选来源 Invocation；Server 复验其 Team/Channel 作用域。 */
  sourceInvocationId?: ID;
}
