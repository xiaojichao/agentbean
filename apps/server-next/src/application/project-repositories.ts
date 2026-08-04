import type {
  ChannelProjectOverviewDto,
  ID,
  PackageReviewAuthorityBasisKind,
  ProjectArtifactFinalizationActorKind,
  ProjectArtifactHumanConfirmationRefDto,
  ProjectArtifactLineageRefDto,
  ProjectArtifactReviewBasisRefDto,
  ProjectArtifactReviewDecision,
  ProjectDocumentBundleBackfillMode,
  ProjectDocumentBundleSourceDto,
  ProjectDocumentInputSetItemResultStatus,
  ProjectStageEdgeSemantics,
  ProjectStageRequiredInputRuleDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import type { ProjectDocumentBundleBackfillReasonCode } from '../../../../packages/domain/src/index.js';

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
  /** #824 唯一最终版指针；尚未最终化时为 undefined。 */
  finalVersionId?: ID;
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
  /** #1060：Agent 交付形成的版本允许无 Stage 来源(NULL);人工 promote 路径仍强制。 */
  stageId?: ID;
  taskId: ID;
  taskRevision: number;
  sourceMessageId?: ID;
  sourceWorkspaceRunId?: ID;
  sourceInvocationId?: ID;
  lineage: ProjectArtifactLineageRefDto[];
  promotedBy: ID;
  /** #1062：「基于此修改」产生的版本记录冻结修订依据;交付/promote 版本为空。 */
  revisedFromVersionId?: ID;
  revisionBasisReviewId?: ID;
  revisionPackageId?: ID;
  revisionDeliveryId?: ID;
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

/** #824 append-only 审核记录。没有对应的 update/delete 接口，写入后不可改写。 */
export interface ProjectArtifactReviewRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  versionId: ID;
  /**
   * #1061：受审版本所属 Stage，写入时从版本自身读取。可空——#1060 交付形成的版本可能
   * 无 Stage 来源(0076)；#824 人工 promote 路径仍有 Stage。
   */
  stageId?: ID;
  /** #1061 AC1：审核绑定的 package 上下文（交付来源）。人工 promote 路径无 package。 */
  packageId?: ID;
  deliveryId?: ID;
  taskId?: ID;
  taskRevision?: number;
  taskAttempt?: number;
  /** #1061 AC1：本次审核依据的 authority basis（审计区分三类事实来源）。 */
  authorityBasis: PackageReviewAuthorityBasisKind;
  decision: ProjectArtifactReviewDecision;
  comment: string;
  basis: ProjectArtifactReviewBasisRefDto[];
  reviewedBy: ID;
  createdAt: UnixMs;
}

/** #824 append-only 最终版切换审计。 */
export interface ProjectArtifactFinalizationRecord {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  versionId: ID;
  previousVersionId?: ID;
  basisReviewId: ID;
  actorKind: ProjectArtifactFinalizationActorKind;
  finalizedBy: ID;
  managementRunId?: ID;
  humanConfirmation?: ProjectArtifactHumanConfirmationRefDto;
  reason?: string;
  createdAt: UnixMs;
}

/** 审核与最终化共用同一个幂等命名空间：同 key 不同命令必须 fail closed。 */
export interface ProjectArtifactDecisionMutationRecord {
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  requestFingerprint: string;
  kind: 'review' | 'finalization';
  collectionId: ID;
  versionId: ID;
  reviewId?: ID;
  finalizationId?: ID;
  createdAt: UnixMs;
}

export type AppendProjectArtifactReviewResult =
  | { kind: 'created' | 'replayed'; review: ProjectArtifactReviewRecord }
  | { kind: 'version_scope_conflict' }
  | { kind: 'idempotency_conflict' };

