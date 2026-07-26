import type {
  ChannelProjectOverviewDto,
  ID,
  ProjectArtifactLineageRefDto,
  ProjectDocumentBundleSourceDto,
  ProjectStageEdgeSemantics,
  ProjectStageRequiredInputRuleDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

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
  | { kind: 'task_scope_conflict' }
  | { kind: 'idempotency_conflict' };

/**
 * #822 Stage edge 记录。
 *
 * 这条记录同时承载「阶段依赖」与「对应 Task dependency」两重事实：
 * 当上下游 Task 都拥有 canonical `task_coordinations` 行时，写入会在同一事务里
 * 镜像一条 `task_dependencies`，并用 `mirroredTaskDependency` 记录该事实，
 * 使删除时同样在一个事务内成对撤销，永不产生两套互相矛盾的依赖事实。
 */
export interface ProjectStageEdgeRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  upstreamStageId: ID;
  downstreamStageId: ID;
  upstreamTaskId: ID;
  upstreamTaskRevision: number;
  downstreamTaskId: ID;
  downstreamTaskRevision: number;
  semantics: ProjectStageEdgeSemantics;
  requiredInputs: ProjectStageRequiredInputRuleDto[];
  mirroredTaskDependency: boolean;
  createdBy: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export type ProjectStageEdgeMutationResult =
  | { kind: 'created' | 'deleted' | 'replayed'; mutation: ChannelProjectMutationRecord }
  | { kind: 'revision_conflict' }
  | { kind: 'task_scope_conflict' }
  | { kind: 'idempotency_conflict' }
  | { kind: 'stage_scope_conflict' }
  | { kind: 'duplicate_edge' }
  | { kind: 'edge_not_found' };

export interface ProjectArtifactCollectionRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  name: string;
  kind: string;
  revision: number;
  currentVersionId: ID;
  versionCount: number;
  createdBy: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ProjectArtifactVersionRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  versionNumber: number;
  artifactId: ID;
  stageId: ID;
  taskId: ID;
  taskRevision: number;
  sourceMessageId?: ID;
  sourceWorkspaceRunId?: ID;
  sourceInvocationId?: ID;
  lineage: ProjectArtifactLineageRefDto[];
  promotedBy: ID;
  createdAt: UnixMs;
}

export interface ProjectArtifactMutationRecord {
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  requestFingerprint: string;
  collectionId: ID;
  versionId: ID;
  createdAt: UnixMs;
}

/**
 * #823 提升结果。`replayed` 覆盖两条幂等路径：相同 idempotencyKey 重放，
 * 以及同一 Artifact 已有版本时的自然幂等。
 */
