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
    | 'review_needs_human'
    | 'stage_dependency_incomplete'
    | 'stage_dependency_unaccepted'
    | 'required_input_missing';
  taskId: ID;
  dependencyTaskId?: ID;
  /** #822 Stage edge 派生的阻塞原因携带边与上游阶段身份，便于界面解释。 */
  edgeId?: ID;
  upstreamStageId?: ID;
  requiredInputKey?: string;
}

/**
 * #822 Stage edge 的项目语义。
 * - `blocks_start`：上游阶段完成后下游才可启动。
 * - `provides_context`：上游产物只作为下游上下文，不阻塞启动。
 */
export type ProjectStageEdgeSemantics = 'blocks_start' | 'provides_context';

/** #822 必需输入规则：声明下游阶段必须从上游阶段获得哪类产物。 */
export interface ProjectStageRequiredInputRuleDto {
  key: string;
  kind: 'artifact' | 'document';
  label: string;
}

export interface ProjectStageMissingRequiredInputDto extends ProjectStageRequiredInputRuleDto {
  edgeId: ID;
  upstreamStageId: ID;
}

export interface ProjectStageEdgeDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  upstreamStageId: ID;
  downstreamStageId: ID;
  upstreamTaskId: ID;
  downstreamTaskId: ID;
  semantics: ProjectStageEdgeSemantics;
  requiredInputs: ProjectStageRequiredInputRuleDto[];
  createdBy: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
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
  /** #822 阶段绑定的 Task revision，供客户端提交依赖写操作时携带 fence。 */
  taskRevision: number;
  aggregateStatus: ProjectStageAggregateStatus;
  blockingReasons: ProjectStageBlockingReasonDto[];
  /** #822 前置阶段身份（按 Stage edge 聚合，不含 provides_context 之外的推断）。 */
  upstreamStageIds: ID[];
  /** #822 全部 `blocks_start` 前置阶段是否已满足。 */
  dependenciesSatisfied: boolean;
  /** #822 尚未满足的必需输入。 */
  missingRequiredInputs: ProjectStageMissingRequiredInputDto[];
  /** #822 执行门禁结论：依赖与必需输入是否允许启动新的 claim/Invocation。 */
  executionAllowed: boolean;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface ChannelProjectOverviewDto {
  profile: ChannelProjectProfileDto;
  stages: ProjectStageDto[];
  /** #822 频道内的 Stage 依赖图。 */
  edges: ProjectStageEdgeDto[];
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
 * #822 在已有项目画像的频道中追加后续阶段。
 * 配置 Stage edge 至少需要两个阶段，因此本切片补齐首个阶段之后的阶段创建。
 */
export interface CreateProjectStageInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  expectedRevision: number;
  idempotencyKey: string;
  stage: {
    name: string;
    goal: string;
    ownerId: ID;
    reviewerIds: ID[];
    acceptanceCriteria: string[];
    taskId: ID;
  };
}

export interface CreateProjectStageEdgeInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  expectedRevision: number;
  idempotencyKey: string;
  upstreamStageId: ID;
  downstreamStageId: ID;
  semantics: ProjectStageEdgeSemantics;
  requiredInputs: ProjectStageRequiredInputRuleDto[];
  expectedUpstreamTaskRevision: number;
  expectedDownstreamTaskRevision: number;
}

export interface DeleteProjectStageEdgeInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  expectedRevision: number;
  idempotencyKey: string;
  edgeId: ID;
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

/** #824 人工审核决定。三态与 Task acceptance 无关：阶段完成仍走 canonical Task delivery/acceptance。 */
export type ProjectArtifactReviewDecision = 'approved' | 'rejected' | 'changes_requested';

/** #824 审核依据引用种类；全部由 Server 复验同 Team/Channel 作用域。 */
export type ProjectArtifactReviewBasisKind = 'project_version' | 'artifact' | 'message';

export interface ProjectArtifactReviewBasisRefDto {
  kind: ProjectArtifactReviewBasisKind;
  refId: ID;
}

/**
 * #824 append-only 审核记录：一条记录就是一次不可覆盖的决定。
 * 仓储只提供 list/append，没有 update/delete —— 「只追加不覆盖」是接口层结构性保证。
 */