export type SetProjectArtifactFinalVersionResult =
  | {
    kind: 'finalized' | 'replayed';
    collection: ProjectArtifactCollectionRecord;
    finalization: ProjectArtifactFinalizationRecord;
  }
  | { kind: 'collection_revision_conflict' }
  | { kind: 'version_scope_conflict' }
  /** 事务内复核发现目标版本最新一条审核已不是提交时那条 approved。 */
  | { kind: 'review_basis_conflict' }
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
  /**
   * #824 审核与最终化的读写。刻意只有 list/append/setFinal 三类：
   * 没有 updateReview / deleteReview / clearFinalVersion，
   * 因此「审核只追加不覆盖」「旧最终化历史保持可读」是接口层的结构性保证。
   */
  listArtifactReviews(input: { teamId: ID; channelId: ID }): Promise<ProjectArtifactReviewRecord[]>;
  listArtifactFinalizations(input: { teamId: ID; channelId: ID }): Promise<ProjectArtifactFinalizationRecord[]>;
  getArtifactDecisionMutation(input: {
    teamId: ID;
    channelId: ID;
    idempotencyKey: string;
  }): Promise<ProjectArtifactDecisionMutationRecord | null>;
  appendArtifactReview(input: {
    review: ProjectArtifactReviewRecord;
    mutation: ProjectArtifactDecisionMutationRecord;
  }): Promise<AppendProjectArtifactReviewResult>;
  /**
   * 原子切换最终版：同一提交点复核幂等键、集合 revision fence、版本作用域，
   * 并复核「目标版本最新一条审核仍是提交时那条 approved」，再写审计并推进指针。
   */
  setArtifactFinalVersion(input: {
    teamId: ID;
    channelId: ID;
    collectionId: ID;
    expectedCollectionRevision: number;
    nextRevision: number;
    updatedAt: UnixMs;
    finalization: ProjectArtifactFinalizationRecord;
    mutation: ProjectArtifactDecisionMutationRecord;
  }): Promise<SetProjectArtifactFinalVersionResult>;
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

export interface ProjectReferenceItemRecord {
  id: ID;
  selectionId: ID;
  kind: 'document_revision' | 'artifact_version';
  position: number;
  documentId?: ID;
  revisionId?: ID;
  revisionNumber?: number;
  filename?: string;
  bundlePosition?: number;
  collectionId?: ID;
  versionId?: ID;
  versionNumber?: number;
  artifactId?: ID;
  artifactFilename?: string;
  /** #1063：current/final 指针解析 item 冻结的 collection revision basis。 */
  collectionRevision?: number;
  createdAt: UnixMs;
}

export interface ProjectReferenceSelectionRecord {
  id: ID;
  referenceSetId: ID;
  sourceKind: 'bundle_all' | 'bundle_subset' | 'document' | 'artifact_version'
    | 'package_delivered' | 'package_current' | 'package_final' | 'package_specified';
  position: number;
  bundleId?: ID;
  bundleName?: string;
  bundleMemberCount?: number;
  /** #1063：package 语境快照(package 不可变;policy=来源投影策略)。 */
  packageId?: ID;
  packageProjection?: 'delivered' | 'current' | 'final' | 'specified';
  packageMemberCount?: number;
  createdAt: UnixMs;
  items: ProjectReferenceItemRecord[];
}

export interface ProjectReferenceSetRecord {
  id: ID;
  contractVersion: number;
  teamId: ID;
  channelId: ID;
  messageId: ID;
  createdBy: ID;
  createdAt: UnixMs;
  selections: ProjectReferenceSelectionRecord[];
}

export interface ProjectReferenceSetMutationRecord {
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  requestFingerprint: string;
  referenceSetId: ID;
  createdAt: UnixMs;
}

export type CreateProjectReferenceSetResult =
  | {
    kind: 'created' | 'replayed';
    mutation: ProjectReferenceSetMutationRecord;
  }
  | { kind: 'idempotency_conflict' | 'reference_fact_conflict' };

export interface ProjectReferenceSetRepository {
  getByMessageId(input: {
    teamId: ID;
    channelId: ID;
    messageId: ID;
  }): Promise<ProjectReferenceSetRecord | null>;
  create(input: {
    set: ProjectReferenceSetRecord;
    selections: ProjectReferenceSelectionRecord[];
    items: ProjectReferenceItemRecord[];
    mutation: ProjectReferenceSetMutationRecord;
  }): Promise<CreateProjectReferenceSetResult>;
}

export interface ProjectDocumentInputSetItemResultRecord {
  inputSetId: ID;
  invocationId: ID;
  agentId: ID;
  workspaceRunId?: ID;
  teamId: ID;
  channelId: ID;
  documentId: ID;
  baseRevisionId: ID;
  status: ProjectDocumentInputSetItemResultStatus;
  artifactId?: ID;
  revisionId?: ID;
  error?: string;
  requestFingerprint: string;
  createdAt: UnixMs;
}