export type PromoteArtifactToProjectVersionResult =
  | {
    kind: 'created' | 'replayed';
    collection: ProjectArtifactCollectionRecord;
    version: ProjectArtifactVersionRecord;
  }
  | { kind: 'collection_revision_conflict' }
  | { kind: 'collection_scope_conflict' }
  | { kind: 'collection_name_conflict' }
  | { kind: 'artifact_scope_conflict' }
  | { kind: 'stage_scope_conflict' }
  | { kind: 'task_scope_conflict' }
  | { kind: 'artifact_promoted_to_other_collection' }
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
  listEdges(input: { teamId: ID; channelId: ID }): Promise<ProjectStageEdgeRecord[]>;
  /** 在已有画像上追加后续阶段：同一事务内校验 Task fence、提升 profile revision 并记录幂等结果。 */
  createStage(input: {
    expectedRevision: number;
    nextRevision: number;
    updatedAt: UnixMs;
    stage: ProjectStageRecord;
    mutation: ChannelProjectMutationRecord;
  }): Promise<ProjectStageEdgeMutationResult>;
  /** 同一事务内写入 Stage edge、镜像 Task dependency、提升 profile revision 并记录幂等结果。 */
  createStageEdge(input: {
    expectedRevision: number;
    nextRevision: number;
    updatedAt: UnixMs;
    edge: ProjectStageEdgeRecord;
    mutation: ChannelProjectMutationRecord;
  }): Promise<ProjectStageEdgeMutationResult>;
  /** 同一事务内删除 Stage edge 与其镜像 Task dependency，并提升 profile revision。 */
  deleteStageEdge(input: {
    teamId: ID;
    channelId: ID;
    edgeId: ID;
    expectedRevision: number;
    nextRevision: number;
    updatedAt: UnixMs;
    mutation: ChannelProjectMutationRecord;
  }): Promise<ProjectStageEdgeMutationResult>;
  listArtifactCollections(input: { teamId: ID; channelId: ID }): Promise<ProjectArtifactCollectionRecord[]>;
  getArtifactCollection(input: {
    teamId: ID;
    channelId: ID;
    collectionId: ID;
  }): Promise<ProjectArtifactCollectionRecord | null>;
  listArtifactVersions(input: { teamId: ID; channelId: ID }): Promise<ProjectArtifactVersionRecord[]>;
  getArtifactVersionByArtifact(input: {
    teamId: ID;
    channelId: ID;
    artifactId: ID;
  }): Promise<ProjectArtifactVersionRecord | null>;
  getArtifactMutation(input: {
    teamId: ID;
    channelId: ID;
    idempotencyKey: string;
  }): Promise<ProjectArtifactMutationRecord | null>;
  /**
   * 原子提升：在同一提交点复核幂等键、集合 revision fence、Artifact/Stage 作用域，
   * 再写入版本并推进 current version 指针与集合 revision。
   */
  promoteArtifact(input: {
    teamId: ID;
    channelId: ID;
    /** 追加到既有集合时的 revision fence；创建新集合时为 undefined。 */
    expectedCollectionRevision?: number;
    collection: ProjectArtifactCollectionRecord;
    /** true 表示本次写入创建新集合，false 表示向既有集合追加版本。 */
    createsCollection: boolean;
    version: ProjectArtifactVersionRecord;
    mutation: ProjectArtifactMutationRecord;
  }): Promise<PromoteArtifactToProjectVersionResult>;
}

/** #825：Bundle 本体。成员另存，创建后不可变。 */
export interface ProjectDocumentBundleRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  name: string;
  source: ProjectDocumentBundleSourceDto;
  memberCount: number;
  createdBy: ID;
  createdAt: UnixMs;
}

/** 加入包时冻结的成员事实；当前 revision 由读取时从 ChannelDocument 投影，不落这张表。 */
export interface ProjectDocumentBundleMemberRecord {
  bundleId: ID;
  position: number;
  documentId: ID;
  initialRevisionId: ID;
  initialRevisionNumber: number;
  initialFilename: string;
}

export interface ProjectDocumentBundleMutationRecord {
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  requestFingerprint: string;
  bundleId: ID;
  createdAt: UnixMs;
}

export type CreateProjectDocumentBundleResult =
  | { kind: 'created' | 'replayed'; mutation: ProjectDocumentBundleMutationRecord }
  | { kind: 'document_scope_conflict' }
  | { kind: 'idempotency_conflict' };

/**
 * 刻意只暴露读与一次性 create：没有 addMember / removeMember / replaceMembers，
 * 因此「后续新增 Markdown 不回填旧 Bundle」是接口层的结构性保证，而不是运行时约定。
 */
export interface ProjectDocumentBundleRepository {
  list(input: { teamId: ID; channelId: ID }): Promise<ProjectDocumentBundleRecord[]>;
  getById(input: { teamId: ID; channelId: ID; bundleId: ID }): Promise<ProjectDocumentBundleRecord | null>;
  listMembers(input: { bundleId: ID }): Promise<ProjectDocumentBundleMemberRecord[]>;
  getMutation(input: {
    teamId: ID;
    channelId: ID;
    idempotencyKey: string;
  }): Promise<ProjectDocumentBundleMutationRecord | null>;
  create(input: {
    bundle: ProjectDocumentBundleRecord;
    members: ProjectDocumentBundleMemberRecord[];
    mutation: ProjectDocumentBundleMutationRecord;
  }): Promise<CreateProjectDocumentBundleResult>;
}