export interface ProjectArtifactReviewDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  /** 明确的受审版本：审核对象永远是具体版本，不是集合。 */
  versionId: ID;
  /** 审核语境：受审版本所属 Stage。 */
  stageId: ID;
  decision: ProjectArtifactReviewDecision;
  comment: string;
  basis: ProjectArtifactReviewBasisRefDto[];
  reviewedBy: ID;
  createdAt: UnixMs;
}

/**
 * #824 版本审核状态：该版本**最新一条**审核记录的 decision；无记录为 `pending`。
 * 取最新一条而非「曾经通过」，使「要求修改」对最终化真正具有约束力。
 */
export type ProjectArtifactVersionReviewState = 'pending' | ProjectArtifactReviewDecision;

export type ProjectArtifactFinalizationActorKind = 'human' | 'pi_manager';

/**
 * #824 PI Manager 代表用户最终化时必须携带的人类确认引用。
 * Server 复验：消息在同 Team/Channel、作者等于声明的确认人、且该确认人本身有最终化权限。
 */
export interface ProjectArtifactHumanConfirmationRefDto {
  kind: 'message';
  refId: ID;
  confirmedBy: ID;
}

/** #824 每次最终版切换的 append-only 审计条目。旧版本、旧审核与旧最终化历史都不被修改。 */
export interface ProjectArtifactFinalizationDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  /** 本次切换后的最终版。 */
  versionId: ID;
  /** 切换来源：上一版最终版；首次最终化为空。 */
  previousVersionId?: ID;
  /** 依据的通过审核记录 id：最终化必须落在一条明确的 approved 审核上。 */
  basisReviewId: ID;
  actorKind: ProjectArtifactFinalizationActorKind;
  /** 最终化归属的人类；Manager 代表操作时是被代表的用户。 */
  finalizedBy: ID;
  /** Manager 代表操作时的 management run 身份。 */
  managementRunId?: ID;
  humanConfirmation?: ProjectArtifactHumanConfirmationRefDto;
  reason?: string;
  createdAt: UnixMs;
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
  /** #824 该版本的完整审核历史，按时间升序；append-only。 */
  reviews: ProjectArtifactReviewDto[];
  /** #824 由 `reviews` 最新一条派生的审核状态。 */
  reviewState: ProjectArtifactVersionReviewState;
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
  /**
   * #824 唯一最终版指针；尚未最终化时为空。
   * 最终版是集合上的**指针**而不是版本状态，因此切换后旧版本仍保持自己的审核事实。
   */
  finalVersionId?: ID;
  versions: ProjectArtifactVersionDto[];
  /** #824 最终版切换审计，按时间升序；append-only。 */
  finalizations: ProjectArtifactFinalizationDto[];
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

/**
 * #824 对具体产物版本提交人工审核决定。
 * 没有 `expectedVersionRevision` 之类的 fence：审核只追加，不覆盖任何既有记录，
 * 因此并发审核天然共存，唯一需要幂等保护的是重复提交同一条决定。
 */
export interface SubmitProjectArtifactReviewInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  /** 受审版本；Server 据此解析所属集合与 Stage 语境。 */
  versionId: ID;
  decision: ProjectArtifactReviewDecision;
  comment: string;
  /** 可选依据引用；Server 复验每一条的可见性与作用域。 */
  basis?: ProjectArtifactReviewBasisRefDto[];
}

/**
 * #824 PI Manager 代表用户最终化时携带的上下文。
 * 缺省表示已认证的人类本人在操作 —— Web socket 端点只对已认证人类开放，
 * 因此本字段永远不能被用来「降级」成人类，只能用来声明更严格的 Manager 路径。
 */
export interface ProjectArtifactManagerFinalizationContextDto {
  managementRunId: ID;
  humanConfirmation: ProjectArtifactHumanConfirmationRefDto;
}

export interface SetProjectArtifactFinalVersionInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  idempotencyKey: string;
  collectionId: ID;
  /** 集合 revision fence：并发切换中只有一个能落地。 */
  expectedCollectionRevision: number;
  /** 目标最终版；必须属于该集合且当前审核状态为 approved。 */
  versionId: ID;
  reason?: string;
  manager?: ProjectArtifactManagerFinalizationContextDto;
}