export type RecordProjectDocumentInputSetItemResult =
  | { kind: 'created' | 'replayed'; result: ProjectDocumentInputSetItemResultRecord }
  | { kind: 'idempotency_conflict' };

export interface ProjectDocumentInputSetResultRepository {
  listByInvocation(input: {
    teamId: ID;
    channelId: ID;
    invocationId: ID;
  }): Promise<ProjectDocumentInputSetItemResultRecord[]>;
  record(input: ProjectDocumentInputSetItemResultRecord): Promise<RecordProjectDocumentInputSetItemResult>;
}

/** #830：回填游标。backfillId 让不同版本的回填策略各走各的游标，互不覆盖。 */
export interface ProjectDocumentBundleBackfillCursor {
  runCreatedAt: UnixMs;
  runId: ID;
}

export interface ProjectDocumentBundleBackfillProgressRecord {
  backfillId: string;
  mode: ProjectDocumentBundleBackfillMode;
  cursor?: ProjectDocumentBundleBackfillCursor;
  completedAt?: UnixMs;
  updatedAt: UnixMs;
}

/** 至少有一份频道文档曾派生自它的 Workspace Run；Run 行本身可能已经缺失。 */
export interface ProjectDocumentBundleBackfillCandidateRunRecord {
  runId: ID;
  teamId: ID;
  channelId: ID;
  createdAt: UnixMs;
}

/** 曾派生自目标 Run 的频道文档；derivesFromRunNow 区分「仍是它的产物」与「已漂移」。 */
export interface ProjectDocumentBundleBackfillDocumentFactRecord {
  documentId: ID;
  channelId: ID;
  createdAt: UnixMs;
  derivesFromRunNow: boolean;
}

export type ProjectDocumentBundleBackfillOutcomeKind =
  | 'created'
  | 'would_create'
  | 'existing'
  | 'ambiguous'
  | 'skipped'
  | 'failed';

export interface ProjectDocumentBundleBackfillOutcomeRecord {
  backfillId: string;
  mode: ProjectDocumentBundleBackfillMode;
  teamId: ID;
  channelId?: ID;
  workspaceRunId: ID;
  outcome: ProjectDocumentBundleBackfillOutcomeKind;
  reasonCode?: ProjectDocumentBundleBackfillReasonCode;
  memberCount: number;
  bundleId?: ID;
  decidedAt: UnixMs;
}

export interface ProjectDocumentBundleBackfillSummary {
  outcomes: Record<ProjectDocumentBundleBackfillOutcomeKind, number>;
  reasons: Record<string, number>;
}

/**
 * 回填专用的只读发现 + 裁决记录接口。它刻意与 ProjectDocumentBundleRepository 分开：
 * 后者「只有读与一次性 create」是 #825 的结构性保证，不能因为回填而被撑大。
 * 本接口同样不提供任何写 Bundle 的能力 —— 回填要建包只能走既有建包用例。
 */
export interface ProjectDocumentBundleBackfillRepository {
  getProgress(input: {
    backfillId: string;
    mode: ProjectDocumentBundleBackfillMode;
  }): Promise<ProjectDocumentBundleBackfillProgressRecord | null>;
  saveProgress(input: ProjectDocumentBundleBackfillProgressRecord): Promise<void>;
  listCandidateRuns(input: {
    cursor?: ProjectDocumentBundleBackfillCursor;
    limit: number;
  }): Promise<ProjectDocumentBundleBackfillCandidateRunRecord[]>;
  listRunDocumentFacts(input: {
    teamId: ID;
    workspaceRunId: ID;
  }): Promise<ProjectDocumentBundleBackfillDocumentFactRecord[]>;
  findBundleIdForRun(input: {
    teamId: ID;
    channelId: ID;
    workspaceRunId: ID;
  }): Promise<ID | null>;
  recordOutcome(input: ProjectDocumentBundleBackfillOutcomeRecord): Promise<void>;
  summarize(input: {
    backfillId: string;
    mode: ProjectDocumentBundleBackfillMode;
  }): Promise<ProjectDocumentBundleBackfillSummary>;
}
