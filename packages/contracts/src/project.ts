import type { ID, UnixMs } from './common.js';
import type { ArtifactDto } from './artifact.js';
import type { TaskDto } from './task.js';
// type-only 循环引用安全:package-review.js 只 import project.js 的 decision 类型。
import type { PackageReviewAuthorityBasisKind } from './package-review.js';

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
export type ProjectStageRequiredInputSourceDto =
  | {
      readonly kind: 'artifact_collection';
      readonly collectionId: ID;
      /** `final` 只接受明确最终版；`approved` 接受当前最新通过版，若已有最终版则优先最终版。 */
      readonly versionPolicy: 'final' | 'approved';
    }
  | {
      readonly kind: 'document_bundle';
      readonly bundleId: ID;
    };

export interface ProjectStageRequiredInputRuleDto {
  key: string;
  kind: 'artifact' | 'document';
  label: string;
  /**
   * #829 显式稳定来源。旧 edge 读取时可能缺失；Server 对自动推进一律视为未满足，
   * 绝不从 key、label、文件名或路径猜来源。
   */
  source?: ProjectStageRequiredInputSourceDto;
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
  /** #829 PI Manager 对该阶段的权威推进投影。 */
  advance: ProjectStageAdvanceDto;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export type ProjectStageAdvanceWaitingReason =
  | 'channel_archived'
  | 'automation_unavailable'
  | 'task_not_pending'
  | 'task_revision_stale'
  | 'execution_gate_blocked'
  | 'required_input_incomplete'
  | 'stable_input_stale'
  | 'no_eligible_agent'
  | 'claim_stale'
  | 'invocation_active';

export type ProjectStageStableInputDto =
  | {
      readonly key: string;
      readonly kind: 'artifact_version';
      readonly edgeId: ID;
      readonly upstreamStageId: ID;
      readonly collectionId: ID;
      readonly versionId: ID;
      readonly artifactId: ID;
      readonly reviewId: ID;
      readonly finalizationId?: ID;
      readonly taskRevision: number;
    }
  | {
      readonly key: string;
      readonly kind: 'document_revision';
      readonly edgeId: ID;
      readonly upstreamStageId: ID;
      readonly bundleId: ID;
      readonly documentId: ID;
      readonly revisionId: ID;
      readonly revisionNumber: number;
      readonly artifactId: ID;
      readonly taskRevision: number;
    };

/** #829 随 Offer/Invocation 冻结的精确项目输入身份；任何字段变化都使旧决定失效。 */
export interface ProjectStageInputFenceDto {
  readonly stageId: ID;
  readonly inputs: readonly ProjectStageStableInputDto[];
}

export interface ProjectStageAdvanceDto {
  readonly kind: 'waiting' | 'suggest' | 'publish_offer' | 'create_invocation';
  readonly automatic: boolean;
  readonly reason?: ProjectStageAdvanceWaitingReason;
  readonly stableInputs: readonly ProjectStageStableInputDto[];
  readonly candidateAgentIds: readonly ID[];
  readonly targetAgentId?: ID;
  readonly taskRevision: number;
  readonly stageTaskRevision: number;
  readonly coordinationTaskRevision?: number;
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
 * #1060：Agent 交付形成的版本允许无 Stage 来源（Task 未绑定 Stage 或合成 taskId 时缺省）。
 */
export interface ProjectArtifactVersionSourceDto {
  stageId?: ID;
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
 * #1061：审核绑定 package/delivery/Task revision/attempt 与 reviewer authority basis（AC1）；
 * stageId 可空（#1060 交付形成的版本可能无 Stage 来源）。
 */
export interface ProjectArtifactReviewDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  collectionId: ID;
  /** 明确的受审版本：审核对象永远是具体版本，不是集合。 */
  versionId: ID;
  /** 审核语境：受审版本所属 Stage；交付形成的版本可能无 Stage。 */
  stageId?: ID;
  /** #1061：审核绑定的 package 上下文（交付来源）；人工 promote 路径无。 */
  packageId?: ID;
  deliveryId?: ID;
  taskId?: ID;
  taskRevision?: number;
  taskAttempt?: number;
  /** #1061：本次审核依据的 authority basis。 */
  authorityBasis: PackageReviewAuthorityBasisKind;
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

/**
 * Manager 代用户设置最终版时，用户确认消息必须精确使用此文本。
 * 将确认事实同时绑定集合、版本和预期集合修订，避免旧消息或其他动作的确认被重放。
 */
export function projectArtifactFinalizationConfirmationText(
  collectionId: ID,
  versionId: ID,
  expectedCollectionRevision: number,
): string {
  return `确认在集合修订 ${expectedCollectionRevision} 下，将逻辑产物集合 ${collectionId} 的版本 ${versionId} 设为最终版`;
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
  /**
   * #1062 修订 provenance:本版本由「基于此修改」产生时记录冻结依据
   * (来源版本/审核/package/delivery);交付形成或人工 promote 的版本为空。
   */
  revisionBasis?: ProjectArtifactVersionRevisionBasisDto;
  /** #824 该版本的完整审核历史，按时间升序；append-only。 */
  reviews: ProjectArtifactReviewDto[];
  /** #824 由 `reviews` 最新一条派生的审核状态。 */
  reviewState: ProjectArtifactVersionReviewState;
  /** #1065 AC5：本版本作为成员出现在哪些交付包(按时间升序；非交付形成版本为空)。 */
  packageMemberships: PackageMembershipRefDto[];
}

/**
 * #1065 AC5 Files 侧 package membership：一次交付 OutputPackage 与跨版本逻辑产物
 * ProjectArtifactCollection 明确区分;某版本「属于哪个交付包」由 Server 投影,
 * web 不自行按文件名/时间推断。
 */
export interface PackageMembershipRefDto {
  readonly packageId: ID;
  readonly sequence: number;
  readonly shortLabel: string;
  readonly deliveredAt: UnixMs;
  readonly taskId?: ID;
  readonly taskTitle?: string;
}

/**
 * #1062 修订 provenance:新版本保留从旧 version、review、Task delivery 派生的 lineage;
 * 短标识或「刚才那个」不充当长期身份。
 */
export interface ProjectArtifactVersionRevisionBasisDto {
  /** 基于此修改的明确来源版本。 */
  revisedFromVersionId: ID;
  /** 回应的 rejected/changes_requested 审核记录。 */
  basisReviewId?: ID;
  /** 来源 package / delivery(冻结成员身份)。 */
  packageId?: ID;
  deliveryId?: ID;
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
  /** 审核意见必须非空，确保决定具备可追溯语境。 */
  comment: string;
  /** 至少一条依据引用；Server 复验每一条的可见性与作用域。 */
  basis: ProjectArtifactReviewBasisRefDto[];
}

/**
 * #824 PI Manager 代表用户最终化时携带的上下文。
 * 仅供受信的 Server Manager 入口注入；人类 Web socket 会移除此字段。
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
