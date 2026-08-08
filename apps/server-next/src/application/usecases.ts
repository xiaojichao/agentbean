import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentInvocationRecordDto } from '../../../../packages/contracts/src/index.js';
import type {
  ProjectDocumentInputSetItemResultDto,
  ProjectDocumentInputSetResultDto,
  ProjectDocumentInputSetResultProposalV1,
} from '../../../../packages/contracts/src/index.js';
import type {
  CreateDeviceWorkspaceSnapshotInput,
  DeviceWorkspaceSnapshotDto,
  DeviceWorkspaceSnapshotInputSetItemDto,
} from '../../../../packages/contracts/src/project-channel-workspace.js';
import { hashPassword, isLegacyHash, verifyLegacySha256, verifyPassword } from './password.js';
import { isHiddenSystemMessage, formalKindToStorageKind, makeFailure, makeSuccess, parseAgentCollaborationProposalV1, projectArtifactFinalizationConfirmationText, type ActiveMemoryAttributionDto, type Ack, type AdapterKind, type AgentArtifactSourceRootConfigDto, type AgentCollaborationProposalV1, type AgentDescriptorDto, type AgentDto, type AgentCategory, type DispatchMemoryContextItemDto, type AgentInvocationResultDto, type AgentMetricsSummary, type ArtifactDto, type ArtifactPreviewDto, type ArtifactSourceRootDto, type ChannelArchivePreflightDto, type ChannelArchiveConfirmationDto, type ChannelDocumentDto, type ChannelDocumentRevisionDto, type ChannelDocumentResourceBindingDto, type ChannelDocumentSourceDto, type ChannelDto, type ChannelMembersDto, type ChannelFileEntryDto, type ChannelFileSourceDto, type ChannelFilesResultDto, type ChannelFileDirectoryDto, type ArtifactRole, type DeviceDetailDto, type DeviceDto, type DeviceInviteAckDto, type DeviceInviteCredentialsDto, type DeviceInviteDto, type DispatchAttachmentDto, type DispatchDto, type DispatchHistoryMessageDto, type DispatchRequestDto, type DmChannelDto, type HumanMemberDto, type ID, type JoinLinkDto, type MemoryContentKind, type MemoryGovernanceSnapshotDto, type MemoryKind, type MemoryRedactionLevel, type MemoryScopeType, type MessageDto, type MessageMetaDto, type RouteReason, type RuntimeDto, type ScanRequestCustomAgent, type SetAgentTeamVisibilityInput, type SkillDto, type TaskDagViewDto, type TaskDto, type TaskStatus, type TeamDto, type UnixMs, type UserDto, type UserRole, type WorkspaceRunDto, type WorkspaceRunStatus, type ProjectChannelWorkspaceDto, type ProjectChannelWorkspaceFileDto, type ProjectChannelWorkspaceRevisionDto, type ArchiveExportManifestDto, type WorkspacePublishStagingDto, type FormalMemoryDto, type FormalMemoryListDto, type FormalMemoryDetailDto, type FormalMemoryKind, type FormalMemoryScopeType, type SystemKnowledgeDto, type SystemKnowledgeDetailDto, type SystemKnowledgeListDto, type UserMemoryDto, type UserMemoryDetailDto, type UserMemoryListDto, type GetChannelDocumentInput, type ListChannelDocumentsInput, type ListChannelDocumentRevisionsInput, type DeriveChannelDocumentInput, type SaveChannelDocumentInput, type RestoreChannelDocumentInput, type PublishChannelDocumentInput, type PublishChannelDocumentResultDto, type ChannelDocumentResultDto, type ChannelDocumentRevisionsResultDto } from '../../../../packages/contracts/src/index.js';
import { planMentionMigration } from './mention-migration.js';
import {
  createAckReadCandidateCommandHandler,
  createCheckInboxCommandHandler,
  createSendMessageCommandHandler,
} from './message-tracer-handlers.js';
import { createMessageTracerCommandDispatcher } from './message-tracer-dispatcher.js';
import { parseMessageTracerCommandEnvelopeV1, type MessageTracerCommandResponseV1 } from '../../../../packages/contracts/src/index.js';
import type {
  SystemActivityCommandResponseV1,
  SystemActivityQueryName,
  SystemActivityQueryResponseV1,
} from '../../../../packages/contracts/src/system-activity.js';
import { createSystemActivityDispatcher } from './system-activity-dispatcher.js';
import { createMemorySystemActivityUnitOfWork } from './system-activity-unit-of-work.js';
import { autoProjectSystemActivityFact } from './system-activity-auto-project.js';
import {
  createInMemoryTaskFailureRemediationRepositories,
  createTaskFailureRemediationMemoryState,
  cloneTaskFailureRemediationMemoryState,
  restoreTaskFailureRemediationMemoryState,
} from '../infra/memory/task-failure-remediation-repositories.js';
import { createMemoryTaskFailureRemediationUnitOfWork } from './task-failure-remediation-unit-of-work.js';
import {
  handleRetryAttempt,
  type TaskFailureRemediationHandlerDeps,
} from './task-failure-remediation-handler.js';
import type { TaskRemediationCommandResponseV1 } from '../../../../packages/contracts/src/task-failure-remediation.js';
import {
  parseTaskRemediationCommandEnvelopeV1,
} from '../../../../packages/contracts/src/task-failure-remediation.js';
import { lookupLegacyCoordinationWriteFenced } from './legacy-coordination-fence.js';
import type {
  DaemonPiCapabilityNegotiationV1,
  PiAuthorityCutoverCommandResponseV1,
  PiAuthorityCutoverQueryName,
  PiAuthorityCutoverQueryResponseV1,
} from '../../../../packages/contracts/src/pi-authority-cutover.js';
import { createPiAuthorityCutoverDispatcher } from './pi-authority-cutover-dispatcher.js';
import { createMemoryPiAuthorityCutoverUnitOfWork } from './pi-authority-cutover-unit-of-work.js';
import {
  handleBindMessageAuthorityEpoch,
  type LegacyCoordinationJobInventory,
  type PiAuthorityCutoverHandlerDeps,
} from './pi-authority-cutover-handler.js';
import {
  evaluateCommandPathAvailability,
  negotiateDaemonPiCapabilities,
} from '../../../../packages/domain/src/pi-authority-cutover-policy.js';
import {
  clonePiAuthorityCutoverMemoryState,
  createInMemoryPiAuthorityCutoverRepositories,
  createPiAuthorityCutoverMemoryState,
  restorePiAuthorityCutoverMemoryState,
} from '../infra/memory/pi-authority-cutover-repositories.js';
import {
  cloneSystemActivityMemoryState,
  createInMemorySystemActivityRepositories,
  createSystemActivityMemoryState,
  restoreSystemActivityMemoryState,
} from '../infra/memory/system-activity-repositories.js';
import {
  initialChannelDocumentIds,
  isMarkdownArtifact,
  sanitizeMarkdownFilename,
} from './channel-document-policy.js';
import {
  saveArtifactVersionRevisionCommand,
  type SaveArtifactVersionRevisionResult,
} from './artifact-revision-handler.js';
import type { ArtifactRevisionConflictDto } from '../../../../packages/contracts/src/index.js';
import { parseArtifactRevisionCommandInputV1 } from '../../../../packages/contracts/src/index.js';
import { canApplyChannelUpdate, channelHumanMembersForCreate, deriveManagementRunUsage, isDefaultChannel, normalizeAdapterKind, normalizeAgentName, normalizeMentionName, normalizePathForComparison, routeMessage, type RouteResult, canManageFormalMemory, canProposeFormalCorrection, canReadFormalMemory, canManageSystemKnowledge, canManageUserMemory, canReadSystemKnowledge, canReadUserMemory, evaluateTeamAgentMemoryOptIn, evaluateArchivePreflight, evaluateArchiveConfirmation, validateWorkspaceImportFiles, evaluateWorkspacePublish, assembleArchiveExportManifest, evaluateWorkspaceStagingSizeLimits, evaluateWorkspaceStagingUpload, evaluateWorkspaceStagingCommitReadiness, evaluateWorkspaceStagingExpiry, normalizeWorkspacePublishId, isCompatibleWorkspaceStagingBegin, DEFAULT_WORKSPACE_STAGING_FILE_MAX_BYTES, DEFAULT_WORKSPACE_STAGING_PUBLISH_MAX_BYTES, DEFAULT_WORKSPACE_STAGING_RETENTION_MS, deriveActivityAudience, mapLifecycleCommandToActivityFact, mapRemediationCommandToActivityFact } from '../../../../packages/domain/src/index.js';
import type { AgentExposureActiveProjectionDto, AgentExposureManifestRevisionDto, AgentExposureRestrictionDto, AgentTeamCoverageDto, CreateAgentExposureDraftInput, GetAgentExposureActiveInput, GetAgentTeamCoverageInput, ListAgentExposureRevisionsInput, PublishAgentExposureInput, RevokeAgentExposureInput, UpdateAgentExposureDraftInput, UpsertAgentExposureRestrictionInput } from '../../../../packages/contracts/src/index.js';
import type { AgentMemoryProjectionDto, CreateAgentMemoryProjectionDraftInput, GetConsumableAgentMemoryProjectionsInput, GetConsumableAgentMemoryProjectionsResult, ListAgentMemoryProjectionRevisionsInput, PublishAgentMemoryProjectionInput, TeamAgentMemoryOptInDto, UpdateAgentMemoryProjectionDraftInput, UpsertTeamAgentMemoryOptInInput, WithdrawAgentMemoryProjectionInput } from '../../../../packages/contracts/src/index.js';
import type { AgentConfigUpdate, AgentRecord, ArtifactRecord, ChannelArchiveRecord, ChannelDocumentRecord, ChannelDocumentRevisionRecord, ChannelRecord, DeviceInviteRecord, DeviceRecord, DispatchRecord, JoinLinkRecord, MessageRecord, ServerNextRepositories, TaskRecord, UserRecord, WorkspaceRunRecord, ProjectChannelWorkspaceRecord, ProjectChannelWorkspaceRevisionRecord, WorkspacePublishStagingRecord, WorkspacePublishStagingFileRecord } from './repositories.js';
import type { WorkspaceStagingContentStore } from './workspace-staging-content-store.js';
import {
  PROJECT_REFERENCE_SET_CONTRACT_VERSION,
  type ProjectReferenceFailureDetailsDto,
  type ProjectReferenceItemDto,
  type ProjectReferenceSelectionRequestDto,
  type ProjectReferenceSetDto,
  type ResolveProjectReferenceOrdinalInput,
  type ResolveProjectReferenceOrdinalResultDto,
  type ResolveProjectReferencesInput,
  type ResolveProjectReferencesResultDto,
  parseOutputPackageQueryInputV1,
  parseProjectReferenceSelectionRequestsV1,
} from '../../../../packages/contracts/src/index.js';
import type {
  ChannelProjectProfileRecord,
  ProjectArtifactCollectionRecord,
  ProjectArtifactDecisionMutationRecord,
  ProjectArtifactFinalizationRecord,
  ProjectArtifactReviewRecord,
  ProjectArtifactVersionRecord,
  ProjectDocumentBundleMemberRecord,
  ProjectDocumentBundleRecord,
  ProjectDocumentInputSetItemResultRecord,
  ProjectReferenceItemRecord,
  ProjectReferenceSelectionRecord,
  ProjectReferenceSetRecord,
  ProjectReferenceSetRepository,
  ProjectStageEdgeMutationResult,
  ProjectStageEdgeRecord,
  ProjectStageRecord,
} from './project-repositories.js';
import type {
  OutputPackageMemberRecord,
  OutputPackageRecord,
} from './output-package-repositories.js';
import type {
  TaskClaimLeaseRecord,
  TaskOfferRecord,
  TaskCoordinationRecord,
  TaskCoordinationRepositories,
} from './task-coordination-repositories.js';
import type { PackageMembershipRefDto, ProjectStageDto } from '../../../../packages/contracts/src/project.js';
import { buildDeviceInviteCommand, DEVICE_SERVICE_OPERATION_COMMANDS } from './device-invite-command.js';
import { buildDaemonVersionInfo } from '../daemon-version.js';
import { createInvocationGateway } from './management/invocation-gateway.js';
import { createCollaborationService } from './management/collaboration-service.js';
import { appendManagementEventInTransaction, createManagementKernel } from './management/management-kernel.js';
import { createManagementRouter, type ManagementRoutingResult } from './management/management-router.js';
import { createTaskCoordinationKernel } from './management/task-coordination-kernel.js';
import {
  evaluateTaskLinkedRequestContext,
  publishTaskLinkedOffers,
  type TaskLinkedRequestContext,
  type TaskLinkedRequestEvaluation,
} from './task-linked-request-handler.js';
import { createTaskLifecycleKernel } from './management/task-lifecycle-kernel.js';
import { resolveProjectStageExecutionGate } from './project-stage-execution-gate.js';
import { createMemorySourceInvalidationService } from './memory-source-invalidation-service.js';
import { createCollaborativeMemoryService, type MemoryView } from './collaborative-memory-service.js';
import { createMemoryCandidateService, type MemoryCandidateView } from './memory-candidate-service.js';
import { createMemoryGovernanceService } from './memory-governance-service.js';
import { createFormalMemoryService } from './formal-memory-service.js';
import { createExperiencePackService } from './experience-pack-service.js';
import { createSystemUserMemoryService } from './system-user-memory-service.js';
import type {
  ChannelProjectOverviewDto,
  CreateInitialProjectStageInput,
  CreateProjectDocumentBundleInput,
  CreateProjectStageEdgeInput,
  CreateProjectStageInput,
  DeleteProjectStageEdgeInput,
  ErrorCode,
  FailureAck,
  GetChannelProjectOverviewInput,
  GetProjectDocumentBundleInput,
  ListProjectArtifactCollectionsInput,
  ListProjectDocumentBundlesInput,
  ProjectArtifactCollectionDto,
  ProjectArtifactFinalizationDto,
  ProjectArtifactReviewDecision,
  ProjectArtifactVersionReviewState,
  PackageReviewDto,
  ProjectArtifactLibraryDto,
  ProjectArtifactLineageRefDto,
  ProjectArtifactReviewBasisRefDto,
  ProjectArtifactReviewDto,
  ProjectArtifactVersionDto,
  ProjectDocumentBundleDetailDto,
  ProjectDocumentBundleDto,
  ProjectDocumentBundleFailureDetailsDto,
  ProjectDocumentBundleFailureReason,
  ProjectDocumentBundleListResultDto,
  ProjectDocumentBundleMemberViewDto,
  ProjectDocumentBundleResultDto,
  ProjectDocumentBundleSourceDto,
  OutputPackageDto,
  OutputPackageSummaryDto,
  OutputPackagePendingDeliveryDto,
  OutputPackageProjectionPolicy,
  OutputPackageProjectionResultV1,
  PackageMemberAvailableActionsDto,
  PackageReviewAction,
  ConsistencyTokenV1,
  ArtifactRevisionAction,
  ArtifactVersionRevisionSaveResultDto,
  ProjectStageBlockingReasonDto,
  ProjectStageEdgeDto,
  ProjectStageMissingRequiredInputDto,
  ProjectStageRequiredInputRuleDto,
  PromoteArtifactToProjectVersionInput,
  SetProjectArtifactFinalVersionInput,
  SubmitProjectArtifactReviewInput,
} from '../../../../packages/contracts/src/index.js';
import {
  deriveAuthorityBasis,
  deriveProjectArtifactVersionReviewState,
  evaluateArtifactReviewAuthority,
  evaluateArtifactPromotion,
  evaluatePackageArtifactReviewAuthority,
  evaluateBundleComposition,
  evaluateProjectArtifactFinalization,
  evaluateProjectArtifactLineage,
  evaluateProjectStageEdgeCreation,
  evaluateProjectStageAdvance,
  evaluateProjectStageExecutionGate,
  isProjectArtifactLineageKind,
  isProjectArtifactReviewBasisKind,
  isProjectArtifactReviewDecision,
  projectStageTaskProjection,
  type ProjectArtifactLineageCandidate,
  type ProjectArtifactPromotionRejectionCode,
  type ProjectArtifactAuthorityFacts,
  type ProjectArtifactFinalizationRejectionCode,
  type ProjectDocumentBundleMemberCandidate,
  type ProjectDocumentBundleMemberRejectionCode,
} from '../../../../packages/domain/src/index.js';
import {
  evaluateSelectionEligibility,
  resolveOutputPackageProjection,
  resolvePackageReferenceOrdinal,
  resolveReferenceOrdinal,
  type OutputPackageProjectionCollectionFact,
  type OutputPackageProjectionMemberFact,
  type OutputPackageProjectionVersionFact,
  type ProjectReferenceArtifactVersionCandidate,
  type ProjectReferenceBundleCandidate,
  type ProjectReferenceDocumentCandidate,
  type ProjectReferenceOrdinalPackageMember,
  type ProjectReferencePackageCandidate,
  type ProjectReferenceSelectionCandidate,
} from '../../../../packages/domain/src/index.js';
import {
  buildProjectStageUpstreamEdgeFacts,
  resolveProjectStageReviewDecision,
  type ProjectStageFacts,
} from './project-stage-execution-gate.js';
import {
  filterStrictProjectStageAgentIds,
  hasActiveProjectStageInvocation,
  resolveProjectStageClaimFence,
  resolveProjectStageStableInputs,
} from './project-stage-advance-service.js';
import { canReadMemoryCapsule, canReadMemoryScope, createServerMemoryCandidatePermissions, createServerMemoryWritePermissions } from './server-memory-permissions.js';
import type { MemoryGrantRecord } from './memory-repositories.js';
import type { ServerCapsuleRuntimeContextResolver } from './server-capsule-runtime-context-service.js';
import { createPiProviderService, getEmergencyStopActive } from './pi-provider-service.js';
import { createAgentExposureService } from './agent-exposure-service.js';
import { createAgentMemoryProjectionService } from './agent-memory-projection-service.js';
import { createPromotionModesService } from './promotion-modes-service.js';
import {
  parseAgentOrchestrationEscalationCommandV1,
  parsePromotionProposalActionV1,
  parseSemanticPromotionEvaluateCommandV1,
  parseSemanticPromotionRolloutStateV1,
  parseTeamPromotionPolicyApplicationV1,
  parseTeamPromotionPolicyV1,
} from '../../../../packages/contracts/src/index.js';
import { createChannelCoordinator, type CoordinationCycleSummary, type CoordinationJobOutcome } from './channel-coordination-coordinator.js';
import { createCapabilitySummarizer } from './capability-summarizer.js';
import { createChangelogSummarizer } from './changelog-summarizer.js';
import {
  compareChannelFileSnapshots,
  createChannelFileMetrics,
  DEFAULT_CHANNEL_FILE_ROLLOUT,
  type ChannelFileRolloutConfig,
  type ChannelFileSnapshotEntry,
} from './channel-file-rollout.js';
import {
  createProjectCollaborationMetrics,
  FULL_PROJECT_COLLABORATION_ROLLOUT,
  type ProjectCollaborationRolloutConfig,
} from './project-collaboration-rollout.js';
import { createActiveMemoryContextResolver } from './active-memory-context-resolver.js';
import {
  bumpOutputPackageWatermark,
  ensureOutputPackageConsistency,
  OUTPUT_PACKAGE_WATERMARK_STREAM_KIND,
} from './output-package-consistency.js';
import { createOutputPackageService, type OutputPackageService } from './output-package-service.js';
import { readOutputPackageCardMeta } from './output-package-handler.js';
import { ensureUserCanViewChannel } from './channel-access.js';
import type {
  TaskAcceptanceContractV1,
  TaskDeliveryOverviewV1,
  TaskLevelAvailableActionDto,
  TaskResponsibilityFocusV1,
  TaskTimelineEventV1,
} from '../../../../packages/contracts/src/task-delivery-overview.js';
import { type SubmitPackageReviewResult } from './package-review-handler.js';

/** #1061 三个 package review 命令的 socket 输入(teamId 由 socket 会话解析,userId 由 Server 注入)。 */
export interface PackageReviewCommandSocketInput {
  readonly teamId: string;
  readonly channelId: string;
  readonly packageId: string;
  readonly collectionId: string;
  readonly versionId: string;
  readonly decision: 'approved' | 'changes_requested' | 'rejected';
  readonly comment: string;
  readonly idempotencyKey: string;
  readonly expectedCollectionRevision?: number;
  readonly expectedTaskRevision?: number;
  readonly expectedTaskAttempt?: number;
  readonly rejectReason?: string;
}
import type {
  CancelPiProviderTestResult,
  ActivePiModelDto,
  DiscoverPiProviderModelsResult,
  ListPiProviderCardsResult,
  ListPiProviderPresetsResult,
  PiProviderCardDto,
  PublicPiHealthDto,
  PublishPiProviderCardResult,
  RunPiProviderTestResult,
} from '../../../../packages/contracts/src/index.js';

import type {
  ApproveExperiencePackInput,
  ChannelExperienceAttachmentDto,
  ConfirmExperiencePackAttachmentInput,
  CreateExperiencePackDraftInput,
  ExperiencePackDto,
  MarkExperiencePackSourceInvalidInput,
  RecommendExperiencePackToChannelInput,
  RevokeExperiencePackAttachmentInput,
  WithdrawExperiencePackInput,
} from '../../../../packages/contracts/src/index.js';

export interface ServerNextClock {
  now(): number;
}

export interface ServerNextIds {
  nextId(): string;
}

export interface ServerNextJoinCodes {
  nextCode(): string;
}

export interface ServerNextDeviceInviteCodes {
  nextCode(): string;
}

const DELETED_MESSAGE_BODY = '消息已删除';

export interface ArtifactContentStoreWriteInput {
  teamId: string;
  artifactId: string;
  filename: string;
  content: Buffer;
}

export interface ArtifactContentStoreWriteResult {
  storagePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactContentStore {
  writeContent(input: ArtifactContentStoreWriteInput): Promise<ArtifactContentStoreWriteResult>;
  copyContent?(input: {
    teamId: string;
    sourceArtifactId: string;
    sourceStoragePath?: string;
    artifactId: string;
    filename: string;
  }): Promise<ArtifactContentStoreWriteResult>;
  deleteContent?(input: { teamId: string; artifactId: string }): Promise<void>;
}

/** 无 content store 时的兜底:保存直接失败(不产生无内容版本事实)。 */
function dummyContentStore(): ArtifactContentStore {
  return {
    async writeContent() {
      throw new Error('Artifact content store is not configured');
    },
  };
}

export interface ServerNextUseCases {
  registerUser(input: RegisterUserInput): Promise<Ack<RegisterUserResult>>;
  loginUser(input: LoginUserInput): Promise<Ack<LoginUserResult>>;
  whoami(input: WhoamiInput): Promise<Ack<WhoamiResult>>;
  changePassword(input: { userId: string; currentPassword: string; newPassword: string }): Promise<Ack<{}>>;
  /** 用户自删账号：非 admin、且当前不拥有任何 team。供 smoke teardown 与账号注销。 */
  deleteOwnAccount(input: { userId: string }): Promise<Ack<{}>>;
  listTeams(input: { userId: string }): Promise<Ack<ListTeamsResult>>;
  listAdminTeams(input: AdminListQueryInput): Promise<Ack<AdminListPageResult<'teams', AdminTeamDto>>>;
  listAdminUsers(input: AdminListQueryInput): Promise<Ack<AdminListPageResult<'users', AdminUserDto>>>;
  listAdminDevices(input: AdminListQueryInput): Promise<Ack<AdminListPageResult<'devices', AdminDeviceDto>>>;
  listAdminAgents(input: AdminListQueryInput): Promise<Ack<AdminListPageResult<'agents', AdminAgentDto>>>;
  createAdminUser(input: CreateAdminUserInput): Promise<Ack<CreateAdminUserResult>>;
  updateAdminUser(input: UpdateAdminUserInput): Promise<Ack<{ user: AdminUserDto }>>;
  resetAdminUserPassword(input: ResetAdminUserPasswordInput): Promise<Ack<{}>>;
  deleteAdminTeam(input: { userId: string; teamId: string }): Promise<Ack<{}>>;
  deleteAdminUser(input: { adminUserId: string; targetUserId: string }): Promise<Ack<{}>>;
  deleteAdminAgent(input: { userId: string; agentId: string }): Promise<Ack<{}>>;
  transferDeviceOwnerAsAdmin(input: { adminUserId: string; deviceId: string; targetUserId: string }): Promise<Ack<{ device: AdminDeviceDto }>>;
  createTeam(input: CreateTeamInput): Promise<Ack<CreateTeamResult>>;
  switchTeam(input: SwitchTeamInput): Promise<Ack<SwitchTeamResult>>;
  createJoinLink(input: CreateJoinLinkInput): Promise<Ack<JoinLinkResult>>;
  validateJoinLink(input: ValidateJoinLinkInput): Promise<Ack<JoinLinkResult>>;
  listJoinLinks(input: { userId: string; teamId: string }): Promise<Ack<{ links: JoinLinkDto[] }>>;
  revokeJoinLink(input: { userId: string; teamId: string; code: string }): Promise<Ack<{ link: JoinLinkDto }>>;
  createDeviceInvite(input: CreateDeviceInviteInput): Promise<Ack<DeviceInviteAckDto>>;
  waitForDeviceInvite(input: WaitForDeviceInviteInput): Promise<Ack<DeviceInviteAckDto>>;
  completeDeviceInvite(input: CompleteDeviceInviteInput): Promise<Ack<DeviceInviteAckDto & { credentials: DeviceInviteCredentialsDto }>>;
  deviceHelloFromCredentials(input: DeviceHelloFromCredentialsInput): Promise<Ack<{ device: DeviceDto; credentials?: DeviceInviteCredentialsDto; affectedTeamIds: string[] }>>;
  listDevices(input: { teamId: string; userId: string; currentDeviceId?: string | null }): Promise<Ack<{ devices: DeviceDto[] }>>;
  listDeviceAgents(input: { teamId: string; userId: string; deviceId: string }): Promise<Ack<{ agents: DeviceAgentListDto[]; runtimes: RuntimeDto[] }>>;
  getDevice(input: { userId: string; deviceId: string; currentDeviceId?: string | null }): Promise<Ack<{ device: DeviceDetailDto }>>;
  assertCanManageDevice(input: { userId: string; deviceId: string }): Promise<Ack<{ deviceId: string }>>;
  renameDevice(input: { userId: string; deviceId: string; name: string; currentDeviceId?: string | null }): Promise<Ack<{ device: DeviceDto }>>;
  deleteDevice(input: { userId: string; deviceId: string; currentDeviceId?: string | null }): Promise<Ack<{ device: DeviceDto; affectedTeamIds: string[]; channelTeamIds: string[]; deletedDeviceIds: string[] }>>;
  requestDeviceScan(input: RequestDeviceScanInput): Promise<Ack<RequestDeviceScanResult>>;
  deviceHello(input: DeviceHelloInput): Promise<Ack<{
    device: DeviceDto;
    credentials?: DeviceInviteCredentialsDto;
    affectedTeamIds: string[];
    piAuthorityCapabilities?: DaemonPiCapabilityNegotiationV1;
  }>>;
  markDeviceOffline(input: { deviceId: string; timestamp: UnixMs }): Promise<Ack<{ device: DeviceDto; affectedTeamIds: string[] }>>;
  reconcileDisconnectedDevices(input: { timestamp: UnixMs }): Promise<Ack<{ devices: DeviceDto[]; affectedTeamIds: string[] }>>;
  reportDeviceRuntimes(input: ReportDeviceRuntimesInput): Promise<Ack<{ runtimes: RuntimeDto[] }>>;
  reportCustomSkills(input: ReportCustomSkillsInput): Promise<Ack<{ updated: number }>>;
  buildDeviceScanRequest(input: { deviceId: string }): Promise<Ack<{ skipped: boolean; request?: RequestDeviceScanResult['request'] }>>;
  registerDiscoveredAgents(input: RegisterDiscoveredAgentsInput): Promise<Ack<RegisterDiscoveredAgentsResult>>;
  listVisibleAgents(input: { teamId: string }): Promise<Ack<{ agents: AgentDto[] }>>;
  createCustomAgent(input: CreateCustomAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  setAgentTeamVisibility(input: SetAgentTeamVisibilityInput): Promise<Ack<{ agent: AgentDto }>>;
  updateAgentConfig(input: UpdateAgentConfigInput): Promise<Ack<{ agent: AgentDto }>>;
  deleteAgent(input: DeleteAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  listChannels(input: { teamId: string; userId: string }): Promise<Ack<{ channels: ChannelDto[] }>>;
  /**
   * #965 AC#4：读取某次 PI 协调（coordination decision）实际使用的 Active Memory 来源归因。
   * 仅返回 id/来源码/理由码（无正文）。授权在读取时复验：调用方必须是 decision 所在频道的可读
   * 成员；否则 fail-closed 返回 null（不泄露归因的存在，也不泄露其他 scope 的正文）。
   */
  getMemoryAttribution(input: {
    teamId: ID;
    userId: ID;
    /** PI 系统消息 meta.coordination.jobId 携带；优先用它定位 decision。 */
    jobId?: ID;
    /** 无 jobId 时回退用触发协调的人类消息 id 定位。 */
    messageId?: ID;
  }): Promise<Ack<{ attribution: ActiveMemoryAttributionDto | null }>>;
  createChannel(input: CreateChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  updateChannel(input: UpdateChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  addChannelHumanMember(input: ChannelHumanMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  removeChannelHumanMember(input: ChannelHumanMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  leaveChannel(input: { teamId: ID; userId: ID; channelId: ID }): Promise<Ack<{ channel: ChannelDto }>>;
  addChannelAgentMember(input: ChannelAgentMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  removeChannelAgentMember(input: ChannelAgentMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  listChannelMembers(input: ListChannelMembersInput): Promise<Ack<ChannelMembersDto>>;
  /**
   * #1084 系统侧（无 userId 授权）解析频道 Agent 成员的本机 deviceId 集合。
   * fan-out workspace revision committed 通知时，server 用它定位频道在线设备。
   * 直读 channels.agentMemberIds → agents.getById filter visibleTeamIds.includes(teamId) → 取 deviceId。
   * 无授权语义：调用方是 server 内部 fan-out（非用户请求）。
   */
  resolveChannelAgentDeviceIds(input: { teamId: string; channelId: string }): Promise<readonly string[]>;
  archiveChannel(input: ArchiveChannelInput): Promise<Ack<{ channel: ChannelDto } | { preflight: ChannelArchivePreflightDto } | { confirmation: ChannelArchiveConfirmationDto }>>;
  deleteChannel(input: DeleteChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  startDirectMessage(input: StartDirectMessageInput): Promise<Ack<{ dm: DmChannelDto }>>;
  listDirectMessages(input: ListDirectMessagesInput): Promise<Ack<{ dms: DmChannelDto[] }>>;
  snapshotDirectMessage(input: SnapshotDirectMessageInput): Promise<Ack<{ dm: DmChannelDto; messages: MessageDto[] }>>;
  registerAgent(input: AgentDto): Promise<Ack<{ agent: AgentDto }>>;
  sendMessage(input: SendMessageInput): Promise<Ack<SendMessageResult>>;
  /**
   * #921 Message tracer command 派发（ADR-0067 封闭 registry）。默认关闭——messageTracerEnabled=false 时返回
   * disabled；=true 时按 envelope.commandName 路由到 send-message/check-inbox/ack-read-candidate handler。
   * authority（userId/teamId）由 socket session 注入。freshness_hold/conflict/rejected 是合法 outcome（ok:true）。
   */
  dispatchMessageTracerCommand(input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: MessageTracerCommandResponseV1 } | { ok: false; error: string }>;
  /**
   * #929 System activity command 派发（audience-scoped projection / attention / change-feed ack）。
   * authority（userId/teamId）由 socket session 注入。
   */
  dispatchSystemActivityCommand(input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: SystemActivityCommandResponseV1 } | { ok: false; error: string }>;
  /** #929 System activity query（task timeline / thread card / attention inbox / change feed）。 */
  dispatchSystemActivityQuery(input: {
    queryName: SystemActivityQueryName;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: SystemActivityQueryResponseV1 } | { ok: false; error: string }>;
  /** #931 PI authority cutover command/query 派发。 */
  dispatchPiAuthorityCutoverCommand(input: {
    envelope: unknown; payload: unknown; userId: string; teamId: string;
  }): Promise<{ ok: true; response: PiAuthorityCutoverCommandResponseV1 } | { ok: false; error: string }>;
  dispatchPiAuthorityCutoverQuery(input: {
    queryName: PiAuthorityCutoverQueryName; payload: unknown; userId: string; teamId: string;
  }): Promise<{ ok: true; response: PiAuthorityCutoverQueryResponseV1 } | { ok: false; error: string }>;
  /**
   * #1014 Task remediation 具名 command（至少 retry-attempt）。
   * envelope.commandName 路由；authority 由 session 注入。
   */
  dispatchTaskRemediationCommand(input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: TaskRemediationCommandResponseV1 } | { ok: false; error: string }>;
  /** #923 模型评估入口：只产 clarification/proposal/audit，永远不 direct promote。 */
  evaluateSemanticPromotion(input: {
    userId: string;
    teamId: string;
    command: unknown;
  }): Promise<Ack<{ result: unknown }>>;
  /** #923 已认证 Human 对 Server 签发 proposal 执行动作。 */
  actOnPromotionProposal(input: {
    userId: string;
    teamId: string;
    action: unknown;
  }): Promise<Ack<{ result: unknown }>>;
  updateSemanticPromotionRollout(input: {
    userId: string;
    teamId: string;
    state: unknown;
  }): Promise<Ack<{ result: unknown }>>;
  updateTeamPromotionPolicy(input: {
    userId: string;
    teamId: string;
    policy: unknown;
  }): Promise<Ack<{ result: unknown }>>;
  applyTeamPromotionPolicy(input: {
    userId: string;
    teamId: string;
    command: unknown;
  }): Promise<Ack<{ result: unknown }>>;
  /** #923 daemon 认证设备上的责任 Agent 才能请求 escalation。 */
  escalateAgentOrchestration(input: {
    deviceId: string;
    command: unknown;
  }): Promise<Ack<{ result: unknown }>>;
  /** Channel Coordinator（#706）：处理单个 Coordination Job。供测试与生产 driver 调用。 */
  processCoordinationJob(jobId: string): Promise<CoordinationJobOutcome>;
  /** Channel Coordinator（#706）：串行消费所有到期 Job。供测试与生产 driver 调用。 */
  runCoordinationCycle(input?: { now?: number; limit?: number }): Promise<CoordinationCycleSummary>;
  getDispatchRequest(input: {
    dispatchId: string;
    purpose?: 'execute' | 'route';
  }): Promise<Ack<{ request: DispatchRequestDto & { id: string } }>>;
  acceptDispatch(input: AcceptDispatchInput): Promise<Ack<AcceptDispatchResult>>;
  cancelDispatch(input: CancelDispatchInput): Promise<Ack<{ dispatch: DispatchDto; task?: TaskDto }>>;
  cancelChannelDispatches(input: CancelChannelDispatchesInput): Promise<Ack<{ dispatches: DispatchDto[]; tasks?: TaskDto[] }>>;
  listChannelMessages(input: ListChannelMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  listChannelFiles(input: ListChannelFilesInput): Promise<Ack<ChannelFilesResultDto>>;
  searchChannelFiles(input: SearchChannelFilesInput): Promise<Ack<ChannelFilesResultDto>>;
  createProjectChannelWorkspace(input: CreateProjectChannelWorkspaceInput): Promise<Ack<{ workspace: ProjectChannelWorkspaceDto }>>;
  /** #964 Device-initiated import with provenance tracking. */
  importProjectChannelWorkspace(input: ImportProjectChannelWorkspaceInput): Promise<Ack<{ workspace: ProjectChannelWorkspaceDto }>>;
  /** #966 Atomic publish: 基线匹配则整体创建下一 revision；基线落后返回 CONFLICT（当前版本+冲突路径）。 */
  publishProjectChannelWorkspace(input: PublishProjectChannelWorkspaceInput): Promise<Ack<{ workspace: ProjectChannelWorkspaceDto }>>;
  getProjectChannelWorkspace(input: GetProjectChannelWorkspaceInput): Promise<Ack<{ workspace: ProjectChannelWorkspaceDto }>>;
  /**
   * #968 Device-initiated materialization (apply a published revision back to a local dir).
   * Authorizes via device token + channel membership and returns the immutable revision
   * manifest (paths + artifact refs). The server never learns the local target path.
   * Source-Device independent: any device whose owner can view the channel may materialize.
   */
  materializeProjectChannelWorkspace(input: MaterializeProjectChannelWorkspaceInput): Promise<Ack<{ workspace: ProjectChannelWorkspaceDto }>>;
  /** #969 导出归档封存清单（仅频道治理者，只读，不恢复频道/不扩权）。 */
  exportProjectChannelWorkspace(input: ExportProjectChannelWorkspaceInput): Promise<Ack<{ manifest: ArchiveExportManifestDto }>>;
  /** #969 列出 workspace 全部 revision（最新在前）。 */
  listProjectChannelWorkspaceRevisions(input: ListProjectChannelWorkspaceInput): Promise<Ack<{ revisions: ProjectChannelWorkspaceRevisionDto[] }>>;
  /** #1043 将 current/final/整包/显式版本解析为不可变 Device snapshot。 */
  createDeviceWorkspaceSnapshot(input: CreateDeviceWorkspaceSnapshotInput): Promise<Ack<{ snapshot: DeviceWorkspaceSnapshotDto }>>;
  /** #1043 按已冻结身份读取 snapshot；不存在或跨 Team/Channel 均拒绝。 */
  getDeviceWorkspaceSnapshot(input: { token: string; teamId: string; channelId: string; snapshotId: string }): Promise<Ack<{ snapshot: DeviceWorkspaceSnapshotDto }>>;
  /**
   * #967 开启或续用稳定 publish identity 的暂存会话。
   * 上传中内容不进 revision / 频道索引；同 identity + 兼容 plan 幂等返回现有会话。
   */
  beginWorkspacePublishStaging(input: BeginWorkspacePublishStagingInput): Promise<Ack<{ staging: WorkspacePublishStagingDto }>>;
  /** #1003：device token 开启/续用 staging（daemon 生产路径）。 */
  beginWorkspacePublishStagingForDevice(input: DeviceBeginWorkspacePublishStagingInput): Promise<Ack<{ staging: WorkspacePublishStagingDto }>>;
  /** #967 字节续传：同 publishId 可断点续传；已完成文件幂等成功。 */
  putWorkspacePublishStagingFile(input: PutWorkspacePublishStagingFileInput): Promise<Ack<{ staging: WorkspacePublishStagingDto }>>;
  /** #967 hardening：device token 入口的 put（daemon 续传）。 */
  putWorkspacePublishStagingFileForDevice(input: DevicePutWorkspacePublishStagingFileInput): Promise<Ack<{ staging: WorkspacePublishStagingDto }>>;
  /** #967 查询暂存进度或已提交最终结果（幂等）。 */
  getWorkspacePublishStaging(input: GetWorkspacePublishStagingInput): Promise<Ack<{ staging: WorkspacePublishStagingDto }>>;
  /** #967 hardening：device token 查询 staging。 */
  getWorkspacePublishStagingForDevice(input: DeviceGetWorkspacePublishStagingInput): Promise<Ack<{ staging: WorkspacePublishStagingDto }>>;
  /**
   * #967 原子提交暂存 → 新 revision。
   * 重复 commit 同一 publishId 不重复创建 revision；超限/未完成/冲突均无部分结果。
   */
  commitWorkspacePublishStaging(input: CommitWorkspacePublishStagingInput): Promise<Ack<{ staging: WorkspacePublishStagingDto; workspace?: ProjectChannelWorkspaceDto }>>;
  /** #967 hardening：device token 提交 staging。 */
  commitWorkspacePublishStagingForDevice(input: DeviceCommitWorkspacePublishStagingInput): Promise<Ack<{ staging: WorkspacePublishStagingDto; workspace?: ProjectChannelWorkspaceDto }>>;
  /** #967 清理过期未提交暂存（committed 结果保留可查询）。 */
  cleanupExpiredWorkspacePublishStaging(input?: CleanupWorkspacePublishStagingInput): Promise<Ack<{ cleaned: number }>>;
  getChannelProjectOverview(input: GetChannelProjectOverviewInput & { userId: string }): Promise<Ack<{ overview: ChannelProjectOverviewDto | null }>>;
  createInitialProjectStage(input: CreateInitialProjectStageInput & { userId: string }): Promise<Ack<{
    overview: ChannelProjectOverviewDto;
    replayed: boolean;
  }>>;
  createProjectStage(input: CreateProjectStageInput & { userId: string }): Promise<Ack<{
    overview: ChannelProjectOverviewDto;
    replayed: boolean;
  }>>;
  createProjectStageEdge(input: CreateProjectStageEdgeInput & { userId: string }): Promise<Ack<{
    overview: ChannelProjectOverviewDto;
    replayed: boolean;
  }>>;
  deleteProjectStageEdge(input: DeleteProjectStageEdgeInput & { userId: string }): Promise<Ack<{
    overview: ChannelProjectOverviewDto;
    replayed: boolean;
  }>>;
  /** #823 按逻辑产物集合读取当前版、历史、来源与 lineage。 */
  listProjectArtifactCollections(input: ListProjectArtifactCollectionsInput & { userId: string }): Promise<Ack<{
    library: ProjectArtifactLibraryDto;
  }>>;
  /** #823 将频道中已有且可见的不可变 Artifact 显式提升为逻辑产物版本。 */
  promoteArtifactToProjectVersion(input: PromoteArtifactToProjectVersionInput & { userId: string }): Promise<Ack<{
    library: ProjectArtifactLibraryDto;
    collection: ProjectArtifactCollectionDto;
    version: ProjectArtifactVersionDto;
    replayed: boolean;
  }>>;
  submitArtifactReview(input: SubmitProjectArtifactReviewInput & { userId: string }): Promise<Ack<{
    library: ProjectArtifactLibraryDto;
    collection: ProjectArtifactCollectionDto;
    version: ProjectArtifactVersionDto;
    review: ProjectArtifactReviewDto;
    replayed: boolean;
  }>>;
  setArtifactFinalVersion(input: SetProjectArtifactFinalVersionInput & { userId: string }): Promise<Ack<{
    library: ProjectArtifactLibraryDto;
    collection: ProjectArtifactCollectionDto;
    version: ProjectArtifactVersionDto;
    finalization: ProjectArtifactFinalizationDto;
    replayed: boolean;
  }>>;
  /** #1061 对 package 成员版本提交审核(AC1),append-only。 */
  submitPackageArtifactReview(input: PackageReviewCommandSocketInput & { userId: string }): Promise<Ack<{
    review: PackageReviewDto;
    replayed: boolean;
  }>>;
  /** #1061 "通过并设为最终版":一个事务写 review 与 finalization 两个独立事实(AC9)。 */
  submitPackageReviewAndFinalize(input: PackageReviewCommandSocketInput & { userId: string }): Promise<Ack<{
    review: PackageReviewDto;
    finalization: ProjectArtifactFinalizationDto;
    collection: ProjectArtifactCollectionDto;
    replayed: boolean;
  }>>;
  /** #1061 审核(changes_requested/rejected)与退回 Task delivery 原子提交(AC6)。 */
  submitPackageReviewAndRejectDelivery(input: PackageReviewCommandSocketInput & { userId: string }): Promise<Ack<{
    review: PackageReviewDto;
    task: { taskId: string; taskRevision: number; taskAttempt: number; status: string };
    replayed: boolean;
  }>>;
  listProjectDocumentBundles(
    input: ListProjectDocumentBundlesInput & { userId: string },
  ): Promise<Ack<ProjectDocumentBundleListResultDto>>;
  getProjectDocumentBundle(
    input: GetProjectDocumentBundleInput & { userId: string },
  ): Promise<Ack<ProjectDocumentBundleResultDto>>;
  createProjectDocumentBundle(
    input: CreateProjectDocumentBundleInput & { userId: string },
  ): Promise<Ack<ProjectDocumentBundleResultDto & { replayed: boolean }>>;
  resolveProjectReferences(
    input: ResolveProjectReferencesInput & { userId: string },
  ): Promise<Ack<ResolveProjectReferencesResultDto>>;
  resolveProjectReferenceOrdinal(
    input: ResolveProjectReferenceOrdinalInput & { userId: string },
  ): Promise<Ack<ResolveProjectReferenceOrdinalResultDto>>;
  /** #1060 列出频道 OutputPackage(三处投影共用同一 Server 事实)。 */
  listOutputPackages(
    input: { teamId: string; channelId: string; taskId?: string; userId: string; limit?: number; cursor?: { createdAt: number; packageId: string }; minimumConsistency?: ConsistencyTokenV1; currentDeviceId?: string | null },
  ): Promise<Ack<{ packages: OutputPackageSummaryDto[]; pendingDeliveries: OutputPackagePendingDeliveryDto[]; nextCursor?: { createdAt: number; packageId: string } }>>;
  /** #1060 获取单个 OutputPackage(含冻结成员);#1063 支持可选 projection 请求。 */
  getOutputPackage(
    input: {
      teamId: string;
      channelId: string;
      packageId: string;
      userId: string;
      projection?: { policy: OutputPackageProjectionPolicy; versions?: { collectionId: string; versionId: string }[] };
      minimumConsistency?: ConsistencyTokenV1;
      currentDeviceId?: string | null;
    },
  ): Promise<Ack<{
    package: OutputPackageDto;
    projection?: OutputPackageProjectionResultV1;
    asOf: number;
    audienceScope: string;
  }>>;
  /** #1065 AC3/AC4：Task 交付聚合视图(目标/acceptance/焦点/availableActions/时间线)。 */
  queryTaskDeliveryOverview(
    input: { teamId: string; channelId: string; taskId: string; userId: string; minimumConsistency?: ConsistencyTokenV1 },
  ): Promise<Ack<{ overview: TaskDeliveryOverviewV1 }>>;
  /** #1062 基于明确版本保存 Markdown 修订(原子产生新版本并移动 current;stale → 结构化 conflict)。 */
  saveArtifactVersionRevision(input: {
    userId: string;
    teamId: string;
    channelId: string;
    collectionId: string;
    baseVersionId: string;
    content: string;
    filename?: string;
    expectedCollectionRevision: number;
    revisionBasis: {
      sourceVersionId: string;
      basisReviewId?: string;
      packageId?: string;
      deliveryId?: string;
    };
    idempotencyKey: string;
    /** socket bind 层注入的传输元数据;usecase 剥离,不进 wire payload 校验。 */
    currentDeviceId?: string | null;
  }): Promise<
    Ack<{
      revision: ArtifactVersionRevisionSaveResultDto;
      replayed: boolean;
    }>
  >;
  listChannelDocuments(input: ListChannelDocumentsInput): Promise<Ack<{ documents: ChannelDocumentDto[] }>>;
  getChannelDocument(input: GetChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  listChannelDocumentRevisions(input: ListChannelDocumentRevisionsInput): Promise<Ack<ChannelDocumentRevisionsResultDto>>;
  deriveChannelDocument(input: DeriveChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  saveChannelDocument(input: SaveChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  restoreChannelDocument(input: RestoreChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  publishChannelDocument(input: PublishChannelDocumentInput): Promise<Ack<PublishChannelDocumentResultDto>>;
  searchMessages(input: SearchMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  getMessageContext(input: GetMessageContextInput): Promise<Ack<{ targetMessageId: ID; messages: MessageDto[]; threadRootId?: ID }>>;
  convertMessageToTask(input: ConvertMessageToTaskInput): Promise<Ack<{ message: MessageDto; task: TaskDto }>>;
  listTasks(input: ListTasksInput): Promise<Ack<{ tasks: TaskDto[] }>>;
  getTaskDag(input: { userId: string; teamId: string; rootTaskId: string }): Promise<Ack<{ dag: TaskDagViewDto }>>;
  summarizeAgentMetrics(input: { userId: string; teamId: string }): Promise<Ack<{ summaries: AgentMetricsSummary[] }>>;
  /** 每日更新日志 LLM 兜底（仅 CI 内部端点调用，见 dev-server handleChangelogSummarizeHttp）。 */
  summarizeChangelogEntries(input: {
    pulls: { number: number; title: string; body: string }[];
  }): Promise<Ack<{ results: { number: number; entries: { type: '新功能' | '改进' | '修复'; text: string }[] }[] }>>;
  createTask(input: CreateTaskInput): Promise<Ack<{ task: TaskDto }>>;
  updateTask(input: UpdateTaskInput): Promise<Ack<{ task: TaskDto; message?: MessageDto }>>;
  deleteTask(input: DeleteTaskInput): Promise<Ack<{ task: TaskDto }>>;
  cancelTask(input: CancelTaskInput): Promise<Ack<{ task: TaskDto }>>;
  closeTask(input: CloseTaskInput): Promise<Ack<{ task: TaskDto }>>;
  /** #995 根交付人审 accept（human authority → lifecycle accept-root-delivery）。 */
  acceptRootDelivery(input: AcceptRootDeliveryInput): Promise<Ack<{ task: TaskDto }>>;
  /** #995 根交付人审 reject（human authority → lifecycle reject-root-delivery）。 */
  rejectRootDelivery(input: RejectRootDeliveryInput): Promise<Ack<{ task: TaskDto }>>;
  reorderTask(input: ReorderTaskInput): Promise<Ack<{ task: TaskDto }>>;
  uploadArtifact(input: UploadArtifactInput): Promise<Ack<{ artifact: ArtifactDto }>>;
  uploadArtifactForDevice(input: DeviceUploadArtifactInput): Promise<Ack<{ artifact: ArtifactDto }>>;
  getArtifact(input: GetArtifactInput): Promise<Ack<{ artifact: ArtifactDto }>>;
  getArtifactFile(input: GetArtifactInput): Promise<Ack<{ artifact: ArtifactDto; storagePath?: string }>>;
  getArtifactFileForDevice(input: DeviceGetArtifactInput): Promise<Ack<{ artifact: ArtifactDto; storagePath?: string }>>;
  getWorkspaceRun(input: GetWorkspaceRunInput): Promise<Ack<{ workspaceRun: WorkspaceRunDto }>>;
  getWorkspaceRunDetail(input: GetWorkspaceRunInput): Promise<Ack<{ workspaceRun: WorkspaceRunDto; artifacts: ArtifactDto[] }>>;
  getWorkspaceRunLogFile(input: GetWorkspaceRunInput): Promise<Ack<{ artifact: ArtifactDto; storagePath?: string }>>;
  listTeamWorkspaceRuns(input: ListTeamWorkspaceRunsInput): Promise<Ack<{ runs: TeamWorkspaceRunListItemDto[]; nextCursor?: string }>>;
  listAgentWorkspaceRuns(input: ListAgentWorkspaceRunsInput): Promise<Ack<{ runs: AgentWorkspaceRunListItemDto[] }>>;
  failTimedOutDispatches(input: { heartbeatCutoff: number; legacyCutoff: number }): Promise<Ack<{ dispatches: DispatchDto[]; tasks?: TaskDto[] }>>;
  receiveDispatchResult(input: ReceiveDispatchResultInput): Promise<Ack<ReceiveDispatchResultResult>>;
  receiveDispatchError(input: ReceiveDispatchErrorInput): Promise<Ack<ReceiveDispatchErrorResult>>;
  receiveDispatchProgress(input: ReceiveDispatchProgressInput): Promise<Ack<ReceiveDispatchProgressResult>>;
  reactMessage(input: ReactMessageInput): Promise<Ack<{ messageId: string }>>;
  saveMessage(input: SaveMessageInput): Promise<Ack<{ messageId: string }>>;
  listSavedMessages(input: ListSavedMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  pinMessage(input: PinMessageInput): Promise<Ack<{ messageId: string; channelId: string }>>;
  listPinnedMessages(input: ListPinnedMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  editMessage(input: EditMessageInput): Promise<Ack<{ message: MessageDto }>>;
  deleteMessage(input: DeleteMessageInput): Promise<Ack<{ message: MessageDto }>>;
  updateMemberRole(input: UpdateMemberRoleInput): Promise<Ack<{ member: { id: string; teamId: string; userId: string; username: string; role: string } }>>;
  removeMember(input: RemoveMemberInput): Promise<Ack<{ userId: string }>>;
  transferOwner(input: TransferOwnerInput): Promise<Ack<{ team: { id: string; name: string }; member: { id: string; teamId: string; userId: string; username: string; role: string } }>>;
  listMembers(input: ListMembersInput): Promise<Ack<{ humans: Array<{ id: string; teamId: string; userId: string; username: string; role: string; displayName?: string; joinedAt: number }>; agents: any[] }>>;
  getAgentEnvForDevice(input: { token: string; teamId: string; agentId: string }): Promise<Ack<{ env: Record<string, string> }>>;
  updateMemberHuman(input: UpdateMemberHumanInput): Promise<Ack<{ human: { id: string; teamId: string; userId: string; username: string; role: string; displayName?: string; joinedAt: number } }>>;
  updateTeam(input: UpdateTeamInput): Promise<Ack<{ team: { id: string; name: string; path: string } }>>;
  /** 公开入口接受 unknown，由运行时 exact-key parser fail closed。 */
  listPiProviderPresets(input: unknown): Promise<Ack<ListPiProviderPresetsResult>>;
  listPiProviderCards(input: unknown): Promise<Ack<ListPiProviderCardsResult>>;
  getPiProviderCard(input: unknown): Promise<Ack<{ card: PiProviderCardDto }>>;
  createPiProviderCard(input: unknown): Promise<Ack<{ card: PiProviderCardDto }>>;
  updatePiProviderCard(input: unknown): Promise<Ack<{ card: PiProviderCardDto }>>;
  copyPiProviderCard(input: unknown): Promise<Ack<{ card: PiProviderCardDto }>>;
  discoverPiProviderModels(input: unknown): Promise<Ack<DiscoverPiProviderModelsResult>>;
  runPiProviderTest(input: unknown): Promise<Ack<RunPiProviderTestResult>>;
  cancelPiProviderTest(input: unknown): Promise<Ack<CancelPiProviderTestResult>>;
  publishPiProviderCard(input: unknown): Promise<Ack<PublishPiProviderCardResult>>;
  setActivePiModel(input: unknown): Promise<Ack<{ activeModel: ActivePiModelDto }>>;
  getActivePiModel(input: unknown): Promise<Ack<{ activeModel: ActivePiModelDto | null; history: ActivePiModelDto[]; health: PublicPiHealthDto }>>;
  getPublicPiHealth(input: unknown): Promise<Ack<{ health: PublicPiHealthDto }>>;
  /** #699 US 84：系统管理员紧急停止/恢复 PI 自动协调。 */
  setEmergencyStop(input: unknown): Promise<Ack<{ emergencyStopActive: boolean }>>;
  /** #699 US 84：读取 PI 紧急停止状态。 */
  getEmergencyStop(input: unknown): Promise<Ack<{ emergencyStopActive: boolean }>>;
  /** #699 US 29：查询当前 Team 的 PI Token Usage。since 为可选时间戳（ms）。 */
  getTeamPiTokenUsage(input: unknown): Promise<Ack<{ totalInputTokens: number; totalOutputTokens: number; totalDecisions: number }>>;
  /** Team PI 自动协调开关（#707）。任意成员可读；返回仅 autoCoordinationEnabled（AC#1）。 */
  getPiPolicy(input: { teamId: string; userId: string }): Promise<Ack<{ autoCoordinationEnabled: boolean }>>;
  /** 更新 Team PI 自动协调开关；仅 Owner/Admin（AC#2）。 */
  updatePiPolicy(input: { teamId: string; userId: string; autoCoordinationEnabled: boolean }): Promise<Ack<{ autoCoordinationEnabled: boolean }>>;
  /** #710 Agent Exposure：owner 创建 Draft。 */
  createAgentExposureDraft(input: CreateAgentExposureDraftInput): Promise<Ack<{ manifest: AgentExposureManifestRevisionDto }>>;
  updateAgentExposureDraft(input: UpdateAgentExposureDraftInput): Promise<Ack<{ manifest: AgentExposureManifestRevisionDto }>>;
  publishAgentExposure(input: PublishAgentExposureInput): Promise<Ack<{ manifest: AgentExposureManifestRevisionDto; supersededManifestId: string | null }>>;
  revokeAgentExposure(input: RevokeAgentExposureInput): Promise<Ack<{ revoked: boolean }>>;
  listAgentExposureRevisions(input: ListAgentExposureRevisionsInput): Promise<Ack<{ revisions: readonly AgentExposureManifestRevisionDto[]; activeRestriction: AgentExposureRestrictionDto | null }>>;
  /** PI/成员只读 active 投影（AC#3）。 */
  getAgentExposureActive(input: GetAgentExposureActiveInput): Promise<Ack<{ projection: AgentExposureActiveProjectionDto | null }>>;
  /** Team Owner/Admin 收紧（AC#4 fail-closed）。 */
  upsertAgentExposureRestriction(input: UpsertAgentExposureRestrictionInput): Promise<Ack<{ restriction: AgentExposureRestrictionDto }>>;
  /** PI Team 页只读 coverage（AC#5）。 */
  getAgentTeamCoverage(input: GetAgentTeamCoverageInput): Promise<Ack<{ coverage: AgentTeamCoverageDto }>>;
  /** #718 Agent Memory Projection：owner 创建 Draft（AC#2）。 */
  createAgentMemoryProjectionDraft(input: CreateAgentMemoryProjectionDraftInput): Promise<Ack<{ projection: AgentMemoryProjectionDto }>>;
  updateAgentMemoryProjectionDraft(input: UpdateAgentMemoryProjectionDraftInput): Promise<Ack<{ projection: AgentMemoryProjectionDto }>>;
  publishAgentMemoryProjection(input: PublishAgentMemoryProjectionInput): Promise<Ack<{ projection: AgentMemoryProjectionDto; supersededProjectionId: string | null }>>;
  withdrawAgentMemoryProjection(input: WithdrawAgentMemoryProjectionInput): Promise<Ack<{ withdrawn: boolean }>>;
  listAgentMemoryProjectionRevisions(input: ListAgentMemoryProjectionRevisionsInput): Promise<Ack<{ revisions: readonly AgentMemoryProjectionDto[]; activeOptIn: TeamAgentMemoryOptInDto | null }>>;
  /** Team Owner/Admin 启用/停用本 Team 对投影的使用（AC#3）。 */
  upsertTeamAgentMemoryOptIn(input: UpsertTeamAgentMemoryOptInInput): Promise<Ack<{ optIn: TeamAgentMemoryOptInDto }>>;
  /** PI/成员只读消费当前 Team 已启用投影（AC#6/AC#7 fail-closed）。 */
  getConsumableAgentMemoryProjections(input: GetConsumableAgentMemoryProjectionsInput): Promise<Ack<GetConsumableAgentMemoryProjectionsResult>>;
  getMemoryGovernanceSnapshot(input: { userId: string; teamId: string }): Promise<Ack<{ snapshot: MemoryGovernanceSnapshotDto }>>;
  createCollaborativeMemory(input: { userId: string; teamId: string; kind: MemoryKind; scopeType: MemoryScopeType; scopeRef: string; content: string; summary?: string; tags?: readonly string[]; validUntil?: number; asCandidate?: boolean }): Promise<Ack<{ memory: MemoryView }>>;
  updateCollaborativeMemory(input: { userId: string; teamId: string; memoryId: string; expectedUpdatedAt: number; content?: string; summary?: string; tags?: readonly string[]; validUntil?: number }): Promise<Ack<{ memory: MemoryView }>>;
  expireCollaborativeMemory(input: { userId: string; teamId: string; memoryId: string }): Promise<Ack<{ memory: MemoryView }>>;
  supersedeCollaborativeMemory(input: { userId: string; teamId: string; memoryId: string; content: string; summary?: string; tags?: readonly string[] }): Promise<Ack<{ memory: MemoryView }>>;
  deleteCollaborativeMemory(input: { userId: string; teamId: string; memoryId: string }): Promise<Ack<{ memory: MemoryView }>>;
  issueMemoryGrant(input: { userId: string; teamId: string; grantId?: string; sourceScopeType: MemoryScopeType; sourceScopeRef: string; targetAgentId: string; authorizedContentKind: MemoryContentKind; authorizedRedactionLevel: MemoryRedactionLevel; expiresAt: number }): Promise<Ack<{ grant: MemoryGrantRecord }>>;
  revokeMemoryGrant(input: { userId: string; teamId: string; grantId: string }): Promise<Ack<{ grant: MemoryGrantRecord }>>;
  acceptMemoryCandidate(input: { userId: string; teamId: string; candidateId: string; kind: MemoryKind; summary?: string; tags?: readonly string[]; validUntil?: number }): Promise<Ack<{ candidate: MemoryCandidateView }>>;
  rejectMemoryCandidate(input: { userId: string; teamId: string; candidateId: string }): Promise<Ack<{ candidate: MemoryCandidateView }>>;
  mergeMemoryCandidate(input: { userId: string; teamId: string; candidateId: string; conflictMemoryId: string }): Promise<Ack<{ candidate: MemoryCandidateView }>>;
  getFormalMemories(input: { userId: string; teamId: string; scopeType: FormalMemoryScopeType; scopeRef: string }): Promise<Ack<{ list: FormalMemoryListDto }>>;
  getFormalMemoryDetail(input: { userId: string; teamId: string; memoryId: string }): Promise<Ack<{ memory: FormalMemoryDetailDto }>>;
  createFormalMemory(input: { userId: string; teamId: string; kind: FormalMemoryKind; scopeType: FormalMemoryScopeType; scopeRef: string; content: string; summary?: string; tags?: readonly string[]; changeReason?: string; validUntil?: number }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  reviseFormalMemory(input: { userId: string; teamId: string; memoryId: string; content: string; summary?: string; tags?: readonly string[]; changeReason: string }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  deactivateFormalMemory(input: { userId: string; teamId: string; memoryId: string; changeReason: string }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  deleteFormalMemory(input: { userId: string; teamId: string; memoryId: string; changeReason?: string }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  proposeFormalCorrection(input: { userId: string; teamId: string; scopeType: FormalMemoryScopeType; scopeRef: string; targetMemoryId?: string; correctionType: 'revise' | 'delete'; kind?: FormalMemoryKind; content: string; summary?: string; reason: string }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  acceptFormalCorrection(input: { userId: string; teamId: string; memoryId: string }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  rejectFormalCorrection(input: { userId: string; teamId: string; memoryId: string; changeReason?: string }): Promise<Ack<{ memory: FormalMemoryDto }>>;
  getSystemKnowledge(input: { userId: string }): Promise<Ack<{ list: SystemKnowledgeListDto }>>;
  getSystemKnowledgeDetail(input: { userId: string; memoryId: string }): Promise<Ack<{ memory: SystemKnowledgeDetailDto }>>;
  createSystemKnowledge(input: { userId: string; kind: FormalMemoryKind; content: string; summary?: string; changeReason?: string; validUntil?: number }): Promise<Ack<{ memory: SystemKnowledgeDto }>>;
  reviseSystemKnowledge(input: { userId: string; memoryId: string; content: string; summary?: string; changeReason: string; validUntil?: number }): Promise<Ack<{ memory: SystemKnowledgeDto }>>;
  deactivateSystemKnowledge(input: { userId: string; memoryId: string; changeReason: string }): Promise<Ack<{ memory: SystemKnowledgeDto }>>;
  deleteSystemKnowledge(input: { userId: string; memoryId: string; changeReason?: string }): Promise<Ack<{ deleted: true }>>;
  getUserMemory(input: { userId: string }): Promise<Ack<{ list: UserMemoryListDto }>>;
  getUserMemoryDetail(input: { userId: string; memoryId: string }): Promise<Ack<{ memory: UserMemoryDetailDto }>>;
  createUserMemory(input: { userId: string; kind: FormalMemoryKind; content: string; summary?: string; changeReason?: string; validUntil?: number }): Promise<Ack<{ memory: UserMemoryDto }>>;
  reviseUserMemory(input: { userId: string; memoryId: string; content: string; summary?: string; changeReason: string; validUntil?: number }): Promise<Ack<{ memory: UserMemoryDto }>>;
  deactivateUserMemory(input: { userId: string; memoryId: string; changeReason: string }): Promise<Ack<{ memory: UserMemoryDto }>>;
  deleteUserMemory(input: { userId: string; memoryId: string; changeReason?: string }): Promise<Ack<{ deleted: true }>>;
  // #722+#723 Experience Pack
  createExperiencePackDraft(input: CreateExperiencePackDraftInput): Promise<Ack<{ pack: ExperiencePackDto }>>;
  approveExperiencePack(input: ApproveExperiencePackInput): Promise<Ack<{ pack: ExperiencePackDto }>>;
  withdrawExperiencePack(input: WithdrawExperiencePackInput): Promise<Ack<{ pack: ExperiencePackDto }>>;
  markExperiencePackSourceInvalid(input: MarkExperiencePackSourceInvalidInput): Promise<Ack<{ pack: ExperiencePackDto }>>;
  listExperiencePacks(input: { teamId: ID; userId: ID; status?: string }): Promise<Ack<{ packs: readonly ExperiencePackDto[] }>>;
  getExperiencePack(input: { teamId: ID; userId: ID; packId: ID }): Promise<Ack<{ pack: ExperiencePackDto }>>;
  recommendExperiencePackToChannel(input: RecommendExperiencePackToChannelInput): Promise<Ack<{ attachment: ChannelExperienceAttachmentDto }>>;
  confirmExperiencePackAttachment(input: ConfirmExperiencePackAttachmentInput): Promise<Ack<{ attachment: ChannelExperienceAttachmentDto }>>;
  revokeExperiencePackAttachment(input: RevokeExperiencePackAttachmentInput): Promise<Ack<{ attachment: ChannelExperienceAttachmentDto }>>;

  deleteTeam(input: DeleteTeamInput): Promise<Ack<{ fallbackTeam: { id: string; name: string; path: string } | null }>>;
}

export interface RegisterUserInput {
  username: string;
  password: string;
  teamName?: string;
  joinCode?: string;
}

export interface RegisterUserResult {
  token: string;
  user: UserDto;
  currentTeam: TeamDto;
  defaultChannel: ChannelDto;
  joinedTeam?: TeamDto;
}

/** System admin creates a user; default path also creates a personal private team. */
export interface CreateAdminUserInput {
  adminUserId: string;
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
  /**
   * When true (default), create a personal private Team (owner + default channel)
   * so the new user can log in immediately. When false, user can only enter via invite code.
   */
  createPersonalTeam?: boolean;
}

export interface CreateAdminUserResult {
  user: AdminUserDto;
  team?: TeamDto;
  defaultChannel?: ChannelDto;
}

/** System admin updates display name, email, and/or system role. */
export interface UpdateAdminUserInput {
  adminUserId: string;
  targetUserId: string;
  displayName?: string | null;
  email?: string | null;
  role?: UserRole;
}

/** System admin sets a new password without knowing the current one. */
export interface ResetAdminUserPasswordInput {
  adminUserId: string;
  targetUserId: string;
  newPassword: string;
}

type DeviceAgentListDto = AgentDto & {
  deviceName?: string;
};

type AgentMemberDto = AgentDto & {
  deviceName?: string;
};

type AgentMemberProjection = {
  dto: AgentMemberDto;
  rawDeviceId?: string;
};

type AdminTeamDto = Omit<TeamDto, 'currentUserRole'> & {
  currentUserRole?: TeamDto['currentUserRole'];
  members: Array<HumanMemberDto & { joinedAt?: number }>;
};

type AdminUserDto = Omit<UserDto, 'displayName' | 'email'> & {
  createdAt: number;
  /** Null means cleared; omitted/undefined means unset. Explicit null survives JSON merge on clients. */
  displayName?: string | null;
  email?: string | null;
};

type AdminAgentDto = AgentDto & {
  role?: string;
  primaryTeamName: string;
  ownerName?: string | null;
  userName?: string | null;
  deviceName?: string | null;
  deviceUserId?: string | null;
  deviceUserName?: string | null;
};

/**
 * System inventory list query: 1-based page, default pageSize 20, clamped to [1, 100].
 * Optional `q` filters after sort and before slice (case-insensitive substring).
 */
type AdminListQueryInput = {
  userId: string;
  page?: number;
  pageSize?: number;
  /** Keyword filter; empty/whitespace means no filter. */
  q?: string;
};

type AdminListPageMeta = {
  page: number;
  pageSize: number;
  total: number;
};

type AdminListPageResult<K extends string, TItem> = AdminListPageMeta & {
  [P in K]: TItem[];
};

type AdminDeviceDto = DeviceDto & {
  userId: string;
  userName: string;
  teamName: string;
  agentCount: number;
  runtimes: RuntimeDto[];
  agents: AdminAgentDto[];
};

export interface LoginUserInput {
  username: string;
  password: string;
  joinCode?: string;
}

export interface LoginUserResult {
  token: string;
  user: UserDto;
  currentTeam: TeamDto;
  joinedTeam?: TeamDto;
}

export interface WhoamiInput {
  token: string;
  deviceToken?: string;
}

export interface WhoamiResult {
  user: UserDto;
  currentTeam: TeamDto;
  verifiedCurrentDeviceId?: string;
  deviceCredentialStatus?: 'verified' | 'pending' | 'invalid';
}

export interface ListTeamsResult {
  currentTeamId?: string;
  teams: TeamDto[];
}

export interface CreateTeamInput {
  userId: string;
  name: string;
}

export interface CreateTeamResult {
  team: TeamDto;
  defaultChannel: ChannelDto;
}

export interface SwitchTeamInput {
  userId: string;
  teamId: string;
}

export interface SwitchTeamResult {
  currentTeam: TeamDto;
}

export interface CreateJoinLinkInput {
  userId: string;
  teamId: string;
  expiresAt?: number;
  maxUses?: number;
}

export interface ValidateJoinLinkInput {
  code: string;
}

export interface JoinLinkResult {
  link: JoinLinkDto;
  team: TeamDto;
}

export interface CreateDeviceInviteInput {
  userId: string;
  teamId: string;
  profileId?: string;
  expiresAt?: number;
}

export interface WaitForDeviceInviteInput {
  code: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  serverUrl?: string;
}

export interface CompleteDeviceInviteInput {
  userId: string;
  code: string;
  serverUrl?: string;
}

export interface DeviceHelloFromCredentialsInput {
  token: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: DeviceDto['systemInfo'];
  capabilities?: DeviceDto['capabilities'];
}

export interface DeviceHelloInput {
  teamId: string;
  ownerId: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: DeviceDto['systemInfo'];
  capabilities?: DeviceDto['capabilities'];
}

export interface RequestDeviceScanInput {
  userId: string;
  deviceId: string;
}

export interface RequestDeviceScanResult {
  request: {
    requestId: string;
    deviceId: string;
    customAgents?: ScanRequestCustomAgent[];
  };
}

export interface ReportCustomSkillsInput {
  teamId: string;
  deviceId: string;
  items: Array<{ agentId: string; skills: SkillDto[] }>;
}

export interface ReportDeviceRuntimesInput {
  teamId: string;
  deviceId: string;
  runtimes: Array<{
    adapterKind: string;
    name: string;
    command?: string;
    cwd?: string;
    version?: string;
    installed?: boolean;
  }>;
}

export interface DiscoveredAgentInput {
  name: string;
  adapterKind: string;
  category: AgentCategory;
  command?: string;
  args?: string[];
  cwd?: string;
  discoverySource?: 'runtime' | 'gateway' | 'filesystem';
  gatewayInstanceKey?: string;
  projectDocumentInputSetVersions?: number[];
  /** daemon 扫描 cwd/AGENTS.md（或 CLAUDE.md）得到的 Agent 自描述。 */
  descriptor?: AgentDescriptorDto | null;
}

export interface RegisterDiscoveredAgentsInput {
  teamId: string;
  deviceId: string;
  agents: DiscoveredAgentInput[];
}

export interface RegisterDiscoveredAgentsResult {
  agents: AgentDto[];
  missingOfflineIds: string[];
}

export interface CreateCustomAgentInput {
  userId: string;
  teamId: string;
  deviceId: string;
  runtimeId?: string;
  name: string;
  description?: string;
  adapterKind?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  projectDocumentInputSetVersions?: number[];
  /** web 连接上报的本机设备 id，用于校验 custom agent runtime 只能在本地设备创建。 */
  currentDeviceId?: string | null;
}

export interface UpdateAgentConfigInput {
  userId: string;
  teamId: string;
  agentId: string;
  runtimeId?: string;
  name?: string;
  description?: string | null;
  adapterKind?: AdapterKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** web 连接上报的本机设备 id，用于校验 runtime 设置只能在本地设备修改。 */
  currentDeviceId?: string | null;
}

export interface DeleteAgentInput {
  userId: string;
  teamId: string;
  agentId: string;
}

export interface SendMessageInput {
  userId: string;
  teamId: string;
  channelId: string;
  /** Optional durable server message id for transport-level replay. */
  messageId?: string;
  threadId?: string;
  body: string;
  asTask?: boolean;
  artifactIds?: string[];
  clientMessageId?: string;
  senderId?: string;
  senderKind?: string;
  connectedAgentDeviceIds?: string[];
  dispatchClaimDeviceIds?: string[];
  meta?: MessageMetaDto;
  selections?: ProjectReferenceSelectionRequestDto[];
}

export interface SendMessageResult {
  message: MessageDto;
  dispatches: DispatchDto[];
  route?: RouteResult;
  coalescedDispatchId?: string;
  task?: TaskDto;
  acknowledgementMessage?: MessageDto;
  management?: ManagementRoutingResult;
  referenceSet?: ProjectReferenceSetDto;
}

export interface AcceptDispatchInput {
  dispatchId: string;
  agentId: string;
  deviceId?: string;
  quietWindowMs: number;
}

export type AcceptDispatchResult =
  | { ready: false; retryAfterMs: number }
  | { ready: true; dispatch: DispatchDto; request: DispatchRequestDto & { id: string } };

export interface ListChannelMessagesInput {
  channelId: string;
  limit: number;
}

export interface ListChannelFilesInput {
  userId: string;
  teamId: string;
  channelId: string;
  cursor?: string;
  pageSize?: number;
  path?: string;
  role?: ArtifactRole | 'all';
}

export interface SearchChannelFilesInput extends ListChannelFilesInput {
  query: string;
}

export interface CreateProjectChannelWorkspaceInput {
  userId: string;
  teamId: string;
  channelId: string;
  files: Array<Pick<ProjectChannelWorkspaceFileDto, 'path' | 'artifactId'>>;
}

export interface GetProjectChannelWorkspaceInput {
  userId: string;
  teamId: string;
  channelId: string;
  revisionId?: string;
}

/** #969 归档导出输入（治理者授权在 usecases 内用 canApplyChannelUpdate 判定，与 archiveChannel 同）。 */
export interface ExportProjectChannelWorkspaceInput {
  userId: string;
  teamId: string;
  channelId: string;
}

/** #969 列出 workspace 全部 revision 输入。 */
export interface ListProjectChannelWorkspaceInput {
  userId: string;
  teamId: string;
  channelId: string;
}

/** #964 Device-initiated workspace import. Auth via device token in payload. */
export interface ImportProjectChannelWorkspaceInput {
  token: string;
  teamId: string;
  channelId: string;
  files: Array<Pick<ProjectChannelWorkspaceFileDto, 'path' | 'artifactId'>>;
}

/**
 * #966 Atomic workspace publish. 以基线 revision 为依据整体发布下一 revision。
 * 基线落后 → CONFLICT（返回当前版本 + 冲突路径，不写、不合 publish）。权限撤销/校验失败/冲突均无部分结果。
 */
export interface PublishProjectChannelWorkspaceInput {
  userId: string;
  teamId: string;
  channelId: string;
  /** 调用方读取的固定输入 revision（基线）。 */
  baselineRevisionId: string;
  files: Array<Pick<ProjectChannelWorkspaceFileDto, 'path' | 'artifactId'>>;
  /** #966 交付 Agent 身份，写入 publish provenance（AC#4）。省略=非 Agent 发布（无 provenance）。 */
  provenance?: { agentId: string; taskId: string; taskAttempt: number };
}

/**
 * #968 Device-initiated workspace materialization (apply published revision to local).
 * Auth via device token; the local target directory is chosen client-side and never sent.
 */
export interface MaterializeProjectChannelWorkspaceInput {
  token: string;
  teamId: string;
  channelId: string;
  /** Specific revision to materialize; defaults to the workspace's current revision. */
  revisionId?: string;
  /**
   * #1056：跨 Team device 调用时必须声明本次执行 Agent——服务端按该 Agent 的
   * device 绑定 + visibleTeamIds + Channel membership 授权（codex P1：不能只按
   * 设备上任意 Agent 放行）。同 Team 调用不需要。
   */
  agentId?: string;
}

/** #967 begin：稳定 publish identity + 计划文件清单（size/sha 用于上限与完整性校验）。 */
export interface BeginWorkspacePublishStagingInput {
  userId: string;
  teamId: string;
  channelId: string;
  publishId: string;
  baselineRevisionId: string;
  files: Array<{
    path: string;
    filename?: string;
    mimeType?: string;
    expectedSizeBytes: number;
    expectedSha256: string;
  }>;
  provenance?: { agentId: string; taskId: string; taskAttempt: number; workspaceRunId?: string; deviceId?: string };
  /** 可选覆盖 Server 默认上限（测试用）；生产由配置注入。 */
  limits?: { maxFileBytes?: number; maxPublishBytes?: number };
  /** #1044 device 路径内部透传：commit 重验 device↔agent 绑定用；HTTP/socket 合同不暴露。 */
  deviceId?: string;
  /**
   * #1056 device 跨 Team publish 内部透传（仅 ForDevice wrapper 设置；HTTP/socket
   * 客户端无法伪造——访问判定时用 sessionSecret 重新验签）：owner 非目标 Team
   * 成员时频道访问由 Agent 授权承担，不再要求人类成员身份。
   */
  deviceActorToken?: string;
}

export interface PutWorkspacePublishStagingFileInput {
  userId: string;
  teamId: string;
  channelId: string;
  publishId: string;
  path: string;
  /** 严格串行续传偏移，必须等于当前 receivedBytes。 */
  offset: number;
  /** 原始字节（测试与 usecase 直调）；HTTP 层可先读入再传入。 */
  content: Buffer | Uint8Array | string;
  limits?: { maxFileBytes?: number; maxPublishBytes?: number };
  /** #1056 同 BeginWorkspacePublishStagingInput.deviceActorToken。 */
  deviceActorToken?: string;
}

export interface DeviceBeginWorkspacePublishStagingInput {
  token: string;
  teamId: string;
  channelId: string;
  publishId: string;
  baselineRevisionId: string;
  files: BeginWorkspacePublishStagingInput['files'];
  provenance?: BeginWorkspacePublishStagingInput['provenance'];
  limits?: BeginWorkspacePublishStagingInput['limits'];
}

export interface DevicePutWorkspacePublishStagingFileInput {
  token: string;
  teamId: string;
  channelId: string;
  publishId: string;
  path: string;
  offset: number;
  content: Buffer | Uint8Array | string;
  limits?: { maxFileBytes?: number; maxPublishBytes?: number };
}

export interface GetWorkspacePublishStagingInput {
  userId: string;
  teamId: string;
  channelId: string;
  publishId: string;
  /** #1056 同 BeginWorkspacePublishStagingInput.deviceActorToken。 */
  deviceActorToken?: string;
}

export interface DeviceGetWorkspacePublishStagingInput {
  token: string;
  teamId: string;
  channelId: string;
  publishId: string;
}

export interface CommitWorkspacePublishStagingInput {
  userId: string;
  teamId: string;
  channelId: string;
  publishId: string;
  limits?: { maxFileBytes?: number; maxPublishBytes?: number };
  /** #1044 device 路径内部透传：commit 重验 device↔agent 绑定用；HTTP/socket 合同不暴露。 */
  deviceId?: string;
  /** #1056 同 BeginWorkspacePublishStagingInput.deviceActorToken。 */
  deviceActorToken?: string;
}

export interface DeviceCommitWorkspacePublishStagingInput {
  token: string;
  teamId: string;
  channelId: string;
  publishId: string;
  limits?: { maxFileBytes?: number; maxPublishBytes?: number };
}

export interface CleanupWorkspacePublishStagingInput {
  retentionMs?: number;
  limit?: number;
  now?: number;
}

export interface SearchMessagesInput {
  userId: string;
  teamId: string;
  query: string;
  channelId?: string;
  limit?: number;
}

export interface GetMessageContextInput {
  userId: string;
  teamId: string;
  messageId: string;
}

export interface ConvertMessageToTaskInput {
  userId: string;
  teamId: string;
  messageId: string;
}

export interface ListTasksInput {
  userId: string;
  teamId: string;
  channelId?: string;
}

export interface CreateTaskInput {
  userId: string;
  teamId: string;
  title: string;
  description?: string;
  channelId?: string;
  assigneeId?: string;
  tags?: string[];
}

export interface UpdateTaskInput {
  userId: string;
  teamId: string;
  taskId: string;
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  assigneeId?: string | null;
  channelId?: string | null;
  tags?: string[];
  sortOrder?: number;
}

export interface DeleteTaskInput {
  userId: string;
  teamId: string;
  taskId: string;
}

export interface CancelTaskInput {
  userId: string;
  teamId: string;
  taskId: string;
  reason: string;
}

export interface CloseTaskInput {
  userId: string;
  teamId: string;
  taskId: string;
  reason: string;
}

export interface AcceptRootDeliveryInput {
  userId: string;
  teamId: string;
  taskId: string;
  /** 省略时服务端从 root-delivery-submitted 事件解析。 */
  deliveryMessageId?: string;
  /** 省略时使用当前 task.revision（仍会在 kernel 做 fencing）。 */
  expectedTaskRevision?: number;
}

export interface RejectRootDeliveryInput {
  userId: string;
  teamId: string;
  taskId: string;
  reason: string;
  expectedTaskRevision?: number;
}

export interface ReorderTaskInput {
  userId: string;
  teamId: string;
  taskId: string;
  sortOrder: number;
}

export interface GetArtifactInput {
  userId: string;
  teamId: string;
  artifactId: string;
}

export interface UploadArtifactInput {
  userId: string;
  teamId: string;
  channelId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  relativePath?: string;
  sha256?: string;
  role?: ArtifactRole;
  sourceRoot?: ArtifactDto['sourceRoot'];
  /** #1056 同 BeginWorkspacePublishStagingInput.deviceActorToken。 */
  deviceActorToken?: string;
}

export interface DeviceUploadArtifactInput extends Omit<UploadArtifactInput, 'userId'> {
  token: string;
  /** #1056：跨 Team 上传必须声明本次执行 Agent（逐 Agent 授权）；同 Team 不需要。 */
  agentId?: string;
}

export interface DeviceGetArtifactInput {
  token: string;
  teamId: string;
  artifactId: string;
  /** #1043：Device 下载 snapshot 时必须绑定并复验稳定版本身份。 */
  expectedArtifactVersionId?: string;
  /** #1056：跨 Team 下载必须声明本次执行 Agent（逐 Agent 授权）；同 Team 不需要。 */
  agentId?: string;
}

export interface GetWorkspaceRunInput {
  userId: string;
  teamId: string;
  runId: string;
}

export interface ListTeamWorkspaceRunsInput {
  userId: string;
  teamId: string;
  agentId?: string;
  deviceId?: string;
  status?: WorkspaceRunStatus;
  cursor?: string;
  pageSize?: number;
}

export interface ListAgentWorkspaceRunsInput {
  userId: string;
  teamId: string;
  agentId: string;
}

export interface TeamWorkspaceRunListItemDto {
  workspaceRun: WorkspaceRunDto;
  artifacts: ArtifactDto[];
}

export interface AgentWorkspaceRunListItemDto {
  runId: string;
  createdAt: number;
  updatedAt: number;
  status: WorkspaceRunDto['status'];
  cwd?: string;
  command?: string;
  exitCode?: number;
  files: ArtifactDto[];
}

export interface CancelDispatchInput {
  userId: string;
  dispatchId: string;
}

export interface CancelChannelDispatchesInput {
  userId: string;
  teamId: string;
  channelId: string;
}

export interface CreateChannelInput {
  userId: string;
  teamId: string;
  name: string;
  title?: string;
  visibility: ChannelDto['visibility'];
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}

export interface UpdateChannelInput {
  userId: string;
  teamId: string;
  channelId: string;
  name?: string;
  title?: string;
  visibility?: ChannelDto['visibility'];
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}

export interface ChannelHumanMemberInput {
  userId: string;
  teamId: string;
  channelId: string;
  memberUserId: string;
}

export interface ChannelAgentMemberInput {
  userId: string;
  teamId: string;
  channelId: string;
  agentId: string;
}

export interface ListChannelMembersInput {
  userId: string;
  teamId: string;
  channelId: string;
}

export interface ArchiveChannelInput {
  userId: string;
  teamId: string;
  channelId: string;
  confirmationToken?: string;
}

export interface DeleteChannelInput {
  userId: string;
  teamId: string;
  channelId: string;
}

export interface StartDirectMessageInput {
  userId: string;
  teamId: string;
  agentId: string;
}

export interface ListDirectMessagesInput {
  userId: string;
  teamId: string;
}

export interface SnapshotDirectMessageInput {
  userId: string;
  teamId: string;
  channelId: string;
  limit?: number;
}

export interface ReceiveDispatchArtifactInput {
  id: string;
  filename: string;
  mimeType?: string;
  sizeBytes?: number;
  storagePath?: string;
  relativePath?: string;
  pathKind?: ArtifactDto['pathKind'];
  role?: ArtifactRole;
  sourceRoot?: ArtifactDto['sourceRoot'];
  sha256?: string;
  contentBase64?: string;
}

export interface ReceiveDispatchWorkspaceRunInput {
  id?: string;
  status?: WorkspaceRunDto['status'];
  cwd?: string;
  command?: string;
  logExcerpt?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
  /** #1111:daemon 回报的本次 committed publishId(daemon ≥0.3.43),用于把
   * output-package 卡片 meta 内嵌进 agent 回复消息(meta.outputPackageCard)。 */
  publishId?: string;
}

export interface ReceiveDispatchResultInput {
  dispatchId: string;
  agentId: string;
  body: string;
  artifactIds?: string[];
  artifacts?: ReceiveDispatchArtifactInput[];
  workspaceRun?: ReceiveDispatchWorkspaceRunInput;
  collaborationProposals?: readonly AgentCollaborationProposalV1[];
  projectDocumentInputSetResult?: ProjectDocumentInputSetResultProposalV1;
}

export interface ReceiveDispatchResultResult {
  dispatch: DispatchDto;
  message?: MessageDto;
  task?: TaskDto;
  collaborationProposalDiagnostics?: readonly string[];
  projectDocumentInputSetResult?: ProjectDocumentInputSetResultDto;
}

export interface ReceiveDispatchErrorInput {
  dispatchId: string;
  agentId: string;
  error: string;
  retryable?: boolean;
}

export interface ReceiveDispatchErrorResult {
  dispatch: DispatchDto;
  task?: TaskDto;
}

export interface ReceiveDispatchProgressInput {
  dispatchId: string;
  agentId: string;
  /** daemon 发送心跳的时间；server 以到达时刻为准（touchHeartbeat 用 clock.now()）。 */
  sentAt?: number;
}
export type ReceiveDispatchProgressResult = { dispatchId: string };

export interface ReactMessageInput {
  userId: string;
  teamId: string;
  messageId: string;
  emoji?: string;
  on: boolean;
}

export interface SaveMessageInput {
  userId: string;
  teamId: string;
  messageId: string;
  on: boolean;
}

export interface ListSavedMessagesInput {
  userId: string;
  teamId: string;
}

export interface PinMessageInput {
  userId: string;
  teamId: string;
  messageId: string;
  on: boolean;
}

export interface ListPinnedMessagesInput {
  userId: string;
  teamId: string;
  channelId: string;
}

export interface EditMessageInput {
  userId: string;
  teamId: string;
  messageId: string;
  body: string;
  meta?: MessageMetaDto;
}

export interface DeleteMessageInput {
  userId: string;
  teamId: string;
  messageId: string;
}

export interface UpdateMemberRoleInput {
  userId: string;
  teamId: string;
  targetUserId: string;
  role: 'owner' | 'admin' | 'member';
}

export interface RemoveMemberInput {
  userId: string;
  teamId: string;
  targetUserId: string;
}

export interface TransferOwnerInput {
  userId: string;
  teamId: string;
  targetUserId: string;
}

export interface ListMembersInput {
  userId: string;
  teamId: string;
}

export interface UpdateMemberHumanInput {
  userId: string;
  teamId: string;
  targetUserId: string;
  description?: string | null;
}

export interface UpdateTeamInput {
  userId: string;
  teamId: string;
  name?: string;
}

export interface DeleteTeamInput {
  userId: string;
  teamId: string;
}

/** #921 outbox 投递事件（send-message 提交后排空 pending outbox 时逐条产出）。 */
export interface MessageTracerDelivery {
  readonly teamId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly audienceRecipientIds: readonly string[];
}

export interface CreateServerNextUseCasesInput {
  repositories: ServerNextRepositories;
  clock: ServerNextClock;
  ids: ServerNextIds;
  joinCodes?: ServerNextJoinCodes;
  deviceInviteCodes?: ServerNextDeviceInviteCodes;
  sessionSecret?: string;
  artifactContentStore?: ArtifactContentStore;
  /**
   * #1005：staging 字节磁盘存储。有则 put 写 dataDir、不写 SQLite BLOB；
   * 缺省（memory 测试）继续用 file.content Buffer。
   */
  stagingContentStore?: WorkspaceStagingContentStore;
  resolveArtifactPreview?: (artifact: ArtifactRecord) => Promise<ArtifactPreviewDto | undefined>;
  onArtifactCommitted?: (artifact: ArtifactRecord) => Promise<void>;
  /** #829 项目审核/最终化事实变化后，best-effort 触发 Server 权威阶段推进重算。 */
  onProjectFactsChanged?: (scope: { teamId: string; channelId: string }) => Promise<void>;
  /** #829 阶段投影与自动推进共用同一条公开 PI 健康判定，避免 UI 显示可推进但 Server fail closed。 */
  resolvePiHealthy?: () => Promise<boolean>;
  /** #829 Overview 使用与自动推进相同的 Broker 候选事实。 */
  resolveProjectStageCandidates?: (taskId: string, options?: {
    readonly dependencyTaskIds?: readonly string[];
    readonly skipProjectStageGate?: boolean;
  }) => Promise<{
    candidates: readonly { agentId: string; eligible: boolean }[];
  }>;
  /**
   * #1064：Task-linked @Agent 请求的 Agent eligibility 解析（复用 broker
   * `resolveCandidates`——含 operation restriction / Team visibility / 渠道门禁）。
   * dev-server 注入；缺省（未接线测试环境）用简单可见性兜底（fail closed 语义由复验链兜底）。
   */
  resolveTaskLinkedEligibleAgentIds?: (taskId: string) => Promise<readonly string[]>;
  /**
   * #1059 候选 01/02 深化：OutputPackage 交付流水线深模块。缺省由 {repositories,
   * clock, ids} 内部构造；dev-server 可显式注入，以便切片 2 把 transport 改绑到该模块。
   */
  outputPackageService?: OutputPackageService;
  managementRouter?: ReturnType<typeof createManagementRouter>;
  managementKernel?: ReturnType<typeof createManagementKernel>;
  taskCoordinationKernel?: ReturnType<typeof createTaskCoordinationKernel>;
  taskLifecycleKernel?: ReturnType<typeof createTaskLifecycleKernel>;
  serverCapsuleRuntimeContextResolver?: ServerCapsuleRuntimeContextResolver;
  /**
   * Default is durable-job (ADR 0061 Coordinated message intake).
   * Pass `legacy` only for unmigrated tests or emergency env override at the host.
   */
  messageIngestionMode?: 'legacy' | 'durable-job' | 'message-tracer';
  /** #921 Message tracer command 路径开关（默认 false；true 时暴露 dispatchMessageTracerCommand）。 */
  messageTracerEnabled?: boolean;
  /** #921 outbox 投递回调：send-message 提交后排空 pending outbox，逐条调用以推送至订阅者。 */
  onMessageTracerDelivered?: (delivery: MessageTracerDelivery) => Promise<void> | void;
  /** #1084 workspace revision commit fan-out：真正新建 revision 后通知频道在线设备 materialize 到本机 .agentbean。 */
  onWorkspaceRevisionCommitted?: (payload: { teamId: string; channelId: string; workspaceId: string; revisionId: string }) => Promise<void> | void;
  channelFileRollout?: ChannelFileRolloutConfig;
  channelFileMetrics?: ReturnType<typeof createChannelFileMetrics>;
  projectCollaborationRollout?: ProjectCollaborationRolloutConfig;
  projectCollaborationMetrics?: ReturnType<typeof createProjectCollaborationMetrics>;
}

export function createServerNextUseCases(input: CreateServerNextUseCasesInput): ServerNextUseCases {
  const { repositories, clock, ids } = input;
  // #1059 候选 01/02 深化：OutputPackage 交付流水线深模块（formation + review 核心写）。
  // 缺省内部构造；dev-server 可经 input.outputPackageService 显式注入（切片 2 transport 改绑用）。
  const outputPackageService = input.outputPackageService ?? createOutputPackageService({ repositories, clock, ids });
  // #1064：Task-linked @Agent 请求的 eligibility 解析。dev-server 注入 broker
  // resolveCandidates；缺省用简单可见性兜底（未接线测试环境；fail closed 由复验链保证）。
  const resolveTaskLinkedEligibleAgentIds = input.resolveTaskLinkedEligibleAgentIds
    ?? (async (taskId: string) => {
      const task = await repositories.tasks.getById(taskId);
      if (!task) return [];
      const agents = (await repositories.agents.listAll()).filter((agent) =>
        agent.primaryTeamId === task.teamId || agent.visibleTeamIds.includes(task.teamId));
      return agents
        .filter((agent) => agent.status === 'online' && agent.deletedAt === undefined)
        .map((agent) => agent.id);
    });
  const taskLinkedHandlerDeps = {
    repositories,
    ids,
    clock,
    resolveEligibleAgentIds: resolveTaskLinkedEligibleAgentIds,
  } as const;
  const resolveProjectPiHealthy = input.resolvePiHealthy
    ?? (async () => !getEmergencyStopActive());
  const notifyProjectFactsChanged = async (scope: { teamId: string; channelId: string }) => {
    try {
      await input.onProjectFactsChanged?.(scope);
    } catch {
      // 权威写入已经提交；推进器失败必须 fail closed，但不能回滚人类或项目事实。
    }
  };
  const joinCodes = input.joinCodes ?? { nextCode: generateJoinCode };
  const deviceInviteCodes = input.deviceInviteCodes ?? { nextCode: generateJoinCode };
  const sessionSecret = input.sessionSecret ?? 'agentbean-next-dev-session-secret';
  const ARCHIVE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
  function signArchiveToken(payloadBase64: string): string {
    return createHmac('sha256', sessionSecret).update(payloadBase64).digest('base64url');
  }
  function verifyArchiveToken(payloadBase64: string, signature: string): boolean {
    try {
      const expected = createHmac('sha256', sessionSecret).update(payloadBase64).digest('base64url');
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  }
  const artifactContentStore = input.artifactContentStore;
  const stagingContentStore = input.stagingContentStore;
  const resolveArtifactPreview = input.resolveArtifactPreview;
  const onArtifactCommitted = input.onArtifactCommitted;
  // #706 Channel Coordinator 消费 durable Job。默认 durable-job（ADR 0061）；
  // legacy 仅用于显式未迁移调用方 / 紧急旁路（见 host resolveMessageIngestionMode）。
  const messageIngestionMode = input.messageIngestionMode ?? 'durable-job';
  // #921 Message tracer command 路径（默认关闭；ADR-0067 registry）。启用时构造 3 handler + dispatcher。
  // mode='message-tracer' 自动启用（sendMessage 路由到新路径）。
  const messageTracerEnabled = (input.messageTracerEnabled ?? false) || messageIngestionMode === 'message-tracer';
  // #921 outbox 投递：send-message 提交后排空 pending outbox，逐条回调推送 + markDelivered（at-least-once）。
  const deliverMessageTracerOutbox = input.onMessageTracerDelivered
    ? async (): Promise<void> => {
        const unitOfWork = repositories.channelCoordinationUnitOfWork;
        const pending = await unitOfWork.run((tx) => tx.outbox.listPending({ limit: 100 }));
        for (const row of pending) {
          const payload = JSON.parse(row.payloadJson) as { messageId?: string };
          if (!payload.messageId) continue;
          try {
            await input.onMessageTracerDelivered!({
              teamId: row.teamId,
              channelId: row.channelId,
              messageId: payload.messageId,
              audienceRecipientIds: row.audienceRecipientIds,
            });
          } catch {
            // 投递失败不阻断：保留 pending 供重试（at-least-once），继续下一条。
            continue;
          }
          await unitOfWork.run((tx) => tx.outbox.markDelivered({ id: row.id, now: clock.now() }));
        }
      }
    : undefined;
  const messageTracerDispatcher = messageTracerEnabled
    ? createMessageTracerCommandDispatcher({
        send: createSendMessageCommandHandler({
          unitOfWork: repositories.channelCoordinationUnitOfWork,
          ids,
          clock,
          sessionSecret,
          deliverOutbox: deliverMessageTracerOutbox,
        }),
        checkInbox: createCheckInboxCommandHandler({
          unitOfWork: repositories.channelCoordinationUnitOfWork,
          ids,
          clock,
          sessionSecret,
        }),
        ack: createAckReadCandidateCommandHandler({
          unitOfWork: repositories.channelCoordinationUnitOfWork,
          ids,
          clock,
          sessionSecret,
        }),
      })
    : null;
  const promotionModesForTeam = (teamId: string) => createPromotionModesService({
    teamId,
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
    issueAuthorizationToken(tokenInput) {
      const payload = Buffer.from(JSON.stringify(tokenInput), 'utf8').toString('base64url');
      const signature = createHmac('sha256', sessionSecret).update(payload).digest('base64url');
      return `${payload}.${signature}`;
    },
    async canApproveProposal({ teamId: approvalTeamId, userId }) {
      const role = await repositories.teams.getMemberRole(approvalTeamId, userId);
      return role === 'owner' || role === 'admin';
    },
    async resolveActiveManifestRevision({ teamId: manifestTeamId, agentId, now }) {
      const manifest = await repositories.agentExposure.manifests
        .getActiveByTeamAgent(manifestTeamId, agentId);
      return manifest && (manifest.validUntil === null || manifest.validUntil > now)
        ? manifest.revision
        : null;
    },
  });
  async function dispatchMessageTracerCommand(input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: MessageTracerCommandResponseV1 } | { ok: false; error: string }> {
    if (!messageTracerDispatcher) {
      return { ok: false, error: 'MESSAGE_TRACER_DISABLED' };
    }
    let commandName: ReturnType<typeof parseMessageTracerCommandEnvelopeV1>['commandName'];
    try {
      commandName = parseMessageTracerCommandEnvelopeV1(input.envelope).commandName;
    } catch {
      return { ok: false, error: 'MESSAGE_TRACER_PAYLOAD_INVALID' };
    }
    const response = await messageTracerDispatcher.dispatch({
      commandName,
      envelope: input.envelope,
      payload: input.payload,
      authority: { actorId: input.userId, teamId: input.teamId },
    });
    return { ok: true, response };
  }

  /**
   * #999 System activity：优先使用 repositories 注入的 SQLite/memory 持久仓储；
   * 未注入时回退 per-team 进程内 memory（兼容旧测试构造）。
   */
  const systemActivityByTeam = new Map<string, ReturnType<typeof createSystemActivityDispatcher>>();
  function systemActivityDispatcherFor(teamId: string) {
    let dispatcher = systemActivityByTeam.get(teamId);
    if (dispatcher) return dispatcher;
    if (repositories.systemActivity && repositories.systemActivityUnitOfWork) {
      dispatcher = createSystemActivityDispatcher({
        teamId,
        unitOfWork: repositories.systemActivityUnitOfWork,
        ids,
        clock,
      });
    } else {
      const state = createSystemActivityMemoryState();
      const repos = createInMemorySystemActivityRepositories(state);
      dispatcher = createSystemActivityDispatcher({
        teamId,
        unitOfWork: createMemorySystemActivityUnitOfWork({
          repos,
          snapshot: () => cloneSystemActivityMemoryState(state),
          restore: (snap) => restoreSystemActivityMemoryState(
            state,
            snap as ReturnType<typeof createSystemActivityMemoryState>,
          ),
        }),
        ids,
        clock,
      });
    }
    systemActivityByTeam.set(teamId, dispatcher);
    return dispatcher;
  }

  async function dispatchSystemActivityCommand(input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: SystemActivityCommandResponseV1 } | { ok: false; error: string }> {
    if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
      return { ok: false, error: 'FORBIDDEN' };
    }
    try {
      const response = await systemActivityDispatcherFor(input.teamId).dispatchCommand({
        envelope: input.envelope,
        payload: input.payload,
      });
      return { ok: true, response };
    } catch {
      return { ok: false, error: 'SYSTEM_ACTIVITY_PAYLOAD_INVALID' };
    }
  }

  async function dispatchSystemActivityQuery(input: {
    queryName: SystemActivityQueryName;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: SystemActivityQueryResponseV1 } | { ok: false; error: string }> {
    if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
      return { ok: false, error: 'FORBIDDEN' };
    }
    try {
      const response = await systemActivityDispatcherFor(input.teamId).dispatchQuery({
        queryName: input.queryName,
        payload: input.payload,
      });
      return { ok: true, response };
    } catch {
      return { ok: false, error: 'SYSTEM_ACTIVITY_PAYLOAD_INVALID' };
    }
  }

  async function dispatchTaskRemediationCommand(input: {
    envelope: unknown;
    payload: unknown;
    userId: string;
    teamId: string;
  }): Promise<{ ok: true; response: TaskRemediationCommandResponseV1 } | { ok: false; error: string }> {
    if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
      return { ok: false, error: 'FORBIDDEN' };
    }
    let commandName: ReturnType<typeof parseTaskRemediationCommandEnvelopeV1>['commandName'];
    try {
      commandName = parseTaskRemediationCommandEnvelopeV1(input.envelope).commandName;
    } catch {
      return { ok: false, error: 'TASK_REMEDIATION_PAYLOAD_INVALID' };
    }
    try {
      let response: TaskRemediationCommandResponseV1;
      if (commandName === 'retry-attempt') {
        response = await handleRetryAttempt(remediationHandlerDeps, input.envelope, input.payload);
      } else {
        return { ok: false, error: 'REMEDIATION_COMMAND_NOT_WIRED' };
      }
      // #1014：remediation 成功后自动投影
      if (response.outcome === 'applied' && response.result) {
        const result = response.result as {
          commandName?: string;
          taskId?: string;
          actionRequiredId?: string;
          remediation?: { taskRevision?: number };
        };
        const taskId = result.taskId ?? '';
        if (taskId) {
          const task = await repositories.tasks.getById(taskId);
          const members = await repositories.teams.listAllMembers(input.teamId);
          const memberIds = members.map((m) => m.userId);
          let channelHuman: string[] | null = null;
          if (task?.channelId) {
            const channel = await repositories.channels.getById(task.channelId);
            channelHuman = channel?.humanMemberIds ?? null;
          }
          const audience = deriveActivityAudience({
            teamMemberIds: memberIds,
            channelHumanMemberIds: channelHuman,
            creatorId: task?.creatorId,
            assigneeId: task?.assigneeId,
            forActionRequired: true,
          });
          const fact = mapRemediationCommandToActivityFact({
            commandName,
            teamId: input.teamId,
            taskId,
            taskRevision: result.remediation?.taskRevision ?? task?.revision ?? 1,
            channelId: task?.channelId ?? undefined,
            visibleRecipientIds: audience.visibleRecipientIds,
            responsibleRecipientIds: audience.responsibleRecipientIds,
            eventId: `remediation:${commandName}:${taskId}:${input.userId}:${clock.now()}`,
            sequence: task?.revision ?? 1,
            occurredAt: clock.now(),
            actionRequiredId: result.actionRequiredId,
          });
          if (fact) {
            await autoProjectSystemActivityFact({
              dispatcher: systemActivityDispatcherFor(input.teamId),
              fact,
              idempotencyKey: `auto-project:remediation:${commandName}:${taskId}:${response.receipt?.receiptId ?? clock.now()}`,
            });
          }
        }
      }
      return { ok: true, response };
    } catch {
      return { ok: false, error: 'TASK_REMEDIATION_FAILED' };
    }
  }
  /**
   * #931 PI authority cutover infrastructure.
   */
  const piAuthorityCutoverState = createPiAuthorityCutoverMemoryState();
  const piAuthorityCutoverRepos = createInMemoryPiAuthorityCutoverRepositories(
    piAuthorityCutoverState,
    { migrations: repositories.teamPiAuthorityMigrations },
  );
  const piAuthorityCutoverUnitOfWork = createMemoryPiAuthorityCutoverUnitOfWork({
    repos: piAuthorityCutoverRepos,
    snapshot: () => clonePiAuthorityCutoverMemoryState(piAuthorityCutoverState),
    restore: (snap) => restorePiAuthorityCutoverMemoryState(piAuthorityCutoverState, snap as ReturnType<typeof createPiAuthorityCutoverMemoryState>),
  });
  const legacyJobInventory: LegacyCoordinationJobInventory = {
    async listOpen(teamId) {
      const open = await repositories.channelCoordination.jobs.listOpenByTeam(teamId);
      const pendingOrRetry: string[] = [];
      const running: { jobId: string; lineageKey: string }[] = [];
      for (const job of open) {
        if (job.status === 'pending' || job.status === 'retry_wait') {
          pendingOrRetry.push(job.id);
        } else if (job.status === 'running') {
          running.push({ jobId: job.id, lineageKey: `legacy-job:${job.id}:message:${job.messageId}` });
        }
      }
      return { pendingOrRetry, running };
    },
    async cancelJobs({ jobIds, now }) {
      const cancelled: string[] = [];
      for (const jobId of jobIds) {
        const job = await repositories.channelCoordination.jobs.getById(jobId);
        if (!job) continue;
        if (job.status !== 'pending' && job.status !== 'retry_wait') continue;
        const updated = await repositories.channelCoordination.jobs.updateState({ jobId, status: 'cancelled', attempt: job.attempt, nextRetryAt: null, updatedAt: now });
        if (updated) cancelled.push(jobId);
      }
      return cancelled;
    },
  };

  function makeCutoverHandlerDeps(teamId: string, operatorId: string, operatorRole: 'owner'|'admin'|'member'): PiAuthorityCutoverHandlerDeps {
    return { unitOfWork: piAuthorityCutoverUnitOfWork, ids, clock, teamId, operatorId, operatorRole, legacyJobInventory };
  }

  /** #931 A2：bind authority epoch after sendMessage（best-effort）。 */
  async function bindMessageEpochBestEffort(teamId: string, messageId: string, clientMessageId: string | null): Promise<void> {
    try {
      await piAuthorityCutoverUnitOfWork.runInTransaction(async (repos) => {
        const migration = await repos.migrations.get(teamId);
        if (!migration) return;
        await repos.epochBindings.create({ messageId, teamId, sourceLineageKey: `message:${teamId}:${messageId}`, authorityEpoch: migration.authorityEpoch, migrationRevision: migration.migrationRevision, boundAt: clock.now(), clientMessageId });
      });
    } catch { /* best-effort */ }
  }

  /** #931 A6：Team emergency-stop guard for promotion/PI commands。 */
  async function assertTeamPiCommandsAllowed(teamId: string): Promise<Ack<never> | null> {
    const migration = await repositories.teamPiAuthorityMigrations.get(teamId);
    if (!migration) return null;
    const decision = evaluateCommandPathAvailability({ migration: { state: migration.state, legacyWriterFenced: migration.legacyWriterFenced, emergencyStop: migration.emergencyStop }, path: 'promotion' });
    if (!decision.allowed) {
      return makeFailure('CONFLICT', decision.reason === 'pi_emergency_stop' ? 'Team PI emergency-stop is active' : decision.reason);
    }
    return null;
  }

  /** #931 A1：cutover command dispatcher。 */
  async function dispatchPiAuthorityCutoverCommand(input: { envelope: unknown; payload: unknown; userId: string; teamId: string }): Promise<{ ok: true; response: PiAuthorityCutoverCommandResponseV1 } | { ok: false; error: string }> {
    if (!(await repositories.teams.isMember(input.teamId, input.userId))) return { ok: false, error: 'FORBIDDEN' };
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (!role || (role !== 'owner' && role !== 'admin')) return { ok: false, error: 'FORBIDDEN' };
    try {
      const dispatcher = createPiAuthorityCutoverDispatcher(makeCutoverHandlerDeps(input.teamId, input.userId, role));
      const response = await dispatcher.dispatchCommand({ envelope: input.envelope, payload: input.payload });
      return { ok: true, response };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'PI_AUTHORITY_CUTOVER_FAILED' };
    }
  }

  /** #931 A1：cutover query dispatcher。 */
  async function dispatchPiAuthorityCutoverQuery(input: { queryName: PiAuthorityCutoverQueryName; payload: unknown; userId: string; teamId: string }): Promise<{ ok: true; response: PiAuthorityCutoverQueryResponseV1 } | { ok: false; error: string }> {
    if (!(await repositories.teams.isMember(input.teamId, input.userId))) return { ok: false, error: 'FORBIDDEN' };
    const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
    if (!role || (role !== 'owner' && role !== 'admin')) return { ok: false, error: 'FORBIDDEN' };
    try {
      const dispatcher = createPiAuthorityCutoverDispatcher(makeCutoverHandlerDeps(input.teamId, input.userId, role));
      const response = await dispatcher.dispatchQuery({ queryName: input.queryName, payload: input.payload });
      return { ok: true, response };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'PI_AUTHORITY_CUTOVER_FAILED' };
    }
  }

  const channelFileRollout = input.channelFileRollout ?? {
    ...DEFAULT_CHANNEL_FILE_ROLLOUT,
    // Directly constructed use cases preserve the pre-rollout behavior. Production
    // always injects the parsed rollout config from startServerNextDevServer.
    markdownEditing: true,
  };
  const channelFileMetrics = input.channelFileMetrics ?? createChannelFileMetrics();
  const projectCollaborationRollout = input.projectCollaborationRollout
    ?? FULL_PROJECT_COLLABORATION_ROLLOUT;
  const projectCollaborationMetrics = input.projectCollaborationMetrics
    ?? createProjectCollaborationMetrics();
  const recordProjectInputSetResultMetrics = (result: ProjectDocumentInputSetResultDto) => {
    for (const item of result.items) {
      projectCollaborationMetrics.recordInputSetResult(item.status);
    }
  };
  const recordProjectInputSetRuntimeFailure = (error: string) => {
    if (error.includes('CAPABILITY_MISSING')) {
      projectCollaborationMetrics.recordInputSetFailure('capability');
    } else if (error.includes('DOWNLOAD_FAILED')) {
      projectCollaborationMetrics.recordInputSetFailure('download');
    } else if (error.includes('SIZE_MISMATCH') || error.includes('SHA256_MISMATCH')) {
      projectCollaborationMetrics.recordInputSetFailure('checksum');
    } else if (error.includes('PROJECT_DOCUMENT_INPUT_SET_RUNTIME_UNAVAILABLE')
      || error.includes('PROJECT_DOCUMENT_INPUT_SET_MATERIALIZATION_FAILED')) {
      projectCollaborationMetrics.recordInputSetFailure('materialization');
    }
  };
  const dispatchCoalescingLocks = new Map<string, Promise<void>>();
  const invocationGateway = createInvocationGateway({ repositories, clock, ids });
  const collaborationService = createCollaborationService({ repositories, clock, ids });
  const managementKernel = input.managementKernel ?? createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock,
    ids,
  });
  const taskCoordinationKernel = input.taskCoordinationKernel ?? createTaskCoordinationKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const taskLifecycleKernel = input.taskLifecycleKernel ?? createTaskLifecycleKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
    // #1014：lifecycle 权威成功后自动投影 System activity（post-commit）
    async onApplied(event) {
      const members = await repositories.teams.listAllMembers(event.teamId);
      const memberIds = members.map((m) => m.userId);
      let channelHuman: string[] | null = null;
      if (event.channelId) {
        const channel = await repositories.channels.getById(event.channelId);
        channelHuman = channel?.humanMemberIds ?? null;
      }
      const forReview = event.commandName === 'submit-root-delivery'
        || event.commandName === 'transition-subtask-in-review';
      const audience = deriveActivityAudience({
        teamMemberIds: memberIds,
        channelHumanMemberIds: channelHuman,
        creatorId: event.creatorId,
        assigneeId: event.assigneeId,
        forReview,
      });
      const fact = mapLifecycleCommandToActivityFact({
        commandName: event.commandName,
        teamId: event.teamId,
        taskId: event.taskId,
        taskRevision: event.taskRevision,
        channelId: event.channelId ?? undefined,
        visibleRecipientIds: audience.visibleRecipientIds,
        responsibleRecipientIds: audience.responsibleRecipientIds,
        eventId: event.eventId,
        sequence: Math.max(event.taskRevision, 1),
        occurredAt: event.occurredAt,
        deliveryMessageId: event.deliveryMessageId,
        reason: event.reason,
        status: event.status,
      });
      if (!fact) return;
      await autoProjectSystemActivityFact({
        dispatcher: systemActivityDispatcherFor(event.teamId),
        fact,
        idempotencyKey: `auto-project:${event.eventId}`,
      });
    },
  });

  /** #1014 remediation：进程内 memory 仓储 + retry 等具名 command 入口。 */
  const remediationState = createTaskFailureRemediationMemoryState();
  const remediationRepos = createInMemoryTaskFailureRemediationRepositories(remediationState);
  const remediationUnitOfWork = createMemoryTaskFailureRemediationUnitOfWork({
    repos: remediationRepos,
    snapshot: () => cloneTaskFailureRemediationMemoryState(remediationState),
    restore: (snap) => restoreTaskFailureRemediationMemoryState(
      remediationState,
      snap as ReturnType<typeof createTaskFailureRemediationMemoryState>,
    ),
  });
  const remediationHandlerDeps: TaskFailureRemediationHandlerDeps = {
    unitOfWork: remediationUnitOfWork,
    ids,
    clock,
  };
  const managementRouter = input.managementRouter ?? createManagementRouter({
    repositories,
    kernel: managementKernel,
    clock,
    ids,
  });
  const memorySourceInvalidation = createMemorySourceInvalidationService({
    unitOfWork: repositories.memoryUnitOfWork,
    clock,
    ids,
    async isSourceAvailable(source) {
      if (source.sourceKind === 'message') {
        const message = await repositories.messages.getById(source.sourceId);
        return Boolean(message && message.teamId === source.teamId && !isDeletedMessage(message));
      }
      if (source.sourceKind === 'task') {
        const task = await repositories.tasks.getById(source.sourceId);
        return Boolean(task && task.teamId === source.teamId);
      }
      if (source.sourceKind === 'artifact') {
        const artifact = await repositories.artifacts.getForTeam({
          teamId: source.teamId, artifactId: source.sourceId,
        });
        if (!artifact) return false;
        const channel = await repositories.channels.getById(artifact.channelId);
        return Boolean(channel && channel.teamId === source.teamId);
      }
      if (source.sourceKind === 'workspace-run') {
        const workspaceRun = await repositories.workspaceRuns.getForTeam({
          teamId: source.teamId, runId: source.sourceId,
        });
        if (!workspaceRun) return false;
        const channel = await repositories.channels.getById(workspaceRun.channelId);
        return Boolean(channel && channel.teamId === source.teamId);
      }
      if (source.sourceKind === 'invocation') {
        const invocation = await repositories.management.invocations.getById(source.sourceId);
        if (!invocation || invocation.intent.teamId !== source.teamId) return false;
        const channel = await repositories.channels.getById(invocation.intent.channelId);
        if (!channel || channel.teamId !== source.teamId) return false;
        const taskId = invocation.intent.taskContext?.taskId;
        if (!taskId) return true;
        const task = await repositories.tasks.getById(taskId);
        return Boolean(task && task.teamId === source.teamId);
      }
      // memory/manual/local-summary 没有本切片的 server 删除入口；保持可用，避免越界误判。
      return true;
    },
  });
  const collaborativeMemory = createCollaborativeMemoryService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemoryWritePermissions(repositories),
    clock,
    ids,
  });
  const memoryCandidates = createMemoryCandidateService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: createServerMemoryCandidatePermissions(repositories),
    clock,
    ids,
  });
  const memoryGovernance = createMemoryGovernanceService({ repositories, clock });
  const formalMemory = createFormalMemoryService({ repositories, collaborativeMemory, clock });
  const experiencePack = createExperiencePackService({ repositories, clock, ids });
  const systemUserMemory = createSystemUserMemoryService({ repositories, clock });
  const piProvider = createPiProviderService({
    repositories: repositories.piProvider,
    unitOfWork: repositories.piProviderUnitOfWork,
    users: repositories.users,
    clock,
    ids,
  });
  // #710 Team Agent Exposure：owner 发布/撤回，Team Owner/Admin 收紧，成员只读。
  // canManageAgent 复用设备拥有者链路授权（fail-closed）。
  const agentExposure = createAgentExposureService({
    repositories: {
      agentExposure: repositories.agentExposure,
      agentExposureUnitOfWork: repositories.agentExposureUnitOfWork,
      agents: repositories.agents,
      teams: repositories.teams,
    },
    canManageAgent: async ({ userId, agentId }) => {
      const agent = await repositories.agents.getById(agentId);
      return agent ? canManageAgentAsUser(repositories, { userId, agent }) : false;
    },
    clock,
    ids,
    // #946：manifest 替代后撤销绑定旧 revision 的 execution grant（跨域 best-effort，lease 留存）。
    onManifestSuperseded: async ({ teamId, agentId, manifestRevision, now }) => {
      const grants = await repositories.taskCoordination.executionGrants.listActiveByManifestRevision({
        teamId, agentId, manifestRevision,
      });
      for (const grant of grants) {
        await repositories.taskCoordination.executionGrants.revoke({
          id: grant.id, reason: 'manifest-superseded', revokedAt: now, now,
        });
      }
    },
  });
  // #718 Team-scoped Agent Memory 投影：owner 发布/撤回，Team Owner/Admin opt-in，
  // PI/成员只读消费当前 Team 已启用投影。canManageAgent 复用设备拥有者链路授权（fail-closed）。
  const agentMemoryProjection = createAgentMemoryProjectionService({
    repositories: {
      agentMemoryProjection: repositories.agentMemoryProjection,
      agentMemoryProjectionUnitOfWork: repositories.agentMemoryProjectionUnitOfWork,
      agents: repositories.agents,
      teams: repositories.teams,
    },
    canManageAgent: async ({ userId, agentId }) => {
      const agent = await repositories.agents.getById(agentId);
      return agent ? canManageAgentAsUser(repositories, { userId, agent }) : false;
    },
    clock,
    ids,
  });
  // #720 Active Memory Context Resolver：Coordinator 与 ManagementRun 共享的权限过滤接缝（AC#8）。
  // limit=6：Team/Channel/Task/Agent 四来源配额（floor(6/4)=1 保底 + 2 条高分补充）。
  const activeMemoryContextResolver = createActiveMemoryContextResolver({
    repositories,
    formalMemory,
    agentMemoryProjection,
    experiencePack,
    clock,
    limit: 6,
  });
  // Channel Coordinator（#706/#707）：消费 durable Job，调 Active PI Model 产出提议，
  // 再由 Server 校验权限、风险与频道状态后应用低风险动作。不依赖 Device 在线。
  const channelCoordinator = createChannelCoordinator({
    jobs: repositories.channelCoordination.jobs,
    decisions: repositories.channelCoordination.decisions,
    unitOfWork: repositories.channelCoordinationUnitOfWork,
    messages: repositories.messages,
    channels: repositories.channels,
    teams: repositories.teams,
    agents: repositories.agents,
    teamPolicy: repositories.teamPiPolicy,
    modelResolver: piProvider,
    memoryContextResolver: activeMemoryContextResolver,
    clock,
    ids,
    teamPiAuthorityMigrations: repositories.teamPiAuthorityMigrations,
  });
  // 解析当前 Active PI Model 为可调用目标（unavailable → 跳过 LLM 类能力）。
  // 注意：独立函数无上下文类型，'unavailable' 需 as const 保持字面量（内联时由期望类型收窄）。
  async function resolveActivePiModelTarget() {
    const active = await repositories.piProviderUnitOfWork.run(
      (piRepositories) => piRepositories.activeModel.get(),
    );
    if (!active) {
      return { kind: 'unavailable' as const, diagnosticCode: 'PI_ACTIVE_MODEL_NOT_SET' };
    }
    return piProvider.resolveInvocationTarget({
      cardId: active.cardId,
      revisionId: active.revisionId,
    });
  }

  // Agent capability LLM 总结（混合提取慢路径）：机械提取为空/内容变化时，
  // 用 Active PI Model 对 AGENTS.md 全文总结一次，结果标「AI 总结」候选。
  const capabilitySummarizer = createCapabilitySummarizer({
    resolveActiveTarget: resolveActivePiModelTarget,
    updateSummarized: async ({ agentId, capabilitiesSummarized, timestamp }) =>
      repositories.agents.updateSummarizedCapabilities({
        agentId,
        capabilitiesSummarized,
        timestamp,
      }),
    clock,
  });
  // 每日更新日志 LLM 兜底：PR 未写用户向小节时，用 Active PI Model 生成条目。
  const changelogSummarizer = createChangelogSummarizer({
    resolveActiveTarget: resolveActivePiModelTarget,
  });
  // 来源失效是删除之后的反应式级联：best-effort，绝不阻塞或回滚已成功的删除。
  // 失败时由读取侧懒检查（evaluateMemoryInjection 的 allSourcesAvailable）兜底。
  const invalidateSourcesAfterDeletion = async (input: {
    readonly teamId: string;
    readonly sourceKind: Parameters<typeof memorySourceInvalidation.invalidateSources>[0]['sourceKind'];
    readonly sourceIds: readonly string[];
    readonly actorId?: string;
  }): Promise<void> => {
    try {
      await memorySourceInvalidation.invalidateSources(input);
    } catch {
      // 来源失效是 best-effort；任何异常都不得影响删除主路径。
    }
  };

  // #921 slice D：mode='message-tracer' 时，sendMessage 路由到 message-tracer handler（cutover 路由层）。
  // 翻译 SendMessageInput → command envelope + payload → dispatch → 翻译回 SendMessageResult。
  async function sendMessageViaMessageTracer(messageInput: SendMessageInput): Promise<Ack<SendMessageResult>> {
    const threadId = messageInput.threadId;
    const result = await dispatchMessageTracerCommand({
      envelope: {
        schemaVersion: 1,
        commandName: 'send-message',
        commandSchemaVersion: 1,
        idempotencyKey: messageInput.clientMessageId ?? ids.nextId(),
      },
      payload: {
        channelId: messageInput.channelId,
        threadId,
        senderKind: (messageInput.senderKind ?? 'human') as 'human' | 'agent' | 'system',
        body: messageInput.body,
        mentions: messageInput.meta?.mentions,
        attachmentIds: messageInput.artifactIds ?? messageInput.meta?.attachments,
        clientMessageId: messageInput.clientMessageId,
        freshnessBasis: {
          schemaVersion: 1,
          target: {
            schemaVersion: 1,
            kind: threadId ? 'thread' as const : 'channel-mainline' as const,
            channelId: messageInput.channelId,
            ...(threadId ? { threadId } : {}),
          },
        },
      },
      userId: messageInput.userId,
      teamId: messageInput.teamId,
    });
    if (!result.ok) return makeFailure('INTERNAL_ERROR', `Message tracer: ${result.error}`);
    const response = result.response;
    // applied → fetch message → SendMessageResult（dispatches 为空：message-tracer 不建 coordination job）
    if (response.outcome === 'applied' && response.result?.commandName === 'send-message') {
      const message = await repositories.messages.getById(response.result.messageId);
      if (!message) return makeFailure('INTERNAL_ERROR', 'Message not found after send');
      void bindMessageEpochBestEffort(message.teamId, message.id, messageInput.clientMessageId ?? null);
      return makeSuccess({ message, dispatches: [] });
    }
    // replay → response 仅含 wire receipt（V1 投影白名单不含 resultJson，ADR-0067）；
    // result 属 applied 不重发，故查存储层 receipt.resultJson 恢复 messageId。
    if (response.outcome === 'replayed' && response.receipt) {
      const receiptRecord = await repositories.channelCoordinationUnitOfWork.run((tx) =>
        tx.commandReceipts.getReceiptById(response.receipt!.receiptId));
      if (receiptRecord?.resultJson) {
        try {
          const data = JSON.parse(receiptRecord.resultJson) as { messageId?: string };
          if (data.messageId) {
            const message = await repositories.messages.getById(data.messageId);
            if (message) {
              void bindMessageEpochBestEffort(message.teamId, message.id, messageInput.clientMessageId ?? null);
              return makeSuccess({ message, dispatches: [] });
            }
          }
        } catch { /* fall through */ }
      }
    }
    // freshness_hold / conflict / rejected → failure ack（映射到已知错误码）
    const errorCode = response.outcome === 'conflict' || response.outcome === 'freshness_hold'
      ? 'CONFLICT'
      : response.outcome === 'rejected' ? 'BAD_REQUEST' : 'INTERNAL_ERROR';
    return makeFailure(errorCode, response.stableCode);
  }

  async function sendLegacyMessage(messageInput: SendMessageInput): Promise<Ack<SendMessageResult>> {
    if ((messageInput.selections?.length ?? 0) > 0
      && !projectCollaborationRollout.bundleSelection) {
      projectCollaborationMetrics.recordMutationFailure('disabled');
      return makeFailure('NOT_FOUND', 'Project document Selection is disabled');
    }
    if (!(await repositories.teams.isMember(messageInput.teamId, messageInput.userId))) {
      return makeFailure('FORBIDDEN', 'User is not a team member');
    }
    const channel = await repositories.channels.getById(messageInput.channelId);
    if (!channel || channel.teamId !== messageInput.teamId) {
      return makeFailure('NOT_FOUND', 'Channel not found');
    }
    if (channel.archivedAt != null) {
      return makeFailure('VALIDATION_ERROR', 'Archived channels do not accept new messages');
    }
    if (channel.visibility === 'private' && !channel.humanMemberIds.includes(messageInput.userId)) {
      return makeFailure('FORBIDDEN', 'User cannot view channel');
    }

    const referenceFingerprint = projectReferenceRequestFingerprint(messageInput);
    if (messageInput.clientMessageId) {
      const existing = await repositories.messages.getByClientMessageId({
        teamId: messageInput.teamId,
        channelId: messageInput.channelId,
        clientMessageId: messageInput.clientMessageId,
      });
      if (existing) {
        const sameRequest = existing.senderId === messageInput.userId
          && existing.body === messageInput.body
          && existing.meta?.projectReferenceRequestFingerprint === referenceFingerprint;
        if (!sameRequest) {
          return makeFailure('CONFLICT', 'Client message id was already used for a different message');
        }
        const [projected] = await enrichMessagesWithArtifacts(repositories, [existing]);
        return makeSuccess({
          message: projected ?? existing,
          dispatches: (await repositories.dispatches.listByMessage(existing.id)).map(toDispatchDto),
          ...(projected?.referenceSet ? { referenceSet: projected.referenceSet } : {}),
        });
      }
    }
    const frozen = await resolveAndFreezeSelections(repositories, {
      userId: messageInput.userId,
      teamId: messageInput.teamId,
      channelId: messageInput.channelId,
      channel,
      selections: messageInput.selections ?? [],
    });
    if (!frozen.ok) return frozen;

    const now = clock.now();
    let messageId = ids.nextId();
    let threadId = messageInput.threadId ?? messageId;
    const visibleAgents = await repositories.agents.listVisibleInTeam(messageInput.teamId);
    const mentions = sanitizeMessageMentions({
      body: messageInput.body,
      mentions: messageInput.meta?.mentions,
      channel,
      visibleAgents,
    });
    const contextOwner = messageInput.threadId
      ? await resolveRoutingContextAgentId(repositories, {
          teamId: messageInput.teamId,
          channel,
          threadId: messageInput.threadId,
        })
      : undefined;
    const route = routeMessageForChannel({
      channel,
      visibleAgents,
      teamId: messageInput.teamId,
      body: messageInput.body,
      mentions,
      contextOwner,
      connectedAgentDeviceIds: messageInput.connectedAgentDeviceIds,
      dispatchClaimDeviceIds: messageInput.dispatchClaimDeviceIds,
    });
    const attachmentResult = await getAttachableUploadedArtifacts(repositories, {
      userId: messageInput.userId,
      teamId: messageInput.teamId,
      channelId: messageInput.channelId,
      artifactIds: messageInput.artifactIds ?? [],
    });
    if (!attachmentResult.ok) return attachmentResult;
    const attachedArtifactIds = attachmentResult.artifacts.map((artifact) => artifact.id);
    const shouldCreateTask = messageInput.asTask === true || shouldAutoCreateTaskThread({
      body: messageInput.body,
      route,
      threadId: messageInput.threadId,
    });
    let taskId = shouldCreateTask ? ids.nextId() : undefined;
    if (messageInput.clientMessageId) {
      const reservation = await repositories.management.reservations.getByRequestKey({
        teamId: messageInput.teamId,
        requestKey: `${messageInput.teamId}:${messageInput.userId}:${messageInput.clientMessageId.trim()}`,
      });
      const reservedRun = reservation
        ? await repositories.management.runs.getById(reservation.managementRunId)
        : null;
      if (reservedRun
        && reservedRun.teamId === messageInput.teamId
        && reservedRun.channelId === messageInput.channelId) {
        // 引用提交冲突后的重试必须复用管理预约冻结的根身份，否则 run 会指向
        // 已回滚的 message/task，createOrResumeRun 的 requestHash 也会冲突。
        messageId = reservedRun.rootMessageId;
        threadId = messageInput.threadId ?? messageId;
        if (shouldCreateTask && reservedRun.rootTaskId) taskId = reservedRun.rootTaskId;
      }
    }
    let management: ManagementRoutingResult = await managementRouter.route({
      userId: messageInput.userId,
      teamId: messageInput.teamId,
      channelId: messageInput.channelId,
      rootMessageId: messageId,
      ...(taskId ? { rootTaskId: taskId } : {}),
      ...(messageInput.clientMessageId ? { clientMessageId: messageInput.clientMessageId } : {}),
      body: messageInput.body,
      ...(route.kind === 'dispatch' ? { targetAgentId: route.agentId } : {}),
    });
    if (management.kind === 'unavailable') {
      return makeFailure('VALIDATION_ERROR', management.diagnostics.join(','));
    }
    const coordinatedManagedRoot = management.kind === 'managed' && management.managementPhase >= 2;
    let saved: {
      message: MessageRecord;
      task: TaskRecord | null;
      referenceSet?: ProjectReferenceSetDto;
    };
    try {
      saved = await repositories.channelCoordinationUnitOfWork.run(async (transaction) => {
        const message = await transaction.messages.append({
          id: messageId,
          teamId: messageInput.teamId,
          channelId: messageInput.channelId,
          threadId,
          senderKind: 'human',
          senderId: messageInput.userId,
          body: messageInput.body,
          createdAt: now,
          meta: {
            ...(messageInput.clientMessageId ? { clientMessageId: messageInput.clientMessageId } : {}),
            ...(attachedArtifactIds.length > 0 ? { artifactIds: attachedArtifactIds } : {}),
            ...(taskId ? { taskId } : {}),
            ...(mentions.length ? { mentions } : {}),
            projectReferenceRequestFingerprint: referenceFingerprint,
            routeReason: toRouteReason(route),
          },
        });
        const referenceSet = frozen.selections.length > 0
          ? await persistFrozenProjectReferences(transaction.projectReferenceSets, {
            ids,
            message,
            createdBy: messageInput.userId,
            previews: frozen.selections,
            idempotencyKey: messageInput.clientMessageId ?? message.id,
            requestFingerprint: referenceFingerprint,
            createdAt: now,
          })
          : undefined;
        // 任务创建必须晚于引用事实的提交点复核，并与消息处于同一事务；
        // 否则 revision 并发冲突会回滚消息，却遗留幽灵任务。
        const task = shouldCreateTask
          ? await transaction.tasks.create({
              id: taskId!, teamId: messageInput.teamId, title: messageInput.body.trim() || '附件',
              description: undefined,
              status: route.kind === 'dispatch' || coordinatedManagedRoot ? 'in_progress' : 'todo',
              creatorId: messageInput.userId,
              assigneeId: route.kind === 'dispatch' && !coordinatedManagedRoot ? route.agentId : undefined,
              channelId: messageInput.channelId, tags: [], sortOrder: now, createdAt: now, updatedAt: now,
            })
          : null;
        return { message, task, referenceSet };
      });
    } catch (error) {
      if (!(error instanceof ProjectReferenceCommitConflictError)) throw error;
      // 管理运行尚未 schedule，必须保留 queued reservation 供相同请求重试复用。
      // 这里取消它会让并发重放或后续重试只能拿到终态 run。
      if (error.kind === 'idempotency_conflict' && messageInput.clientMessageId) {
        const replay = await repositories.messages.getByClientMessageId({
          teamId: messageInput.teamId,
          channelId: messageInput.channelId,
          clientMessageId: messageInput.clientMessageId,
        });
        if (replay?.meta?.projectReferenceRequestFingerprint === referenceFingerprint) {
          const [projected] = await enrichMessagesWithArtifacts(repositories, [replay]);
          return makeSuccess({
            message: projected ?? replay,
            dispatches: (await repositories.dispatches.listByMessage(replay.id)).map(toDispatchDto),
            ...(projected?.referenceSet ? { referenceSet: projected.referenceSet } : {}),
          });
        }
        return makeFailure('CONFLICT', 'Client message id was already used for a different message');
      }
      return makeFailure(
        'VALIDATION_ERROR',
        'Project references changed before the message could be committed; refresh and retry',
        { reason: 'selections_rejected' },
      );
    }
    const { message, task, referenceSet } = saved;
    if (task && management.kind === 'managed' && management.managementPhase >= 2) {
      await taskCoordinationKernel.bootstrapRootCoordination({
        managementRunId: management.managementRunId,
        taskId: task.id,
        idempotencyKey: `bootstrap-root:${task.id}`,
        acceptanceCriteria: [{
          id: `root-completion:${task.id}`,
          description: '根任务目标已完成并可供用户审核',
          evidenceRequired: false,
        }],
        maxAttempts: 1,
      });
    }
    const releaseDispatchCoalescingLock = await acquireKeyedLock(
      dispatchCoalescingLocks,
      `${message.teamId}:${message.channelId}:${message.senderId}`,
    );
    try {
      const coalescedDispatchId = management.kind === 'managed'
        ? undefined
        : await touchPendingCoalescibleDispatch(repositories, { message, updatedAt: now });
      const attachedArtifacts: ArtifactRecord[] = [];
      for (const artifact of attachmentResult.artifacts) {
        attachedArtifacts.push(await repositories.artifacts.create({ ...artifact, messageId: message.id }));
      }
      if (channelFileRollout.markdownEditing) {
        await createInitialChannelDocuments(repositories, attachedArtifacts, messageInput.userId, now);
      }
      const dispatches: DispatchDto[] = [];
      let acknowledgementMessage: MessageDto | undefined;
      if (route.kind === 'dispatch' && management.kind !== 'managed' && !coalescedDispatchId) {
        const dispatch = await repositories.dispatches.create({
          id: ids.nextId(), teamId: messageInput.teamId, channelId: messageInput.channelId,
          messageId: message.id, agentId: route.agentId, status: 'queued', requestId: ids.nextId(),
          prompt: messageInput.body, createdAt: now, updatedAt: now,
        });
        dispatches.push(toDispatchDto(dispatch));
        await repositories.agents.updateStatus({ agentId: dispatch.agentId, status: 'busy', lastSeenAt: now });
        if (task) {
          acknowledgementMessage = await appendTaskClaimAcknowledgementMessage(repositories, {
            id: ids.nextId(), message, task, dispatch: toDispatchDto(dispatch), createdAt: now,
          });
        }
      }
      if (management.kind === 'managed') management = await managementRouter.scheduleManaged(management);
      if (management.mode === 'shadow' && management.shadowRequestKey) {
        void managementRouter.recordShadowDecision({
          shadowRequestKey: management.shadowRequestKey,
          body: messageInput.body,
          ...(route.kind === 'dispatch' ? { targetAgentId: route.agentId } : {}),
        }).catch(() => undefined);
      }
      return makeSuccess({
        message: attachedArtifacts.length > 0
          ? { ...message, artifacts: attachedArtifacts.map(toArtifactDto), ...(referenceSet ? { referenceSet } : {}) }
          : { ...message, ...(referenceSet ? { referenceSet } : {}) },
        dispatches,
        route,
        ...(coalescedDispatchId ? { coalescedDispatchId } : {}),
        ...(task ? { task } : {}),
        ...(acknowledgementMessage ? { acknowledgementMessage } : {}),
        management,
        ...(referenceSet ? { referenceSet } : {}),
      });
    } finally {
      releaseDispatchCoalescingLock();
    }
  }

  return {
    runCoordinationCycle(input?: { now?: number; limit?: number }): Promise<CoordinationCycleSummary> {
      return channelCoordinator.runCoordinationCycle(input);
    },
    processCoordinationJob(jobId: string): Promise<CoordinationJobOutcome> {
      return channelCoordinator.processJob(jobId);
    },
    async evaluateSemanticPromotion(promotionInput) {
      const stopped = await assertTeamPiCommandsAllowed(promotionInput.teamId);
      if (stopped) return stopped;
      if (!(await repositories.teams.isMember(promotionInput.teamId, promotionInput.userId))) {
        return makeFailure('FORBIDDEN', 'Requester is not a team member');
      }
      let command: ReturnType<typeof parseSemanticPromotionEvaluateCommandV1>;
      try {
        command = parseSemanticPromotionEvaluateCommandV1(promotionInput.command);
      } catch {
        return makeFailure('VALIDATION_ERROR', 'Promotion evaluation payload invalid');
      }
      try {
        const result = await promotionModesForTeam(promotionInput.teamId).evaluateSemantic({
          channelId: command.channelId,
          requesterId: promotionInput.userId,
          approverId: command.approverId,
          ...(command.evaluation ? { evaluation: command.evaluation } : {}),
          ...(command.evaluatorFailed ? { evaluatorFailed: true } : {}),
          ...(command.exclusion ? { exclusion: command.exclusion } : {}),
        });
        return makeSuccess({ result });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Promotion evaluation failed');
      }
    },
    async actOnPromotionProposal(promotionInput) {
      const stopped = await assertTeamPiCommandsAllowed(promotionInput.teamId);
      if (stopped) return stopped;
      if (!(await repositories.teams.isMember(promotionInput.teamId, promotionInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      let action: ReturnType<typeof parsePromotionProposalActionV1>;
      try {
        action = parsePromotionProposalActionV1(promotionInput.action);
      } catch {
        return makeFailure('VALIDATION_ERROR', 'Promotion proposal action invalid');
      }
      try {
        const result = await promotionModesForTeam(promotionInput.teamId).actOnProposal({
          actorId: promotionInput.userId,
          action,
        });
        return makeSuccess({ result });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Promotion proposal action failed');
      }
    },
    async updateSemanticPromotionRollout(promotionInput) {
      const role = await repositories.teams.getMemberRole(promotionInput.teamId, promotionInput.userId);
      if (role !== 'owner' && role !== 'admin') {
        return makeFailure('FORBIDDEN', 'Team owner or admin required');
      }
      let state: ReturnType<typeof parseSemanticPromotionRolloutStateV1>;
      try {
        state = parseSemanticPromotionRolloutStateV1(promotionInput.state);
      } catch {
        return makeFailure('VALIDATION_ERROR', 'Promotion rollout payload invalid');
      }
      if (state.teamId !== promotionInput.teamId) {
        return makeFailure('FORBIDDEN', 'Promotion rollout team mismatch');
      }
      try {
        return makeSuccess({
          result: await promotionModesForTeam(promotionInput.teamId).upsertSemanticRollout(state),
        });
      } catch (error) {
        return error instanceof Error && error.message === 'SEMANTIC_PROMOTION_ROLLOUT_REVISION_CONFLICT'
          ? makeFailure('CONFLICT', error.message)
          : makeFailure('INTERNAL_ERROR', 'Promotion rollout update failed');
      }
    },
    async updateTeamPromotionPolicy(promotionInput) {
      const role = await repositories.teams.getMemberRole(promotionInput.teamId, promotionInput.userId);
      if (role !== 'owner' && role !== 'admin') {
        return makeFailure('FORBIDDEN', 'Team owner or admin required');
      }
      let policy: ReturnType<typeof parseTeamPromotionPolicyV1>;
      try {
        policy = parseTeamPromotionPolicyV1(promotionInput.policy);
      } catch {
        return makeFailure('VALIDATION_ERROR', 'Promotion policy payload invalid');
      }
      if (policy.teamId !== promotionInput.teamId) {
        return makeFailure('FORBIDDEN', 'Promotion policy team mismatch');
      }
      try {
        return makeSuccess({
          result: await promotionModesForTeam(promotionInput.teamId).upsertTeamPolicy(policy),
        });
      } catch (error) {
        return error instanceof Error && error.message === 'TEAM_PROMOTION_POLICY_REVISION_CONFLICT'
          ? makeFailure('CONFLICT', error.message)
          : makeFailure('INTERNAL_ERROR', 'Promotion policy update failed');
      }
    },
    async applyTeamPromotionPolicy(promotionInput) {
      if (!(await repositories.teams.isMember(promotionInput.teamId, promotionInput.userId))) {
        return makeFailure('FORBIDDEN', 'Requester is not a team member');
      }
      let command: ReturnType<typeof parseTeamPromotionPolicyApplicationV1>;
      try {
        command = parseTeamPromotionPolicyApplicationV1(promotionInput.command);
      } catch {
        return makeFailure('VALIDATION_ERROR', 'Promotion policy application invalid');
      }
      try {
        const result = await promotionModesForTeam(promotionInput.teamId).applyTeamPolicy({
          requesterId: promotionInput.userId,
          channelId: command.channelId,
          ruleId: command.ruleId,
          orchestrationNeed: command.orchestrationNeed,
          ...(command.exclusion ? { exclusion: command.exclusion } : {}),
          objectiveSnapshot: command.objectiveSnapshot,
          freshnessBasis: command.freshnessBasis,
          idempotencyKey: command.idempotencyKey,
        });
        return makeSuccess({ result });
      } catch {
        return makeFailure('INTERNAL_ERROR', 'Promotion policy application failed');
      }
    },
    async escalateAgentOrchestration(promotionInput) {
      let command;
      try {
        command = parseAgentOrchestrationEscalationCommandV1(promotionInput.command);
      } catch {
        return makeFailure('VALIDATION_ERROR', 'Agent escalation payload invalid');
      }
      const simple = command.escalation.simpleRequest;
      if (!simple) return makeFailure('VALIDATION_ERROR', 'Simple request context required');
      const [agent, dispatch] = await Promise.all([
        repositories.agents.getById(command.escalation.agentId),
        repositories.dispatches.getById(simple.dispatchId),
      ]);
      if (!agent || agent.deviceId !== promotionInput.deviceId || !dispatch
        || dispatch.agentId !== agent.id || dispatch.messageId !== simple.messageId) {
        return makeFailure('FORBIDDEN', 'Agent escalation authority mismatch');
      }
      const team = await repositories.teams.getById(dispatch.teamId);
      if (!team) return makeFailure('NOT_FOUND', 'Team not found');
      const result = await promotionModesForTeam(dispatch.teamId).escalateAgent({
        escalation: command.escalation,
        idempotencyKey: command.idempotencyKey,
        approverId: team.ownerId,
      });
      return makeSuccess({ result });
    },
    async registerUser(registerInput) {
      const existing = await repositories.users.getByUsername(registerInput.username);
      if (existing) {
        return makeFailure('CONFLICT', 'Username already exists');
      }
      const joinLink = registerInput.joinCode
        ? await getUsableJoinLink(repositories, clock, registerInput.joinCode)
        : undefined;
      if (joinLink && !joinLink.ok) {
        return joinLink;
      }

      const now = clock.now();
      const userId = ids.nextId();
      const teamId = ids.nextId();
      const channelId = ids.nextId();
      const username = normalizeUsername(registerInput.username);
      const teamName = registerInput.teamName?.trim() || registerInput.username;
      const teamPath = slugify(teamName);

      const user = await repositories.users.create({
        id: userId,
        username,
        role: 'user',
        primaryTeamId: teamId,
        currentTeamId: teamId,
        passwordHash: await hashPassword(registerInput.password),
        createdAt: now,
        updatedAt: now,
      });
      const team = await repositories.teams.create({
        id: teamId,
        name: teamName,
        path: teamPath,
        visibility: 'private',
        ownerId: userId,
        createdAt: now,
      });
      await repositories.teams.addMember({
        teamId,
        userId,
        username,
        role: 'owner',
        joinedAt: now,
      });
      await repositories.users.setCurrentTeam(userId, teamId);
      const defaultChannel = await repositories.channels.create({
        id: channelId,
        teamId,
        kind: 'channel',
        name: 'all',
        visibility: 'public',
        createdBy: userId,
        createdAt: now,
        humanMemberIds: [userId],
        agentMemberIds: [],
      });

      let currentTeam = toTeamDto(team, 'owner');
      let joinedTeam: TeamDto | undefined;
      if (joinLink?.ok) {
        const joined = await joinTeamFromLink(repositories, clock, joinLink.link, user);
        if (!joined.ok) {
          return joined;
        }
        currentTeam = joined.currentTeam;
        joinedTeam = joined.currentTeam;
      }

      return makeSuccess({
        token: issueSessionToken(user.id, sessionSecret),
        user: { ...toUserDto(user), primaryTeamId: currentTeam.id },
        currentTeam,
        defaultChannel,
        ...(joinedTeam ? { joinedTeam } : {}),
      });
    },

    async loginUser(loginInput) {
      const user = await repositories.users.getByUsername(normalizeUsername(loginInput.username));
      if (!user) {
        return makeFailure('UNAUTHENTICATED', 'Invalid username or password');
      }
      // 支持 scrypt（新）与裸 SHA256（旧 server-next 遗留）两种哈希；旧哈希校验通过后顺带升级。
      const okScrypt = await verifyPassword(loginInput.password, user.passwordHash);
      const okLegacy = !okScrypt && isLegacyHash(user.passwordHash) && verifyLegacySha256(loginInput.password, user.passwordHash);
      if (!okScrypt && !okLegacy) {
        return makeFailure('UNAUTHENTICATED', 'Invalid username or password');
      }
      if (okLegacy) {
        await repositories.users.updatePassword({
          userId: user.id,
          passwordHash: await hashPassword(loginInput.password),
          updatedAt: clock.now(),
        });
      }

      const joined = loginInput.joinCode
        ? await consumeJoinCodeForUser(repositories, clock, loginInput.joinCode, user)
        : undefined;
      if (joined && !joined.ok) {
        return joined;
      }
      const currentTeam = joined?.currentTeam ?? await resolveCurrentTeam(repositories, user);
      if (!currentTeam) {
        return makeFailure('FORBIDDEN', 'User has no team membership');
      }

      await repositories.users.setCurrentTeam(user.id, currentTeam.id);

      return makeSuccess({
        token: issueSessionToken(user.id, sessionSecret),
        user: { ...toUserDto(user), primaryTeamId: currentTeam.id },
        currentTeam: toTeamDto(currentTeam, currentTeam.currentUserRole),
        ...(joined ? { joinedTeam: toTeamDto(joined.currentTeam, joined.currentTeam.currentUserRole) } : {}),
      });
    },

    async changePassword(input) {
      const user = await repositories.users.getById(input.userId);
      if (!user) {
        return makeFailure('UNAUTHENTICATED', 'User not found');
      }
      const okScrypt = await verifyPassword(input.currentPassword, user.passwordHash);
      const okLegacy = !okScrypt && isLegacyHash(user.passwordHash) && verifyLegacySha256(input.currentPassword, user.passwordHash);
      if (!okScrypt && !okLegacy) {
        return makeFailure('UNAUTHENTICATED', 'Current password is incorrect');
      }
      if (input.newPassword.length < 6) {
        return makeFailure('VALIDATION_ERROR', 'Password must be at least 6 characters');
      }
      await repositories.users.updatePassword({
        userId: user.id,
        passwordHash: await hashPassword(input.newPassword),
        updatedAt: clock.now(),
      });
      return makeSuccess({});
    },

    async deleteOwnAccount(input) {
      if (input.userId === 'system') {
        return makeFailure('VALIDATION_ERROR', 'Cannot delete protected user');
      }
      const user = await repositories.users.getById(input.userId);
      if (!user) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      if (user.role === 'admin') {
        return makeFailure('FORBIDDEN', 'System admin cannot delete own account');
      }
      const ownedTeam = (await repositories.teams.listAll()).find((team) => team.ownerId === user.id);
      if (ownedTeam) {
        return makeFailure('CONFLICT', 'Cannot delete a user who owns a team');
      }
      const memberships = await repositories.teams.listForUser(user.id);
      if (memberships.length > 0) {
        return makeFailure('CONFLICT', 'Leave or remove all team memberships before deleting account');
      }
      await repositories.users.delete(user.id);
      return makeSuccess({});
    },

    async whoami(whoamiInput) {
      const userId = verifySessionToken(whoamiInput.token, sessionSecret);
      if (!userId) {
        return makeFailure('UNAUTHENTICATED', 'Invalid session token');
      }
      const user = await repositories.users.getById(userId);
      if (!user) {
        return makeFailure('UNAUTHENTICATED', 'Session user no longer exists');
      }
      const currentTeam = await resolveCurrentTeam(repositories, user);
      if (!currentTeam) {
        return makeFailure('FORBIDDEN', 'User has no team membership');
      }
      let verifiedCurrentDeviceId: string | undefined;
      let deviceCredentialStatus: WhoamiResult['deviceCredentialStatus'];
      if (whoamiInput.deviceToken) {
        const credentials = verifyDeviceToken(whoamiInput.deviceToken, sessionSecret);
        if (credentials?.ownerId === userId) {
          const device = credentials.deviceId
            ? await repositories.devices.getById(credentials.deviceId)
            : await findDeviceByCredentials(repositories, credentials.teamId, credentials);
          if (device?.ownerId === userId && device.teamId === credentials.teamId) {
            verifiedCurrentDeviceId = device.id;
            deviceCredentialStatus = 'verified';
          } else {
            deviceCredentialStatus = credentials.deviceId ? 'invalid' : 'pending';
          }
        } else {
          deviceCredentialStatus = 'invalid';
        }
      }
      return makeSuccess({
        user: { ...toUserDto(user), primaryTeamId: currentTeam.id },
        currentTeam: toTeamDto(currentTeam, currentTeam.currentUserRole),
        ...(verifiedCurrentDeviceId ? { verifiedCurrentDeviceId } : {}),
        ...(deviceCredentialStatus ? { deviceCredentialStatus } : {}),
      });
    },

    async listTeams(listInput) {
      const user = await repositories.users.getById(listInput.userId);
      if (!user) {
        return makeFailure('UNAUTHENTICATED', 'User not found');
      }
      const teams = await repositories.teams.listForUser(listInput.userId);
      const currentTeam = resolveCurrentTeamFromList(teams, user);
      return makeSuccess({
        currentTeamId: currentTeam?.id,
        teams: teams.map((team) => toTeamDto(team, team.currentUserRole)),
      });
    },

    async listAdminTeams(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const { page, pageSize } = normalizeAdminListPagination(adminInput);
      const q = normalizeAdminListQuery(adminInput.q);
      const allTeams = sortAdminInventoryByCreatedAtDesc(await repositories.teams.listAll());
      const filtered = q
        ? allTeams.filter((team) => adminInventoryMatchesQuery(q, [team.name, team.path]))
        : allTeams;
      const total = filtered.length;
      const pageTeams = sliceAdminInventoryPage(filtered, page, pageSize);
      const result: AdminTeamDto[] = [];
      for (const team of pageTeams) {
        result.push({
          ...team,
          members: await repositories.teams.listAllMembers(team.id),
        });
      }
      return makeSuccess({ teams: result, page, pageSize, total });
    },

    async listAdminUsers(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const { page, pageSize } = normalizeAdminListPagination(adminInput);
      const q = normalizeAdminListQuery(adminInput.q);
      const allUsers = sortAdminInventoryByCreatedAtDesc(await repositories.users.listAll());
      const filtered = q
        ? allUsers.filter((user) =>
            adminInventoryMatchesQuery(q, [user.username, user.displayName, user.email]))
        : allUsers;
      const total = filtered.length;
      const pageUsers = sliceAdminInventoryPage(filtered, page, pageSize);
      return makeSuccess({
        users: pageUsers.map((user) => ({
          ...toUserDto(user),
          email: user.email ?? null,
          createdAt: user.createdAt,
        })),
        page,
        pageSize,
        total,
      });
    },

    async createAdminUser(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.adminUserId);
      if (!admin.ok) {
        return admin;
      }

      const usernameRaw = typeof adminInput.username === 'string' ? adminInput.username : '';
      const username = normalizeUsername(usernameRaw);
      if (!username) {
        return makeFailure('VALIDATION_ERROR', 'Username is required');
      }
      const password = typeof adminInput.password === 'string' ? adminInput.password : '';
      if (password.length < 6) {
        return makeFailure('VALIDATION_ERROR', 'Password must be at least 6 characters');
      }
      const role: UserRole = adminInput.role ?? 'user';
      if (role !== 'user' && role !== 'admin') {
        return makeFailure('VALIDATION_ERROR', 'Role must be user or admin');
      }
      const createPersonalTeam = adminInput.createPersonalTeam !== false;
      const displayName =
        typeof adminInput.displayName === 'string' && adminInput.displayName.trim().length > 0
          ? adminInput.displayName.trim()
          : undefined;

      const existing = await repositories.users.getByUsername(username);
      if (existing) {
        return makeFailure('CONFLICT', 'Username already exists');
      }

      const now = clock.now();
      const userId = ids.nextId();
      const teamId = createPersonalTeam ? ids.nextId() : undefined;
      const channelId = createPersonalTeam ? ids.nextId() : undefined;
      const passwordHash = await hashPassword(password);

      const user = await repositories.users.create({
        id: userId,
        username,
        role,
        ...(displayName ? { displayName } : {}),
        ...(teamId ? { primaryTeamId: teamId, currentTeamId: teamId } : {}),
        passwordHash,
        createdAt: now,
        updatedAt: now,
      });

      if (!createPersonalTeam || !teamId || !channelId) {
        return makeSuccess({
          user: {
            ...toUserDto(user),
            email: user.email ?? null,
            createdAt: user.createdAt,
          },
        });
      }

      const teamName = displayName || username;
      const teamPath = await allocateUniqueTeamPath(repositories, teamName);
      const team = await repositories.teams.create({
        id: teamId,
        name: teamName,
        path: teamPath,
        visibility: 'private',
        ownerId: userId,
        createdAt: now,
      });
      await repositories.teams.addMember({
        teamId,
        userId,
        username,
        role: 'owner',
        joinedAt: now,
      });
      await repositories.users.setCurrentTeam(userId, teamId);
      const defaultChannel = await repositories.channels.create({
        id: channelId,
        teamId,
        kind: 'channel',
        name: 'all',
        visibility: 'public',
        createdBy: userId,
        createdAt: now,
        humanMemberIds: [userId],
        agentMemberIds: [],
      });

      return makeSuccess({
        user: {
          ...toUserDto({ ...user, primaryTeamId: teamId }),
          email: user.email ?? null,
          createdAt: user.createdAt,
        },
        team: toTeamDto(team, 'owner'),
        defaultChannel,
      });
    },

    async updateAdminUser(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.adminUserId);
      if (!admin.ok) {
        return admin;
      }
      const user = await repositories.users.getById(adminInput.targetUserId);
      if (!user) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      if (isProtectedSystemUser(user)) {
        return makeFailure('VALIDATION_ERROR', 'Cannot modify protected user');
      }

      const hasDisplayName = adminInput.displayName !== undefined;
      const hasEmail = adminInput.email !== undefined;
      const hasRole = adminInput.role !== undefined;
      if (!hasDisplayName && !hasEmail && !hasRole) {
        return makeFailure('VALIDATION_ERROR', 'No fields to update');
      }

      let nextRole: UserRole | undefined;
      if (hasRole) {
        if (adminInput.role !== 'user' && adminInput.role !== 'admin') {
          return makeFailure('VALIDATION_ERROR', 'Role must be user or admin');
        }
        nextRole = adminInput.role;
      }

      let nextDisplayName: string | null | undefined;
      if (hasDisplayName) {
        if (adminInput.displayName === null) {
          nextDisplayName = null;
        } else {
          const trimmed = String(adminInput.displayName).trim();
          nextDisplayName = trimmed.length > 0 ? trimmed : null;
        }
      }

      let nextEmail: string | null | undefined;
      if (hasEmail) {
        if (adminInput.email === null) {
          nextEmail = null;
        } else {
          const trimmed = String(adminInput.email).trim();
          nextEmail = trimmed.length > 0 ? trimmed : null;
        }
      }

      // Admin count check + role write are atomic inside updateProfile (see LAST_ADMIN).
      const updated = await repositories.users.updateProfile({
        userId: user.id,
        updatedAt: clock.now(),
        ...(nextDisplayName !== undefined ? { displayName: nextDisplayName } : {}),
        ...(nextEmail !== undefined ? { email: nextEmail } : {}),
        ...(nextRole !== undefined ? { role: nextRole } : {}),
      });
      if (!updated.ok) {
        if (updated.error === 'LAST_ADMIN') {
          return makeFailure('CONFLICT', 'Cannot demote the last admin');
        }
        if (updated.error === 'EMAIL_CONFLICT') {
          return makeFailure('CONFLICT', 'Email already in use');
        }
        return makeFailure('NOT_FOUND', 'User not found');
      }

      return makeSuccess({
        user: {
          ...toUserDto(updated.user),
          // Explicit nulls so JSON/socket clients can clear prior list-row fields on merge.
          displayName: updated.user.displayName ?? null,
          email: updated.user.email ?? null,
          createdAt: updated.user.createdAt,
        },
      });
    },

    async resetAdminUserPassword(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.adminUserId);
      if (!admin.ok) {
        return admin;
      }
      const user = await repositories.users.getById(adminInput.targetUserId);
      if (!user) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      if (isProtectedSystemUser(user)) {
        return makeFailure('VALIDATION_ERROR', 'Cannot modify protected user');
      }
      const newPassword = typeof adminInput.newPassword === 'string' ? adminInput.newPassword : '';
      if (newPassword.length < 6) {
        return makeFailure('VALIDATION_ERROR', 'Password must be at least 6 characters');
      }
      const written = await repositories.users.updatePassword({
        userId: user.id,
        passwordHash: await hashPassword(newPassword),
        updatedAt: clock.now(),
      });
      if (!written) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      return makeSuccess({});
    },

    async listAdminDevices(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const { page, pageSize } = normalizeAdminListPagination(adminInput);
      const q = normalizeAdminListQuery(adminInput.q);
      const allDevices = sortAdminInventoryByCreatedAtDesc(await repositories.devices.listAll());
      const filtered = q
        ? allDevices.filter((device) =>
            adminInventoryMatchesQuery(q, [
              device.name,
              device.hostname,
              device.systemInfo?.hostname,
            ]))
        : allDevices;
      const total = filtered.length;
      const pageDevices = sliceAdminInventoryPage(filtered, page, pageSize);
      const devices: AdminDeviceDto[] = [];
      for (const device of pageDevices) {
        devices.push(await toAdminDeviceDto(repositories, device));
      }
      return makeSuccess({ devices, page, pageSize, total });
    },

    async listAdminAgents(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const { page, pageSize } = normalizeAdminListPagination(adminInput);
      const q = normalizeAdminListQuery(adminInput.q);
      // listAll already excludes soft-deleted agents; keep that as the default inventory filter.
      const allAgents = sortAdminInventoryByCreatedAtDesc(await repositories.agents.listAll());
      const filtered = q
        ? allAgents.filter((agent) => adminInventoryMatchesQuery(q, [agent.name]))
        : allAgents;
      const total = filtered.length;
      const pageAgents = sliceAdminInventoryPage(filtered, page, pageSize);
      return makeSuccess({
        agents: await toAdminAgentDtos(repositories, pageAgents),
        page,
        pageSize,
        total,
      });
    },

    async deleteAdminTeam(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const team = await repositories.teams.getById(adminInput.teamId);
      if (!team) {
        return makeFailure('NOT_FOUND', 'Team not found');
      }
      await repositories.teams.delete(team.id);
      return makeSuccess({});
    },

    async deleteAdminUser(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.adminUserId);
      if (!admin.ok) {
        return admin;
      }
      if (adminInput.targetUserId === adminInput.adminUserId) {
        return makeFailure('VALIDATION_ERROR', 'Cannot delete protected user');
      }
      const user = await repositories.users.getById(adminInput.targetUserId);
      if (!user) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      if (isProtectedSystemUser(user)) {
        return makeFailure('VALIDATION_ERROR', 'Cannot delete protected user');
      }
      const ownedTeam = (await repositories.teams.listAll()).find((team) => team.ownerId === user.id);
      if (ownedTeam) {
        return makeFailure('CONFLICT', 'Cannot delete a user who owns a team');
      }
      await repositories.users.delete(user.id);
      return makeSuccess({});
    },

    async deleteAdminAgent(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const agent = await repositories.agents.getById(adminInput.agentId);
      if (!agent || agent.deletedAt !== undefined) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      const affectedTeamIds = agent.visibleTeamIds;
      const now = clock.now();
      for (const teamId of affectedTeamIds) {
        await repositories.channels.removeAgentFromTeamChannels({
          teamId,
          agentId: agent.id,
          timestamp: now,
        });
      }
      const deleted = await repositories.agents.softDelete({
        agentId: adminInput.agentId,
        timestamp: now,
      });
      if (!deleted) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      return makeSuccess({});
    },

    async transferDeviceOwnerAsAdmin(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.adminUserId);
      if (!admin.ok) {
        return admin;
      }
      const device = await repositories.devices.getById(adminInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      const target = await repositories.users.getById(adminInput.targetUserId);
      if (!target) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, target.id))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const now = clock.now();
      const updated = await repositories.devices.transferOwner({
        deviceId: device.id,
        ownerId: target.id,
        updatedAt: now,
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      await repositories.agents.updateOwnerByDevice({
        deviceId: device.id,
        ownerId: target.id,
        timestamp: now,
      });
      return makeSuccess({
        device: await toAdminDeviceDto(repositories, updated),
      });
    },

    async createTeam(teamInput) {
      const user = await repositories.users.getById(teamInput.userId);
      if (!user) {
        return makeFailure('UNAUTHENTICATED', 'User not found');
      }

      const now = clock.now();
      const teamId = ids.nextId();
      const channelId = ids.nextId();
      const team = await repositories.teams.create({
        id: teamId,
        name: teamInput.name.trim(),
        path: slugify(teamInput.name),
        visibility: 'private',
        ownerId: user.id,
        createdAt: now,
      });
      await repositories.teams.addMember({
        teamId,
        userId: user.id,
        username: user.username,
        role: 'owner',
        joinedAt: now,
      });
      const defaultChannel = await repositories.channels.create({
        id: channelId,
        teamId,
        kind: 'channel',
        name: 'all',
        visibility: 'public',
        createdBy: user.id,
        createdAt: now,
        humanMemberIds: [user.id],
        agentMemberIds: [],
      });
      await repositories.users.setCurrentTeam(user.id, teamId);

      return makeSuccess({
        team: toTeamDto(team, 'owner'),
        defaultChannel,
      });
    },

    async switchTeam(teamInput) {
      const team = await repositories.teams.getById(teamInput.teamId);
      if (!team) {
        return makeFailure('NOT_FOUND', 'Team not found');
      }
      const role = await repositories.teams.getMemberRole(teamInput.teamId, teamInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      await repositories.users.setCurrentTeam(teamInput.userId, teamInput.teamId);

      return makeSuccess({
        currentTeam: toTeamDto(team, role),
      });
    },

    async createJoinLink(joinInput) {
      const team = await repositories.teams.getById(joinInput.teamId);
      if (!team) {
        return makeFailure('NOT_FOUND', 'Team not found');
      }
      const role = await repositories.teams.getMemberRole(joinInput.teamId, joinInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const linkId = ids.nextId();
      const link = await repositories.joinLinks.create({
        id: linkId,
        code: joinCodes.nextCode(),
        teamId: team.id,
        createdBy: joinInput.userId,
        createdAt: clock.now(),
        expiresAt: joinInput.expiresAt,
        maxUses: joinInput.maxUses ?? 1,
        usesCount: 0,
      });

      return makeSuccess({
        link: toJoinLinkDto(link),
        team: toTeamDto(team, role),
      });
    },

    async listJoinLinks(listInput) {
      const role = await repositories.teams.getMemberRole(listInput.teamId, listInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const links = await repositories.joinLinks.listByTeam(listInput.teamId);
      return makeSuccess({ links: links.filter((link) => link.revokedAt === undefined).map(toJoinLinkDto) });
    },

    async revokeJoinLink(revokeInput) {
      const role = await repositories.teams.getMemberRole(revokeInput.teamId, revokeInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const link = await repositories.joinLinks.getByCode(revokeInput.code);
      if (!link || link.teamId !== revokeInput.teamId) {
        return makeFailure('NOT_FOUND', 'Join link not found');
      }
      const updated = await repositories.joinLinks.revoke({
        teamId: revokeInput.teamId,
        code: revokeInput.code,
        revokedAt: clock.now(),
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Join link not found');
      }
      return makeSuccess({ link: toJoinLinkDto(updated) });
    },

    async validateJoinLink(joinInput) {
      const usable = await getUsableJoinLink(repositories, clock, joinInput.code);
      if (!usable.ok) {
        return usable;
      }
      const team = await repositories.teams.getById(usable.link.teamId);
      if (!team) {
        return makeFailure('INVITE_INVALID', 'Join link team no longer exists');
      }
      return makeSuccess({
        link: toJoinLinkDto(usable.link),
        team: toTeamDto(team, 'member'),
      });
    },

    async createDeviceInvite(inviteInput) {
      const team = await repositories.teams.getById(inviteInput.teamId);
      if (!team) {
        return makeFailure('NOT_FOUND', 'Team not found');
      }
      const role = await repositories.teams.getMemberRole(inviteInput.teamId, inviteInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const invite = await repositories.deviceInvites.create({
        id: ids.nextId(),
        code: deviceInviteCodes.nextCode(),
        teamId: team.id,
        createdBy: inviteInput.userId,
        createdAt: clock.now(),
        expiresAt: inviteInput.expiresAt ?? clock.now() + 30 * 60_000,
        profileId: inviteInput.profileId,
      });

      return makeSuccess({
        invite: toDeviceInviteDto(invite, buildDeviceInviteCommand(invite.code, invite.profileId ?? team.path)),
        team: toTeamDto(team, role),
      });
    },

    async waitForDeviceInvite(inviteInput) {
      const usable = await getUsableDeviceInviteForWait(repositories, clock, inviteInput);
      if (!usable.ok) {
        return usable;
      }
      const team = await repositories.teams.getById(usable.invite.teamId);
      if (!team) {
        return makeFailure('INVITE_INVALID', 'Device invite team no longer exists');
      }
      // 已完成的邀请仅允许原 Mac/Profile 在有效期内重试；不再覆写首次完成时的 waiter 元数据。
      const updated = usable.invite.completedAt !== undefined
        ? usable.invite
        : await repositories.deviceInvites.updateWaiter({
          code: usable.invite.code,
          machineId: inviteInput.machineId,
          profileId: inviteInput.profileId,
          hostname: inviteInput.hostname,
          serverUrl: inviteInput.serverUrl,
        });
      if (!updated) {
        return makeFailure('INVITE_INVALID', 'Device invite is invalid');
      }

      return makeSuccess({
        invite: toDeviceInviteDto(updated),
        team: toTeamDto(team, 'member'),
      });
    },

    async completeDeviceInvite(inviteInput) {
      const invite = await repositories.deviceInvites.getByCode(inviteInput.code);
      if (!invite) {
        return makeFailure('INVITE_INVALID', 'Device invite is invalid');
      }
      if (invite.expiresAt !== undefined && invite.expiresAt <= clock.now()) {
        return makeFailure('INVITE_EXPIRED', 'Device invite has expired');
      }
      const team = await repositories.teams.getById(invite.teamId);
      if (!team) {
        return makeFailure('INVITE_INVALID', 'Device invite team no longer exists');
      }
      const role = await repositories.teams.getMemberRole(team.id, inviteInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      let completed = invite;
      if (invite.completedAt !== undefined) {
        if (invite.createdBy !== inviteInput.userId) {
          return makeFailure('INVITE_ALREADY_USED', 'Device invite has already been used');
        }
      } else {
        const completedInvite = await repositories.deviceInvites.complete({
          code: invite.code,
          completedAt: clock.now(),
          serverUrl: inviteInput.serverUrl,
        });
        if (!completedInvite) {
          return makeFailure('INVITE_ALREADY_USED', 'Device invite has already been used');
        }
        completed = completedInvite;
      }
      const credentials: DeviceInviteCredentialsDto = {
        token: issueDeviceToken({
          teamId: completed.teamId,
          ownerId: inviteInput.userId,
          machineId: completed.machineId,
          profileId: completed.profileId,
          hostname: completed.hostname,
        }, sessionSecret),
        teamId: completed.teamId,
        ownerId: inviteInput.userId,
        machineId: completed.machineId,
        profileId: completed.profileId,
        hostname: completed.hostname,
        serverUrl: completed.serverUrl ?? inviteInput.serverUrl,
      };

      return makeSuccess({
        invite: toDeviceInviteDto(completed),
        team: toTeamDto(team, role),
        credentials,
      });
    },

    async deviceHelloFromCredentials(deviceInput) {
      const credentials = verifyDeviceToken(deviceInput.token, sessionSecret);
      if (!credentials) {
        return makeFailure('UNAUTHENTICATED', 'Invalid device credentials');
      }
      if (credentials.machineId && deviceInput.machineId && credentials.machineId !== deviceInput.machineId) {
        return makeFailure('FORBIDDEN', 'Device credentials do not match machine');
      }
      if (credentials.profileId && deviceInput.profileId && credentials.profileId !== deviceInput.profileId) {
        return makeFailure('FORBIDDEN', 'Device credentials do not match profile');
      }
      const machineId = deviceInput.machineId ?? credentials.machineId;
      // 只有未绑定 deviceId 的 invite token 表示“重新接入”，允许清除吊销。
      // 已绑定设备 token 是 daemon 的常规重连凭证，必须继续接受 deviceHello 的吊销检查。
      if (!credentials.deviceId && machineId) {
        await repositories.revocations.clear({ teamId: credentials.teamId, machineId });
      }
      return this.deviceHello({
        teamId: credentials.teamId,
        ownerId: credentials.ownerId,
        machineId: deviceInput.machineId ?? credentials.machineId,
        profileId: deviceInput.profileId ?? credentials.profileId,
        hostname: deviceInput.hostname ?? credentials.hostname,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
        capabilities: deviceInput.capabilities,
      });
    },

    async getAgentEnvForDevice(envInput) {
      const credentials = verifyDeviceToken(envInput.token, sessionSecret);
      if (!credentials || credentials.teamId !== envInput.teamId) {
        return makeFailure('UNAUTHENTICATED', 'Invalid device credentials');
      }
      const device = credentials.deviceId
        ? await repositories.devices.getById(credentials.deviceId)
        : await findDeviceByCredentials(repositories, envInput.teamId, credentials);
      if (!device || device.teamId !== envInput.teamId) {
        return makeFailure('UNAUTHENTICATED', 'Unknown device for team');
      }
      const agent = await repositories.agents.getById(envInput.agentId);
      if (!agent || agent.primaryTeamId !== envInput.teamId || agent.deletedAt) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      if (agent.deviceId !== device.id) {
        return makeFailure('FORBIDDEN', 'Device is not bound to this agent');
      }
      if (agent.source !== 'custom') {
        return makeFailure('FORBIDDEN', 'Agent is not custom');
      }
      const config = await repositories.agents.getExecutionConfig(envInput.agentId);
      return makeSuccess({ env: config?.env ?? {} });
    },

    async deviceHello(deviceInput) {
      const now = clock.now();
      const existing =
        deviceInput.machineId && deviceInput.profileId
          ? await repositories.devices.findByMachineProfile({
            teamId: deviceInput.teamId,
            machineId: deviceInput.machineId,
            profileId: deviceInput.profileId,
          })
          : null;

      // 吊销检查：离线删除后重连复活防护（层2）
      if (deviceInput.machineId) {
        const revoked = await repositories.revocations.find({
          teamId: deviceInput.teamId,
          machineId: deviceInput.machineId,
          profileId: deviceInput.profileId ?? null,
        });
        if (revoked) {
          return makeFailure('DEVICE_REVOKED', 'Device was removed from team');
        }
      }

      const ownerId = existing?.ownerId ?? deviceInput.ownerId;
      if (!(await repositories.teams.isMember(deviceInput.teamId, ownerId))) {
        return makeFailure('FORBIDDEN', 'Device owner is not a team member');
      }

      // 解析持久化别名关系：缺 machineId/profileId 的新记录，若与现有同名 canonical 设备互为别名，
      // 则 canonicalDeviceId 指向其 id；有 machineId 的设备走 findByMachineProfile（existing），关系保持 null。
      let canonicalDeviceId: string | null = null;
      if (existing) {
        canonicalDeviceId = existing.canonicalDeviceId ?? null;
      } else if ((!deviceInput.machineId || !deviceInput.profileId) && deviceInput.hostname) {
        const alias = await repositories.devices.findCanonicalByDisplay({
          teamId: deviceInput.teamId,
          ownerId,
          name: deviceInput.hostname,
        });
        if (alias) canonicalDeviceId = alias.id;
      }

      const device = await repositories.devices.upsertHello({
        id: existing?.id ?? ids.nextId(),
        teamId: deviceInput.teamId,
        ownerId,
        status: 'online',
        // 重连不得覆盖用户改名：existing 保留其 name/nameSource；新建时初始化为机器名（hostname）。
        name: existing ? existing.name : deviceInput.hostname,
        nameSource: existing ? existing.nameSource : 'hostname',
        hostname: deviceInput.hostname,
        machineId: deviceInput.machineId,
        profileId: deviceInput.profileId,
        canonicalDeviceId,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
        capabilities: deviceInput.capabilities,
        lastSeenAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      // 设备重连：恢复其托管的 custom agent 为 online。custom agent 不由 daemon 扫描上报
      //（registerDiscoveredAgents 只处理 source='scanned'），一旦因设备掉线被级联成 offline，
      // 只能靠设备重连恢复——其在线语义等价于所绑定 device 在线。
      const affectedTeamIds: string[] = [device.teamId];
      const hostedAgents = await repositories.agents.listByDevice(device.id);
      for (const agent of hostedAgents) {
        // busy 也属在线呈现（dispatching 中），恢复循环不得将其覆盖回 online；
        // 仅 offline（被 markDeviceAndHostedAgentsOffline 级联）需要随设备重连恢复。
        if (agent.source !== 'custom' || agent.status === 'online' || agent.status === 'busy') {
          continue;
        }
        await repositories.agents.updateStatus({
          agentId: agent.id,
          status: 'online',
          lastSeenAt: now,
          lastError: agent.lastError,
        });
        affectedTeamIds.push(...agent.visibleTeamIds);
      }

      const piMigration = await repositories.teamPiAuthorityMigrations.get(device.teamId);
      const piAuthorityCapabilities = piMigration
        ? negotiateDaemonPiCapabilities({ daemonProtocolVersion: Number(deviceInput.daemonVersion?.split('.')[0]) || 0, advertisedCapabilities: [], teamMigrationState: piMigration.state, legacyWriterFenced: piMigration.legacyWriterFenced })
        : undefined;
      return makeSuccess({
        device: await toDeviceDtoWithOwnerName(repositories, device),
        affectedTeamIds: uniqueIds(affectedTeamIds),
        ...(piAuthorityCapabilities ? { piAuthorityCapabilities } : {}),
        credentials: {
          token: issueDeviceToken({
            teamId: device.teamId,
            ownerId: device.ownerId,
            deviceId: device.id,
            machineId: device.machineId,
            profileId: device.profileId,
            hostname: deviceInput.hostname ?? device.systemInfo?.hostname,
          }, sessionSecret),
          teamId: device.teamId,
          ownerId: device.ownerId,
          deviceId: device.id,
          machineId: device.machineId,
          profileId: device.profileId,
          hostname: deviceInput.hostname ?? device.systemInfo?.hostname,
        },
      });
    },

    async listDevices(deviceListInput) {
      if (!(await repositories.teams.isMember(deviceListInput.teamId, deviceListInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const devices = await repositories.devices.listByTeam(deviceListInput.teamId);
      return makeSuccess({
        devices: await toDeviceDtosWithOwnerNames(repositories, dedupeDeviceRecords(devices), deviceListInput.currentDeviceId),
      });
    },

    async markDeviceOffline(offlineInput) {
      const device = await repositories.devices.getById(offlineInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      const { updated, hostedAgents } = await markDeviceAndHostedAgentsOffline(
        repositories,
        device,
        offlineInput.timestamp,
      );
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      return makeSuccess({
        device: await toDeviceDtoWithOwnerName(repositories, updated),
        affectedTeamIds: uniqueIds([device.teamId, ...hostedAgents.flatMap((agent) => agent.visibleTeamIds)]),
      });
    },

    async reconcileDisconnectedDevices(disconnectedInput) {
      const connectedDevices = await repositories.devices.listConnected();
      const devices: DeviceDto[] = [];
      const affectedTeamIds: string[] = [];
      for (const device of connectedDevices) {
        const { updated, hostedAgents } = await markDeviceAndHostedAgentsOffline(
          repositories,
          device,
          disconnectedInput.timestamp,
        );
        if (!updated) {
          continue;
        }
        devices.push(updated);
        affectedTeamIds.push(device.teamId, ...hostedAgents.flatMap((agent) => agent.visibleTeamIds));
      }
      return makeSuccess({ devices: await toDeviceDtosWithOwnerNames(repositories, devices), affectedTeamIds: uniqueIds(affectedTeamIds) });
    },

    async listDeviceAgents(deviceAgentsInput) {
      const device = await repositories.devices.getById(deviceAgentsInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      // 校验 device 属于该 team 且调用者是 team 成员（与 getDevice 一致）
      if (device.teamId !== deviceAgentsInput.teamId) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, deviceAgentsInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const canonicalDevice = resolveCanonicalDeviceRecord(
        device,
        await repositories.devices.listByTeam(device.teamId),
      );
      const [agents, runtimes] = await Promise.all([
        repositories.agents.listByDevice(canonicalDevice.id),
        repositories.runtimes.listByDevice(canonicalDevice.id),
      ]);
      return makeSuccess({
        agents: agents.map((agent) => toDeviceAgentListDto(agent, canonicalDevice)),
        runtimes: runtimes.map(toRuntimeDto),
      });
    },

    async getDevice(deviceDetailInput) {
      const device = await repositories.devices.getById(deviceDetailInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, deviceDetailInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const canonicalDevice = resolveCanonicalDeviceRecord(
        device,
        await repositories.devices.listByTeam(device.teamId),
      );
      const hostedAgents = await repositories.agents.listByDevice(canonicalDevice.id);
      return makeSuccess({
        device: {
          ...(await toDeviceDtoWithOwnerName(repositories, canonicalDevice, deviceDetailInput.currentDeviceId)),
          runtimes: (await repositories.runtimes.listByDevice(canonicalDevice.id)).map(toRuntimeDto),
          agents: hostedAgents.map((agent) => toDeviceAgentListDto(agent, canonicalDevice)),
        },
      });
    },

    // fs:list 目录浏览的管理门禁（PR#642 review 提前自切片2 #637）：
    // fs:list 取消了 selectDirectory 的屏幕物理隔离，宽门控会让任何团队成员
    // 列任意设备任意路径的目录名（含 ~/.ssh 等敏感目录），故端点上线即收紧为
    // 设备拥有者 / 系统管理员，与 renameDevice / deleteDevice 同一业务规则。
    // 每次调用复验（授权不缓存），撤销即时 fail-closed。
    async assertCanManageDevice(manageInput) {
      const device = await repositories.devices.getById(manageInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, manageInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const canonicalDevice = resolveCanonicalDeviceRecord(
        device,
        await repositories.devices.listByTeam(device.teamId),
      );
      if (!(await canManageDeviceAsUser(repositories, { userId: manageInput.userId, device: canonicalDevice }))) {
        return makeFailure('FORBIDDEN', 'User cannot manage device');
      }
      return makeSuccess({ deviceId: canonicalDevice.id });
    },

    async renameDevice(renameInput) {
      const device = await repositories.devices.getById(renameInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, renameInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (!(await canManageDeviceAsUser(repositories, { userId: renameInput.userId, device }))) {
        return makeFailure('FORBIDDEN', 'User cannot manage device');
      }
      const updated = await repositories.devices.updateName({
        deviceId: device.id,
        name: renameInput.name,
        updatedAt: clock.now(),
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      return makeSuccess({ device: await toDeviceDtoWithOwnerName(repositories, updated, renameInput.currentDeviceId) });
    },

    async deleteDevice(deleteInput) {
      const device = await repositories.devices.getById(deleteInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      const actorRole = await repositories.teams.getMemberRole(device.teamId, deleteInput.userId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (!(await canManageDeviceAsUser(repositories, { userId: deleteInput.userId, device }))) {
        return makeFailure('FORBIDDEN', 'User cannot manage device');
      }
      const now = clock.now();
      const teamDevices = await repositories.devices.listByTeam(device.teamId);
      const devicesToDelete = resolveDeviceAliasGroup(device, teamDevices);
      // 写吊销：整组所有真实设备（有 machineId）的凭证，防 deviceHello 重连复活
      await repositories.revocations.upsertAll({
        revocations: devicesToDelete
          .filter((target) => target.machineId)
          .map((target) => ({
            teamId: target.teamId,
            machineId: target.machineId!,
            profileId: target.profileId ?? null,
            deviceId: target.id,
            deletedAt: now,
          })),
      });
      const hostedAgents = (
        await Promise.all(devicesToDelete.map((target) => repositories.agents.listByDevice(target.id)))
      ).flat();
      const affectedTeamIds = uniqueIds([
        ...devicesToDelete.map((target) => target.teamId),
        ...hostedAgents.flatMap((agent) => agent.visibleTeamIds),
      ]);
      for (const agent of hostedAgents) {
        for (const teamId of agent.visibleTeamIds) {
          await repositories.channels.removeAgentFromTeamChannels({
            teamId,
            agentId: agent.id,
            timestamp: now,
          });
        }
      }
      for (const target of devicesToDelete) {
        await repositories.devices.delete({ deviceId: target.id, timestamp: now });
      }
      return makeSuccess({ device: await toDeviceDtoWithOwnerName(repositories, device, deleteInput.currentDeviceId), affectedTeamIds, channelTeamIds: affectedTeamIds, deletedDeviceIds: devicesToDelete.map((target) => target.id) });
    },

    async requestDeviceScan(scanInput) {
      const device = await repositories.devices.getById(scanInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, scanInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (!(await canManageDeviceAsUser(repositories, { userId: scanInput.userId, device }))) {
        return makeFailure('FORBIDDEN', 'User cannot manage device');
      }
      if (device.status !== 'online') {
        return makeFailure('DEVICE_OFFLINE', 'Device is not online');
      }

      // 附带该 device 的 custom agent（executor-hosted + source=custom），供 daemon 扫 skills。
      // 无 custom agent 时省略 customAgents（可选字段），保持与旧请求结构兼容。
      const customAgents = await listCustomAgentsForDevice(repositories, device.id);
      return makeSuccess({
        request: {
          requestId: ids.nextId(),
          deviceId: device.id,
          ...(customAgents.length > 0 ? { customAgents } : {}),
        },
      });
    },

    // hello 首推 / device 自身触发用：跳过 userId 校验（device 连接无 web userId），
    // 仅按 deviceId 查 customAgents 构造 scan request。
    // 当 device 无 custom agent 时返回 skipped:true，调用方据此跳过首推（避免无谓 scanRequested
    // 风暴，并保证不消耗 ids.nextId()，从而不破坏固定 ID 序列的 e2e 流程测试）。
    async buildDeviceScanRequest(buildInput) {
      const device = await repositories.devices.getById(buildInput.deviceId);
      // device 不存在或非 online（如 hello 中途连接异常）→ skipped，不消耗 nextId、不 emit。
      // 与 requestDeviceScan 的 status 守卫一致，保证固定 ID 序列的 e2e 不被破坏。
      if (!device || device.status !== 'online') {
        return makeSuccess({ skipped: true as const, request: undefined });
      }
      const customAgents = await listCustomAgentsForDevice(repositories, device.id);
      if (customAgents.length === 0) {
        return makeSuccess({ skipped: true as const, request: undefined });
      }
      return makeSuccess({
        skipped: false as const,
        request: {
          requestId: ids.nextId(),
          deviceId: device.id,
          customAgents,
        },
      });
    },

    async reportCustomSkills(skillsInput) {
      const device = await repositories.devices.getById(skillsInput.deviceId);
      if (!device || device.teamId !== skillsInput.teamId) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      const now = clock.now();
      let updated = 0;
      for (const item of skillsInput.items) {
        const existing = await repositories.agents.getById(item.agentId);
        // 仅更新本设备的 custom executor-hosted agent；未知 agentId、他设备 agent、
        // 或 scanned/agentos-hosted agent 一律跳过。
        if (!existing || existing.deviceId !== device.id || existing.category !== 'executor-hosted' || existing.source !== 'custom') {
          continue;
        }
        // 过滤掉畸形/恶意 SkillDto（name 非字符串等），避免 daemon 脏数据被静默持久化
        const validSkills = (item.skills ?? []).filter((s): s is SkillDto =>
          typeof s?.name === 'string' && s.name.trim() !== '' &&
          typeof s?.description === 'string' &&
          (s.scope === 'user' || s.scope === 'project' || s.scope === 'system') &&
          typeof s?.sourcePath === 'string' &&
          typeof s?.adapterKind === 'string',
        );
        await repositories.agents.updateSkills({
          agentId: item.agentId,
          skills: validSkills,
          timestamp: now,
        });
        updated += 1;
      }
      return makeSuccess({ updated });
    },

    async reportDeviceRuntimes(runtimeInput) {
      const device = await repositories.devices.getById(runtimeInput.deviceId);
      if (!device || device.teamId !== runtimeInput.teamId) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }

      const now = clock.now();
      const runtimes = await repositories.runtimes.replaceForDevice({
        teamId: runtimeInput.teamId,
        deviceId: runtimeInput.deviceId,
        runtimes: runtimeInput.runtimes.map((runtime) => ({
          id: ids.nextId(),
          teamId: runtimeInput.teamId,
          deviceId: runtimeInput.deviceId,
          adapterKind: normalizeAdapterKind(runtime.adapterKind) as AdapterKind,
          name: runtime.name,
          installed: runtime.installed ?? true,
          command: runtime.command,
          normalizedCommandKey: runtime.command
            ? normalizePathForComparison(runtime.command, { platform: 'unknown' })
            : undefined,
          cwd: runtime.cwd,
          normalizedCwdKey: runtime.cwd
            ? normalizePathForComparison(runtime.cwd, { platform: 'unknown' })
            : undefined,
          version: runtime.version,
          lastSeenAt: now,
        })),
      });

      return makeSuccess({ runtimes: runtimes.map(toRuntimeDto) });
    },

    async registerDiscoveredAgents(discoveredInput) {
      const device = await repositories.devices.getById(discoveredInput.deviceId);
      if (!device || device.teamId !== discoveredInput.teamId) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }

      const now = clock.now();
      const agents: AgentDto[] = [];
      const seenIdentityKeys: string[] = [];

      for (const discovered of discoveredInput.agents) {
        // 源头过滤：只入库 AgentOS 托管型 agent（agentos-hosted）。
        // 编程执行器（executor-hosted）不作为 Agent 成员，仅以 RuntimeDto 形式
        // 在设备详情页展示，故此处直接跳过，避免污染 agents 表与频道成员关系。
        if (discovered.category !== 'agentos-hosted') {
          continue;
        }
        const adapterKind = normalizeAdapterKind(discovered.adapterKind) as AdapterKind;
        const identityKey = agentIdentityKey({
          teamId: discoveredInput.teamId,
          deviceId: discoveredInput.deviceId,
          adapterKind,
          name: discovered.name,
          category: discovered.category,
          gatewayInstanceKey: discovered.gatewayInstanceKey,
        });
        seenIdentityKeys.push(identityKey);

        const existing = await repositories.agents.getByIdentityKey(identityKey);
        const agent = await repositories.agents.upsert({
          id: existing?.id ?? ids.nextId(),
          primaryTeamId: discoveredInput.teamId,
          visibleTeamIds: [discoveredInput.teamId],
          name: discovered.name,
          adapterKind,
          category: discovered.category,
          source: 'scanned',
          status: 'online',
          deviceId: discoveredInput.deviceId,
          command: discovered.command ?? existing?.command,
          args: discovered.args ?? existing?.args,
          cwd: discovered.cwd ?? existing?.cwd,
          gatewayInstanceKey: discovered.gatewayInstanceKey ?? existing?.gatewayInstanceKey,
          projectDocumentInputSetVersions: discovered.projectDocumentInputSetVersions,
          // descriptor 扫描到的 description：仅当无既有手工 description 时使用（agent_md 不覆盖 manual）。
          // 组合 = frontmatter description + 抽取的 capabilities（与添加自定义 Agent 预填语义一致）。
          description: existing?.description
            ?? buildScannedAgentDescription(discovered.descriptor)
            ?? null,
          descriptionSource: existing?.description
            ? (existing.descriptionSource ?? 'manual')
            : discovered.descriptor?.description || (discovered.descriptor?.capabilities?.length ?? 0) > 0
              ? 'agent_md'
              : undefined,
          scannedCapabilities: discovered.descriptor?.capabilities,
          lastSeenAt: now,
        });
        await repositories.agents.linkIdentity({
          identityKey,
          agentId: agent.id,
          kind: discovered.gatewayInstanceKey ? 'agentos-gateway' : 'agentos-concrete',
          timestamp: now,
        });
        await ensureDefaultChannelMembership(repositories, clock, {
          teamId: discoveredInput.teamId,
          agentId: agent.id,
        });
        agents.push(toPublicAgent(agent));
        // 混合提取慢路径：机械提取为空 且 有全文 → 异步触发 LLM 总结
        // （fire-and-forget，不阻塞注册；模型不可用/失败静默跳过）。
        if (
          (discovered.descriptor?.capabilities?.length ?? 0) === 0
          && discovered.descriptor?.rawContent
          && discovered.descriptor.contentHash
        ) {
          void capabilitySummarizer.summarize({
            agentId: agent.id,
            rawContent: discovered.descriptor.rawContent,
            contentHash: discovered.descriptor.contentHash,
          }).catch((error) => {
            console.warn(`capability summarizer failed: ${agent.id} ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }

      const missingOfflineIds = await repositories.agents.markMissingScannedOffline({
        teamId: discoveredInput.teamId,
        deviceId: discoveredInput.deviceId,
        seenIdentityKeys,
        timestamp: now,
      });

      return makeSuccess({ agents, missingOfflineIds });
    },

    async listVisibleAgents(listInput) {
      const agents = await repositories.agents.listVisibleInTeam(listInput.teamId);
      return makeSuccess({ agents: await enrichAgentOwnerNames(repositories, agents) });
    },

    async createCustomAgent(agentInput) {
      const device = await repositories.devices.getById(agentInput.deviceId);
      if (!device || device.teamId !== agentInput.teamId) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(agentInput.teamId, agentInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (!(await canManageDeviceAsUser(repositories, { userId: agentInput.userId, device }))) {
        return makeFailure('FORBIDDEN', 'User cannot manage device');
      }
      // runtime 配置由设备拥有者授权（canManageDeviceAsUser 已在上方校验），不强制本机。
      // 旧「必须 isLocal」守卫会拒绝账号密码登录（无 deviceId）的拥有者，包括物理本机场景。
      if (device.status !== 'online') {
        return makeFailure('DEVICE_OFFLINE', 'Device is not online');
      }

      const runtime = agentInput.runtimeId
        ? await repositories.runtimes.getById(agentInput.runtimeId)
        : null;
      if (agentInput.runtimeId && (!runtime || runtime.deviceId !== device.id || runtime.teamId !== device.teamId)) {
        return makeFailure('NOT_FOUND', 'Runtime not found');
      }
      if (runtime && !runtime.installed) {
        return makeFailure('VALIDATION_ERROR', 'Runtime is not installed');
      }

      const adapterKind = normalizeAdapterKind(runtime?.adapterKind ?? agentInput.adapterKind ?? '');
      if (!adapterKind) {
        return makeFailure('VALIDATION_ERROR', 'adapterKind is required');
      }

      const now = clock.now();
      const agent = await repositories.agents.upsert({
        id: ids.nextId(),
        primaryTeamId: agentInput.teamId,
        visibleTeamIds: [agentInput.teamId],
        name: agentInput.name.trim(),
        description: agentInput.description?.trim(),
        adapterKind: adapterKind as AdapterKind,
        category: 'executor-hosted',
        source: 'custom',
        status: 'online',
        ownerId: agentInput.userId,
        deviceId: device.id,
        command: runtime?.command ?? agentInput.command,
        args: agentInput.args,
        cwd: runtime?.cwd ?? agentInput.cwd,
        envKeys: Object.keys(agentInput.env ?? {}).sort(),
        env: agentInput.env,
        projectDocumentInputSetVersions: agentInput.projectDocumentInputSetVersions,
        lastSeenAt: now,
      });
      await ensureDefaultChannelMembership(repositories, clock, { teamId: agentInput.teamId, agentId: agent.id });

      return makeSuccess({ agent: toPublicAgent(agent) });
    },

    async setAgentTeamVisibility(agentInput) {
      const managed = await agentForManagement(repositories, agentInput);
      if (!managed.ok) {
        return managed;
      }
      // 仅允许在 primary team 上切换可见性 —— 多团队发布已被 0009 迁移废弃。
      if (agentInput.teamId !== managed.agent.primaryTeamId) {
        return makeFailure('VALIDATION_ERROR', '只能在 primary team 上切换可见性');
      }
      const agent = await repositories.agents.setPrimaryTeamVisibility({
        agentId: managed.agent.id,
        visible: agentInput.visible,
        timestamp: clock.now(),
      });
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      if (agentInput.visible) {
        // 恢复可见：重新加入默认频道 #all。
        await ensureDefaultChannelMembership(repositories, clock, {
          teamId: agentInput.teamId,
          agentId: agent.id,
        });
      } else {
        // 隐藏：从该团队所有频道移除（含默认 #all）。
        await repositories.channels.removeAgentFromTeamChannels({
          teamId: agentInput.teamId,
          agentId: agent.id,
          timestamp: clock.now(),
        });
      }
      return makeSuccess({ agent: toPublicAgent(agent) });
    },

    async updateAgentConfig(agentInput) {
      const managed = await agentForConfigUpdate(repositories, agentInput);
      if (!managed.ok) {
        return managed;
      }
      const isCustom = managed.agent.source === 'custom';
      const isAgentOS = managed.agent.source === 'scanned' && managed.agent.category === 'agentos-hosted';
      if (!isCustom && !isAgentOS) {
        return makeFailure('VALIDATION_ERROR', 'Only custom or AgentOS agents can be configured');
      }

      const now = clock.now();
      const changes: AgentConfigUpdate = {};
      if (agentInput.name !== undefined) {
        changes.name = agentInput.name.trim();
      }
      if (agentInput.description !== undefined) {
        // 前端 AgentConfigDialog 在"功能介绍"为空时下发 description: null（表示清空），
        // repository 也以 null 表示清空；这里把 null/空串规整为 null，避免对 null 调 .trim()
        // 抛 TypeError（曾被 socket 兜底吞成 INTERNAL_ERROR）。
        changes.description = (agentInput.description ?? '').trim() || null;
      }

      if (isCustom) {
        // runtime 执行设置（adapterKind/command/args/cwd/env/runtimeId）由设备拥有者授权
        // （agentForConfigUpdate 已校验 canManageDeviceAsUser），不再强制本机。
        // 旧「必须 isLocal」守卫会拒绝账号密码登录（无 deviceId）的拥有者，含物理本机场景。
        if (agentInput.args !== undefined) {
          changes.args = agentInput.args;
        }
        if (agentInput.cwd !== undefined) {
          changes.cwd = agentInput.cwd;
        }
        if (agentInput.command !== undefined) {
          changes.command = agentInput.command;
        }
        if (agentInput.env !== undefined) {
          // Partial merge: non-empty values set/overwrite; empty string leaves an existing key
          // unchanged (web never re-reads secret values). Keys absent from the payload are kept.
          // To clear a key, clients must send a dedicated empty-after-existing full replace only
          // when they intentionally re-submit the full map (create-agent style still replaces via
          // createCustomAgent, not updateAgentConfig).
          const existingEnv = (await repositories.agents.getExecutionConfig(managed.agent.id))?.env ?? {};
          const merged: Record<string, string> = { ...existingEnv };
          for (const [key, value] of Object.entries(agentInput.env)) {
            if (value === '') {
              continue;
            }
            merged[key] = value;
          }
          changes.env = merged;
          changes.envKeys = Object.keys(merged).sort();
        }

        const runtime = agentInput.runtimeId
          ? await repositories.runtimes.getById(agentInput.runtimeId)
          : null;
        if (agentInput.runtimeId) {
          if (!runtime || runtime.teamId !== managed.agent.primaryTeamId) {
            return makeFailure('NOT_FOUND', 'Runtime not found');
          }
          const device = await repositories.devices.getById(runtime.deviceId);
          if (!device || device.teamId !== managed.agent.primaryTeamId) {
            return makeFailure('NOT_FOUND', 'Device not found');
          }
          if (!(await canManageDeviceAsUser(repositories, { userId: agentInput.userId, device }))) {
            return makeFailure('FORBIDDEN', 'User cannot manage target runtime device');
          }
          if (device.status !== 'online') {
            return makeFailure('DEVICE_OFFLINE', 'Device is not online');
          }
          if (!runtime.installed) {
            return makeFailure('VALIDATION_ERROR', 'Runtime is not installed');
          }
          changes.deviceId = runtime.deviceId;
          changes.adapterKind = runtime.adapterKind;
          changes.command = runtime.command;
          changes.cwd = runtime.cwd;
        } else if (agentInput.adapterKind !== undefined) {
          const adapterKind = normalizeAdapterKind(agentInput.adapterKind);
          if (!adapterKind) {
            return makeFailure('VALIDATION_ERROR', 'adapterKind is invalid');
          }
          changes.adapterKind = adapterKind as AdapterKind;
        }
      }

      // 历史 mention 迁移必须先于改名落库：若扫描/写入中途失败，重试同一次改名仍会继续迁移；
      // 反过来先改名会让重试失去 oldName，留下永久的半迁移状态。
      if (changes.name && managed.agent.name !== changes.name) {
        await migrateAgentMentionHistory(repositories, managed.agent);
      }

      const agent = await repositories.agents.updateConfig({
        agentId: managed.agent.id,
        changes: {
          ...changes,
          status: 'online',
          lastSeenAt: now,
        },
        timestamp: now,
      });
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      return makeSuccess({ agent: toPublicAgent(agent) });
    },

    async deleteAgent(agentInput) {
      const managed = await agentForManagement(repositories, agentInput);
      if (!managed.ok) {
        return managed;
      }
      if (managed.agent.source !== 'custom') {
        return makeFailure('VALIDATION_ERROR', 'Only custom agents can be deleted');
      }
      const now = clock.now();
      for (const teamId of managed.agent.visibleTeamIds) {
        await repositories.channels.removeAgentFromTeamChannels({
          teamId,
          agentId: managed.agent.id,
          timestamp: now,
        });
      }
      const agent = await repositories.agents.softDelete({ agentId: managed.agent.id, timestamp: now });
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      return makeSuccess({ agent: toPublicAgent(agent) });
    },

    async listChannels(listInput) {
      if (!(await repositories.teams.isMember(listInput.teamId, listInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      return makeSuccess({ channels: await repositories.channels.listForUser(listInput.teamId, listInput.userId) });
    },
    async getMemoryAttribution(input) {
      // #965 AC#4：定位 decision 并在读取时复验频道读权限，fail-closed 返回 null。
      if (!input.jobId && !input.messageId) {
        return makeFailure('BAD_REQUEST', 'jobId or messageId is required');
      }
      const decision = input.jobId
        ? await repositories.channelCoordination.decisions.getByJobId(input.jobId)
        : await repositories.channelCoordination.decisions.getByMessageId(input.messageId!);
      // 无 decision、或 teamId 不符（跨 Team 探测）→ 不泄露存在性，返回 null。
      if (!decision || decision.teamId !== input.teamId) {
        return makeSuccess({ attribution: null });
      }
      // 读取时复验：调用方必须是 decision 所在频道的可读成员（与 Active Memory 注入同一权限闸）。
      const channelReadable = await canReadMemoryScope(repositories, {
        teamId: decision.teamId,
        requesterUserId: input.userId,
        scopeType: 'channel',
        scopeRef: decision.channelId,
      });
      if (!channelReadable) {
        return makeSuccess({ attribution: null });
      }
      return makeSuccess({ attribution: decision.memoryAttribution });
    },

    async createChannel(channelInput) {
      if (!(await repositories.teams.isMember(channelInput.teamId, channelInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (!(await allHumanMembersBelongToTeam(repositories, channelInput.teamId, channelInput.humanMemberIds ?? []))) {
        return makeFailure('FORBIDDEN', 'Channel human member is not in team');
      }

      const now = clock.now();
      const channel = await repositories.channels.create({
        id: ids.nextId(),
        teamId: channelInput.teamId,
        kind: 'channel',
        name: channelInput.name.trim() || 'team',
        title: channelInput.title,
        visibility: channelInput.visibility,
        createdBy: channelInput.userId,
        createdAt: now,
        humanMemberIds: channelHumanMembersForCreate({
          visibility: channelInput.visibility,
          createdBy: channelInput.userId,
          humanMemberIds: channelInput.humanMemberIds,
        }),
        agentMemberIds: uniqueIds(channelInput.agentMemberIds ?? []),
      });

      return makeSuccess({ channel });
    },

    async updateChannel(channelInput) {
      if (!(await repositories.teams.isMember(channelInput.teamId, channelInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(channelInput.channelId);
      if (!channel || channel.teamId !== channelInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      const updateIntent = {
        ...(channelInput.name !== undefined ? { name: channelInput.name } : {}),
        ...(channelInput.title !== undefined ? { title: channelInput.title } : {}),
        ...(channelInput.visibility !== undefined ? { visibility: channelInput.visibility } : {}),
        ...(channelInput.humanMemberIds !== undefined ? { humanMemberIds: channelInput.humanMemberIds } : {}),
        ...(channelInput.agentMemberIds !== undefined ? { agentMemberIds: channelInput.agentMemberIds } : {}),
      };
      if (!canApplyChannelUpdate(channel, channelInput.userId, updateIntent, channel.archivedAt)) {
        return makeFailure('FORBIDDEN', channel.archivedAt != null ? 'Archived channels are read-only' : 'User cannot manage channel');
      }
      if (
        channelInput.humanMemberIds &&
        !(await allHumanMembersBelongToTeam(repositories, channelInput.teamId, channelInput.humanMemberIds))
      ) {
        return makeFailure('FORBIDDEN', 'Channel human member is not in team');
      }

      const visibility = channelInput.visibility ?? channel.visibility;
      const humanMemberIds = channelInput.humanMemberIds
        ? channelHumanMembersForCreate({
            visibility,
            createdBy: channel.createdBy ?? channelInput.userId,
            humanMemberIds: channelInput.humanMemberIds,
          })
        : undefined;
      const name = channelInput.name?.trim();
      const updated = await repositories.channels.update({
        channelId: channel.id,
        changes: {
          ...(name ? { name } : {}),
          ...(channelInput.title !== undefined ? { title: channelInput.title } : {}),
          ...(channelInput.visibility ? { visibility: channelInput.visibility } : {}),
          ...(humanMemberIds ? { humanMemberIds } : {}),
          ...(channelInput.agentMemberIds ? { agentMemberIds: uniqueIds(channelInput.agentMemberIds) } : {}),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }

      return makeSuccess({ channel: updated });
    },

    async addChannelHumanMember(memberInput) {
      const channel = await channelForCreatorManagement(repositories, memberInput);
      if (!channel.ok) {
        return channel;
      }
      if (!(await repositories.teams.isMember(memberInput.teamId, memberInput.memberUserId))) {
        return makeFailure('FORBIDDEN', 'Channel human member is not in team');
      }

      const updated = await repositories.channels.update({
        channelId: channel.channel.id,
        changes: {
          humanMemberIds: uniqueIds([...channel.channel.humanMemberIds, memberInput.memberUserId]),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      return makeSuccess({ channel: updated });
    },

    async removeChannelHumanMember(memberInput) {
      const channel = await channelForCreatorManagement(repositories, memberInput);
      if (!channel.ok) {
        return channel;
      }
      const nextHumanMemberIds = channel.channel.humanMemberIds.filter((memberId) => memberId !== memberInput.memberUserId);
      const updated = await repositories.channels.update({
        channelId: channel.channel.id,
        changes: {
          humanMemberIds: channelHumanMembersForCreate({
            visibility: channel.channel.visibility,
            createdBy: channel.channel.createdBy ?? memberInput.userId,
            humanMemberIds: nextHumanMemberIds,
          }),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      return makeSuccess({ channel: updated });
    },

    async leaveChannel(leaveInput) {
      if (!(await repositories.teams.isMember(leaveInput.teamId, leaveInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(leaveInput.channelId);
      if (!channel || channel.teamId !== leaveInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (!channel.humanMemberIds.includes(leaveInput.userId)) {
        return makeFailure('FORBIDDEN', 'User is not a channel member');
      }
      const updated = await repositories.channels.update({
        channelId: channel.id,
        changes: {
          humanMemberIds: channelHumanMembersForCreate({
            visibility: channel.visibility,
            createdBy: channel.createdBy ?? leaveInput.userId,
            humanMemberIds: channel.humanMemberIds.filter((memberId) => memberId !== leaveInput.userId),
          }),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      return makeSuccess({ channel: updated });
    },

    async addChannelAgentMember(memberInput) {
      const channel = await channelForCreatorManagement(repositories, memberInput);
      if (!channel.ok) {
        return channel;
      }
      const agent = await repositories.agents.getById(memberInput.agentId);
      if (!agent || !agent.visibleTeamIds.includes(memberInput.teamId)) {
        return makeFailure('FORBIDDEN', 'Channel agent member is not visible in team');
      }

      const updated = await repositories.channels.update({
        channelId: channel.channel.id,
        changes: {
          agentMemberIds: uniqueIds([...channel.channel.agentMemberIds, memberInput.agentId]),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      return makeSuccess({ channel: updated });
    },

    async removeChannelAgentMember(memberInput) {
      const channel = await channelForCreatorManagement(repositories, memberInput);
      if (!channel.ok) {
        return channel;
      }
      const teamId = channel.channel.teamId;
      const agentId = memberInput.agentId;
      const now = clock.now();
      // #946：channel 更新与 coordination 撤销同一 teamDb 事务——踢人即失效执行权（无越权窗口）。
      return repositories.taskCoordinationUnitOfWork.run(async (transaction) => {
        const txChannel = await transaction.channels.getById(channel.channel.id);
        if (!txChannel || txChannel.teamId !== teamId) {
          return makeFailure('NOT_FOUND', 'Channel not found');
        }
        if (!txChannel.agentMemberIds.includes(agentId)) {
          // 幂等：已非成员则不再持有权限，直接返回当前 channel。
          return makeSuccess({ channel: txChannel });
        }
        const updated = await transaction.channels.update({
          channelId: txChannel.id,
          changes: {
            agentMemberIds: txChannel.agentMemberIds.filter((id) => id !== agentId),
            updatedAt: now,
          },
        });
        if (!updated) {
          return makeFailure('NOT_FOUND', 'Channel not found');
        }
        await revokeAgentChannelMembershipAuthority(transaction.coordination, teamId, agentId, now);
        return makeSuccess({ channel: updated });
      });
    },

    async listChannelMembers(memberInput) {
      if (!(await repositories.teams.isMember(memberInput.teamId, memberInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(memberInput.channelId);
      if (!channel || channel.teamId !== memberInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (channel.visibility === 'private' && !channel.humanMemberIds.includes(memberInput.userId)) {
        return makeFailure('FORBIDDEN', 'User cannot view channel');
      }
      const agents: AgentDto[] = [];
      for (const agentId of channel.agentMemberIds) {
        const agent = await repositories.agents.getById(agentId);
        if (agent && agent.visibleTeamIds.includes(memberInput.teamId)) {
          agents.push(agent);
        }
      }
      return makeSuccess({
        humanMemberIds: channel.humanMemberIds,
        agentMemberIds: channel.agentMemberIds,
        humans: await repositories.teams.listMembersByIds(memberInput.teamId, channel.humanMemberIds),
        agents,
      });
    },

    async resolveChannelAgentDeviceIds(resolveInput) {
      // #1084 系统侧方法：无 userId 授权。fan-out 用，只解析频道 Agent 成员的 deviceId。
      const channel = await repositories.channels.getById(resolveInput.channelId);
      if (!channel || channel.teamId !== resolveInput.teamId) return [];
      const deviceIds: string[] = [];
      for (const agentId of channel.agentMemberIds) {
        const agent = await repositories.agents.getById(agentId);
        // 仅保留对该 Team 可见且已绑定本机 device 的 Agent（与 listChannelMembers 一致）。
        if (agent && agent.visibleTeamIds.includes(resolveInput.teamId) && agent.deviceId) {
          deviceIds.push(agent.deviceId);
        }
      }
      return deviceIds;
    },

    async archiveChannel(archiveInput) {
      if (!(await repositories.teams.isMember(archiveInput.teamId, archiveInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(archiveInput.channelId);
      if (!channel || channel.teamId !== archiveInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (isDefaultChannel(channel)) {
        return makeFailure('FORBIDDEN', 'Cannot archive default channel');
      }
      if (!canApplyChannelUpdate(channel, archiveInput.userId, {})) {
        return makeFailure('FORBIDDEN', 'Only channel creator can archive');
      }
      const now = clock.now();
      const channelRevision = channel.revision ?? 0;

      // ---- preflight：展示非终态工作并签发确认 token ----
      if (!archiveInput.confirmationToken) {
        const works = await collectArchiveWorks({
          tasks: repositories.tasks,
          dispatches: repositories.dispatches,
          management: repositories.management,
          coordination: repositories.taskCoordination,
          outputPackages: repositories.outputPackages,
          workspacePublishStagings: repositories.workspacePublishStagings,
          channelProjects: repositories.channelProjects,
        }, archiveInput.teamId, archiveInput.channelId);
        const preflight = evaluateArchivePreflight({
          channel: { id: channel.id, revision: channelRevision, archivedAt: channel.archivedAt ?? null },
          userId: archiveInput.userId,
          teamId: archiveInput.teamId,
          now,
          tokenExpiresInMs: ARCHIVE_CONFIRMATION_TTL_MS,
          sign: signArchiveToken,
          works,
        });
        if (preflight.kind === 'error') {
          return makeFailure('FORBIDDEN', 'Channel is already archived');
        }
        return makeSuccess({ preflight });
      }

      // ---- confirm：校验 token 后同一事务内原子归档 ----
      const confirmation = evaluateArchiveConfirmation({
        channel: { id: channel.id, revision: channelRevision, archivedAt: channel.archivedAt ?? null },
        userId: archiveInput.userId,
        teamId: archiveInput.teamId,
        now,
        token: archiveInput.confirmationToken,
        verifySignature: verifyArchiveToken,
        canArchive: canApplyChannelUpdate(channel, archiveInput.userId, {}),
      });
      if (confirmation.kind === 'error') {
        const errorMessages: Record<typeof confirmation.reason, string> = {
          invalid_token: 'Invalid confirmation token',
          token_expired: 'Confirmation token expired',
          channel_revision_changed: 'Channel was modified after preflight',
          already_archived: 'Channel is already archived',
          forbidden: 'Only channel creator can archive',
          user_mismatch: 'Confirmation token was issued for a different user',
          team_mismatch: 'Confirmation token was issued for a different team',
          channel_mismatch: 'Confirmation token was issued for a different channel',
        };
        return makeFailure('VALIDATION_ERROR', errorMessages[confirmation.reason]);
      }

      return repositories.taskCoordinationUnitOfWork.run(async (transaction) => {
        const txChannel = await transaction.channels.getById(archiveInput.channelId);
        if (!txChannel || txChannel.teamId !== archiveInput.teamId) {
          throw new Error('CHANNEL_NOT_FOUND');
        }
        if (txChannel.archivedAt != null) {
          throw new Error('ALREADY_ARCHIVED');
        }
        if ((txChannel.revision ?? 0) !== confirmation.payload.channelRevision) {
          throw new Error('CHANNEL_REVISION_CHANGED');
        }

        const works = await collectArchiveWorks(transaction, archiveInput.teamId, archiveInput.channelId);

        // 1. 取消非终态 Task（closed 为 Task 系统的终态/取消语义）
        for (const task of works.tasks) {
          const updated = await transaction.tasks.update({
            taskId: task.id,
            changes: { status: 'closed', updatedAt: now },
          });
          if (!updated) throw new Error(`TASK_CLOSE_FAILED:${task.id}`);
        }

        // 2. 撤销 active Claim/Lease
        for (const lease of works.leases) {
          const updated = await transaction.coordination.claimLeases.update({
            id: lease.id,
            expectedStatus: 'active',
            status: 'released',
            heartbeatAt: lease.heartbeatAt,
            expiresAt: lease.expiresAt,
            releasedAt: now,
          });
          if (!updated) throw new Error(`CLAIM_RELEASE_FAILED:${lease.id}`);
        }

        // 3. 失效 open Offer
        for (const offer of works.offers) {
          const updated = await transaction.coordination.offers.updateStatus({
            id: offer.id,
            expectedStatus: 'open',
            status: 'invalidated',
            response: null,
            now,
          });
          if (!updated) throw new Error(`OFFER_INVALIDATE_FAILED:${offer.id}`);
        }

        // 4. 取消非终态 Invocation/Dispatch
        const cancelledInvocationIds: ID[] = [];
        for (const dispatch of works.dispatches) {
          const updated = await transaction.dispatches.markCancelled({
            dispatchId: dispatch.id,
            completedAt: now,
          });
          if (!updated) throw new Error(`DISPATCH_CANCEL_FAILED:${dispatch.id}`);
          // 反向查找关联 invocation（若存在）用于返回值展示
          const attempts = await transaction.management.dispatchAttempts.list(dispatch.id);
          if (attempts.length > 0) {
            cancelledInvocationIds.push(attempts[0]!.invocationId);
          }
        }

        // 5. #1066 AC2：归档事务内把频道内未收敛（open/failed）publish staging
        //    显式收口为 terminal failed——Device 不能自行宣布已收口，状态迁移仅
        //    Server 事务内执行；不删行（审计事实保留）。
        const activeStagings = await transaction.workspacePublishStagings.listActiveByChannel({
          teamId: archiveInput.teamId,
          channelId: channel.id,
        });
        let cancelledStagingCount = 0;
        for (const staging of activeStagings) {
          if (staging.status === 'failed') continue;
          const closed = await transaction.workspacePublishStagings.update({
            ...staging,
            status: 'failed',
            updatedAt: now,
          });
          if (!closed) throw new Error(`STAGING_CANCEL_FAILED:${staging.publishId}`);
          cancelledStagingCount += 1;
        }

        // 6. 写 archivedAt
        const archived = await transaction.channels.archive({
          channelId: channel.id,
          timestamp: now,
        });
        if (!archived) throw new Error('CHANNEL_ARCHIVE_FAILED');

        // 7. #1066 AC12：归档审计记录（只写不删；confirmation 与后续查询共用同一事实）。
        const cancelledInvocationIdsDeduped = [...new Set(cancelledInvocationIds)];
        const archiveRecord: ChannelArchiveRecord = {
          id: ids.nextId(),
          teamId: archiveInput.teamId,
          channelId: channel.id,
          actorUserId: archiveInput.userId,
          authorityBasis: 'channel_creator',
          channelRevision: confirmation.payload.channelRevision,
          outcome: 'archived',
          cancelledTaskIds: works.tasks.map((task) => task.id),
          releasedClaimIds: works.leases.map((lease) => lease.id),
          invalidatedOfferIds: works.offers.map((offer) => offer.id),
          cancelledInvocationIds: cancelledInvocationIdsDeduped,
          pendingReviewTaskIds: works.pendingReviews.map((task) => task.id),
          pendingReviewDeliveryIds: works.pendingReviewDeliveries.map((delivery) => delivery.id),
          pendingDeliveryCount: works.pendingDeliveries.length,
          cancelledStagingCount,
          archivedAt: now,
        };
        await transaction.channelArchives.create(archiveRecord);

        return makeSuccess({
          confirmation: {
            channel: archived,
            cancelledTaskIds: archiveRecord.cancelledTaskIds,
            releasedClaimIds: archiveRecord.releasedClaimIds,
            invalidatedOfferIds: archiveRecord.invalidatedOfferIds,
            cancelledInvocationIds: archiveRecord.cancelledInvocationIds,
            pendingReviewTaskIds: archiveRecord.pendingReviewTaskIds,
            pendingReviewDeliveryIds: archiveRecord.pendingReviewDeliveryIds,
            cancelledStagingCount: archiveRecord.cancelledStagingCount,
          },
        });
      });
    },

    async deleteChannel(deleteInput) {
      if (!(await repositories.teams.isMember(deleteInput.teamId, deleteInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(deleteInput.channelId);
      if (!channel || channel.teamId !== deleteInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (isDefaultChannel(channel)) {
        return makeFailure('FORBIDDEN', 'Cannot delete default channel');
      }
      if (!canApplyChannelUpdate(channel, deleteInput.userId, {}, channel.archivedAt)) {
        return makeFailure('FORBIDDEN', channel.archivedAt != null ? 'Archived channels are read-only' : 'Only channel creator can delete');
      }
      const deletedMessages = await repositories.messages.listByChannel(channel.id, Number.MAX_SAFE_INTEGER);
      const deletedWorkspaceRunIds = (await repositories.workspaceRuns.listByTeam({
        teamId: deleteInput.teamId,
        limit: Number.MAX_SAFE_INTEGER,
      })).filter((run) => run.channelId === channel.id).map((run) => run.id);
      const channelDispatches = (await repositories.dispatches.listByTeam(deleteInput.teamId))
        .filter((dispatch) => dispatch.channelId === channel.id);
      const deletedInvocationIds = [...new Set((await Promise.all(channelDispatches.map((dispatch) =>
        repositories.management.dispatchAttempts.getByDispatchId(dispatch.id),
      ))).flatMap((attempt) => attempt ? [attempt.invocationId] : []))];
      // 先完成事实源级联，再触发 Memory 失效；跨 source kind 复查必须能看到 Channel 已不存在。
      await repositories.channelDocuments.deleteByChannel(channel.id);
      await repositories.projectChannelWorkspaces.deleteByChannel(channel.id);
      const deletedArtifactIds = await repositories.artifacts.deleteByChannel(channel.id);
      await repositories.messages.deleteByChannel(channel.id);
      const deleted = await repositories.channels.delete({ channelId: channel.id });
      if (!deleted) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      await invalidateSourcesAfterDeletion({
        teamId: deleteInput.teamId,
        sourceKind: 'message',
        sourceIds: deletedMessages.map((message) => message.id),
        actorId: deleteInput.userId,
      });
      for (const [sourceKind, sourceIds] of [
        ['artifact', deletedArtifactIds],
        ['workspace-run', deletedWorkspaceRunIds],
        ['invocation', deletedInvocationIds],
      ] as const) {
        await invalidateSourcesAfterDeletion({
          teamId: deleteInput.teamId, sourceKind, sourceIds, actorId: deleteInput.userId,
        });
      }
      return makeSuccess({ channel: deleted });
    },

    async startDirectMessage(dmInput) {
      if (!(await repositories.teams.isMember(dmInput.teamId, dmInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const agent = await repositories.agents.getById(dmInput.agentId);
      if (!agent || !agent.visibleTeamIds.includes(dmInput.teamId)) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }

      const existing = await repositories.channels.getDirectByAgent({
        teamId: dmInput.teamId,
        userId: dmInput.userId,
        agentId: dmInput.agentId,
      });
      if (existing) {
        return makeSuccess({ dm: toDmChannelDto(existing, agent) });
      }

      const now = clock.now();
      const channel = await repositories.channels.create({
        id: ids.nextId(),
        teamId: dmInput.teamId,
        kind: 'direct',
        name: `dm-${dmInput.userId}-${dmInput.agentId}`,
        title: agent.name,
        visibility: 'private',
        dmTargetAgentId: agent.id,
        createdBy: dmInput.userId,
        createdAt: now,
        humanMemberIds: [dmInput.userId],
        agentMemberIds: [agent.id],
      });

      return makeSuccess({ dm: toDmChannelDto(channel, agent) });
    },

    async listDirectMessages(dmInput) {
      if (!(await repositories.teams.isMember(dmInput.teamId, dmInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const visibleDms = await visibleDirectChannelsForUser(repositories, dmInput.teamId, dmInput.userId);
      const dms = visibleDms.map(({ channel, agent }) => toDmChannelDto(channel, agent));
      return makeSuccess({ dms });
    },

    async snapshotDirectMessage(dmInput) {
      if (!(await repositories.teams.isMember(dmInput.teamId, dmInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(dmInput.channelId);
      if (!channel || channel.teamId !== dmInput.teamId || channel.kind !== 'direct') {
        return makeFailure('NOT_FOUND', 'DM not found');
      }
      if (!channel.humanMemberIds.includes(dmInput.userId)) {
        return makeFailure('FORBIDDEN', 'User cannot view DM');
      }
      const agentId = channel.dmTargetAgentId ?? channel.agentMemberIds[0];
      const agent = agentId ? await repositories.agents.getById(agentId) : null;
      if (!agent || !agent.visibleTeamIds.includes(dmInput.teamId)) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      const messages = await repositories.messages.listByChannel(channel.id, normalizeLimit(dmInput.limit));
      return makeSuccess({
        dm: toDmChannelDto(channel, agent),
        messages: await enrichMessagesWithArtifacts(repositories, messages),
      });
    },

    async registerAgent(agentInput) {
      const agent = await repositories.agents.upsert(agentInput);
      for (const teamId of agent.visibleTeamIds) {
        await ensureDefaultChannelMembership(repositories, clock, { teamId, agentId: agent.id });
      }
      return makeSuccess({ agent: toPublicAgent(agent) });
    },

    dispatchMessageTracerCommand,
    dispatchSystemActivityCommand,
    dispatchSystemActivityQuery,
    dispatchTaskRemediationCommand,
    dispatchPiAuthorityCutoverCommand,
    dispatchPiAuthorityCutoverQuery,

    async sendMessage(messageInput) {
      if (messageIngestionMode === 'legacy') return sendLegacyMessage(messageInput);
      if (messageIngestionMode === 'message-tracer') return sendMessageViaMessageTracer(messageInput);
      if ((messageInput.selections?.length ?? 0) > 0
        && !projectCollaborationRollout.bundleSelection) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project document Selection is disabled');
      }
      if (!(await repositories.teams.isMember(messageInput.teamId, messageInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(messageInput.channelId);
      if (!channel || channel.teamId !== messageInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (channel.archivedAt != null) {
        return makeFailure('VALIDATION_ERROR', 'Archived channels do not accept new messages');
      }
      if (channel.visibility === 'private' && !channel.humanMemberIds.includes(messageInput.userId)) {
        return makeFailure('FORBIDDEN', 'User cannot view channel');
      }

      const now = clock.now();
      const visibleAgents = await repositories.agents.listVisibleInTeam(messageInput.teamId);
      const mentions = sanitizeMessageMentions({
        body: messageInput.body,
        mentions: messageInput.meta?.mentions,
        channel,
        visibleAgents,
      });
      const attachmentResult = await getAttachableUploadedArtifacts(repositories, {
        userId: messageInput.userId,
        teamId: messageInput.teamId,
        channelId: messageInput.channelId,
        artifactIds: messageInput.artifactIds ?? [],
      });
      if (!attachmentResult.ok) {
        return attachmentResult;
      }
      const attachedArtifactIds = attachmentResult.artifacts.map((artifact) => artifact.id);
      const referenceFingerprint = projectReferenceRequestFingerprint(messageInput);

      const clientIdempotencyKey = messageInput.clientMessageId
        ? `client:${messageInput.teamId}:${messageInput.clientMessageId}`
        : null;
      const outcome = await repositories.piProviderUnitOfWork.run(async (piRepositories) => {
        const active = await piRepositories.activeModel.get();
        const revision = active ? await piRepositories.revisions.getById(active.revisionId) : null;
        // #699 US 84：紧急停止时模型视为 unavailable，阻止新 Job 调度。
        const emergencyStopped = getEmergencyStopActive();
        const activeModel = !emergencyStopped && active && revision?.status === 'published' && revision.cardId === active.cardId
          ? {
              availability: 'available' as const,
              cardId: active.cardId,
              revisionId: active.revisionId,
              modelId: revision.config.modelId,
            }
          : { availability: 'unavailable' as const };

        // Keep the Active Model UoW open until the Team transaction commits. A model switch
        // uses the same UoW and therefore cannot race between snapshot and message creation.
        return repositories.channelCoordinationUnitOfWork.run(async (transaction) => {
          const existingByMessageId = messageInput.messageId
            ? await transaction.jobs.getByMessageId(messageInput.messageId)
            : null;
          const existingByClientKey = clientIdempotencyKey
            ? await transaction.jobs.getByIdempotencyKey(clientIdempotencyKey)
            : null;
          if (existingByMessageId && existingByClientKey && existingByMessageId.id !== existingByClientKey.id) {
            return { kind: 'conflict' as const };
          }
          const existingJob = existingByMessageId ?? existingByClientKey;
          if (existingJob) {
            const existingMessage = await transaction.messages.getById(existingJob.messageId);
            if (!existingMessage) throw new Error('Coordination job references a missing message');
            const sameRequest = existingMessage.teamId === messageInput.teamId
              && existingMessage.channelId === messageInput.channelId
              && existingMessage.senderId === messageInput.userId
              && existingMessage.body === messageInput.body
              && existingMessage.meta?.projectReferenceRequestFingerprint === referenceFingerprint
              && (!messageInput.threadId || existingMessage.threadId === messageInput.threadId);
            if (!sameRequest) return { kind: 'conflict' as const };
            const replayArtifacts = await transaction.artifacts.listByMessage(existingMessage.id);
            const replayReferenceSet = await transaction.projectReferenceSets.getByMessageId({
              teamId: existingMessage.teamId,
              channelId: existingMessage.channelId,
              messageId: existingMessage.id,
            });
            return {
              kind: 'replay' as const,
              message: existingMessage,
              artifacts: replayArtifacts,
              referenceSet: replayReferenceSet ? toProjectReferenceSetDto(replayReferenceSet) : undefined,
            };
          }

          const frozen = await resolveAndFreezeSelections(repositories, {
            userId: messageInput.userId,
            teamId: messageInput.teamId,
            channelId: messageInput.channelId,
            channel,
            selections: messageInput.selections ?? [],
          });
          if (!frozen.ok) return { kind: 'rejected' as const, failure: frozen };
          // #1064 AC3：task-linked @Agent 请求复验——既有 task 讨论串回复 + @Agent + 项目引用。
          // 复验失败 → 拒绝整条消息（消息未创建，客户端保留草稿与引用，#1059 §11）；
          // 通过 → 记录上下文，消息提交后发布 Offer（AC4）。
          let taskLinked: {
            context: TaskLinkedRequestContext;
            evaluation: Extract<TaskLinkedRequestEvaluation, { kind: 'ready' }>;
          } | null = null;
          // 只对显式 @Agent 触发 task-linked；纯 @人类 提及回到既有 dispatch 路径（AC9）。
          const agentMentions = mentions.filter((mention) => mention.kind === 'agent');
          if (messageInput.threadId
            && agentMentions.length > 0
            && (messageInput.selections?.length ?? 0) > 0
            && frozen.selections.length > 0) {
            const linkedRoot = await repositories.messages.getById(messageInput.threadId);
            const linkedTaskId = typeof linkedRoot?.meta?.taskId === 'string'
              ? linkedRoot.meta.taskId
              : undefined;
            if (linkedTaskId) {
              const linkedTask = await repositories.tasks.getById(linkedTaskId);
              if (linkedTask && linkedTask.teamId === messageInput.teamId) {
                const linkedCoordination = await repositories.taskCoordination.coordinations
                  .getByTaskId(linkedTaskId);
                const linkedContext: TaskLinkedRequestContext = {
                  teamId: messageInput.teamId,
                  channelId: messageInput.channelId,
                  senderUserId: messageInput.userId,
                  channelArchived: channel.archivedAt != null,
                  task: linkedTask,
                  coordination: linkedCoordination,
                  // revision/attempt fence（AC3）：本复验在消息提交事务内执行，读取即
                  // 提交点快照（无并发漂移窗口）；事务外的漂移由 Offer 冻结的
                  // taskRevision/attempt 在 acceptance 时二次比对兜底（TASK_CLAIM_OFFER_STALE）。
                  expectedTaskRevision: linkedTask.revision,
                  ...(linkedCoordination ? { expectedTaskAttempt: linkedCoordination.attempt } : {}),
                  requestedAgentIds: agentMentions.map((mention) => mention.id),
                  previews: frozen.selections,
                  selectionRequests: messageInput.selections ?? [],
                  sourceMessageId: messageInput.threadId,
                };
                const evaluation = await evaluateTaskLinkedRequestContext(
                  taskLinkedHandlerDeps,
                  linkedContext,
                );
                if (evaluation.kind === 'rejected') {
                  return { kind: 'rejected' as const, failure: taskLinkedRequestFailure(evaluation) };
                }
                if (evaluation.kind === 'ready') {
                  taskLinked = { context: linkedContext, evaluation };
                }
              }
            }
          }
          const messageId = messageInput.messageId ?? ids.nextId();
          const message = await transaction.messages.append({
            id: messageId,
            teamId: messageInput.teamId,
            channelId: messageInput.channelId,
            threadId: messageInput.threadId ?? messageId,
            senderKind: 'human',
            senderId: messageInput.userId,
            body: messageInput.body,
            createdAt: now,
            meta: {
              ...(messageInput.clientMessageId ? { clientMessageId: messageInput.clientMessageId } : {}),
              ...(attachedArtifactIds.length > 0 ? { artifactIds: attachedArtifactIds } : {}),
              ...(messageInput.asTask === true ? { asTask: true } : {}),
              ...(mentions.length ? { mentions } : {}),
              projectReferenceRequestFingerprint: referenceFingerprint,
            },
          });
          const referenceSet = frozen.selections.length > 0
            ? await persistFrozenProjectReferences(transaction.projectReferenceSets, {
              ids,
              message,
              createdBy: messageInput.userId,
              previews: frozen.selections,
              idempotencyKey: messageInput.clientMessageId ?? message.id,
              requestFingerprint: referenceFingerprint,
              createdAt: now,
            })
            : undefined;
          const attachedArtifacts: ArtifactRecord[] = [];
          for (const artifact of attachmentResult.artifacts) {
            attachedArtifacts.push(await transaction.artifacts.create({ ...artifact, messageId }));
          }
          // #930：cutover 后 Message 仍提交，但不得新建 legacy coordination job（无 dual-write）。
          const legacyFenced = await lookupLegacyCoordinationWriteFenced(
            repositories.teamPiAuthorityMigrations,
            messageInput.teamId,
          );
          if (!legacyFenced) {
            await transaction.jobs.create({
              id: ids.nextId(),
              teamId: messageInput.teamId,
              channelId: messageInput.channelId,
              messageId,
              idempotencyKey: clientIdempotencyKey ?? `message:${messageInput.teamId}:${messageId}`,
              status: 'pending',
              attempt: 0,
              nextRetryAt: null,
              activeModel,
              createdAt: now,
              updatedAt: now,
            });
          }
          return {
            kind: 'saved' as const,
            message,
            artifacts: attachedArtifacts,
            referenceSet,
            legacyCoordinationFenced: legacyFenced,
            // #1064：task-linked 复验通过后，消息提交成功路径据此发布 Offer（事务外）。
            taskLinked,
          };
        });
      }).catch((error: unknown) => {
        if (error instanceof ProjectReferenceCommitConflictError) {
          return { kind: 'reference_commit_conflict' as const };
        }
        throw error;
      });

      if (outcome.kind === 'conflict') {
        return makeFailure('CONFLICT', 'Client message id was already used for a different message');
      }
      if (outcome.kind === 'reference_commit_conflict') {
        return makeFailure(
          'VALIDATION_ERROR',
          'Project references changed before the message could be committed; refresh and retry',
          { reason: 'selections_rejected' },
        );
      }
      if (outcome.kind === 'rejected') return outcome.failure;

      if (channelFileRollout.markdownEditing) {
        await createInitialChannelDocuments(repositories, outcome.artifacts, messageInput.userId, now);
      }

      // #1064 AC4：task-linked 复验通过后，在消息提交成功后发布 targeted Offer（事务外，
      // 与既有 dispatch 创建同款模式）。Offer 冻结输入但不建立 claim/Invocation。
      if (outcome.kind === 'saved' && outcome.taskLinked) {
        await publishTaskLinkedOffers(
          taskLinkedHandlerDeps,
          outcome.taskLinked.context,
          outcome.taskLinked.evaluation,
        );
      }

      // Replay: return already-created dispatches/tasks without re-executing side effects.
      if (outcome.kind === 'replay') {
        const contextOwner = messageInput.threadId
          ? await resolveRoutingContextAgentId(repositories, {
              teamId: messageInput.teamId,
              channel,
              threadId: messageInput.threadId,
            })
          : undefined;
        const route = routeMessageForChannel({
          channel,
          visibleAgents,
          teamId: messageInput.teamId,
          body: messageInput.body,
          mentions,
          contextOwner,
          connectedAgentDeviceIds: messageInput.connectedAgentDeviceIds,
          dispatchClaimDeviceIds: messageInput.dispatchClaimDeviceIds,
        });
        const message = outcome.artifacts.length > 0
          ? {
            ...outcome.message,
            artifacts: outcome.artifacts.map(toArtifactDto),
            ...(outcome.referenceSet ? { referenceSet: outcome.referenceSet } : {}),
          }
          : {
            ...outcome.message,
            ...(outcome.referenceSet ? { referenceSet: outcome.referenceSet } : {}),
          };
        const existingDispatches = (await repositories.dispatches.listByMessage(outcome.message.id))
          .map(toDispatchDto);
        const existingTaskId = typeof outcome.message.meta?.taskId === 'string'
          ? outcome.message.meta.taskId
          : undefined;
        const existingTask = existingTaskId
          ? await repositories.tasks.getById(existingTaskId)
          : null;
        return makeSuccess({
          message,
          dispatches: existingDispatches,
          route,
          // Do not re-create management runs on idempotent replay.
          management: { kind: 'direct' as const, mode: 'direct' as const },
          ...(existingTask ? { task: existingTask } : {}),
          ...(outcome.referenceSet ? { referenceSet: outcome.referenceSet } : {}),
        });
      }

      // Immediate execution bridge (until Coordinator owns full dispatch lifecycle):
      // hard-constrained paths (@mention / DM / thread owner) and asTask management still
      // run synchronously. Unmentioned root messages stay job-only (ADR 0061).
      const contextOwner = messageInput.threadId
        ? await resolveRoutingContextAgentId(repositories, {
            teamId: messageInput.teamId,
            channel,
            threadId: messageInput.threadId,
          })
        : undefined;
      const route = routeMessageForChannel({
        channel,
        visibleAgents,
        teamId: messageInput.teamId,
        body: messageInput.body,
        mentions,
        contextOwner,
        connectedAgentDeviceIds: messageInput.connectedAgentDeviceIds,
        dispatchClaimDeviceIds: messageInput.dispatchClaimDeviceIds,
      });
      const shouldCreateTask = messageInput.asTask === true || shouldAutoCreateTaskThread({
        body: messageInput.body,
        route,
        threadId: messageInput.threadId,
      });
      let taskId = shouldCreateTask ? ids.nextId() : undefined;
      if (messageInput.clientMessageId) {
        const reservation = await repositories.management.reservations.getByRequestKey({
          teamId: messageInput.teamId,
          requestKey: `${messageInput.teamId}:${messageInput.userId}:${messageInput.clientMessageId.trim()}`,
        });
        const reservedRun = reservation
          ? await repositories.management.runs.getById(reservation.managementRunId)
          : null;
        if (reservedRun
          && reservedRun.teamId === messageInput.teamId
          && reservedRun.channelId === messageInput.channelId
          && shouldCreateTask
          && reservedRun.rootTaskId) {
          taskId = reservedRun.rootTaskId;
        }
      }
      let management: ManagementRoutingResult = await managementRouter.route({
        userId: messageInput.userId,
        teamId: messageInput.teamId,
        channelId: messageInput.channelId,
        rootMessageId: outcome.message.id,
        ...(taskId ? { rootTaskId: taskId } : {}),
        ...(messageInput.clientMessageId ? { clientMessageId: messageInput.clientMessageId } : {}),
        body: messageInput.body,
        ...(route.kind === 'dispatch' ? { targetAgentId: route.agentId } : {}),
      });
      if (management.kind === 'unavailable') {
        return makeFailure('VALIDATION_ERROR', management.diagnostics.join(','));
      }
      const coordinatedManagedRoot = management.kind === 'managed' && management.managementPhase >= 2;
      let task: TaskRecord | null = null;
      if (shouldCreateTask && taskId) {
        task = await repositories.tasks.create({
          id: taskId,
          teamId: messageInput.teamId,
          title: messageInput.body.trim() || '附件',
          description: undefined,
          status: route.kind === 'dispatch' || coordinatedManagedRoot ? 'in_progress' : 'todo',
          creatorId: messageInput.userId,
          assigneeId: route.kind === 'dispatch' && !coordinatedManagedRoot ? route.agentId : undefined,
          channelId: messageInput.channelId,
          tags: [],
          sortOrder: now,
          createdAt: now,
          updatedAt: now,
        });
        await repositories.messages.setTaskIdIfAbsent({ messageId: outcome.message.id, taskId: task.id });
      }
      if (task && management.kind === 'managed' && management.managementPhase >= 2) {
        await taskCoordinationKernel.bootstrapRootCoordination({
          managementRunId: management.managementRunId,
          taskId: task.id,
          idempotencyKey: `bootstrap-root:${task.id}`,
          acceptanceCriteria: [{
            id: `root-completion:${task.id}`,
            description: '根任务目标已完成并可供用户审核',
            evidenceRequired: false,
          }],
          maxAttempts: 1,
        });
      }

      const dispatches: DispatchDto[] = [];
      let acknowledgementMessage: MessageDto | undefined;
      // #1064 AC4/AC9：task-linked 复验通过的请求已发布 targeted Offer（唯一 authority 路径），
      // 不再走 direct dispatch，避免同一请求双重投递。
      const taskLinkedOffered = outcome.kind === 'saved' && outcome.taskLinked != null;
      if (route.kind === 'dispatch' && management.kind !== 'managed' && !taskLinkedOffered) {
        const dispatch = await repositories.dispatches.create({
          id: ids.nextId(),
          teamId: messageInput.teamId,
          channelId: messageInput.channelId,
          messageId: outcome.message.id,
          agentId: route.agentId,
          status: 'queued',
          requestId: ids.nextId(),
          prompt: messageInput.body,
          createdAt: now,
          updatedAt: now,
        });
        dispatches.push(toDispatchDto(dispatch));
        await repositories.agents.updateStatus({ agentId: dispatch.agentId, status: 'busy', lastSeenAt: now });
        if (task) {
          acknowledgementMessage = await appendTaskClaimAcknowledgementMessage(repositories, {
            id: ids.nextId(),
            message: outcome.message,
            task,
            dispatch: toDispatchDto(dispatch),
            createdAt: now,
          });
        }
      }
      if (management.kind === 'managed') {
        management = await managementRouter.scheduleManaged(management);
      }
      if (management.mode === 'shadow' && management.shadowRequestKey) {
        void managementRouter.recordShadowDecision({
          shadowRequestKey: management.shadowRequestKey,
          body: messageInput.body,
          ...(route.kind === 'dispatch' ? { targetAgentId: route.agentId } : {}),
        }).catch(() => undefined);
      }

      const routeReason = toRouteReason(route);
      const messageWithMeta = {
        ...outcome.message,
        meta: {
          ...outcome.message.meta,
          ...(task ? { taskId: task.id } : {}),
          ...(routeReason ? { routeReason } : {}),
        },
      };
      const message = outcome.artifacts.length > 0
        ? {
          ...messageWithMeta,
          artifacts: outcome.artifacts.map(toArtifactDto),
          ...(outcome.referenceSet ? { referenceSet: outcome.referenceSet } : {}),
        }
        : {
          ...messageWithMeta,
          ...(outcome.referenceSet ? { referenceSet: outcome.referenceSet } : {}),
        };
      if (message.id) { void bindMessageEpochBestEffort(message.teamId, message.id, messageInput.clientMessageId ?? null); }
      return makeSuccess({
        message,
        dispatches,
        route,
        ...(task ? { task } : {}),
        ...(acknowledgementMessage ? { acknowledgementMessage } : {}),
        management,
        ...(outcome.referenceSet ? { referenceSet: outcome.referenceSet } : {}),
      });
    },

    async getDispatchRequest(requestInput) {
      const dispatch = await repositories.dispatches.getById(requestInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      const agent = await repositories.agents.getById(dispatch.agentId);
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      return makeSuccess({
        request: await buildDispatchRequest(
          repositories,
          dispatch,
          agent,
          clock.now(),
          requestInput.purpose !== 'route',
          input.serverCapsuleRuntimeContextResolver,
          projectCollaborationRollout.inputSetOutput,
        ),
      });
    },

    async acceptDispatch(acceptInput) {
      const dispatch = await repositories.dispatches.getById(acceptInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (dispatch.agentId !== acceptInput.agentId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to agent');
      }
      if (dispatch.status !== 'queued' && dispatch.status !== 'sent') {
        return makeFailure('CONFLICT', 'Dispatch cannot be accepted');
      }
      const agent = await repositories.agents.getById(dispatch.agentId);
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      if (acceptInput.deviceId && agent.deviceId !== acceptInput.deviceId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to device');
      }
      const now = clock.now();
      const readyAt = dispatch.updatedAt + Math.max(0, acceptInput.quietWindowMs);
      if (now < readyAt) {
        return makeSuccess({ ready: false, retryAfterMs: readyAt - now });
      }

      let request: DispatchRequestDto & { id: string };
      try {
        request = await buildDispatchRequest(
          repositories, dispatch, agent, now, true, input.serverCapsuleRuntimeContextResolver,
          projectCollaborationRollout.inputSetOutput,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordProjectInputSetRuntimeFailure(message);
        if (!message.startsWith('PROJECT_DOCUMENT_INPUT_SET_')) throw error;
        await repositories.dispatches.markFailed({
          dispatchId: dispatch.id,
          error: message,
          completedAt: now,
        });
        return makeFailure('CONFLICT', message);
      }
      const accepted = await repositories.dispatches.markAccepted({
        dispatchId: dispatch.id,
        agentId: agent.id,
        expectedUpdatedAt: dispatch.updatedAt,
        prompt: request.prompt,
        acceptedAt: now,
      });
      if (!accepted) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (!accepted.changed) {
        const retryAfterMs = Math.max(1, accepted.dispatch.updatedAt + Math.max(0, acceptInput.quietWindowMs) - now);
        return makeSuccess({ ready: false, retryAfterMs });
      }
      await collaborationService.recordAccepted({ dispatchId: accepted.dispatch.id });
      return makeSuccess({
        ready: true,
        dispatch: toDispatchDto(accepted.dispatch),
        request,
      });
    },

    async listChannelMessages(listInput) {
      const messages = await repositories.messages.listByChannel(listInput.channelId, listInput.limit);
      return makeSuccess({
        messages: await enrichMessagesWithArtifacts(repositories, messages),
      });
    },

    async listChannelFiles(fileInput) {
      return listPublicChannelFiles(repositories, fileInput, resolveArtifactPreview, { channelFileRollout, channelFileMetrics });
    },

    async searchChannelFiles(fileInput) {
      return listPublicChannelFiles(repositories, fileInput, resolveArtifactPreview, { channelFileRollout, channelFileMetrics });
    },

    async createProjectChannelWorkspace(workspaceInput) {
      const access = await ensureUserCanViewProjectWorkspace(repositories, workspaceInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      if (workspaceInput.files.length === 0) return makeFailure('VALIDATION_ERROR', 'Workspace revision must contain files');
      const paths = new Set<string>();
      const files: ProjectChannelWorkspaceFileDto[] = [];
      for (const file of workspaceInput.files) {
        const path = normalizeWorkspacePath(file.path);
        if (!path || paths.has(path)) return makeFailure('VALIDATION_ERROR', 'Workspace paths must be unique and relative');
        const artifact = await repositories.artifacts.getForTeam({ teamId: workspaceInput.teamId, artifactId: file.artifactId });
        if (!artifact || artifact.channelId !== workspaceInput.channelId) return makeFailure('NOT_FOUND', 'Workspace artifact not found');
        const artifactVersion = await repositories.channelProjects.getArtifactVersionByArtifact({ teamId: workspaceInput.teamId, channelId: workspaceInput.channelId, artifactId: artifact.id });
        paths.add(path);
        files.push({ path, artifactId: artifact.id, ...(artifactVersion ? { artifactVersionId: artifactVersion.id, collectionId: artifactVersion.collectionId } : {}), filename: artifact.filename, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}) });
      }
      const now = clock.now();
      const revision: ProjectChannelWorkspaceRevisionRecord = { id: ids.nextId(), teamId: workspaceInput.teamId, channelId: workspaceInput.channelId, revision: 1, files, createdBy: workspaceInput.userId, createdAt: now };
      const workspace: ProjectChannelWorkspaceRecord = { id: ids.nextId(), teamId: workspaceInput.teamId, channelId: workspaceInput.channelId, currentRevisionId: revision.id, currentRevision: revision };
      const created = await repositories.projectChannelWorkspaces.createInitial({ workspace, revision });
      if (!created) return makeFailure('CONFLICT', 'Project Channel Workspace already exists');
      return makeSuccess({ workspace: created });
    },

    async getProjectChannelWorkspace(workspaceInput) {
      const access = await ensureUserCanViewProjectWorkspace(repositories, workspaceInput);
      if (!access.ok) return access;
      const workspace = await repositories.projectChannelWorkspaces.getForTeam(workspaceInput);
      if (!workspace) return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
      return resolveProjectChannelWorkspaceRevision(repositories, workspace, workspaceInput.revisionId);
    },

    // #969 AC#4：归档导出——频道治理者（创建者）只读装配封存清单。不恢复频道、不扩权、零状态变更。
    async exportProjectChannelWorkspace(exportInput) {
      const access = await ensureUserCanViewProjectWorkspace(repositories, exportInput);
      if (!access.ok) return access;
      const channel = access.channel;
      // 治理授权：与 archiveChannel 同一判断（不传 archivedAt → 归档与否均可导出，导出不依赖归档状态）。
      if (!canApplyChannelUpdate(channel, exportInput.userId, {})) {
        return makeFailure('FORBIDDEN', 'Only channel governors can export the workspace archive');
      }
      const workspace = await repositories.projectChannelWorkspaces.getForTeam(exportInput);
      if (!workspace) return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
      // 只读装配：频道 artifact 由 domain 过滤 role=deliverable；revision 含 import provenance。
      const artifacts = await repositories.artifacts.listByChannel({ teamId: exportInput.teamId, channelId: exportInput.channelId });
      const manifest = assembleArchiveExportManifest({
        teamId: exportInput.teamId,
        channelId: exportInput.channelId,
        exportedByUserId: exportInput.userId,
        now: clock.now(),
        revision: workspace.currentRevision,
        artifacts,
      });
      return makeSuccess({ manifest });
    },

    // #969 AC#2：列出 workspace 全部 revision（repo 已按 revision 倒序，最新在前 = 默认最后成果）。
    async listProjectChannelWorkspaceRevisions(listInput) {
      const access = await ensureUserCanViewProjectWorkspace(repositories, listInput);
      if (!access.ok) return access;
      const revisions = await repositories.projectChannelWorkspaces.listRevisions(listInput);
      return makeSuccess({ revisions });
    },

    async importProjectChannelWorkspace(importInput) {
      const actor = await resolveDeviceTokenActor(repositories, sessionSecret, importInput);
      if (!actor.ok) return actor;
      const credentials = verifyDeviceToken(importInput.token, sessionSecret);
      const sourceDeviceId = credentials?.deviceId ?? 'unknown';
      const access = await ensureUserCanViewProjectWorkspace(repositories, {
        userId: actor.userId,
        teamId: importInput.teamId,
        channelId: importInput.channelId,
      });
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const validated = validateWorkspaceImportFiles(importInput.files);
      if (!validated.ok) {
        return makeFailure('VALIDATION_ERROR',
          validated.error === 'EMPTY_FILES' ? 'Workspace import must contain files'
          : validated.error === 'INVALID_PATH' ? 'Workspace paths must be unique and relative'
          : 'Duplicate workspace path');
      }
      const files: ProjectChannelWorkspaceFileDto[] = [];
      for (const { path, artifactId } of validated.value.files) {
        const artifact = await repositories.artifacts.getForTeam({ teamId: importInput.teamId, artifactId });
        if (!artifact || artifact.channelId !== importInput.channelId) {
          return makeFailure('NOT_FOUND', 'Workspace artifact not found');
        }
        const artifactVersion = await repositories.channelProjects.getArtifactVersionByArtifact({ teamId: importInput.teamId, channelId: importInput.channelId, artifactId: artifact.id });
        files.push({
          path, artifactId: artifact.id,
          ...(artifactVersion ? { artifactVersionId: artifactVersion.id, collectionId: artifactVersion.collectionId } : {}),
          filename: artifact.filename, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes,
          ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
        });
      }
      const now = clock.now();
      const revision: ProjectChannelWorkspaceRevisionRecord = {
        id: ids.nextId(), teamId: importInput.teamId, channelId: importInput.channelId,
        revision: 1, files, createdBy: actor.userId, createdAt: now,
        provenance: { kind: 'import', sourceDeviceId, importedAt: now },
      };
      const workspace: ProjectChannelWorkspaceRecord = {
        id: ids.nextId(), teamId: importInput.teamId, channelId: importInput.channelId,
        currentRevisionId: revision.id, currentRevision: revision,
      };
      const created = await repositories.projectChannelWorkspaces.createInitial({ workspace, revision });
      if (!created) return makeFailure('CONFLICT', 'Project Channel Workspace already exists');
      return makeSuccess({ workspace: created });
    },

    async publishProjectChannelWorkspace(publishInput) {
      const access = await ensureUserCanViewProjectWorkspace(repositories, publishInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const validated = validateWorkspaceImportFiles(publishInput.files);
      if (!validated.ok) {
        return makeFailure('VALIDATION_ERROR',
          validated.error === 'EMPTY_FILES' ? 'Workspace publish must contain files'
          : validated.error === 'INVALID_PATH' ? 'Workspace paths must be unique and relative'
          : 'Duplicate workspace path');
      }
      const files: ProjectChannelWorkspaceFileDto[] = [];
      for (const { path, artifactId } of validated.value.files) {
        const artifact = await repositories.artifacts.getForTeam({ teamId: publishInput.teamId, artifactId });
        if (!artifact || artifact.channelId !== publishInput.channelId) {
          return makeFailure('NOT_FOUND', 'Workspace artifact not found');
        }
        const artifactVersion = await repositories.channelProjects.getArtifactVersionByArtifact({ teamId: publishInput.teamId, channelId: publishInput.channelId, artifactId: artifact.id });
        files.push({
          path, artifactId: artifact.id,
          ...(artifactVersion ? { artifactVersionId: artifactVersion.id, collectionId: artifactVersion.collectionId } : {}),
          filename: artifact.filename, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes,
          ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
        });
      }
      const current = await repositories.projectChannelWorkspaces.getForTeam(publishInput);
      if (!current) return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
      // 域规则预判：overflow 直接拒（empty 已由 validateWorkspaceImportFiles 兜底）。
      const toEntries = (list: ProjectChannelWorkspaceFileDto[]) => list.map((f) => ({ path: f.path, artifactId: f.artifactId }));
      const preDecision = evaluateWorkspacePublish({
        current: { revisionId: current.currentRevision.id, revision: current.currentRevision.revision, files: toEntries(current.currentRevision.files) },
        baselineRevisionId: publishInput.baselineRevisionId,
        files: validated.value.files,
      });
      if (preDecision.kind === 'rejected') {
        return makeFailure('VALIDATION_ERROR', preDecision.reason === 'revision-overflow' ? 'Workspace revision overflow' : 'Workspace publish must contain files');
      }
      const now = clock.now();
      // repo 在事务内做 CAS 终判（消除 read→commit 竞态）：基线匹配才整体写下一 revision。
      const outcome = await repositories.projectChannelWorkspaces.publishRevision({
        teamId: publishInput.teamId,
        channelId: publishInput.channelId,
        baselineRevisionId: publishInput.baselineRevisionId,
        newRevision: {
          id: ids.nextId(), files, createdBy: publishInput.userId, createdAt: now,
          ...(publishInput.provenance ? { provenance: { kind: 'publish', agentId: publishInput.provenance.agentId, taskId: publishInput.provenance.taskId, taskAttempt: publishInput.provenance.taskAttempt, baselineRevisionId: publishInput.baselineRevisionId, publishedAt: now } } : {}),
        },
      });
      if (outcome.kind === 'published') return makeSuccess({ workspace: outcome.workspace });
      // conflict：基线在 read→commit 间被并发发布。用域规则据权威 current 算冲突路径范围（AC#3）。
      const conflictDecision = evaluateWorkspacePublish({
        current: { revisionId: outcome.current.currentRevision.id, revision: outcome.current.currentRevision.revision, files: toEntries(outcome.current.currentRevision.files) },
        baselineRevisionId: publishInput.baselineRevisionId,
        files: validated.value.files,
      });
      const conflictingPaths = conflictDecision.kind === 'conflict' ? conflictDecision.conflictingPaths : [];
      return makeFailure('CONFLICT', 'Workspace baseline changed', {
        currentRevisionId: outcome.current.currentRevision.id,
        currentRevision: outcome.current.currentRevision.revision,
        conflictingPaths,
      });
    },

    async materializeProjectChannelWorkspace(materializeInput) {
      const tokenCredentials = verifyDeviceToken(materializeInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === materializeInput.teamId) {
        // AC#1: device-token gate — only a local device acting for its owner can request a
        // manifest to apply. Remote Agents hold no device token; background jobs don't call this.
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, materializeInput);
        if (!actor.ok) return actor;
        // Authorization is membership-based and source-Device independent (#960: provenance does
        // not decide read/apply authorization). Any device whose owner can view the channel may
        // materialize a revision imported by a different device (AC#4).
        const access = await ensureUserCanViewProjectWorkspace(repositories, {
          userId: actor.userId,
          teamId: materializeInput.teamId,
          channelId: materializeInput.channelId,
        });
        if (!access.ok) return access;
        const sameTeamWorkspace = await repositories.projectChannelWorkspaces.getForTeam({
          teamId: materializeInput.teamId,
          channelId: materializeInput.channelId,
        });
        if (!sameTeamWorkspace) return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
        // The manifest returned is the immutable file list (paths + artifact refs + size/sha).
        // The server never receives the local target directory (no absolute-path leakage).
        return resolveProjectChannelWorkspaceRevision(repositories, sameTeamWorkspace, materializeInput.revisionId);
      }
      // #1056 跨 Team：device token 只证明 home Team 身份；目标 Team 的 manifest
      // 查询（publish baseline）由本次执行 Agent 的 visibleTeamIds + Channel
      // membership + device 绑定授权（codex P1：逐 Agent 校验，不按设备任意 Agent 放行）。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, materializeInput);
      if (!actor.ok) return actor;
      const access = await ensureSnapshotChannelAccess(repositories, {
        userId: actor.userId,
        teamId: materializeInput.teamId,
        channelId: materializeInput.channelId,
      });
      if (!access.ok) return access;
      const authority = await ensureCrossTeamDeviceAgentAuthority(repositories, {
        agentId: materializeInput.agentId,
        deviceId: actor.deviceId,
        teamId: materializeInput.teamId,
        channel: access.channel,
      });
      if (!authority.ok) return authority;
      const workspace = await repositories.projectChannelWorkspaces.getForTeam({
        teamId: materializeInput.teamId,
        channelId: materializeInput.channelId,
      });
      if (!workspace) return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
      return resolveProjectChannelWorkspaceRevision(repositories, workspace, materializeInput.revisionId);
    },

    async createDeviceWorkspaceSnapshot(snapshotInput) {
      // #1053：device token 只证明 home Team 身份；目标 Team 访问由 Agent 授权承担，
      // 允许 visibleTeamIds 覆盖目标 Team 的跨 Team 合法执行。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, snapshotInput);
      if (!actor.ok) return actor;
      const deviceId = actor.deviceId;
      if (!deviceId) return makeFailure('UNAUTHENTICATED', 'Device credentials do not identify a device');
      const access = await ensureSnapshotChannelAccess(repositories, {
        userId: actor.userId,
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
      });
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels reject new snapshots');
      if (!Number.isSafeInteger(snapshotInput.taskAttempt) || snapshotInput.taskAttempt < 1
        || !snapshotInput.taskId?.trim()
        || !snapshotInput.workspaceRunId?.trim()
        || !Array.isArray(snapshotInput.selections)
        || snapshotInput.selections.length === 0) {
        return makeFailure('VALIDATION_ERROR', 'Snapshot taskAttempt and selections are required');
      }
      // #1053：跨 Team 可见 Agent 的授权基础是 visibleTeamIds + Channel membership +
      // device 绑定，不再要求 primaryTeamId === 目标 Team；换绑/visible Team 移除/
      // membership 移除仍在此 fail closed。
      const agent = await repositories.agents.getById(snapshotInput.agentId);
      if (!agent
        || agent.deviceId !== deviceId
        || !agent.visibleTeamIds.includes(snapshotInput.teamId)
        || !access.channel.agentMemberIds.includes(agent.id)) {
        return makeFailure('FORBIDDEN', 'Device is not authorized for this Agent');
      }
      const collections = await repositories.channelProjects.listArtifactCollections({
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
      });
      const versions = await repositories.channelProjects.listArtifactVersions({
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
      });
      const selectedVersionIds = new Set<string>();
      for (const selection of snapshotInput.selections) {
        const collectionIds = selection.kind === 'file_package'
          ? selection.memberCollectionIds
          : [selection.collectionId];
        if (selection.kind === 'file_package'
          && (!selection.memberCollectionIds.length || !selection.memberCollectionIds.includes(selection.collectionId))) {
          return makeFailure('VALIDATION_ERROR', 'File package members must include the package collection');
        }
        for (const collectionId of collectionIds) {
          const collection = collections.find((candidate) => candidate.id === collectionId);
          if (!collection) return makeFailure('NOT_FOUND', 'Snapshot collection member not found');
          if (selection.kind === 'current' || selection.kind === 'file_package') {
            selectedVersionIds.add(collection.currentVersionId);
          } else if (selection.kind === 'final') {
            if (!collection.finalVersionId) return makeFailure('NOT_FOUND', 'Snapshot final version is missing');
            selectedVersionIds.add(collection.finalVersionId);
          } else if (selection.kind === 'version') {
            const requested = versions.find((candidate) => candidate.id === selection.versionId);
            if (!requested || requested.collectionId !== collection.id) {
              return makeFailure('NOT_FOUND', 'Snapshot artifact version not found');
            }
            selectedVersionIds.add(requested.id);
          }
        }
      }
      if (selectedVersionIds.size === 0) return makeFailure('VALIDATION_ERROR', 'Snapshot resolved to no artifact versions');
      const selectedItems: DeviceWorkspaceSnapshotInputSetItemDto[] = [];
      const paths = new Set<string>();
      for (const versionId of selectedVersionIds) {
        const version = versions.find((candidate) => candidate.id === versionId);
        if (!version) return makeFailure('NOT_FOUND', 'Snapshot artifact version is missing');
        const artifact = await repositories.artifacts.getForTeam({ teamId: snapshotInput.teamId, artifactId: version.artifactId });
        if (!artifact || artifact.channelId !== snapshotInput.channelId
          || !(await isPublicChannelFileArtifact(repositories, artifact))) {
          return makeFailure('FORBIDDEN', 'Snapshot artifact is no longer visible');
        }
        if (!artifact.sha256 || !/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
          return makeFailure('CONFLICT', 'Snapshot artifact is missing stable hash or size');
        }
        const path = normalizeWorkspacePath(artifact.filename);
        if (!path || paths.has(path)) return makeFailure('VALIDATION_ERROR', 'Snapshot contains ambiguous file paths');
        paths.add(path);
        selectedItems.push({
          collectionId: version.collectionId,
          artifactVersionId: version.id,
          artifactId: version.artifactId,
          path,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256.toLowerCase(),
        });
      }
      const now = clock.now();
      const workspace = await repositories.projectChannelWorkspaces.getForTeam({
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
      });
      const snapshot: DeviceWorkspaceSnapshotDto = {
        id: ids.nextId(),
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
        // Use the authoritative workspace revision when one exists.  A channel
        // without a workspace still receives a stable snapshot namespace, but
        // that namespace is never used as the publish CAS baseline by daemon.
        workspaceRevisionId: workspace?.currentRevisionId ?? ids.nextId(),
        inputSet: {
          id: ids.nextId(),
          contractVersion: 1,
          selections: structuredClone(snapshotInput.selections),
          items: structuredClone(selectedItems),
        },
        provenance: {
          createdByDeviceId: deviceId,
          agentId: snapshotInput.agentId,
          taskId: snapshotInput.taskId,
          taskAttempt: snapshotInput.taskAttempt,
          workspaceRunId: snapshotInput.workspaceRunId,
          createdAt: now,
        },
        immutable: true,
      };
      await repositories.deviceWorkspaceSnapshots.create(snapshot);
      return makeSuccess({ snapshot: structuredClone(snapshot) });
    },

    async getDeviceWorkspaceSnapshot(snapshotInput) {
      // #1053：与 create 同一跨 Team 授权模型（device home Team 身份 + Agent 目标
      // Team 授权）；物化前每次实时复验，撤权即 fail closed。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, snapshotInput);
      if (!actor.ok) return actor;
      const access = await ensureSnapshotChannelAccess(repositories, {
        userId: actor.userId,
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
      });
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels reject snapshot materialization');
      const snapshot = await repositories.deviceWorkspaceSnapshots.getById({
        teamId: snapshotInput.teamId,
        channelId: snapshotInput.channelId,
        snapshotId: snapshotInput.snapshotId,
      });
      if (!snapshot) {
        return makeFailure('NOT_FOUND', 'Device workspace snapshot not found');
      }
      const agent = await repositories.agents.getById(snapshot.provenance.agentId);
      if (!actor.deviceId || !agent
        || agent.deviceId !== actor.deviceId
        || !agent.visibleTeamIds.includes(snapshotInput.teamId)
        || !access.channel.agentMemberIds.includes(agent.id)) {
        return makeFailure('FORBIDDEN', 'Device or Agent authority was revoked');
      }
      return makeSuccess({ snapshot: structuredClone(snapshot) });
    },

    // #967 Workspace 大文件暂存 / 断网续传 / 可恢复原子发布
    async beginWorkspacePublishStaging(beginInput) {
      const access = await ensureWorkspacePublishChannelAccess(repositories, sessionSecret, beginInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      // hardening：begin 时顺带清理少量过期 open staging（best-effort，不阻塞主路径）。
      void this.cleanupExpiredWorkspacePublishStaging({ limit: 20 }).catch(() => undefined);
      const publishId = normalizeWorkspacePublishId(beginInput.publishId);
      if (!publishId) return makeFailure('VALIDATION_ERROR', 'Invalid publish identity');
      // baselineRevisionId 可选：首次发布（频道尚无 workspace）时省略/空，commit 端 publishRevision 会 bootstrap。
      if (!Array.isArray(beginInput.files) || beginInput.files.length === 0) {
        return makeFailure('VALIDATION_ERROR', 'Workspace staging must declare files');
      }
      const limits = resolveWorkspaceStagingLimits(beginInput.limits);
      const planFiles: WorkspacePublishStagingFileRecord[] = [];
      const seen = new Set<string>();
      let totalBytes = 0;
      for (const entry of beginInput.files) {
        const path = normalizeWorkspacePath(entry.path);
        if (!path) return makeFailure('VALIDATION_ERROR', 'Workspace paths must be unique and relative');
        if (seen.has(path)) return makeFailure('VALIDATION_ERROR', 'Duplicate workspace path');
        seen.add(path);
        const expectedSizeBytes = Number(entry.expectedSizeBytes);
        const expectedSha256 = String(entry.expectedSha256 ?? '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
          return makeFailure('VALIDATION_ERROR', 'expectedSha256 must be a sha256 hex digest');
        }
        totalBytes += expectedSizeBytes;
        const sizeDecision = evaluateWorkspaceStagingSizeLimits({
          fileBytes: expectedSizeBytes,
          totalBytesAfter: totalBytes,
          limits,
        });
        if (sizeDecision.kind === 'rejected') {
          return makeFailure(
            'VALIDATION_ERROR',
            sizeDecision.reason === 'file-too-large' ? 'Workspace staging file exceeds size limit'
              : sizeDecision.reason === 'publish-too-large' ? 'Workspace staging publish exceeds size limit'
              : 'Invalid workspace staging size',
            { reason: sizeDecision.reason },
          );
        }
        const filename = (entry.filename?.trim() || path.split('/').pop() || 'file.bin').slice(0, 255);
        const mimeType = entry.mimeType?.trim() || 'application/octet-stream';
        planFiles.push({
          path,
          filename,
          mimeType,
          expectedSizeBytes,
          expectedSha256,
          receivedBytes: 0,
          complete: false,
        });
      }
      const existing = await repositories.workspacePublishStagings.getByPublishId({
        teamId: beginInput.teamId,
        publishId,
      });
      if (existing) {
        if (existing.channelId !== beginInput.channelId) {
          return makeFailure('CONFLICT', 'Publish identity already used for another channel');
        }
        if (existing.status === 'committed') {
          return makeSuccess({ staging: toWorkspacePublishStagingDto(existing) });
        }
        // #1044：existing open staging 续传前 fail-fast 复验 provenance authority（commit 还会权威复验）。
        const existingAuthority = await ensureWorkspacePublishProvenanceAuthority(repositories, {
          teamId: beginInput.teamId,
          channel: access.channel,
          provenance: existing.provenance ?? beginInput.provenance,
          ...(beginInput.deviceId ? { deviceId: beginInput.deviceId } : {}),
        });
        if (!existingAuthority.ok) return existingAuthority;
        const compatible = isCompatibleWorkspaceStagingBegin({
          existing: {
            teamId: existing.teamId,
            channelId: existing.channelId,
            baselineRevisionId: existing.baselineRevisionId,
            files: existing.files.map((f) => ({
              path: f.path,
              expectedSizeBytes: f.expectedSizeBytes,
              expectedSha256: f.expectedSha256,
            })),
          },
          requested: {
            teamId: beginInput.teamId,
            channelId: beginInput.channelId,
            baselineRevisionId: beginInput.baselineRevisionId,
            files: planFiles.map((f) => ({
              path: f.path,
              expectedSizeBytes: f.expectedSizeBytes,
              expectedSha256: f.expectedSha256,
            })),
          },
        });
        if (!compatible) {
          return makeFailure('CONFLICT', 'Publish identity already used with a different staging plan');
        }
        return makeSuccess({ staging: toWorkspacePublishStagingDto(existing) });
      }
      const now = clock.now();
      // #1044：新建 staging 前 fail-fast 复验 provenance authority，撤权后不再开启新上传会话。
      const authority = await ensureWorkspacePublishProvenanceAuthority(repositories, {
        teamId: beginInput.teamId,
        channel: access.channel,
        provenance: beginInput.provenance,
        ...(beginInput.deviceId ? { deviceId: beginInput.deviceId } : {}),
      });
      if (!authority.ok) return authority;
      const created = await repositories.workspacePublishStagings.create({
        publishId,
        teamId: beginInput.teamId,
        channelId: beginInput.channelId,
        baselineRevisionId: beginInput.baselineRevisionId,
        status: 'open',
        files: planFiles,
        createdBy: beginInput.userId,
        createdAt: now,
        updatedAt: now,
        ...(beginInput.provenance ? { provenance: beginInput.provenance } : {}),
      });
      if (!created) {
        // 竞态：另一请求刚创建。再读一次，并做与 existing 相同的 plan 兼容性检查。
        const raced = await repositories.workspacePublishStagings.getByPublishId({
          teamId: beginInput.teamId,
          publishId,
        });
        if (!raced) return makeFailure('CONFLICT', 'Failed to create workspace publish staging');
        if (raced.channelId !== beginInput.channelId) {
          return makeFailure('CONFLICT', 'Publish identity already used for another channel');
        }
        if (raced.status === 'committed') {
          return makeSuccess({ staging: toWorkspacePublishStagingDto(raced) });
        }
        const racedAuthority = await ensureWorkspacePublishProvenanceAuthority(repositories, {
          teamId: beginInput.teamId,
          channel: access.channel,
          provenance: raced.provenance ?? beginInput.provenance,
          ...(beginInput.deviceId ? { deviceId: beginInput.deviceId } : {}),
        });
        if (!racedAuthority.ok) return racedAuthority;
        const compatible = isCompatibleWorkspaceStagingBegin({
          existing: {
            teamId: raced.teamId,
            channelId: raced.channelId,
            baselineRevisionId: raced.baselineRevisionId,
            files: raced.files.map((f) => ({
              path: f.path,
              expectedSizeBytes: f.expectedSizeBytes,
              expectedSha256: f.expectedSha256,
            })),
          },
          requested: {
            teamId: beginInput.teamId,
            channelId: beginInput.channelId,
            baselineRevisionId: beginInput.baselineRevisionId,
            files: planFiles.map((f) => ({
              path: f.path,
              expectedSizeBytes: f.expectedSizeBytes,
              expectedSha256: f.expectedSha256,
            })),
          },
        });
        if (!compatible) {
          return makeFailure('CONFLICT', 'Publish identity already used with a different staging plan');
        }
        return makeSuccess({ staging: toWorkspacePublishStagingDto(raced) });
      }
      return makeSuccess({ staging: toWorkspacePublishStagingDto(created) });
    },

    async beginWorkspacePublishStagingForDevice(deviceBeginInput) {
      const tokenCredentials = verifyDeviceToken(deviceBeginInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === deviceBeginInput.teamId) {
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, deviceBeginInput);
        if (!actor.ok) return actor;
        // #1044：device 路径透传 deviceId，begin/commit 复验 device↔agent 绑定。
        const deviceId = tokenCredentials.deviceId;
        return this.beginWorkspacePublishStaging({
          userId: actor.userId,
          teamId: deviceBeginInput.teamId,
          channelId: deviceBeginInput.channelId,
          publishId: deviceBeginInput.publishId,
          baselineRevisionId: deviceBeginInput.baselineRevisionId,
          files: deviceBeginInput.files,
          ...(deviceBeginInput.provenance ? { provenance: deviceBeginInput.provenance } : {}),
          ...(deviceBeginInput.limits ? { limits: deviceBeginInput.limits } : {}),
          ...(deviceId ? { deviceId } : {}),
        });
      }
      // #1056 跨 Team：device token 只证明 home Team 身份；目标 Team 发布必须由
      // provenance 的 Agent 授权（begin 内 ensureWorkspacePublishProvenanceAuthority
      // 复验 device↔agent 绑定 + visibleTeamIds + membership）。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, deviceBeginInput);
      if (!actor.ok) return actor;
      if (!actor.deviceId) return makeFailure('UNAUTHENTICATED', 'Device credentials do not identify a device');
      if (!deviceBeginInput.provenance) {
        return makeFailure('FORBIDDEN', 'Cross-team device publish requires agent provenance');
      }
      return this.beginWorkspacePublishStaging({
        userId: actor.userId,
        teamId: deviceBeginInput.teamId,
        channelId: deviceBeginInput.channelId,
        publishId: deviceBeginInput.publishId,
        baselineRevisionId: deviceBeginInput.baselineRevisionId,
        files: deviceBeginInput.files,
        provenance: deviceBeginInput.provenance,
        ...(deviceBeginInput.limits ? { limits: deviceBeginInput.limits } : {}),
        deviceId: actor.deviceId,
        deviceActorToken: deviceBeginInput.token,
      });
    },

    async putWorkspacePublishStagingFileForDevice(devicePutInput) {
      const tokenCredentials = verifyDeviceToken(devicePutInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === devicePutInput.teamId) {
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, devicePutInput);
        if (!actor.ok) return actor;
        return this.putWorkspacePublishStagingFile({
          userId: actor.userId,
          teamId: devicePutInput.teamId,
          channelId: devicePutInput.channelId,
          publishId: devicePutInput.publishId,
          path: devicePutInput.path,
          offset: devicePutInput.offset,
          content: devicePutInput.content,
          ...(devicePutInput.limits ? { limits: devicePutInput.limits } : {}),
        });
      }
      // #1056 跨 Team：续传前复验 staging 的 Agent provenance（无 provenance fail closed）。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, devicePutInput);
      if (!actor.ok) return actor;
      const authority = await ensureCrossTeamStagingAuthority(repositories, {
        teamId: devicePutInput.teamId,
        channelId: devicePutInput.channelId,
        publishId: devicePutInput.publishId,
        ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
      });
      if (!authority.ok) return authority;
      return this.putWorkspacePublishStagingFile({
        userId: actor.userId,
        teamId: devicePutInput.teamId,
        channelId: devicePutInput.channelId,
        publishId: devicePutInput.publishId,
        path: devicePutInput.path,
        offset: devicePutInput.offset,
        content: devicePutInput.content,
        ...(devicePutInput.limits ? { limits: devicePutInput.limits } : {}),
        deviceActorToken: devicePutInput.token,
      });
    },

    async getWorkspacePublishStagingForDevice(deviceGetInput) {
      const tokenCredentials = verifyDeviceToken(deviceGetInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === deviceGetInput.teamId) {
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, deviceGetInput);
        if (!actor.ok) return actor;
        return this.getWorkspacePublishStaging({
          userId: actor.userId,
          teamId: deviceGetInput.teamId,
          channelId: deviceGetInput.channelId,
          publishId: deviceGetInput.publishId,
        });
      }
      // #1056 跨 Team：进度查询同样复验 staging 的 Agent provenance。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, deviceGetInput);
      if (!actor.ok) return actor;
      const authority = await ensureCrossTeamStagingAuthority(repositories, {
        teamId: deviceGetInput.teamId,
        channelId: deviceGetInput.channelId,
        publishId: deviceGetInput.publishId,
        ...(actor.deviceId ? { deviceId: actor.deviceId } : {}),
      });
      if (!authority.ok) return authority;
      return this.getWorkspacePublishStaging({
        userId: actor.userId,
        teamId: deviceGetInput.teamId,
        channelId: deviceGetInput.channelId,
        publishId: deviceGetInput.publishId,
        deviceActorToken: deviceGetInput.token,
      });
    },

    async commitWorkspacePublishStagingForDevice(deviceCommitInput) {
      const tokenCredentials = verifyDeviceToken(deviceCommitInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === deviceCommitInput.teamId) {
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, deviceCommitInput);
        if (!actor.ok) return actor;
        // #1044：device 路径透传 deviceId，commit 复验 device↔agent 绑定。
        const deviceId = tokenCredentials.deviceId;
        return this.commitWorkspacePublishStaging({
          userId: actor.userId,
          teamId: deviceCommitInput.teamId,
          channelId: deviceCommitInput.channelId,
          publishId: deviceCommitInput.publishId,
          ...(deviceCommitInput.limits ? { limits: deviceCommitInput.limits } : {}),
          ...(deviceId ? { deviceId } : {}),
        });
      }
      // #1056 跨 Team：commit 为权威关卡，预检 + commit 内权威复验双保险。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, deviceCommitInput);
      if (!actor.ok) return actor;
      if (!actor.deviceId) return makeFailure('UNAUTHENTICATED', 'Device credentials do not identify a device');
      const authority = await ensureCrossTeamStagingAuthority(repositories, {
        teamId: deviceCommitInput.teamId,
        channelId: deviceCommitInput.channelId,
        publishId: deviceCommitInput.publishId,
        deviceId: actor.deviceId,
      });
      if (!authority.ok) return authority;
      return this.commitWorkspacePublishStaging({
        userId: actor.userId,
        teamId: deviceCommitInput.teamId,
        channelId: deviceCommitInput.channelId,
        publishId: deviceCommitInput.publishId,
        ...(deviceCommitInput.limits ? { limits: deviceCommitInput.limits } : {}),
        deviceId: actor.deviceId,
        deviceActorToken: deviceCommitInput.token,
      });
    },

    async putWorkspacePublishStagingFile(putInput) {
      const access = await ensureWorkspacePublishChannelAccess(repositories, sessionSecret, putInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const publishId = normalizeWorkspacePublishId(putInput.publishId);
      if (!publishId) return makeFailure('VALIDATION_ERROR', 'Invalid publish identity');
      const path = normalizeWorkspacePath(putInput.path);
      if (!path) return makeFailure('VALIDATION_ERROR', 'Workspace paths must be unique and relative');
      const staging = await repositories.workspacePublishStagings.getByPublishId({
        teamId: putInput.teamId,
        publishId,
      });
      if (!staging || staging.channelId !== putInput.channelId) {
        return makeFailure('NOT_FOUND', 'Workspace publish staging not found');
      }
      if (staging.status === 'committed') {
        return makeSuccess({ staging: toWorkspacePublishStagingDto(staging) });
      }
      if (staging.status !== 'open') {
        return makeFailure('CONFLICT', 'Workspace publish staging is not open');
      }
      const fileIndex = staging.files.findIndex((f) => f.path === path);
      if (fileIndex < 0) return makeFailure('NOT_FOUND', 'Staging file path not in plan');
      const file = staging.files[fileIndex]!;
      const chunk = coerceStagingContent(putInput.content);
      const uploadDecision = evaluateWorkspaceStagingUpload({
        expectedSizeBytes: file.expectedSizeBytes,
        receivedBytes: file.receivedBytes,
        complete: file.complete,
        offset: putInput.offset,
        chunkLength: chunk.length,
      });
      if (uploadDecision.kind === 'already-complete') {
        return makeSuccess({ staging: toWorkspacePublishStagingDto(staging) });
      }
      if (uploadDecision.kind === 'rejected') {
        return makeFailure(
          'VALIDATION_ERROR',
          uploadDecision.reason === 'invalid-offset' ? 'Staging upload offset mismatch'
            : uploadDecision.reason === 'overflow' ? 'Staging upload exceeds declared file size'
            : uploadDecision.reason === 'empty-chunk' ? 'Staging upload chunk is empty'
            : 'Staging upload rejected',
          { reason: uploadDecision.reason },
        );
      }
      // 上限双检：单文件 + 会话总接收量（含本 chunk）。
      const limits = resolveWorkspaceStagingLimits(putInput.limits);
      const totalAfter = staging.files.reduce((sum, entry, index) => {
        if (index === fileIndex) return sum + uploadDecision.nextReceivedBytes;
        return sum + entry.receivedBytes;
      }, 0);
      const sizeDecision = evaluateWorkspaceStagingSizeLimits({
        fileBytes: uploadDecision.nextReceivedBytes,
        totalBytesAfter: totalAfter,
        limits,
      });
      if (sizeDecision.kind === 'rejected') {
        return makeFailure(
          'VALIDATION_ERROR',
          sizeDecision.reason === 'file-too-large' ? 'Workspace staging file exceeds size limit'
            : sizeDecision.reason === 'publish-too-large' ? 'Workspace staging publish exceeds size limit'
            : 'Invalid workspace staging size',
          { reason: sizeDecision.reason },
        );
      }

      // #1005：有磁盘 store 时写 dataDir，metadata 只记 storagePath（不塞 BLOB）。
      if (stagingContentStore) {
        let stored: { storagePath: string; sizeBytes: number };
        try {
          stored = await stagingContentStore.appendChunk({
            teamId: putInput.teamId,
            publishId,
            path,
            offset: putInput.offset,
            chunk,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.startsWith('STAGING_OFFSET_MISMATCH')) {
            return makeFailure('VALIDATION_ERROR', 'Staging upload offset mismatch', {
              reason: 'invalid-offset',
            });
          }
          throw error;
        }
        let complete = uploadDecision.complete;
        if (complete) {
          const onDisk = await stagingContentStore.readContent({
            teamId: putInput.teamId,
            publishId,
            path,
            storagePath: stored.storagePath,
          });
          const digest = createHash('sha256').update(onDisk ?? Buffer.alloc(0)).digest('hex');
          if (digest !== file.expectedSha256.toLowerCase()) {
            // 回滚磁盘到本 put 前长度，与 memory 路径「不提交失败 chunk」一致。
            await stagingContentStore.truncateTo({
              teamId: putInput.teamId,
              publishId,
              path,
              sizeBytes: file.receivedBytes,
            });
            return makeFailure('VALIDATION_ERROR', 'Staging file sha256 mismatch', {
              reason: 'hash-mismatch',
              path,
            });
          }
        }
        const nextFiles = staging.files.map((entry, index) => {
          if (index !== fileIndex) return entry;
          return {
            path: entry.path,
            filename: entry.filename,
            mimeType: entry.mimeType,
            expectedSizeBytes: entry.expectedSizeBytes,
            expectedSha256: entry.expectedSha256,
            receivedBytes: uploadDecision.nextReceivedBytes,
            complete,
            storagePath: stored.storagePath,
          };
        });
        const updated = await repositories.workspacePublishStagings.update({
          ...staging,
          files: nextFiles,
          updatedAt: clock.now(),
        });
        return makeSuccess({ staging: toWorkspacePublishStagingDto(updated) });
      }

      const nextContent = Buffer.concat([file.content ? Buffer.from(file.content) : Buffer.alloc(0), chunk]);
      let complete = uploadDecision.complete;
      if (complete) {
        const digest = createHash('sha256').update(nextContent).digest('hex');
        if (digest !== file.expectedSha256.toLowerCase()) {
          // 完整但哈希不匹配：不标记 complete，拒绝本次完成态（调用方可重传）。
          return makeFailure('VALIDATION_ERROR', 'Staging file sha256 mismatch', {
            reason: 'hash-mismatch',
            path,
          });
        }
      }
      const nextFiles = staging.files.map((entry, index) => {
        if (index !== fileIndex) return entry;
        return {
          ...entry,
          receivedBytes: uploadDecision.nextReceivedBytes,
          complete,
          content: nextContent,
        };
      });
      const updated = await repositories.workspacePublishStagings.update({
        ...staging,
        files: nextFiles,
        updatedAt: clock.now(),
      });
      return makeSuccess({ staging: toWorkspacePublishStagingDto(updated) });
    },

    async getWorkspacePublishStaging(getInput) {
      const access = await ensureWorkspacePublishChannelAccess(repositories, sessionSecret, getInput);
      if (!access.ok) return access;
      const publishId = normalizeWorkspacePublishId(getInput.publishId);
      if (!publishId) return makeFailure('VALIDATION_ERROR', 'Invalid publish identity');
      const staging = await repositories.workspacePublishStagings.getByPublishId({
        teamId: getInput.teamId,
        publishId,
      });
      if (!staging || staging.channelId !== getInput.channelId) {
        return makeFailure('NOT_FOUND', 'Workspace publish staging not found');
      }
      // 过期未提交：查询时安全清理，不返回半成品为可提交态。
      if (staging.status !== 'committed') {
        const expiry = evaluateWorkspaceStagingExpiry({
          status: staging.status,
          createdAt: staging.createdAt,
          now: clock.now(),
          retentionMs: DEFAULT_WORKSPACE_STAGING_RETENTION_MS,
        });
        if (expiry.kind === 'expired-cleanable') {
          await stagingContentStore?.deletePublish({
            teamId: staging.teamId,
            publishId: staging.publishId,
          });
          await repositories.workspacePublishStagings.delete({
            teamId: staging.teamId,
            publishId: staging.publishId,
          });
          return makeFailure('NOT_FOUND', 'Workspace publish staging expired');
        }
      }
      return makeSuccess({ staging: toWorkspacePublishStagingDto(staging) });
    },

    async commitWorkspacePublishStaging(commitInput) {
      const access = await ensureWorkspacePublishChannelAccess(repositories, sessionSecret, commitInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const publishId = normalizeWorkspacePublishId(commitInput.publishId);
      if (!publishId) return makeFailure('VALIDATION_ERROR', 'Invalid publish identity');
      const staging = await repositories.workspacePublishStagings.getByPublishId({
        teamId: commitInput.teamId,
        publishId,
      });
      if (!staging || staging.channelId !== commitInput.channelId) {
        return makeFailure('NOT_FOUND', 'Workspace publish staging not found');
      }
      // 幂等：已提交 → 返回同一最终结果，不重复创建 revision。
      if (staging.status === 'committed' && staging.committedRevisionId) {
        // #1060 reconciliation:committed 但 package 可能尚未形成(上次 formation 失败/中断)。
        // 用同一确定性幂等键重试,收敛同一 package;已形成则原样 replay,无副作用。
        if (staging.provenance) {
          try {
            await outputPackageService.formPackage({
              teamId: commitInput.teamId,
              channelId: commitInput.channelId,
              publishId,
              workspaceRevisionId: staging.committedRevisionId,
            });
          } catch {
            // best-effort:不阻塞幂等返回。
          }
        }
        const workspace = await repositories.projectChannelWorkspaces.getForTeam({
          teamId: commitInput.teamId,
          channelId: commitInput.channelId,
        });
        if (workspace && workspace.currentRevisionId === staging.committedRevisionId) {
          return makeSuccess({ staging: toWorkspacePublishStagingDto(staging), workspace });
        }
        const revision = await repositories.projectChannelWorkspaces.getRevision({
          teamId: commitInput.teamId,
          channelId: commitInput.channelId,
          revisionId: staging.committedRevisionId,
        });
        if (workspace && revision) {
          return makeSuccess({
            staging: toWorkspacePublishStagingDto(staging),
            workspace: { ...workspace, currentRevisionId: revision.id, currentRevision: revision },
          });
        }
        return makeSuccess({ staging: toWorkspacePublishStagingDto(staging) });
      }
      if (staging.status !== 'open') {
        return makeFailure('CONFLICT', 'Workspace publish staging is not open');
      }
      // 先解析字节（磁盘或 memory Buffer），再做 readiness / 物化。
      const fileContents = new Map<string, Buffer>();
      for (const file of staging.files) {
        fileContents.set(
          file.path,
          await resolveWorkspaceStagingFileContent(stagingContentStore, staging, file),
        );
      }
      const readiness = evaluateWorkspaceStagingCommitReadiness(
        staging.files.map((file) => {
          const content = fileContents.get(file.path) ?? Buffer.alloc(0);
          const digest = content.length === file.expectedSizeBytes && file.complete
            ? createHash('sha256').update(content).digest('hex')
            : '';
          return {
            path: file.path,
            complete: file.complete,
            expectedSizeBytes: file.expectedSizeBytes,
            receivedBytes: file.receivedBytes,
            sha256Match: digest === file.expectedSha256.toLowerCase(),
          };
        }),
      );
      if (readiness.kind === 'rejected') {
        return makeFailure(
          'VALIDATION_ERROR',
          readiness.reason === 'incomplete' ? 'Workspace staging files are incomplete'
            : readiness.reason === 'hash-mismatch' ? 'Workspace staging file sha256 mismatch'
            : readiness.reason === 'empty-files' ? 'Workspace staging has no files'
            : 'Workspace staging is not ready to commit',
          {
            reason: readiness.reason,
            ...(readiness.incompletePaths ? { incompletePaths: readiness.incompletePaths } : {}),
            ...(readiness.hashMismatchPaths ? { hashMismatchPaths: readiness.hashMismatchPaths } : {}),
          },
        );
      }
      const limits = resolveWorkspaceStagingLimits(commitInput.limits);
      const totalBytes = staging.files.reduce((sum, f) => sum + f.expectedSizeBytes, 0);
      for (const file of staging.files) {
        const sizeDecision = evaluateWorkspaceStagingSizeLimits({
          fileBytes: file.expectedSizeBytes,
          totalBytesAfter: totalBytes,
          limits,
        });
        if (sizeDecision.kind === 'rejected') {
          return makeFailure(
            'VALIDATION_ERROR',
            sizeDecision.reason === 'file-too-large' ? 'Workspace staging file exceeds size limit'
              : sizeDecision.reason === 'publish-too-large' ? 'Workspace staging publish exceeds size limit'
              : 'Invalid workspace staging size',
            { reason: sizeDecision.reason },
          );
        }
      }
      const workspace = await repositories.projectChannelWorkspaces.getForTeam({
        teamId: commitInput.teamId,
        channelId: commitInput.channelId,
      });
      if (!workspace) {
        // 首次发布 bootstrap：频道尚无 workspace。空 baseline = 首次发布，允许（publishRevision 会建）；
        // 非空 baseline 却无 workspace = 非法态（基线指向不存在的 workspace）→ 拒。
        if (staging.baselineRevisionId) return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
      }

      // 半态恢复：publishRevision 已成功但 staging 未标 committed（崩溃窗口）时，
      // 当前 head 的 path/size/sha 与本 plan 一致 → 补标 committed 并返回，不重复创建 revision。
      // 首次发布(无 workspace)无半态可恢复，跳过。
      if (workspace) {
        const recovered = await recoverCommittedWorkspaceStagingIfPublished({
          repositories,
          staging,
          workspace,
          now: clock.now(),
        });
        if (recovered) {
          await stagingContentStore?.deletePublish({ teamId: staging.teamId, publishId: staging.publishId });
          return recovered;
        }
      }

      // #1044：半态恢复之后、物化任何 artifact 之前，权威复验 provenance 的 Agent/Task/Device
      // authority。撤权 → FORBIDDEN，staging 保持 open 可诊断，Workspace 不留部分 revision。
      const provenanceAuthority = await ensureWorkspacePublishProvenanceAuthority(repositories, {
        teamId: commitInput.teamId,
        channel: access.channel,
        provenance: staging.provenance,
        ...(commitInput.deviceId ? { deviceId: commitInput.deviceId } : {}),
      });
      if (!provenanceAuthority.ok) return provenanceAuthority;

      // 预判基线/空清单：在创建任何公开 artifact 之前失败，避免冲突后残留频道可见半成品。
      // 提交清单用占位 artifactId（仅用于路径集合冲突计算；真实 id 在通过后分配）。
      const provisionalEntries = staging.files.map((file) => ({
        path: file.path,
        artifactId: `staging:${publishId}:${file.path}`,
      }));
      const toEntries = (list: Array<{ path: string; artifactId: string }>) =>
        list.map((f) => ({ path: f.path, artifactId: f.artifactId }));
      // pre-publish 冲突预判仅在 workspace 存在时进行：首次发布(无 workspace)无 currentRevision 可比，
      // 跳过——由 publishRevision 事务内 CAS/bootstrap 兜底。
      if (workspace) {
        const preDecision = evaluateWorkspacePublish({
          current: {
            revisionId: workspace.currentRevision.id,
            revision: workspace.currentRevision.revision,
            files: toEntries(workspace.currentRevision.files),
          },
          baselineRevisionId: staging.baselineRevisionId,
          files: provisionalEntries,
        });
        if (preDecision.kind === 'rejected') {
          return makeFailure(
            'VALIDATION_ERROR',
            preDecision.reason === 'revision-overflow' ? 'Workspace revision overflow' : 'Workspace publish must contain files',
          );
        }
        if (preDecision.kind === 'conflict') {
          // 再试一次半态恢复（并发 peer 可能刚完成 publish+标 committed，或仅完成 publish）。
          const workspaceNow = await repositories.projectChannelWorkspaces.getForTeam({
            teamId: commitInput.teamId,
            channelId: commitInput.channelId,
          });
          if (workspaceNow) {
            const recoveredOnConflict = await recoverCommittedWorkspaceStagingIfPublished({
              repositories,
              staging,
              workspace: workspaceNow,
              now: clock.now(),
            });
            if (recoveredOnConflict) {
              await stagingContentStore?.deletePublish({ teamId: staging.teamId, publishId: staging.publishId });
              return recoveredOnConflict;
            }
          }
          // 真冲突：基线落后 / 同路径竞争，不自动合并、不写 revision、不创建 artifact。
          return makeFailure('CONFLICT', 'Workspace baseline changed', {
            currentRevisionId: preDecision.currentRevisionId,
            currentRevision: preDecision.currentRevision,
            conflictingPaths: preDecision.conflictingPaths,
          });
        }
      }

      // 通过预判后再物化 artifacts（commit 前它们不在 revision；无 message/run 时频道索引也不收录）。
      // role=deliverable：成功后可进归档导出；CAS 冲突路径会 deleteForTeam 清掉孤儿。
      const publishedFiles: ProjectChannelWorkspaceFileDto[] = [];
      const createdArtifactIds: string[] = [];
      for (const file of staging.files) {
        const content = fileContents.get(file.path) ?? Buffer.alloc(0);
        const artifactId = ids.nextId();
        let storagePath: string | undefined;
        let sha256 = file.expectedSha256;
        if (content.length > 0 && artifactContentStore) {
          const stored = await artifactContentStore.writeContent({
            teamId: commitInput.teamId,
            artifactId,
            filename: file.filename,
            content,
          });
          storagePath = stored.storagePath;
          sha256 = stored.sha256;
        }
        const artifact = await repositories.artifacts.create({
          id: artifactId,
          teamId: commitInput.teamId,
          channelId: commitInput.channelId,
          uploaderId: commitInput.userId,
          filename: file.filename,
          mimeType: file.mimeType,
          sizeBytes: file.expectedSizeBytes,
          pathKind: 'workspace',
          role: 'deliverable',
          relativePath: file.path,
          sha256,
          createdAt: clock.now(),
          ...(storagePath ? { storagePath } : {}),
        });
        createdArtifactIds.push(artifact.id);
        publishedFiles.push({
          path: file.path,
          artifactId: artifact.id,
          filename: artifact.filename,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
        });
      }

      const now = clock.now();
      const outcome = await repositories.projectChannelWorkspaces.publishRevision({
        teamId: commitInput.teamId,
        channelId: commitInput.channelId,
        baselineRevisionId: staging.baselineRevisionId,
        // 首次发布(无 workspace)时 publishRevision 内部用 newRevision.id 作 workspace id bootstrap（fallback）。
        newRevision: {
          id: ids.nextId(),
          files: publishedFiles,
          createdBy: commitInput.userId,
          createdAt: now,
          ...(staging.provenance
            ? {
                provenance: {
                  kind: 'publish' as const,
                  agentId: staging.provenance.agentId,
                  taskId: staging.provenance.taskId,
                  taskAttempt: staging.provenance.taskAttempt,
                  baselineRevisionId: staging.baselineRevisionId,
                  publishedAt: now,
                  // #1044：可选追溯字段随 revision 固化，发布后可回溯到 Device 与 WorkspaceRun。
                  ...(staging.provenance.deviceId ? { deviceId: staging.provenance.deviceId } : {}),
                  ...(staging.provenance.workspaceRunId ? { workspaceRunId: staging.provenance.workspaceRunId } : {}),
                },
              }
            : {}),
        },
      });
      if (outcome.kind === 'conflict') {
        // 同 publishId 并发 commit / 半态：另一请求可能已成功（或仅完成 publish）→ 幂等收敛。
        const raced = await repositories.workspacePublishStagings.getByPublishId({
          teamId: commitInput.teamId,
          publishId,
        });
        if (raced?.status === 'committed' && raced.committedRevisionId) {
          // peer 已成功：本请求创建的 artifact 是重复物化，清理掉。
          await deleteOrphanWorkspaceStagingArtifacts(repositories, artifactContentStore, {
            teamId: commitInput.teamId,
            artifactIds: createdArtifactIds,
          });
          const workspaceAfter = await repositories.projectChannelWorkspaces.getForTeam({
            teamId: commitInput.teamId,
            channelId: commitInput.channelId,
          });
          if (workspaceAfter && workspaceAfter.currentRevisionId === raced.committedRevisionId) {
            return makeSuccess({ staging: toWorkspacePublishStagingDto(raced), workspace: workspaceAfter });
          }
          const revision = await repositories.projectChannelWorkspaces.getRevision({
            teamId: commitInput.teamId,
            channelId: commitInput.channelId,
            revisionId: raced.committedRevisionId,
          });
          if (workspaceAfter && revision) {
            return makeSuccess({
              staging: toWorkspacePublishStagingDto(raced),
              workspace: { ...workspaceAfter, currentRevisionId: revision.id, currentRevision: revision },
            });
          }
          return makeSuccess({ staging: toWorkspacePublishStagingDto(raced) });
        }
        const recoveredAfterCas = await recoverCommittedWorkspaceStagingIfPublished({
          repositories,
          staging: raced ?? staging,
          workspace: outcome.current,
          now: clock.now(),
        });
        if (recoveredAfterCas) {
          // 半态恢复成功：revision 已由先前请求持有，本请求孤儿 artifact 删除。
          await deleteOrphanWorkspaceStagingArtifacts(repositories, artifactContentStore, {
            teamId: commitInput.teamId,
            artifactIds: createdArtifactIds,
          });
          return recoveredAfterCas;
        }
        // 真冲突：删除刚物化的孤儿 artifact（含 content store），避免 archive/下载残片。
        await deleteOrphanWorkspaceStagingArtifacts(repositories, artifactContentStore, {
          teamId: commitInput.teamId,
          artifactIds: createdArtifactIds,
        });
        const conflictDecision = evaluateWorkspacePublish({
          current: {
            revisionId: outcome.current.currentRevision.id,
            revision: outcome.current.currentRevision.revision,
            files: toEntries(outcome.current.currentRevision.files),
          },
          baselineRevisionId: staging.baselineRevisionId,
          files: toEntries(publishedFiles),
        });
        const conflictingPaths = conflictDecision.kind === 'conflict' ? conflictDecision.conflictingPaths : [];
        return makeFailure('CONFLICT', 'Workspace baseline changed', {
          currentRevisionId: outcome.current.currentRevision.id,
          currentRevision: outcome.current.currentRevision.revision,
          conflictingPaths,
        });
      }
      const committed = await repositories.workspacePublishStagings.update({
        ...staging,
        status: 'committed',
        committedRevisionId: outcome.workspace.currentRevisionId,
        committedWorkspaceId: outcome.workspace.id,
        // 提交后剥离私有 content / storagePath，避免暂存区长期持有大文件。
        files: staging.files.map((f) => ({
          path: f.path,
          filename: f.filename,
          mimeType: f.mimeType,
          expectedSizeBytes: f.expectedSizeBytes,
          expectedSha256: f.expectedSha256,
          receivedBytes: f.receivedBytes,
          complete: true,
        })),
        updatedAt: now,
      });
      // 已物化到 artifact store；删除 staging 磁盘目录。
      await stagingContentStore?.deletePublish({
        teamId: staging.teamId,
        publishId: staging.publishId,
      });
      // #1060：commit 成功后 best-effort 形成 OutputPackage。失败(撤权/attempt 漂移等)只返回
      // rejected,不影响已成功的 commit 结果;committed Workspace revision 保持可恢复事实,
      // 由 commit 幂等重入路径或重复 Device 回调用同一幂等键收敛。
      if (committed.provenance && committed.committedRevisionId) {
        try {
          await outputPackageService.formPackage({
            teamId: committed.teamId,
            channelId: committed.channelId,
            publishId: committed.publishId,
            workspaceRevisionId: committed.committedRevisionId,
          });
        } catch {
          // formation 抛错不阻塞 commit;可由幂等重入重试收敛。
        }
      }
      // #1084 fan-out：真正 commit 后通知频道在线设备 materialize 到本机 .agentbean。
      // 幂等 replay 路径（staging.status==='committed' @6786）不走到此，天然不重复触发。
      // fan-out 失败不阻塞 commit：离线设备由 daemon 重连 reconcile 兜底（at-least-once）。
      try {
        if (committed.committedRevisionId) {
          await input.onWorkspaceRevisionCommitted?.({
            teamId: committed.teamId,
            channelId: committed.channelId,
            workspaceId: outcome.workspace.id,
            revisionId: committed.committedRevisionId,
          });
        }
      } catch {
        // best-effort：不阻塞 commit 结果。
      }
      return makeSuccess({
        staging: toWorkspacePublishStagingDto(committed),
        workspace: outcome.workspace,
      });
    },

    async cleanupExpiredWorkspacePublishStaging(cleanupInput = {}) {
      const retentionMs = cleanupInput.retentionMs ?? DEFAULT_WORKSPACE_STAGING_RETENTION_MS;
      const now = cleanupInput.now ?? clock.now();
      const olderThan = now - retentionMs;
      const expired = await repositories.workspacePublishStagings.listExpiredOpen({
        olderThan,
        limit: cleanupInput.limit ?? 100,
      });
      let cleaned = 0;
      for (const row of expired) {
        const decision = evaluateWorkspaceStagingExpiry({
          status: row.status,
          createdAt: row.createdAt,
          now,
          retentionMs,
        });
        if (decision.kind !== 'expired-cleanable') continue;
        await stagingContentStore?.deletePublish({
          teamId: row.teamId,
          publishId: row.publishId,
        });
        await repositories.workspacePublishStagings.delete({
          teamId: row.teamId,
          publishId: row.publishId,
        });
        cleaned += 1;
      }
      return makeSuccess({ cleaned });
    },

    async listChannelDocuments(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      let records = await repositories.channelDocuments.listWithCurrentRevisionByChannel(documentInput);
      const knownDocumentIds = new Set(records.map(({ document }) => document.id));
      const artifacts = await repositories.artifacts.listByChannel(documentInput);
      const missingDocuments = artifacts.filter((artifact) =>
        Boolean(artifact.messageId && !artifact.workspaceRunId)
        && isMarkdownArtifact(artifact)
        && !knownDocumentIds.has(`channel-document:${artifact.id}`));
      if (channelFileRollout.markdownEditing && missingDocuments.length > 0) {
        for (const artifact of missingDocuments) {
          await getOrCreateChannelDocument(repositories, {
            ...documentInput,
            documentId: `channel-document:${artifact.id}`,
          });
        }
        records = await repositories.channelDocuments.listWithCurrentRevisionByChannel(documentInput);
      }
      return makeSuccess({
        documents: records.map(({ document, currentRevision }) => ({
          ...document,
          currentRevision: toChannelDocumentRevisionDto(currentRevision),
        })),
      });
    },

    async getChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      const document = await getOrCreateChannelDocument(
        repositories,
        documentInput,
        { createIfMissing: channelFileRollout.markdownEditing },
      );
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      return makeSuccess({ document: await toChannelDocumentDto(repositories, document) });
    },

    async listChannelDocumentRevisions(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      const document = await getOrCreateChannelDocument(
        repositories,
        documentInput,
        { createIfMissing: channelFileRollout.markdownEditing },
      );
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const revisions = await repositories.channelDocuments.listRevisions({ documentId: document.id });
      return makeSuccess({
        document: await toChannelDocumentDto(repositories, document),
        revisions: revisions.map(toChannelDocumentRevisionDto),
      });
    },

    async deriveChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (!channelFileRollout.markdownEditing) {
        return makeFailure('NOT_FOUND', 'Channel document editing is disabled');
      }
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const sourceArtifact = await repositories.artifacts.getForTeam({
        teamId: documentInput.teamId,
        artifactId: documentInput.sourceArtifactId,
      });
      if (!sourceArtifact
        || sourceArtifact.channelId !== documentInput.channelId
        || !sourceArtifact.workspaceRunId
        || !sourceArtifact.sourceRoot
        || !sourceArtifact.relativePath
        || (sourceArtifact.mimeType !== 'text/markdown' && !/\.(?:md|markdown)$/i.test(sourceArtifact.filename))) {
        return makeFailure('NOT_FOUND', 'Run Markdown artifact not found');
      }
      const sourcePath = normalizeRootRelativePath(sourceArtifact.relativePath);
      if (!sourcePath) return makeFailure('VALIDATION_ERROR', 'Source Markdown path is invalid');
      const run = await repositories.workspaceRuns.getForTeam({
        teamId: documentInput.teamId,
        runId: sourceArtifact.workspaceRunId,
      });
      if (!run
        || run.channelId !== documentInput.channelId
        || !(await isPublicChannelFileArtifact(repositories, sourceArtifact))) {
        return makeFailure('NOT_FOUND', 'Run Markdown source is unavailable');
      }
      const filename = sanitizeMarkdownFilename(documentInput.filename);
      const existingDocuments = await repositories.channelDocuments.listByChannel(documentInput);
      const selectedTarget = documentInput.targetDocumentId
        ? existingDocuments.find((document) => document.id === documentInput.targetDocumentId)
        : undefined;
      const filenameMatch = existingDocuments.find((document) =>
        document.filename.toLocaleLowerCase() === filename.toLocaleLowerCase());
      if ((filenameMatch && filenameMatch.id !== selectedTarget?.id)
        || (documentInput.targetDocumentId && !selectedTarget)) {
        return makeFailure('CONFLICT', 'A document with this filename already exists; rename it or select that document explicitly');
      }
      if (selectedTarget && selectedTarget.currentRevisionId !== documentInput.targetBaseRevisionId) {
        return makeFailure('CONFLICT', 'Target document has changed; reload before deriving');
      }
      const sourceInfo = await channelFileSource(repositories, sourceArtifact);
      const dispatch = await repositories.dispatches.getById(run.dispatchId);
      const originMessage = dispatch ? await repositories.messages.getById(dispatch.messageId) : null;
      const taskId = sourceInfo?.taskId ?? (originMessage ? messageTaskId(originMessage) : undefined);
      const source: ChannelDocumentSourceDto = {
        ...(sourceInfo?.messageId ? { messageId: sourceInfo.messageId } : {}),
        ...(sourceInfo?.threadId ? { threadId: sourceInfo.threadId } : {}),
        ...(taskId ? { taskId } : {}),
        workspaceRunId: run.id,
        agentId: run.agentId,
        messageCreatedAt: sourceInfo?.messageCreatedAt ?? run.createdAt,
        sourceRoot: sourceArtifact.sourceRoot,
        relativePath: sourceArtifact.relativePath,
        normalizedRelativePath: sourcePath,
        artifactId: sourceArtifact.id,
        artifactRole: sourceArtifact.role ?? 'run_output',
      };
      const sourceArtifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
        teamId: documentInput.teamId,
        channelId: documentInput.channelId,
        runId: run.id,
      });
      const pinned = pinChannelDocumentResources(documentInput.content, source, sourceArtifacts);
      if (!pinned.ok) return makeFailure('VALIDATION_ERROR', pinned.message);
      const bytes = Buffer.byteLength(pinned.content, 'utf8');
      if (bytes > 2 * 1024 * 1024) return makeFailure('VALIDATION_ERROR', 'Markdown content exceeds the 2 MB editing limit');
      if (/<script\b/i.test(pinned.content) || /(?:javascript|vbscript|data):/i.test(pinned.content)) {
        return makeFailure('VALIDATION_ERROR', 'Markdown contains unsafe HTML or URL protocol');
      }
      const artifactId = ids.nextId();
      const stored = artifactContentStore ? await artifactContentStore.writeContent({
        teamId: documentInput.teamId,
        artifactId,
        filename,
        content: Buffer.from(pinned.content, 'utf8'),
      }) : undefined;
      const now = clock.now();
      const artifact: ArtifactRecord = {
        id: artifactId, teamId: documentInput.teamId, channelId: documentInput.channelId,
        uploaderId: documentInput.userId, filename, mimeType: 'text/markdown',
        sizeBytes: bytes, pathKind: 'upload', role: 'attachment', createdAt: now,
        ...(stored ? { storagePath: stored.storagePath, sha256: stored.sha256 } : {}),
      };
      if (selectedTarget) {
        const latestRevision = (await repositories.channelDocuments.listRevisions({ documentId: selectedTarget.id }))[0];
        const revision: ChannelDocumentRevisionRecord = {
          id: ids.nextId(), documentId: selectedTarget.id, artifact,
          revision: (latestRevision?.revision ?? 0) + 1, createdBy: documentInput.userId,
          createdAt: now, source: 'run', derivationSource: source, resources: pinned.resources,
          published: false,
        };
        const saved = await repositories.channelDocuments.addRevision({
          documentId: selectedTarget.id,
          expectedCurrentRevisionId: selectedTarget.currentRevisionId,
          document: { ...selectedTarget, filename, currentRevisionId: revision.id, updatedAt: now },
          revision,
          artifact,
          requireUniqueFilename: true,
          operation: {
            documentId: selectedTarget.id,
            idempotencyKey: `derive:${revision.id}`,
            operationType: 'save',
            requestFingerprint: createHash('sha256').update(JSON.stringify({
              sourceArtifactId: sourceArtifact.id,
              targetBaseRevisionId: selectedTarget.currentRevisionId,
              filename,
            })).digest('hex'),
            revisionId: revision.id,
          },
        });
        if (!saved) {
          await artifactContentStore?.deleteContent?.({ teamId: documentInput.teamId, artifactId });
          return makeFailure('CONFLICT', 'Target document has changed; reload before deriving');
        }
        await notifyProjectFactsChanged({
          teamId: documentInput.teamId,
          channelId: documentInput.channelId,
        });
        return makeSuccess({ document: toCommittedChannelDocumentDto(saved.document, saved.revision) });
      }
      const documentId = ids.nextId();
      const revision: ChannelDocumentRevisionRecord = {
        id: ids.nextId(), documentId, artifact, revision: 1, createdBy: documentInput.userId,
        createdAt: now, source: 'run', derivationSource: source, resources: pinned.resources,
        published: false,
      };
      const document: ChannelDocumentRecord = {
        id: documentId, teamId: documentInput.teamId, channelId: documentInput.channelId,
        filename, currentRevisionId: revision.id, createdAt: now, updatedAt: now,
      };
      const saved = await repositories.channelDocuments.createDerived({ document, revision, artifact });
      if (!saved) {
        await artifactContentStore?.deleteContent?.({ teamId: documentInput.teamId, artifactId });
        return makeFailure('CONFLICT', 'Document could not be created');
      }
      await notifyProjectFactsChanged({
        teamId: documentInput.teamId,
        channelId: documentInput.channelId,
      });
      return makeSuccess({ document: { ...saved, currentRevision: toChannelDocumentRevisionDto(revision) } });
    },

    async saveChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (!channelFileRollout.markdownEditing) {
        return makeFailure('NOT_FOUND', 'Channel document editing is disabled');
      }
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const result = await commitChannelDocumentRevision({
        repositories, artifactContentStore, clock, ids, document, input: documentInput,
        operationType: 'save', source: 'edit',
      });
      if (result.ok) {
        await notifyProjectFactsChanged({
          teamId: documentInput.teamId,
          channelId: documentInput.channelId,
        });
      }
      return result;
    },

    async restoreChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (!channelFileRollout.markdownEditing) {
        return makeFailure('NOT_FOUND', 'Channel document editing is disabled');
      }
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const sourceRevision = await repositories.channelDocuments.getRevision({
        documentId: document.id,
        revisionId: documentInput.revisionId,
      });
      if (!sourceRevision) return makeFailure('NOT_FOUND', 'Channel document revision not found');
      const result = await commitChannelDocumentRevision({
        repositories, artifactContentStore, clock, ids, document, input: documentInput,
        operationType: 'restore', source: 'restore', sourceRevision,
      });
      if (result.ok) {
        await notifyProjectFactsChanged({
          teamId: documentInput.teamId,
          channelId: documentInput.channelId,
        });
      }
      return result;
    },

    async publishChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (!channelFileRollout.markdownEditing) {
        return makeFailure('NOT_FOUND', 'Channel document editing is disabled');
      }
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const result = await commitChannelDocumentRevision({
        repositories, artifactContentStore, clock, ids, document, input: documentInput,
        operationType: 'publish', source: 'edit',
      });
      if (!result.ok) return result;
      await notifyProjectFactsChanged({
        teamId: documentInput.teamId,
        channelId: documentInput.channelId,
      });
      if (!result.message) throw new Error('Published channel document is missing its message');
      return makeSuccess({
        document: result.document,
        message: {
          ...result.message,
          artifacts: [result.document.currentRevision.artifact],
        },
      });
    },

    // #1062 基于明确版本保存 Markdown 修订(AC1-AC10)。
    async saveArtifactVersionRevision(revisionInput) {
      // 与 listOutputPackages 同坑(9024 行注释):currentDeviceId 由 socket bind 层
      // withAuthenticatedUserId 无条件注入,必须与 userId/teamId 一同剥离,
      // 否则 assertExactKeys 拒绝未知字段 → ARTIFACT_REVISION_PAYLOAD_INVALID(#1062 起全链路即坏)。
      const { userId, teamId, currentDeviceId, ...wireInput } = revisionInput;
      void currentDeviceId;
      const parsed = parseArtifactRevisionCommandInputV1('save-artifact-version-revision', wireInput);
      const result = await saveArtifactVersionRevisionCommand(
        {
          repositories,
          artifactContentStore: artifactContentStore ?? dummyContentStore(),
          clock,
          ids,
          editingEnabled: channelFileRollout.markdownEditing,
        },
        {
          teamId,
          userId,
          channelId: parsed.channelId,
          collectionId: parsed.collectionId,
          baseVersionId: parsed.baseVersionId,
          content: parsed.content,
          ...(parsed.filename !== undefined ? { filename: parsed.filename } : {}),
          expectedCollectionRevision: parsed.expectedCollectionRevision,
          revisionBasis: parsed.revisionBasis,
          idempotencyKey: parsed.idempotencyKey,
        },
      );
      // #1065 AC7：新版本更新了 collection current,影响 package current 投影,同样推进水位。
      if (result.kind === 'applied') {
        await bumpOutputPackageWatermark(repositories, parsed.channelId, clock.now());
      }
      return artifactRevisionCommandAck(repositories, result);
    },

    async searchMessages(searchInput) {
      if (!(await repositories.teams.isMember(searchInput.teamId, searchInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const query = searchInput.query.trim();
      if (query.length < 2) {
        return makeFailure('VALIDATION_ERROR', 'Search query must be at least 2 characters');
      }
      const scopedChannelId = normalizeOptionalId(searchInput.channelId);
      let channelIds: string[];
      if (scopedChannelId) {
        const channelAccess = await ensureUserCanViewChannel(repositories, {
          userId: searchInput.userId,
          teamId: searchInput.teamId,
          channelId: scopedChannelId,
        });
        if (!channelAccess.ok) {
          return channelAccess;
        }
        if (channelAccess.channel.archivedAt != null) {
          return makeFailure('NOT_FOUND', 'Channel not found');
        }
        if (channelAccess.channel.kind === 'direct') {
          const agentId = channelAccess.channel.dmTargetAgentId ?? channelAccess.channel.agentMemberIds[0];
          const agent = agentId ? await repositories.agents.getById(agentId) : null;
          if (!agent || !agent.visibleTeamIds.includes(searchInput.teamId)) {
            return makeFailure('NOT_FOUND', 'DM not found');
          }
        }
        channelIds = [scopedChannelId];
      } else {
        channelIds = [
          ...(await repositories.channels.listForUser(searchInput.teamId, searchInput.userId)).map((channel) => channel.id),
          ...(await visibleDirectChannelsForUser(repositories, searchInput.teamId, searchInput.userId)).map(({ channel }) => channel.id),
        ];
      }
      const messages = await repositories.messages.search({
        channelIds,
        query,
        limit: normalizeLimit(searchInput.limit),
      });
      return makeSuccess({
        messages: await enrichMessagesWithArtifacts(repositories, messages),
      });
    },

    async getMessageContext(contextInput) {
      if (!(await repositories.teams.isMember(contextInput.teamId, contextInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const message = await repositories.messages.getById(contextInput.messageId);
      if (!message || message.teamId !== contextInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: contextInput.userId,
        teamId: contextInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      if (channelAccess.channel.kind === 'direct') {
        const agentId = channelAccess.channel.dmTargetAgentId ?? channelAccess.channel.agentMemberIds[0];
        const agent = agentId ? await repositories.agents.getById(agentId) : null;
        if (!agent || !agent.visibleTeamIds.includes(contextInput.teamId)) {
          return makeFailure('NOT_FOUND', 'DM not found');
        }
      }

      const threadRootId = await resolveExplicitThreadRootId(repositories, message);
      let contextMessages = [message];
      if (threadRootId) {
        const threadRoot = await repositories.messages.getById(threadRootId);
        contextMessages = uniqueMessagesById([
          ...(threadRoot && threadRoot.channelId === message.channelId ? [threadRoot] : []),
          ...(await repositories.messages.listThreadBefore({
            channelId: message.channelId,
            threadId: threadRootId,
            beforeMessageId: message.id,
            limit: 50,
          })),
          message,
        ]).sort((a, b) => a.createdAt - b.createdAt);
      }

      return makeSuccess({
        targetMessageId: message.id,
        ...(threadRootId ? { threadRootId } : {}),
        messages: await enrichMessagesWithArtifacts(repositories, contextMessages),
      });
    },

    async convertMessageToTask(convertInput) {
      if (!(await repositories.teams.isMember(convertInput.teamId, convertInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const message = await repositories.messages.getById(convertInput.messageId);
      if (!message || message.teamId !== convertInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      if (message.senderKind === 'system') {
        return makeFailure('VALIDATION_ERROR', 'System messages cannot be converted to tasks');
      }
      if (isDeletedMessage(message)) {
        return makeFailure('CONFLICT', 'Deleted messages cannot be converted to tasks');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: convertInput.userId,
        teamId: convertInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }

      const existingTaskId = typeof message.meta?.taskId === 'string' ? message.meta.taskId : null;
      if (existingTaskId) {
        const existingTask = await repositories.tasks.getById(existingTaskId);
        if (existingTask && existingTask.teamId === convertInput.teamId) {
          const [enrichedMessage] = await enrichMessagesWithArtifacts(repositories, [message]);
          return makeSuccess({ message: enrichedMessage ?? message, task: existingTask });
        }
      }

      const now = clock.now();
      const title = message.body.trim() || '附件';
      const visibleAgents = await repositories.agents.listVisibleInTeam(convertInput.teamId);
      const mentions = sanitizeMessageMentions({
        body: message.body,
        mentions: message.meta?.mentions,
        channel: channelAccess.channel,
        visibleAgents,
      });
      const route = routeMessageForChannel({
        channel: channelAccess.channel,
        visibleAgents,
        teamId: convertInput.teamId,
        body: message.body,
        mentions,
      });
      const taskId = ids.nextId();
      const task = await repositories.tasks.create({
        id: taskId,
        teamId: convertInput.teamId,
        title,
        description: undefined,
        status: 'todo',
        creatorId: convertInput.userId,
        assigneeId: route.kind === 'dispatch' ? route.agentId : undefined,
        channelId: message.channelId,
        tags: [],
        sortOrder: now,
        createdAt: now,
        updatedAt: now,
      });
      const claim = await repositories.messages.setTaskIdIfAbsent({
        messageId: message.id,
        taskId,
      });
      if (!claim) {
        await repositories.tasks.delete({ taskId });
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      if (!claim.inserted) {
        await repositories.tasks.delete({ taskId });
        const existingTask = await repositories.tasks.getById(claim.taskId);
        if (existingTask && existingTask.teamId === convertInput.teamId) {
          const [enrichedMessage] = await enrichMessagesWithArtifacts(repositories, [claim.message]);
          return makeSuccess({ message: enrichedMessage ?? claim.message, task: existingTask });
        }
        return makeFailure('CONFLICT', 'Message is already linked to a missing task');
      }
      const [enrichedMessage] = await enrichMessagesWithArtifacts(repositories, [claim.message]);
      return makeSuccess({ message: enrichedMessage ?? claim.message, task });
    },

    async listTasks(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channelId = normalizeOptionalId(taskInput.channelId);
      if (channelId) {
        const channel = await ensureUserCanViewChannel(repositories, {
          userId: taskInput.userId,
          teamId: taskInput.teamId,
          channelId,
        });
        if (!channel.ok) {
          return channel;
        }
        return makeSuccess({
          tasks: await repositories.tasks.list({
            teamId: taskInput.teamId,
            channelIds: [channelId],
            includeGlobal: false,
          }),
        });
      }
      return makeSuccess({
        tasks: await repositories.tasks.list({
          teamId: taskInput.teamId,
          channelIds: await visibleTaskChannelIds(repositories, taskInput.teamId, taskInput.userId),
          includeGlobal: true,
        }),
      });
    },

    async getChannelProjectOverview(projectInput) {
      if (!projectCollaborationRollout.projectStage) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Channel project stages are disabled');
      }
      if (!(await repositories.teams.isMember(projectInput.teamId, projectInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, projectInput);
      if (!access.ok) return access;
      const overview = await buildChannelProjectOverview(
        repositories,
        access.channel,
        await resolveProjectPiHealthy(),
        clock.now(),
        input.resolveProjectStageCandidates,
      );
      return makeSuccess({ overview });
    },

    async createInitialProjectStage(projectInput) {
      if (!projectCollaborationRollout.projectStage) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Channel project stages are disabled');
      }
      if (!(await repositories.teams.isMember(projectInput.teamId, projectInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, projectInput);
      if (!access.ok) return access;
      const { channel } = access;
      if (channel.kind !== 'channel') {
        return makeFailure('VALIDATION_ERROR', 'Project stages require a regular channel');
      }
      if (!Number.isSafeInteger(projectInput.expectedRevision) || projectInput.expectedRevision < 0) {
        return makeFailure('VALIDATION_ERROR', 'expectedRevision must be a non-negative integer');
      }
      const idempotencyKey = typeof projectInput.idempotencyKey === 'string'
        ? projectInput.idempotencyKey.trim()
        : '';
      if (!idempotencyKey) {
        return makeFailure('VALIDATION_ERROR', 'idempotencyKey is required');
      }
      const projectLeadId = normalizeOptionalId(projectInput.projectLeadId);
      const defaultReviewerIds = normalizeUniqueTextItems(projectInput.defaultReviewerIds);
      const stageName = normalizeOptionalText(projectInput.stage?.name);
      const stageGoal = normalizeOptionalText(projectInput.stage?.goal);
      const stageOwnerId = normalizeOptionalId(projectInput.stage?.ownerId);
      const reviewerIds = normalizeUniqueTextItems(projectInput.stage?.reviewerIds);
      const acceptanceCriteria = normalizeUniqueTextItems(projectInput.stage?.acceptanceCriteria);
      const taskId = normalizeOptionalId(projectInput.stage?.taskId);
      if (!projectLeadId || defaultReviewerIds.length === 0 || !stageName || !stageGoal || !stageOwnerId
        || reviewerIds.length === 0 || !taskId || acceptanceCriteria.length === 0) {
        return makeFailure('VALIDATION_ERROR', 'Project lead, Stage fields, Task, and acceptance criteria are required');
      }
      const normalizedRequest = {
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        expectedRevision: projectInput.expectedRevision,
        projectLeadId,
        defaultReviewerIds,
        stage: {
          name: stageName,
          goal: stageGoal,
          ownerId: stageOwnerId,
          reviewerIds,
          acceptanceCriteria,
          taskId,
        },
      };
      const requestFingerprint = createHash('sha256')
        .update(JSON.stringify(normalizedRequest))
        .digest('hex');
      const existingMutation = await repositories.channelProjects.getMutation({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        idempotencyKey,
      });
      if (existingMutation) {
        if (existingMutation.requestFingerprint !== requestFingerprint) {
          return makeFailure('CONFLICT', 'idempotencyKey was already used for a different project mutation');
        }
        return makeSuccess({ overview: existingMutation.resultOverview, replayed: true });
      }
      if (channel.archivedAt != null) {
        return makeFailure('CONFLICT', 'Archived channels are read-only');
      }
      const actorRole = await repositories.teams.getMemberRole(projectInput.teamId, projectInput.userId);
      if (channel.createdBy !== projectInput.userId && actorRole !== 'owner' && actorRole !== 'admin') {
        return makeFailure('FORBIDDEN', 'User cannot configure this channel project');
      }
      const humanActorIds = uniqueIds([projectLeadId, ...defaultReviewerIds, ...reviewerIds]);
      const humanActorMembership = await Promise.all(humanActorIds.map(async (actorId) =>
        (await repositories.teams.isMember(projectInput.teamId, actorId))
        && (channel.visibility === 'public' || channel.humanMemberIds.includes(actorId))));
      if (humanActorMembership.some((isMember) => !isMember)) {
        return makeFailure('FORBIDDEN', 'Project leads and reviewers must be channel members');
      }
      const ownerIsHuman = (await repositories.teams.isMember(projectInput.teamId, stageOwnerId))
        && (channel.visibility === 'public' || channel.humanMemberIds.includes(stageOwnerId));
      if (!ownerIsHuman && !channel.agentMemberIds.includes(stageOwnerId)) {
        return makeFailure('FORBIDDEN', 'Stage owner must be a channel member');
      }
      const task = await repositories.tasks.getById(taskId);
      if (!task || task.teamId !== projectInput.teamId || task.channelId !== projectInput.channelId) {
        return makeFailure('NOT_FOUND', 'Tracked Task not found in this Team and Channel');
      }

      const now = clock.now();
      const profileId = ids.nextId();
      const stageId = ids.nextId();
      const profile = {
        id: profileId,
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        projectLeadId,
        defaultReviewerIds,
        revision: 1,
        createdBy: projectInput.userId,
        createdAt: now,
        updatedAt: now,
      };
      const stage = {
        id: stageId,
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        taskId,
        taskRevision: task.revision,
        name: stageName,
        goal: stageGoal,
        ownerId: stageOwnerId,
        reviewerIds,
        acceptanceCriteria,
        createdAt: now,
        updatedAt: now,
      };
      const initialOverview: ChannelProjectOverviewDto = await projectChannelProjectOverview(
        repositories,
        channel,
        profile,
        [stage],
        [],
        await resolveProjectPiHealthy(),
        now,
        input.resolveProjectStageCandidates,
      );
      const result = await repositories.channelProjects.createInitialStage({
        expectedRevision: projectInput.expectedRevision,
        profile,
        stage,
        mutation: {
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
          idempotencyKey,
          requestFingerprint,
          profileId,
          stageId,
          resultRevision: 1,
          resultOverview: initialOverview,
          createdAt: now,
        },
      });
      if (result.kind === 'idempotency_conflict') {
        return makeFailure('CONFLICT', 'idempotencyKey was already used for a different project mutation');
      }
      if (result.kind === 'revision_conflict') {
        return makeFailure('CONFLICT', 'Project revision is stale; refresh and retry');
      }
      if (result.kind === 'task_scope_conflict') {
        return makeFailure('CONFLICT', 'Tracked Task changed scope or revision; refresh and retry');
      }
      return makeSuccess({
        overview: result.mutation.resultOverview,
        replayed: result.kind === 'replayed',
      });
    },

    async createProjectStage(stageInput) {
      if (!projectCollaborationRollout.projectStage) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Channel project stages are disabled');
      }
      const stageName = normalizeOptionalText(stageInput.stage?.name);
      const stageGoal = normalizeOptionalText(stageInput.stage?.goal);
      const stageOwnerId = normalizeOptionalId(stageInput.stage?.ownerId);
      const reviewerIds = normalizeUniqueTextItems(stageInput.stage?.reviewerIds);
      const acceptanceCriteria = normalizeUniqueTextItems(stageInput.stage?.acceptanceCriteria);
      const taskId = normalizeOptionalId(stageInput.stage?.taskId);
      if (!stageName || !stageGoal || !stageOwnerId || reviewerIds.length === 0
        || !taskId || acceptanceCriteria.length === 0) {
        return makeFailure('VALIDATION_ERROR', 'Stage fields, Task, reviewers and acceptance criteria are required');
      }
      const prepared = await prepareProjectStageEdgeMutation(repositories, stageInput, {
        stage: { name: stageName, goal: stageGoal, ownerId: stageOwnerId, reviewerIds, acceptanceCriteria, taskId },
      });
      if (!prepared.ok) return prepared.settled;
      const { channel, profile, stages, edges, idempotencyKey, requestFingerprint } = prepared;
      const humanActorMembership = await Promise.all(reviewerIds.map(async (actorId) =>
        (await repositories.teams.isMember(stageInput.teamId, actorId))
        && (channel.visibility === 'public' || channel.humanMemberIds.includes(actorId))));
      if (humanActorMembership.some((isMember) => !isMember)) {
        return makeFailure('FORBIDDEN', 'Reviewers must be channel members');
      }
      const ownerIsHuman = (await repositories.teams.isMember(stageInput.teamId, stageOwnerId))
        && (channel.visibility === 'public' || channel.humanMemberIds.includes(stageOwnerId));
      if (!ownerIsHuman && !channel.agentMemberIds.includes(stageOwnerId)) {
        return makeFailure('FORBIDDEN', 'Stage owner must be a channel member');
      }
      const task = await repositories.tasks.getById(taskId);
      if (!task || task.teamId !== stageInput.teamId || task.channelId !== stageInput.channelId) {
        return makeFailure('NOT_FOUND', 'Tracked Task not found in this Team and Channel');
      }
      const now = clock.now();
      const stage: ProjectStageRecord = {
        id: ids.nextId(),
        teamId: stageInput.teamId,
        channelId: stageInput.channelId,
        taskId,
        taskRevision: task.revision,
        name: stageName,
        goal: stageGoal,
        ownerId: stageOwnerId,
        reviewerIds,
        acceptanceCriteria,
        createdAt: now,
        updatedAt: now,
      };
      const nextRevision = profile.revision + 1;
      const resultOverview = await projectChannelProjectOverview(
        repositories,
        channel,
        { ...profile, revision: nextRevision, updatedAt: now },
        [...stages, stage],
        edges,
        await resolveProjectPiHealthy(),
        now,
        input.resolveProjectStageCandidates,
      );
      const result = await repositories.channelProjects.createStage({
        expectedRevision: stageInput.expectedRevision,
        nextRevision,
        updatedAt: now,
        stage,
        mutation: {
          teamId: stageInput.teamId,
          channelId: stageInput.channelId,
          idempotencyKey,
          requestFingerprint,
          profileId: profile.id,
          stageId: stage.id,
          resultRevision: nextRevision,
          resultOverview,
          createdAt: now,
        },
      });
      if (result.kind === 'duplicate_edge') {
        return makeFailure('CONFLICT', 'This Tracked Task already has a project Stage');
      }
      return projectStageEdgeMutationAck(result);
    },

    async createProjectStageEdge(edgeInput) {
      if (!projectCollaborationRollout.projectStage) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Channel project stages are disabled');
      }
      if (edgeInput.semantics !== 'blocks_start' && edgeInput.semantics !== 'provides_context') {
        return makeFailure('VALIDATION_ERROR', 'semantics must be blocks_start or provides_context');
      }
      if (!Number.isSafeInteger(edgeInput.expectedUpstreamTaskRevision)
        || edgeInput.expectedUpstreamTaskRevision < 1
        || !Number.isSafeInteger(edgeInput.expectedDownstreamTaskRevision)
        || edgeInput.expectedDownstreamTaskRevision < 1) {
        return makeFailure('VALIDATION_ERROR', 'Expected Task revisions must be positive integers');
      }
      const prepared = await prepareProjectStageEdgeMutation(repositories, edgeInput, {
        upstreamStageId: normalizeOptionalId(edgeInput.upstreamStageId),
        downstreamStageId: normalizeOptionalId(edgeInput.downstreamStageId),
        semantics: edgeInput.semantics,
        requiredInputs: normalizeProjectStageRequiredInputs(edgeInput.requiredInputs),
        expectedUpstreamTaskRevision: edgeInput.expectedUpstreamTaskRevision,
        expectedDownstreamTaskRevision: edgeInput.expectedDownstreamTaskRevision,
      });
      if (!prepared.ok) return prepared.settled;
      const { channel, profile, stages, edges, idempotencyKey, requestFingerprint, normalized } = prepared;
      const upstreamStage = stages.find((stage) => stage.id === normalized.upstreamStageId);
      const downstreamStage = stages.find((stage) => stage.id === normalized.downstreamStageId);
      const decision = evaluateProjectStageEdgeCreation({
        teamId: edgeInput.teamId,
        channelId: edgeInput.channelId,
        upstream: upstreamStage
          ? {
            stageId: upstreamStage.id,
            teamId: upstreamStage.teamId,
            channelId: upstreamStage.channelId,
            taskId: upstreamStage.taskId,
          }
          : null,
        downstream: downstreamStage
          ? {
            stageId: downstreamStage.id,
            teamId: downstreamStage.teamId,
            channelId: downstreamStage.channelId,
            taskId: downstreamStage.taskId,
          }
          : null,
        existingEdges: edges,
        requiredInputs: normalized.requiredInputs,
      });
      if (decision.kind === 'rejected') {
        return projectStageEdgeRejection(decision.reason);
      }
      if (!upstreamStage || !downstreamStage) {
        return makeFailure('NOT_FOUND', 'Project Stage not found in this Channel');
      }
      if (upstreamStage.taskRevision !== normalized.expectedUpstreamTaskRevision
        || downstreamStage.taskRevision !== normalized.expectedDownstreamTaskRevision) {
        return makeFailure('CONFLICT', 'Stage or Task revision is stale; refresh and retry');
      }
      const now = clock.now();
      const edge: ProjectStageEdgeRecord = {
        id: ids.nextId(),
        teamId: edgeInput.teamId,
        channelId: edgeInput.channelId,
        upstreamStageId: upstreamStage.id,
        downstreamStageId: downstreamStage.id,
        upstreamTaskId: upstreamStage.taskId,
        upstreamTaskRevision: upstreamStage.taskRevision,
        downstreamTaskId: downstreamStage.taskId,
        downstreamTaskRevision: downstreamStage.taskRevision,
        semantics: normalized.semantics,
        requiredInputs: normalized.requiredInputs,
        mirroredTaskDependency: false,
        createdBy: edgeInput.userId,
        createdAt: now,
        updatedAt: now,
      };
      const nextRevision = profile.revision + 1;
      const resultOverview = await projectChannelProjectOverview(
        repositories,
        channel,
        { ...profile, revision: nextRevision, updatedAt: now },
        stages,
        [...edges, edge],
        await resolveProjectPiHealthy(),
        now,
        input.resolveProjectStageCandidates,
      );
      const result = await repositories.channelProjects.createStageEdge({
        expectedRevision: edgeInput.expectedRevision,
        nextRevision,
        updatedAt: now,
        edge,
        mutation: {
          teamId: edgeInput.teamId,
          channelId: edgeInput.channelId,
          idempotencyKey,
          requestFingerprint,
          profileId: profile.id,
          stageId: downstreamStage.id,
          resultRevision: nextRevision,
          resultOverview,
          createdAt: now,
        },
      });
      if (result.kind === 'created') {
        await notifyProjectFactsChanged({
          teamId: edgeInput.teamId,
          channelId: edgeInput.channelId,
        });
      }
      return projectStageEdgeMutationAck(result);
    },

    async deleteProjectStageEdge(edgeInput) {
      if (!projectCollaborationRollout.projectStage) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Channel project stages are disabled');
      }
      const prepared = await prepareProjectStageEdgeMutation(repositories, edgeInput, {
        edgeId: normalizeOptionalId(edgeInput.edgeId),
      });
      if (!prepared.ok) return prepared.settled;
      const { channel, profile, stages, edges, idempotencyKey, requestFingerprint, normalized } = prepared;
      const edge = edges.find((candidate) => candidate.id === normalized.edgeId);
      if (!edge) return makeFailure('NOT_FOUND', 'Project Stage edge not found in this Channel');
      const now = clock.now();
      const nextRevision = profile.revision + 1;
      const resultOverview = await projectChannelProjectOverview(
        repositories,
        channel,
        { ...profile, revision: nextRevision, updatedAt: now },
        stages,
        edges.filter((candidate) => candidate.id !== edge.id),
        await resolveProjectPiHealthy(),
        now,
        input.resolveProjectStageCandidates,
      );
      const result = await repositories.channelProjects.deleteStageEdge({
        teamId: edgeInput.teamId,
        channelId: edgeInput.channelId,
        edgeId: edge.id,
        expectedRevision: edgeInput.expectedRevision,
        nextRevision,
        updatedAt: now,
        mutation: {
          teamId: edgeInput.teamId,
          channelId: edgeInput.channelId,
          idempotencyKey,
          requestFingerprint,
          profileId: profile.id,
          stageId: edge.downstreamStageId,
          resultRevision: nextRevision,
          resultOverview,
          createdAt: now,
        },
      });
      if (result.kind === 'deleted') {
        await notifyProjectFactsChanged({
          teamId: edgeInput.teamId,
          channelId: edgeInput.channelId,
        });
      }
      return projectStageEdgeMutationAck(result);
    },

    async listProjectArtifactCollections(projectInput) {
      if (!projectCollaborationRollout.reviewFinalization) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project artifact review and finalization are disabled');
      }
      if (!(await repositories.teams.isMember(projectInput.teamId, projectInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, projectInput);
      if (!access.ok) return access;
      return makeSuccess({
        library: await buildProjectArtifactLibrary(repositories, access.channel),
      });
    },

    async promoteArtifactToProjectVersion(projectInput) {
      if (!projectCollaborationRollout.reviewFinalization) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project artifact review and finalization are disabled');
      }
      if (!(await repositories.teams.isMember(projectInput.teamId, projectInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, projectInput);
      if (!access.ok) return access;
      const { channel } = access;
      if (channel.kind !== 'channel') {
        return makeFailure('VALIDATION_ERROR', 'Project artifacts require a regular channel');
      }
      const idempotencyKey = typeof projectInput.idempotencyKey === 'string'
        ? projectInput.idempotencyKey.trim()
        : '';
      if (!idempotencyKey) {
        return makeFailure('VALIDATION_ERROR', 'idempotencyKey is required');
      }
      const artifactId = normalizeOptionalId(projectInput.artifactId);
      const stageId = normalizeOptionalId(projectInput.stageId);
      if (!artifactId || !stageId) {
        return makeFailure('VALIDATION_ERROR', 'artifactId and stageId are required');
      }
      const requestedCollectionId = normalizeOptionalId(projectInput.collectionId);
      const collectionName = normalizeOptionalText(projectInput.collection?.name);
      const collectionKind = normalizeOptionalText(projectInput.collection?.kind);
      const sourceInvocationId = normalizeOptionalId(projectInput.sourceInvocationId);
      if (requestedCollectionId) {
        if (!Number.isSafeInteger(projectInput.expectedCollectionRevision)
          || (projectInput.expectedCollectionRevision ?? 0) < 1) {
          return makeFailure('VALIDATION_ERROR', 'expectedCollectionRevision must be a positive integer');
        }
      } else if (!collectionName || !collectionKind) {
        // 集合的稳定身份与业务类型必须显式声明，绝不从文件名、目录、mime 或 pathKind 推断。
        return makeFailure('VALIDATION_ERROR', 'A new logical artifact collection requires an explicit name and kind');
      }
      const lineageInput = Array.isArray(projectInput.lineage) ? projectInput.lineage : [];
      if (lineageInput.some((ref) => !ref || !isProjectArtifactLineageKind(ref.kind) || !normalizeOptionalId(ref.refId))) {
        return makeFailure('VALIDATION_ERROR', 'lineage entries require a supported kind and refId');
      }
      const normalizedLineage: ProjectArtifactLineageRefDto[] = lineageInput.map((ref) => ({
        kind: ref.kind,
        refId: normalizeOptionalId(ref.refId) as string,
      }));
      const normalizedRequest = {
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        artifactId,
        stageId,
        ...(requestedCollectionId
          ? {
            collectionId: requestedCollectionId,
            expectedCollectionRevision: projectInput.expectedCollectionRevision,
          }
          : { collection: { name: collectionName, kind: collectionKind } }),
        lineage: normalizedLineage,
        ...(sourceInvocationId ? { sourceInvocationId } : {}),
      };
      const requestFingerprint = createHash('sha256')
        .update(JSON.stringify(normalizedRequest))
        .digest('hex');
      const existingMutation = await repositories.channelProjects.getArtifactMutation({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        idempotencyKey,
      });
      if (existingMutation) {
        if (existingMutation.requestFingerprint !== requestFingerprint) {
          return makeFailure('CONFLICT', 'idempotencyKey was already used for a different project artifact mutation');
        }
        const replayed = await projectArtifactPromotionResult(repositories, channel, {
          collectionId: existingMutation.collectionId,
          versionId: existingMutation.versionId,
        });
        if (!replayed) {
          return makeFailure('CONFLICT', 'Recorded project artifact mutation result is no longer available');
        }
        return makeSuccess({ ...replayed, replayed: true });
      }
      // 归档频道保持集合与版本可读，但拒绝提升与新增版本。
      if (channel.archivedAt != null) {
        return makeFailure('CONFLICT', 'Archived channels are read-only');
      }
      const profile = await repositories.channelProjects.getProfile({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      if (!profile) {
        return makeFailure('NOT_FOUND', 'Channel project profile not found');
      }
      const actorRole = await repositories.teams.getMemberRole(projectInput.teamId, projectInput.userId);
      if (profile.projectLeadId !== projectInput.userId && actorRole !== 'owner' && actorRole !== 'admin') {
        return makeFailure('FORBIDDEN', 'Only the project lead or a Team owner/admin can promote project artifacts');
      }
      const artifact = await repositories.artifacts.getForTeam({
        teamId: projectInput.teamId,
        artifactId,
      });
      if (!artifact
        || artifact.channelId !== projectInput.channelId
        || isWorkspaceRunLogArtifact(artifact)
        || !(await isPublicChannelFileArtifact(repositories, artifact))) {
        return makeFailure('NOT_FOUND', 'Artifact is not visible in this Team and Channel');
      }
      const stages = await repositories.channelProjects.listStages({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const stage = stages.find((candidate) => candidate.id === stageId);
      if (!stage) {
        return makeFailure('NOT_FOUND', 'Project Stage not found in this Team and Channel');
      }
      const task = await repositories.tasks.getById(stage.taskId);
      if (!task || task.teamId !== projectInput.teamId || task.channelId !== projectInput.channelId) {
        return makeFailure('NOT_FOUND', 'Stage Tracked Task not found in this Team and Channel');
      }
      if (sourceInvocationId) {
        const invocation = await repositories.management.invocations.getById(sourceInvocationId);
        if (!invocation
          || invocation.intent.teamId !== projectInput.teamId
          || invocation.intent.channelId !== projectInput.channelId) {
          return makeFailure('NOT_FOUND', 'Source Invocation is not visible in this Team and Channel');
        }
        const taskContext = invocation.intent.taskContext;
        if (taskContext
          && (taskContext.taskId !== task.id || taskContext.taskRevision !== task.revision)) {
          // 旧 Task revision 的 Agent 结果不得污染当前任务的项目产物。
          return makeFailure('CONFLICT', 'Source Invocation targets a stale Task revision');
        }
      }
      const lineageCandidates: ProjectArtifactLineageCandidate[] = [];
      for (const ref of normalizedLineage) {
        lineageCandidates.push({
          ...ref,
          scope: await resolveProjectArtifactLineageScope(repositories, projectInput, ref),
        });
      }
      const lineageEvaluation = evaluateProjectArtifactLineage({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        promotedArtifactId: artifactId,
        candidates: lineageCandidates,
      });
      if (!lineageEvaluation.ok) {
        return makeFailure(
          lineageEvaluation.reasonCode === 'lineage_out_of_scope' ? 'NOT_FOUND' : 'VALIDATION_ERROR',
          `Project artifact lineage rejected: ${lineageEvaluation.reasonCode}`,
        );
      }
      const collections = await repositories.channelProjects.listArtifactCollections({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const targetCollection = requestedCollectionId
        ? collections.find((candidate) => candidate.id === requestedCollectionId) ?? null
        : null;
      const existingVersionForArtifact = await repositories.channelProjects.getArtifactVersionByArtifact({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        artifactId,
      });
      const decision = evaluateArtifactPromotion({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        ...(requestedCollectionId
          ? {
            requestedCollectionId,
            expectedCollectionRevision: projectInput.expectedCollectionRevision,
          }
          : {}),
        ...(collectionName ? { requestedCollectionName: collectionName } : {}),
        targetCollection: targetCollection === null ? null : {
          id: targetCollection.id,
          teamId: targetCollection.teamId,
          channelId: targetCollection.channelId,
          name: targetCollection.name,
          revision: targetCollection.revision,
          versionCount: targetCollection.versionCount,
        },
        existingCollectionNames: collections.map((candidate) => candidate.name),
        existingVersionForArtifact: existingVersionForArtifact === null ? null : {
          id: existingVersionForArtifact.id,
          collectionId: existingVersionForArtifact.collectionId,
        },
      });
      if (decision.kind === 'rejected') {
        return projectArtifactPromotionFailure(decision.reasonCode);
      }
      if (decision.kind === 'replay_existing_version') {
        const replayed = await projectArtifactPromotionResult(repositories, channel, {
          collectionId: decision.collectionId,
          versionId: decision.versionId,
        });
        if (!replayed) return makeFailure('NOT_FOUND', 'Promoted project artifact version not found');
        return makeSuccess({ ...replayed, replayed: true });
      }

      const now = clock.now();
      const versionId = ids.nextId();
      const collectionId = decision.kind === 'create_collection' ? ids.nextId() : decision.collectionId;
      const collectionRecord: ProjectArtifactCollectionRecord = decision.kind === 'create_collection'
        ? {
          id: collectionId,
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
          name: collectionName as string,
          kind: collectionKind as string,
          revision: decision.collectionRevision,
          currentVersionId: versionId,
          versionCount: decision.versionNumber,
          createdBy: projectInput.userId,
          createdAt: now,
          updatedAt: now,
        }
        : {
          ...(targetCollection as ProjectArtifactCollectionRecord),
          revision: decision.collectionRevision,
          currentVersionId: versionId,
          versionCount: decision.versionNumber,
          updatedAt: now,
        };
      const versionRecord: ProjectArtifactVersionRecord = {
        id: versionId,
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        collectionId,
        versionNumber: decision.versionNumber,
        artifactId,
        stageId: stage.id,
        taskId: task.id,
        taskRevision: task.revision,
        // 来源消息与 Workspace Run 取自 Artifact 自身的持久化事实，不接受客户端提交。
        ...(artifact.messageId === undefined ? {} : { sourceMessageId: artifact.messageId }),
        ...(artifact.workspaceRunId === undefined ? {} : { sourceWorkspaceRunId: artifact.workspaceRunId }),
        ...(sourceInvocationId ? { sourceInvocationId } : {}),
        lineage: lineageEvaluation.lineage,
        promotedBy: projectInput.userId,
        createdAt: now,
      };
      const result = await repositories.channelProjects.promoteArtifact({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        ...(decision.kind === 'append_version'
          ? { expectedCollectionRevision: projectInput.expectedCollectionRevision }
          : {}),
        collection: collectionRecord,
        createsCollection: decision.kind === 'create_collection',
        version: versionRecord,
        mutation: {
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
          idempotencyKey,
          requestFingerprint,
          collectionId,
          versionId,
          createdAt: now,
        },
      });
      if (result.kind === 'idempotency_conflict') {
        return makeFailure('CONFLICT', 'idempotencyKey was already used for a different project artifact mutation');
      }
      if (result.kind === 'collection_revision_conflict') {
        return makeFailure('CONFLICT', 'Project artifact collection revision is stale; refresh and retry');
      }
      if (result.kind === 'collection_name_conflict') {
        return makeFailure('CONFLICT', 'A logical artifact collection with this name already exists');
      }
      if (result.kind === 'collection_scope_conflict') {
        return makeFailure('CONFLICT', 'Project artifact collection changed scope; refresh and retry');
      }
      if (result.kind === 'artifact_scope_conflict') {
        return makeFailure('CONFLICT', 'Artifact changed scope; refresh and retry');
      }
      if (result.kind === 'stage_scope_conflict') {
        return makeFailure('CONFLICT', 'Project Stage changed scope; refresh and retry');
      }
      if (result.kind === 'task_scope_conflict') {
        return makeFailure('CONFLICT', 'Stage Tracked Task changed scope or revision; refresh and retry');
      }
      if (result.kind === 'artifact_promoted_to_other_collection') {
        return makeFailure('CONFLICT', 'Artifact is already promoted into another logical artifact collection');
      }
      const projection = await projectArtifactPromotionResult(repositories, channel, {
        collectionId: result.collection.id,
        versionId: result.version.id,
      });
      if (!projection) return makeFailure('NOT_FOUND', 'Promoted project artifact version not found');
      return makeSuccess({ ...projection, replayed: result.kind === 'replayed' });
    },

    async submitArtifactReview(projectInput) {
      if (!projectCollaborationRollout.reviewFinalization) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project artifact review and finalization are disabled');
      }
      if (!(await repositories.teams.isMember(projectInput.teamId, projectInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, projectInput);
      if (!access.ok) return access;
      const { channel } = access;
      if (channel.kind !== 'channel') {
        return makeFailure('VALIDATION_ERROR', 'Project artifact reviews require a regular channel');
      }
      const idempotencyKey = typeof projectInput.idempotencyKey === 'string'
        ? projectInput.idempotencyKey.trim()
        : '';
      const versionId = normalizeOptionalId(projectInput.versionId);
      if (!idempotencyKey || !versionId) {
        return makeFailure('VALIDATION_ERROR', 'idempotencyKey and versionId are required');
      }
      if (!isProjectArtifactReviewDecision(projectInput.decision)) {
        return makeFailure('VALIDATION_ERROR', 'Unsupported project artifact review decision');
      }
      const basisInput = Array.isArray(projectInput.basis) ? projectInput.basis : [];
      if (basisInput.length === 0 || basisInput.some((ref) =>
        !ref || !isProjectArtifactReviewBasisKind(ref.kind) || !normalizeOptionalId(ref.refId))) {
        return makeFailure(
          'VALIDATION_ERROR',
          'At least one review basis entry with a supported kind and refId is required',
        );
      }
      const basis: ProjectArtifactReviewBasisRefDto[] = basisInput.map((ref) => ({
        kind: ref.kind,
        refId: normalizeOptionalId(ref.refId) as string,
      }));
      const comment = typeof projectInput.comment === 'string' ? projectInput.comment.trim() : '';
      if (!comment) {
        return makeFailure('VALIDATION_ERROR', 'Review comment is required');
      }
      const versions = await repositories.channelProjects.listArtifactVersions({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const version = versions.find((candidate) => candidate.id === versionId);
      if (!version) {
        return makeFailure('NOT_FOUND', 'Project artifact version not found in this Team and Channel');
      }
      const stages = await repositories.channelProjects.listStages({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const stage = stages.find((candidate) => candidate.id === version.stageId);
      if (!stage) {
        return makeFailure('NOT_FOUND', 'Project artifact version Stage not found in this Team and Channel');
      }
      for (const ref of basis) {
        const scope = await resolveProjectArtifactLineageScope(repositories, projectInput, ref);
        if (!scope
          || scope.teamId !== projectInput.teamId
          || scope.channelId !== projectInput.channelId) {
          return makeFailure('NOT_FOUND', 'Review basis is not visible in this Team and Channel');
        }
      }
      const profile = await repositories.channelProjects.getProfile({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      if (!profile) return makeFailure('NOT_FOUND', 'Channel project profile not found');
      const actorFacts = await projectArtifactAuthorityFacts(
        repositories,
        projectInput.teamId,
        projectInput.userId,
        profile,
        stage,
      );
      const authority = evaluateArtifactReviewAuthority({
        actorKind: 'human',
        facts: actorFacts,
        decision: projectInput.decision,
      });
      if (authority.kind === 'rejected') {
        return makeFailure('FORBIDDEN', 'User cannot review this project artifact version');
      }
      const requestFingerprint = createHash('sha256')
        .update(JSON.stringify({
          kind: 'review',
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
          versionId,
          decision: projectInput.decision,
          comment,
          basis,
        }))
        .digest('hex');
      const existingMutation = await repositories.channelProjects.getArtifactDecisionMutation({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        idempotencyKey,
      });
      if (existingMutation) {
        if (existingMutation.requestFingerprint !== requestFingerprint
          || existingMutation.kind !== 'review'
          || !existingMutation.reviewId) {
          return makeFailure('CONFLICT', 'idempotencyKey was already used for a different artifact decision');
        }
        const reviews = await repositories.channelProjects.listArtifactReviews({
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
        });
        const review = reviews.find((candidate) => candidate.id === existingMutation.reviewId);
        const projection = await projectArtifactPromotionResult(repositories, channel, {
          collectionId: existingMutation.collectionId,
          versionId: existingMutation.versionId,
        });
        if (!review || !projection) {
          return makeFailure('CONFLICT', 'Recorded artifact review result is no longer available');
        }
        return makeSuccess({ ...projection, review: projectArtifactReviewDto(review), replayed: true });
      }
      if (channel.archivedAt != null) {
        return makeFailure('CONFLICT', 'Archived channels are read-only');
      }
      const now = clock.now();
      const review: ProjectArtifactReviewRecord = {
        id: ids.nextId(),
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        collectionId: version.collectionId,
        versionId: version.id,
        // stage 已在上方按 version.stageId 找到(stage-less 交付版本在 L8111 处 fail-closed)。
        stageId: stage.id,
        // #1061：记录本次审核依据的 authority basis(基于已通过的 #824 authority 判定)。
        authorityBasis: deriveAuthorityBasis(actorFacts),
        decision: projectInput.decision,
        comment,
        basis,
        reviewedBy: projectInput.userId,
        createdAt: now,
      };
      const mutation: ProjectArtifactDecisionMutationRecord = {
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        idempotencyKey,
        requestFingerprint,
        kind: 'review',
        collectionId: version.collectionId,
        versionId: version.id,
        reviewId: review.id,
        createdAt: now,
      };
      const result = await repositories.channelProjects.appendArtifactReview({ review, mutation });
      if (result.kind === 'idempotency_conflict') {
        return makeFailure('CONFLICT', 'idempotencyKey was already used for a different artifact decision');
      }
      if (result.kind === 'version_scope_conflict') {
        return makeFailure('CONFLICT', 'Project artifact version scope changed; refresh and retry');
      }
      const projection = await projectArtifactPromotionResult(repositories, channel, {
        collectionId: result.review.collectionId,
        versionId: result.review.versionId,
      });
      if (!projection) return makeFailure('NOT_FOUND', 'Reviewed project artifact version not found');
      try {
        await input.onProjectFactsChanged?.({
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
        });
      } catch {
        // 审核事实已经持久化；推进器失败由阶段投影显示等待原因，不回滚人工决定。
      }
      return makeSuccess({
        ...projection,
        review: projectArtifactReviewDto(result.review),
        replayed: result.kind === 'replayed',
      });
    },

    async setArtifactFinalVersion(projectInput) {
      if (!projectCollaborationRollout.reviewFinalization) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project artifact review and finalization are disabled');
      }
      if (!(await repositories.teams.isMember(projectInput.teamId, projectInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, projectInput);
      if (!access.ok) return access;
      const { channel } = access;
      if (channel.kind !== 'channel') {
        return makeFailure('VALIDATION_ERROR', 'Project artifact finalization requires a regular channel');
      }
      const idempotencyKey = typeof projectInput.idempotencyKey === 'string'
        ? projectInput.idempotencyKey.trim()
        : '';
      const collectionId = normalizeOptionalId(projectInput.collectionId);
      const versionId = normalizeOptionalId(projectInput.versionId);
      if (!idempotencyKey || !collectionId || !versionId) {
        return makeFailure(
          'VALIDATION_ERROR',
          'idempotencyKey, collectionId and versionId are required',
        );
      }
      if (!Number.isSafeInteger(projectInput.expectedCollectionRevision)
        || projectInput.expectedCollectionRevision < 1) {
        return makeFailure(
          'VALIDATION_ERROR',
          'expectedCollectionRevision must be a positive integer',
        );
      }
      const reason = normalizeOptionalText(projectInput.reason);
      const collections = await repositories.channelProjects.listArtifactCollections({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const collection = collections.find((candidate) => candidate.id === collectionId) ?? null;
      const versions = await repositories.channelProjects.listArtifactVersions({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const version = versions.find((candidate) => candidate.id === versionId) ?? null;
      const reviews = await repositories.channelProjects.listArtifactReviews({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const versionReviews = reviews.filter((review) => review.versionId === versionId);
      const stages = await repositories.channelProjects.listStages({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      const stage = version
        ? stages.find((candidate) => candidate.id === version.stageId) ?? null
        : null;
      const profile = await repositories.channelProjects.getProfile({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
      });
      if (!profile) return makeFailure('NOT_FOUND', 'Channel project profile not found');
      if (version && !stage) {
        return makeFailure('NOT_FOUND', 'Project artifact version Stage not found in this Team and Channel');
      }

      let actorKind: 'human' | 'pi_manager' = 'human';
      let finalizedBy = projectInput.userId;
      let managementRunId: string | undefined;
      let humanConfirmation: ProjectArtifactFinalizationRecord['humanConfirmation'];
      let confirmationFacts:
        | { confirmedBy: string; confirmerFacts: ProjectArtifactAuthorityFacts }
        | null
        | undefined;
      let actorFacts = await projectArtifactAuthorityFacts(
        repositories,
        projectInput.teamId,
        projectInput.userId,
        profile,
        stage,
      );
      if (projectInput.manager !== undefined) {
        actorKind = 'pi_manager';
        managementRunId = normalizeOptionalId(projectInput.manager.managementRunId);
        const confirmation = projectInput.manager.humanConfirmation;
        const confirmationRefId = normalizeOptionalId(confirmation?.refId);
        const confirmedBy = normalizeOptionalId(confirmation?.confirmedBy);
        if (!managementRunId
          || confirmation?.kind !== 'message'
          || !confirmationRefId
          || !confirmedBy) {
          return makeFailure('VALIDATION_ERROR', 'Manager finalization requires a message confirmation');
        }
        const managementRun = await repositories.management.runs.getById(managementRunId);
        if (!managementRun
          || managementRun.teamId !== projectInput.teamId
          || managementRun.channelId !== projectInput.channelId
          || managementRun.initiatedByUserId !== confirmedBy) {
          return makeFailure(
            'FORBIDDEN',
            'Manager finalization run is invalid, out of scope, or not bound to the confirmer',
          );
        }
        const message = await repositories.messages.getById(confirmationRefId);
        if (!message
          || message.teamId !== projectInput.teamId
          || message.channelId !== projectInput.channelId
          || message.senderKind !== 'human'
          || message.senderId !== confirmedBy
          || message.threadId !== managementRun.rootMessageId
          || message.body.trim() !== projectArtifactFinalizationConfirmationText(
            collectionId,
            versionId,
            projectInput.expectedCollectionRevision,
          )) {
          return makeFailure('FORBIDDEN', 'Manager human confirmation is invalid or out of scope');
        }
        humanConfirmation = { kind: 'message', refId: confirmationRefId, confirmedBy };
        finalizedBy = confirmedBy;
        const confirmerFacts = await projectArtifactAuthorityFacts(
          repositories,
          projectInput.teamId,
          confirmedBy,
          profile,
          stage,
        );
        confirmationFacts = { confirmedBy, confirmerFacts };
        // Manager 代表人类行使权限；Server 已复验确认消息，策略仍会再次验证确认人的权限事实。
        actorFacts = confirmerFacts;
      }
      const requestFingerprint = createHash('sha256')
        .update(JSON.stringify({
          kind: 'finalization',
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
          collectionId,
          versionId,
          expectedCollectionRevision: projectInput.expectedCollectionRevision,
          reason: reason ?? null,
          manager: managementRunId && humanConfirmation
            ? { managementRunId, humanConfirmation }
            : null,
        }))
        .digest('hex');
      const decision = evaluateProjectArtifactFinalization({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        actorKind,
        actorFacts,
        ...(confirmationFacts === undefined ? {} : { humanConfirmation: confirmationFacts }),
        collection,
        expectedCollectionRevision: projectInput.expectedCollectionRevision,
        targetVersion: version
          ? { id: version.id, collectionId: version.collectionId, reviews: versionReviews }
          : null,
      });
      if (decision.kind === 'rejected') {
        return projectArtifactFinalizationFailure(decision.reasonCode);
      }
      const existingMutation = await repositories.channelProjects.getArtifactDecisionMutation({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        idempotencyKey,
      });
      if (existingMutation
        && (existingMutation.requestFingerprint !== requestFingerprint
          || existingMutation.kind !== 'finalization'
          || !existingMutation.finalizationId)) {
        return makeFailure('CONFLICT', 'idempotencyKey was already used for a different artifact decision');
      }
      if (decision.kind === 'replay_current_final' || existingMutation) {
        const finalizations = await repositories.channelProjects.listArtifactFinalizations({
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
        });
        const finalization = existingMutation?.finalizationId
          ? finalizations.find((candidate) => candidate.id === existingMutation.finalizationId)
          : finalizations
            .filter((candidate) =>
              candidate.collectionId === collectionId && candidate.versionId === versionId)
            .sort((left, right) =>
              right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
        const projection = await projectArtifactPromotionResult(repositories, channel, {
          collectionId,
          versionId,
        });
        if (!finalization || !projection) {
          return makeFailure('CONFLICT', 'Recorded artifact finalization result is no longer available');
        }
        return makeSuccess({
          ...projection,
          finalization: projectArtifactFinalizationDto(finalization),
          replayed: true,
        });
      }
      if (channel.archivedAt != null) {
        return makeFailure('CONFLICT', 'Archived channels are read-only');
      }
      const now = clock.now();
      const finalization: ProjectArtifactFinalizationRecord = {
        id: ids.nextId(),
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        collectionId,
        versionId,
        ...(decision.previousVersionId === undefined
          ? {}
          : { previousVersionId: decision.previousVersionId }),
        basisReviewId: decision.basisReviewId,
        actorKind,
        finalizedBy,
        ...(managementRunId === undefined ? {} : { managementRunId }),
        ...(humanConfirmation === undefined ? {} : { humanConfirmation }),
        ...(reason === undefined ? {} : { reason }),
        createdAt: now,
      };
      const mutation: ProjectArtifactDecisionMutationRecord = {
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        idempotencyKey,
        requestFingerprint,
        kind: 'finalization',
        collectionId,
        versionId,
        finalizationId: finalization.id,
        createdAt: now,
      };
      const result = await repositories.channelProjects.setArtifactFinalVersion({
        teamId: projectInput.teamId,
        channelId: projectInput.channelId,
        collectionId,
        expectedCollectionRevision: projectInput.expectedCollectionRevision,
        nextRevision: decision.collectionRevision,
        updatedAt: now,
        finalization,
        mutation,
      });
      if (result.kind === 'idempotency_conflict') {
        return makeFailure('CONFLICT', 'idempotencyKey was already used for a different artifact decision');
      }
      if (result.kind === 'collection_revision_conflict') {
        return makeFailure('CONFLICT', 'Project artifact collection revision is stale; refresh and retry');
      }
      if (result.kind === 'version_scope_conflict') {
        return makeFailure('CONFLICT', 'Project artifact version scope changed; refresh and retry');
      }
      if (result.kind === 'review_basis_conflict') {
        return makeFailure('CONFLICT', 'Project artifact review state changed; refresh and retry');
      }
      const projection = await projectArtifactPromotionResult(repositories, channel, {
        collectionId: result.collection.id,
        versionId: result.finalization.versionId,
      });
      if (!projection) return makeFailure('NOT_FOUND', 'Finalized project artifact version not found');
      try {
        await input.onProjectFactsChanged?.({
          teamId: projectInput.teamId,
          channelId: projectInput.channelId,
        });
      } catch {
        // 最终化已经成功；推进失败不允许反向改写人类最终化事实。
      }
      return makeSuccess({
        ...projection,
        finalization: projectArtifactFinalizationDto(result.finalization),
        replayed: result.kind === 'replayed',
      });
    },

    // #1059 候选 01/02 深化：review 核心（handler 调用 + 水位推进）下沉到 OutputPackageService；
    // wrapper 只留 transport 面向的 ack 整形（project-artifact 投影，属另一边界，切片 2 决议）。
    async submitPackageArtifactReview(reviewInput) {
      const result = await outputPackageService.submitReview({
        teamId: reviewInput.teamId,
        userId: reviewInput.userId,
        channelId: reviewInput.channelId,
        packageId: reviewInput.packageId,
        collectionId: reviewInput.collectionId,
        versionId: reviewInput.versionId,
        decision: reviewInput.decision,
        comment: reviewInput.comment,
        idempotencyKey: reviewInput.idempotencyKey,
      });
      return packageReviewCommandAck(repositories, result, 'review');
    },

    async submitPackageReviewAndFinalize(reviewInput) {
      const result = await outputPackageService.finalize({
        teamId: reviewInput.teamId,
        userId: reviewInput.userId,
        channelId: reviewInput.channelId,
        packageId: reviewInput.packageId,
        collectionId: reviewInput.collectionId,
        versionId: reviewInput.versionId,
        decision: reviewInput.decision,
        comment: reviewInput.comment,
        idempotencyKey: reviewInput.idempotencyKey,
        expectedCollectionRevision: reviewInput.expectedCollectionRevision,
      });
      return packageReviewCommandAck(repositories, result, 'finalize');
    },

    async submitPackageReviewAndRejectDelivery(reviewInput) {
      const result = await outputPackageService.rejectDelivery({
        teamId: reviewInput.teamId,
        userId: reviewInput.userId,
        channelId: reviewInput.channelId,
        packageId: reviewInput.packageId,
        collectionId: reviewInput.collectionId,
        versionId: reviewInput.versionId,
        decision: reviewInput.decision,
        comment: reviewInput.comment,
        idempotencyKey: reviewInput.idempotencyKey,
        expectedTaskRevision: reviewInput.expectedTaskRevision,
        expectedTaskAttempt: reviewInput.expectedTaskAttempt,
        rejectReason: reviewInput.rejectReason,
      });
      return packageReviewCommandAck(repositories, result, 'reject-delivery');
    },

    async listProjectDocumentBundles(bundleInput) {
      if (!projectCollaborationRollout.bundleSelection) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project document Bundle and Selection are disabled');
      }
      if (!(await repositories.teams.isMember(bundleInput.teamId, bundleInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, bundleInput);
      if (!access.ok) return access;
      const records = await repositories.projectDocumentBundles.list({
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
      });
      return makeSuccess({
        bundles: records.map(toProjectDocumentBundleDto),
        archived: access.channel.archivedAt != null,
      });
    },

    async getProjectDocumentBundle(bundleInput) {
      if (!projectCollaborationRollout.bundleSelection) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project document Bundle and Selection are disabled');
      }
      if (!(await repositories.teams.isMember(bundleInput.teamId, bundleInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      // 归档频道保持可读：此处不做 archivedAt 拦截，只有创建路径拒绝写入。
      const access = await ensureUserCanViewChannel(repositories, bundleInput);
      if (!access.ok) return access;
      const record = await repositories.projectDocumentBundles.getById({
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
        bundleId: bundleInput.bundleId,
      });
      if (!record) return makeFailure('NOT_FOUND', 'Document bundle not found');
      return makeSuccess({
        bundle: await toProjectDocumentBundleDetailDto(repositories, record),
        archived: access.channel.archivedAt != null,
      });
    },

    // #1060 OutputPackage 查询:三处投影(讨论串/Task/Files)共用同一 Server 事实。
    async listOutputPackages(packageInput) {
      // AC10:运行时 exact-key 校验,拒绝未知字段;不以 TypeScript interface 代替运行时合同。
      // userId/teamId/currentDeviceId 是 Server 从 session 注入的权威字段,不属于 wire payload,校验前剥离。
      // currentDeviceId 由 socket bind 层的 withAuthenticatedUserId 无条件注入(设备态需要),
      // 必须与 userId/teamId 一同剥离,否则 assertExactKeys 拒绝未知字段 → OUTPUT_PACKAGE_PAYLOAD_INVALID。
      const { userId, teamId, currentDeviceId, ...wireInput } = packageInput;
      const parsed = parseOutputPackageQueryInputV1('list-channel-output-packages', wireInput) as typeof packageInput;
      parsed.userId = userId;
      parsed.teamId = teamId;
      if (!(await repositories.teams.isMember(parsed.teamId, parsed.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, parsed);
      if (!access.ok) return access;
      // #1065 AC7：带 minimumConsistency 时对照 output-package stream 水位,
      // 投影未追到最低位置 → projection_not_ready,不以旧数据伪装成功。
      const notReady = await ensureOutputPackageConsistency(repositories, parsed.minimumConsistency);
      if (notReady) return notReady;
      const limit = parsed.limit ?? 50;
      const records = await repositories.outputPackages.listPackagesByChannel({
        teamId: parsed.teamId,
        channelId: parsed.channelId,
        ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
        limit: limit + 1,
        ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
      });
      const hasMore = records.length > limit;
      const page = hasMore ? records.slice(0, limit) : records;
      // #1061 AC11：summary 携带成员 reviewState 的聚合(Server 计算,Files/Task 直接展示)。
      // #1065：与 Task 交付聚合视图共用同一组 Server 事实(summarizeOutputPackages)。
      const summaries = await summarizeOutputPackages(
        repositories,
        { teamId: parsed.teamId, channelId: parsed.channelId },
        page,
      );
      // pendingDeliveries:committed 且有 provenance 但尚未形成 package 的交付(UI「交付处理中」)。
      // 差集必须基于**全频道**已形成 publishId(分页会漏判后页已成形 package);taskId 过滤与 packages 一致。
      const pendingDeliveries = await listPendingOutputDeliveries(repositories, {
        teamId: parsed.teamId,
        channelId: parsed.channelId,
        ...(parsed.taskId ? { taskId: parsed.taskId } : {}),
      });
      return makeSuccess({
        packages: summaries,
        pendingDeliveries,
        ...(hasMore && page.length > 0
          ? { nextCursor: { createdAt: page[page.length - 1]!.createdAt, packageId: page[page.length - 1]!.packageId } }
          : {}),
      });
    },

    async getOutputPackage(packageInput) {
      // AC10:运行时 exact-key 校验(剥离注入字段后;含 currentDeviceId,同 listOutputPackages)。
      const { userId, teamId, currentDeviceId, ...wireInput } = packageInput;
      const parsed = parseOutputPackageQueryInputV1('get-output-package', wireInput) as typeof packageInput;
      parsed.userId = userId;
      parsed.teamId = teamId;
      if (!(await repositories.teams.isMember(parsed.teamId, parsed.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, parsed);
      if (!access.ok) return access;
      // #1065 AC7：与 listOutputPackages 同一水位检查(三处投影共用同一 Server 事实)。
      const notReady = await ensureOutputPackageConsistency(repositories, parsed.minimumConsistency);
      if (notReady) return notReady;
      const result = await repositories.outputPackages.getPackageById({
        teamId: parsed.teamId,
        packageId: parsed.packageId,
      });
      if (!result || result.package.channelId !== packageInput.channelId) {
        return makeFailure('NOT_FOUND', 'Output package not found');
      }
      // #1061 AC11：Server 按当前用户计算可执行动作,web 只渲染 Server 给的动作。
      const availableActions = await computePackageMemberAvailableActions(repositories, {
        teamId: parsed.teamId,
        userId: parsed.userId,
        channelId: parsed.channelId,
        packageProjection: result,
      });
      // #1063 projection 块:按请求策略解析 delivered/current/final/specified,
      // 返回 asOf 水位与 audienceScope(合同已冻结、本票真正接线)。
      const projection = parsed.projection
        ? await computeOutputPackageProjection(repositories, {
          teamId: parsed.teamId,
          channelId: parsed.channelId,
          packageProjection: result,
          policy: parsed.projection.policy,
          specifiedVersions: parsed.projection.versions,
        })
        : undefined;
      const asOf = clock.now();
      return makeSuccess({
        package: toOutputPackageDto(result.package, result.members),
        availableActions,
        ...(projection ? { projection } : {}),
        asOf,
        audienceScope: `${parsed.teamId}:${parsed.channelId}:${parsed.userId}`,
      });
    },

    async queryTaskDeliveryOverview(overviewInput) {
      const { userId, teamId } = overviewInput;
      if (!(await repositories.teams.isMember(teamId, userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, {
        userId,
        teamId,
        channelId: overviewInput.channelId,
      });
      if (!access.ok) return access;
      // #1065 AC7：与 output-package 查询同一水位语义,投影未追上 → not_ready。
      const notReady = await ensureOutputPackageConsistency(repositories, overviewInput.minimumConsistency);
      if (notReady) return notReady;
      const overview = await buildTaskDeliveryOverview(repositories, {
        teamId,
        channelId: overviewInput.channelId,
        taskId: overviewInput.taskId,
        userId,
        now: clock.now(),
        piHealthy: await resolveProjectPiHealthy(),
        includeStage: projectCollaborationRollout.projectStage,
        ...(input.resolveProjectStageCandidates
          ? { resolveProjectStageCandidates: input.resolveProjectStageCandidates }
          : {}),
      });
      if (!overview) {
        return makeFailure('NOT_FOUND', 'Task delivery overview not found');
      }
      return makeSuccess({ overview });
    },

    async createProjectDocumentBundle(bundleInput) {
      if (!projectCollaborationRollout.bundleSelection) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project document Bundle and Selection are disabled');
      }
      if (!(await repositories.teams.isMember(bundleInput.teamId, bundleInput.userId))) {
        return bundleFailure('FORBIDDEN', 'User is not a team member', 'not_team_member');
      }
      const access = await ensureUserCanViewChannel(repositories, bundleInput);
      if (!access.ok) return access;
      const { channel } = access;
      const idempotencyKey = normalizeOptionalText(bundleInput.idempotencyKey);
      if (!idempotencyKey) {
        return bundleFailure('VALIDATION_ERROR', 'idempotencyKey is required', 'invalid_request');
      }
      const name = normalizeOptionalText(bundleInput.name);
      if (!name) {
        return bundleFailure('VALIDATION_ERROR', 'Bundle name is required', 'invalid_request');
      }
      const workspaceRunId = normalizeOptionalId(bundleInput.workspaceRunId);
      if (!workspaceRunId) {
        return bundleFailure('VALIDATION_ERROR', 'workspaceRunId is required', 'invalid_request');
      }
      // 保留调用方给定的顺序，只在同一 documentId 重复出现时由 domain 判为 duplicate。
      const documentIds = Array.isArray(bundleInput.documentIds)
        ? bundleInput.documentIds.map((id) => normalizeOptionalId(id)).filter((id): id is string => Boolean(id))
        : [];
      if (documentIds.length === 0) {
        return bundleFailure(
          'VALIDATION_ERROR', 'At least one Markdown document is required', 'invalid_request',
        );
      }
      const requestFingerprint = createHash('sha256')
        .update(JSON.stringify({
          teamId: bundleInput.teamId,
          channelId: bundleInput.channelId,
          name,
          workspaceRunId,
          documentIds,
        }))
        .digest('hex');
      const existingMutation = await repositories.projectDocumentBundles.getMutation({
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
        idempotencyKey,
      });
      if (existingMutation) {
        if (existingMutation.requestFingerprint !== requestFingerprint) {
          return bundleFailure(
            'CONFLICT', 'idempotencyKey was already used for a different bundle', 'idempotency_conflict',
          );
        }
        const replayedRecord = await repositories.projectDocumentBundles.getById({
          teamId: bundleInput.teamId,
          channelId: bundleInput.channelId,
          bundleId: existingMutation.bundleId,
        });
        if (!replayedRecord) {
          return bundleFailure('NOT_FOUND', 'Document bundle not found', 'bundle_unavailable');
        }
        return makeSuccess({
          bundle: await toProjectDocumentBundleDetailDto(repositories, replayedRecord),
          archived: channel.archivedAt != null,
          replayed: true,
        });
      }
      if (channel.archivedAt != null) {
        return bundleFailure('CONFLICT', 'Archived channels are read-only', 'channel_archived');
      }
      const actorRole = await repositories.teams.getMemberRole(bundleInput.teamId, bundleInput.userId);
      const profile = await repositories.channelProjects.getProfile({
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
      });
      if (channel.createdBy !== bundleInput.userId
        && profile?.projectLeadId !== bundleInput.userId
        && actorRole !== 'owner'
        && actorRole !== 'admin') {
        return bundleFailure(
          'FORBIDDEN', 'User cannot create document bundles in this channel', 'actor_not_authorized',
        );
      }

      const run = await repositories.workspaceRuns.getForTeam({
        teamId: bundleInput.teamId,
        runId: workspaceRunId,
      });
      if (!run || run.channelId !== bundleInput.channelId) {
        return bundleFailure(
          'NOT_FOUND', 'Workspace Run not found in this Team and Channel', 'run_unavailable',
        );
      }
      if (!(await isPublicWorkspaceRun(repositories, run))) {
        return bundleFailure(
          'FORBIDDEN',
          'Workspace Run output is not publicly visible in this channel',
          'run_not_public',
        );
      }
      const source = await resolveProjectDocumentBundleSource(repositories, run);
      if (!source.ok) return source;

      const candidates: ProjectDocumentBundleMemberCandidate[] = [];
      const unresolved: string[] = [];
      for (const documentId of documentIds) {
        const candidate = await loadProjectDocumentBundleCandidate(repositories, {
          teamId: bundleInput.teamId,
          channelId: bundleInput.channelId,
          documentId,
        });
        if (!candidate) {
          unresolved.push(documentId);
          continue;
        }
        candidates.push(candidate);
      }
      if (unresolved.length > 0) {
        const rejections = unresolved.map((documentId) => ({ documentId, code: 'not_found' as const }));
        return bundleFailure(
          'NOT_FOUND',
          `Document bundle members are unavailable: ${describeBundleRejections(rejections)}`,
          'members_unavailable',
          rejections,
        );
      }
      const composition = evaluateBundleComposition(candidates, {
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
        workspaceRunId,
      });
      if (composition.rejections.length > 0) {
        return bundleFailure(
          'VALIDATION_ERROR',
          `Document bundle members are ineligible: ${describeBundleRejections(composition.rejections)}`,
          'members_ineligible',
          composition.rejections,
        );
      }

      const now = clock.now();
      const bundleId = ids.nextId();
      const bundle = {
        id: bundleId,
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
        name,
        source: source.source,
        memberCount: composition.accepted.length,
        createdBy: bundleInput.userId,
        createdAt: now,
      };
      // 成员在此刻冻结：position、initialRevisionId 与加入时的文件名一次写死，之后只投影当前 revision。
      const members = composition.accepted.map((candidate, index) => ({
        bundleId,
        position: index,
        documentId: candidate.documentId,
        initialRevisionId: candidate.currentRevisionId,
        initialRevisionNumber: candidate.currentRevisionNumber,
        initialFilename: candidate.filename,
      }));
      const result = await repositories.projectDocumentBundles.create({
        bundle,
        members,
        mutation: {
          teamId: bundleInput.teamId,
          channelId: bundleInput.channelId,
          idempotencyKey,
          requestFingerprint,
          bundleId,
          createdAt: now,
        },
      });
      if (result.kind === 'idempotency_conflict') {
        return bundleFailure(
          'CONFLICT', 'idempotencyKey was already used for a different bundle', 'idempotency_conflict',
        );
      }
      if (result.kind === 'document_scope_conflict') {
        return bundleFailure(
          'CONFLICT',
          'A member document changed scope or revision; refresh and retry',
          'member_scope_conflict',
        );
      }
      const committed = await repositories.projectDocumentBundles.getById({
        teamId: bundleInput.teamId,
        channelId: bundleInput.channelId,
        bundleId: result.mutation.bundleId,
      });
      if (!committed) {
        return bundleFailure('NOT_FOUND', 'Document bundle not found', 'bundle_unavailable');
      }
      if (result.kind === 'created') {
        await notifyProjectFactsChanged({
          teamId: bundleInput.teamId,
          channelId: bundleInput.channelId,
        });
      }
      return makeSuccess({
        bundle: await toProjectDocumentBundleDetailDto(repositories, committed),
        archived: false,
        replayed: result.kind === 'replayed',
      });
    },

    async resolveProjectReferences(referenceInput) {
      if (!projectCollaborationRollout.bundleSelection) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project document Bundle and Selection are disabled');
      }
      if (!(await repositories.teams.isMember(referenceInput.teamId, referenceInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, referenceInput);
      if (!access.ok) return access;
      return resolveAndFreezeSelections(repositories, {
        ...referenceInput,
        channel: access.channel,
      });
    },

    async resolveProjectReferenceOrdinal(referenceInput) {
      if (!projectCollaborationRollout.bundleSelection) {
        projectCollaborationMetrics.recordMutationFailure('disabled');
        return makeFailure('NOT_FOUND', 'Project document Bundle and Selection are disabled');
      }
      if (!(await repositories.teams.isMember(referenceInput.teamId, referenceInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const access = await ensureUserCanViewChannel(repositories, referenceInput);
      if (!access.ok) return access;
      const bundleMembers = [];
      for (const bundleId of referenceInput.focusBundleIds) {
        const bundle = await repositories.projectDocumentBundles.getById({
          teamId: referenceInput.teamId,
          channelId: referenceInput.channelId,
          bundleId,
        });
        if (!bundle) continue;
        const members = await repositories.projectDocumentBundles.listMembers({ bundleId });
        for (const member of members) {
          const document = await repositories.channelDocuments.getForTeam({
            teamId: referenceInput.teamId,
            channelId: referenceInput.channelId,
            documentId: member.documentId,
          });
          if (!document) continue;
          bundleMembers.push({
            bundleId,
            documentId: member.documentId,
            revisionId: document.currentRevisionId,
            position: member.position + 1,
            filename: document.filename,
          });
        }
      }
      // #1063 package 焦点:F1/F2/「第 N 个文件」在 package 焦点内解析为显式版本身份。
      // collections/versions 提升到循环外一次读取(多焦点不 N+1、同快照)。
      const packageMembers: ProjectReferenceOrdinalPackageMember[] = [];
      const focusPackageIds = referenceInput.focusPackageIds ?? [];
      if (focusPackageIds.length > 0) {
        const collections = await repositories.channelProjects.listArtifactCollections({
          teamId: referenceInput.teamId,
          channelId: referenceInput.channelId,
        });
        const versions = await repositories.channelProjects.listArtifactVersions({
          teamId: referenceInput.teamId,
          channelId: referenceInput.channelId,
        });
        for (const packageId of focusPackageIds) {
          const record = await repositories.outputPackages.getPackageById({
            teamId: referenceInput.teamId,
            packageId,
          });
          if (!record || record.package.channelId !== referenceInput.channelId) continue;
          for (const member of record.members) {
            const collection = collections.find((candidate) => candidate.id === member.collectionId);
            if (!collection) continue;
            const version = versions.find((candidate) => candidate.id === collection.currentVersionId);
            if (!version) continue;
            packageMembers.push({
              packageId,
              collectionId: member.collectionId,
              versionId: version.id,
              versionNumber: version.versionNumber,
              shortLabel: member.shortLabel,
              position: member.sequence,
              filename: member.filename,
            });
          }
        }
      }
      const bundleResult = resolveReferenceOrdinal(
        referenceInput.ordinal,
        referenceInput.focusBundleIds,
        bundleMembers,
      );
      if (referenceInput.focusPackageIds && referenceInput.focusPackageIds.length > 0) {
        const packageResult = resolvePackageReferenceOrdinal(
          referenceInput.ordinal,
          referenceInput.focusPackageIds,
          packageMembers,
        );
        if (packageResult.kind !== 'not_found') {
          // 同一焦点内 bundle 与 package 都命中时,package 优先(整包引用语义更强);
          // 都不满足才走 not_found。
          return makeSuccess(packageResult);
        }
        if (bundleResult.kind === 'resolved' || bundleResult.kind === 'ambiguous') {
          return makeSuccess(bundleResult);
        }
        return makeSuccess({ kind: 'not_found' });
      }
      return makeSuccess(bundleResult);
    },

    async getTaskDag(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const selectedTask = await repositories.tasks.getById(taskInput.rootTaskId);
      if (!selectedTask || selectedTask.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task DAG not found');
      }
      if (selectedTask.channelId) {
        const channel = await ensureUserCanViewChannel(repositories, {
          userId: taskInput.userId,
          teamId: taskInput.teamId,
          channelId: selectedTask.channelId,
        });
        if (!channel.ok) return channel;
      }
      const selectedCoordination = await repositories.taskCoordination.coordinations.getByTaskId(selectedTask.id);
      const rootTaskId = selectedCoordination?.rootTaskId
        ?? (selectedCoordination?.nodeKind === 'root' ? selectedTask.id : taskInput.rootTaskId);
      const rootTask = rootTaskId === selectedTask.id
        ? selectedTask
        : await repositories.tasks.getById(rootTaskId);
      if (!rootTask || rootTask.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task DAG not found');
      }
      const run = await repositories.management.runs.getByRootTaskId(rootTask.id);
      if (!run || !('managementPhase' in run) || run.managementPhase < 2) {
        return makeFailure('NOT_FOUND', 'Task DAG not found');
      }
      const coordinations = await repositories.taskCoordination.coordinations.listByManagementRun(run.id);
      if (!coordinations.some((coordination) => coordination.taskId === rootTask.id)) {
        return makeFailure('NOT_FOUND', 'Task DAG not found');
      }
      const events = await repositories.management.events.list(run.id);
      const handoffs = await repositories.management.handoffs.listByRun(run.id);
      const nodes = await Promise.all(coordinations.map(async (coordination) => {
        const task = await repositories.tasks.getById(coordination.taskId);
        if (!task || task.teamId !== taskInput.teamId) {
          throw new Error('Task DAG references a missing task');
        }
        const criteria = (await repositories.taskCoordination.criteria.list(task.id))
          .filter((criterion) => criterion.introducedRevision <= task.revision
            && (criterion.retiredRevision === undefined || criterion.retiredRevision > task.revision));
        const dependencyTaskIds = (await repositories.taskCoordination.dependencies.list(task.id))
          .map((dependency) => dependency.dependencyTaskId);
        const claim = await repositories.taskCoordination.claimLeases.getLatest({
          taskId: task.id,
          taskRevision: task.revision,
          taskAttempt: coordination.attempt,
        });
        const deliveries = await repositories.taskCoordination.deliveries.listByTask(task.id);
        const latestDelivery = [...deliveries].reverse().find((delivery) =>
          delivery.taskRevision === task.revision && delivery.taskAttempt === coordination.attempt);
        const canonicalAcceptance = latestDelivery
          ? await repositories.taskCoordination.acceptances.getCanonicalByDelivery(latestDelivery.id)
          : null;
        const evidenceSnapshots = latestDelivery
          ? (await repositories.taskCoordination.evidenceSnapshots.listByTask(task.id))
            .filter((snapshot) => snapshot.invocationId === latestDelivery.invocationId
              && latestDelivery.evidenceRefs.some((reference) => reference.kind === snapshot.kind
                && reference.id === snapshot.sourceId
                && reference.snapshotHash === snapshot.snapshotHash))
          : [];
        // #948-G：该 task 验收时解析的不可变 output snapshot（下游 input binding 引用其 evidenceRefs）。
        const outputSnapshots = await repositories.taskCoordination.outputSnapshots.listByTask(task.id);
        const { revision: _revision, ...taskDto } = task;
        return {
          task: taskDto,
          taskRevision: task.revision,
          coordination: {
            schemaVersion: 1 as const,
            ...(coordination.rootTaskId ? { rootTaskId: coordination.rootTaskId } : {}),
            ...(coordination.parentTaskId ? { parentTaskId: coordination.parentTaskId } : {}),
            managementRunId: coordination.managementRunId,
            nodeKind: coordination.nodeKind,
            reviewPolicy: coordination.reviewPolicy,
            claimPolicy: coordination.claimPolicy,
            requiredCapabilities: coordination.requiredCapabilities,
            acceptanceCriteria: criteria.map(({ taskId: _taskId, introducedRevision: _introducedRevision,
              retiredRevision: _retiredRevision, position: _position, ...criterion }) => criterion),
            dependencyTaskIds,
            attempt: coordination.attempt,
            maxAttempts: coordination.maxAttempts,
          },
          ...(claim ? { claim: {
            agentId: claim.agentId,
            taskRevision: claim.taskRevision,
            taskAttempt: claim.taskAttempt,
            status: claim.status,
            acquiredAt: claim.acquiredAt,
            expiresAt: claim.expiresAt,
          } } : {}),
          ...(latestDelivery ? { latestDelivery: {
            id: latestDelivery.id,
            invocationId: latestDelivery.invocationId,
            summary: latestDelivery.summary,
          } } : {}),
          ...(canonicalAcceptance ? { canonicalAcceptance: {
            decision: canonicalAcceptance.decision,
            reason: canonicalAcceptance.reason,
            decidedBy: canonicalAcceptance.decidedBy,
            decidedAt: canonicalAcceptance.decidedAt,
          } } : {}),
          resultRefs: latestDelivery ? [
            { kind: 'invocation' as const, id: latestDelivery.invocationId },
            ...evidenceSnapshots.map((snapshot) => ({ kind: snapshot.kind, id: snapshot.sourceId })),
          ] : [],
          // #712 切片 C-3：该 task 的 PI Offer 及 Agent 响应（AC#7 Task 视图）
          offers: (await repositories.taskCoordination.offers.listByTask(task.id)).map((offer) => ({
            id: offer.id,
            taskId: offer.taskId,
            agentId: offer.agentId,
            status: offer.status,
            hardSpecified: offer.hardSpecified,
            requirementConfirmation: offer.requirementConfirmation,
            offerExpiresAt: offer.offerExpiresAt,
            response: offer.response,
            createdAt: offer.createdAt,
          })),
          // #948-G：已解析的具名 output snapshot（不可变，绑定 revision+attempt）。非空才含。
          ...(outputSnapshots.length > 0 ? { resolvedOutputSnapshots: outputSnapshots.map((snapshot) => ({
            slotName: snapshot.slotName,
            taskRevision: snapshot.taskRevision,
            taskAttempt: snapshot.taskAttempt,
            evidenceRefs: snapshot.resolvedEvidenceRefs,
          })) } : {}),
        };
      }));
      // #709 root task 的不可变 revision 历史（旧→新），供 Task 视图展示变更原因（AC7）。
      const revisionHistory = (await repositories.tasks.listRevisions({
        taskId: rootTask.id,
        teamId: taskInput.teamId,
      })).map((task) => ({
        revision: task.revision,
        objective: task.description ?? task.title,
        superseded: task.supersededByRevision !== null,
        supersededByRevision: task.supersededByRevision,
        supersededReasonCode: task.supersededReasonCode,
        supersededAt: task.supersededAt,
        createdAt: task.createdAt,
      }));
      return makeSuccess({
        dag: {
          schemaVersion: 1,
          managementRunId: run.id,
          rootTaskId: rootTask.id,
          graphRevision: events.at(-1)?.event.sequence ?? 0,
          nodes,
          revisionHistory,
          handoffs: handoffs.map((handoff) => ({ id: handoff.id,
            ...(handoff.intent.fromAgentId ? { fromAgentId: handoff.intent.fromAgentId } : {}),
            toAgentId: handoff.intent.toAgentId, kind: handoff.intent.kind,
            objective: handoff.intent.objective, status: handoff.status,
            ...(handoff.invocationId ? { invocationId: handoff.invocationId } : {}),
            createdAt: handoff.createdAt, updatedAt: handoff.updatedAt })),
          events: events.map(({ event }) => ({
            sequence: event.sequence,
            type: event.type,
            createdAt: event.createdAt,
          })),
          // #649：用量从既有 events 派生（不建表），上限用 run 创建时冻结的 budget。
          usage: deriveManagementRunUsage(events.map(({ event }) => ({
            type: event.type,
            payload: event.type === 'task-created'
              ? { taskId: event.payload.taskId, ...(event.payload.parentTaskId ? { parentTaskId: event.payload.parentTaskId } : {}) }
              : {},
          }))),
          budget: run.budget,
        },
      });
    },

    async summarizeAgentMetrics(metricsInput) {
      if (!(await repositories.teams.isMember(metricsInput.teamId, metricsInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const dispatches = await repositories.dispatches.listByTeam(metricsInput.teamId);
      return makeSuccess({ summaries: summarizeDispatchMetrics(dispatches) });
    },

    async summarizeChangelogEntries(metricsInput) {
      if (!Array.isArray(metricsInput.pulls) || metricsInput.pulls.length === 0 || metricsInput.pulls.length > 100) {
        return makeFailure('VALIDATION_ERROR', 'pulls must be a non-empty array of at most 100 items');
      }
      const results = await changelogSummarizer.summarize(metricsInput.pulls);
      return makeSuccess({ results });
    },

    async createTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const title = typeof taskInput.title === 'string' ? taskInput.title.trim() : '';
      if (!title) {
        return makeFailure('VALIDATION_ERROR', 'Task title is required');
      }
      const channelId = normalizeOptionalId(taskInput.channelId);
      const assigneeId = normalizeOptionalId(taskInput.assigneeId);
      if (channelId) {
        const channel = await ensureUserCanViewChannel(repositories, {
          userId: taskInput.userId,
          teamId: taskInput.teamId,
          channelId,
        });
        if (!channel.ok) {
          return channel;
        }
      }
      if (assigneeId && !(await isAssignableToTask(repositories, taskInput.teamId, assigneeId))) {
        return makeFailure('FORBIDDEN', 'Task assignee is not visible in team');
      }
      const now = clock.now();
      const task = await repositories.tasks.create({
        id: ids.nextId(),
        teamId: taskInput.teamId,
        title,
        description: normalizeOptionalText(taskInput.description),
        status: 'todo',
        creatorId: taskInput.userId,
        assigneeId,
        channelId,
        tags: normalizeTags(taskInput.tags),
        sortOrder: now,
        createdAt: now,
        updatedAt: now,
      });
      return makeSuccess({ task });
    },

    async updateTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      if (task.channelId) {
        const channel = await ensureUserCanViewChannel(repositories, {
          userId: taskInput.userId,
          teamId: taskInput.teamId,
          channelId: task.channelId,
        });
        if (!channel.ok) {
          return channel;
        }
      }
      const nextChannelId = hasOwn(taskInput, 'channelId') ? normalizeOptionalId(taskInput.channelId ?? undefined) : undefined;
      const nextAssigneeId = hasOwn(taskInput, 'assigneeId') ? normalizeOptionalId(taskInput.assigneeId ?? undefined) : undefined;
      if (hasOwn(taskInput, 'channelId')
        && nextChannelId !== task.channelId
        && await taskIsBoundToProjectStage(repositories, task)) {
        return makeFailure('CONFLICT', 'Task is bound to a Project Stage and cannot change channels');
      }
      if (nextChannelId) {
        const channel = await ensureUserCanViewChannel(repositories, {
          userId: taskInput.userId,
          teamId: taskInput.teamId,
          channelId: nextChannelId,
        });
        if (!channel.ok) {
          return channel;
        }
      }
      if (taskInput.status !== undefined && !isTaskStatus(taskInput.status)) {
        return makeFailure('VALIDATION_ERROR', 'Task status is invalid');
      }
      if (
        taskInput.assigneeId !== undefined &&
        taskInput.assigneeId !== null &&
        nextAssigneeId !== undefined &&
        !(await isAssignableToTask(repositories, taskInput.teamId, nextAssigneeId))
      ) {
        return makeFailure('FORBIDDEN', 'Task assignee is not visible in team');
      }
      if (taskInput.sortOrder !== undefined && (typeof taskInput.sortOrder !== 'number' || !Number.isFinite(taskInput.sortOrder))) {
        return makeFailure('VALIDATION_ERROR', 'Task sortOrder must be a finite number');
      }
      if (taskInput.title !== undefined && typeof taskInput.title !== 'string') {
        return makeFailure('VALIDATION_ERROR', 'Task title is required');
      }
      const title = taskInput.title !== undefined ? taskInput.title.trim() : undefined;
      if (title !== undefined && !title) {
        return makeFailure('VALIDATION_ERROR', 'Task title is required');
      }
      // #995：绑定 management run 的 root Task 禁止用 task:update 完成/退回。
      if (taskInput.status !== undefined && taskInput.status !== task.status) {
        const managementRun = await repositories.management.runs.getByRootTaskId(task.id);
        if (managementRun && taskInput.status === 'done') {
          return makeFailure(
            'CONFLICT',
            'Managed root completion must use accept-root-delivery (task:accept-root-delivery)',
          );
        }
        if (managementRun && task.status === 'in_review' && taskInput.status === 'in_progress') {
          return makeFailure(
            'CONFLICT',
            'Managed root rework must use reject-root-delivery (task:reject-root-delivery)',
          );
        }
      }
      const updated = await repositories.tasks.update({
        taskId: task.id,
        changes: {
          ...(title !== undefined ? { title } : {}),
          ...(hasOwn(taskInput, 'description') ? { description: normalizeOptionalText(taskInput.description ?? undefined) } : {}),
          ...(taskInput.status !== undefined ? { status: taskInput.status } : {}),
          ...(hasOwn(taskInput, 'assigneeId') ? { assigneeId: nextAssigneeId } : {}),
          ...(hasOwn(taskInput, 'channelId') ? { channelId: nextChannelId } : {}),
          ...(taskInput.tags !== undefined ? { tags: normalizeTags(taskInput.tags) } : {}),
          ...(taskInput.sortOrder !== undefined ? { sortOrder: taskInput.sortOrder } : {}),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      const statusMessage = taskInput.status !== undefined && taskInput.status !== task.status && updated.channelId
        ? await repositories.messages.append({
            id: ids.nextId(),
            teamId: updated.teamId,
            channelId: updated.channelId,
            senderKind: 'system',
            senderId: 'system',
            body: `任务「${updated.title}」状态更新为${taskStatusLabel(updated.status)}`,
            createdAt: updated.updatedAt,
            meta: {
              kind: 'task-status-updated',
              taskId: updated.id,
              taskTitle: updated.title,
              previousStatus: task.status,
              status: updated.status,
            },
          })
        : null;
      return makeSuccess({
        task: updated,
        ...(statusMessage ? { message: statusMessage } : {}),
      });
    },

    async deleteTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      if (await taskIsBoundToProjectStage(repositories, task)) {
        return makeFailure('CONFLICT', 'Task is bound to a Project Stage and cannot be deleted');
      }
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      const deletedInvocationIds = coordination
        ? (await repositories.management.invocations.listByRun(coordination.managementRunId))
          .filter((invocation) => invocation.intent.taskContext?.taskId === task.id)
          .map((invocation) => invocation.id)
        : [];
      const deleted = await repositories.tasks.delete({ taskId: task.id });
      if (!deleted) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      await invalidateSourcesAfterDeletion({
        teamId: taskInput.teamId, sourceKind: 'task', sourceIds: [task.id], actorId: taskInput.userId,
      });
      await invalidateSourcesAfterDeletion({
        teamId: taskInput.teamId, sourceKind: 'invocation', sourceIds: deletedInvocationIds,
        actorId: taskInput.userId,
      });
      return makeSuccess({ task: deleted });
    },

    async cancelTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      // authority 推导：requester（创建者）/ human（team member）/ admin
      const role = await repositories.teams.getMemberRole(taskInput.teamId, taskInput.userId);
      const authorityKind = task.creatorId === taskInput.userId ? 'requester'
        : (role === 'owner' || role === 'admin') ? 'admin' : 'human';
      try {
        const result = await taskLifecycleKernel.cancelTask(
          { schemaVersion: 1, commandName: 'cancel-task', commandSchemaVersion: 1,
            idempotencyKey: `cancel:${taskInput.taskId}:${taskInput.userId}:${clock.now()}` },
          { taskId: task.id, expectedTaskRevision: task.revision, reason: taskInput.reason },
          { managementRunId: '', workerId: taskInput.userId, leaseToken: '', fencingToken: 0 },
          authorityKind, taskInput.teamId,
        );
        const updated = await repositories.tasks.getById(task.id);
        return makeSuccess({ task: updated ?? task });
      } catch (error) {
        return makeFailure('CONFLICT', (error as Error).message);
      }
    },

    async closeTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const role = await repositories.teams.getMemberRole(taskInput.teamId, taskInput.userId);
      if (role !== 'owner' && role !== 'admin') {
        return makeFailure('FORBIDDEN', 'Only team admins can close tasks');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      try {
        await taskLifecycleKernel.closeTask(
          { schemaVersion: 1, commandName: 'close-task', commandSchemaVersion: 1,
            idempotencyKey: `close:${taskInput.taskId}:${taskInput.userId}:${clock.now()}` },
          { taskId: task.id, expectedTaskRevision: task.revision, reason: taskInput.reason },
          { managementRunId: '', workerId: taskInput.userId, leaseToken: '', fencingToken: 0 },
          'admin', taskInput.teamId,
        );
        const updated = await repositories.tasks.getById(task.id);
        return makeSuccess({ task: updated ?? task });
      } catch (error) {
        return makeFailure('CONFLICT', (error as Error).message);
      }
    },

    async acceptRootDelivery(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      const managementRun = await repositories.management.runs.getByRootTaskId(task.id);
      if (!managementRun) {
        return makeFailure('CONFLICT', 'Only managed root tasks support root-delivery accept');
      }
      if (managementRun.status !== 'in_review' && managementRun.status !== 'completed') {
        return makeFailure('CONFLICT', 'Managed Task is not ready for human completion');
      }
      let deliveryMessageId = taskInput.deliveryMessageId?.trim() || '';
      if (!deliveryMessageId) {
        const events = await repositories.management.events.list(managementRun.id);
        const deliveryEvent = [...events].reverse()
          .find(({ event }) => event.type === 'root-delivery-submitted');
        if (!deliveryEvent || deliveryEvent.event.type !== 'root-delivery-submitted') {
          return makeFailure('CONFLICT', 'Managed Task has no review delivery');
        }
        deliveryMessageId = deliveryEvent.event.payload.messageId;
      }
      const expectedTaskRevision = taskInput.expectedTaskRevision ?? task.revision;
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      try {
        if (coordination?.nodeKind === 'root' && coordination.managementRunId === managementRun.id) {
          // 优先 lifecycle registry（#926/#995 权威路径）
          await taskLifecycleKernel.acceptRootDelivery(
            {
              schemaVersion: 1,
              commandName: 'accept-root-delivery',
              commandSchemaVersion: 1,
              idempotencyKey: `accept-root:${task.id}:${taskInput.userId}:${expectedTaskRevision}:${deliveryMessageId}`,
            },
            {
              taskId: task.id,
              expectedTaskRevision,
              deliveryMessageId,
            },
            { managementRunId: '', workerId: taskInput.userId, leaseToken: '', fencingToken: 0 },
            'human',
            taskInput.teamId,
          );
        } else {
          // 无 coordination 的 Phase-1 managed root：统一入口仍禁用 updateTask 旁路
          if (task.status !== 'done') {
            const updatedTask = await repositories.tasks.update({
              taskId: task.id,
              changes: { status: 'done', updatedAt: clock.now() },
            });
            if (!updatedTask) return makeFailure('NOT_FOUND', 'Task not found');
          }
          await managementKernel.completeRunFromHumanTask({
            managementRunId: managementRun.id,
            taskId: task.id,
            userId: taskInput.userId,
            deliveryMessageId,
          });
        }
        const updated = await repositories.tasks.getById(task.id);
        return makeSuccess({ task: updated ?? task });
      } catch (error) {
        return makeFailure('CONFLICT', (error as Error).message);
      }
    },

    async rejectRootDelivery(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const reason = typeof taskInput.reason === 'string' ? taskInput.reason.trim() : '';
      if (!reason) {
        return makeFailure('VALIDATION_ERROR', 'Reject reason is required');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      const managementRun = await repositories.management.runs.getByRootTaskId(task.id);
      if (!managementRun) {
        return makeFailure('CONFLICT', 'Only managed root tasks support root-delivery reject');
      }
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      const expectedTaskRevision = taskInput.expectedTaskRevision ?? task.revision;
      try {
        if (coordination?.nodeKind === 'root' && coordination.managementRunId === managementRun.id) {
          await taskLifecycleKernel.rejectRootDelivery(
            {
              schemaVersion: 1,
              commandName: 'reject-root-delivery',
              commandSchemaVersion: 1,
              idempotencyKey: `reject-root:${task.id}:${taskInput.userId}:${expectedTaskRevision}:${reason}`,
            },
            {
              taskId: task.id,
              expectedTaskRevision,
              reason,
            },
            { managementRunId: '', workerId: taskInput.userId, leaseToken: '', fencingToken: 0 },
            'human',
            taskInput.teamId,
          );
        } else {
          // Phase-1 无 coordination：退回仍走 coordination kernel reopen（统一 reject 入口）
          await taskCoordinationKernel.reopenRootTaskFromHuman({
            managementRunId: managementRun.id,
            taskId: task.id,
            userId: taskInput.userId,
            expectedTaskRevision,
          });
        }
        const updated = await repositories.tasks.getById(task.id);
        return makeSuccess({ task: updated ?? task });
      } catch (error) {
        return makeFailure('CONFLICT', (error as Error).message);
      }
    },

    async reorderTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (typeof taskInput.sortOrder !== 'number' || !Number.isFinite(taskInput.sortOrder)) {
        return makeFailure('VALIDATION_ERROR', 'Task sortOrder must be a finite number');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      const updated = await repositories.tasks.update({
        taskId: task.id,
        changes: {
          sortOrder: taskInput.sortOrder,
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      return makeSuccess({ task: updated });
    },

    async uploadArtifact(artifactInput) {
      const ownerIsMember = await repositories.teams.isMember(artifactInput.teamId, artifactInput.userId);
      // #1056：device 跨 Team 上传的旁路只接受真实 device 身份（token 验签，
      // HTTP/socket 客户端无法伪造）；Agent 授权已由 uploadArtifactForDevice 复验。
      const crossTeamActor = !ownerIsMember && artifactInput.deviceActorToken
        ? await resolveHostedDeviceTokenActor(repositories, sessionSecret, { token: artifactInput.deviceActorToken })
        : null;
      if (!ownerIsMember && (!crossTeamActor || !crossTeamActor.ok)) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (ownerIsMember) {
        const channelAccess = await ensureUserCanViewChannel(repositories, {
          userId: artifactInput.userId,
          teamId: artifactInput.teamId,
          channelId: artifactInput.channelId,
        });
        if (!channelAccess.ok) {
          return channelAccess;
        }
      } else {
        // 跨 Team：频道存在且归属目标 Team（防御纵深）。
        const channel = await repositories.channels.getById(artifactInput.channelId);
        if (!channel || channel.teamId !== artifactInput.teamId) {
          return makeFailure('NOT_FOUND', 'Channel not found');
        }
      }
      const artifact = await repositories.artifacts.create({
        id: ids.nextId(),
        teamId: artifactInput.teamId,
        channelId: artifactInput.channelId,
        uploaderId: artifactInput.userId,
        filename: artifactInput.filename,
        mimeType: artifactInput.mimeType,
        sizeBytes: artifactInput.sizeBytes,
        storagePath: artifactInput.storagePath,
        relativePath: artifactInput.relativePath,
        pathKind: 'upload',
        role: artifactInput.role ?? 'attachment',
        sourceRoot: artifactInput.sourceRoot,
        sha256: artifactInput.sha256,
        createdAt: clock.now(),
      });
      return makeSuccess({ artifact: toArtifactDto(artifact) });
    },

    async uploadArtifactForDevice(artifactInput) {
      const tokenCredentials = verifyDeviceToken(artifactInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === artifactInput.teamId) {
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, artifactInput);
        if (!actor.ok) {
          return actor;
        }
        return this.uploadArtifact({
          ...artifactInput,
          userId: actor.userId,
        });
      }
      // #1056 跨 Team：device token 只证明 home Team 身份；目标 Team 上传由本次
      // 执行 Agent 的 visibleTeamIds + Channel membership + device 绑定授权
      // （codex P1：逐 Agent 校验——同设备其他 Agent 是成员不代表本次执行 Agent 有权）。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, artifactInput);
      if (!actor.ok) return actor;
      const channel = await repositories.channels.getById(artifactInput.channelId);
      if (!channel || channel.teamId !== artifactInput.teamId) return makeFailure('NOT_FOUND', 'Channel not found');
      const authority = await ensureCrossTeamDeviceAgentAuthority(repositories, {
        agentId: artifactInput.agentId,
        deviceId: actor.deviceId,
        teamId: artifactInput.teamId,
        channel,
      });
      if (!authority.ok) return authority;
      return this.uploadArtifact({
        ...artifactInput,
        userId: actor.userId,
        deviceActorToken: artifactInput.token,
      });
    },

    async getArtifact(artifactInput) {
      const result = await getAuthorizedArtifact(repositories, artifactInput);
      if (!result.ok) return result;
      if (!(await isPublicArtifact(repositories, result.artifact))) {
        return makeFailure('NOT_FOUND', 'Artifact not found');
      }
      return makeSuccess({ artifact: toArtifactDto(result.artifact) });
    },

    async getArtifactFile(artifactInput) {
      const result = await getAuthorizedArtifact(repositories, artifactInput);
      if (!result.ok) return result;
      if (!(await isPublicArtifact(repositories, result.artifact))) {
        return makeFailure('NOT_FOUND', 'Artifact not found');
      }
      return makeSuccess({
        artifact: toArtifactDto(result.artifact),
        storagePath: result.artifact.storagePath,
      });
    },

    async getArtifactFileForDevice(artifactInput) {
      const tokenCredentials = verifyDeviceToken(artifactInput.token, sessionSecret);
      if (tokenCredentials && tokenCredentials.teamId === artifactInput.teamId) {
        // 同 Team 路径维持原有完整人类可见性校验。
        const actor = await resolveDeviceTokenActor(repositories, sessionSecret, artifactInput);
        if (!actor.ok) {
          return actor;
        }
        const result = await this.getArtifactFile({
          userId: actor.userId,
          teamId: artifactInput.teamId,
          artifactId: artifactInput.artifactId,
        });
        if (!result.ok || !artifactInput.expectedArtifactVersionId) return result;
        const versions = await repositories.channelProjects.listArtifactVersions({
          teamId: artifactInput.teamId,
          channelId: result.artifact.channelId,
        });
        const version = versions.find((candidate) =>
          candidate.id === artifactInput.expectedArtifactVersionId
          && candidate.artifactId === result.artifact.id,
        );
        if (!version) return makeFailure('NOT_FOUND', 'Artifact version not found');
        return result;
      }
      // #1053 跨 Team：device token 只证明 home Team 身份；目标 Team 的 artifact
      // 下载（snapshot 物化、dispatch 附件）由本次执行 Agent 的 visibleTeamIds +
      // artifact 所在 Channel membership + device 绑定授权（#1056 codex P1：与
      // upload 一致的逐 Agent 校验，不按设备任意 Agent 放行）。
      const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, artifactInput);
      if (!actor.ok) return actor;
      const artifact = await repositories.artifacts.getForTeam({
        teamId: artifactInput.teamId,
        artifactId: artifactInput.artifactId,
      });
      if (!artifact) return makeFailure('NOT_FOUND', 'Artifact not found');
      const channel = await repositories.channels.getById(artifact.channelId);
      if (!channel || channel.teamId !== artifactInput.teamId) return makeFailure('NOT_FOUND', 'Artifact not found');
      const authority = await ensureCrossTeamDeviceAgentAuthority(repositories, {
        agentId: artifactInput.agentId,
        deviceId: actor.deviceId,
        teamId: artifactInput.teamId,
        channel,
      });
      if (!authority.ok) return authority;
      if (!(await isPublicArtifact(repositories, artifact))) {
        return makeFailure('NOT_FOUND', 'Artifact not found');
      }
      if (artifactInput.expectedArtifactVersionId) {
        const versions = await repositories.channelProjects.listArtifactVersions({
          teamId: artifactInput.teamId,
          channelId: artifact.channelId,
        });
        const version = versions.find((candidate) =>
          candidate.id === artifactInput.expectedArtifactVersionId
          && candidate.artifactId === artifact.id,
        );
        if (!version) return makeFailure('NOT_FOUND', 'Artifact version not found');
      }
      return makeSuccess({
        artifact: toArtifactDto(artifact),
        storagePath: artifact.storagePath,
      });
    },

    async getWorkspaceRun(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
      if (!(await isPublicWorkspaceRun(repositories, result.workspaceRun))) {
        return makeFailure('NOT_FOUND', 'Workspace run not found');
      }
      return makeSuccess({ workspaceRun: await toWorkspaceRunDto(repositories, result.workspaceRun, runInput.userId) });
    },

    async getWorkspaceRunDetail(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
      if (!(await isPublicWorkspaceRun(repositories, result.workspaceRun))) {
        return makeFailure('NOT_FOUND', 'Workspace run not found');
      }
      const artifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
        teamId: result.workspaceRun.teamId,
        channelId: result.workspaceRun.channelId,
        runId: result.workspaceRun.id,
      });
      return makeSuccess({
        workspaceRun: await toWorkspaceRunDto(repositories, result.workspaceRun, runInput.userId),
        artifacts: artifacts.map(toArtifactDto),
      });
    },

    async getWorkspaceRunLogFile(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
      if (!(await isPublicWorkspaceRun(repositories, result.workspaceRun))) {
        return makeFailure('NOT_FOUND', 'Workspace run not found');
      }
      const artifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
        teamId: result.workspaceRun.teamId,
        channelId: result.workspaceRun.channelId,
        runId: result.workspaceRun.id,
      });
      const logArtifact = artifacts.find(isWorkspaceRunLogArtifact);
      if (!logArtifact) {
        return makeFailure('NOT_FOUND', 'Workspace run log artifact not found');
      }
      return makeSuccess({
        artifact: toArtifactDto(logArtifact),
        storagePath: logArtifact.storagePath,
      });
    },

    async listTeamWorkspaceRuns(runInput) {
      if (!(await repositories.teams.isMember(runInput.teamId, runInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const pageSize = clampWorkspaceRunPageSize(runInput.pageSize);
      let cursor: { updatedAt: number; id: string } | undefined;
      if (runInput.cursor !== undefined) {
        const decoded = decodeWorkspaceRunCursor(runInput.cursor);
        if (decoded === 'invalid') {
          return makeFailure('BAD_REQUEST', 'Invalid workspace run cursor');
        }
        cursor = decoded;
      }
      const visibleRuns: TeamWorkspaceRunListItemDto[] = [];
      const fetchLimit = Math.max(pageSize + 1, pageSize * 10);
      let fetchCursor = cursor;
      while (visibleRuns.length < pageSize + 1) {
        const runs = await repositories.workspaceRuns.listByTeam({
          teamId: runInput.teamId,
          limit: fetchLimit,
          agentId: runInput.agentId,
          deviceId: runInput.deviceId,
          status: runInput.status,
          cursor: fetchCursor,
        });
        for (const run of runs) {
          if (visibleRuns.length >= pageSize + 1) {
            break;
          }
          const channelAccess = await ensureUserCanViewChannel(repositories, {
            userId: runInput.userId,
            teamId: run.teamId,
            channelId: run.channelId,
          });
          if (!channelAccess.ok) {
            continue;
          }
          if (!(await isPublicWorkspaceRun(repositories, run))) {
            continue;
          }
          const artifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
            teamId: run.teamId,
            channelId: run.channelId,
            runId: run.id,
          });
          visibleRuns.push({
            workspaceRun: run,
            artifacts: artifacts.map(toArtifactDto),
          });
        }
        const lastFetchedRun = runs.at(-1);
        if (visibleRuns.length >= pageSize + 1 || runs.length < fetchLimit || !lastFetchedRun) break;
        fetchCursor = { updatedAt: lastFetchedRun.updatedAt, id: lastFetchedRun.id };
      }
      const hasMore = visibleRuns.length > pageSize;
      const page = hasMore ? visibleRuns.slice(0, pageSize) : visibleRuns;
      const lastVisibleRun = page.at(-1)?.workspaceRun;
      const nextCursor =
        hasMore && lastVisibleRun
          ? encodeWorkspaceRunCursor({
              updatedAt: lastVisibleRun.updatedAt,
              id: lastVisibleRun.id,
            })
          : undefined;
      return makeSuccess({ runs: page, nextCursor });
    },

    async listAgentWorkspaceRuns(runInput) {
      if (!(await repositories.teams.isMember(runInput.teamId, runInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const runs = await repositories.workspaceRuns.listByAgent({
        teamId: runInput.teamId,
        agentId: runInput.agentId,
        limit: 200,
      });
      const visibleRuns: AgentWorkspaceRunListItemDto[] = [];
      for (const run of runs) {
        const channelAccess = await ensureUserCanViewChannel(repositories, {
          userId: runInput.userId,
          teamId: run.teamId,
          channelId: run.channelId,
        });
        if (!channelAccess.ok) {
          continue;
        }
        if (!(await isPublicWorkspaceRun(repositories, run))) {
          continue;
        }
        const artifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
          teamId: run.teamId,
          channelId: run.channelId,
          runId: run.id,
        });
        visibleRuns.push(toAgentWorkspaceRunListItem(run, artifacts));
        if (visibleRuns.length >= 50) {
          break;
        }
      }
      return makeSuccess({ runs: visibleRuns });
    },

    async cancelDispatch(cancelInput) {
      const dispatch = await repositories.dispatches.getById(cancelInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (!(await repositories.teams.isMember(dispatch.teamId, cancelInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }

      const now = clock.now();
      const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(cancelInput.dispatchId);
      const cancelled = managedAttempt
        ? await invocationGateway.completeAttempt({ dispatchId: cancelInput.dispatchId, status: 'cancelled', actorKind: 'human', actorId: cancelInput.userId })
        : await repositories.dispatches.markCancelled({ dispatchId: cancelInput.dispatchId, completedAt: now });
      if (!cancelled) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      const originMessage = await repositories.messages.getById(cancelled.dispatch.messageId);
      const task = cancelled.changed && !managedAttempt
        ? await markLinkedTaskTodoIfInProgress(repositories, originMessage, now)
        : null;
      if (cancelled.changed && managedAttempt) {
        await recordManagedDispatchTerminal(repositories, clock, ids, managementKernel, taskCoordinationKernel, collaborationService, {
          dispatchId: cancelled.dispatch.id,
          status: 'cancelled',
          actorId: cancelInput.userId,
          errorCode: 'USER_CANCELLED',
        });
      }
      const agent = await repositories.agents.getById(cancelled.dispatch.agentId);
      if (agent && agent.status === 'busy') {
        await markAgentOnlineIfIdle(repositories, {
          agentId: cancelled.dispatch.agentId,
          teamId: cancelled.dispatch.teamId,
          lastSeenAt: now,
        });
      }
      return makeSuccess({
        dispatch: toDispatchDto(cancelled.dispatch),
        ...(task ? { task } : {}),
      });
    },

    async cancelChannelDispatches(cancelInput) {
      if (!(await repositories.teams.isMember(cancelInput.teamId, cancelInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: cancelInput.userId,
        teamId: cancelInput.teamId,
        channelId: cancelInput.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      const now = clock.now();
      const dispatches = await repositories.dispatches.listByTeam(cancelInput.teamId);
      const cancelled: DispatchDto[] = [];
      const tasks: TaskDto[] = [];
      for (const dispatch of dispatches) {
        if (dispatch.channelId !== cancelInput.channelId || !isPendingDispatchStatus(dispatch.status)) {
          continue;
        }
        const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(dispatch.id);
        const result = managedAttempt
          ? await invocationGateway.completeAttempt({ dispatchId: dispatch.id, status: 'cancelled', actorKind: 'human', actorId: cancelInput.userId })
          : await repositories.dispatches.markCancelled({ dispatchId: dispatch.id, completedAt: now });
        if (!result?.changed) {
          continue;
        }
        const agent = await repositories.agents.getById(result.dispatch.agentId);
        if (agent && agent.status === 'busy') {
          await markAgentOnlineIfIdle(repositories, {
            agentId: result.dispatch.agentId,
            teamId: result.dispatch.teamId,
            lastSeenAt: now,
          });
        }
        const originMessage = await repositories.messages.getById(result.dispatch.messageId);
        const task = managedAttempt ? null : await markLinkedTaskTodoIfInProgress(repositories, originMessage, now);
        if (managedAttempt) {
          await recordManagedDispatchTerminal(repositories, clock, ids, managementKernel, taskCoordinationKernel, collaborationService, {
            dispatchId: result.dispatch.id,
            status: 'cancelled',
            actorId: cancelInput.userId,
            errorCode: 'USER_CANCELLED',
          });
        }
        if (task) {
          tasks.push(task);
        }
        cancelled.push(toDispatchDto(result.dispatch));
      }
      return makeSuccess({
        dispatches: cancelled,
        ...(tasks.length > 0 ? { tasks } : {}),
      });
    },

    async failTimedOutDispatches(timeoutInput) {
      const now = clock.now();
      const pending = await repositories.dispatches.listPendingOlderThan({
        heartbeatCutoff: timeoutInput.heartbeatCutoff,
        legacyCutoff: timeoutInput.legacyCutoff,
      });
      const dispatches: DispatchDto[] = [];
      const tasks: TaskDto[] = [];
      for (const dispatch of pending) {
        if (!isPendingDispatchStatus(dispatch.status)) {
          continue;
        }
        const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(dispatch.id);
        // 失联诊断：设备 online 却无心跳 → 进程卡（UNRESPONSIVE）；offline → 网络/关机（OFFLINE）。
        const heartbeatAgent = await repositories.agents.getById(dispatch.agentId);
        const device = heartbeatAgent?.deviceId ? await repositories.devices.getById(heartbeatAgent.deviceId) : null;
        const disconnectError = device && device.status === 'online' ? 'DAEMON_UNRESPONSIVE' : 'DAEMON_OFFLINE';
        const timedOut = managedAttempt
          ? await invocationGateway.completeAttempt({ dispatchId: dispatch.id, status: 'timed_out', error: disconnectError })
          : await repositories.dispatches.markTimedOut({ dispatchId: dispatch.id, error: disconnectError, completedAt: now });
        if (timedOut?.changed) {
          const agent = await repositories.agents.getById(dispatch.agentId);
          if (agent && agent.status === 'busy') {
            await markAgentOnlineIfIdle(repositories, {
              agentId: dispatch.agentId,
              teamId: dispatch.teamId,
              lastSeenAt: now,
            });
          }
          const originMessage = await repositories.messages.getById(timedOut.dispatch.messageId);
          const task = managedAttempt ? null : await markLinkedTaskTodoIfInProgress(repositories, originMessage, now);
          if (managedAttempt) {
            await recordManagedDispatchTerminal(repositories, clock, ids, managementKernel, taskCoordinationKernel, collaborationService, {
              dispatchId: timedOut.dispatch.id,
              status: 'timed_out',
              errorCode: disconnectError,
            });
          }
          if (task) {
            tasks.push(task);
          }
          dispatches.push(toDispatchDto(timedOut.dispatch));
        }
      }
      return makeSuccess({
        dispatches,
        ...(tasks.length > 0 ? { tasks } : {}),
      });
    },

    async receiveDispatchProgress(input) {
      const dispatch = await repositories.dispatches.getById(input.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (dispatch.agentId !== input.agentId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to agent');
      }
      if (!isPendingDispatchStatus(dispatch.status)) {
        return makeSuccess({ dispatchId: input.dispatchId });
      }
      const now = clock.now();
      await repositories.dispatches.touchHeartbeat({ dispatchId: input.dispatchId, at: now });
      return makeSuccess({ dispatchId: input.dispatchId });
    },

    async receiveDispatchResult(resultInput) {
      if (resultInput.projectDocumentInputSetResult
        && !projectCollaborationRollout.inputSetOutput) {
        projectCollaborationMetrics.recordInputSetFailure('result_validation');
        return makeFailure('NOT_FOUND', 'Project document InputSet output is disabled');
      }
      const dispatch = await repositories.dispatches.getById(resultInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (dispatch.agentId !== resultInput.agentId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to agent');
      }
      if (!isCompletableDispatchStatus(dispatch.status)) {
        // OutputPackage 补偿必须独立于 Dispatch terminal 状态收敛：daemon 可能在
        // commit 成功后先收到结果确认，而首次成形又因瞬时存储/lineage 时序失败。
        // 不能把该重放当成普通 duplicate 直接拒绝，否则 publish 会永久停留 pending。
        if (resultInput.workspaceRun?.publishId) {
          const replayAttempt = await repositories.management.dispatchAttempts.getByDispatchId(
            resultInput.dispatchId,
          );
          const replayHandoff = replayAttempt
            ? await repositories.management.handoffs.getByInvocationId(replayAttempt.invocationId)
            : null;
          const replayPublishesToRoot = !replayHandoff || replayHandoff.intent.returnMode === 'deliver_to_root';
          if (replayPublishesToRoot) {
            const replayStaging = await repositories.workspacePublishStagings.getByPublishId({
              teamId: dispatch.teamId,
              publishId: resultInput.workspaceRun.publishId,
            });
            if (replayStaging?.committedRevisionId) {
              try {
                await outputPackageService.formPackage({
                  teamId: dispatch.teamId,
                  channelId: dispatch.channelId,
                  publishId: resultInput.workspaceRun.publishId,
                  workspaceRevisionId: replayStaging.committedRevisionId,
                });
              } catch {
                // INTERNAL_ERROR 不会被 daemon 当作 delivered ack，保留重试机会。
                return makeFailure('INTERNAL_ERROR', 'OutputPackage reconciliation pending');
              }
              const replayCard = await readOutputPackageCardMeta(repositories, {
                teamId: dispatch.teamId,
                publishId: resultInput.workspaceRun.publishId,
              });
              if (replayCard) {
                const replayMessage = (await repositories.messages.listByChannel(
                  dispatch.channelId,
                  10_000,
                )).find((message) => message.meta?.dispatchId === dispatch.id);
                if (replayMessage && !replayMessage.meta?.outputPackageCard) {
                  await repositories.messages.updateMeta({
                    messageId: replayMessage.id,
                    meta: { ...(replayMessage.meta ?? {}), outputPackageCard: replayCard },
                  });
                }
              }
            }
            return makeSuccess({ dispatch: toDispatchDto(dispatch) });
          }
        }
        if (resultInput.projectDocumentInputSetResult) {
          const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(
            resultInput.dispatchId,
          );
          if (!managedAttempt) {
            return makeFailure('VALIDATION_ERROR', 'Project document InputSet Dispatch attempt is unavailable');
          }
          const invocationId = managedAttempt.invocationId;
          const proposal = resultInput.projectDocumentInputSetResult;
          if (invocationId === proposal.invocationId) {
            const managedInvocation = await repositories.management.invocations.getById(invocationId);
            if (!managedInvocation) {
              return makeFailure('VALIDATION_ERROR', 'Project document InputSet Invocation is unavailable');
            }
            const requestFingerprint = projectDocumentInputSetProposalFingerprint(proposal);
            const replayed = await repositories.projectDocumentInputSetResults.listByInvocation({
              teamId: dispatch.teamId,
              channelId: dispatch.channelId,
              invocationId,
            });
            let recoveredResult: ProjectDocumentInputSetResultDto | undefined;
            if (replayed.length === proposal.items.length
              && replayed.every((item) =>
                item.inputSetId === proposal.inputSetId
                && item.requestFingerprint === requestFingerprint)) {
              recoveredResult = toProjectDocumentInputSetResultDto(
                proposal.inputSetId,
                proposal.invocationId,
                replayed,
              );
            } else {
              const recoveryNow = clock.now();
              const reportedArtifactIds = uniqueIds([
                ...(resultInput.artifactIds ?? []),
                ...(resultInput.artifacts ?? []).map((artifact) => artifact.id),
              ]);
              const validation = await validateProjectDocumentInputSetResultProposal({
                repositories,
                dispatch,
                managedInvocation,
                proposal,
                reportedArtifactIds,
                inlineArtifacts: resultInput.artifacts,
              });
              if (!validation.ok) {
                projectCollaborationMetrics.recordInputSetFailure('result_validation');
                return validation;
              }
              if (await isProjectDocumentInputSetResultAttemptStale({
                repositories,
                invocation: managedInvocation,
                dispatch,
                agentId: resultInput.agentId,
              })) {
                return makeFailure('CONFLICT', 'Project document InputSet result belongs to a stale Dispatch attempt');
              }
              let recoveredRun = (await repositories.workspaceRuns.listByDispatch(dispatch.id)).at(-1);
              if (!recoveredRun && resultInput.workspaceRun) {
                const existingDeliveryMessage = (await repositories.messages.listByChannel(
                  dispatch.channelId,
                  10_000,
                )).find((message) => message.meta?.dispatchId === dispatch.id);
                const publishedWorkspaceRunId = typeof existingDeliveryMessage?.meta?.workspaceRunId === 'string'
                  ? existingDeliveryMessage.meta.workspaceRunId
                  : undefined;
                const recoveryWorkspaceRunId = resultInput.workspaceRun.id
                  ?? publishedWorkspaceRunId
                  ?? ids.nextId();
                const managedHandoff = await repositories.management.handoffs.getByInvocationId(invocationId);
                const publishResult = !managedHandoff || managedHandoff.intent.returnMode === 'deliver_to_root';
                const originMessage = await repositories.messages.getById(dispatch.messageId);
                const nestReplyInThread = shouldNestDispatchReplyInThread(originMessage);
                const deliveryMessage = existingDeliveryMessage ?? (publishResult
                  ? await repositories.messages.append({
                      id: ids.nextId(),
                      teamId: dispatch.teamId,
                      channelId: dispatch.channelId,
                      threadId: originMessage?.threadId ?? originMessage?.id,
                      senderKind: 'agent',
                      senderId: resultInput.agentId,
                      body: resultInput.body,
                      createdAt: recoveryNow,
                      meta: {
                        dispatchId: dispatch.id,
                        replyScope: nestReplyInThread ? 'thread' : 'channel',
                        ...(nestReplyInThread && originMessage?.threadId
                          ? { parentMessageId: originMessage.threadId }
                          : {}),
                        ...(reportedArtifactIds.length > 0 ? { artifactIds: reportedArtifactIds } : {}),
                        workspaceRunId: recoveryWorkspaceRunId,
                      },
                    })
                  : null);
                const recoveryAgent = await repositories.agents.getById(resultInput.agentId);
                recoveredRun = await repositories.workspaceRuns.create({
                  id: recoveryWorkspaceRunId,
                  teamId: dispatch.teamId,
                  channelId: dispatch.channelId,
                  ...(deliveryMessage ? { messageId: deliveryMessage.id } : {}),
                  dispatchId: dispatch.id,
                  agentId: resultInput.agentId,
                  ...(recoveryAgent?.deviceId ? { deviceId: recoveryAgent.deviceId } : {}),
                  status: resultInput.workspaceRun.status ?? 'succeeded',
                  cwd: resultInput.workspaceRun.cwd,
                  command: resultInput.workspaceRun.command,
                  logExcerpt: normalizeWorkspaceRunLogExcerpt(resultInput.workspaceRun.logExcerpt),
                  exitCode: resultInput.workspaceRun.exitCode,
                  startedAt: resultInput.workspaceRun.startedAt,
                  completedAt: resultInput.workspaceRun.completedAt ?? recoveryNow,
                  createdAt: recoveryNow,
                  updatedAt: recoveryNow,
                  artifactIds: reportedArtifactIds,
                });
              }
              if (recoveredRun) {
                const recoveryDeliveryMessage = recoveredRun.messageId
                  ? await repositories.messages.getById(recoveredRun.messageId)
                  : (await repositories.messages.listByChannel(
                      dispatch.channelId,
                      10_000,
                    )).find((message) => message.meta?.dispatchId === dispatch.id) ?? null;
                for (const artifactId of reportedArtifactIds) {
                  const artifact = await repositories.artifacts.getForTeam({
                    teamId: dispatch.teamId,
                    artifactId,
                  });
                  if (!artifact || artifact.channelId !== dispatch.channelId) continue;
                  await repositories.artifacts.create({
                    ...artifact,
                    ...(recoveryDeliveryMessage ? { messageId: recoveryDeliveryMessage.id } : {}),
                    dispatchId: dispatch.id,
                    workspaceRunId: recoveredRun.id,
                    pathKind: 'generated',
                  });
                }
                // Terminal recovery may arrive with only inline Artifact payloads. Validation can
                // accept them via inlineArtifacts, but commit requires persisted records — so
                // materialize any missing ones the same way as the happy-path result handler.
                for (const artifactInput of resultInput.artifacts ?? []) {
                  const existing = await repositories.artifacts.getForTeam({
                    teamId: dispatch.teamId,
                    artifactId: artifactInput.id,
                  });
                  if (existing) continue;
                  if (artifactInput.sourceRoot && !isValidArtifactSourceRoot(artifactInput.sourceRoot)) {
                    projectCollaborationMetrics.recordInputSetFailure('result_validation');
                    return makeFailure('VALIDATION_ERROR', 'Invalid artifact source root');
                  }
                  const contentResult = await resolveDispatchArtifactContent(artifactContentStore, {
                    teamId: dispatch.teamId,
                    artifact: artifactInput,
                  });
                  if (!contentResult.ok) {
                    projectCollaborationMetrics.recordInputSetFailure('result_validation');
                    return contentResult;
                  }
                  const persisted = await repositories.artifacts.create({
                    id: artifactInput.id,
                    teamId: dispatch.teamId,
                    channelId: dispatch.channelId,
                    ...(recoveryDeliveryMessage ? { messageId: recoveryDeliveryMessage.id } : {}),
                    dispatchId: dispatch.id,
                    workspaceRunId: recoveredRun.id,
                    uploaderId: resultInput.agentId,
                    filename: artifactInput.filename,
                    mimeType: artifactInput.mimeType ?? 'application/octet-stream',
                    sizeBytes: contentResult.content?.sizeBytes ?? artifactInput.sizeBytes ?? 0,
                    storagePath: contentResult.content?.storagePath ?? artifactInput.storagePath,
                    relativePath: artifactInput.relativePath,
                    pathKind: artifactInput.pathKind ?? 'generated',
                    role: artifactInput.role ?? 'intermediate',
                    sourceRoot: artifactInput.sourceRoot,
                    sha256: contentResult.content?.sha256 ?? artifactInput.sha256,
                    createdAt: recoveryNow,
                  });
                  await onArtifactCommitted?.(persisted).catch(() => undefined);
                }
              }
              const committedArtifacts = (await Promise.all(proposal.items.flatMap((item) =>
                item.status === 'changed'
                  ? [repositories.artifacts.getForTeam({
                      teamId: dispatch.teamId,
                      artifactId: item.artifactId,
                    })]
                  : [])))
                .filter((artifact): artifact is ArtifactRecord => artifact !== null);
              const recovered = await commitProjectDocumentInputSetResults({
                repositories,
                ids,
                now: recoveryNow,
                agentId: resultInput.agentId,
                dispatch,
                invocation: managedInvocation,
                proposal,
                committedArtifacts,
                ...(recoveredRun ? { workspaceRunId: recoveredRun.id } : {}),
              });
              recoveredResult = recovered;
              recordProjectInputSetResultMetrics(recovered);
            }
            if (recoveredResult) {
              const recoveredRuns = await repositories.workspaceRuns.listByDispatch(dispatch.id);
              const recoveredRun = recoveredRuns.at(-1);
              const fallbackMessage = (await repositories.messages.listByChannel(
                dispatch.channelId,
                10_000,
              )).find((message) => message.meta?.dispatchId === dispatch.id);
              const deliveryMessage = recoveredRun?.messageId
                ? await repositories.messages.getById(recoveredRun.messageId)
                : fallbackMessage ?? null;
              if (deliveryMessage) {
                await repositories.messages.updateMeta({
                  messageId: deliveryMessage.id,
                  meta: {
                    ...(deliveryMessage.meta ?? {}),
                    projectDocumentInputSetResult: recoveredResult,
                  },
                });
              }
              const terminalStatus = dispatch.status === 'succeeded'
                || dispatch.status === 'failed'
                || dispatch.status === 'cancelled'
                || dispatch.status === 'timed_out'
                ? dispatch.status
                : null;
              if (terminalStatus) {
                const artifactIds = uniqueIds([
                  ...(recoveredRun?.artifactIds ?? []),
                  ...(resultInput.artifactIds ?? []),
                  ...(resultInput.artifacts ?? []).map((artifact) => artifact.id),
                ]);
                const invocationResult: AgentInvocationResultDto = {
                  schemaVersion: 1,
                  invocationId: managedAttempt.invocationId,
                  ...(managedInvocation.intent.taskContext?.taskId
                    ? { taskId: managedInvocation.intent.taskContext.taskId }
                    : {}),
                  agentId: resultInput.agentId,
                  status: terminalStatus,
                  body: resultInput.body,
                  artifactIds,
                  ...(recoveredRun ? { workspaceRunId: recoveredRun.id } : {}),
                  memoryCandidateIds: [],
                  projectDocumentInputSetResult: recoveredResult,
                  startedAt: managedAttempt.startedAt,
                  completedAt: dispatch.completedAt ?? clock.now(),
                  ...(terminalStatus === 'succeeded'
                    ? {}
                    : { error: dispatch.error ?? `DISPATCH_${terminalStatus.toUpperCase()}` }),
                };
                await recordManagedDispatchTerminal(
                  repositories,
                  clock,
                  ids,
                  managementKernel,
                  taskCoordinationKernel,
                  collaborationService,
                  {
                    dispatchId: dispatch.id,
                    status: terminalStatus,
                    artifactIds,
                    result: invocationResult,
                    ...(deliveryMessage ? { deliveryMessageId: deliveryMessage.id } : {}),
                    actorId: resultInput.agentId,
                    ...(terminalStatus === 'succeeded'
                      ? {}
                      : { errorCode: dispatch.error ?? `DISPATCH_${terminalStatus.toUpperCase()}` }),
                  },
                );
              }
              return makeSuccess({
                dispatch: toDispatchDto(dispatch),
                projectDocumentInputSetResult: recoveredResult,
              });
            }
          }
        }
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      const agent = await repositories.agents.getById(resultInput.agentId);
      if (!agent || agent.deletedAt !== undefined) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }

      const now = clock.now();
      const resultSucceeded = isSuccessfulDispatchResult(resultInput.workspaceRun);
      if ((resultInput.artifacts ?? []).some((artifact) =>
        artifact.sourceRoot && !isValidArtifactSourceRoot(artifact.sourceRoot))) {
        return makeFailure('VALIDATION_ERROR', 'Invalid artifact source root');
      }
      const collaborationProposalDiagnostics: string[] = [];
      const collaborationProposals = (resultInput.collaborationProposals ?? []).flatMap((proposal) => {
        try {
          return [parseAgentCollaborationProposalV1(proposal)];
        } catch {
          collaborationProposalDiagnostics.push('AGENT_COLLABORATION_PROPOSAL_INVALID');
          return [];
        }
      });
      const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(resultInput.dispatchId);
      const managedInvocation = managedAttempt
        ? await repositories.management.invocations.getById(managedAttempt.invocationId)
        : null;
      const managedHandoff = managedAttempt
        ? await repositories.management.handoffs.getByInvocationId(managedAttempt.invocationId)
        : null;
      if (resultInput.projectDocumentInputSetResult) {
        const validation = await validateProjectDocumentInputSetResultProposal({
          repositories,
          dispatch,
          managedInvocation,
          proposal: resultInput.projectDocumentInputSetResult,
          reportedArtifactIds: uniqueIds([
            ...(resultInput.artifactIds ?? []),
            ...(resultInput.artifacts ?? []).map((artifact) => artifact.id),
          ]),
          inlineArtifacts: resultInput.artifacts,
        });
        if (!validation.ok) {
          projectCollaborationMetrics.recordInputSetFailure('result_validation');
          return validation;
        }
        if (managedInvocation && await isProjectDocumentInputSetResultAttemptStale({
          repositories,
          invocation: managedInvocation,
          dispatch,
          agentId: resultInput.agentId,
        })) {
          return makeFailure('CONFLICT', 'Project document InputSet result belongs to a stale Dispatch attempt');
        }
      }
      const publishResult = !managedHandoff || managedHandoff.intent.returnMode === 'deliver_to_root';
      const completed = managedAttempt
        ? await invocationGateway.completeAttempt({
            dispatchId: resultInput.dispatchId,
            status: resultSucceeded ? 'succeeded' : 'failed',
            ...(resultSucceeded ? {} : { error: workspaceRunFailureError(resultInput.workspaceRun) }),
            actorKind: 'agent',
            actorId: resultInput.agentId,
          })
        : resultSucceeded
          ? await repositories.dispatches.markSucceeded({ dispatchId: resultInput.dispatchId, completedAt: now })
          : await repositories.dispatches.markFailed({ dispatchId: resultInput.dispatchId, error: workspaceRunFailureError(resultInput.workspaceRun), completedAt: now });
      if (!completed) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (!completed.changed) {
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      const originMessage = await repositories.messages.getById(completed.dispatch.messageId);
      const reportedArtifactIds = uniqueIds([
        ...(resultInput.artifactIds ?? []),
        ...(resultInput.artifacts ?? []).map((artifact) => artifact.id),
      ]);
      const workspaceRunId = resultInput.workspaceRun
        ? resultInput.workspaceRun.id ?? ids.nextId()
        : undefined;
      const nestReplyInThread = shouldNestDispatchReplyInThread(originMessage);
      // #1111 内嵌形态:daemon ≥0.3.43 结果回报带 publishId 时,把 output-package 卡片
      // meta 挂进回复消息——卡片随回复气泡内嵌渲染(原型:卡片在 agent 消息 div 内),
      // web 端据此隐藏同 packageId 的独立卡片。读取失败/旧 daemon → 独立卡片兜底。
      let inlinePackageCard = publishResult && resultInput.workspaceRun?.publishId
        ? await readOutputPackageCardMeta(repositories, {
            teamId: completed.dispatch.teamId,
            publishId: resultInput.workspaceRun.publishId,
          })
        : null;
      let message = publishResult ? await repositories.messages.append({
        id: ids.nextId(),
        teamId: completed.dispatch.teamId,
        channelId: completed.dispatch.channelId,
        threadId: originMessage?.threadId ?? originMessage?.id,
        senderKind: 'agent',
        senderId: resultInput.agentId,
        body: resultInput.body,
        createdAt: now,
        meta: {
          dispatchId: completed.dispatch.id,
          replyScope: nestReplyInThread
            ? 'thread'
            : 'channel',
          ...(nestReplyInThread && originMessage?.threadId
            ? { parentMessageId: originMessage.threadId }
            : {}),
          ...(reportedArtifactIds.length > 0 ? { artifactIds: reportedArtifactIds } : {}),
          ...(workspaceRunId ? { workspaceRunId } : {}),
          ...(inlinePackageCard ? { outputPackageCard: inlinePackageCard } : {}),
        },
      }) : null;
      const workspaceRun = resultInput.workspaceRun
        ? await repositories.workspaceRuns.create({
            id: workspaceRunId!,
            teamId: completed.dispatch.teamId,
            channelId: completed.dispatch.channelId,
            ...(message ? { messageId: message.id } : {}),
            dispatchId: completed.dispatch.id,
            agentId: resultInput.agentId,
            deviceId: agent.deviceId,
            status: resultInput.workspaceRun.status ?? 'succeeded',
            cwd: resultInput.workspaceRun.cwd,
            command: resultInput.workspaceRun.command,
            logExcerpt: normalizeWorkspaceRunLogExcerpt(resultInput.workspaceRun.logExcerpt),
            exitCode: resultInput.workspaceRun.exitCode,
            startedAt: resultInput.workspaceRun.startedAt,
            completedAt: resultInput.workspaceRun.completedAt ?? now,
            createdAt: now,
            updatedAt: now,
            artifactIds: reportedArtifactIds,
        })
        : null;
      // commit 发生在 daemon 回报之前时，首次成形可能因 managed workspace run
      // 尚未落库而被拒绝。此处 workspace run 已落库，使用同一 publish identity
      // 幂等重试，随后把卡片快照补回已追加的 Agent 回复。
      if (publishResult && resultInput.workspaceRun?.publishId) {
        const staging = await repositories.workspacePublishStagings.getByPublishId({
          teamId: completed.dispatch.teamId,
          publishId: resultInput.workspaceRun.publishId,
        });
        if (staging?.committedRevisionId) {
          try {
            await outputPackageService.formPackage({
              teamId: completed.dispatch.teamId,
              channelId: completed.dispatch.channelId,
              publishId: resultInput.workspaceRun.publishId,
              workspaceRevisionId: staging.committedRevisionId,
            });
          } catch {
            // best-effort:回复链路不因 package reconciliation 失败而中断。
          }
        }
        if (!inlinePackageCard) {
          inlinePackageCard = await readOutputPackageCardMeta(repositories, {
            teamId: completed.dispatch.teamId,
            publishId: resultInput.workspaceRun.publishId,
          });
          if (inlinePackageCard && message) {
            message = await repositories.messages.updateMeta({
              messageId: message.id,
              meta: { ...message.meta, outputPackageCard: inlinePackageCard },
            }) ?? message;
          }
        }
      }
      const artifacts: ArtifactDto[] = [];
      const committedArtifacts: ArtifactRecord[] = [];
      for (const artifactId of uniqueIds(resultInput.artifactIds ?? [])) {
        const uploadedArtifact = await repositories.artifacts.getForTeam({
          teamId: completed.dispatch.teamId,
          artifactId,
        });
        if (!uploadedArtifact) {
          return makeFailure('NOT_FOUND', 'Artifact not found');
        }
        if (uploadedArtifact.channelId !== completed.dispatch.channelId) {
          return makeFailure('FORBIDDEN', 'Artifact cannot be attached to this dispatch');
        }
        const linkedArtifact = await repositories.artifacts.create({
          ...uploadedArtifact,
          ...(message ? { messageId: message.id } : {}),
          dispatchId: completed.dispatch.id,
          workspaceRunId: workspaceRun?.id,
          pathKind: 'generated',
        });
        committedArtifacts.push(linkedArtifact);
        artifacts.push(toArtifactDto(linkedArtifact));
      }
      for (const artifactInput of resultInput.artifacts ?? []) {
        const contentResult = await resolveDispatchArtifactContent(artifactContentStore, {
          teamId: completed.dispatch.teamId,
          artifact: artifactInput,
        });
        if (!contentResult.ok) {
          return contentResult;
        }
        const artifact = await repositories.artifacts.create({
          id: artifactInput.id,
          teamId: completed.dispatch.teamId,
          channelId: completed.dispatch.channelId,
          ...(message ? { messageId: message.id } : {}),
          dispatchId: completed.dispatch.id,
          workspaceRunId: workspaceRun?.id,
          uploaderId: resultInput.agentId,
          filename: artifactInput.filename,
          mimeType: artifactInput.mimeType ?? 'application/octet-stream',
          sizeBytes: contentResult.content?.sizeBytes ?? artifactInput.sizeBytes ?? 0,
          storagePath: contentResult.content?.storagePath ?? artifactInput.storagePath,
          relativePath: artifactInput.relativePath,
          pathKind: artifactInput.pathKind ?? (workspaceRun ? 'workspace' : 'generated'),
          role: artifactInput.role ?? (workspaceRun ? 'run_output' : 'deliverable'),
          sourceRoot: artifactInput.sourceRoot,
          sha256: contentResult.content?.sha256 ?? artifactInput.sha256,
          createdAt: now,
        });
        await onArtifactCommitted?.(artifact).catch(() => undefined);
        committedArtifacts.push(artifact);
        artifacts.push(toArtifactDto(artifact));
      }
      const projectDocumentInputSetResult = resultInput.projectDocumentInputSetResult && managedInvocation
        ? await commitProjectDocumentInputSetResults({
            repositories,
            ids,
            now,
            agentId: resultInput.agentId,
            dispatch: completed.dispatch,
            invocation: managedInvocation,
            proposal: resultInput.projectDocumentInputSetResult,
            committedArtifacts,
            ...(workspaceRunId ? { workspaceRunId } : {}),
          })
        : undefined;
      if (projectDocumentInputSetResult) {
        recordProjectInputSetResultMetrics(projectDocumentInputSetResult);
      }
      if (channelFileRollout.markdownEditing) {
        const inputSetResultArtifactIds = new Set(
          resultInput.projectDocumentInputSetResult?.items.flatMap((item) =>
            'artifactId' in item ? [item.artifactId] : []) ?? [],
        );
        await createInitialChannelDocuments(
          repositories,
          committedArtifacts.filter((artifact) => !inputSetResultArtifactIds.has(artifact.id)),
          resultInput.agentId,
          now,
        );
      }
      // The real-time broadcast of this agent reply goes straight to the chat view, so the internal
      // workspace-run.log must be stripped here too — matching enrichMessagesWithArtifacts. The log
      // stays persisted (created above) and is served by the workspace-run detail endpoint.
      const chatArtifacts = artifacts.filter((artifact) => !isWorkspaceRunLogArtifact(artifact));
      const authoritativeMessage = message && projectDocumentInputSetResult
        ? await repositories.messages.updateMeta({
            messageId: message.id,
            meta: {
              ...(message.meta ?? {}),
              projectDocumentInputSetResult,
            },
          })
        : message;
      const messageWithArtifacts: MessageDto | null = authoritativeMessage ? {
        ...authoritativeMessage,
        ...(chatArtifacts.length > 0 ? { artifacts: chatArtifacts } : {}),
        ...(workspaceRun ? { workspaceRun } : {}),
      } : null;
      const completedTask = managedAttempt
        ? null
        : resultSucceeded
          ? await markLinkedTaskInReview(repositories, originMessage, now)
          : await markLinkedTaskTodoIfInProgress(repositories, originMessage, now);
      if (managedAttempt) {
        if (collaborationProposals.length) {
          try {
            await collaborationService.recordProposals({ dispatchId: completed.dispatch.id,
              agentId: resultInput.agentId, proposals: collaborationProposals });
          } catch (error) {
            const diagnostic = collaborationProposalDiagnostic(error);
            if (!diagnostic) throw error;
            collaborationProposalDiagnostics.push(diagnostic);
          }
        }
        const invocationResult: AgentInvocationResultDto = { schemaVersion: 1,
          invocationId: managedAttempt.invocationId,
          ...(managedInvocation?.intent.taskContext?.taskId
            ? { taskId: managedInvocation.intent.taskContext.taskId } : {}),
          agentId: resultInput.agentId, status: resultSucceeded ? 'succeeded' : 'failed',
          body: resultInput.body, artifactIds: artifacts.map((artifact) => artifact.id),
          ...(workspaceRun ? { workspaceRunId: workspaceRun.id } : {}), memoryCandidateIds: [],
          ...(collaborationProposals.length > 0 ? { collaborationProposals } : {}),
          ...(projectDocumentInputSetResult ? { projectDocumentInputSetResult } : {}),
          startedAt: managedAttempt.startedAt, completedAt: now,
          ...(!resultSucceeded ? { error: workspaceRunFailureError(resultInput.workspaceRun) } : {}) };
        await recordManagedDispatchTerminal(repositories, clock, ids, managementKernel, taskCoordinationKernel, collaborationService, {
          dispatchId: completed.dispatch.id,
          status: resultSucceeded ? 'succeeded' : 'failed',
          artifactIds: artifacts.map((artifact) => artifact.id),
          result: invocationResult,
          ...(message ? { deliveryMessageId: message.id } : {}),
          actorId: resultInput.agentId,
          ...(!resultSucceeded ? { errorCode: workspaceRunFailureError(resultInput.workspaceRun) } : {}),
        });
      }
      await markAgentOnlineIfIdle(repositories, {
        agentId: resultInput.agentId,
        teamId: completed.dispatch.teamId,
        lastSeenAt: now,
      });

      return makeSuccess({
        dispatch: toDispatchDto(completed.dispatch),
        ...(messageWithArtifacts ? { message: messageWithArtifacts } : {}),
        ...(completedTask ? { task: completedTask } : {}),
        ...(collaborationProposalDiagnostics.length > 0
          ? { collaborationProposalDiagnostics: [...new Set(collaborationProposalDiagnostics)] }
          : {}),
        ...(projectDocumentInputSetResult ? { projectDocumentInputSetResult } : {}),
      });
    },

    async receiveDispatchError(errorInput) {
      const dispatch = await repositories.dispatches.getById(errorInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (dispatch.agentId !== errorInput.agentId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to agent');
      }
      if (!isPendingDispatchStatus(dispatch.status)) {
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      const agent = await repositories.agents.getById(errorInput.agentId);
      if (!agent || agent.deletedAt !== undefined) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }

      const now = clock.now();
      const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(errorInput.dispatchId);
      if (managedAttempt) {
        const invocation = await repositories.management.invocations.getById(managedAttempt.invocationId);
        if (invocation?.intent.schemaVersion === 2) {
          recordProjectInputSetRuntimeFailure(errorInput.error);
        }
      }
      const failed = managedAttempt
        ? await invocationGateway.completeAttempt({ dispatchId: errorInput.dispatchId, status: 'failed', error: errorInput.error, actorKind: 'agent', actorId: errorInput.agentId })
        : await repositories.dispatches.markFailed({ dispatchId: errorInput.dispatchId, error: errorInput.error, completedAt: now });
      if (!failed) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (!failed.changed) {
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      // Daemon was alive enough to report the error — keep the Agent online/busy (same as
      // receiveDispatchResult / server-side timeout). Old markAgentOfflineIfIdle made Hermes
      // pipe timeouts look like "device/agent 离线" even though the socket never dropped.
      // True offline still comes from device disconnect / snapshot removal.
      //
      // Race: a successor dispatch may be created between the pending check and updateStatus.
      // Mirror markAgentOnlineIfIdle — write online, then restoreAgentBusyIfDispatchArrived.
      const agentStatusInput = {
        agentId: errorInput.agentId,
        teamId: failed.dispatch.teamId,
        lastSeenAt: now,
      };
      if (await hasPendingDispatchForAgent(repositories, agentStatusInput)) {
        await repositories.agents.updateStatus({
          agentId: agentStatusInput.agentId,
          status: 'busy',
          lastSeenAt: now,
          lastError: errorInput.error,
        });
      } else {
        await repositories.agents.updateStatus({
          agentId: agentStatusInput.agentId,
          status: 'online',
          lastSeenAt: now,
          lastError: errorInput.error,
        });
        await restoreAgentBusyIfDispatchArrived(repositories, agentStatusInput);
      }
      const originMessage = await repositories.messages.getById(failed.dispatch.messageId);
      const task = managedAttempt ? null : await markLinkedTaskTodoIfInProgress(repositories, originMessage, now);
      if (managedAttempt) {
        await recordManagedDispatchTerminal(repositories, clock, ids, managementKernel, taskCoordinationKernel, collaborationService, {
          dispatchId: failed.dispatch.id,
          status: 'failed',
          actorId: errorInput.agentId,
          errorCode: errorInput.error,
        });
      }

      return makeSuccess({
        dispatch: toDispatchDto(failed.dispatch),
        ...(task ? { task } : {}),
      });
    },

    async reactMessage(reactInput) {
      if (!(await repositories.teams.isMember(reactInput.teamId, reactInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const message = await repositories.messages.getById(reactInput.messageId);
      if (!message || message.teamId !== reactInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: reactInput.userId,
        teamId: reactInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      if (isDeletedMessage(message)) {
        return makeFailure('CONFLICT', 'Deleted messages cannot be changed');
      }
      const emoji = reactInput.emoji || '❤️';
      await repositories.reactions.toggle({
        id: ids.nextId(),
        messageId: message.id,
        userId: reactInput.userId,
        emoji,
        createdAt: clock.now(),
        on: reactInput.on,
      });
      return makeSuccess({ messageId: message.id });
    },

    async saveMessage(saveInput) {
      if (!(await repositories.teams.isMember(saveInput.teamId, saveInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const message = await repositories.messages.getById(saveInput.messageId);
      if (!message || message.teamId !== saveInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: saveInput.userId,
        teamId: saveInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      if (isDeletedMessage(message)) {
        return makeFailure('CONFLICT', 'Deleted messages cannot be changed');
      }
      await repositories.savedMessages.toggle({
        id: ids.nextId(),
        messageId: message.id,
        userId: saveInput.userId,
        teamId: saveInput.teamId,
        channelId: message.channelId,
        createdAt: clock.now(),
        on: saveInput.on,
      });
      return makeSuccess({ messageId: message.id });
    },

    async listSavedMessages(listInput) {
      if (!(await repositories.teams.isMember(listInput.teamId, listInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const saved = await repositories.savedMessages.listByUser({
        userId: listInput.userId,
        teamId: listInput.teamId,
      });
      const messages: MessageDto[] = [];
      for (const s of saved) {
        const msg = await repositories.messages.getById(s.messageId);
        if (!msg) continue;
        if (isDeletedMessage(msg)) continue;
        const channelAccess = await ensureUserCanViewChannel(repositories, {
          userId: listInput.userId,
          teamId: listInput.teamId,
          channelId: msg.channelId,
        });
        if (!channelAccess.ok) continue;
        if (isHiddenSystemMessage({ senderKind: msg.senderKind, meta: msg.meta })) continue;
        messages.push(msg);
      }
      return makeSuccess({ messages });
    },

    async pinMessage(pinInput) {
      if (!(await repositories.teams.isMember(pinInput.teamId, pinInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const message = await repositories.messages.getById(pinInput.messageId);
      if (!message || message.teamId !== pinInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: pinInput.userId,
        teamId: pinInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      if (isDeletedMessage(message)) {
        return makeFailure('CONFLICT', 'Deleted messages cannot be changed');
      }
      await repositories.pinnedMessages.toggle({
        id: ids.nextId(),
        messageId: message.id,
        userId: pinInput.userId,
        teamId: pinInput.teamId,
        channelId: message.channelId,
        createdAt: clock.now(),
        on: pinInput.on,
      });
      return makeSuccess({ messageId: message.id, channelId: message.channelId });
    },

    async listPinnedMessages(listInput) {
      if (!(await repositories.teams.isMember(listInput.teamId, listInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: listInput.userId,
        teamId: listInput.teamId,
        channelId: listInput.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      const pinned = await repositories.pinnedMessages.listByChannel({
        teamId: listInput.teamId,
        channelId: listInput.channelId,
      });
      const messages: MessageDto[] = [];
      for (const pinnedMessage of pinned) {
        const msg = await repositories.messages.getById(pinnedMessage.messageId);
        if (
          msg
          && msg.teamId === listInput.teamId
          && msg.channelId === listInput.channelId
          && !isDeletedMessage(msg)
        ) {
          messages.push(msg);
        }
      }
      return makeSuccess({ messages: await enrichMessagesWithArtifacts(repositories, messages) });
    },

    async editMessage(editInput) {
      if (!(await repositories.teams.isMember(editInput.teamId, editInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const nextBody = editInput.body.trim();
      if (!nextBody) {
        return makeFailure('VALIDATION_ERROR', 'Message body is required');
      }
      const message = await repositories.messages.getById(editInput.messageId);
      if (!message || message.teamId !== editInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: editInput.userId,
        teamId: editInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      if (message.senderKind !== 'human' || message.senderId !== editInput.userId) {
        return makeFailure('FORBIDDEN', 'Only the message author can edit this message');
      }
      if (isDeletedMessage(message)) {
        return makeFailure('CONFLICT', 'Deleted messages cannot be changed');
      }
      if (typeof message.meta?.taskId === 'string') {
        return makeFailure('CONFLICT', 'Task messages cannot be edited');
      }
      const dispatches = await repositories.dispatches.listByMessage(message.id);
      if (dispatches.some((dispatch) => isPendingDispatchStatus(dispatch.status))) {
        return makeFailure('CONFLICT', 'Message dispatch is still running');
      }
      const previousMeta = { ...(message.meta ?? {}) };
      delete previousMeta.mentions;
      const mentions = sanitizeMessageMentions({
        body: nextBody,
        mentions: editInput.meta?.mentions,
        channel: channelAccess.channel,
        visibleAgents: await repositories.agents.listVisibleInTeam(editInput.teamId),
      });
      const meta = {
        ...previousMeta,
        ...(mentions.length ? { mentions } : {}),
        editedAt: clock.now(),
        editedBy: editInput.userId,
      };
      const edited = await repositories.messages.edit({
        messageId: message.id,
        body: nextBody,
        meta,
      });
      if (!edited) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const [enrichedMessage] = await enrichMessagesWithArtifacts(repositories, [edited]);
      return makeSuccess({ message: enrichedMessage ?? edited });
    },

    async deleteMessage(deleteInput) {
      if (!(await repositories.teams.isMember(deleteInput.teamId, deleteInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const message = await repositories.messages.getById(deleteInput.messageId);
      if (!message || message.teamId !== deleteInput.teamId) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: deleteInput.userId,
        teamId: deleteInput.teamId,
        channelId: message.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
      }
      if (message.senderKind !== 'human' || message.senderId !== deleteInput.userId) {
        return makeFailure('FORBIDDEN', 'Only the message author can delete this message');
      }
      if (isDeletedMessage(message)) {
        const [enrichedMessage] = await enrichMessagesWithArtifacts(repositories, [message]);
        return makeSuccess({ message: enrichedMessage ?? message });
      }
      if (typeof message.meta?.taskId === 'string') {
        return makeFailure('CONFLICT', 'Task messages cannot be deleted');
      }
      const dispatches = await repositories.dispatches.listByMessage(message.id);
      if (dispatches.some((dispatch) => isPendingDispatchStatus(dispatch.status))) {
        return makeFailure('CONFLICT', 'Message dispatch is still running');
      }
      const meta = {
        ...(message.meta ?? {}),
        deletedAt: clock.now(),
        deletedBy: deleteInput.userId,
      };
      const deleted = await repositories.messages.softDelete({
        messageId: message.id,
        body: DELETED_MESSAGE_BODY,
        meta,
      });
      if (!deleted) {
        return makeFailure('NOT_FOUND', 'Message not found');
      }
      const [enrichedMessage] = await enrichMessagesWithArtifacts(repositories, [deleted]);
      await invalidateSourcesAfterDeletion({
        teamId: deleteInput.teamId, sourceKind: 'message', sourceIds: [message.id], actorId: deleteInput.userId,
      });
      return makeSuccess({ message: enrichedMessage ?? deleted });
    },

    async updateMemberRole(roleInput) {
      const actorRole = await repositories.teams.getMemberRole(roleInput.teamId, roleInput.userId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'Actor is not a team member');
      }
      if (actorRole === 'member') {
        return makeFailure('FORBIDDEN', 'Only owner or admin can change roles');
      }
      if (roleInput.userId === roleInput.targetUserId) {
        return makeFailure('FORBIDDEN', 'Cannot change your own role');
      }
      if (roleInput.role === 'owner') {
        return makeFailure('FORBIDDEN', 'Use transferOwner to change ownership');
      }
      const targetMember = await repositories.teams.getMember({
        teamId: roleInput.teamId,
        userId: roleInput.targetUserId,
      });
      if (!targetMember) {
        return makeFailure('NOT_FOUND', 'Target user is not a team member');
      }
      if (targetMember.role === 'owner') {
        return makeFailure('FORBIDDEN', 'Cannot change owner role');
      }
      if (actorRole === 'admin' && targetMember.role === 'admin') {
        return makeFailure('FORBIDDEN', 'Admin cannot change other admin roles');
      }
      const updated = await repositories.teams.updateMemberRole({
        teamId: roleInput.teamId,
        userId: roleInput.targetUserId,
        role: roleInput.role,
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Member not found');
      }
      return makeSuccess({
        member: {
          id: `${updated.teamId}:${updated.userId}`,
          teamId: updated.teamId,
          userId: updated.userId,
          username: updated.username,
          role: updated.role,
        },
      });
    },

    async removeMember(removeInput) {
      const actorRole = await repositories.teams.getMemberRole(removeInput.teamId, removeInput.userId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'Actor is not a team member');
      }
      if (actorRole === 'member') {
        return makeFailure('FORBIDDEN', 'Only owner or admin can remove members');
      }
      if (removeInput.userId === removeInput.targetUserId) {
        return makeFailure('FORBIDDEN', 'Cannot remove yourself, use leave team instead');
      }
      const targetMember = await repositories.teams.getMember({
        teamId: removeInput.teamId,
        userId: removeInput.targetUserId,
      });
      if (!targetMember) {
        return makeFailure('NOT_FOUND', 'Target user is not a team member');
      }
      if (targetMember.role === 'owner') {
        return makeFailure('FORBIDDEN', 'Cannot remove owner');
      }
      if (actorRole === 'admin' && targetMember.role === 'admin') {
        return makeFailure('FORBIDDEN', 'Admin cannot remove other admins');
      }
      await repositories.teams.removeMember({
        teamId: removeInput.teamId,
        userId: removeInput.targetUserId,
      });
      await repositories.channels.removeHumanFromTeamChannels({
        teamId: removeInput.teamId,
        userId: removeInput.targetUserId,
        timestamp: clock.now(),
      });
      return makeSuccess({ userId: removeInput.targetUserId });
    },

    async transferOwner(transferInput) {
      const actorRole = await repositories.teams.getMemberRole(transferInput.teamId, transferInput.userId);
      if (actorRole !== 'owner') {
        return makeFailure('FORBIDDEN', 'Only owner can transfer ownership');
      }
      const targetMember = await repositories.teams.getMember({
        teamId: transferInput.teamId,
        userId: transferInput.targetUserId,
      });
      if (!targetMember) {
        return makeFailure('NOT_FOUND', 'Target user is not a team member');
      }
      // Demote current owner to admin
      await repositories.teams.updateMemberRole({
        teamId: transferInput.teamId,
        userId: transferInput.userId,
        role: 'admin',
      });
      // Promote target to owner
      const updated = await repositories.teams.updateMemberRole({
        teamId: transferInput.teamId,
        userId: transferInput.targetUserId,
        role: 'owner',
      });
      // Update team owner_id
      const team = await repositories.teams.updateOwner({
        teamId: transferInput.teamId,
        ownerId: transferInput.targetUserId,
      });
      if (!updated || !team) {
        return makeFailure('NOT_FOUND', 'Failed to update ownership');
      }
      return makeSuccess({
        team: { id: team.id, name: team.name },
        member: {
          id: `${updated.teamId}:${updated.userId}`,
          teamId: updated.teamId,
          userId: updated.userId,
          username: updated.username,
          role: updated.role,
        },
      });
    },

    async listMembers(listInput) {
      const currentUserRole = await repositories.teams.getMemberRole(listInput.teamId, listInput.userId);
      if (!currentUserRole) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const humans = await repositories.teams.listAllMembers(listInput.teamId);
      // 兜底：当成员仓储漏掉当前用户时（数据不一致），仍保证他能看到自己在列表里。
      if (!humans.some((human) => human.userId === listInput.userId)) {
        const [currentUser, currentMember] = await Promise.all([
          repositories.users.getById(listInput.userId),
          repositories.teams.getMember({ teamId: listInput.teamId, userId: listInput.userId }),
        ]);
        const currentHuman: HumanMemberDto & { joinedAt: UnixMs } = {
          id: `${listInput.teamId}:${listInput.userId}`,
          teamId: listInput.teamId,
          userId: listInput.userId,
          username: currentUser?.username ?? currentMember?.username ?? listInput.userId,
          role: currentUserRole,
          ...(currentUser?.displayName ? { displayName: currentUser.displayName } : {}),
          ...(currentUser?.avatarUrl ? { avatarUrl: currentUser.avatarUrl } : {}),
          joinedAt: currentMember?.joinedAt ?? currentUser?.createdAt ?? 0,
        };
        humans.push(currentHuman);
      }
      const agents = await repositories.agents.listVisibleInTeam(listInput.teamId);
      return makeSuccess({ humans, agents: await toAgentMemberDtos(repositories, listInput.teamId, agents) });
    },

    async updateMemberHuman(humanInput) {
      const actorRole = await repositories.teams.getMemberRole(humanInput.teamId, humanInput.userId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'Actor is not a team member');
      }
      const isSelf = humanInput.userId === humanInput.targetUserId;
      if (!isSelf && actorRole !== 'admin' && actorRole !== 'owner') {
        return makeFailure('FORBIDDEN', 'Only admin or owner can update other members');
      }
      const targetMember = await repositories.teams.getMember({
        teamId: humanInput.teamId,
        userId: humanInput.targetUserId,
      });
      if (!targetMember) {
        return makeFailure('NOT_FOUND', 'Target user is not a team member');
      }
      const description = humanInput.description?.trim() || null;
      const updatedUser = await repositories.users.updateDescription({
        userId: humanInput.targetUserId,
        description,
        updatedAt: clock.now(),
      });
      if (!updatedUser) {
        return makeFailure('NOT_FOUND', 'User not found');
      }
      const humans = await repositories.teams.listAllMembers(humanInput.teamId);
      const human = humans.find((h) => h.userId === humanInput.targetUserId);
      if (!human) {
        return makeFailure('NOT_FOUND', 'Member not found after update');
      }
      return makeSuccess({ human });
    },

    async updateTeam(updateInput) {
      const actorRole = await repositories.teams.getMemberRole(updateInput.teamId, updateInput.userId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'Actor is not a team member');
      }
      if (actorRole === 'member') {
        return makeFailure('FORBIDDEN', 'Only owner or admin can update team');
      }
      const name = updateInput.name?.trim();
      if (!name) {
        return makeFailure('BAD_REQUEST', 'Team name cannot be empty');
      }
      const updated = await repositories.teams.update({
        teamId: updateInput.teamId,
        name,
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Team not found');
      }
      return makeSuccess({
        team: { id: updated.id, name: updated.name, path: updated.path },
      });
    },

    async getPiPolicy(input) {
      // 任意成员可读公开的自动协调状态（AC#2 只读）。
      const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
      if (!role) return makeFailure('FORBIDDEN', 'Not a team member');
      const policy = await repositories.teamPiPolicy.getOrDefault(input.teamId);
      // AC#1：刻意只返回 autoCoordinationEnabled，绝不暴露 mode/phase/placement/provider/model/budget。
      return makeSuccess({ autoCoordinationEnabled: policy.autoCoordinationEnabled });
    },

    async updatePiPolicy(input) {
      // 仅 Team Owner/Admin 可切换（AC#2）。
      const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
      if (role !== 'owner' && role !== 'admin') {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can change PI auto-coordination');
      }
      const saved = await repositories.teamPiPolicy.setAutoCoordination({
        teamId: input.teamId,
        enabled: input.autoCoordinationEnabled,
        actorId: input.userId,
        now: clock.now(),
      });
      return makeSuccess({ autoCoordinationEnabled: saved.autoCoordinationEnabled });
    },

    async createAgentExposureDraft(input) {
      return agentExposure.createDraft(input);
    },
    async updateAgentExposureDraft(input) {
      return agentExposure.updateDraft(input);
    },
    async publishAgentExposure(input) {
      return agentExposure.publish(input);
    },
    async revokeAgentExposure(input) {
      return agentExposure.revoke(input);
    },
    async listAgentExposureRevisions(input) {
      return agentExposure.listRevisions(input);
    },
    async getAgentExposureActive(input) {
      // AC#3：socket 路径校验 Team 成员身份，防跨 Team 读取他人 active 投影。
      // userId 由 bind 层从 authenticatedUser 注入；内部 PI 消费者（broker）直接调 repo，不走此校验。
      if (input.userId !== undefined) {
        const role = await repositories.teams.getMemberRole(input.teamId, input.userId);
        if (!role) return makeFailure('FORBIDDEN', 'Not a team member');
      }
      const result = await agentExposure.getActiveProjection({ teamId: input.teamId, agentId: input.agentId });
      return makeSuccess(result);
    },
    async upsertAgentExposureRestriction(input) {
      return agentExposure.upsertRestriction(input);
    },
    async getAgentTeamCoverage(input) {
      return agentExposure.getTeamCoverage(input);
    },

    // #718 Team-scoped Agent Memory 投影：owner 发布/撤回，Team opt-in，PI/成员只读消费。
    async createAgentMemoryProjectionDraft(input) {
      return agentMemoryProjection.createDraft(input);
    },
    async updateAgentMemoryProjectionDraft(input) {
      return agentMemoryProjection.updateDraft(input);
    },
    async publishAgentMemoryProjection(input) {
      return agentMemoryProjection.publish(input);
    },
    async withdrawAgentMemoryProjection(input) {
      return agentMemoryProjection.withdraw(input);
    },
    async listAgentMemoryProjectionRevisions(input) {
      return agentMemoryProjection.listRevisions(input);
    },
    async upsertTeamAgentMemoryOptIn(input) {
      return agentMemoryProjection.upsertOptIn(input);
    },
    async getConsumableAgentMemoryProjections(input) {
      const result = await agentMemoryProjection.getConsumableProjections(input);
      return makeSuccess(result);
    },

    async listPiProviderPresets(input) {
      return piProvider.listPresets(input);
    },

    async listPiProviderCards(input) {
      return piProvider.listCards(input);
    },

    async getPiProviderCard(input) {
      return piProvider.getCard(input);
    },

    async createPiProviderCard(input) {
      return piProvider.createCard(input);
    },

    async updatePiProviderCard(input) {
      return piProvider.updateCard(input);
    },

    async copyPiProviderCard(input) {
      return piProvider.copyCard(input);
    },

    async discoverPiProviderModels(input) {
      return piProvider.discoverModels(input);
    },

    async runPiProviderTest(input) {
      return piProvider.runTest(input);
    },

    async cancelPiProviderTest(input) {
      return piProvider.cancelTest(input);
    },

    async publishPiProviderCard(input) {
      return piProvider.publishCard(input);
    },

    async setActivePiModel(input) {
      return piProvider.setActiveModel(input);
    },

    async getActivePiModel(input) {
      return piProvider.getActiveModel(input);
    },

    async getPublicPiHealth(input) {
      return piProvider.getPublicHealth(input);
    },

    // #699 US 84：紧急停止
    async setEmergencyStop(input) {
      return piProvider.setEmergencyStop(input);
    },

    async getEmergencyStop(_input) {
      return piProvider.getEmergencyStop();
    },

    // #699 US 29：查询当前 Team 的 PI Token Usage。
    async getTeamPiTokenUsage(input) {
      const raw = input as Record<string, unknown> | null | undefined;
      const since = typeof raw?.since === 'number' ? raw.since : undefined;
      return repositories.channelCoordinationUnitOfWork.run(async (tx) => {
        const usage = await tx.decisions.aggregateUsage(since);
        return makeSuccess(usage);
      });
    },

    async getMemoryGovernanceSnapshot(memoryInput) {
      return makeSuccess({ snapshot: await memoryGovernance.getSnapshot(memoryInput) });
    },

    async createCollaborativeMemory(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ memory: await collaborativeMemory.createMemory({ ...payload, actorId: userId }) });
    },

    async updateCollaborativeMemory(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ memory: await collaborativeMemory.updateMemory({ ...payload, actorId: userId }) });
    },

    async expireCollaborativeMemory(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ memory: await collaborativeMemory.expireMemory({ ...payload, actorId: userId }) });
    },

    async supersedeCollaborativeMemory(memoryInput) {
      const { userId, ...payload } = memoryInput;
      const result = await collaborativeMemory.supersedeMemory({ ...payload, actorId: userId });
      return makeSuccess({ memory: result.created });
    },

    async deleteCollaborativeMemory(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ memory: await collaborativeMemory.deleteMemory({ ...payload, actorId: userId }) });
    },

    async issueMemoryGrant(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ grant: await collaborativeMemory.issueGrant({ ...payload, issuedByUserId: userId }) });
    },

    async revokeMemoryGrant(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ grant: await collaborativeMemory.revokeGrant({ ...payload, actorId: userId }) });
    },

    async acceptMemoryCandidate(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ candidate: await memoryCandidates.acceptCandidate({ ...payload, actorId: userId }) });
    },

    async rejectMemoryCandidate(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ candidate: await memoryCandidates.rejectCandidate({ ...payload, actorId: userId }) });
    },

    async mergeMemoryCandidate(memoryInput) {
      const { userId, ...payload } = memoryInput;
      return makeSuccess({ candidate: await memoryCandidates.mergeCandidate({ ...payload, actorId: userId }) });
    },

    async getFormalMemories(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      const isChannelMember = memoryInput.scopeType === 'channel'
        ? await isChannelMemberOf(repositories, memoryInput.scopeRef, memoryInput.userId)
        : false;
      if (!canReadFormalMemory(role, memoryInput.scopeType, isChannelMember)) {
        return makeFailure('FORBIDDEN', 'No permission to read Formal Memory in this scope');
      }
      try {
        const items = await formalMemory.list({
          teamId: memoryInput.teamId,
          scopeType: memoryInput.scopeType,
          scopeRef: memoryInput.scopeRef,
        });
        return makeSuccess({
          list: {
            schemaVersion: 1,
            teamId: memoryInput.teamId,
            scopeType: memoryInput.scopeType,
            scopeRef: memoryInput.scopeRef,
            channelId: memoryInput.scopeType === 'channel' ? memoryInput.scopeRef : undefined,
            canManage: canManageFormalMemory(role),
            canProposeCorrection: canProposeFormalCorrection(role),
            items,
          },
        });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async getFormalMemoryDetail(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      try {
        const detail = await formalMemory.getDetail({
          teamId: memoryInput.teamId,
          memoryId: memoryInput.memoryId,
        });
        const isChannelMember = detail.scopeType === 'channel'
          ? await isChannelMemberOf(repositories, detail.scopeRef, memoryInput.userId)
          : false;
        if (!canReadFormalMemory(role, detail.scopeType, isChannelMember)) {
          return makeFailure('FORBIDDEN', 'No permission to read this Formal Memory');
        }
        return makeSuccess({ memory: detail });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async createFormalMemory(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canManageFormalMemory(role)) {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can manage Formal Memory');
      }
      const { userId, ...payload } = memoryInput;
      try {
        const memory = await formalMemory.create({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async reviseFormalMemory(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canManageFormalMemory(role)) {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can manage Formal Memory');
      }
      const { userId, ...payload } = memoryInput;
      try {
        const memory = await formalMemory.revise({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async deactivateFormalMemory(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canManageFormalMemory(role)) {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can manage Formal Memory');
      }
      const { userId, ...payload } = memoryInput;
      try {
        const memory = await formalMemory.deactivate({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async deleteFormalMemory(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canManageFormalMemory(role)) {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can manage Formal Memory');
      }
      const { userId, ...payload } = memoryInput;
      try {
        const memory = await formalMemory.delete({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async proposeFormalCorrection(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canProposeFormalCorrection(role)) {
        return makeFailure('FORBIDDEN', 'Only Team members can propose corrections');
      }
      const isChannelMember = memoryInput.scopeType === 'channel'
        ? await isChannelMemberOf(repositories, memoryInput.scopeRef, memoryInput.userId)
        : false;
      if (!canReadFormalMemory(role, memoryInput.scopeType, isChannelMember)) {
        return makeFailure('FORBIDDEN', 'No permission to propose correction in this scope');
      }
      const { userId, ...payload } = memoryInput;
      try {
        const memory = await formalMemory.proposeCorrection({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async acceptFormalCorrection(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canManageFormalMemory(role)) {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can accept corrections');
      }
      try {
        const memory = await formalMemory.accept({
          teamId: memoryInput.teamId,
          actorId: memoryInput.userId,
          memoryId: memoryInput.memoryId,
        });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async rejectFormalCorrection(memoryInput) {
      const role = await repositories.teams.getMemberRole(memoryInput.teamId, memoryInput.userId);
      if (!canManageFormalMemory(role)) {
        return makeFailure('FORBIDDEN', 'Only Team Owner/Admin can reject corrections');
      }
      try {
        const memory = await formalMemory.reject({
          teamId: memoryInput.teamId,
          actorId: memoryInput.userId,
          memoryId: memoryInput.memoryId,
          changeReason: memoryInput.changeReason,
        });
        return makeSuccess({ memory });
      } catch (error) {
        return formalMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async getSystemKnowledge(input) {
      const user = await repositories.users.getById(input.userId);
      if (!canReadSystemKnowledge(user?.role)) {
        return makeFailure('FORBIDDEN', 'Only system admin can view System Knowledge');
      }
      try {
        const items = await systemUserMemory.listSystemKnowledge();
        return makeSuccess({ list: { schemaVersion: 1, scope: 'system', items } });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async getSystemKnowledgeDetail(input) {
      const user = await repositories.users.getById(input.userId);
      if (!canReadSystemKnowledge(user?.role)) {
        return makeFailure('FORBIDDEN', 'Only system admin can view System Knowledge');
      }
      try {
        const memory = await systemUserMemory.getSystemKnowledgeDetail({ id: input.memoryId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async createSystemKnowledge(input) {
      const user = await repositories.users.getById(input.userId);
      if (!canManageSystemKnowledge(user?.role)) {
        return makeFailure('FORBIDDEN', 'Only system admin can manage System Knowledge');
      }
      const { userId, ...payload } = input;
      try {
        const memory = await systemUserMemory.createSystemKnowledge({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async reviseSystemKnowledge(input) {
      const user = await repositories.users.getById(input.userId);
      if (!canManageSystemKnowledge(user?.role)) {
        return makeFailure('FORBIDDEN', 'Only system admin can manage System Knowledge');
      }
      const { userId, ...payload } = input;
      try {
        const memory = await systemUserMemory.reviseSystemKnowledge({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async deactivateSystemKnowledge(input) {
      const user = await repositories.users.getById(input.userId);
      if (!canManageSystemKnowledge(user?.role)) {
        return makeFailure('FORBIDDEN', 'Only system admin can manage System Knowledge');
      }
      const { userId, ...payload } = input;
      try {
        const memory = await systemUserMemory.deactivateSystemKnowledge({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async deleteSystemKnowledge(input) {
      const user = await repositories.users.getById(input.userId);
      if (!canManageSystemKnowledge(user?.role)) {
        return makeFailure('FORBIDDEN', 'Only system admin can manage System Knowledge');
      }
      const { userId, ...payload } = input;
      try {
        await systemUserMemory.deleteSystemKnowledge({ ...payload, actorId: userId });
        return makeSuccess({ deleted: true });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async getUserMemory(input) {
      // userId 即 owner：任何已登录用户只列出属于自己的 User Memory（AC#3）。
      try {
        const items = await systemUserMemory.listUserMemory({ ownerUserId: input.userId });
        return makeSuccess({ list: { schemaVersion: 1, scope: 'user', ownerUserId: input.userId, items } });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async getUserMemoryDetail(input) {
      // AC#6 fail-closed：先轻量取 owner 验证本人，通过后才让 service 组装 detail
      // （含版本历史）——避免服务端读取他人 User Memory 的 versions。
      const existing = await repositories.userMemory.getById({ id: input.memoryId });
      if (!existing) return makeFailure('NOT_FOUND', 'User Memory not found');
      if (!canReadUserMemory(input.userId, existing.ownerUserId)) {
        return makeFailure('FORBIDDEN', 'No permission to read this User Memory');
      }
      try {
        const memory = await systemUserMemory.getUserMemoryDetail({ id: input.memoryId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async createUserMemory(input) {
      // owner = actor（service 强制 + DB CHECK owner_user_id=created_by_user_id 双保险）。
      const { userId, ...payload } = input;
      try {
        const memory = await systemUserMemory.createUserMemory({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async reviseUserMemory(input) {
      // 先取 owner 验证本人（AC#6 fail-closed），再 revise。
      const existing = await repositories.userMemory.getById({ id: input.memoryId });
      if (!existing) return makeFailure('NOT_FOUND', 'User Memory not found');
      if (!canManageUserMemory(input.userId, existing.ownerUserId)) {
        return makeFailure('FORBIDDEN', 'No permission to manage this User Memory');
      }
      const { userId, ...payload } = input;
      try {
        const memory = await systemUserMemory.reviseUserMemory({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async deactivateUserMemory(input) {
      const existing = await repositories.userMemory.getById({ id: input.memoryId });
      if (!existing) return makeFailure('NOT_FOUND', 'User Memory not found');
      if (!canManageUserMemory(input.userId, existing.ownerUserId)) {
        return makeFailure('FORBIDDEN', 'No permission to manage this User Memory');
      }
      const { userId, ...payload } = input;
      try {
        const memory = await systemUserMemory.deactivateUserMemory({ ...payload, actorId: userId });
        return makeSuccess({ memory });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    async deleteUserMemory(input) {
      const existing = await repositories.userMemory.getById({ id: input.memoryId });
      if (!existing) return makeFailure('NOT_FOUND', 'User Memory not found');
      if (!canManageUserMemory(input.userId, existing.ownerUserId)) {
        return makeFailure('FORBIDDEN', 'No permission to manage this User Memory');
      }
      const { userId, ...payload } = input;
      try {
        await systemUserMemory.deleteUserMemory({ ...payload, actorId: userId });
        return makeSuccess({ deleted: true });
      } catch (error) {
        return systemUserMemoryErrorAck(error) ?? rethrow(error);
      }
    },

    // ── #722 Experience Pack ────────────────────────────────────────────

    async createExperiencePackDraft(input) {
      try {
        const pack = await experiencePack.createDraft(input);
        return makeSuccess({ pack });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async approveExperiencePack(input) {
      try {
        const pack = await experiencePack.approve(input);
        return makeSuccess({ pack });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async withdrawExperiencePack(input) {
      try {
        const pack = await experiencePack.withdraw(input);
        return makeSuccess({ pack });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async markExperiencePackSourceInvalid(input) {
      try {
        const pack = await experiencePack.markSourceInvalid(input);
        return makeSuccess({ pack });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async listExperiencePacks(input) {
      try {
        const status = input.status as ExperiencePackDto['status'] | undefined;
        const packs = await experiencePack.listByTeam({ teamId: input.teamId, status });
        return makeSuccess({ packs });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async getExperiencePack(input) {
      try {
        const pack = await experiencePack.getById({ teamId: input.teamId, packId: input.packId });
        if (!pack) return makeFailure('NOT_FOUND', 'Experience Pack not found');
        return makeSuccess({ pack });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async recommendExperiencePackToChannel(input) {
      try {
        const attachment = await experiencePack.recommendToChannel(input);
        return makeSuccess({ attachment });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async confirmExperiencePackAttachment(input) {
      try {
        const attachment = await experiencePack.confirmAttachment(input);
        return makeSuccess({ attachment });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async revokeExperiencePackAttachment(input) {
      try {
        const attachment = await experiencePack.revokeAttachment(input);
        return makeSuccess({ attachment });
      } catch (error) {
        return experiencePackErrorAck(error) ?? rethrow(error);
      }
    },

    async deleteTeam(deleteInput) {
      const actorRole = await repositories.teams.getMemberRole(deleteInput.teamId, deleteInput.userId);
      if (actorRole !== 'owner') {
        return makeFailure('FORBIDDEN', 'Only owner can delete team');
      }
      const team = await repositories.teams.getById(deleteInput.teamId);
      if (!team) {
        return makeFailure('NOT_FOUND', 'Team not found');
      }
      // Find fallback team for each affected user before cascade
      const teamMembers = await repositories.teams.listAllMembers(deleteInput.teamId);
      const affectedUserIds = teamMembers.map((m) => m.userId);
      // Find a fallback team for the actor (pick another team they belong to)
      let fallbackTeam: { id: string; name: string; path: string } | null = null;
      const actorTeams = await repositories.teams.listForUser(deleteInput.userId);
      const otherTeam = actorTeams.find((t) => t.id !== deleteInput.teamId);
      if (otherTeam) {
        fallbackTeam = { id: otherTeam.id, name: otherTeam.name, path: otherTeam.path };
        // Switch affected users to their fallback teams
        for (const userId of affectedUserIds) {
          const userTeams = await repositories.teams.listForUser(userId);
          const userFallback = userTeams.find((t) => t.id !== deleteInput.teamId);
          if (userFallback) {
            await repositories.users.setCurrentTeam(userId, userFallback.id);
          }
        }
      }
      // Cascade delete
      await repositories.teams.delete(deleteInput.teamId);
      return makeSuccess({ fallbackTeam });
    },
  };
}

async function resolveDeviceTokenActor(
  repositories: ServerNextRepositories,
  sessionSecret: string,
  input: { token: string; teamId: string },
): Promise<{ ok: true; userId: string } | Ack<Record<string, never>>> {
  const credentials = verifyDeviceToken(input.token, sessionSecret);
  if (!credentials || credentials.teamId !== input.teamId) {
    return makeFailure('UNAUTHENTICATED', 'Invalid device credentials');
  }
  const device = credentials.deviceId
    ? await repositories.devices.getById(credentials.deviceId)
    : await findDeviceByCredentials(repositories, input.teamId, credentials);
  if (!device || device.teamId !== input.teamId) {
    return makeFailure('UNAUTHENTICATED', 'Unknown device for team');
  }
  if (!(await repositories.teams.isMember(input.teamId, credentials.ownerId))) {
    return makeFailure('FORBIDDEN', 'Device owner is not a team member');
  }
  return { ok: true, userId: credentials.ownerId };
}

/**
 * #1053 跨 Team device 身份解析：device token 证明的是 Device 在其 home Team 内的
 * 身份（token 签名有效、device 记录与 token 自洽、owner 仍是 home Team 成员），
 * 不要求 token.teamId === 目标 Team。目标 Team 的资源访问授权由调用方基于该
 * Device 托管 Agent 的 visibleTeamIds + 目标 Channel membership 判定（Agent/Device
 * 换绑、visible Team 移除、membership 移除、archive 均继续 fail closed）。
 */
async function resolveHostedDeviceTokenActor(
  repositories: ServerNextRepositories,
  sessionSecret: string,
  input: { token: string },
): Promise<{ ok: true; userId: string; deviceId?: string; homeTeamId: string } | Ack<Record<string, never>>> {
  const credentials = verifyDeviceToken(input.token, sessionSecret);
  if (!credentials) {
    return makeFailure('UNAUTHENTICATED', 'Invalid device credentials');
  }
  const device = credentials.deviceId
    ? await repositories.devices.getById(credentials.deviceId)
    : await findDeviceByCredentials(repositories, credentials.teamId, credentials);
  if (!device || device.teamId !== credentials.teamId) {
    return makeFailure('UNAUTHENTICATED', 'Unknown device for team');
  }
  if (!(await repositories.teams.isMember(credentials.teamId, credentials.ownerId))) {
    return makeFailure('FORBIDDEN', 'Device owner is not a team member');
  }
  return { ok: true, userId: credentials.ownerId, deviceId: device.id, homeTeamId: credentials.teamId };
}

async function getAuthorizedArtifact(
  repositories: ServerNextRepositories,
  artifactInput: GetArtifactInput,
): Promise<{ ok: true; artifact: ArtifactRecord } | Ack<Record<string, never>>> {
  if (!(await repositories.teams.isMember(artifactInput.teamId, artifactInput.userId))) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  const artifact = await repositories.artifacts.getForTeam({
    teamId: artifactInput.teamId,
    artifactId: artifactInput.artifactId,
  });
  if (!artifact) {
    return makeFailure('NOT_FOUND', 'Artifact not found');
  }
  const channelAccess = await ensureUserCanViewChannel(repositories, {
    userId: artifactInput.userId,
    teamId: artifact.teamId,
    channelId: artifact.channelId,
  });
  if (!channelAccess.ok) {
    return channelAccess;
  }
  return { ok: true, artifact };
}

async function getAuthorizedWorkspaceRun(
  repositories: ServerNextRepositories,
  runInput: GetWorkspaceRunInput,
): Promise<{ ok: true; workspaceRun: WorkspaceRunRecord } | Ack<Record<string, never>>> {
  if (!(await repositories.teams.isMember(runInput.teamId, runInput.userId))) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  const workspaceRun = await repositories.workspaceRuns.getForTeam({
    teamId: runInput.teamId,
    runId: runInput.runId,
  });
  if (!workspaceRun) {
    return makeFailure('NOT_FOUND', 'Workspace run not found');
  }
  const channelAccess = await ensureUserCanViewChannel(repositories, {
    userId: runInput.userId,
    teamId: workspaceRun.teamId,
    channelId: workspaceRun.channelId,
  });
  if (!channelAccess.ok) {
    return channelAccess;
  }
  return { ok: true, workspaceRun };
}

/**
 * #830 导出：回填要在 dry-run 下给出与 apply 完全一致的裁决，就必须用**同一段**
 * 可见性/来源判定，而不是另写一份 SQL 复刻。导出只读判定函数是让两条路径共享真相的
 * 最小代价；写入路径依旧只有 createProjectDocumentBundle 一个入口。
 */
export async function isPublicWorkspaceRun(
  repositories: ServerNextRepositories,
  run: WorkspaceRunRecord,
): Promise<boolean> {
  const attempt = await repositories.management.dispatchAttempts.getByDispatchId(run.dispatchId);
  if (!attempt) return true;
  const handoff = await repositories.management.handoffs.getByInvocationId(attempt.invocationId);
  return !handoff || handoff.intent.returnMode === 'deliver_to_root';
}

async function isPublicArtifact(
  repositories: ServerNextRepositories,
  artifact: ArtifactRecord,
): Promise<boolean> {
  if (artifact.workspaceRunId) {
    const run = await repositories.workspaceRuns.getForTeam({ teamId: artifact.teamId, runId: artifact.workspaceRunId });
    if (run && !(await isPublicWorkspaceRun(repositories, run))) return false;
  }
  if (artifact.dispatchId) {
    const attempt = await repositories.management.dispatchAttempts.getByDispatchId(artifact.dispatchId);
    if (!attempt) return true;
    const handoff = await repositories.management.handoffs.getByInvocationId(attempt.invocationId);
    return !handoff || handoff.intent.returnMode === 'deliver_to_root';
  }
  return true;
}

async function getAttachableUploadedArtifacts(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; channelId: string; artifactIds: string[] },
): Promise<Ack<{ artifacts: ArtifactRecord[] }>> {
  const artifacts: ArtifactRecord[] = [];
  for (const artifactId of uniqueIds(input.artifactIds)) {
    const artifact = await repositories.artifacts.getForTeam({
      teamId: input.teamId,
      artifactId,
    });
    if (!artifact) {
      return makeFailure('NOT_FOUND', 'Artifact not found');
    }
    if (
      artifact.channelId !== input.channelId ||
      artifact.uploaderId !== input.userId ||
      artifact.pathKind !== 'upload' ||
      artifact.messageId !== undefined
    ) {
      return makeFailure('FORBIDDEN', 'Artifact cannot be attached to this message');
    }
    artifacts.push(artifact);
  }
  return makeSuccess({ artifacts });
}

function toUserDto(user: UserDto): UserDto {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    primaryTeamId: user.primaryTeamId,
    email: user.email,
  };
}

function toTeamDto(team: Omit<TeamDto, 'currentUserRole'>, currentUserRole: TeamDto['currentUserRole']): TeamDto {
  return {
    id: team.id,
    name: team.name,
    path: team.path,
    visibility: team.visibility,
    ownerId: team.ownerId,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    currentUserRole,
  };
}

function toJoinLinkDto(link: JoinLinkRecord): JoinLinkDto {
  return {
    id: link.id,
    code: link.code,
    teamId: link.teamId,
    createdBy: link.createdBy,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
    maxUses: link.maxUses,
    usesCount: link.usesCount,
    revokedAt: link.revokedAt,
  };
}

function collapseByCanonical(devices: DeviceRecord[]): DeviceRecord[] {
  // 按 effectiveCanonical（canonicalDeviceId ?? id）折叠别名集群。
  // 代表选取复用 preferDeviceRecord（与 dedupeByHeuristic 同一语义）：
  // 选更新/更近活跃/host 状态更好的记录，与既有 canonical 代表语义保持一致。
  const groups = new Map<string, DeviceRecord[]>();
  for (const device of devices) {
    const key = device.canonicalDeviceId ?? device.id;
    const group = groups.get(key);
    if (group) {
      group.push(device);
    } else {
      groups.set(key, [device]);
    }
  }
  const result: DeviceRecord[] = [];
  for (const group of groups.values()) {
    const representative = group.reduce(
      (best, device) => (best === undefined ? device : preferDeviceRecord(device, best)),
      group[0]!,
    );
    result.push(representative);
  }
  return result;
}

function dedupeDeviceRecords(devices: DeviceRecord[]): DeviceRecord[] {
  // 先按持久化 canonical 关系折叠，再用原 heuristic（machineKey/displayKey）兜底处理未建立关系的记录。
  return dedupeByHeuristic(collapseByCanonical(devices));
}

function dedupeByHeuristic(devices: DeviceRecord[]): DeviceRecord[] {
  const result: DeviceRecord[] = [];
  const indexByMachineKey = new Map<string, number>();
  const indexByDisplayKey = new Map<string, number>();
  for (const device of devices) {
    const machineKey = deviceMachineKey(device);
    const displayKey = deviceDisplayKey(device);
    const machineMatch = machineKey ? indexByMachineKey.get(machineKey) : undefined;
    const displayMatch = displayKey ? indexByDisplayKey.get(displayKey) : undefined;
    const existingIndex = machineMatch ?? (
      displayMatch !== undefined && (!machineKey || !deviceMachineKey(result[displayMatch]!))
        ? displayMatch
        : undefined
    );
    if (existingIndex === undefined) {
      indexDeviceRecord(result.length, device, indexByMachineKey, indexByDisplayKey);
      result.push(device);
      continue;
    }
    result[existingIndex] = preferDeviceRecord(device, result[existingIndex]!);
    indexDeviceRecord(existingIndex, result[existingIndex]!, indexByMachineKey, indexByDisplayKey);
    indexDeviceRecord(existingIndex, device, indexByMachineKey, indexByDisplayKey);
  }
  return result;
}

function resolveCanonicalDeviceRecord(device: DeviceRecord, teamDevices: DeviceRecord[]): DeviceRecord {
  return dedupeDeviceRecords(teamDevices).find((candidate) => deviceRecordsCanAlias(candidate, device)) ?? device;
}

function resolveDeviceAliasGroup(device: DeviceRecord, teamDevices: DeviceRecord[]): DeviceRecord[] {
  const canonicalDevice = resolveCanonicalDeviceRecord(device, teamDevices);
  const aliases = teamDevices.filter((candidate) =>
    deviceRecordsCanAlias(candidate, canonicalDevice) || deviceRecordsCanAlias(candidate, device),
  );
  return aliases.length > 0 ? aliases : [device];
}

function deviceRecordsCanAlias(a: DeviceRecord, b: DeviceRecord): boolean {
  if (a.id === b.id) return true;
  if (deviceCanonicalKey(a) === deviceCanonicalKey(b)) return true;
  const aMachineKey = deviceMachineKey(a);
  const bMachineKey = deviceMachineKey(b);
  if (aMachineKey && bMachineKey) return aMachineKey === bMachineKey;
  const aDisplayKey = deviceDisplayKey(a);
  const bDisplayKey = deviceDisplayKey(b);
  return Boolean(aDisplayKey && bDisplayKey && aDisplayKey === bDisplayKey && (!aMachineKey || !bMachineKey));
}

function deviceCanonicalKey(device: DeviceRecord): string {
  return ['canonical-device', device.teamId, device.ownerId, device.canonicalDeviceId ?? device.id].join('\u0000');
}

function indexDeviceRecord(
  index: number,
  device: DeviceRecord,
  indexByMachineKey: Map<string, number>,
  indexByDisplayKey: Map<string, number>,
): void {
  const machineKey = deviceMachineKey(device);
  if (machineKey) indexByMachineKey.set(machineKey, index);
  const displayKey = deviceDisplayKey(device);
  if (displayKey) indexByDisplayKey.set(displayKey, index);
}

function deviceMachineKey(device: DeviceRecord): string | null {
  if (!device.machineId || !device.profileId) return null;
  return [
    'machine-profile',
    device.teamId,
    device.ownerId,
    normalizeDeviceKey(device.machineId),
    normalizeDeviceKey(device.profileId),
  ].join('\u0000');
}

function deviceDisplayKey(device: DeviceRecord): string | null {
  const displayName = normalizeDeviceKey(device.name ?? device.systemInfo?.hostname);
  if (!displayName) return null;
  return ['display-name', device.teamId, device.ownerId, displayName].join('\u0000');
}

function normalizeDeviceKey(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function preferDeviceRecord(candidate: DeviceRecord, current: DeviceRecord): DeviceRecord {
  const identityDelta = deviceIdentityRank(candidate) - deviceIdentityRank(current);
  if (identityDelta !== 0) return identityDelta > 0 ? candidate : current;
  const updatedDelta = (candidate.updatedAt ?? 0) - (current.updatedAt ?? 0);
  if (updatedDelta !== 0) return updatedDelta > 0 ? candidate : current;
  const lastSeenDelta = (candidate.lastSeenAt ?? 0) - (current.lastSeenAt ?? 0);
  if (lastSeenDelta !== 0) return lastSeenDelta > 0 ? candidate : current;
  return deviceStatusRank(candidate.status) > deviceStatusRank(current.status) ? candidate : current;
}

function deviceIdentityRank(device: DeviceRecord): number {
  return deviceMachineKey(device) ? 2 : 1;
}

function deviceStatusRank(status: DeviceRecord['status']): number {
  if (status === 'online') return 3;
  if (status === 'unknown') return 2;
  return 1;
}

function toDeviceInviteDto(invite: DeviceInviteRecord, command?: string): DeviceInviteDto {
  return {
    id: invite.id,
    code: invite.code,
    teamId: invite.teamId,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    completedAt: invite.completedAt,
    profileId: invite.profileId,
    command,
    operationCommands: command ? DEVICE_SERVICE_OPERATION_COMMANDS.map((item) => ({ ...item })) : undefined,
  };
}

async function markDeviceAndHostedAgentsOffline(
  repositories: ServerNextRepositories,
  device: DeviceRecord,
  timestamp: UnixMs,
): Promise<{ updated: DeviceRecord | null; hostedAgents: AgentRecord[] }> {
  const hostedAgents = await repositories.agents.listByDevice(device.id);
  const updated = await repositories.devices.markOffline({
    deviceId: device.id,
    timestamp,
  });
  for (const agent of hostedAgents) {
    if (agent.status === 'offline') {
      continue;
    }
    await repositories.agents.updateStatus({
      agentId: agent.id,
      status: 'offline',
      lastSeenAt: timestamp,
      lastError: agent.lastError,
    });
  }
  return { updated, hostedAgents };
}

// 是否为当前 web 连接所在的本地设备。currentDeviceId 来自 web socket auth（getStoredDeviceId）；
// 与 device.id / canonicalDeviceId / machineId 任一命中即视为本地（兼容别名集群与历史 machineId 注册）。
// currentDeviceId 为 undefined 时调用方应不下发 isLocal（daemon/admin 路径）；为 null 或不命中时 fail-closed 为 false。
function isDeviceLocalToHint(
  device: { id?: string | null; canonicalDeviceId?: string | null; machineId?: string | null } | null | undefined,
  currentDeviceId?: string | null,
): boolean {
  if (!device?.id || !currentDeviceId) return false;
  if (device.id === currentDeviceId) return true;
  if (device.canonicalDeviceId && device.canonicalDeviceId === currentDeviceId) return true;
  return Boolean(device.machineId && device.machineId === currentDeviceId);
}

function toDeviceDto(device: DeviceDto, currentDeviceId?: string | null): DeviceDto {
  const daemonVersionInfo = buildDaemonVersionInfo(
    device.systemInfo as Record<string, unknown> | null | undefined,
    device.daemonVersion,
  );
  const dto: DeviceDto = {
    id: device.id,
    teamId: device.teamId,
    ownerId: device.ownerId,
    status: device.status,
    name: device.name,
    systemInfo: device.systemInfo,
    capabilities: device.capabilities,
    daemonVersion: device.daemonVersion,
    daemonVersionInfo,
    latestDaemonVersion: daemonVersionInfo.latest,
    daemonUpdateAvailable: daemonVersionInfo.updateAvailable,
    profileId: device.profileId,
    lastSeenAt: device.lastSeenAt,
  };
  if (currentDeviceId !== undefined) {
    dto.isLocal = isDeviceLocalToHint(device, currentDeviceId);
  }
  return dto;
}

async function toDeviceDtoWithOwnerName(repositories: ServerNextRepositories, device: DeviceDto, currentDeviceId?: string | null): Promise<DeviceDto> {
  return (await toDeviceDtosWithOwnerNames(repositories, [device], currentDeviceId))[0] ?? toDeviceDto(device, currentDeviceId);
}

async function toDeviceDtosWithOwnerNames(repositories: ServerNextRepositories, devices: DeviceDto[], currentDeviceId?: string | null): Promise<DeviceDto[]> {
  const dtos = devices.map((device) => toDeviceDto(device, currentDeviceId));
  const ownerIdsByTeam = new Map<string, Set<string>>();
  for (const device of dtos) {
    if (!device.teamId || !device.ownerId) {
      continue;
    }
    const ownerIds = ownerIdsByTeam.get(device.teamId) ?? new Set<string>();
    ownerIds.add(device.ownerId);
    ownerIdsByTeam.set(device.teamId, ownerIds);
  }

  const ownerNames = new Map<string, string>();
  await Promise.all(
    Array.from(ownerIdsByTeam.entries()).map(async ([teamId, ownerIds]) => {
      const members = await repositories.teams.listMembersByIds(teamId, Array.from(ownerIds));
      for (const member of members) {
        ownerNames.set(deviceOwnerKey(member.teamId, member.userId), member.displayName ?? member.username);
      }
    }),
  );

  return dtos.map((device) => ({
    ...device,
    ownerName: ownerNames.get(deviceOwnerKey(device.teamId, device.ownerId)) ?? device.ownerName,
  }));
}

function deviceOwnerKey(teamId: string, userId: string): string {
  return `${teamId}:${userId}`;
}

function toRuntimeDto(runtime: RuntimeDto): RuntimeDto {
  return {
    id: runtime.id,
    deviceId: runtime.deviceId,
    adapterKind: runtime.adapterKind,
    name: runtime.name,
    installed: runtime.installed,
    command: runtime.command,
    cwd: runtime.cwd,
    normalizedCommandKey: runtime.normalizedCommandKey,
    normalizedCwdKey: runtime.normalizedCwdKey,
    version: runtime.version,
    lastSeenAt: runtime.lastSeenAt,
  };
}

async function requireGlobalAdmin(
  repositories: ServerNextRepositories,
  userId: string,
): Promise<{ ok: true; user: UserRecord } | Ack<{}>> {
  const user = await repositories.users.getById(userId);
  if (!user) {
    return makeFailure('UNAUTHENTICATED', 'User not found');
  }
  if (user.role !== 'admin') {
    return makeFailure('FORBIDDEN', 'Admin access required');
  }
  return { ok: true, user };
}

/** System identity: id or username "system" must not be edited/deleted via admin ops. */
function isProtectedSystemUser(user: Pick<UserRecord, 'id' | 'username'>): boolean {
  return user.id === 'system' || user.username === 'system';
}

const ADMIN_LIST_DEFAULT_PAGE_SIZE = 20;
const ADMIN_LIST_MAX_PAGE_SIZE = 100;

function normalizeAdminListPagination(input: { page?: number; pageSize?: number }): {
  page: number;
  pageSize: number;
} {
  const pageRaw = input.page;
  const page = typeof pageRaw === 'number' && Number.isFinite(pageRaw) && pageRaw >= 1
    ? Math.floor(pageRaw)
    : 1;
  const pageSizeRaw = input.pageSize;
  if (typeof pageSizeRaw !== 'number' || !Number.isFinite(pageSizeRaw) || pageSizeRaw < 1) {
    return { page, pageSize: ADMIN_LIST_DEFAULT_PAGE_SIZE };
  }
  return {
    page,
    pageSize: Math.min(ADMIN_LIST_MAX_PAGE_SIZE, Math.floor(pageSizeRaw)),
  };
}

/** Trim and lowercase keyword; empty/whitespace → undefined (no filter). */
function normalizeAdminListQuery(q: unknown): string | undefined {
  if (typeof q !== 'string') {
    return undefined;
  }
  const trimmed = q.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

function adminInventoryMatchesQuery(
  q: string,
  fields: Array<string | null | undefined>,
): boolean {
  return fields.some((field) => typeof field === 'string' && field.toLowerCase().includes(q));
}

function adminInventoryCreatedAt(item: { createdAt?: number | null; lastSeenAt?: number | null }): number {
  return item.createdAt ?? item.lastSeenAt ?? 0;
}

function sortAdminInventoryByCreatedAtDesc<T extends { id: string; createdAt?: number | null; lastSeenAt?: number | null }>(
  items: T[],
): T[] {
  return [...items].sort((left, right) => {
    const createdDelta = adminInventoryCreatedAt(right) - adminInventoryCreatedAt(left);
    if (createdDelta !== 0) {
      return createdDelta;
    }
    return right.id.localeCompare(left.id);
  });
}

function sliceAdminInventoryPage<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  if (start >= items.length) {
    return [];
  }
  return items.slice(start, start + pageSize);
}

async function toAdminAgentDtos(
  repositories: ServerNextRepositories,
  agents: AgentRecord[],
): Promise<AdminAgentDto[]> {
  if (agents.length === 0) {
    return [];
  }
  const deviceIds = uniqueIds(agents.map((agent) => agent.deviceId ?? ''));
  const [devices, users, teams] = await Promise.all([
    Promise.all(deviceIds.map((deviceId) => repositories.devices.getById(deviceId))),
    repositories.users.listAll(),
    repositories.teams.listAll(),
  ]);
  const devicesById = new Map(
    devices.filter((device): device is DeviceRecord => Boolean(device)).map((device) => [device.id, device]),
  );
  const usersById = new Map(users.map((user) => [user.id, user]));
  const teamsById = new Map(teams.map((team) => [team.id, team]));
  return agents.map((agent) => toAdminAgentDto(agent, {
    device: agent.deviceId ? devicesById.get(agent.deviceId) : undefined,
    usersById,
    teamsById,
  }));
}

async function toAdminDeviceDto(
  repositories: ServerNextRepositories,
  device: DeviceRecord,
): Promise<AdminDeviceDto> {
  const [owner, team, agents, runtimes, allUsers, allTeams] = await Promise.all([
    repositories.users.getById(device.ownerId),
    repositories.teams.getById(device.teamId),
    repositories.agents.listByDevice(device.id),
    repositories.runtimes.listByDevice(device.id),
    repositories.users.listAll(),
    repositories.teams.listAll(),
  ]);
  const usersById = new Map(allUsers.map((user) => [user.id, user]));
  const teamsById = new Map(allTeams.map((candidate) => [candidate.id, candidate]));
  const adminAgents = agents.map((agent) => toAdminAgentDto(agent, { device, usersById, teamsById }));
  return {
    ...toDeviceDto(device),
    userId: device.ownerId,
    userName: owner?.username ?? '未知用户',
    teamName: team?.name ?? '未知团队',
    agentCount: agents.length,
    runtimes: runtimes.map(toRuntimeDto),
    agents: adminAgents,
  };
}

function toAdminAgentDto(
  agent: AgentRecord,
  context: {
    device?: DeviceRecord;
    usersById: Map<string, UserRecord>;
    teamsById: Map<string, Omit<TeamDto, 'currentUserRole'>>;
  },
): AdminAgentDto {
  const ownerId = agent.ownerId ?? context.device?.ownerId;
  const owner = ownerId ? context.usersById.get(ownerId) : undefined;
  const deviceOwner = context.device?.ownerId ? context.usersById.get(context.device.ownerId) : undefined;
  const team = context.teamsById.get(agent.primaryTeamId);
  return {
    ...toPublicAgent(agent),
    role: undefined,
    primaryTeamName: team?.name ?? '未知团队',
    ownerId,
    ownerName: owner?.username ?? null,
    userName: owner?.username ?? null,
    deviceName: context.device ? deviceDisplayName(context.device) : '未分配设备',
    deviceUserId: context.device?.ownerId ?? null,
    deviceUserName: deviceOwner?.username ?? null,
  };
}

function deviceDisplayName(device: DeviceRecord): string {
  return device.name ?? device.systemInfo?.hostname ?? '未命名设备';
}

function summarizeDispatchMetrics(dispatches: DispatchDto[]): AgentMetricsSummary[] {
  const byAgent = new Map<string, DispatchDto[]>();
  for (const dispatch of dispatches) {
    const list = byAgent.get(dispatch.agentId);
    if (list) {
      list.push(dispatch);
    } else {
      byAgent.set(dispatch.agentId, [dispatch]);
    }
  }
  const summaries: AgentMetricsSummary[] = [];
  for (const [agentId, list] of byAgent) {
    const latencies = list
      .filter((d) => d.completedAt !== undefined)
      .map((d) => d.completedAt! - d.createdAt)
      .sort((a, b) => a - b);
    const successCount = list.filter((d) => d.status === 'succeeded').length;
    const failCount = list.filter((d) => d.status === 'failed' || d.status === 'timed_out').length;
    const avgResponseMs = latencies.length > 0
      ? Math.round(latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length)
      : 0;
    const p95Index = Math.floor(latencies.length * 0.95);
    const p95ResponseMs = latencies.length > 0 ? latencies[Math.min(p95Index, latencies.length - 1)]! : 0;
    const lastFailed = list
      .filter((d) => (d.status === 'failed' || d.status === 'timed_out') && d.completedAt !== undefined)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0];
    summaries.push({
      agentId,
      totalRequests: list.length,
      successCount,
      failCount,
      avgResponseMs,
      p95ResponseMs,
      lastError: lastFailed?.error,
      lastErrorAt: lastFailed?.completedAt,
    });
  }
  return summaries;
}

function toDispatchDto(dispatch: DispatchDto): DispatchDto {
  return {
    id: dispatch.id,
    teamId: dispatch.teamId,
    channelId: dispatch.channelId,
    messageId: dispatch.messageId,
    agentId: dispatch.agentId,
    status: dispatch.status,
    requestId: dispatch.requestId,
    createdAt: dispatch.createdAt,
    updatedAt: dispatch.updatedAt,
    acceptedAt: dispatch.acceptedAt,
    completedAt: dispatch.completedAt,
    error: dispatch.error,
    lastHeartbeatAt: dispatch.lastHeartbeatAt,
  };
}

async function toWorkspaceRunDto(
  repositories: ServerNextRepositories,
  run: WorkspaceRunRecord,
  requesterUserId: string,
): Promise<WorkspaceRunDto> {
  const dispatch = await repositories.dispatches.getById(run.dispatchId);
  const attempt = await repositories.management.dispatchAttempts.getByDispatchId(run.dispatchId);
  const invocation = attempt ? await repositories.management.invocations.getById(attempt.invocationId) : null;
  const memoryCapsuleRef = invocation?.intent.memoryCapsuleRef;
  const canReadCapsule = memoryCapsuleRef
    ? await canReadMemoryCapsule(repositories, {
        teamId: run.teamId,
        requesterUserId,
        capsuleId: memoryCapsuleRef.id,
      })
    : false;
  return {
    ...run,
    ...(dispatch?.messageId && dispatch.messageId !== run.messageId ? { sourceMessageId: dispatch.messageId } : {}),
    ...(invocation ? { managementInvocationId: invocation.id } : {}),
    ...(memoryCapsuleRef && canReadCapsule ? { memoryCapsuleRef } : {}),
  };
}

function resolveWorkspaceStagingLimits(limits?: { maxFileBytes?: number; maxPublishBytes?: number }) {
  return {
    maxFileBytes: limits?.maxFileBytes ?? DEFAULT_WORKSPACE_STAGING_FILE_MAX_BYTES,
    maxPublishBytes: limits?.maxPublishBytes ?? DEFAULT_WORKSPACE_STAGING_PUBLISH_MAX_BYTES,
  };
}

/** path + size + sha 清单是否与 revision 一致（用于 commit 半态恢复，不依赖 artifactId）。 */
function stagingManifestMatchesRevision(
  staging: WorkspacePublishStagingRecord,
  revision: { files: ReadonlyArray<{ path: string; sizeBytes: number; sha256?: string }> },
): boolean {
  if (staging.files.length !== revision.files.length) return false;
  const byPath = new Map(revision.files.map((file) => [file.path, file]));
  for (const file of staging.files) {
    const hit = byPath.get(file.path);
    if (!hit) return false;
    if (hit.sizeBytes !== file.expectedSizeBytes) return false;
    if ((hit.sha256 ?? '').toLowerCase() !== file.expectedSha256.toLowerCase()) return false;
  }
  return true;
}

/** #967 hardening：清理 commit 冲突/重复物化产生的孤儿 artifact + content store。 */
async function deleteOrphanWorkspaceStagingArtifacts(
  repositories: ServerNextRepositories,
  artifactContentStore: ArtifactContentStore | undefined,
  input: { teamId: string; artifactIds: readonly string[] },
): Promise<void> {
  for (const artifactId of input.artifactIds) {
    try {
      await repositories.artifacts.deleteForTeam({ teamId: input.teamId, artifactId });
    } catch {
      // best-effort：不因清理失败掩盖主错误
    }
    try {
      await artifactContentStore?.deleteContent?.({ teamId: input.teamId, artifactId });
    } catch {
      // best-effort
    }
  }
}

/**
 * #967 半态恢复：revision 已前进且内容与 staging plan 一致，但 staging 仍为 open。
 * 补标 committed 并返回最终结果，避免 publishId 永久不可查询。
 */
async function recoverCommittedWorkspaceStagingIfPublished(input: {
  repositories: ServerNextRepositories;
  staging: WorkspacePublishStagingRecord;
  workspace: ProjectChannelWorkspaceRecord;
  now: number;
}): Promise<Ack<{ staging: WorkspacePublishStagingDto; workspace?: ProjectChannelWorkspaceDto }> | null> {
  const { repositories, staging, workspace, now } = input;
  if (staging.status === 'committed') return null;
  // 基线仍等于当前 → 尚未发布（或无变化），不能当作已发布恢复。
  if (staging.baselineRevisionId === workspace.currentRevision.id) return null;
  if (!stagingManifestMatchesRevision(staging, workspace.currentRevision)) return null;
  const committed = await repositories.workspacePublishStagings.update({
    ...staging,
    status: 'committed',
    committedRevisionId: workspace.currentRevision.id,
    committedWorkspaceId: workspace.id,
    files: staging.files.map((file) => ({
      path: file.path,
      filename: file.filename,
      mimeType: file.mimeType,
      expectedSizeBytes: file.expectedSizeBytes,
      expectedSha256: file.expectedSha256,
      receivedBytes: file.receivedBytes,
      complete: true,
    })),
    updatedAt: now,
  });
  return makeSuccess({
    staging: toWorkspacePublishStagingDto(committed),
    workspace,
  });
}

function coerceStagingContent(content: Buffer | Uint8Array | string): Buffer {
  if (Buffer.isBuffer(content)) return content;
  if (content instanceof Uint8Array) return Buffer.from(content);
  return Buffer.from(content, 'base64');
}

/** #1005：优先从磁盘 staging store 读；否则回退 memory Buffer / 旧 BLOB 行。 */
async function resolveWorkspaceStagingFileContent(
  store: WorkspaceStagingContentStore | undefined,
  staging: WorkspacePublishStagingRecord,
  file: WorkspacePublishStagingFileRecord,
): Promise<Buffer> {
  if (store && (file.storagePath || file.receivedBytes > 0)) {
    const fromDisk = await store.readContent({
      teamId: staging.teamId,
      publishId: staging.publishId,
      path: file.path,
      ...(file.storagePath ? { storagePath: file.storagePath } : {}),
    });
    if (fromDisk) return fromDisk;
  }
  return file.content ? Buffer.from(file.content) : Buffer.alloc(0);
}

/** #967 DTO 剥离私有 content，确保上传中字节不经 API 泄漏到频道侧。 */
function toWorkspacePublishStagingDto(record: WorkspacePublishStagingRecord): WorkspacePublishStagingDto {
  return {
    publishId: record.publishId,
    teamId: record.teamId,
    channelId: record.channelId,
    baselineRevisionId: record.baselineRevisionId,
    status: record.status,
    files: record.files.map((file) => ({
      path: file.path,
      filename: file.filename,
      mimeType: file.mimeType,
      expectedSizeBytes: file.expectedSizeBytes,
      expectedSha256: file.expectedSha256,
      receivedBytes: file.receivedBytes,
      complete: file.complete,
    })),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.committedRevisionId ? { committedRevisionId: record.committedRevisionId } : {}),
    ...(record.committedWorkspaceId ? { committedWorkspaceId: record.committedWorkspaceId } : {}),
    ...(record.provenance ? { provenance: record.provenance } : {}),
  };
}

function toArtifactDto(artifact: ArtifactRecord): ArtifactDto {
  return {
    id: artifact.id,
    teamId: artifact.teamId,
    channelId: artifact.channelId,
    messageId: artifact.messageId,
    dispatchId: artifact.dispatchId,
    workspaceRunId: artifact.workspaceRunId,
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    relativePath: artifact.relativePath,
    pathKind: artifact.pathKind,
    role: artifact.role,
    sourceRoot: artifact.sourceRoot,
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
  };
}

// Structural so it accepts both the persisted ArtifactRecord and the serialized ArtifactDto —
// the log must be hidden from every chat-facing message read path (history, DM snapshot, search,
// and the real-time dispatch-result broadcast), not just the workspace-run detail endpoint.
function isWorkspaceRunLogArtifact(
  artifact: Pick<ArtifactRecord, 'workspaceRunId' | 'relativePath' | 'filename'>,
): boolean {
  return artifact.workspaceRunId !== undefined
    && (artifact.relativePath === 'logs/workspace-run.log' || artifact.filename === 'workspace-run.log');
}

function toDispatchAttachmentDto(artifact: ArtifactRecord): DispatchAttachmentDto {
  return {
    id: artifact.id,
    name: artifact.filename,
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
  };
}

function toAgentWorkspaceRunListItem(
  run: WorkspaceRunRecord,
  artifacts: ArtifactRecord[],
): AgentWorkspaceRunListItemDto {
  return {
    runId: run.id,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: run.status,
    cwd: run.cwd,
    command: run.command,
    exitCode: run.exitCode,
    files: artifacts.map((artifact) => ({
      ...toArtifactDto(artifact),
      pathKind: artifact.pathKind ?? 'workspace',
      relativePath: artifact.relativePath ?? artifact.filename,
    })),
  };
}

async function enrichMessagesWithArtifacts(
  repositories: ServerNextRepositories,
  messages: MessageRecord[],
): Promise<MessageDto[]> {
  const enriched: MessageDto[] = [];
  for (const message of messages) {
    // ADR-0066：PI Manager 系统消息（management-status / coordination 协调输出）不在用户对话视图出现，
    // 服务端在序列化边界统一过滤，使前端不再收到这些消息（replyCount、Thread 面板随之正确）。
    if (isHiddenSystemMessage({ senderKind: message.senderKind, meta: message.meta })) continue;
    const isDeleted = isDeletedMessage(message);
    // The internal workspace-run.log is reachable via the workspace-run detail endpoint; it must
    // not leak into chat-facing message attachments (channel history, DM snapshot, search results).
    const artifacts = isDeleted
      ? []
      : (await repositories.artifacts.listByMessage(message.id))
          .filter((artifact) => !isWorkspaceRunLogArtifact(artifact));
    const workspaceRunId = !isDeleted && typeof message.meta?.workspaceRunId === 'string' ? message.meta.workspaceRunId : undefined;
    const workspaceRun = workspaceRunId
      ? await repositories.workspaceRuns.getForTeam({ teamId: message.teamId, runId: workspaceRunId })
      : null;
    // 投影 dispatch 状态：dispatchStatus/dispatchId 不在 MessageRecord，靠 dispatches.listByMessage 查。
    // 进行中的优先（让前端切频道/刷新后能恢复「正在处理」）；否则取最新一条的终态。
    const dispatches = isDeleted ? [] : await repositories.dispatches.listByMessage(message.id);
    const chosenDispatch = dispatches.find((d) => isPendingDispatchStatus(d.status)) ?? dispatches[dispatches.length - 1];
    const referenceSet = isDeleted
      ? null
      : await repositories.projectReferenceSets.getByMessageId({
        teamId: message.teamId,
        channelId: message.channelId,
        messageId: message.id,
      });
    enriched.push({
      ...message,
      ...(artifacts.length > 0 ? { artifacts: artifacts.map(toArtifactDto) } : {}),
      ...(workspaceRun ? { workspaceRun } : {}),
      ...(chosenDispatch ? { dispatchStatus: chosenDispatch.status, dispatchId: chosenDispatch.id } : {}),
      ...(referenceSet ? { referenceSet: toProjectReferenceSetDto(referenceSet) } : {}),
    });
  }
  return enriched;
}

function isDeletedMessage(message: MessageRecord): boolean {
  return Boolean(message.meta?.deletedAt);
}

async function resolveExplicitThreadRootId(
  repositories: ServerNextRepositories,
  message: MessageRecord,
): Promise<ID | null> {
  if (!message.threadId || message.threadId === message.id) {
    return null;
  }
  if (message.meta?.replyScope === 'thread') {
    return message.threadId;
  }
  const root = await repositories.messages.getById(message.threadId);
  const isTopLevelAgentReply = message.senderKind === 'agent'
    && (
      (root !== null && root.threadId === root.id)
      || (root === null && message.meta?.replyScope === 'channel')
    );
  return isTopLevelAgentReply ? null : message.threadId;
}

function uniqueMessagesById(messages: MessageRecord[]): MessageRecord[] {
  const byId = new Map<ID, MessageRecord>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return [...byId.values()];
}

function toDmChannelDto(channel: ChannelDto, agent: AgentDto): DmChannelDto {
  return {
    channel,
    agent,
  };
}

function toDispatchHistoryMessageDto(message: MessageRecord): DispatchHistoryMessageDto {
  return {
    messageId: message.id,
    threadId: message.threadId,
    senderKind: message.senderKind,
    senderId: message.senderId,
    body: message.body,
    createdAt: message.createdAt,
  };
}

const DISPATCH_PROMPT_COALESCING_CHANNEL_WINDOW = 100;

async function acquireKeyedLock(
  locks: Map<string, Promise<void>>,
  key: string,
): Promise<() => void> {
  const previous = locks.get(key) ?? Promise.resolve();
  let releaseCurrent: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  locks.set(key, current);
  await previous;
  return () => {
    releaseCurrent?.();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  };
}

async function touchPendingCoalescibleDispatch(
  repositories: ServerNextRepositories,
  input: { message: MessageRecord; updatedAt: UnixMs },
): Promise<string | undefined> {
  const dispatches = await repositories.dispatches.listByTeam(input.message.teamId);
  const candidates = dispatches
    .filter((dispatch) =>
      dispatch.channelId === input.message.channelId &&
      (dispatch.status === 'queued' || dispatch.status === 'sent') &&
      dispatch.messageId !== input.message.id
    )
    .sort((left, right) => right.createdAt - left.createdAt);

  for (const dispatch of candidates) {
    const [originMessage, agent] = await Promise.all([
      repositories.messages.getById(dispatch.messageId),
      repositories.agents.getById(dispatch.agentId),
    ]);
    if (!originMessage || !agent) {
      continue;
    }
    const promptMessages = await collectCoalescedDispatchPromptMessages(repositories, {
      originMessage,
      agent,
    });
    if (!promptMessages.some((message) => message.id === input.message.id)) {
      continue;
    }
    const touched = await repositories.dispatches.touchPending({
      dispatchId: dispatch.id,
      updatedAt: input.updatedAt,
    });
    if (touched?.changed) {
      return dispatch.id;
    }
  }
  return undefined;
}

/**
 * #718 加载 Team opted-in 的 Agent Memory 公开投影，作为 dispatch Active Memory Context 的一部分。
 * 复用 domain evaluateTeamAgentMemoryOptIn 的 fail-closed 判定（active + opt-in + revision fence）。
 * 懒过期：active 但 validUntil<=now → 标记 expired（镜像 service refreshExpiry）。
 */
async function loadAgentMemoryProjectionContext(
  repositories: ServerNextRepositories,
  input: { teamId: ID; agentId: ID; now: UnixMs },
): Promise<readonly DispatchMemoryContextItemDto[]> {
  const repo = repositories.agentMemoryProjection;
  const active = await repo.projections.getActiveByTeamAgent(input.teamId, input.agentId);
  if (active && active.validUntil !== null && active.validUntil <= input.now) {
    await repo.projections.setStatus({ id: active.id, status: 'expired', now: input.now });
    return [];
  }
  if (!active) return [];
  const optIn = await repo.optIns.getByTeamAgent(input.teamId, input.agentId);
  const verdict = evaluateTeamAgentMemoryOptIn({
    activeProjectionId: active.id,
    optIn: optIn ? { projectionId: optIn.projectionId, enabled: optIn.enabled } : null,
  });
  if (!verdict.consumable) return [];
  return [{
    schemaVersion: 1,
    id: active.id,
    kind: formalKindToStorageKind(active.kind),
    scopeType: 'agent',
    content: active.content,
    selectionReason: 'team-opted-in-agent-memory-projection',
    provenance: { origin: 'server', projectionId: active.id, sourceRefs: active.sourceRefs },
  }];
}

async function assertProjectDocumentInputSetDispatchReady(
  repositories: ServerNextRepositories,
  intent: Extract<AgentInvocationRecordDto['intent'], { schemaVersion: 2 }>,
  agent: AgentRecord,
): Promise<void> {
  const version = intent.projectDocumentInputSet.contractVersion;
  const channel = await repositories.channels.getById(intent.channelId);
  if (!channel || channel.teamId !== intent.teamId || channel.archivedAt) {
    throw new Error('PROJECT_DOCUMENT_INPUT_SET_CHANNEL_FORBIDDEN');
  }
  if (!agent.projectDocumentInputSetVersions?.includes(version)) {
    throw new Error('PROJECT_DOCUMENT_INPUT_SET_AGENT_CAPABILITY_MISSING');
  }
  const device = agent.deviceId ? await repositories.devices.getById(agent.deviceId) : null;
  if (device?.status !== 'online'
    || !device.capabilities?.projectDocumentInputSetVersions?.includes(version)) {
    throw new Error('PROJECT_DOCUMENT_INPUT_SET_DEVICE_CAPABILITY_MISSING');
  }
  if (intent.taskContext) {
    const task = await repositories.tasks.getById(intent.taskContext.taskId);
    if (!task || task.teamId !== intent.teamId || task.channelId !== intent.channelId
      || task.revision !== intent.taskContext.taskRevision) {
      throw new Error('PROJECT_DOCUMENT_INPUT_SET_TASK_REVISION_STALE');
    }
    const gate = await resolveProjectStageExecutionGate(repositories, task);
    if (gate.boundStageTaskRevision !== null
      && gate.boundStageTaskRevision !== task.revision) {
      throw new Error('PROJECT_DOCUMENT_INPUT_SET_STAGE_REVISION_STALE');
    }
    if (gate.blocked) throw new Error('PROJECT_DOCUMENT_INPUT_SET_STAGE_BLOCKED');
  }
  for (const item of intent.projectDocumentInputSet.items) {
    const document = await repositories.channelDocuments.getForTeam({
      teamId: intent.teamId,
      channelId: intent.channelId,
      documentId: item.documentId,
    });
    const revision = await repositories.channelDocuments.getRevision({
      documentId: item.documentId,
      revisionId: item.baseRevisionId,
    });
    if (!document || !revision
      || revision.artifact.id !== item.artifactId
      || revision.artifact.teamId !== intent.teamId
      || revision.artifact.channelId !== intent.channelId
      || revision.artifact.sha256 !== item.sha256
      || revision.artifact.sizeBytes !== item.sizeBytes) {
      throw new Error('PROJECT_DOCUMENT_INPUT_SET_REVISION_FORBIDDEN');
    }
  }
}

async function buildDispatchRequest(
  repositories: ServerNextRepositories,
  dispatch: DispatchRecord,
  agent: AgentRecord,
  now: UnixMs,
  includeRuntimeMemory: boolean,
  serverCapsuleRuntimeContextResolver?: ServerCapsuleRuntimeContextResolver,
  projectDocumentInputSetEnabled = true,
): Promise<DispatchRequestDto & { id: string }> {
  const executionConfig = agent.source === 'custom' || (agent.source === 'scanned' && agent.command)
    ? await repositories.agents.getExecutionConfig(agent.id)
    : null;
  const originMessage = await repositories.messages.getById(dispatch.messageId);
  const managementAttempt = await repositories.management.dispatchAttempts.getByDispatchId(dispatch.id);
  const managementInvocation = managementAttempt
    ? await repositories.management.invocations.getById(managementAttempt.invocationId)
    : null;
  if (managementInvocation?.intent.schemaVersion === 2) {
    if (!projectDocumentInputSetEnabled) {
      throw new Error('PROJECT_DOCUMENT_INPUT_SET_DISABLED');
    }
    await assertProjectDocumentInputSetDispatchReady(
      repositories,
      managementInvocation.intent,
      agent,
    );
  }
  const managementHandoff = managementInvocation
    ? await repositories.management.handoffs.getByInvocationId(managementInvocation.id)
    : null;
  const history = originMessage?.threadId
    ? await repositories.messages.listThreadBefore({
        channelId: dispatch.channelId,
        threadId: originMessage.threadId,
        beforeMessageId: originMessage.id,
        limit: 20,
      })
    : [];
  const dispatchHistory = history.filter((message) => !isTaskClaimAcknowledgementMessage(message));
  const promptMessages = !managementHandoff && originMessage
    ? await collectCoalescedDispatchPromptMessages(repositories, {
        originMessage,
        agent,
      })
    : [];
  const requestPrompt = managementHandoff ? managementInvocation!.intent.objective : (promptMessages.length > 0
    ? renderCoalescedDispatchPrompt(promptMessages)
    : dispatch.prompt);
  const referenceMessageIds = promptMessages.length > 0
    ? promptMessages.map((message) => message.id)
    : [dispatch.messageId];
  const projectReferenceSets = (await Promise.all(referenceMessageIds.map((messageId) =>
    repositories.projectReferenceSets.getByMessageId({
      teamId: dispatch.teamId,
      channelId: dispatch.channelId,
      messageId,
    }))))
    .filter((set): set is ProjectReferenceSetRecord => set !== null);
  const attachments: ArtifactRecord[] = [];
  if (managementInvocation) {
    for (const artifactId of uniqueIds([...managementInvocation.intent.attachmentIds])) {
      const artifact = await repositories.artifacts.getForTeam({ teamId: dispatch.teamId, artifactId });
      if (artifact?.channelId === dispatch.channelId) attachments.push(artifact);
    }
  } else {
    // Current coalesced prompt messages always carry their own attachments.
    const promptAttachmentMessageIds = promptMessages.length > 0
      ? promptMessages.map((message) => message.id)
      : [dispatch.messageId];
    for (const messageId of promptAttachmentMessageIds) {
      attachments.push(...await repositories.artifacts.listByMessage(messageId));
    }
    // Thread history only includes message bodies. Without re-attaching prior
    // human uploads, a follow-up like "分析这张图片" has no image bytes/path and
    // the agent correctly claims no picture was provided.
    const promptMessageIdSet = new Set(promptAttachmentMessageIds);
    for (const message of dispatchHistory) {
      if (
        message.senderKind !== 'human'
        || isDeletedMessage(message)
        || promptMessageIdSet.has(message.id)
      ) {
        continue;
      }
      for (const artifact of await repositories.artifacts.listByMessage(message.id)) {
        if (isWorkspaceRunLogArtifact(artifact)) continue;
        // Only user upload attachments — not agent run outputs re-injected as inputs.
        const role = artifact.role ?? 'attachment';
        if (role !== 'attachment') continue;
        attachments.push(artifact);
      }
    }
  }
  // 冻结引用对应的精确内容也进入既有 attachment 下载链路；daemon 同时获得
  // revision/version 清单，既能读到文件，又不会把引用漂移到 current/final 指针。
  for (const set of projectReferenceSets) {
    for (const selection of set.selections) {
      for (const item of selection.items) {
        // V2 Invocation 的文档 revision 由必需 InputSet 独立交付，不能落入普通附件
        // “下载失败后跳过”的兼容链路；artifact_version 仍是普通附件。
        if (managementInvocation?.intent.schemaVersion === 2
          && item.kind === 'document_revision') {
          continue;
        }
        const artifact = item.kind === 'document_revision'
          ? (await repositories.channelDocuments.getRevision({
              documentId: item.documentId as string,
              revisionId: item.revisionId as string,
            }))?.artifact
          : await repositories.artifacts.getForTeam({
              teamId: dispatch.teamId,
              artifactId: item.artifactId as string,
            });
        if (artifact?.teamId === dispatch.teamId && artifact.channelId === dispatch.channelId) {
          attachments.push(artifact);
        }
      }
    }
  }
  const capsuleRef = managementInvocation?.intent.memoryCapsuleRef;
  if (includeRuntimeMemory && capsuleRef && !serverCapsuleRuntimeContextResolver) {
    throw new Error('SERVER_CAPSULE_RUNTIME_CONTEXT_UNAVAILABLE');
  }
  const capsuleContext = includeRuntimeMemory && capsuleRef
    ? await serverCapsuleRuntimeContextResolver!.resolve({
        teamId: managementInvocation!.intent.teamId,
        managementRunId: managementInvocation!.managementRunId,
        taskId: managementInvocation!.intent.taskContext?.taskId,
        targetAgentId: managementInvocation!.intent.targetAgentId,
        memoryCapsuleRef: capsuleRef,
        now,
      })
    : [];
  // #718: 追加 Team opted-in 的 Agent Memory 公开投影（opt-in 即独立授权，不经 Capsule；
  // server 端 fail-closed 实时查 active+opt-in+revision fence，AC#7）。
  const projectionContext = includeRuntimeMemory
    ? await loadAgentMemoryProjectionContext(repositories, { teamId: dispatch.teamId, agentId: agent.id, now })
    : [];
  const memoryContext = [...capsuleContext, ...projectionContext];
  const artifactSourceRoots = parseAgentArtifactSourceRoots(executionConfig?.env);
  const workspaceSnapshot = includeRuntimeMemory
    ? await buildDispatchWorkspaceSnapshot(repositories, {
        dispatch,
        agent,
        now,
        originMessage,
        managementInvocation,
        projectReferenceSets,
      })
    : undefined;

  return {
    id: dispatch.id,
    teamId: dispatch.teamId,
    channelId: dispatch.channelId,
    messageId: dispatch.messageId,
    ...(originMessage?.threadId ? { threadId: originMessage.threadId } : {}),
    agentId: dispatch.agentId,
    deviceId: agent.deviceId,
    requestId: dispatch.requestId,
    ...(managementAttempt ? { managementInvocationId: managementAttempt.invocationId } : {}),
    ...(managementInvocation ? { managementContext: {
      invocationId: managementInvocation.id,
      ...(managementInvocation.intent.taskContext
        ? { taskContext: managementInvocation.intent.taskContext }
        : {}),
      contextRefs: managementHandoff?.intent.contextRefs ?? [],
      dependencyResults: managementInvocation.intent.dependencyResults,
      acceptanceCriteria: managementInvocation.intent.acceptanceCriteria,
    } } : {}),
    ...(memoryContext.length > 0 ? { memoryContext } : {}),
    ...(projectReferenceSets.length > 0
      ? { projectReferenceSets: projectReferenceSets.map(toProjectReferenceSetDto) }
      : {}),
    ...(workspaceSnapshot ? { workspaceSnapshot } : {}),
    ...(managementInvocation?.intent.schemaVersion === 2
      ? { projectDocumentInputSet: managementInvocation.intent.projectDocumentInputSet }
      : {}),
    prompt: requestPrompt,
    history: dispatchHistory.map(toDispatchHistoryMessageDto),
    ...(attachments.length > 0
      ? {
          attachments: Array.from(
            new Map(attachments.map((artifact) => [artifact.id, artifact])).values(),
          ).map(toDispatchAttachmentDto),
        }
      : {}),
    ...(executionConfig
      ? {
          customAgent: {
            id: agent.id,
            name: agent.name,
            adapterKind: executionConfig.adapterKind,
            command: executionConfig.command,
            args: executionConfig.args,
            cwd: executionConfig.cwd,
            ...(artifactSourceRoots.length > 0
              ? { artifactSourceRoots }
              : {}),
            ...(agent.source === 'custom'
              ? { envRef: { agentId: agent.id, teamId: agent.primaryTeamId } }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * Dispatch execution seam for #1043.  Message references already contain
 * concrete artifact version identities; persist one deterministic snapshot per
 * dispatch so retries/reconnects do not re-resolve mutable current/final
 * pointers.  This intentionally uses only the referenced versions and never
 * mirrors the channel library.
 */
async function buildDispatchWorkspaceSnapshot(
  repositories: ServerNextRepositories,
  input: {
    dispatch: DispatchRecord;
    agent: AgentRecord;
    now: UnixMs;
    originMessage: MessageRecord | null;
    managementInvocation: Awaited<ReturnType<ServerNextRepositories['management']['invocations']['getById']>>;
    projectReferenceSets: readonly ProjectReferenceSetRecord[];
  },
): Promise<DeviceWorkspaceSnapshotDto | undefined> {
  const references = input.projectReferenceSets.flatMap((set) => set.selections.flatMap((selection) => selection.items))
    .filter((item) => item.kind === 'artifact_version'
      && typeof item.collectionId === 'string'
      && typeof item.versionId === 'string'
      && typeof item.artifactId === 'string')
    .map((item) => ({
      collectionId: item.collectionId!,
      versionId: item.versionId!,
      artifactId: item.artifactId!,
    }));
  if (references.length === 0) return undefined;
  const deviceId = input.agent.deviceId;
  if (!deviceId) throw new Error('DEVICE_WORKSPACE_SNAPSHOT_UNAVAILABLE');

  const snapshotId = `dispatch:${input.dispatch.id}:workspace-snapshot`;
  const existing = await repositories.deviceWorkspaceSnapshots.getById({
    teamId: input.dispatch.teamId,
    channelId: input.dispatch.channelId,
    snapshotId,
  });
  if (existing) return existing;

  const versions = await repositories.channelProjects.listArtifactVersions({
    teamId: input.dispatch.teamId,
    channelId: input.dispatch.channelId,
  });
  const uniqueReferences = Array.from(new Map(references.map((item) => [item.versionId, item])).values());
  const items: DeviceWorkspaceSnapshotInputSetItemDto[] = [];
  const paths = new Set<string>();
  for (const reference of uniqueReferences) {
    const version = versions.find((candidate) => candidate.id === reference.versionId
      && candidate.collectionId === reference.collectionId
      && candidate.artifactId === reference.artifactId);
    const artifact = version
      ? await repositories.artifacts.getForTeam({ teamId: input.dispatch.teamId, artifactId: version.artifactId })
      : null;
    if (!version || !artifact || artifact.channelId !== input.dispatch.channelId
      || !(await isPublicChannelFileArtifact(repositories, artifact))
      || !artifact.sha256 || !/^[a-f0-9]{64}$/i.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      throw new Error('DEVICE_WORKSPACE_SNAPSHOT_UNAVAILABLE');
    }
    const path = normalizeWorkspacePath(artifact.filename);
    if (!path || paths.has(path)) throw new Error('DEVICE_WORKSPACE_SNAPSHOT_AMBIGUOUS');
    paths.add(path);
    items.push({
      collectionId: version.collectionId,
      artifactVersionId: version.id,
      artifactId: version.artifactId,
      path,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256.toLowerCase(),
    });
  }

  // V1 and V2 invocations both carry the frozen task context.  It must be
  // authoritative for provenance; schema V2 is the InputSet gate, not the
  // boundary for task identity.
  const taskContext = input.managementInvocation?.intent.taskContext;
  const taskId: string = taskContext?.taskId
    ?? (typeof input.originMessage?.meta?.taskId === 'string' ? input.originMessage.meta.taskId : undefined)
    ?? input.dispatch.id;
  const taskAttempt = taskContext?.taskAttempt ?? 1;
  // A management invocation may be retried.  The dispatch id is allocated per
  // attempt and is already a safe path segment, so use it as the immutable run
  // identity instead of reusing the invocation id (or the colon-delimited
  // request id) across attempts.
  const workspaceRunId = input.dispatch.id;
  const workspace = await repositories.projectChannelWorkspaces.getForTeam({
    teamId: input.dispatch.teamId,
    channelId: input.dispatch.channelId,
  });
  const snapshot: DeviceWorkspaceSnapshotDto = {
    id: snapshotId,
    teamId: input.dispatch.teamId,
    channelId: input.dispatch.channelId,
    workspaceRevisionId: workspace?.currentRevisionId ?? `dispatch:${input.dispatch.id}:workspace-revision`,
    inputSet: {
      id: `${snapshotId}:input-set`,
      contractVersion: 1,
      selections: uniqueReferences.map((reference) => ({
        kind: 'version' as const,
        collectionId: reference.collectionId,
        versionId: reference.versionId,
      })),
      items,
    },
    provenance: {
      createdByDeviceId: deviceId,
      agentId: input.agent.id,
      taskId,
      taskAttempt,
      workspaceRunId,
      createdAt: input.now,
    },
    immutable: true,
  };
  await repositories.deviceWorkspaceSnapshots.create(snapshot);
  return snapshot;
}

function parseAgentArtifactSourceRoots(
  env: Record<string, string> | undefined,
): AgentArtifactSourceRootConfigDto[] {
  const raw = env?.AGENTBEAN_ARTIFACT_SOURCE_ROOTS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const roots: AgentArtifactSourceRootConfigDto[] = [];
    const ids = new Set<string>();
    for (const value of parsed) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const label = typeof item.label === 'string' ? item.label.trim() : '';
      const envVarName = typeof item.envVarName === 'string' ? item.envVarName.trim() : '';
      const defaultRole = item.defaultRole;
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)
        || ids.has(id)
        || !label
        || label.length > 80
        || label === '.'
        || label === '..'
        || /[/\\\u0000-\u001f]/.test(label)
        || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(envVarName)
        || (defaultRole !== 'intermediate' && defaultRole !== 'run_output' && defaultRole !== 'deliverable')) {
        continue;
      }
      ids.add(id);
      roots.push({
        id,
        label,
        envVarName,
        defaultRole,
        recursive: item.recursive !== false,
      });
    }
    return roots.slice(0, 16);
  } catch {
    return [];
  }
}

function isValidArtifactSourceRoot(sourceRoot: ArtifactSourceRootDto): boolean {
  // InputSet uses a namespaced configured-output root (project-document-input-set:<id>).
  // Colon remains safe here: path separators and control characters stay forbidden.
  return /^[A-Za-z0-9_:-]{1,128}$/.test(sourceRoot.id)
    && sourceRoot.label.length > 0
    && sourceRoot.label.length <= 120
    && sourceRoot.label !== '.'
    && sourceRoot.label !== '..'
    && !/[/\\\u0000-\u001f]/.test(sourceRoot.label)
    && (sourceRoot.kind === 'run_output'
      || sourceRoot.kind === 'agent_workspace'
      || sourceRoot.kind === 'configured_output'
      || sourceRoot.kind === 'adapter_generated'
      || sourceRoot.kind === 'legacy_run');
}

async function collectCoalescedDispatchPromptMessages(
  repositories: ServerNextRepositories,
  input: {
    originMessage: MessageRecord;
    agent: AgentRecord;
  },
): Promise<MessageRecord[]> {
  const channelMessages = await repositories.messages.listByChannel(
    input.originMessage.channelId,
    DISPATCH_PROMPT_COALESCING_CHANNEL_WINDOW,
  );
  const originIndex = channelMessages.findIndex((message) => message.id === input.originMessage.id);
  if (originIndex === -1) {
    return [input.originMessage];
  }

  const messages = [input.originMessage];
  for (const candidate of channelMessages.slice(originIndex + 1)) {
    if (isTaskClaimAcknowledgementMessage(candidate) || candidate.senderKind === 'system') {
      continue;
    }
    if (!canCoalesceDispatchPromptMessage({
      originMessage: input.originMessage,
      candidate,
      agent: input.agent,
    })) {
      break;
    }
    messages.push(candidate);
  }
  return messages;
}

function canCoalesceDispatchPromptMessage(input: {
  originMessage: MessageRecord;
  candidate: MessageRecord;
  agent: AgentRecord;
}): boolean {
  if (isDeletedMessage(input.candidate)) {
    return false;
  }
  if (input.candidate.senderKind !== 'human') {
    return false;
  }
  if (input.candidate.senderId !== input.originMessage.senderId) {
    return false;
  }
  if (!isInDispatchPromptCoalescingScope(input.originMessage, input.candidate)) {
    return false;
  }

  const originTaskId = taskIdForMessage(input.originMessage);
  const candidateTaskId = taskIdForMessage(input.candidate);
  if (candidateTaskId && candidateTaskId !== originTaskId) {
    return false;
  }
  if (!originTaskId && candidateTaskId) {
    return false;
  }
  return messageMentionTargetsAgent(input.candidate, input.agent);
}

function isInDispatchPromptCoalescingScope(originMessage: MessageRecord, candidate: MessageRecord): boolean {
  if (originMessage.threadId && originMessage.threadId !== originMessage.id) {
    return candidate.threadId === originMessage.threadId;
  }
  return candidate.threadId === candidate.id || candidate.threadId === originMessage.threadId;
}

function taskIdForMessage(message: MessageRecord): string | undefined {
  return typeof message.meta?.taskId === 'string' ? message.meta.taskId : undefined;
}

function messageMentionTargetsAgent(message: MessageRecord, agent: AgentRecord): boolean {
  const leadingOffset = message.body.length - message.body.trimStart().length;
  const hasLeadingMention = message.body.startsWith('@', leadingOffset);
  if (!hasLeadingMention) {
    return true;
  }

  // 仅首个 @ 决定 channel dispatch/coalescing；正文后续提及不能把消息并入另一 Agent。
  const mentions = message.meta?.mentions;
  const leadingMention = Array.isArray(mentions)
    ? mentions.find((mention) => mention?.start === leadingOffset)
    : undefined;
  if (leadingMention) {
    return leadingMention.kind === 'agent' && leadingMention.id === agent.id;
  }

  // fallback：从 body 文本 @name 匹配（旧消息/无 mentions）
  const mentionText = message.body.trimStart().match(/^@(.+)/)?.[1];
  if (!mentionText) return true;
  const mention = normalizeMentionName(mentionText);
  const agentName = normalizeMentionName(agent.name);
  return mention === agentName || mention.startsWith(`${agentName}-`);
}

async function migrateAgentMentionHistory(
  repositories: ServerNextRepositories,
  agent: AgentRecord,
): Promise<void> {
  const oldName = normalizeMentionName(agent.name);
  for (const teamId of agent.visibleTeamIds) {
    const [teamChannels, visibleAgents] = await Promise.all([
      repositories.channels.listByTeam(teamId),
      repositories.agents.listVisibleInTeam(teamId),
    ]);
    for (const channel of teamChannels) {
      // 只迁移目标 Agent 当前仍是成员的频道。已移出频道的历史文本无法可靠判定原指向，宁可保留旧文本。
      if (!channel.agentMemberIds.includes(agent.id)) continue;

      const hasSameNamedAgent = visibleAgents.some((candidate) =>
        candidate.id !== agent.id
        && channel.agentMemberIds.includes(candidate.id)
        && normalizeMentionName(candidate.name) === oldName
      );
      const humanMembers = await repositories.teams.listMembersByIds(teamId, channel.humanMemberIds);
      const hasSameNamedHuman = humanMembers.some((member) =>
        normalizeMentionName(member.username) === oldName
        || (member.displayName ? normalizeMentionName(member.displayName) === oldName : false)
      );
      // 旧消息没有 id；同名时无法证明 @name 指向谁，禁止猜测并写错稳定身份。
      if (hasSameNamedAgent || hasSameNamedHuman) continue;

      const messages = await repositories.messages.listByChannel(channel.id, Number.MAX_SAFE_INTEGER);
      const migrations = planMentionMigration(messages, agent.name, agent.id);
      for (const migration of migrations) {
        await repositories.messages.updateMeta({ messageId: migration.messageId, meta: migration.meta });
      }
    }
  }
}

function sanitizeMessageMentions(input: {
  body: string;
  mentions: MessageMetaDto['mentions'];
  channel: Pick<ChannelRecord, 'humanMemberIds' | 'agentMemberIds'>;
  visibleAgents: AgentDto[];
}): NonNullable<MessageMetaDto['mentions']> {
  if (!Array.isArray(input.mentions)) return [];

  const humanMemberIds = new Set(input.channel.humanMemberIds);
  const agentNames = new Map(
    input.visibleAgents
      .filter((agent) => input.channel.agentMemberIds.includes(agent.id))
      .map((agent) => [agent.id, normalizeMentionName(agent.name)]),
  );
  const seen = new Set<string>();
  return input.mentions.filter((mention) => {
    if (
      !mention
      || typeof mention.id !== 'string'
      || (mention.kind !== 'human' && mention.kind !== 'agent')
      || typeof mention.name !== 'string'
      || !Number.isInteger(mention.start)
      || !Number.isInteger(mention.end)
      || mention.start < 0
      || mention.end <= mention.start
      || mention.end > input.body.length
      || input.body.slice(mention.start, mention.end) !== `@${mention.name}`
    ) {
      return false;
    }
    if (mention.kind === 'human' && !humanMemberIds.has(mention.id)) return false;
    if (mention.kind === 'agent' && agentNames.get(mention.id) !== normalizeMentionName(mention.name)) return false;
    const key = `${mention.start}:${mention.end}:${mention.kind}:${mention.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderCoalescedDispatchPrompt(messages: MessageRecord[]): string {
  return messages.map((message) => message.body).join('\n\n');
}

function routeMessageForChannel(input: {
  channel: ChannelRecord;
  visibleAgents: AgentDto[];
  teamId: string;
  body: string;
  mentions?: NonNullable<MessageMetaDto['mentions']>;
  contextOwner?: RoutingContextOwner;
  connectedAgentDeviceIds?: string[];
  dispatchClaimDeviceIds?: string[];
}): RouteResult {
  const connectedAgentDeviceIds = input.connectedAgentDeviceIds
    ? new Set(input.connectedAgentDeviceIds)
    : undefined;
  const isSocketReachable = (agent: AgentDto): boolean =>
    !connectedAgentDeviceIds || !agent.deviceId || connectedAgentDeviceIds.has(agent.deviceId);
  const dispatchClaimDeviceIds = new Set(input.dispatchClaimDeviceIds ?? []);
  const canQueueForBusyAgent = (agent: AgentDto): boolean =>
    agent.status === 'busy' && Boolean(agent.deviceId && dispatchClaimDeviceIds.has(agent.deviceId));
  if (input.channel.kind === 'direct') {
    const targetAgentId = input.channel.dmTargetAgentId ?? input.channel.agentMemberIds[0];
    const targetAgent = input.visibleAgents.find((agent) =>
      agent.id === targetAgentId &&
      agent.visibleTeamIds.includes(input.teamId) &&
      (
        agent.status === 'online' ||
        canQueueForBusyAgent(agent)
      ) &&
      isSocketReachable(agent)
    );
    return targetAgent
      ? { kind: 'dispatch', agentId: targetAgent.id, reason: 'direct' }
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  // Non-DM channels only dispatch to explicit channel agent members. Team-visible
  // outsiders (e.g. BettaFish not in "AI短剧") must never win unmentioned fallback.
  const channelAgents = input.visibleAgents.filter((agent) =>
    input.channel.agentMemberIds.includes(agent.id)
  );
  const bodyStart = input.body.length - input.body.trimStart().length;
  const structuredLeadingMention = input.mentions?.find((mention) => mention.start === bodyStart);
  if (structuredLeadingMention?.kind === 'human') {
    return { kind: 'no-dispatch', reason: 'human-mention' };
  }
  if (structuredLeadingMention?.kind === 'agent') {
    const targetAgent = channelAgents.find((agent) => agent.id === structuredLeadingMention.id);
    const isEligible = targetAgent
      && targetAgent.visibleTeamIds.includes(input.teamId)
      && (targetAgent.status === 'online' || canQueueForBusyAgent(targetAgent));
    if (!targetAgent || !isEligible) {
      return { kind: 'no-dispatch', reason: 'unknown-mention' };
    }
    return isSocketReachable(targetAgent)
      ? { kind: 'dispatch', agentId: targetAgent.id, reason: 'mention' }
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  const hasLeadingMention = /^@(.+)/.test(input.body.trimStart());
  const route = routeMessage({
    body: input.body,
    agents: hasLeadingMention
      ? channelAgents.map((agent) => canQueueForBusyAgent(agent)
          ? { ...agent, status: 'online' as const, channelIds: [input.channel.id] }
          : { ...agent, channelIds: [input.channel.id] })
      : channelAgents.map((agent) => ({ ...agent, channelIds: [input.channel.id] })),
    humanMembers: [],
    teamId: input.teamId,
    channelId: input.channel.id,
  });
  if ((route.kind === 'dispatch' && route.reason === 'mention') || (route.kind === 'no-dispatch' && route.reason !== 'no-online-agent')) {
    if (route.kind !== 'dispatch') {
      return route;
    }
    const agent = channelAgents.find((candidate) => candidate.id === route.agentId);
    return agent && isSocketReachable(agent)
      ? route
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  const contextOwner = input.contextOwner;
  if (contextOwner?.kind === 'human') {
    return { kind: 'no-dispatch', reason: 'human-assignee' };
  }
  if (contextOwner?.kind === 'agent') {
    // Thread / Tracked-task follow-up may continue with the existing owner.
    const contextAgent = channelAgents.find((agent) => agent.id === contextOwner.agentId);
    return contextAgent && isDispatchEligibleAgent(contextAgent, input) && isSocketReachable(contextAgent)
      ? { kind: 'dispatch', agentId: contextAgent.id, reason: 'fallback' }
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  // ADR 0061: unmentioned root messages never get an implicit channel owner
  // (no "first online member" fallback). Coordinated intake uses PI; uncoordinated
  // intake requires explicit @Agent or an existing task/thread owner above.
  if (route.kind === 'dispatch' && route.reason === 'fallback') {
    return { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  return route;
}

type RoutingContextOwner =
  | { kind: 'agent'; agentId: string }
  | { kind: 'human' };

async function resolveRoutingContextAgentId(
  repositories: ServerNextRepositories,
  input: { teamId: string; channel: ChannelRecord; threadId: string },
): Promise<RoutingContextOwner | undefined> {
  const root = await repositories.messages.getById(input.threadId);
  if (!root || root.teamId !== input.teamId || root.channelId !== input.channel.id) {
    return undefined;
  }

  const rootTaskId = typeof root.meta?.taskId === 'string' ? root.meta.taskId : undefined;
  if (rootTaskId) {
    const run = await repositories.management.runs.getByRootTaskId(rootTaskId);
    if (run?.schemaVersion === 2 && run.status === 'running' && run.activeAgentId) {
      return { kind: 'agent', agentId: run.activeAgentId };
    }
  }

  const rootTaskAssignee = await taskAssigneeOwner(repositories, input.teamId, root);
  if (rootTaskAssignee) {
    return rootTaskAssignee;
  }

  const threadMessages = await repositories.messages.listByThread({
    channelId: input.channel.id,
    threadId: input.threadId,
    limit: 200,
  });
  for (const message of [...threadMessages].reverse()) {
    const taskAssignee = await taskAssigneeOwner(repositories, input.teamId, message);
    if (taskAssignee) {
      return taskAssignee;
    }
    if (message.senderKind === 'agent' && message.senderId) {
      return { kind: 'agent', agentId: message.senderId };
    }
  }

  return undefined;
}

async function taskAssigneeOwner(
  repositories: ServerNextRepositories,
  teamId: string,
  message: MessageRecord,
): Promise<RoutingContextOwner | undefined> {
  const taskId = typeof message.meta?.taskId === 'string' ? message.meta.taskId : undefined;
  if (!taskId) {
    return undefined;
  }
  const task = await repositories.tasks.getById(taskId);
  if (!task || task.teamId !== teamId || !task.assigneeId) {
    return undefined;
  }
  const agent = await repositories.agents.getById(task.assigneeId);
  if (agent) {
    return agent.visibleTeamIds.includes(teamId) ? { kind: 'agent', agentId: agent.id } : undefined;
  }
  return await repositories.teams.isMember(teamId, task.assigneeId) ? { kind: 'human' } : undefined;
}

function isDispatchEligibleAgent(
  agent: AgentDto,
  input: { teamId: string; channel: ChannelRecord },
): boolean {
  if (agent.status !== 'online') {
    return false;
  }
  if (!agent.visibleTeamIds.includes(input.teamId)) {
    return false;
  }
  // DM targets are already scoped; group channels require explicit membership.
  if (input.channel.kind !== 'direct' && !input.channel.agentMemberIds.includes(agent.id)) {
    return false;
  }
  return true;
}

function shouldAutoCreateTaskThread(input: {
  body: string;
  route: RouteResult;
  threadId?: string;
}): boolean {
  // DM 与频道一致：命中任务型关键词且已路由到 Agent 时自动建 Task 并沉淀讨论串。
  // 已在既有讨论串内（threadId 存在）或未路由到 Agent 时不自动建 Task。
  if (input.threadId || input.route.kind !== 'dispatch') {
    return false;
  }
  const body = input.body.trim();
  if (!body) {
    return false;
  }
  const plain = body.replace(/^@\S+\s*/, '').trim().toLowerCase();
  if (/^(hello|hi|hey|你好|在吗|你是谁|你能干嘛|你有哪些\s*skills?\??|有哪些\s*skills?\??|什么样的消息|哪些消息)/i.test(plain)) {
    return false;
  }
  return /(?:总结|整理|改写|撰写|写(?:一|个|篇|份)?|生成|制作|调用|画|分析一下|调研|搜索|查找|实现|修复|测试|review|code\s*review|top\s*\d+|top\d+|新闻|报告|文章|封面|配图|图片|代码|上线|部署)/i.test(plain);
}

/**
 * #1064 AC3/AC11：task-linked 复验失败的结构化失败（消息未创建，客户端保留草稿与引用）。
 * code 与 blockedVersionIds 供 composer 精确提示；web 端失败不清空输入。
 */
function taskLinkedRequestFailure(
  evaluation: Extract<TaskLinkedRequestEvaluation, { kind: 'rejected' }>,
): ReturnType<typeof makeFailure> {
  const messageByCode: Record<string, string> = {
    CHANNEL_ARCHIVED: '频道已归档，无法向 Agent 交办任务',
    TASK_CHANNEL_MISMATCH: '任务不属于当前频道，无法交办',
    TASK_AUTHORITY_DENIED: '你不是该任务的负责人或验收 authority，无法交办',
    TASK_REVISION_STALE: '任务已更新，请刷新后重试',
    TASK_ATTEMPT_STALE: '任务执行轮次已变化，请刷新后重试',
    TASK_NOT_OPEN: '任务已结束，无法交办',
    AGENT_NOT_ELIGIBLE: '目标 Agent 当前不满足执行条件（不可见/离线/能力不足），不会静默改派',
    ARTIFACT_VISIBILITY_DENIED: '引用文件对目标 Agent 不可见',
    INPUT_BINDING_UNRESOLVED: '任务输入绑定尚未解析完成',
    REVIEW_BASIS_BLOCKED: '引用版本未通过审核，不能作为默认输入（可显式「基于此修改」）',
  };
  return makeFailure('CONFLICT', messageByCode[evaluation.code] ?? 'Task-linked 请求被拒绝', {
    reason: 'task_link_rejected',
    taskLinkedCode: evaluation.code,
    ...(evaluation.blockedVersionIds ? { blockedVersionIds: evaluation.blockedVersionIds } : {}),
  });
}

function shouldNestDispatchReplyInThread(originMessage: MessageRecord | null | undefined): boolean {
  if (!originMessage?.threadId) {
    return false;
  }
  if (originMessage.threadId !== originMessage.id) {
    return true;
  }
  return typeof originMessage.meta?.taskId === 'string';
}

const TASK_CLAIM_ACKNOWLEDGEMENT_BODY = '我来处理，会先看请求和附件，再把结果发在线程里。';

async function appendTaskClaimAcknowledgementMessage(
  repositories: ServerNextRepositories,
  input: {
    id: string;
    message: MessageDto;
    task: TaskDto;
    dispatch: DispatchDto;
    createdAt: number;
  },
): Promise<MessageDto> {
  return await repositories.messages.append({
    id: input.id,
    teamId: input.message.teamId,
    channelId: input.message.channelId,
    threadId: input.message.threadId ?? input.message.id,
    senderKind: 'agent',
    senderId: input.dispatch.agentId,
    body: TASK_CLAIM_ACKNOWLEDGEMENT_BODY,
    createdAt: input.createdAt,
    meta: {
      kind: 'task-claim-confirmed',
      taskId: input.task.id,
      dispatchId: input.dispatch.id,
      parentMessageId: input.message.id,
      replyScope: 'thread',
    },
  });
}

function isTaskClaimAcknowledgementMessage(message: MessageRecord): boolean {
  return message.meta?.kind === 'task-claim-confirmed';
}

function toRouteReason(route: RouteResult): RouteReason | undefined {
  if (route.kind !== 'dispatch') {
    return undefined;
  }
  if (route.reason === 'mention') {
    return 'MENTION';
  }
  if (route.reason === 'direct') {
    return 'DIRECT';
  }
  return 'CHANNEL_DEFAULT';
}

function normalizeLimit(limit: number | undefined): number {
  return Math.min(Math.max(Number.isInteger(limit) ? limit as number : 50, 1), 200);
}

const WORKSPACE_RUN_LOG_EXCERPT_MAX_CHARS = 16000;
const DISPATCH_INLINE_ARTIFACT_CONTENT_MAX_BYTES = 2 * 1024 * 1024 + 1024;
const SENSITIVE_LOG_ASSIGNMENT_RE = /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)[A-Z0-9_]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s"'`]+)/gi;

function normalizeWorkspaceRunLogExcerpt(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const redacted = value.replace(SENSITIVE_LOG_ASSIGNMENT_RE, '$1=[redacted]');
  if (redacted.length <= WORKSPACE_RUN_LOG_EXCERPT_MAX_CHARS) {
    return redacted;
  }
  return redacted.slice(redacted.length - WORKSPACE_RUN_LOG_EXCERPT_MAX_CHARS);
}

function clampWorkspaceRunPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 30;
  }
  const n = Math.floor(value);
  if (n < 1) return 1;
  if (n > 100) return 100;
  return n;
}

function encodeWorkspaceRunCursor(run: { updatedAt: number; id: string }): string {
  return Buffer.from(`${run.updatedAt}:${run.id}`, 'utf8').toString('base64url');
}

function decodeWorkspaceRunCursor(cursor: string): { updatedAt: number; id: string } | 'invalid' {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return 'invalid';
  }
  const separator = decoded.lastIndexOf(':');
  if (separator <= 0) return 'invalid';
  const updatedAt = Number(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (!Number.isFinite(updatedAt) || !id) return 'invalid';
  return { updatedAt, id };
}

async function resolveDispatchArtifactContent(
  artifactContentStore: ArtifactContentStore | undefined,
  input: { teamId: string; artifact: ReceiveDispatchArtifactInput },
): Promise<{ ok: true; content?: ArtifactContentStoreWriteResult } | Ack<Record<string, never>>> {
  const contentBase64 = input.artifact.contentBase64;
  if (contentBase64 === undefined) {
    return { ok: true };
  }
  if (!artifactContentStore) {
    return makeFailure('VALIDATION_ERROR', 'Artifact content store is not configured');
  }
  if (!isBase64Like(contentBase64)) {
    return makeFailure('VALIDATION_ERROR', 'Invalid artifact content');
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length > DISPATCH_INLINE_ARTIFACT_CONTENT_MAX_BYTES) {
    return makeFailure('VALIDATION_ERROR', 'Artifact content is too large');
  }
  const stored = await artifactContentStore.writeContent({
    teamId: input.teamId,
    artifactId: input.artifact.id,
    filename: input.artifact.filename,
    content,
  });
  return { ok: true, content: stored };
}

function isBase64Like(value: string): boolean {
  if (value.length === 0) {
    return true;
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
}

async function allocateUniqueTeamPath(
  repositories: ServerNextRepositories,
  preferredName: string,
): Promise<string> {
  const base = slugify(preferredName);
  const teams = await repositories.teams.listAll();
  const used = new Set(teams.map((team) => team.path));
  if (!used.has(base)) {
    return base;
  }
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function generateJoinCode(): string {
  return randomBytes(16).toString('base64url');
}

async function resolveCurrentTeam(
  repositories: ServerNextRepositories,
  user: { id: string; currentTeamId?: string; primaryTeamId?: string },
): Promise<(TeamDto & { currentUserRole: 'owner' | 'admin' | 'member' }) | undefined> {
  const teams = await repositories.teams.listForUser(user.id);
  return resolveCurrentTeamFromList(teams, user);
}

function resolveCurrentTeamFromList(
  teams: Array<TeamDto & { currentUserRole: 'owner' | 'admin' | 'member' }>,
  user: { currentTeamId?: string; primaryTeamId?: string },
): (TeamDto & { currentUserRole: 'owner' | 'admin' | 'member' }) | undefined {
  return (
    teams.find((team) => team.id === user.currentTeamId) ??
    teams.find((team) => team.id === user.primaryTeamId) ??
    teams[0]
  );
}

async function getUsableJoinLink(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  code: string,
): Promise<{ ok: true; link: JoinLinkRecord } | Ack<Record<string, never>>> {
  const link = await repositories.joinLinks.getByCode(code);
  if (!link || link.revokedAt) {
    return makeFailure('INVITE_INVALID', 'Join link is invalid');
  }
  if (link.expiresAt !== undefined && link.expiresAt <= clock.now()) {
    return makeFailure('INVITE_EXPIRED', 'Join link has expired');
  }
  if (link.maxUses !== undefined && link.usesCount >= link.maxUses) {
    return makeFailure('INVITE_ALREADY_USED', 'Join link has already been used');
  }
  return { ok: true, link };
}

async function getUsableDeviceInvite(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  code: string,
): Promise<{ ok: true; invite: DeviceInviteRecord } | Ack<Record<string, never>>> {
  const invite = await repositories.deviceInvites.getByCode(code);
  if (!invite) {
    return makeFailure('INVITE_INVALID', 'Device invite is invalid');
  }
  if (invite.expiresAt !== undefined && invite.expiresAt <= clock.now()) {
    return makeFailure('INVITE_EXPIRED', 'Device invite has expired');
  }
  if (invite.completedAt !== undefined) {
    return makeFailure('INVITE_ALREADY_USED', 'Device invite has already been used');
  }
  return { ok: true, invite };
}

async function getUsableDeviceInviteForWait(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  input: { code: string; machineId?: string; profileId?: string },
): Promise<{ ok: true; invite: DeviceInviteRecord } | Ack<Record<string, never>>> {
  const invite = await repositories.deviceInvites.getByCode(input.code);
  if (!invite) return makeFailure('INVITE_INVALID', 'Device invite is invalid');
  if (invite.expiresAt !== undefined && invite.expiresAt <= clock.now()) {
    return makeFailure('INVITE_EXPIRED', 'Device invite has expired');
  }
  if (invite.completedAt === undefined) return { ok: true, invite };
  if (invite.machineId === input.machineId && invite.profileId === input.profileId
    && input.machineId !== undefined && input.profileId !== undefined) {
    return { ok: true, invite };
  }
  return makeFailure('INVITE_ALREADY_USED', 'Device invite has already been used');
}

async function findDeviceByCredentials(
  repositories: ServerNextRepositories,
  teamId: string,
  credentials: Pick<DeviceInviteCredentialsDto, 'machineId' | 'profileId'>,
): Promise<DeviceRecord | null> {
  if (!credentials.machineId || !credentials.profileId) {
    return null;
  }
  const teamDevices = await repositories.devices.listByTeam(teamId);
  return teamDevices.find(
    (candidate) => candidate.machineId === credentials.machineId && candidate.profileId === credentials.profileId,
  ) ?? null;
}

async function consumeJoinCodeForUser(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  code: string,
  user: UserRecord,
): Promise<{ ok: true; currentTeam: TeamDto & { currentUserRole: 'owner' | 'admin' | 'member' } } | Ack<Record<string, never>>> {
  const usable = await getUsableJoinLink(repositories, clock, code);
  if (!usable.ok) {
    return usable;
  }
  return joinTeamFromLink(repositories, clock, usable.link, user);
}

// Every team has a default public channel `#all`. Team membership and channel
// membership live in separate tables, so any entry point that brings a human or
// agent into a team must mirror that membership into `#all`. The repository
// performs append-style writes (SQLite: INSERT OR IGNORE) to avoid replacing
// another concurrent join's membership set.
async function ensureDefaultChannelMembership(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  input: { teamId: string; humanId?: string; agentId?: string },
): Promise<void> {
  await repositories.channels.addDefaultChannelMembers({
    teamId: input.teamId,
    humanMemberIds: input.humanId ? [input.humanId] : undefined,
    agentMemberIds: input.agentId ? [input.agentId] : undefined,
    timestamp: clock.now(),
  });
}

async function joinTeamFromLink(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  link: JoinLinkRecord,
  user: UserRecord,
): Promise<{ ok: true; currentTeam: TeamDto & { currentUserRole: 'owner' | 'admin' | 'member' } } | Ack<Record<string, never>>> {
  const team = await repositories.teams.getById(link.teamId);
  if (!team) {
    return makeFailure('INVITE_INVALID', 'Join link team no longer exists');
  }
  const existingRole = await repositories.teams.getMemberRole(link.teamId, user.id);
  if (!existingRole) {
    await repositories.teams.addMember({
      teamId: link.teamId,
      userId: user.id,
      username: user.username,
      role: 'member',
      joinedAt: clock.now(),
    });
    await ensureDefaultChannelMembership(repositories, clock, { teamId: link.teamId, humanId: user.id });
    const consumed = await repositories.joinLinks.incrementUses(link.code);
    if (!consumed) {
      return makeFailure('INVITE_INVALID', 'Join link is invalid');
    }
  }
  await repositories.users.setCurrentTeam(user.id, link.teamId);
  return {
    ok: true,
    currentTeam: toTeamDto(team, existingRole ?? 'member') as TeamDto & { currentUserRole: 'owner' | 'admin' | 'member' },
  };
}

function issueSessionToken(userId: string, secret: string): string {
  const payload = Buffer.from(JSON.stringify({ userId }), 'utf8').toString('base64url');
  return `abn.${payload}.${signSessionPayload(payload, secret)}`;
}

function verifySessionToken(token: string, secret: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'abn') {
    return null;
  }
  const payload = parts[1];
  const signature = parts[2];
  if (!payload || !signature) {
    return null;
  }
  const expected = signSessionPayload(payload, secret);
  if (!safeEqual(signature, expected)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId?: unknown };
    return typeof decoded.userId === 'string' && decoded.userId ? decoded.userId : null;
  } catch {
    return null;
  }
}

function issueDeviceToken(
  credentials: Pick<DeviceInviteCredentialsDto, 'teamId' | 'ownerId' | 'deviceId' | 'machineId' | 'profileId' | 'hostname'>,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64url');
  return `abn_device.${payload}.${signSessionPayload(payload, secret)}`;
}

function verifyDeviceToken(
  token: string,
  secret: string,
): Pick<DeviceInviteCredentialsDto, 'teamId' | 'ownerId' | 'deviceId' | 'machineId' | 'profileId' | 'hostname'> | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'abn_device') {
    return null;
  }
  const payload = parts[1];
  const signature = parts[2];
  if (!payload || !signature) {
    return null;
  }
  const expected = signSessionPayload(payload, secret);
  if (!safeEqual(signature, expected)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      teamId?: unknown;
      ownerId?: unknown;
      deviceId?: unknown;
      machineId?: unknown;
      profileId?: unknown;
      hostname?: unknown;
    };
    if (typeof decoded.teamId !== 'string' || !decoded.teamId) {
      return null;
    }
    if (typeof decoded.ownerId !== 'string' || !decoded.ownerId) {
      return null;
    }
    return {
      teamId: decoded.teamId,
      ownerId: decoded.ownerId,
      deviceId: typeof decoded.deviceId === 'string' ? decoded.deviceId : undefined,
      machineId: typeof decoded.machineId === 'string' ? decoded.machineId : undefined,
      profileId: typeof decoded.profileId === 'string' ? decoded.profileId : undefined,
      hostname: typeof decoded.hostname === 'string' ? decoded.hostname : undefined,
    };
  } catch {
    return null;
  }
}

function signSessionPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isPendingDispatchStatus(status: DispatchDto['status']): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}

type ArchiveWorkRepositories = Pick<
  ServerNextRepositories,
  | 'tasks'
  | 'dispatches'
  | 'management'
  // #1066：package 级待审核 delivery 与未收敛 projection 复验（AC1）。
  | 'outputPackages'
  | 'workspacePublishStagings'
  | 'channelProjects'
> & {
  coordination: TaskCoordinationRepositories;
};

async function collectArchiveWorks(
  deps: ArchiveWorkRepositories,
  teamId: string,
  channelId: string,
) {
  const tasks = await deps.tasks.list({ teamId, channelIds: [channelId], includeGlobal: false });
  const pendingReviews = tasks.filter((task) => task.status === 'in_review');
  const activeTasks = tasks.filter((task) =>
    task.status !== 'done' && task.status !== 'closed' && task.status !== 'in_review',
  );

  const activeLeases: TaskClaimLeaseRecord[] = [];
  const openOffers: TaskOfferRecord[] = [];
  const taskLeases: TaskClaimLeaseRecord[] = await deps.coordination.claimLeases.listActive();
  for (const task of activeTasks) {
    const lease = taskLeases.find((l) => l.taskId === task.id);
    if (lease) activeLeases.push(lease);

    const taskOffers: TaskOfferRecord[] = await deps.coordination.offers.listByTask(task.id);
    openOffers.push(...taskOffers.filter((offer) => offer.status === 'open'));
  }

  const channelDispatches = (await deps.dispatches.listByTeam(teamId))
    .filter((dispatch) => dispatch.channelId === channelId && isPendingDispatchStatus(dispatch.status));

  const invocations: { id: ID; title?: string; status: string }[] = [];
  for (const dispatch of channelDispatches) {
    const attempts = await deps.management.dispatchAttempts.list(dispatch.id);
    const attempt = attempts[0];
    if (attempt) {
      invocations.push({ id: attempt.invocationId, status: dispatch.status });
    }
  }

  // #1066 AC1：package 级待审核 delivery（#1061 reviews 表聚合 reviewState 非 approved 的包）
  // 与未收敛 projection（committed 有 provenance 但尚未形成 package 的交付）一并列入 gate。
  // 两者都只读列出——归档不删除交付历史，仅要求有权人知悉（AC3）。
  const packageRecords = await deps.outputPackages.listPackagesByChannel({
    teamId,
    channelId,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const packageSummaries = await summarizeOutputPackages(deps, { teamId, channelId }, packageRecords);
  // 仅「待审核」= reviewState 'pending' 列入 gate；approved/rejected/changes_requested 均为
  // 已收敛的终态审核结果，不应让归档清单永久残留（rejected 永不收敛）。
  const pendingReviewDeliveries = packageSummaries
    .filter((summary) => summary.reviewState === 'pending')
    .map((summary) => ({ id: summary.packageId, status: summary.reviewState }));

  const pendingDeliveries = await listPendingOutputDeliveries(deps, { teamId, channelId });

  return {
    tasks: activeTasks.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    invocations,
    claims: activeLeases.map((lease) => ({ id: lease.id, status: lease.status })),
    leases: activeLeases,
    offers: openOffers.map((offer) => ({ id: offer.id, status: offer.status })),
    pendingReviews: pendingReviews.map((task) => ({ id: task.id, title: task.title, status: task.status })),
    pendingReviewDeliveries: pendingReviewDeliveries.map((delivery) => ({
      id: delivery.id,
      status: delivery.status,
    })),
    pendingDeliveries: pendingDeliveries.map((delivery) => ({
      id: delivery.publishId,
      status: 'committed',
    })),
    dispatches: channelDispatches,
  };
}

function isCompletableDispatchStatus(status: DispatchDto['status']): boolean {
  return isPendingDispatchStatus(status) || status === 'timed_out';
}

function isSuccessfulDispatchResult(workspaceRun: ReceiveDispatchWorkspaceRunInput | undefined): boolean {
  return workspaceRun?.status === undefined || workspaceRun.status === 'succeeded';
}

function workspaceRunFailureError(workspaceRun: ReceiveDispatchWorkspaceRunInput | undefined): string {
  return workspaceRun?.status === 'cancelled' ? 'WORKSPACE_RUN_CANCELLED' : 'WORKSPACE_RUN_FAILED';
}

async function markAgentOnlineIfIdle(
  repositories: ServerNextRepositories,
  input: { agentId: ID; teamId: ID; lastSeenAt: UnixMs },
): Promise<void> {
  if (await hasPendingDispatchForAgent(repositories, input)) {
    return;
  }
  await repositories.agents.updateStatus({
    agentId: input.agentId,
    status: 'online',
    lastSeenAt: input.lastSeenAt,
  });
  await restoreAgentBusyIfDispatchArrived(repositories, input);
}

async function hasPendingDispatchForAgent(
  repositories: ServerNextRepositories,
  input: { agentId: ID; teamId: ID },
): Promise<boolean> {
  const teamDispatches = await repositories.dispatches.listByTeam(input.teamId);
  return teamDispatches.some((dispatch) =>
    dispatch.agentId === input.agentId && isPendingDispatchStatus(dispatch.status)
  );
}

async function restoreAgentBusyIfDispatchArrived(
  repositories: ServerNextRepositories,
  input: { agentId: ID; teamId: ID; lastSeenAt: UnixMs },
): Promise<void> {
  if (!(await hasPendingDispatchForAgent(repositories, input))) {
    return;
  }
  await repositories.agents.updateStatus({
    agentId: input.agentId,
    status: 'busy',
    lastSeenAt: input.lastSeenAt,
  });
}

async function markLinkedTaskInReview(
  repositories: ServerNextRepositories,
  message: MessageRecord | null,
  updatedAt: number,
): Promise<TaskDto | null> {
  const taskId = typeof message?.meta?.taskId === 'string' ? message.meta.taskId : null;
  if (!taskId) {
    return null;
  }
  const task = await repositories.tasks.getById(taskId);
  if (!task || task.status === 'in_review' || task.status === 'done' || task.status === 'closed') {
    return null;
  }
  return await repositories.tasks.update({
    taskId,
    changes: {
      status: 'in_review',
      updatedAt,
    },
  });
}

async function markLinkedTaskTodoIfInProgress(
  repositories: ServerNextRepositories,
  message: MessageRecord | null,
  updatedAt: number,
): Promise<TaskDto | null> {
  const taskId = typeof message?.meta?.taskId === 'string' ? message.meta.taskId : null;
  if (!taskId) {
    return null;
  }
  const task = await repositories.tasks.getById(taskId);
  if (!task || task.status !== 'in_progress') {
    return null;
  }
  return await repositories.tasks.update({
    taskId,
    changes: {
      status: 'todo',
      updatedAt,
    },
  });
}

async function recordManagedDispatchTerminal(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  ids: ServerNextIds,
  kernel: ReturnType<typeof createManagementKernel>,
  taskKernel: ReturnType<typeof createTaskCoordinationKernel>,
  collaborationService: ReturnType<typeof createCollaborationService>,
  input: {
    dispatchId: string;
    status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
    deliveryMessageId?: string;
    actorId?: string;
    errorCode?: string;
    artifactIds?: readonly string[];
    result?: AgentInvocationResultDto;
  },
): Promise<void> {
  const attempt = await repositories.management.dispatchAttempts.getByDispatchId(input.dispatchId);
  if (!attempt) {
    return;
  }
  const invocation = await repositories.management.invocations.getById(attempt.invocationId);
  if (!invocation) {
    throw new Error('MANAGEMENT_INVOCATION_NOT_FOUND');
  }
  const handoff = await repositories.management.handoffs.getByInvocationId(invocation.id);
  await collaborationService.recordTerminal({ dispatchId: input.dispatchId,
    status: input.status, artifactIds: input.artifactIds ?? [],
    ...(input.result ? { result: input.result } : {}) });
  if (handoff) {
    if (handoff.intent.returnMode === 'deliver_to_root' && input.status === 'succeeded'
      && input.deliveryMessageId) {
      await submitRootDeliveryFromHandoff(repositories, clock, ids, {
        managementRunId: invocation.managementRunId,
        invocationId: invocation.id,
        messageId: input.deliveryMessageId,
        workerId: input.actorId ?? 'system',
        idempotencyKey: `handoff-root-delivery:${handoff.id}:${input.dispatchId}`,
      });
    }
    return;
  }
  const taskContext = invocation.intent.taskContext;
  const coordination = taskContext
    ? await repositories.taskCoordination.coordinations.getByTaskId(taskContext.taskId)
    : null;
  if (coordination?.nodeKind === 'subtask'
    && coordination.managementRunId === invocation.managementRunId) {
    if (input.status !== 'succeeded') {
      await taskKernel.recordInvocationFailure({
        managementRunId: invocation.managementRunId,
        invocationId: invocation.id,
        reasonCode: input.errorCode ?? `INVOCATION_${input.status.toUpperCase()}`,
      });
    }
    return;
  }
  await kernel.recordInvocationTerminal({
    managementRunId: invocation.managementRunId,
    dispatchId: input.dispatchId,
    status: input.status,
    ...(input.deliveryMessageId ? { deliveryMessageId: input.deliveryMessageId } : {}),
    ...(input.actorId ? { actorId: input.actorId } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

async function submitRootDeliveryFromHandoff(
  repositories: ServerNextRepositories,
  clock: ServerNextClock,
  ids: ServerNextIds,
  input: {
    managementRunId: string;
    invocationId: string;
    messageId: string;
    workerId: string;
    idempotencyKey: string;
  },
) {
  await repositories.managementUnitOfWork.run(async (management) => {
    const run = await management.runs.getById(input.managementRunId);
    if (!run || run.schemaVersion !== 2 || !run.rootTaskId) return;
    if (run.status === 'in_review' || run.status === 'completed'
      || run.status === 'failed' || run.status === 'cancelled') return;
    // 含 subtask 的 run 不在此闭环：canonical submitRootDelivery 会做依赖完成、
    // 叶子验收与完整 contributingInvocationIds 校验，handoff 交付不能绕过它们
    // 把根任务提前推进到 in_review；无 subtask 时 handoff 交付即根交付。
    const coordinations = await repositories.taskCoordination.coordinations
      .listByManagementRun(run.id);
    if (coordinations.some((coordination) => coordination.nodeKind === 'subtask')) return;
    const rootTask = await repositories.tasks.getById(run.rootTaskId);
    if (!rootTask || rootTask.status !== 'in_progress') return;
    const now = clock.now();
    const updatedTask = await repositories.tasks.update({ taskId: rootTask.id,
      changes: { status: 'in_review', updatedAt: now } });
    if (!updatedTask) throw new Error('TASK_NOT_FOUND');
    await appendManagementEventInTransaction(management, {
      managementRunId: run.id,
      type: 'root-delivery-submitted',
      actorKind: 'system',
      actorId: input.workerId,
      idempotencyKey: input.idempotencyKey,
      payload: { messageId: input.messageId, contributingInvocationIds: [input.invocationId] },
    }, now, ids);
    await management.runs.update({ ...run, status: 'in_review', updatedAt: now });
  });
}

function collaborationProposalDiagnostic(error: unknown): string | null {
  if (!(error instanceof Error) || !/^HANDOFF_[A-Z0-9_]{1,72}$/.test(error.message)) return null;
  return error.message;
}

async function allHumanMembersBelongToTeam(
  repositories: ServerNextRepositories,
  teamId: string,
  userIds: string[],
): Promise<boolean> {
  for (const userId of uniqueIds(userIds)) {
    if (!(await repositories.teams.isMember(teamId, userId))) {
      return false;
    }
  }
  return true;
}

async function visibleTaskChannelIds(
  repositories: ServerNextRepositories,
  teamId: string,
  userId: string,
): Promise<string[]> {
  const [channels, dms] = await Promise.all([
    repositories.channels.listForUser(teamId, userId),
    visibleDirectChannelsForUser(repositories, teamId, userId),
  ]);
  return uniqueIds([
    ...channels.map((channel) => channel.id),
    ...dms.map(({ channel }) => channel.id),
  ]);
}

async function visibleDirectChannelsForUser(
  repositories: ServerNextRepositories,
  teamId: string,
  userId: string,
): Promise<Array<{ channel: ChannelRecord; agent: AgentRecord }>> {
  const channels = await repositories.channels.listDirectForUser(teamId, userId);
  const visible: Array<{ channel: ChannelRecord; agent: AgentRecord }> = [];
  for (const channel of channels) {
    const agentId = channel.dmTargetAgentId ?? channel.agentMemberIds[0];
    const agent = agentId ? await repositories.agents.getById(agentId) : null;
    if (agent && agent.visibleTeamIds.includes(teamId)) {
      visible.push({ channel, agent });
    }
  }
  return visible;
}

async function isAssignableToTask(
  repositories: ServerNextRepositories,
  teamId: string,
  assigneeId: string,
): Promise<boolean> {
  if (await repositories.teams.isMember(teamId, assigneeId)) {
    return true;
  }
  const agent = await repositories.agents.getById(assigneeId);
  return Boolean(agent && agent.deletedAt === undefined && agent.visibleTeamIds.includes(teamId));
}

function isTaskStatus(status: string): status is TaskStatus {
  return status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'cancelled' || status === 'closed';
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return '待处理';
    case 'in_progress':
      return '进行中';
    case 'in_review':
      return '待审核';
    case 'done':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'closed':
      return '已关闭';
  }
}

function normalizeOptionalText(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : undefined;
}

function normalizeOptionalId(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized ? normalized : undefined;
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!Array.isArray(tags)) {
    return [];
  }
  return uniqueIds(tags.map((tag) => typeof tag === 'string' ? tag.trim() : '').filter(Boolean)).slice(0, 20);
}

function normalizeUniqueTextItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueIds(value.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean));
}

function projectReferenceRequestFingerprint(
  input: Pick<
    SendMessageInput,
    'userId' | 'teamId' | 'channelId' | 'messageId' | 'threadId' | 'body'
    | 'asTask' | 'artifactIds' | 'meta' | 'selections'
  >,
): string {
  return createHash('sha256').update(JSON.stringify({
    userId: input.userId,
    teamId: input.teamId,
    channelId: input.channelId,
    messageId: input.messageId ?? null,
    threadId: input.threadId ?? null,
    body: input.body,
    asTask: input.asTask === true,
    artifactIds: input.artifactIds ?? [],
    meta: input.meta ?? null,
    selections: input.selections ?? [],
  })).digest('hex');
}

class ProjectReferenceCommitConflictError extends Error {
  constructor(readonly kind: 'idempotency_conflict' | 'reference_fact_conflict') {
    super(`Project reference set commit failed: ${kind}`);
  }
}

async function persistFrozenProjectReferences(
  repository: ProjectReferenceSetRepository,
  input: {
    ids: ServerNextIds;
    message: MessageRecord;
    createdBy: string;
    previews: readonly ResolveProjectReferencesResultDto['selections'][number][];
    idempotencyKey: string;
    requestFingerprint: string;
    createdAt: number;
  },
): Promise<ProjectReferenceSetDto> {
  const setId = input.ids.nextId();
  const selections: ProjectReferenceSelectionRecord[] = [];
  const items: ProjectReferenceItemRecord[] = [];
  for (const [selectionPosition, preview] of input.previews.entries()) {
    const selectionId = input.ids.nextId();
    const selectionItems: ProjectReferenceItemRecord[] = preview.items.map((item, position) => ({
      id: input.ids.nextId(),
      selectionId,
      kind: item.kind,
      position,
      ...(item.kind === 'document_revision'
        ? {
          documentId: item.documentId,
          revisionId: item.revisionId,
          revisionNumber: item.revisionNumber,
          filename: item.filename,
          ...(item.bundlePosition === undefined ? {} : { bundlePosition: item.bundlePosition }),
        }
        : {
          collectionId: item.collectionId,
          versionId: item.versionId,
          versionNumber: item.versionNumber,
          artifactId: item.artifactId,
          artifactFilename: item.filename,
          ...(item.collectionRevision === undefined ? {} : { collectionRevision: item.collectionRevision }),
        }),
      createdAt: input.createdAt,
    }));
    selections.push({
      id: selectionId,
      referenceSetId: setId,
      sourceKind: preview.sourceKind,
      position: selectionPosition,
      ...(preview.bundle
        ? {
          bundleId: preview.bundle.bundleId,
          bundleName: preview.bundle.name,
          bundleMemberCount: preview.bundle.memberCount,
        }
        : {}),
      ...(preview.package
        ? {
          packageId: preview.package.packageId,
          packageProjection: preview.package.policy,
          packageMemberCount: preview.package.memberCount,
        }
        : {}),
      createdAt: input.createdAt,
      items: selectionItems,
    });
    items.push(...selectionItems);
  }
  const set: ProjectReferenceSetRecord = {
    id: setId,
    contractVersion: PROJECT_REFERENCE_SET_CONTRACT_VERSION,
    teamId: input.message.teamId,
    channelId: input.message.channelId,
    messageId: input.message.id,
    createdBy: input.createdBy,
    createdAt: input.createdAt,
    selections,
  };
  const result = await repository.create({
    set,
    selections,
    items,
    mutation: {
      teamId: input.message.teamId,
      channelId: input.message.channelId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: input.requestFingerprint,
      referenceSetId: setId,
      createdAt: input.createdAt,
    },
  });
  if (result.kind !== 'created') {
    throw new ProjectReferenceCommitConflictError(
      result.kind === 'reference_fact_conflict' ? result.kind : 'idempotency_conflict',
    );
  }
  return toProjectReferenceSetDto(set);
}

function toProjectReferenceSetDto(record: ProjectReferenceSetRecord): ProjectReferenceSetDto {
  return {
    id: record.id,
    contractVersion: record.contractVersion,
    teamId: record.teamId,
    channelId: record.channelId,
    messageId: record.messageId,
    selections: record.selections.map((selection) => ({
      id: selection.id,
      position: selection.position,
      sourceKind: selection.sourceKind,
      ...(selection.bundleId && selection.bundleName && selection.bundleMemberCount !== undefined
        ? {
          bundle: {
            bundleId: selection.bundleId,
            name: selection.bundleName,
            memberCount: selection.bundleMemberCount,
          },
        }
        : {}),
      ...(selection.packageId && selection.packageProjection && selection.packageMemberCount !== undefined
        ? {
          package: {
            packageId: selection.packageId,
            policy: selection.packageProjection,
            memberCount: selection.packageMemberCount,
          },
        }
        : {}),
      items: selection.items.map((item): ProjectReferenceItemDto =>
        item.kind === 'document_revision'
          ? {
            kind: 'document_revision',
            documentId: item.documentId as string,
            revisionId: item.revisionId as string,
            revisionNumber: item.revisionNumber as number,
            filename: item.filename as string,
            ...(item.bundlePosition === undefined ? {} : { bundlePosition: item.bundlePosition }),
          }
          : {
            kind: 'artifact_version',
            collectionId: item.collectionId as string,
            versionId: item.versionId as string,
            versionNumber: item.versionNumber as number,
            artifactId: item.artifactId as string,
            filename: item.artifactFilename as string,
            ...(item.collectionRevision === undefined ? {} : { collectionRevision: item.collectionRevision }),
          }),
      createdAt: selection.createdAt,
    })),
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  };
}

async function resolveAndFreezeSelections(
  repositories: ServerNextRepositories,
  input: {
    userId: string;
    teamId: string;
    channelId: string;
    channel: ChannelRecord;
    selections: readonly ProjectReferenceSelectionRequestDto[];
  },
): Promise<Ack<ResolveProjectReferencesResultDto>> {
  // #1063 运行时 exact-key 校验(#1059 §9):畸形 selection payload(未知 arm/多余字段/
  // 错误形状)在此结构化拒绝,而不是穿透到 domain 抛 TypeError。message:send 与
  // resolve-references 都经本函数。
  let requests: readonly ProjectReferenceSelectionRequestDto[];
  try {
    requests = parseProjectReferenceSelectionRequestsV1(input.selections);
  } catch {
    return makeFailure(
      'VALIDATION_ERROR',
      'One or more project reference selections are malformed',
      { reason: 'invalid_request' },
    );
  }
  const previews = [];
  const rejections: NonNullable<ProjectReferenceFailureDetailsDto['rejections']>[number][] = [];
  for (const [selectionIndex, request] of requests.entries()) {
    const selection = await loadProjectReferenceSelectionCandidate(repositories, input, request);
    const verdict = evaluateSelectionEligibility(selection, {
      teamId: input.channel.teamId,
      channelId: input.channel.id,
      archived: input.channel.archivedAt != null,
      visible: input.channel.visibility !== 'private'
        || input.channel.humanMemberIds.includes(input.userId),
    }, {
      teamId: input.teamId,
      channelId: input.channelId,
    });
    if (!verdict.eligible) {
      rejections.push({
        selectionIndex,
        ...(verdict.refId ? { refId: verdict.refId } : {}),
        code: verdict.code,
      });
      continue;
    }
    previews.push(verdict.preview);
  }
  if (rejections.length > 0) {
    return makeFailure(
      'VALIDATION_ERROR',
      'One or more project reference selections were rejected',
      { reason: 'selections_rejected', rejections },
    );
  }
  return makeSuccess({
    selections: previews,
    archived: input.channel.archivedAt != null,
  });
}

async function loadProjectReferenceSelectionCandidate(
  repositories: ServerNextRepositories,
  input: { teamId: string; channelId: string },
  request: ProjectReferenceSelectionRequestDto,
): Promise<ProjectReferenceSelectionCandidate> {
  if (request.kind === 'document') {
    return {
      request,
      document: await loadProjectReferenceDocumentCandidate(repositories, {
        ...input,
        documentId: request.documentId,
      }),
    };
  }
  if (request.kind === 'artifact_version') {
    const versions = await repositories.channelProjects.listArtifactVersions(input);
    const version = versions.find((candidate) => candidate.id === request.versionId) ?? null;
    let artifactVersion: ProjectReferenceArtifactVersionCandidate | null = null;
    if (version) {
      const artifact = await repositories.artifacts.getForTeam({
        teamId: input.teamId,
        artifactId: version.artifactId,
      });
      artifactVersion = {
        collectionId: version.collectionId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        artifactId: version.artifactId,
        filename: artifact?.filename ?? version.artifactId,
        teamId: version.teamId,
        channelId: version.channelId,
        visible: Boolean(artifact)
          && artifact!.channelId === input.channelId
          && await isPublicChannelFileArtifact(repositories, artifact!),
      };
    }
    return { request, artifactVersion };
  }

  if (request.kind === 'bundle_all' || request.kind === 'bundle_subset') {
    const record = await repositories.projectDocumentBundles.getById({
      teamId: input.teamId,
      channelId: input.channelId,
      bundleId: request.bundleId,
    });
    let bundle: ProjectReferenceBundleCandidate | null = null;
    if (record) {
      const members = await repositories.projectDocumentBundles.listMembers({ bundleId: record.id });
      const resolvedMembers: ProjectReferenceDocumentCandidate[] = [];
      let visible = true;
      for (const member of members) {
        const candidate = await loadProjectReferenceDocumentCandidate(repositories, {
          ...input,
          documentId: member.documentId,
          bundlePosition: member.position + 1,
        });
        if (!candidate) {
          visible = false;
          continue;
        }
        if (!candidate.visible) visible = false;
        resolvedMembers.push(candidate);
      }
      bundle = {
        bundleId: record.id,
        teamId: record.teamId,
        channelId: record.channelId,
        name: record.name,
        visible,
        members: resolvedMembers,
      };
    }
    return { request, bundle };
  }

  // #1063 package 语境:装载冻结成员 + 同快照 collections/versions/reviews,
  // 构造 domain 候选(资格/投影解析全部在 domain 纯函数内完成)。
  const packageCandidate = await loadProjectReferencePackageCandidate(repositories, input, request);
  if (request.kind === 'package_members') {
    return { request, packageMembers: packageCandidate };
  }
  return { request, packageProjection: packageCandidate };
}

async function loadProjectReferencePackageCandidate(
  repositories: ServerNextRepositories,
  input: { teamId: string; channelId: string },
  request: Extract<ProjectReferenceSelectionRequestDto, { kind: 'package_projection' | 'package_members' }>,
): Promise<ProjectReferencePackageCandidate | null> {
  const record = await repositories.outputPackages.getPackageById({
    teamId: input.teamId,
    packageId: request.packageId,
  });
  if (!record || record.package.channelId !== input.channelId) return null;
  const members: OutputPackageProjectionMemberFact[] = record.members.map((member) => ({
    sequence: member.sequence,
    shortLabel: member.shortLabel,
    collectionId: member.collectionId,
    deliveredVersionId: member.artifactVersionId,
    requiredForFinal: member.requiredForFinal,
    filename: member.filename,
  }));
  const collectionIds = new Set(members.map((member) => member.collectionId));
  const collections = (await repositories.channelProjects.listArtifactCollections(input))
    .filter((collection) => collectionIds.has(collection.id))
    .map((collection): OutputPackageProjectionCollectionFact => ({
      id: collection.id,
      revision: collection.revision,
      currentVersionId: collection.currentVersionId,
      ...(collection.finalVersionId === undefined ? {} : { finalVersionId: collection.finalVersionId }),
    }));
  const versionIds = new Set(collections.map((collection) => collection.currentVersionId));
  for (const collection of collections) {
    if (collection.finalVersionId) versionIds.add(collection.finalVersionId);
  }
  for (const member of members) versionIds.add(member.deliveredVersionId);
  const versions = (await repositories.channelProjects.listArtifactVersions(input))
    .filter((version) => versionIds.has(version.id))
    .map(async (version): Promise<OutputPackageProjectionVersionFact> => {
      const artifact = await repositories.artifacts.getForTeam({
        teamId: input.teamId,
        artifactId: version.artifactId,
      });
      const visible = Boolean(artifact)
        && artifact!.channelId === input.channelId
        && await isPublicChannelFileArtifact(repositories, artifact!);
      return {
        id: version.id,
        collectionId: version.collectionId,
        versionNumber: version.versionNumber,
        artifactId: version.artifactId,
        filename: artifact?.filename ?? version.artifactId,
        visible,
      };
    });
  const reviewStateByVersionId = new Map<string, ProjectArtifactVersionReviewState>();
  for (const review of await repositories.channelProjects.listArtifactReviews(input)) {
    if (versionIds.has(review.versionId)) {
      reviewStateByVersionId.set(review.versionId, review.decision);
    }
  }
  return {
    packageId: record.package.packageId,
    teamId: record.package.teamId,
    channelId: record.package.channelId,
    memberCount: record.package.memberCount,
    members,
    collections,
    versions: await Promise.all(versions),
    reviewStateByVersionId,
  };
}

async function loadProjectReferenceDocumentCandidate(
  repositories: ServerNextRepositories,
  input: {
    teamId: string;
    channelId: string;
    documentId: string;
    bundlePosition?: number;
  },
): Promise<ProjectReferenceDocumentCandidate | null> {
  const document = await repositories.channelDocuments.getForTeam(input);
  if (!document) return null;
  const revision = await repositories.channelDocuments.getRevision({
    documentId: document.id,
    revisionId: document.currentRevisionId,
  });
  if (!revision) return null;
  return {
    documentId: document.id,
    teamId: document.teamId,
    channelId: document.channelId,
    revisionId: revision.id,
    revisionNumber: revision.revision,
    filename: document.filename,
    visible: revision.artifact.teamId === input.teamId
      && revision.artifact.channelId === input.channelId
      && await isPublicChannelFileArtifact(repositories, revision.artifact),
    ...(input.bundlePosition === undefined ? {} : { bundlePosition: input.bundlePosition }),
  };
}

/**
 * #830：把建包失败的语义原因塞进 FailureAck.details。
 *
 * 调用方（尤其是回填）需要区分「内部 Invocation」「陈旧 Invocation」「成员不可见」
 * 这些同属 FORBIDDEN/CONFLICT 的不同事实；靠解析人类可读 message 反推是脆的，
 * 原因码才是稳定契约。message 保持原样，不影响既有断言。
 */
function bundleFailure(
  error: ErrorCode,
  message: string,
  reason: ProjectDocumentBundleFailureReason,
  rejections?: readonly { documentId: string; code: ProjectDocumentBundleMemberRejectionCode }[],
): FailureAck {
  const details: ProjectDocumentBundleFailureDetailsDto = {
    reason,
    ...(rejections?.length ? { rejections: rejections.map(({ documentId, code }) => ({ documentId, code })) } : {}),
  };
  return makeFailure(error, message, details as unknown as Record<string, unknown>);
}

/**
 * #825：从 Workspace Run 解析 Bundle 来源。Invocation 经 dispatch attempt 反查；
 * 若该 Invocation 绑定的 Task revision/attempt 已被取代，说明来源已陈旧，拒绝建包。
 */
export async function resolveProjectDocumentBundleSource(
  repositories: ServerNextRepositories,
  run: WorkspaceRunRecord,
): Promise<Ack<{ source: ProjectDocumentBundleSourceDto }>> {
  const attempt = await repositories.management.dispatchAttempts.getByDispatchId(run.dispatchId);
  const invocation = attempt
    ? await repositories.management.invocations.getById(attempt.invocationId)
    : null;
  const taskContext = invocation?.intent.taskContext;
  if (taskContext) {
    const task = await repositories.tasks.getById(taskContext.taskId);
    if (!task || task.teamId !== run.teamId || task.channelId !== run.channelId) {
      return bundleFailure(
        'NOT_FOUND',
        'Invocation Task is unavailable in this Team and Channel',
        'invocation_task_unavailable',
      );
    }
    if (task.revision !== taskContext.taskRevision) {
      return bundleFailure(
        'CONFLICT',
        'Invocation is stale: its Task revision has been superseded',
        'invocation_stale',
      );
    }
  }
  const dispatch = await repositories.dispatches.getById(run.dispatchId);
  const originMessage = dispatch ? await repositories.messages.getById(dispatch.messageId) : null;
  const taskId = taskContext?.taskId ?? (originMessage ? messageTaskId(originMessage) : undefined);
  const messageId = run.sourceMessageId ?? run.messageId ?? originMessage?.id;
  const source: ProjectDocumentBundleSourceDto = {
    kind: 'workspace_run',
    workspaceRunId: run.id,
    agentId: run.agentId,
    ...(attempt ? { invocationId: attempt.invocationId } : {}),
    ...(taskId ? { taskId } : {}),
    ...(messageId ? { messageId } : {}),
    runCreatedAt: run.createdAt,
  };
  return makeSuccess({ source });
}

/**
 * 把一个 documentId 装配为成员候选。这里只负责取数与可见性复验，
 * 是否够格由 domain 的 evaluateBundleComposition 裁决 —— 判定规则不在此分叉。
 */
/**
 * #830 导出：回填要在 dry-run 下给出与 apply 完全一致的裁决，就必须用**同一段**
 * 可见性/来源判定，而不是另写一份 SQL 复刻。导出只读判定函数是让两条路径共享真相的
 * 最小代价；写入路径依旧只有 createProjectDocumentBundle 一个入口。
 */
export async function loadProjectDocumentBundleCandidate(
  repositories: ServerNextRepositories,
  input: { teamId: string; channelId: string; documentId: string },
): Promise<ProjectDocumentBundleMemberCandidate | null> {
  const document = await repositories.channelDocuments.getForTeam(input);
  if (!document) return null;
  const revision = await repositories.channelDocuments.getRevision({
    documentId: document.id,
    revisionId: document.currentRevisionId,
  });
  if (!revision) return null;
  const { artifact, derivationSource } = revision;
  // 可见性同时约束正文与来源产物：来源 Run 不公开时，正文虽是新上传件也不得进包。
  let visible = artifact.channelId === input.channelId
    && artifact.teamId === input.teamId
    && await isPublicChannelFileArtifact(repositories, artifact);
  if (visible && derivationSource) {
    const sourceArtifact = await repositories.artifacts.getForTeam({
      teamId: input.teamId,
      artifactId: derivationSource.artifactId,
    });
    visible = Boolean(sourceArtifact)
      && sourceArtifact!.channelId === input.channelId
      && await isPublicChannelFileArtifact(repositories, sourceArtifact!);
  }
  return {
    documentId: document.id,
    teamId: document.teamId,
    channelId: document.channelId,
    filename: document.filename,
    currentRevisionId: revision.id,
    currentRevisionNumber: revision.revision,
    artifact: { filename: artifact.filename, mimeType: artifact.mimeType },
    ...(derivationSource
      ? {
        derivation: {
          workspaceRunId: derivationSource.workspaceRunId,
          relativePath: derivationSource.relativePath,
          normalizedRelativePath: derivationSource.normalizedRelativePath,
          artifactId: derivationSource.artifactId,
          artifactRole: derivationSource.artifactRole,
        },
      }
      : {}),
    visible,
  };
}

function describeBundleRejections(
  rejections: readonly { documentId: string; code: ProjectDocumentBundleMemberRejectionCode }[],
): string {
  return rejections.map(({ documentId, code }) => `${documentId}=${code}`).join(', ');
}

function toProjectDocumentBundleDto(
  record: ProjectDocumentBundleRecord,
): ProjectDocumentBundleDto {
  return {
    id: record.id,
    teamId: record.teamId,
    channelId: record.channelId,
    name: record.name,
    source: record.source,
    memberCount: record.memberCount,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
  };
}

/**
 * 固定成员 + 当前 revision 投影。当前 revision 每次读取时从 ChannelDocument 现取，
 * Bundle 自身不缓存正文事实，因此文档被修订后包详情自动反映最新来源与时间，
 * 而 initialRevisionId 保持不动。
 */
async function toProjectDocumentBundleDetailDto(
  repositories: ServerNextRepositories,
  record: ProjectDocumentBundleRecord,
): Promise<ProjectDocumentBundleDetailDto> {
  const memberRecords = await repositories.projectDocumentBundles.listMembers({ bundleId: record.id });
  const members: ProjectDocumentBundleMemberViewDto[] = [];
  for (const member of memberRecords) {
    members.push({
      documentId: member.documentId,
      position: member.position,
      initialRevisionId: member.initialRevisionId,
      initialRevisionNumber: member.initialRevisionNumber,
      initialFilename: member.initialFilename,
      current: await projectDocumentBundleMemberCurrent(repositories, record, member),
    });
  }
  return { ...toProjectDocumentBundleDto(record), members };
}

async function projectDocumentBundleMemberCurrent(
  repositories: ServerNextRepositories,
  record: ProjectDocumentBundleRecord,
  member: ProjectDocumentBundleMemberRecord,
): Promise<ProjectDocumentBundleMemberViewDto['current']> {
  const document = await repositories.channelDocuments.getForTeam({
    teamId: record.teamId,
    channelId: record.channelId,
    documentId: member.documentId,
  });
  if (!document) return null;
  const revision = await repositories.channelDocuments.getRevision({
    documentId: document.id,
    revisionId: document.currentRevisionId,
  });
  if (!revision) return null;
  return {
    revisionId: revision.id,
    revisionNumber: revision.revision,
    filename: document.filename,
    source: revision.source ?? channelDocumentInitialRevisionSource(revision.artifact),
    createdBy: revision.createdBy,
    createdAt: revision.createdAt,
    changedSinceJoin: revision.id !== member.initialRevisionId,
  };
}

type ProjectStageEdgeMutationAck = Ack<{
  overview: ChannelProjectOverviewDto;
  replayed: boolean;
}>;

interface ProjectStageEdgeMutationContext<N> {
  ok: true;
  channel: ChannelRecord;
  profile: ChannelProjectProfileRecord;
  stages: ProjectStageRecord[];
  edges: ProjectStageEdgeRecord[];
  idempotencyKey: string;
  requestFingerprint: string;
  normalized: N;
}

/**
 * #822 只做去空白与结构规整，**不修正 kind**。
 * 未知 kind 必须原样传给 domain 由 evaluateProjectStageEdgeCreation fail closed 拒绝，
 * 否则静默强转会让非法规则伪装成合法产物输入。
 */
export function normalizeProjectStageRequiredInputs(
  value: unknown,
): ProjectStageRequiredInputRuleDto[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    const rule = entry as {
      key?: unknown;
      kind?: unknown;
      label?: unknown;
      source?: {
        kind?: unknown;
        collectionId?: unknown;
        versionPolicy?: unknown;
        bundleId?: unknown;
      };
    } | null;
    const source = rule?.source?.kind === 'artifact_collection'
      ? {
        kind: 'artifact_collection' as const,
        collectionId: typeof rule.source.collectionId === 'string'
          ? rule.source.collectionId.trim()
          : '',
        versionPolicy: rule.source.versionPolicy as 'final' | 'approved',
      }
      : rule?.source?.kind === 'document_bundle'
        ? {
          kind: 'document_bundle' as const,
          bundleId: typeof rule.source.bundleId === 'string' ? rule.source.bundleId.trim() : '',
        }
        : rule?.source === undefined
          ? undefined
          : rule.source as unknown as ProjectStageRequiredInputRuleDto['source'];
    return {
      key: typeof rule?.key === 'string' ? rule.key.trim() : '',
      kind: rule?.kind as 'artifact' | 'document',
      label: typeof rule?.label === 'string' ? rule.label.trim() : '',
      ...(source ? { source } : {}),
    };
  });
}

function projectStageEdgeRejection(
  reason:
    | 'unknown_stage'
    | 'self_dependency'
    | 'cross_team'
    | 'cross_channel'
    | 'invalid_required_input'
    | 'duplicate_edge'
    | 'cycle',
): ProjectStageEdgeMutationAck {
  switch (reason) {
    case 'unknown_stage':
      return makeFailure('NOT_FOUND', 'Project Stage not found in this Channel');
    case 'self_dependency':
      return makeFailure('VALIDATION_ERROR', 'A Stage cannot depend on itself');
    case 'cross_team':
    case 'cross_channel':
      return makeFailure('FORBIDDEN', 'Stage dependencies must stay in the same Team and Channel');
    case 'invalid_required_input':
      return makeFailure('VALIDATION_ERROR', 'Required input rules must have a unique key, a label and a known kind');
    case 'duplicate_edge':
      return makeFailure('CONFLICT', 'This Stage dependency already exists');
    case 'cycle':
      return makeFailure('VALIDATION_ERROR', 'Stage dependencies must stay acyclic');
  }
}

function projectStageEdgeMutationAck(
  result: ProjectStageEdgeMutationResult,
): ProjectStageEdgeMutationAck {
  switch (result.kind) {
    case 'created':
    case 'deleted':
    case 'replayed':
      return makeSuccess({
        overview: result.mutation.resultOverview,
        replayed: result.kind === 'replayed',
      });
    case 'idempotency_conflict':
      return makeFailure('CONFLICT', 'idempotencyKey was already used for a different project mutation');
    case 'revision_conflict':
      return makeFailure('CONFLICT', 'Project revision is stale; refresh and retry');
    case 'task_scope_conflict':
      return makeFailure('CONFLICT', 'Tracked Task changed scope or revision; refresh and retry');
    case 'stage_scope_conflict':
      return makeFailure('NOT_FOUND', 'Project Stage not found in this Channel');
    case 'duplicate_edge':
      return makeFailure('CONFLICT', 'This Stage dependency already exists');
    case 'edge_not_found':
      return makeFailure('NOT_FOUND', 'Project Stage edge not found in this Channel');
  }
}

/**
 * #822 Stage edge 写操作的共享前置校验。
 *
 * 与 #821 保持一致的判定顺序：幂等复放在归档门禁之前，
 * 因此归档前完成的写入重试仍返回原结果，而新的写入一律被归档拒绝。
 */
async function prepareProjectStageEdgeMutation<N extends Record<string, unknown>>(
  repositories: ServerNextRepositories,
  input: {
    userId: string;
    teamId: string;
    channelId: string;
    expectedRevision: number;
    idempotencyKey: string;
  },
  normalized: N,
): Promise<ProjectStageEdgeMutationContext<N> | { ok: false; settled: ProjectStageEdgeMutationAck }> {
  const settle = (settled: ProjectStageEdgeMutationAck) => ({ ok: false as const, settled });
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
    return settle(makeFailure('FORBIDDEN', 'User is not a team member'));
  }
  const access = await ensureUserCanViewChannel(repositories, input);
  if (!access.ok) return settle(access as ProjectStageEdgeMutationAck);
  const { channel } = access;
  if (channel.kind !== 'channel') {
    return settle(makeFailure('VALIDATION_ERROR', 'Project stages require a regular channel'));
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    return settle(makeFailure('VALIDATION_ERROR', 'expectedRevision must be a positive integer'));
  }
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  if (!idempotencyKey) {
    return settle(makeFailure('VALIDATION_ERROR', 'idempotencyKey is required'));
  }
  const requestFingerprint = createHash('sha256')
    .update(JSON.stringify({
      teamId: input.teamId,
      channelId: input.channelId,
      expectedRevision: input.expectedRevision,
      ...normalized,
    }))
    .digest('hex');
  const existingMutation = await repositories.channelProjects.getMutation({
    teamId: input.teamId,
    channelId: input.channelId,
    idempotencyKey,
  });
  if (existingMutation) {
    if (existingMutation.requestFingerprint !== requestFingerprint) {
      return settle(makeFailure('CONFLICT', 'idempotencyKey was already used for a different project mutation'));
    }
    return settle(makeSuccess({ overview: existingMutation.resultOverview, replayed: true }));
  }
  if (channel.archivedAt != null) {
    return settle(makeFailure('CONFLICT', 'Archived channels are read-only'));
  }
  const profile = await repositories.channelProjects.getProfile({
    teamId: input.teamId,
    channelId: input.channelId,
  });
  if (!profile) {
    return settle(makeFailure('NOT_FOUND', 'Channel project profile not found'));
  }
  const actorRole = await repositories.teams.getMemberRole(input.teamId, input.userId);
  const authorized = profile.projectLeadId === input.userId
    || channel.createdBy === input.userId
    || actorRole === 'owner'
    || actorRole === 'admin';
  if (!authorized) {
    return settle(makeFailure('FORBIDDEN', 'User cannot configure this channel project'));
  }
  const [stages, edges] = await Promise.all([
    repositories.channelProjects.listStages({ teamId: input.teamId, channelId: input.channelId }),
    repositories.channelProjects.listEdges({ teamId: input.teamId, channelId: input.channelId }),
  ]);
  return {
    ok: true,
    channel,
    profile,
    stages,
    edges,
    idempotencyKey,
    requestFingerprint,
    normalized,
  };
}

async function buildChannelProjectOverview(
  repositories: ServerNextRepositories,
  channel: ChannelRecord,
  piHealthy: boolean,
  now: number,
  resolveProjectStageCandidates?: CreateServerNextUseCasesInput['resolveProjectStageCandidates'],
): Promise<ChannelProjectOverviewDto | null> {
  const profile = await repositories.channelProjects.getProfile({
    teamId: channel.teamId,
    channelId: channel.id,
  });
  if (!profile) return null;
  const [records, edges] = await Promise.all([
    repositories.channelProjects.listStages({ teamId: channel.teamId, channelId: channel.id }),
    repositories.channelProjects.listEdges({ teamId: channel.teamId, channelId: channel.id }),
  ]);
  return projectChannelProjectOverview(
    repositories,
    channel,
    profile,
    records,
    edges,
    piHealthy,
    now,
    resolveProjectStageCandidates,
  );
}

/**
 * #822 从权威记录投影频道项目总览。
 *
 * `edgeRecords` 可以由调用方替换成 mutation 之后的期望边集，
 * 这样创建/删除 Stage edge 的结果快照与后续读取共用同一套投影逻辑。
 */
async function projectChannelProjectOverview(
  repositories: ServerNextRepositories,
  channel: ChannelRecord,
  profile: ChannelProjectProfileRecord,
  stageRecords: readonly ProjectStageRecord[],
  edgeRecords: readonly ProjectStageEdgeRecord[],
  piHealthy: boolean,
  now: number,
  resolveProjectStageCandidates?: CreateServerNextUseCasesInput['resolveProjectStageCandidates'],
): Promise<ChannelProjectOverviewDto> {
  const stageFacts = new Map<string, ProjectStageFacts>();
  for (const record of stageRecords) {
    const task = await repositories.tasks.getById(record.taskId);
    if (!task || task.teamId !== channel.teamId || task.channelId !== channel.id) {
      throw new Error(`Project Stage ${record.id} references an unavailable scoped Task`);
    }
    stageFacts.set(record.id, {
      record,
      task,
      reviewDecision: await resolveProjectStageReviewDecision(repositories, task),
    });
  }
  const stages: ChannelProjectOverviewDto['stages'] = [];
  for (const record of stageRecords) {
    const facts = stageFacts.get(record.id) as ProjectStageFacts;
    stages.push(await projectStageDto(
      repositories,
      facts,
      stageFacts,
      edgeRecords,
      piHealthy,
      now,
      resolveProjectStageCandidates,
    ));
  }
  return {
    profile,
    stages,
    edges: edgeRecords.map(projectStageEdgeDto),
    archived: channel.archivedAt != null,
  };
}

function projectStageEdgeDto(record: ProjectStageEdgeRecord): ProjectStageEdgeDto {
  return {
    id: record.id,
    teamId: record.teamId,
    channelId: record.channelId,
    upstreamStageId: record.upstreamStageId,
    downstreamStageId: record.downstreamStageId,
    upstreamTaskId: record.upstreamTaskId,
    downstreamTaskId: record.downstreamTaskId,
    semantics: record.semantics,
    requiredInputs: record.requiredInputs,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * #823 按逻辑产物投影文件库：集合携带 current version 指针与完整版本历史，
 * 版本携带 Stage/Task、消息、Workspace Run、Invocation、Artifact 与 lineage 来源。
 */
async function buildProjectArtifactLibrary(
  repositories: ServerNextRepositories,
  channel: ChannelRecord,
): Promise<ProjectArtifactLibraryDto> {
  const scope = { teamId: channel.teamId, channelId: channel.id };
  const [collections, versions, reviews, finalizations] = await Promise.all([
    repositories.channelProjects.listArtifactCollections(scope),
    repositories.channelProjects.listArtifactVersions(scope),
    repositories.channelProjects.listArtifactReviews(scope),
    repositories.channelProjects.listArtifactFinalizations(scope),
  ]);
  const reviewsByVersion = new Map<string, ProjectArtifactReviewRecord[]>();
  for (const review of reviews) {
    const bucket = reviewsByVersion.get(review.versionId) ?? [];
    bucket.push(review);
    reviewsByVersion.set(review.versionId, bucket);
  }
  const finalizationsByCollection = new Map<string, ProjectArtifactFinalizationDto[]>();
  for (const finalization of finalizations) {
    const bucket = finalizationsByCollection.get(finalization.collectionId) ?? [];
    bucket.push(projectArtifactFinalizationDto(finalization));
    finalizationsByCollection.set(finalization.collectionId, bucket);
  }
  // #1065 AC5：一次交付 OutputPackage 与跨版本逻辑产物明确区分;version 的
  // packageMemberships 由 Server 投影(该版本作为成员出现在哪些交付包)。
  const packageRecords = await repositories.outputPackages.listPackagesByChannel({
    teamId: channel.teamId,
    channelId: channel.id,
    limit: 200,
  });
  const membershipsByVersion = new Map<string, PackageMembershipRefDto[]>();
  for (const record of packageRecords) {
    const projection = await repositories.outputPackages.getPackageById({
      teamId: channel.teamId,
      packageId: record.packageId,
    });
    for (const member of projection?.members ?? []) {
      const bucket = membershipsByVersion.get(member.artifactVersionId) ?? [];
      bucket.push({
        packageId: record.packageId,
        sequence: member.sequence,
        shortLabel: member.shortLabel,
        deliveredAt: record.createdAt,
        ...(record.taskId ? { taskId: record.taskId } : {}),
      });
      membershipsByVersion.set(member.artifactVersionId, bucket);
    }
  }
  for (const membershipBuckets of membershipsByVersion.values()) {
    membershipBuckets.sort((left, right) => left.deliveredAt - right.deliveredAt);
  }
  const versionsByCollection = new Map<string, ProjectArtifactVersionDto[]>();
  for (const version of versions) {
    const artifact = await repositories.artifacts.getForTeam({
      teamId: channel.teamId,
      artifactId: version.artifactId,
    });
    if (!artifact || artifact.channelId !== channel.id) {
      throw new Error(`Project artifact version ${version.id} references an unavailable scoped Artifact`);
    }
    const bucket = versionsByCollection.get(version.collectionId) ?? [];
    bucket.push(projectArtifactVersionDto(
      version,
      artifact,
      reviewsByVersion.get(version.id) ?? [],
      membershipsByVersion.get(version.id) ?? [],
    ));
    versionsByCollection.set(version.collectionId, bucket);
  }
  return {
    collections: collections.map((collection) => ({
      id: collection.id,
      teamId: collection.teamId,
      channelId: collection.channelId,
      name: collection.name,
      kind: collection.kind,
      revision: collection.revision,
      currentVersionId: collection.currentVersionId,
      ...(collection.finalVersionId === undefined ? {} : { finalVersionId: collection.finalVersionId }),
      versions: (versionsByCollection.get(collection.id) ?? [])
        .sort((left, right) => left.versionNumber - right.versionNumber),
      finalizations: finalizationsByCollection.get(collection.id) ?? [],
      createdBy: collection.createdBy,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
    })),
    archived: channel.archivedAt != null,
  };
}

function projectArtifactVersionDto(
  version: ProjectArtifactVersionRecord,
  artifact: ArtifactRecord,
  reviews: readonly ProjectArtifactReviewRecord[],
  packageMemberships: readonly PackageMembershipRefDto[] = [],
): ProjectArtifactVersionDto {
  const reviewDtos = reviews
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
    .map(projectArtifactReviewDto);
  return {
    id: version.id,
    teamId: version.teamId,
    channelId: version.channelId,
    collectionId: version.collectionId,
    versionNumber: version.versionNumber,
    artifact: toArtifactDto(artifact),
    source: {
      ...(version.stageId === undefined ? {} : { stageId: version.stageId }),
      taskId: version.taskId,
      taskRevision: version.taskRevision,
      ...(version.sourceMessageId === undefined ? {} : { messageId: version.sourceMessageId }),
      ...(version.sourceWorkspaceRunId === undefined ? {} : { workspaceRunId: version.sourceWorkspaceRunId }),
      ...(version.sourceInvocationId === undefined ? {} : { invocationId: version.sourceInvocationId }),
    },
    lineage: version.lineage,
    promotedBy: version.promotedBy,
    ...(version.revisedFromVersionId !== undefined
      ? {
        revisionBasis: {
          revisedFromVersionId: version.revisedFromVersionId,
          ...(version.revisionBasisReviewId !== undefined
            ? { basisReviewId: version.revisionBasisReviewId }
            : {}),
          ...(version.revisionPackageId !== undefined
            ? { packageId: version.revisionPackageId }
            : {}),
          ...(version.revisionDeliveryId !== undefined
            ? { deliveryId: version.revisionDeliveryId }
            : {}),
        },
      }
      : {}),
    createdAt: version.createdAt,
    reviews: reviewDtos,
    reviewState: deriveProjectArtifactVersionReviewState(reviews),
    packageMemberships: packageMemberships.map((membership) => ({ ...membership })),
  };
}

function projectArtifactReviewDto(record: ProjectArtifactReviewRecord): ProjectArtifactReviewDto {
  return {
    id: record.id,
    teamId: record.teamId,
    channelId: record.channelId,
    collectionId: record.collectionId,
    versionId: record.versionId,
    ...(record.stageId ? { stageId: record.stageId } : {}),
    ...(record.packageId ? { packageId: record.packageId } : {}),
    ...(record.deliveryId ? { deliveryId: record.deliveryId } : {}),
    ...(record.taskId ? { taskId: record.taskId } : {}),
    ...(record.taskRevision !== undefined ? { taskRevision: record.taskRevision } : {}),
    ...(record.taskAttempt !== undefined ? { taskAttempt: record.taskAttempt } : {}),
    authorityBasis: record.authorityBasis,
    decision: record.decision,
    comment: record.comment,
    basis: record.basis,
    reviewedBy: record.reviewedBy,
    createdAt: record.createdAt,
  };
}

// #1060 OutputPackage DTO 映射:record → 冻结的不可变投影(创建后成员/版本永不改写)。
/**
 * #1061 AC11：聚合 package 成员 reviewState——任一 rejected → rejected;任一
 * changes_requested → changes_requested;全部 approved → approved;否则 pending。
 */
function aggregatePackageReviewState(
  memberReviews: readonly { versionId: string; decision: ProjectArtifactReviewDecision }[],
): ProjectArtifactVersionReviewState {
  if (memberReviews.length === 0) return 'pending';
  // 每个成员取最新一条 review(与 #824 的 deriveProjectArtifactVersionReviewState 一致)。
  const latestByVersion = new Map<string, ProjectArtifactReviewDecision>();
  for (const review of memberReviews) {
    latestByVersion.set(review.versionId, review.decision);
  }
  const latest = [...latestByVersion.values()];
  if (latest.some((decision) => decision === 'rejected')) return 'rejected';
  if (latest.some((decision) => decision === 'changes_requested')) return 'changes_requested';
  if (latest.every((decision) => decision === 'approved')) return 'approved';
  return 'pending';
}

function toOutputPackageSummaryDto(
  record: OutputPackageRecord,
  reviewState: ProjectArtifactVersionReviewState,
): OutputPackageSummaryDto {
  return {
    schemaVersion: 1,
    packageId: record.packageId,
    teamId: record.teamId,
    channelId: record.channelId,
    revision: 1,
    deliveryId: record.deliveryId,
    publishId: record.publishId,
    workspaceRevisionId: record.workspaceRevisionId,
    agentId: record.agentId,
    taskId: record.taskId,
    taskBinding: record.taskBinding,
    ...(record.taskRevision !== undefined ? { taskRevision: record.taskRevision } : {}),
    taskAttempt: record.taskAttempt,
    memberCount: record.memberCount,
    reviewState,
    status: 'recorded',
    createdAt: record.createdAt,
  };
}

// ---------------------------------------------------------------------------
// #1065：OutputPackage 列表/Task 交付聚合视图共用的 summary 组装(同一组 Server 事实)。
// ---------------------------------------------------------------------------

/** TaskRecord → TaskDto(交付聚合视图与 ProjectStage 投影共用,防字段漂移)。 */
function toTaskDto(task: TaskRecord): TaskDto {
  return {
    id: task.id,
    teamId: task.teamId,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    status: task.status,
    creatorId: task.creatorId,
    ...(task.assigneeId === undefined ? {} : { assigneeId: task.assigneeId }),
    ...(task.channelId === undefined ? {} : { channelId: task.channelId }),
    tags: task.tags,
    sortOrder: task.sortOrder,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** #1066：package 投影聚合所需仓储（archive gate 与查询共用，避免全量 ServerNextRepositories）。 */
type OutputPackageProjectionRepositories = Pick<
  ServerNextRepositories,
  'outputPackages' | 'workspacePublishStagings' | 'channelProjects'
>;

async function summarizeOutputPackages(
  repositories: OutputPackageProjectionRepositories,
  input: { teamId: ID; channelId: ID },
  records: readonly OutputPackageRecord[],
): Promise<OutputPackageSummaryDto[]> {
  const allReviews = await repositories.channelProjects.listArtifactReviews({
    teamId: input.teamId,
    channelId: input.channelId,
  });
  const summaries = [];
  for (const record of records) {
    const projection = await repositories.outputPackages.getPackageById({
      teamId: input.teamId,
      packageId: record.packageId,
    });
    const memberReviews = (projection?.members ?? []).flatMap((member) =>
      allReviews.filter((review) => review.versionId === member.artifactVersionId));
    summaries.push(toOutputPackageSummaryDto(record, aggregatePackageReviewState(memberReviews)));
  }
  return summaries;
}

async function listPendingOutputDeliveries(
  repositories: OutputPackageProjectionRepositories,
  input: { teamId: ID; channelId: ID; taskId?: ID },
): Promise<OutputPackagePendingDeliveryDto[]> {
  const committedStagings = await repositories.workspacePublishStagings.listCommittedByChannel({
    teamId: input.teamId,
    channelId: input.channelId,
    ...(input.taskId ? { taskId: input.taskId } : {}),
  });
  const formedPublishIds = new Set(
    await repositories.outputPackages.listPackagePublishIdsByChannel({
      teamId: input.teamId,
      channelId: input.channelId,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    }),
  );
  return committedStagings
    .filter((staging) => staging.provenance && !formedPublishIds.has(staging.publishId))
    .map((staging) => ({
      publishId: staging.publishId,
      workspaceRevisionId: staging.committedRevisionId ?? '',
      agentId: staging.provenance!.agentId,
      taskId: staging.provenance!.taskId,
      taskAttempt: staging.provenance!.taskAttempt,
      committedAt: staging.updatedAt,
    }));
}

// ---------------------------------------------------------------------------
// #1065 AC3/AC4：Task 交付聚合视图(单一 Server 投影,web 只渲染)。
// ---------------------------------------------------------------------------

async function buildTaskDeliveryOverview(
  repositories: ServerNextRepositories,
  input: {
    teamId: ID;
    channelId: ID;
    taskId: ID;
    userId: ID;
    now: UnixMs;
    piHealthy: boolean;
    /** #822 阶段功能开关由调用方(闭包内)判定后传入。 */
    includeStage: boolean;
    resolveProjectStageCandidates?: CreateServerNextUseCasesInput['resolveProjectStageCandidates'];
  },
): Promise<TaskDeliveryOverviewV1 | null> {
  const { teamId, channelId, taskId } = input;
  const task = await repositories.tasks.getById(taskId);
  if (!task || task.teamId !== teamId || (task.channelId !== undefined && task.channelId !== channelId)) {
    return null;
  }
  const coordination = await repositories.taskCoordination.coordinations.getByTaskId(taskId);
  const [criteria, offers] = await Promise.all([
    coordination ? repositories.taskCoordination.criteria.list(taskId) : Promise.resolve([]),
    repositories.taskCoordination.offers.listByTask(taskId),
  ]);
  const claim = coordination
    ? await repositories.taskCoordination.claimLeases.getLatest({
      taskId,
      taskRevision: coordination.taskRevision,
      taskAttempt: coordination.attempt,
    })
    : null;

  // 当前 delivery/package(与 listOutputPackages 同一组 Server 事实,AC6)。
  const packageRecords = await repositories.outputPackages.listPackagesByChannel({
    teamId,
    channelId,
    taskId,
    limit: 50,
  });
  const [packages, pendingDeliveries] = await Promise.all([
    summarizeOutputPackages(repositories, { teamId, channelId }, packageRecords),
    listPendingOutputDeliveries(repositories, { teamId, channelId, taskId }),
  ]);

  // stage:该 task 绑定 ProjectStage 时携带(目标/依赖/executionAllowed,AC3)。
  let stage: ProjectStageDto | undefined;
  if (input.includeStage) {
    const channel = await repositories.channels.getById(channelId);
    if (channel && channel.teamId === teamId) {
      const overview = await buildChannelProjectOverview(
        repositories,
        channel,
        input.piHealthy,
        input.now,
        input.resolveProjectStageCandidates,
      );
      stage = overview?.stages.find((candidate) => candidate.task.id === taskId);
    }
  }

  // 执行链原料(AC4:offer/claim/delivery/人工修改/review/final/交接)。
  const [reviews, finalizations, versions, deliveries, collections] = await Promise.all([
    repositories.channelProjects.listArtifactReviews({ teamId, channelId }),
    repositories.channelProjects.listArtifactFinalizations({ teamId, channelId }),
    repositories.channelProjects.listArtifactVersions({ teamId, channelId }),
    coordination ? repositories.taskCoordination.deliveries.listByTask(taskId) : Promise.resolve([]),
    repositories.channelProjects.listArtifactCollections({ teamId, channelId }),
  ]);

  // #1065 AC3：required review coverage——焦点交付包中 final 必需成员数 vs 已达 final 数。
  let requiredReviewCoverage: TaskAcceptanceContractV1['requiredReviewCoverage'] = {
    requiredForFinalCount: 0,
    finalizedCount: 0,
    complete: false,
  };
  const focusRecord = packageRecords[packageRecords.length - 1];
  if (focusRecord) {
    const projection = await repositories.outputPackages.getPackageById({
      teamId,
      packageId: focusRecord.packageId,
    });
    const requiredMembers = (projection?.members ?? []).filter((member) => member.requiredForFinal);
    const finalVersionIds = new Set(
      collections.map((collection) => collection.finalVersionId).filter((id): id is string => Boolean(id)),
    );
    const finalizedCount = requiredMembers.filter((member) => finalVersionIds.has(member.artifactVersionId)).length;
    requiredReviewCoverage = {
      requiredForFinalCount: requiredMembers.length,
      finalizedCount,
      complete: requiredMembers.length > 0 && finalizedCount === requiredMembers.length,
    };
  }
  const taskReviews = reviews.filter((review) => review.taskId === taskId);
  const taskFinalizations = finalizations.filter((fin) => taskReviews.some((review) => review.id === fin.basisReviewId));
  // #1062「基于此修改」产生的新版本 = 人工修改事件(revisionPackageId 冻结来源包)。
  const taskHumanRevisions = versions.filter((version) => version.taskId === taskId && version.revisionPackageId);

  const timeline: TaskTimelineEventV1[] = [];
  const agentNameOf = async (agentId: ID): Promise<string> => {
    const agent = await repositories.agents.getById(agentId);
    return agent?.name ?? agentId;
  };
  for (const offer of offers) {
    const name = await agentNameOf(offer.agentId);
    const isHandoff = (offer.frozenInputs?.length ?? 0) > 0;
    timeline.push({
      id: `${isHandoff ? 'handoff' : 'offer'}-${offer.id}`,
      kind: isHandoff ? 'handoff' : 'offer',
      at: offer.createdAt,
      actorKind: 'system',
      summary: isHandoff ? `将冻结文件包交给 Agent「${name}」` : `向 Agent「${name}」发布工作 Offer`,
    });
    if (offer.response?.kind === 'accepted') {
      timeline.push({
        id: `accept-${offer.id}`,
        kind: 'acceptance',
        at: offer.updatedAt,
        actorKind: 'agent',
        actorName: name,
        summary: `Agent「${name}」接受 Offer`,
      });
    }
  }
  if (claim) {
    const name = await agentNameOf(claim.agentId);
    timeline.push({
      id: `claim-${claim.id}`,
      kind: 'claim',
      at: claim.acquiredAt,
      actorKind: 'agent',
      actorName: name,
      summary: `Agent「${name}」建立执行 claim`,
    });
    // #948 E:execution-start 投影 = task.status 进入 in_progress;时刻以 claim.acquiredAt 保守近似。
    if (task.status === 'in_progress') {
      timeline.push({
        id: `start-${claim.id}`,
        kind: 'execution_start',
        at: claim.acquiredAt,
        actorKind: 'agent',
        actorName: name,
        summary: `Agent「${name}」开始执行`,
      });
    }
  }
  for (const delivery of deliveries) {
    const name = claim ? await agentNameOf(claim.agentId) : 'Agent';
    timeline.push({
      id: `delivery-${delivery.id}`,
      kind: 'delivery',
      at: delivery.createdAt,
      actorKind: 'agent',
      actorName: name,
      summary: `Agent「${name}」提交交付`,
    });
  }
  for (const record of packageRecords) {
    timeline.push({
      id: `package-${record.packageId}`,
      kind: 'delivery',
      at: record.createdAt,
      actorKind: 'system',
      summary: `交付文件包形成(${record.memberCount} 个文件)`,
    });
  }
  for (const version of taskHumanRevisions) {
    timeline.push({
      id: `revise-${version.id}`,
      kind: 'human_revision',
      at: version.createdAt,
      actorKind: 'human',
      summary: `人工修订产物版本 v${version.versionNumber}`,
    });
  }
  for (const review of taskReviews) {
    const decisionLabel = review.decision === 'approved' ? '通过'
      : review.decision === 'changes_requested' ? '要求修改'
        : review.decision === 'rejected' ? '拒绝'
          : review.decision;
    timeline.push({
      id: `review-${review.id}`,
      kind: 'review',
      at: review.createdAt,
      actorKind: 'human',
      summary: `审核${decisionLabel}「${review.comment || '无备注'}」`,
    });
  }
  for (const fin of taskFinalizations) {
    timeline.push({
      id: `final-${fin.id}`,
      kind: 'finalization',
      at: fin.createdAt,
      actorKind: fin.actorKind === 'human' ? 'human' : 'pi',
      summary: `设为最终版(${fin.reason ?? '验收通过'})`,
    });
  }
  timeline.sort((a, b) => a.at - b.at);

  // 当前责任焦点(AC3/AC10:只由 Offer/claim/execution/delivery/review 等 Server 事实投影)。
  const focus = await deriveTaskResponsibilityFocus(
    repositories,
    { task, coordination, offers, claim },
  );

  // Task 级可发现性动作(AC9:Server 计算,web 只渲染;command 提交仍完整复验)。
  const availableActions: TaskLevelAvailableActionDto[] = [
    { action: 'open-task', label: '打开 Task' },
    packages.length > 0
      ? { action: 'delegate-to-agent', label: '交给 Agent 处理' }
      : { action: 'delegate-to-agent', label: '交给 Agent 处理', disabled: true, disabledReason: '暂无交付文件包' },
    task.status === 'in_review' && packages.length > 0
      ? { action: 'review-package', label: '审核交付包' }
      : { action: 'review-package', label: '审核交付包', disabled: true, disabledReason: '当前无待审核交付' },
  ];

  const watermark = await repositories.systemActivity?.watermarks
    .get(OUTPUT_PACKAGE_WATERMARK_STREAM_KIND, channelId) ?? null;
  return {
    schemaVersion: 1,
    taskId,
    channelId,
    task: toTaskDto(task),
    ...(stage ? { stage } : {}),
    acceptanceContract: {
      nodeKind: coordination?.nodeKind ?? 'root',
      reviewPolicy: coordination?.reviewPolicy ?? 'human',
      humanAcceptanceAuthorityIds: coordination?.humanAcceptanceAuthorityIds ?? [],
      requiresHumanAcceptance: (coordination?.humanAcceptanceAuthorityIds?.length ?? 0) > 0,
      acceptanceCriteria: criteria.map((criterion) => criterion.description),
      taskRevision: coordination?.taskRevision ?? task.revision,
      attempt: coordination?.attempt ?? 1,
      maxAttempts: coordination?.maxAttempts ?? 1,
      requiredReviewCoverage,
    },
    responsibilityFocus: focus,
    delivery: {
      packages,
      pendingDeliveries,
      ...(packageRecords.length > 0 ? { focusPackageId: packageRecords[packageRecords.length - 1]!.packageId } : {}),
    },
    availableActions,
    timeline,
    asOf: input.now,
    audienceScope: `${teamId}:${channelId}:${input.userId}`,
    consistencyToken: {
      schemaVersion: 1,
      entries: [{ streamKind: OUTPUT_PACKAGE_WATERMARK_STREAM_KIND, streamId: channelId, revision: watermark?.revision ?? 0 }],
    },
  };
}

async function deriveTaskResponsibilityFocus(
  repositories: ServerNextRepositories,
  input: {
    task: { status: TaskStatus; id: ID };
    coordination: TaskCoordinationRecord | null;
    offers: readonly TaskOfferRecord[];
    claim: TaskClaimLeaseRecord | null;
  },
): Promise<TaskResponsibilityFocusV1> {
  const { task, coordination, offers, claim } = input;
  if (!coordination) {
    return { kind: 'none', detail: '尚无协调事实' };
  }
  const openOffer = offers.find((offer) => offer.status === 'open' && !offer.response);
  if (openOffer) {
    const agent = await repositories.agents.getById(openOffer.agentId);
    return {
      kind: 'offer_wait',
      offerId: openOffer.id,
      agentId: openOffer.agentId,
      ...(agent?.name ? { agentName: agent.name } : {}),
      detail: `等待 Agent「${agent?.name ?? openOffer.agentId}」响应 Offer`,
    };
  }
  if (task.status === 'in_review') {
    return { kind: 'review_wait', detail: '等待人类验收/审核交付' };
  }
  if (claim) {
    const agent = await repositories.agents.getById(claim.agentId);
    const name = agent?.name ?? claim.agentId;
    if (claim.status === 'active') {
      if (task.status === 'in_progress') {
        return {
          kind: 'execution_active',
          claimLeaseId: claim.id,
          agentId: claim.agentId,
          ...(agent?.name ? { agentName: agent.name } : {}),
          detail: `Agent「${name}」正在执行`,
        };
      }
      return {
        kind: 'claim_active',
        claimLeaseId: claim.id,
        agentId: claim.agentId,
        ...(agent?.name ? { agentName: agent.name } : {}),
        detail: `Agent「${name}」已建立执行 claim`,
      };
    }
  }
  return { kind: 'none', detail: '等待分配' };
}

function toOutputPackageDto(
  record: OutputPackageRecord,
  members: readonly OutputPackageMemberRecord[],
): OutputPackageDto {
  return {
    schemaVersion: 1,
    packageId: record.packageId,
    teamId: record.teamId,
    channelId: record.channelId,
    revision: 1,
    deliveryId: record.deliveryId,
    publishId: record.publishId,
    workspaceRevisionId: record.workspaceRevisionId,
    agentId: record.agentId,
    taskId: record.taskId,
    taskBinding: record.taskBinding,
    ...(record.taskRevision !== undefined ? { taskRevision: record.taskRevision } : {}),
    taskAttempt: record.taskAttempt,
    ...(record.invocationId ? { invocationId: record.invocationId } : {}),
    ...(record.workspaceRunId ? { workspaceRunId: record.workspaceRunId } : {}),
    ...(record.claimLeaseId ? { claimLeaseId: record.claimLeaseId } : {}),
    ...(record.deviceId ? { deviceId: record.deviceId } : {}),
    members: members.map((member) => ({
      packageId: record.packageId,
      sequence: member.sequence,
      shortLabel: member.shortLabel,
      collectionId: member.collectionId,
      artifactVersionId: member.artifactVersionId,
      role: member.role,
      requiredForFinal: member.requiredForFinal,
      sourcePath: member.sourcePath,
      filename: member.filename,
      ...(member.sha256 ? { sha256: member.sha256 } : {}),
      sizeBytes: member.sizeBytes,
    })),
    memberCount: record.memberCount,
    status: 'recorded',
    createdAt: record.createdAt,
  };
}

async function computeOutputPackageProjection(
  repositories: ServerNextRepositories,
  input: {
    teamId: string;
    channelId: string;
    packageProjection: { package: OutputPackageRecord; members: OutputPackageMemberRecord[] };
    policy: OutputPackageProjectionPolicy;
    specifiedVersions?: readonly { collectionId: string; versionId: string }[];
  },
): Promise<OutputPackageProjectionResultV1> {
  // 装载 package 候选与 projection policy 无关(只读冻结成员 + 同快照 facts);
  // specified 也在同一装载路径,只是解析策略不同。
  const packageCandidate = await loadProjectReferencePackageCandidate(repositories, {
    teamId: input.teamId,
    channelId: input.channelId,
  }, {
    kind: 'package_projection',
    packageId: input.packageProjection.package.packageId,
    policy: input.policy === 'specified' ? 'delivered' : input.policy,
  });
  if (!packageCandidate) {
    // package 已通过上面的 getById 存在校验;此处不可达,防御性返回空 not_ready。
    return {
      policy: input.policy,
      status: 'not_ready',
      members: [],
      blockers: [],
      omitted: [],
      consistencyToken: {
        schemaVersion: 1,
        entries: [{ streamKind: 'output-package', streamId: input.packageProjection.package.packageId, revision: 1 }],
      },
    };
  }
  const resolution = resolveOutputPackageProjection({
    members: packageCandidate.members,
    collections: packageCandidate.collections,
    versions: packageCandidate.versions,
    reviewStateByVersionId: packageCandidate.reviewStateByVersionId,
    policy: input.policy,
    ...(input.specifiedVersions ? { specifiedVersions: input.specifiedVersions } : {}),
  });
  const consistencyToken: ConsistencyTokenV1 = {
    schemaVersion: 1,
    entries: [
      { streamKind: 'output-package', streamId: input.packageProjection.package.packageId, revision: 1 },
      ...packageCandidate.collections.map((collection) => ({
        streamKind: 'project-artifact-collection',
        streamId: collection.id,
        revision: collection.revision,
      })),
    ],
  };
  return {
    policy: input.policy,
    status: resolution.status,
    members: resolution.members,
    blockers: resolution.blockers,
    omitted: resolution.omitted,
    consistencyToken,
  };
}

function projectArtifactFinalizationDto(
  record: ProjectArtifactFinalizationRecord,
): ProjectArtifactFinalizationDto {
  return {
    id: record.id,
    teamId: record.teamId,
    channelId: record.channelId,
    collectionId: record.collectionId,
    versionId: record.versionId,
    ...(record.previousVersionId === undefined ? {} : { previousVersionId: record.previousVersionId }),
    basisReviewId: record.basisReviewId,
    actorKind: record.actorKind,
    finalizedBy: record.finalizedBy,
    ...(record.managementRunId === undefined ? {} : { managementRunId: record.managementRunId }),
    ...(record.humanConfirmation === undefined ? {} : { humanConfirmation: record.humanConfirmation }),
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    createdAt: record.createdAt,
  };
}

async function projectArtifactPromotionResult(
  repositories: ServerNextRepositories,
  channel: ChannelRecord,
  refs: { collectionId: string; versionId: string },
): Promise<{
  library: ProjectArtifactLibraryDto;
  collection: ProjectArtifactCollectionDto;
  version: ProjectArtifactVersionDto;
} | null> {
  const library = await buildProjectArtifactLibrary(repositories, channel);
  const collection = library.collections.find((candidate) => candidate.id === refs.collectionId);
  const version = collection?.versions.find((candidate) => candidate.id === refs.versionId);
  if (!collection || !version) return null;
  return { library, collection, version };
}

async function resolveProjectArtifactLineageScope(
  repositories: ServerNextRepositories,
  scope: { teamId: string; channelId: string },
  ref: ProjectArtifactLineageRefDto | ProjectArtifactReviewBasisRefDto,
): Promise<{ teamId: string; channelId: string } | null> {
  if (ref.kind === 'project_version') {
    const versions = await repositories.channelProjects.listArtifactVersions(scope);
    const version = versions.find((candidate) => candidate.id === ref.refId);
    return version ? { teamId: version.teamId, channelId: version.channelId } : null;
  }
  if (ref.kind === 'message') {
    const message = await repositories.messages.getById(ref.refId);
    return message ? { teamId: message.teamId, channelId: message.channelId } : null;
  }
  const artifact = await repositories.artifacts.getForTeam({
    teamId: scope.teamId,
    artifactId: ref.refId,
  });
  if (!artifact || isWorkspaceRunLogArtifact(artifact)) return null;
  if (!(await isPublicChannelFileArtifact(repositories, artifact))) return null;
  return { teamId: artifact.teamId, channelId: artifact.channelId };
}

/**
 * #1061 AC11：按当前用户计算 package 成员的可执行动作。
 * 权限判定完全复用 domain 纯函数(review/finalization authority 与 #824 合同同源),
 * 客户端不得自行推断——按钮可见性只由这里的结果决定。
 */
async function computePackageMemberAvailableActions(
  repositories: ServerNextRepositories,
  input: {
    teamId: string;
    userId: string;
    channelId: string;
    packageProjection: { package: OutputPackageRecord; members: OutputPackageMemberRecord[] };
  },
): Promise<PackageMemberAvailableActionsDto[]> {
  const { teamId, userId, channelId } = input;
  const profile = await repositories.channelProjects.getProfile({ teamId, channelId });
  const collections = await repositories.channelProjects.listArtifactCollections({ teamId, channelId });
  const versions = await repositories.channelProjects.listArtifactVersions({ teamId, channelId });
  const reviews = await repositories.channelProjects.listArtifactReviews({ teamId, channelId });
  const stages = await repositories.channelProjects.listStages({ teamId, channelId });
  const teamRole = await repositories.teams.getMemberRole(teamId, userId);
  const task = await repositories.tasks.getById(input.packageProjection.package.taskId);
  const coordination = task
    ? await repositories.taskCoordination.coordinations.getByTaskId(task.id)
    : null;

  // #1062:预读可修订成员对应 Artifact(Markdown 判定),避免在 map 回调里 await。
  const memberArtifacts = new Map<string, Awaited<ReturnType<ServerNextRepositories['artifacts']['getForTeam']>>>();
  for (const member of input.packageProjection.members) {
    const version = versions.find((candidate) => candidate.id === member.artifactVersionId);
    if (!version) continue;
    memberArtifacts.set(
      member.artifactVersionId,
      await repositories.artifacts.getForTeam({ teamId, artifactId: version.artifactId }),
    );
  }

  return input.packageProjection.members.map((member) => {
    const collection = collections.find((candidate) => candidate.id === member.collectionId);
    const version = versions.find((candidate) => candidate.id === member.artifactVersionId);
    const stage = version?.stageId
      ? stages.find((candidate) => candidate.id === version.stageId) ?? null
      : null;
    const memberReviews = reviews.filter((candidate) => candidate.versionId === member.artifactVersionId);
    const reviewState = deriveProjectArtifactVersionReviewState(
      memberReviews.map((record) => ({
        id: record.id,
        versionId: record.versionId,
        decision: record.decision,
        createdAt: record.createdAt,
      })),
    );
    const isFinalVersion = collection?.finalVersionId === member.artifactVersionId;

    const authority = evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: {
        teamId,
        channelId,
        actorFacts: {
          userId,
          teamRole,
          projectLeadId: profile?.projectLeadId ?? '',
          stageReviewerIds: stage?.reviewerIds ?? [],
        },
        package: {
          id: input.packageProjection.package.packageId,
          teamId: input.packageProjection.package.teamId,
          channelId: input.packageProjection.package.channelId,
          members: input.packageProjection.members.map((m) => ({
            collectionId: m.collectionId,
            artifactVersionId: m.artifactVersionId,
          })),
        },
        versionScope: {
          collectionId: member.collectionId,
          versionId: member.artifactVersionId,
          versionCollectionId: version?.collectionId,
        },
      },
      decision: 'approved',
    });
    const canReview = authority.kind === 'allowed';
    const canFinalize = canReview; // #824 合同:review 与 finalization authority 同源。

    const actions: (PackageReviewAction | ArtifactRevisionAction)[] = [];
    if (canReview) {
      actions.push('review-approved', 'review-changes-requested', 'review-rejected');
      if (task && coordination
        && task.status === 'in_review'
        && input.packageProjection.package.taskId === task.id) {
        actions.push('review-and-reject-delivery');
      }
      if (canFinalize && collection) {
        actions.push('review-and-finalize');
      }
    }
    if (canFinalize && collection && reviewState === 'approved' && !isFinalVersion) {
      actions.push('set-final');
    }
    // #1062 AC1:被拒绝/要求修改的 Markdown 交付版本可「基于此修改」。
    // 频道可见人类 + 未归档即可编辑(与 Channel document 编辑同一权限口径);
    // reviewState 由 Server 从版本自身 reviews 派生,客户端不推断。
    const latestReview = memberReviews
      .slice()
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .at(-1);
    if (collection && version && !isFinalVersion
      && (reviewState === 'rejected' || reviewState === 'changes_requested')
      && latestReview) {
      const memberArtifact = memberArtifacts.get(member.artifactVersionId);
      if (memberArtifact && isMarkdownArtifact(memberArtifact)) {
        actions.push('revise-version');
      }
    }
    return {
      collectionId: member.collectionId,
      versionId: member.artifactVersionId,
      reviewState,
      isFinalVersion,
      collectionRevision: collection?.revision ?? 0,
      ...(reviewState === 'rejected' || reviewState === 'changes_requested'
        ? { latestReviewId: latestReview?.id }
        : {}),
      actions,
    };
  });
}

function projectArtifactPromotionFailure(
  reasonCode: ProjectArtifactPromotionRejectionCode,
): ReturnType<typeof makeFailure> {
  switch (reasonCode) {
    case 'collection_not_found':
      return makeFailure('NOT_FOUND', 'Logical artifact collection not found in this Team and Channel');
    case 'collection_out_of_scope':
      return makeFailure('NOT_FOUND', 'Logical artifact collection not found in this Team and Channel');
    case 'collection_revision_stale':
      return makeFailure('CONFLICT', 'Project artifact collection revision is stale; refresh and retry');
    case 'collection_name_conflict':
      return makeFailure('CONFLICT', 'A logical artifact collection with this name already exists');
    case 'artifact_promoted_to_other_collection':
      return makeFailure('CONFLICT', 'Artifact is already promoted into another logical artifact collection');
    default:
      return makeFailure('VALIDATION_ERROR', 'Ambiguous logical artifact collection target');
  }
}

/**
 * #1061 三个 package review 命令的结果 → Ack 映射。
 * - conflict/rejected → 结构化失败(AC10:stale/越权/replay 冲突返回明确 outcome);
 * - replayed → 从 receipt 的完整 resultJson 恢复既有事实,不重跑业务(AC10 同 key replay);
 * - applied → 各命令自己的成功事实(review / review+finalization / review+task transition)。
 */
/** #1061 AC10：stale/幂等类拒绝码 → CONFLICT 语义(其余权限类 → FORBIDDEN)。 */
const PACKAGE_REVIEW_CONFLICT_CODES: readonly string[] = [
  'collection-revision-stale',
  'task-revision-stale',
  'task-attempt-stale',
  'version-not-in-package',
  'version-not-in-collection',
  'delivery-not-reviewable',
  'package-out-of-scope',
  'review-required-before-reject',
  'idempotency-conflict',
];

/** #1061 三个命令的成功 payload 按 mode 映射。 */
export interface PackageReviewAckPayloadMap {
  readonly review: { review: PackageReviewDto; replayed: boolean };
  readonly finalize: {
    review: PackageReviewDto;
    finalization: ProjectArtifactFinalizationDto;
    collection: ProjectArtifactCollectionDto;
    replayed: boolean;
  };
  readonly 'reject-delivery': {
    review: PackageReviewDto;
    task: { taskId: string; taskRevision: number; taskAttempt: number; status: string };
    replayed: boolean;
  };
}

async function packageReviewCommandAck<M extends keyof PackageReviewAckPayloadMap>(
  repositories: ServerNextRepositories,
  result: SubmitPackageReviewResult,
  mode: M,
): Promise<Ack<PackageReviewAckPayloadMap[M]>> {
  if (result.kind === 'conflict') {
    return makeFailure('CONFLICT', `Package review conflict: ${result.reasonCode}`);
  }
  if (result.kind === 'rejected') {
    // #1061 AC10：stale revision / 幂等冲突是 conflict 语义,权限类是 FORBIDDEN。
    if (PACKAGE_REVIEW_CONFLICT_CODES.includes(result.reasonCode)) {
      return makeFailure('CONFLICT', `Package review conflict: ${result.reasonCode}`);
    }
    if (result.reasonCode === 'invalid-decision' || result.reasonCode === 'reject-reason-required') {
      return makeFailure('VALIDATION_ERROR', `Package review rejected: ${result.reasonCode}`);
    }
    return makeFailure('FORBIDDEN', `Package review rejected: ${result.reasonCode}`);
  }
  if (result.kind === 'replayed') {
    // 同 key replay:从首次 receipt 的完整 resultJson 恢复既有事实(AC10)。
    let parsed: { review?: PackageReviewDto } = {};
    try {
      parsed = JSON.parse(result.receipt.resultJson ?? '{}') as { review?: PackageReviewDto };
    } catch {
      // 治理压缩后的 receipt 无 result:返回冲突,调用方刷新。
    }
    if (!parsed.review) {
      return makeFailure('CONFLICT', 'Recorded package review result is no longer available');
    }
    if (mode === 'finalize') {
      const finalizations = await repositories.channelProjects.listArtifactFinalizations({
        teamId: result.receipt.teamId,
        channelId: parsed.review.channelId ?? '',
      });
      const finalization = finalizations.find((candidate) => candidate.basisReviewId === parsed.review!.id);
      // 组合事实必须完整可恢复;治理压缩导致任一缺失 → conflict,不伪造(AC10)。
      if (!finalization) {
        return makeFailure('CONFLICT', 'Recorded package review finalization result is no longer available');
      }
      const channel = await repositories.channels.getById(parsed.review.channelId ?? '');
      const projection = channel
        ? await projectArtifactPromotionResult(repositories, channel, {
          collectionId: parsed.review.collectionId ?? '',
          versionId: parsed.review.versionId ?? '',
        })
        : null;
      if (!projection) {
        return makeFailure('CONFLICT', 'Recorded package review finalization result is no longer available');
      }
      return makeSuccess({
        review: parsed.review,
        finalization: projectArtifactFinalizationDto(finalization),
        collection: projection.collection,
        replayed: true,
      });
    }
    if (mode === 'reject-delivery') {
      let parsedTask: { taskId: string; taskStatusAfterReject: string } | undefined;
      try {
        parsedTask = (JSON.parse(result.receipt.resultJson ?? '{}') as { task?: typeof parsedTask }).task;
      } catch {
        // 治理压缩后的 receipt 无 result。
      }
      if (!parsedTask) {
        return makeFailure('CONFLICT', 'Recorded package review result is no longer available');
      }
      return makeSuccess({
        review: parsed.review,
        task: {
          taskId: parsedTask.taskId,
          taskRevision: parsed.review.taskRevision ?? 1,
          taskAttempt: parsed.review.taskAttempt ?? 1,
          status: parsedTask.taskStatusAfterReject,
        },
        replayed: true,
      });
    }
    return makeSuccess({ review: parsed.review, replayed: true });
  }
  if (mode === 'finalize' && result.finalization) {
    const collection = await repositories.channelProjects.getArtifactCollection({
      teamId: result.finalization.teamId,
      channelId: result.finalization.channelId,
      collectionId: result.finalization.collectionId,
    });
    return makeSuccess({
      review: projectArtifactReviewDto(result.review) as PackageReviewDto,
      finalization: projectArtifactFinalizationDto(result.finalization),
      collection: collection ?? { id: result.finalization.collectionId } as never,
      replayed: false,
    } as never);
  }
  if (mode === 'reject-delivery' && result.taskTransition) {
    return makeSuccess({
      review: projectArtifactReviewDto(result.review) as PackageReviewDto,
      task: {
        taskId: result.taskTransition.taskId,
        taskRevision: result.taskTransition.taskRevision,
        taskAttempt: result.taskTransition.taskAttempt,
        status: result.taskTransition.status,
      },
      replayed: false,
    });
  }
  return makeSuccess({ review: projectArtifactReviewDto(result.review) as PackageReviewDto, replayed: false });
}

/**
 * #1062 save-artifact-version-revision 结果 → Ack 映射。
 * - conflict(stale fence 三态) → CONFLICT + details.revisionConflict 结构化 payload(AC6/AC7);
 * - replayed → 从 receipt.resultJson 恢复首次结果,不重跑业务(AC10);
 * - rejected → FORBIDDEN/VALIDATION_ERROR 按语义(权限类 FORBIDDEN,内容/作用域类 VALIDATION)。
 */
async function artifactRevisionCommandAck(
  _repositories: ServerNextRepositories,
  result: SaveArtifactVersionRevisionResult,
): Promise<Ack<{ revision: ArtifactVersionRevisionSaveResultDto; replayed: boolean }>> {
  if (result.kind === 'conflict') {
    if (result.revisionConflict) {
      return makeFailure('CONFLICT', `Artifact revision conflict: ${result.reasonCode}`, {
        revisionConflict: result.revisionConflict,
      });
    }
    return makeFailure('CONFLICT', `Artifact revision conflict: ${result.reasonCode}`);
  }
  if (result.kind === 'rejected') {
    // 作用域/内容/编辑开关 → VALIDATION_ERROR;权限/归档/越权 → FORBIDDEN。
    if (result.reasonCode === 'revision-editing-disabled'
      || result.reasonCode === 'content-invalid'
      || result.reasonCode === 'version-not-in-collection'
      || result.reasonCode === 'not-markdown-version'
      || result.reasonCode === 'revision-basis-mismatch'
      || result.reasonCode === 'collection-not-found'
      || result.reasonCode === 'channel-not-found'
      || result.reasonCode === 'invalid-request') {
      return makeFailure('VALIDATION_ERROR', `Artifact revision rejected: ${result.reasonCode}`);
    }
    return makeFailure('FORBIDDEN', `Artifact revision rejected: ${result.reasonCode}`);
  }
  if (result.kind === 'replayed') {
    let parsed: ArtifactVersionRevisionSaveResultDto | undefined;
    try {
      parsed = JSON.parse(result.receipt.resultJson ?? '{}') as ArtifactVersionRevisionSaveResultDto;
    } catch {
      // 治理压缩后的 receipt 无 result。
    }
    if (!parsed?.versionId) {
      return makeFailure('CONFLICT', 'Recorded artifact revision result is no longer available');
    }
    return makeSuccess({ revision: parsed, replayed: true });
  }
  return makeSuccess({ revision: result.saveResult, replayed: false });
}

async function projectArtifactAuthorityFacts(
  repositories: ServerNextRepositories,
  teamId: string,
  userId: string,
  profile: ChannelProjectProfileRecord,
  stage: ProjectStageRecord | null,
): Promise<ProjectArtifactAuthorityFacts> {
  return {
    userId,
    teamRole: await repositories.teams.getMemberRole(teamId, userId),
    projectLeadId: profile.projectLeadId,
    stageReviewerIds: stage?.reviewerIds ?? [],
  };
}

function projectArtifactFinalizationFailure(
  reasonCode: ProjectArtifactFinalizationRejectionCode,
): ReturnType<typeof makeFailure> {
  switch (reasonCode) {
    case 'collection_not_found':
    case 'collection_out_of_scope':
      return makeFailure('NOT_FOUND', 'Logical artifact collection not found in this Team and Channel');
    case 'version_not_in_collection':
      return makeFailure('NOT_FOUND', 'Target version does not belong to this logical artifact collection');
    case 'collection_revision_stale':
      return makeFailure('CONFLICT', 'Project artifact collection revision is stale; refresh and retry');
    case 'version_not_approved':
      return makeFailure('CONFLICT', 'Target project artifact version is not currently approved');
    case 'manager_confirmation_missing':
      return makeFailure('VALIDATION_ERROR', 'Manager finalization requires a human confirmation');
    case 'manager_confirmation_unauthorized':
      return makeFailure('FORBIDDEN', 'Manager confirmation author cannot finalize this artifact version');
    case 'actor_not_human':
    case 'actor_not_authorized':
      return makeFailure('FORBIDDEN', 'User cannot finalize this project artifact version');
  }
}

async function projectStageDto(
  repositories: ServerNextRepositories,
  facts: ProjectStageFacts,
  stageFacts: ReadonlyMap<string, ProjectStageFacts>,
  edgeRecords: readonly ProjectStageEdgeRecord[],
  piHealthy: boolean,
  now: number,
  resolveProjectStageCandidates?: CreateServerNextUseCasesInput['resolveProjectStageCandidates'],
): Promise<ChannelProjectOverviewDto['stages'][number]> {
  const { record, task } = facts;
  const inboundEdges = edgeRecords.filter((edge) => edge.downstreamStageId === record.id);
  const stableResolution = await resolveProjectStageStableInputs(repositories, task);
  const upstreamEdgeFacts = await buildProjectStageUpstreamEdgeFacts(
    repositories,
    inboundEdges,
    async (stageId) => stageFacts.get(stageId),
    stableResolution.inputs,
  );
  const gate = evaluateProjectStageExecutionGate({ upstreamEdges: upstreamEdgeFacts });
  const gateBlocks = gate.kind === 'blocked' ? gate.blocks : [];

  const dependencyRecords = await repositories.taskCoordination.dependencies.list(task.id);
  const rawDependencies = await Promise.all(dependencyRecords.map(async (dependency) => {
    const dependencyTask = await repositories.tasks.getById(dependency.dependencyTaskId);
    if (!dependencyTask || dependencyTask.teamId !== task.teamId || dependencyTask.channelId !== task.channelId) {
      throw new Error(`Task ${task.id} has an unavailable scoped dependency`);
    }
    return { taskId: dependencyTask.id, status: dependencyTask.status };
  }));
  // Stage edge 覆盖的依赖由边派生原因表达，避免同一依赖事实出现两条阻塞原因。
  const edgeCoveredTaskIds = new Set(inboundEdges
    .filter((edge) => edge.semantics === 'blocks_start')
    .map((edge) => edge.upstreamTaskId));
  const dependencies = [...rawDependencies];
  for (const edgeFacts of upstreamEdgeFacts) {
    if (edgeFacts.semantics !== 'blocks_start') continue;
    if (dependencies.some((dependency) => dependency.taskId === edgeFacts.upstreamTaskId)) continue;
    dependencies.push({
      taskId: edgeFacts.upstreamTaskId,
      status: edgeFacts.upstreamTaskStatus,
    });
  }
  const projection = projectStageTaskProjection({
    taskId: task.id,
    taskStatus: task.status,
    dependencies,
    reviewDecision: facts.reviewDecision,
  });
  const blockingReasons: ProjectStageBlockingReasonDto[] = [
    ...projection.blockingReasons.filter((reason) => reason.code !== 'dependency_incomplete'
      || !reason.dependencyTaskId
      || !edgeCoveredTaskIds.has(reason.dependencyTaskId)),
    ...gateBlocks.map((block) => ({
      code: block.code,
      taskId: task.id,
      dependencyTaskId: block.upstreamTaskId,
      edgeId: block.edgeId,
      upstreamStageId: block.upstreamStageId,
      ...(block.requiredInputKey === undefined ? {} : { requiredInputKey: block.requiredInputKey }),
    })),
  ];
  const missingRequiredInputs: ProjectStageMissingRequiredInputDto[] = [];
  for (const block of gateBlocks) {
    if (block.code !== 'required_input_missing' || block.requiredInputKey === undefined) continue;
    const edge = inboundEdges.find((candidate) => candidate.id === block.edgeId);
    const rule = edge?.requiredInputs.find((candidate) => candidate.key === block.requiredInputKey);
    if (!rule) continue;
    missingRequiredInputs.push({
      edgeId: block.edgeId,
      upstreamStageId: block.upstreamStageId,
      key: rule.key,
      kind: rule.kind,
      label: rule.label,
    });
  }
  const dependenciesSatisfied = !gateBlocks.some((block) =>
    block.code === 'stage_dependency_incomplete' || block.code === 'stage_dependency_unaccepted');
  const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
  const currentClaim = coordination
    ? await repositories.taskCoordination.claimLeases.getCurrent({
      taskId: task.id,
      taskRevision: task.revision,
      taskAttempt: coordination.attempt,
    })
    : null;
  const activeInvocation = coordination
    ? await hasActiveProjectStageInvocation(repositories, task, coordination)
    : false;
  const claimFenceCurrent = coordination
    ? (await resolveProjectStageClaimFence(repositories, {
      task,
      coordination,
      claim: currentClaim,
      stable: stableResolution,
      now,
    })).current
    : false;
  const persistedEdges = task.channelId
    ? await repositories.channelProjects.listEdges({
      teamId: task.teamId,
      channelId: task.channelId,
    })
    : [];
  const persistedMirroredDependencyIds = new Set(persistedEdges
    .filter((edge) => edge.downstreamTaskId === task.id && edge.mirroredTaskDependency)
    .map((edge) => edge.upstreamTaskId));
  const expectedDependencyTaskIds = [
    ...dependencyRecords
      .map((dependency) => dependency.dependencyTaskId)
      .filter((dependencyTaskId) => !persistedMirroredDependencyIds.has(dependencyTaskId)),
    ...edgeRecords
      .filter((edge) => edge.downstreamTaskId === task.id && edge.semantics === 'blocks_start')
      .map((edge) => edge.upstreamTaskId),
  ];
  const brokerEligibleAgentIds = coordination && resolveProjectStageCandidates
    ? (await resolveProjectStageCandidates(task.id, {
      dependencyTaskIds: [...new Set(expectedDependencyTaskIds)],
      skipProjectStageGate: true,
    })).candidates
      .filter((candidate) => candidate.eligible)
      .map((candidate) => candidate.agentId)
    : undefined;
  const candidateAgentIds = await projectStageCandidateAgentIds(
    repositories,
    task,
    coordination,
    stableResolution.inputs.some((stableInput) => stableInput.kind === 'document_revision'),
    now,
    brokerEligibleAgentIds,
  );
  const policy = await repositories.teamPiPolicy.getOrDefault(task.teamId);
  const advanceDecision = evaluateProjectStageAdvance({
    channelWritable: !(await repositories.channels.getById(record.channelId))?.archivedAt,
    piHealthy,
    autoCoordinationEnabled: policy.autoCoordinationEnabled,
    taskStatus: task.status,
    taskRevision: task.revision,
    stageTaskRevision: record.taskRevision,
    coordinationTaskRevision: coordination?.taskRevision ?? -1,
    claimStatus: currentClaim
      ? claimFenceCurrent ? 'active' : 'stale'
      : 'none',
    ...(currentClaim ? { claimedAgentId: currentClaim.agentId } : {}),
    invocationStatus: activeInvocation ? 'active' : 'none',
    executionGateAllowed: gate.kind === 'allowed',
    requiredInputCount: stableResolution.requiredRuleCount,
    stableInputCount: stableResolution.satisfiedRuleKeys.length,
    stableInputFenceCurrent: true,
    eligibleAgentIds: candidateAgentIds,
  });
  const taskDto = toTaskDto(task);
  return {
    id: record.id,
    teamId: record.teamId,
    channelId: record.channelId,
    name: record.name,
    goal: record.goal,
    ownerId: record.ownerId,
    reviewerIds: record.reviewerIds,
    acceptanceCriteria: record.acceptanceCriteria,
    task: taskDto,
    taskRevision: record.taskRevision,
    aggregateStatus: projection.aggregateStatus,
    blockingReasons,
    upstreamStageIds: inboundEdges.map((edge) => edge.upstreamStageId),
    dependenciesSatisfied,
    missingRequiredInputs,
    executionAllowed: gate.kind === 'allowed',
    advance: {
      kind: advanceDecision.kind,
      automatic: policy.autoCoordinationEnabled,
      ...('reason' in advanceDecision ? { reason: advanceDecision.reason } : {}),
      stableInputs: stableResolution.inputs,
      candidateAgentIds: 'targetAgentIds' in advanceDecision
        ? advanceDecision.targetAgentIds
        : candidateAgentIds,
      ...('targetAgentId' in advanceDecision ? { targetAgentId: advanceDecision.targetAgentId } : {}),
      taskRevision: task.revision,
      stageTaskRevision: record.taskRevision,
      ...(coordination ? { coordinationTaskRevision: coordination.taskRevision } : {}),
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function projectStageCandidateAgentIds(
  repositories: ServerNextRepositories,
  task: TaskRecord,
  coordination: Awaited<ReturnType<ServerNextRepositories['taskCoordination']['coordinations']['getByTaskId']>>,
  requiresDocumentInputSet: boolean,
  now: number,
  brokerEligibleAgentIds?: readonly string[],
): Promise<string[]> {
  if (!coordination || !task.channelId) return [];
  if (brokerEligibleAgentIds) {
    return filterStrictProjectStageAgentIds(repositories, {
      teamId: task.teamId,
      candidateAgentIds: brokerEligibleAgentIds,
      requiredCapabilities: coordination.requiredCapabilities,
      ...(requiresDocumentInputSet
        ? { requiredProjectDocumentInputSetVersion: 1 }
        : {}),
      now,
    });
  }
  const channel = await repositories.channels.getById(task.channelId);
  if (!channel || channel.archivedAt != null) return [];
  const devices = new Map((await repositories.devices.listByTeam(task.teamId))
    .map((device) => [device.id, device]));
  const eligible: string[] = [];
  for (const agent of await repositories.agents.listAll()) {
    if (!agent.visibleTeamIds.includes(task.teamId)
      || agent.deletedAt !== undefined
      || agent.status !== 'online'
      || !agent.deviceId
      || (channel.dmTargetAgentId !== agent.id && !channel.agentMemberIds.includes(agent.id))) {
      continue;
    }
    const device = devices.get(agent.deviceId);
    if (!device || device.status !== 'online') continue;
    if (requiresDocumentInputSet
      && (!agent.projectDocumentInputSetVersions?.includes(1)
        || !device.capabilities?.projectDocumentInputSetVersions?.includes(1))) {
      continue;
    }
    const manifest = await repositories.agentExposure.manifests
      .getActiveByTeamAgent(task.teamId, agent.id);
    const capabilities = new Set((manifest?.capabilities ?? agent.skills ?? [])
      .map((capability) => capability.name.toLowerCase()));
    if (coordination.requiredCapabilities
      .some((required) => !capabilities.has(required.toLowerCase()))) continue;
    if (coordination.claimPolicy === 'targeted' && task.assigneeId !== agent.id) continue;
    eligible.push(agent.id);
  }
  return filterStrictProjectStageAgentIds(repositories, {
    teamId: task.teamId,
    candidateAgentIds: eligible,
    requiredCapabilities: coordination.requiredCapabilities,
    now,
  });
}

async function taskIsBoundToProjectStage(
  repositories: ServerNextRepositories,
  task: TaskRecord,
): Promise<boolean> {
  if (!task.channelId) return false;
  const stages = await repositories.channelProjects.listStages({
    teamId: task.teamId,
    channelId: task.channelId,
  });
  return stages.some((stage) => stage.taskId === task.id);
}

/**
 * #946：Agent 被移出 channel 后，撤销其在 Task 协调域的执行权（同事务调用）。
 * - 释放该 agent 在本 team 的 active claim lease：listActive 仅返回 active lease，
 *   update 的 CAS（expectedStatus='active'）保证仅释放 active、已终态（released/expired/
 *   invalid）幂等跳过且绝不重写 releasedAt——与 domain evaluateAuthorityRevocation 的
 *   inspectTaskClaim 守护等价（application lease 缺 domain 的 renewedAt，故就地用 CAS）。
 * - 撤销其名下所有 active execution grant（authority-revoked）。
 */
async function revokeAgentChannelMembershipAuthority(
  coordination: TaskCoordinationRepositories,
  teamId: string,
  agentId: string,
  now: number,
): Promise<void> {
  const leases = (await coordination.claimLeases.listActive())
    .filter((lease) => lease.teamId === teamId && lease.agentId === agentId);
  for (const lease of leases) {
    await coordination.claimLeases.update({
      id: lease.id,
      expectedStatus: 'active',
      status: 'released',
      heartbeatAt: lease.heartbeatAt,
      expiresAt: lease.expiresAt,
      releasedAt: now,
    });
  }
  const grants = await coordination.executionGrants.listActiveByAgent({ teamId, agentId });
  for (const grant of grants) {
    await coordination.executionGrants.revoke({
      id: grant.id, reason: 'authority-revoked', revokedAt: now, now,
    });
  }
}

async function channelForCreatorManagement(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; channelId: string },
): Promise<Ack<{ channel: ChannelDto & { humanMemberIds: string[]; agentMemberIds: string[] } }>> {
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) {
    return makeFailure('NOT_FOUND', 'Channel not found');
  }
  if (!canApplyChannelUpdate(channel, input.userId, { humanMemberIds: channel.humanMemberIds })) {
    return makeFailure('FORBIDDEN', 'User cannot manage channel');
  }
  return makeSuccess({ channel });
}

function normalizeWorkspacePath(value: string): string | null {
  const path = value.trim().replaceAll('\\', '/');
  if (!path || path.startsWith('/') || /^[a-zA-Z]:/.test(path) || /[\u0000-\u001f\u007f]/.test(path)
    || path.split('/').some((part) => part === '' || part === '.' || part === '..')) return null;
  return path;
}

async function ensureUserCanViewProjectWorkspace(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; channelId: string },
): Promise<Ack<{ channel: ChannelRecord }>> {
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) return makeFailure('FORBIDDEN', 'User is not a team member');
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) return makeFailure('NOT_FOUND', 'Channel not found');
  if (channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
  if (channel.visibility === 'private' && !channel.humanMemberIds.includes(input.userId)) return makeFailure('FORBIDDEN', 'User cannot view channel');
  return makeSuccess({ channel });
}

/**
 * #1053：device snapshot 端点的频道访问判定。owner 是目标 Team 成员时维持原有
 * 人类可见性校验（含私有频道 human membership）；owner 不是目标 Team 成员时
 * （跨 Team 可见 Agent 合法执行），人类在目标 Team 没有可见性立场，频道访问由
 * 调用点的 Agent 授权（visibleTeamIds + channel agentMemberIds + device 绑定）
 * 承担，这里只校验频道存在、归属目标 Team 且不是 DM/all 内置频道。
 */
async function ensureSnapshotChannelAccess(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; channelId: string },
): Promise<Ack<{ channel: ChannelRecord }>> {
  if (await repositories.teams.isMember(input.teamId, input.userId)) {
    return ensureUserCanViewProjectWorkspace(repositories, input);
  }
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) return makeFailure('NOT_FOUND', 'Channel not found');
  if (channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
  return makeSuccess({ channel });
}

/**
 * #1056：workspace publish staging 的频道访问判定。owner 是目标 Team 成员时维持
 * 原有人类可见性校验；不是成员时仅接受真实 device 身份——deviceActorToken 用
 * sessionSecret 重新验签（HTTP/socket 客户端无法伪造该标记绕过成员检查），
 * 频道访问再由调用链上的 Agent 授权承担（begin：ensureWorkspacePublishProvenanceAuthority
 * 复验 device↔agent 绑定 + visibleTeamIds + membership；put/get/commit：ForDevice
 * wrapper 已复验 staging.provenance）。无 token 或验签失败维持原有 FORBIDDEN。
 */
async function ensureWorkspacePublishChannelAccess(
  repositories: ServerNextRepositories,
  sessionSecret: string,
  input: { userId: string; teamId: string; channelId: string; deviceActorToken?: string },
): Promise<Ack<{ channel: ChannelRecord }>> {
  if (await repositories.teams.isMember(input.teamId, input.userId)) {
    return ensureUserCanViewProjectWorkspace(repositories, input);
  }
  if (!input.deviceActorToken) return makeFailure('FORBIDDEN', 'User is not a team member');
  const actor = await resolveHostedDeviceTokenActor(repositories, sessionSecret, { token: input.deviceActorToken });
  if (!actor.ok) return makeFailure('FORBIDDEN', 'User is not a team member');
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) return makeFailure('NOT_FOUND', 'Channel not found');
  if (channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
  return makeSuccess({ channel });
}

/**
 * #1044 publish provenance 的 Agent/Task authority 复验。
 * begin(fail-fast)与 commit(权威,物化任何 artifact 之前)都要过这一关:
 * 离线期间发生的 Agent 解绑/删除、Device 换绑或 Task 跨频道漂移必须阻止过期提交,
 * 且不得在 Workspace 里留下部分 revision。
 * 无 provenance 的 staging(纯用户手工发布)不做 Agent/Task 校验。
 * taskId 可能是 daemon 合成 fallback(dispatch.id),只在命中真实 Task 记录时校验归属。
 * #1056：与 snapshot 授权（#1053）同一模型——不再要求 primaryTeamId === 目标 Team，
 * 跨 Team 可见 Agent 凭 visibleTeamIds + Channel membership + device 绑定发布。
 */
async function ensureWorkspacePublishProvenanceAuthority(
  repositories: ServerNextRepositories,
  input: {
    teamId: ID;
    channel: ChannelRecord;
    provenance?: { agentId: ID; taskId: ID; taskAttempt: number; workspaceRunId?: ID; deviceId?: ID };
    deviceId?: ID;
  },
): Promise<Ack<{ ok: true }>> {
  const provenance = input.provenance;
  if (!provenance) return makeSuccess({ ok: true });
  const agent = await repositories.agents.getById(provenance.agentId);
  if (!agent
    || !agent.visibleTeamIds.includes(input.teamId)
    || !input.channel.agentMemberIds.includes(agent.id)
    || (input.deviceId !== undefined && agent.deviceId !== input.deviceId)
    || (provenance.deviceId !== undefined && agent.deviceId !== provenance.deviceId)) {
    return makeFailure('FORBIDDEN', 'Publish Agent authority was revoked', { reason: 'agent-authority-revoked' });
  }
  const task = await repositories.tasks.getById(provenance.taskId);
  if (task && (task.teamId !== input.teamId
    || (task.channelId != null && task.channelId !== input.channel.id))) {
    return makeFailure('FORBIDDEN', 'Publish Task authority does not match this channel', { reason: 'task-authority-mismatch' });
  }
  return makeSuccess({ ok: true });
}

/**
 * #1056：跨 Team device publish 的 staging provenance 预检。put/get/commit 的
 * ForDevice wrapper 在委托前调用——staging 无 provenance（纯用户手工发布）时对跨
 * Team device fail closed；有 provenance 时复验 Agent 授权（device 绑定 +
 * visibleTeamIds + Channel membership + Task 归属）。
 */
async function ensureCrossTeamStagingAuthority(
  repositories: ServerNextRepositories,
  input: { teamId: string; channelId: string; publishId: string; deviceId?: string },
): Promise<Ack<{ ok: true }>> {
  const publishId = normalizeWorkspacePublishId(input.publishId);
  if (!publishId) return makeFailure('VALIDATION_ERROR', 'Invalid publish identity');
  const staging = await repositories.workspacePublishStagings.getByPublishId({
    teamId: input.teamId,
    publishId,
  });
  if (!staging || staging.channelId !== input.channelId) {
    return makeFailure('NOT_FOUND', 'Workspace publish staging not found');
  }
  if (!staging.provenance) {
    return makeFailure('FORBIDDEN', 'Cross-team device publish requires agent provenance');
  }
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) return makeFailure('NOT_FOUND', 'Channel not found');
  return ensureWorkspacePublishProvenanceAuthority(repositories, {
    teamId: input.teamId,
    channel,
    provenance: staging.provenance,
    ...(input.deviceId ? { deviceId: input.deviceId } : {}),
  });
}

/**
 * #1056：跨 Team device 调用的逐 Agent 授权（codex P1：同一 Device 托管多 Agent
 * 时，按设备上任意 Agent 放行会形成跨 Agent 的频道权限旁路——必须验证本次声明
 * 的执行 Agent 本人的 device 绑定 + visibleTeamIds + Channel membership）。
 */
async function ensureCrossTeamDeviceAgentAuthority(
  repositories: ServerNextRepositories,
  input: { agentId: string | undefined; deviceId: string | undefined; teamId: string; channel: ChannelRecord },
): Promise<Ack<{ ok: true }>> {
  if (!input.agentId) {
    return makeFailure('FORBIDDEN', 'Cross-team device access requires the executing Agent identity');
  }
  if (!input.deviceId) {
    return makeFailure('UNAUTHENTICATED', 'Device credentials do not identify a device');
  }
  const agent = await repositories.agents.getById(input.agentId);
  if (!agent
    || agent.deviceId !== input.deviceId
    || !agent.visibleTeamIds.includes(input.teamId)
    || !input.channel.agentMemberIds.includes(agent.id)) {
    return makeFailure('FORBIDDEN', 'Device is not authorized for this Agent');
  }
  return makeSuccess({ ok: true });
}

/**
 * Resolve a workspace to a specific revision, or its current revision when `revisionId`
 * is omitted / matches current. Shared by read (#962) and materialize (#968) use cases.
 */
async function resolveProjectChannelWorkspaceRevision(
  repositories: ServerNextRepositories,
  workspace: ProjectChannelWorkspaceRecord,
  revisionId?: string,
): Promise<Ack<{ workspace: ProjectChannelWorkspaceRecord }>> {
  if (!revisionId || revisionId === workspace.currentRevisionId) return makeSuccess({ workspace });
  const revision = await repositories.projectChannelWorkspaces.getRevision({
    teamId: workspace.teamId,
    channelId: workspace.channelId,
    revisionId,
  });
  if (!revision) return makeFailure('NOT_FOUND', 'Workspace revision not found');
  return makeSuccess({ workspace: { ...workspace, currentRevisionId: revision.id, currentRevision: revision } });
}

async function validateProjectDocumentInputSetResultProposal(input: {
  repositories: ServerNextRepositories;
  dispatch: DispatchRecord;
  managedInvocation: AgentInvocationRecordDto | null;
  proposal: ProjectDocumentInputSetResultProposalV1;
  reportedArtifactIds: readonly string[];
  inlineArtifacts?: readonly ReceiveDispatchArtifactInput[];
}): Promise<Ack<{ valid: true }>> {
  const { managedInvocation, proposal } = input;
  if (!managedInvocation
    || managedInvocation.intent.schemaVersion !== 2
    || managedInvocation.id !== proposal.invocationId
    || managedInvocation.intent.teamId !== input.dispatch.teamId
    || managedInvocation.intent.channelId !== input.dispatch.channelId
    || managedInvocation.intent.projectDocumentInputSet.id !== proposal.inputSetId) {
    return makeFailure('VALIDATION_ERROR', 'Project document InputSet result is outside its Invocation scope');
  }
  const channel = await input.repositories.channels.getById(input.dispatch.channelId);
  if (!channel || channel.teamId !== input.dispatch.teamId || channel.archivedAt != null) {
    return makeFailure('CONFLICT', 'Archived or unavailable channels reject late InputSet results');
  }
  const expectedItems = managedInvocation.intent.projectDocumentInputSet.items;
  const proposedIds = new Set(proposal.items.map((item) => item.documentId));
  if (proposal.contractVersion !== 1
    || proposal.items.length !== expectedItems.length
    || proposedIds.size !== proposal.items.length) {
    return makeFailure('VALIDATION_ERROR', 'Project document InputSet result must cover each manifest item exactly once');
  }
  const reportedArtifacts = new Set(input.reportedArtifactIds);
  for (const item of proposal.items) {
    const expected = expectedItems.find((candidate) => candidate.documentId === item.documentId);
    if (!expected || expected.baseRevisionId !== item.baseRevisionId) {
      return makeFailure('VALIDATION_ERROR', 'Project document InputSet result identity does not match the manifest');
    }
    if (item.status === 'unchanged') {
      if (item.sha256 !== expected.sha256 || 'artifactId' in item || 'error' in item) {
        return makeFailure('VALIDATION_ERROR', 'Unchanged InputSet result has an invalid digest or Artifact');
      }
      continue;
    }
    if (item.status === 'changed') {
      if (!item.sha256 || item.sha256 === expected.sha256
        || !item.artifactId || !reportedArtifacts.has(item.artifactId)) {
        return makeFailure('VALIDATION_ERROR', 'Changed InputSet result requires a newly reported Artifact and digest');
      }
      const artifact = await input.repositories.artifacts.getForTeam({
        teamId: input.dispatch.teamId,
        artifactId: item.artifactId,
      });
      const inlineArtifact = input.inlineArtifacts?.find((candidate) => candidate.id === item.artifactId);
      const artifactIsUnbound = artifact
        && !artifact.messageId
        && !artifact.dispatchId
        && !artifact.workspaceRunId;
      const artifactBelongsToDispatch = artifact?.dispatchId === input.dispatch.id;
      // Prefer bytes already on disk; for pure-inline payloads the proposal digest must match
      // the actual content hash, otherwise resolveDispatchArtifactContent would later rewrite
      // sha256 while commit still trusts item.sha256.
      let contentSha256: string | undefined;
      if (!artifact && inlineArtifact?.contentBase64 !== undefined) {
        if (!isBase64Like(inlineArtifact.contentBase64)) {
          return makeFailure('VALIDATION_ERROR', 'Changed InputSet result Artifact is unavailable or invalid');
        }
        const content = Buffer.from(inlineArtifact.contentBase64, 'base64');
        if (content.length > DISPATCH_INLINE_ARTIFACT_CONTENT_MAX_BYTES) {
          return makeFailure('VALIDATION_ERROR', 'Changed InputSet result Artifact is unavailable or invalid');
        }
        contentSha256 = createHash('sha256').update(content).digest('hex');
        if (contentSha256 !== item.sha256
          || (inlineArtifact.sha256 != null && inlineArtifact.sha256 !== contentSha256)
          || (inlineArtifact.sizeBytes != null && inlineArtifact.sizeBytes !== content.byteLength)) {
          return makeFailure('VALIDATION_ERROR', 'Changed InputSet result Artifact is unavailable or invalid');
        }
      }
      const candidate = artifact ?? inlineArtifact;
      const candidateSha256 = artifact?.sha256 ?? contentSha256 ?? inlineArtifact?.sha256;
      if (!artifact
        && !inlineArtifact) {
        return makeFailure('VALIDATION_ERROR', 'Changed InputSet result Artifact is unavailable or invalid');
      }
      if (!candidate
        || (artifact && artifact.channelId !== input.dispatch.channelId)
        || candidateSha256 !== item.sha256
        || !isMarkdownArtifact({ ...candidate, mimeType: candidate.mimeType ?? 'application/octet-stream' })
        || candidate.role !== 'intermediate'
        || candidate.sourceRoot?.kind !== 'configured_output'
        || candidate.sourceRoot.id !== `project-document-input-set:${proposal.inputSetId}`
        || (artifact && !artifactIsUnbound && !artifactBelongsToDispatch)) {
        return makeFailure('VALIDATION_ERROR', 'Changed InputSet result Artifact is unavailable or invalid');
      }
      continue;
    }
    if (!item.error || 'artifactId' in item) {
      return makeFailure('VALIDATION_ERROR', 'Failed InputSet result requires an error and cannot commit an Artifact');
    }
  }
  return makeSuccess({ valid: true });
}

async function commitProjectDocumentInputSetResults(input: {
  repositories: ServerNextRepositories;
  ids: ServerNextIds;
  now: number;
  agentId: string;
  dispatch: DispatchRecord;
  invocation: AgentInvocationRecordDto;
  proposal: ProjectDocumentInputSetResultProposalV1;
  committedArtifacts: readonly ArtifactRecord[];
  workspaceRunId?: string;
}): Promise<ProjectDocumentInputSetResultDto> {
  if (input.invocation.intent.schemaVersion !== 2) {
    throw new Error('Project document InputSet result requires Invocation V2');
  }
  const requestFingerprint = projectDocumentInputSetProposalFingerprint(input.proposal);
  const expectedItems = input.invocation.intent.projectDocumentInputSet.items;
  const results: ProjectDocumentInputSetItemResultRecord[] = [];
  const record = async (
    item: ProjectDocumentInputSetResultProposalV1['items'][number],
    facts: Pick<ProjectDocumentInputSetItemResultRecord, 'status' | 'artifactId' | 'revisionId' | 'error'>,
  ): Promise<void> => {
    const result: ProjectDocumentInputSetItemResultRecord = {
      inputSetId: input.proposal.inputSetId,
      invocationId: input.proposal.invocationId,
      agentId: input.agentId,
      ...(input.workspaceRunId ? { workspaceRunId: input.workspaceRunId } : {}),
      teamId: input.dispatch.teamId,
      channelId: input.dispatch.channelId,
      documentId: item.documentId,
      baseRevisionId: item.baseRevisionId,
      status: facts.status,
      ...(facts.artifactId ? { artifactId: facts.artifactId } : {}),
      ...(facts.revisionId ? { revisionId: facts.revisionId } : {}),
      ...(facts.error ? { error: facts.error } : {}),
      requestFingerprint,
      createdAt: input.now,
    };
    const stored = await input.repositories.projectDocumentInputSetResults.record(result);
    if (stored.kind === 'idempotency_conflict') {
      throw new Error('PROJECT_DOCUMENT_INPUT_SET_RESULT_IDEMPOTENCY_CONFLICT');
    }
    results.push(stored.result);
  };

  for (const item of input.proposal.items) {
    const expected = expectedItems.find((candidate) => candidate.documentId === item.documentId)!;
    if (item.status === 'unchanged') {
      await record(item, { status: 'unchanged' });
      continue;
    }
    if (item.status === 'failed') {
      await record(item, { status: 'failed', error: item.error });
      continue;
    }
    const artifact = input.committedArtifacts.find((candidate) => candidate.id === item.artifactId);
    if (!artifact) {
      await record(item, { status: 'failed', error: 'PROJECT_DOCUMENT_RESULT_ARTIFACT_NOT_COMMITTED' });
      continue;
    }
    // Authoritative store digest wins: reject proposals whose claimed sha256 no longer matches
    // the Artifact that was actually persisted (covers forged inline metadata and rewrite races).
    if (artifact.sha256 && artifact.sha256 !== item.sha256) {
      await record(item, {
        status: 'failed',
        artifactId: artifact.id,
        error: 'PROJECT_DOCUMENT_RESULT_ARTIFACT_DIGEST_MISMATCH',
      });
      continue;
    }
    const normalizedRelativePath = artifact.relativePath
      ? normalizeRootRelativePath(artifact.relativePath)
      : null;
    if (!input.workspaceRunId
      || artifact.workspaceRunId !== input.workspaceRunId
      || !artifact.sourceRoot
      || !artifact.relativePath
      || !normalizedRelativePath) {
      await record(item, {
        status: 'failed',
        artifactId: artifact.id,
        error: 'PROJECT_DOCUMENT_RESULT_SOURCE_UNAVAILABLE',
      });
      continue;
    }
    const document = await input.repositories.channelDocuments.getForTeam({
      teamId: input.dispatch.teamId,
      channelId: input.dispatch.channelId,
      documentId: expected.documentId,
    });
    if (!document) {
      await record(item, {
        status: 'failed',
        artifactId: artifact.id,
        error: 'PROJECT_DOCUMENT_RESULT_DOCUMENT_UNAVAILABLE',
      });
      continue;
    }
    const revisions = await input.repositories.channelDocuments.listRevisions({
      documentId: document.id,
    });
    const recoveredRevision = revisions.find((revision) =>
      revision.artifact.id === artifact.id
      && revision.createdBy === input.agentId
      && revision.source === 'run'
      && document.currentRevisionId === revision.id);
    if (recoveredRevision) {
      await record(item, {
        status: 'committed',
        artifactId: artifact.id,
        revisionId: recoveredRevision.id,
      });
      continue;
    }
    if (document.currentRevisionId !== expected.baseRevisionId) {
      await record(item, {
        status: 'conflict',
        artifactId: artifact.id,
        error: 'PROJECT_DOCUMENT_RESULT_BASE_REVISION_STALE',
      });
      continue;
    }
    const latest = revisions[0];
    const fileSource = await channelFileSource(input.repositories, artifact);
    const derivationSource: ChannelDocumentSourceDto = {
      ...(fileSource?.messageId ? { messageId: fileSource.messageId } : {}),
      ...(fileSource?.threadId ? { threadId: fileSource.threadId } : {}),
      ...(fileSource?.taskId ? { taskId: fileSource.taskId } : {}),
      workspaceRunId: input.workspaceRunId,
      agentId: input.agentId,
      messageCreatedAt: fileSource?.messageCreatedAt ?? input.now,
      sourceRoot: artifact.sourceRoot,
      relativePath: artifact.relativePath,
      normalizedRelativePath,
      artifactId: artifact.id,
      artifactRole: artifact.role ?? 'intermediate',
    };
    const revision: ChannelDocumentRevisionRecord = {
      id: input.ids.nextId(),
      documentId: document.id,
      artifact,
      revision: (latest?.revision ?? expected.revisionNumber) + 1,
      createdBy: input.agentId,
      createdAt: input.now,
      source: 'run',
      derivationSource,
      published: false,
    };
    const committed = await input.repositories.channelDocuments.addRevision({
      documentId: document.id,
      expectedCurrentRevisionId: expected.baseRevisionId,
      document: {
        ...document,
        filename: sanitizeMarkdownFilename(artifact.filename),
        currentRevisionId: revision.id,
        updatedAt: input.now,
      },
      revision,
      artifact,
      operation: {
        documentId: document.id,
        idempotencyKey: `input-set-result:${input.proposal.inputSetId}:${document.id}`,
        operationType: 'save',
        requestFingerprint: createHash('sha256').update(JSON.stringify({
          inputSetId: input.proposal.inputSetId,
          invocationId: input.proposal.invocationId,
          documentId: document.id,
          baseRevisionId: expected.baseRevisionId,
          artifactId: artifact.id,
          sha256: item.sha256,
        })).digest('hex'),
        revisionId: revision.id,
      },
    });
    if (!committed) {
      await record(item, {
        status: 'conflict',
        artifactId: artifact.id,
        error: 'PROJECT_DOCUMENT_RESULT_BASE_REVISION_STALE',
      });
      continue;
    }
    await record(item, {
      status: 'committed',
      artifactId: artifact.id,
      revisionId: committed.revision.id,
    });
  }
  return toProjectDocumentInputSetResultDto(
    input.proposal.inputSetId,
    input.proposal.invocationId,
    results,
  );
}

async function isProjectDocumentInputSetResultAttemptStale(input: {
  repositories: ServerNextRepositories;
  invocation: AgentInvocationRecordDto;
  dispatch: DispatchRecord;
  agentId: string;
}): Promise<boolean> {
  const taskContext = input.invocation.intent.taskContext;
  const dispatchAttempt = await input.repositories.management.dispatchAttempts.getByDispatchId(
    input.dispatch.id,
  );
  const invocationAttempts = await input.repositories.management.dispatchAttempts.list(
    input.invocation.id,
  );
  const latestAttemptNumber = invocationAttempts.reduce(
    (latest, attempt) => Math.max(latest, attempt.attemptNumber),
    0,
  );
  if (!dispatchAttempt || dispatchAttempt.attemptNumber !== latestAttemptNumber) {
    return true;
  }
  if (!taskContext) return false;
  const [task, currentClaim] = await Promise.all([
    input.repositories.tasks.getById(taskContext.taskId),
    input.repositories.taskCoordination.claimLeases.getCurrent({
      taskId: taskContext.taskId,
      taskRevision: taskContext.taskRevision,
      taskAttempt: taskContext.taskAttempt,
    }),
  ]);
  return !task
    || task.teamId !== input.dispatch.teamId
    || task.channelId !== input.dispatch.channelId
    || task.revision !== taskContext.taskRevision
    || !currentClaim
    || currentClaim.id !== taskContext.claimLeaseId
    || currentClaim.agentId !== input.agentId
    || currentClaim.status !== 'active';
}

function projectDocumentInputSetProposalFingerprint(
  proposal: ProjectDocumentInputSetResultProposalV1,
): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex');
}

function toProjectDocumentInputSetResultDto(
  inputSetId: string,
  invocationId: string,
  records: readonly ProjectDocumentInputSetItemResultRecord[],
): ProjectDocumentInputSetResultDto {
  const items: ProjectDocumentInputSetItemResultDto[] = records.map((record) => {
    const base = {
      documentId: record.documentId,
      baseRevisionId: record.baseRevisionId,
      createdAt: record.createdAt,
    };
    if (record.status === 'unchanged') return { ...base, status: 'unchanged' };
    if (record.status === 'committed' && record.artifactId && record.revisionId) {
      return {
        ...base,
        status: 'committed',
        artifactId: record.artifactId,
        revisionId: record.revisionId,
      };
    }
    if (record.status === 'conflict' && record.artifactId && record.error) {
      return {
        ...base,
        status: 'conflict',
        artifactId: record.artifactId,
        error: record.error,
      };
    }
    if (record.status === 'failed' && record.error) {
      return {
        ...base,
        status: 'failed',
        ...(record.artifactId ? { artifactId: record.artifactId } : {}),
        error: record.error,
      };
    }
    throw new Error(`Invalid persisted Project document InputSet result: ${record.status}`);
  });
  const first = records[0];
  if (!first) throw new Error('Project document InputSet result is empty');
  const source = {
    agentId: first.agentId,
    ...(first.workspaceRunId ? { workspaceRunId: first.workspaceRunId } : {}),
  };
  return { contractVersion: 1, inputSetId, invocationId, source, items };
}

type ChannelFileCursor = { createdAt: number; id: string };

async function commitChannelDocumentRevision(input: {
  repositories: ServerNextRepositories;
  artifactContentStore?: ArtifactContentStore;
  clock: ServerNextClock;
  ids: ServerNextIds;
  document: ChannelDocumentRecord;
  input: SaveChannelDocumentInput | RestoreChannelDocumentInput;
  operationType: 'save' | 'restore' | 'publish';
  source: ChannelDocumentRevisionDto['source'];
  sourceRevision?: ChannelDocumentRevisionRecord;
}): Promise<Ack<ChannelDocumentResultDto & { message?: MessageDto }>> {
  const {
    repositories,
    artifactContentStore,
    clock,
    ids,
    document,
    operationType,
    source,
    sourceRevision,
  } = input;
  const documentInput = input.input;
  const latestRevision = (await repositories.channelDocuments.listRevisions({ documentId: document.id }))[0];
  let contentInput = 'content' in documentInput ? documentInput.content : undefined;
  const derivationSource = sourceRevision?.derivationSource ?? latestRevision?.derivationSource;
  let resources = sourceRevision?.resources ?? latestRevision?.resources;
  if (contentInput !== undefined && derivationSource) {
    const sourceArtifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
      teamId: documentInput.teamId,
      channelId: documentInput.channelId,
      runId: derivationSource.workspaceRunId,
    });
    const pinned = pinChannelDocumentResources(contentInput, derivationSource, sourceArtifacts);
    if (!pinned.ok) return makeFailure('VALIDATION_ERROR', pinned.message);
    contentInput = pinned.content;
    resources = pinned.resources;
  }
  if (contentInput !== undefined) {
    const bytes = Buffer.byteLength(contentInput, 'utf8');
    if (bytes > 2 * 1024 * 1024) {
      return makeFailure('VALIDATION_ERROR', 'Markdown content exceeds the 2 MB editing limit');
    }
    if (/<script\b/i.test(contentInput) || /(?:javascript|vbscript|data):/i.test(contentInput)) {
      return makeFailure('VALIDATION_ERROR', 'Markdown contains unsafe HTML or URL protocol');
    }
  }
  const filename = sanitizeMarkdownFilename(
    ('filename' in documentInput ? documentInput.filename : undefined)
      ?? sourceRevision?.artifact.filename
      ?? document.filename,
  );
  const requestFingerprint = channelDocumentOperationFingerprint({
    operationType,
    baseRevisionId: documentInput.baseRevisionId,
    filename,
    content: contentInput,
    sourceRevisionId: sourceRevision?.id,
  });
  const idempotencyKey = documentInput.idempotencyKey?.trim()
    || `legacy:${documentInput.userId}:${requestFingerprint}`;
  const replay = await repositories.channelDocuments.getRevisionByIdempotencyKey({
    documentId: document.id,
    idempotencyKey,
  });
  if (replay) {
    if (replay.operation.operationType !== operationType
      || replay.operation.requestFingerprint !== requestFingerprint) {
      return makeFailure('VALIDATION_ERROR', 'Idempotency key was already used for a different document operation');
    }
    const message = replay.revision.publication
      ? await repositories.messages.getById(replay.revision.publication.messageId)
      : null;
    return makeSuccess({
      document: toCommittedChannelDocumentDto(replay.document, replay.revision),
      ...(message ? { message } : {}),
    });
  }
  if (document.currentRevisionId !== documentInput.baseRevisionId) {
    return makeFailure('CONFLICT', 'Document has changed; reload before saving');
  }

  const artifactId = ids.nextId();
  const now = clock.now();
  let stored: ArtifactContentStoreWriteResult | undefined;
  if (sourceRevision) {
    if (artifactContentStore && sourceRevision.artifact.storagePath && !artifactContentStore.copyContent) {
      return makeFailure('INTERNAL_ERROR', 'Artifact content store cannot restore document revisions');
    }
    stored = artifactContentStore?.copyContent
      ? await artifactContentStore.copyContent({
          teamId: documentInput.teamId,
          sourceArtifactId: sourceRevision.artifact.id,
          sourceStoragePath: sourceRevision.artifact.storagePath,
          artifactId,
          filename,
        })
      : undefined;
  } else if (contentInput !== undefined) {
    stored = artifactContentStore
      ? await artifactContentStore.writeContent({
          teamId: documentInput.teamId,
          artifactId,
          filename,
          content: Buffer.from(contentInput, 'utf8'),
        })
      : undefined;
  }
  const revisionId = ids.nextId();
  const publicationId = operationType === 'publish' ? ids.nextId() : undefined;
  const messageId = operationType === 'publish' ? ids.nextId() : undefined;
  const artifact: ArtifactRecord = {
    id: artifactId,
    teamId: document.teamId,
    channelId: document.channelId,
    ...(messageId ? { messageId } : {}),
    uploaderId: documentInput.userId,
    filename,
    mimeType: 'text/markdown',
    sizeBytes: stored?.sizeBytes
      ?? (contentInput !== undefined ? Buffer.byteLength(contentInput, 'utf8') : sourceRevision?.artifact.sizeBytes ?? 0),
    pathKind: 'upload',
    createdAt: now,
    ...(stored ? { storagePath: stored.storagePath, sha256: stored.sha256 } : {}),
  };
  const publication = publicationId && messageId
    ? { id: publicationId, messageId, publishedBy: documentInput.userId, publishedAt: now }
    : undefined;
  const revision: ChannelDocumentRevisionRecord = {
    id: revisionId,
    documentId: document.id,
    artifact,
    revision: (latestRevision?.revision ?? 0) + 1,
    createdBy: documentInput.userId,
    createdAt: now,
    source,
    ...(derivationSource ? { derivationSource } : {}),
    ...(resources ? { resources } : {}),
    ...(sourceRevision ? { restoredFromRevisionId: sourceRevision.id } : {}),
    published: Boolean(publication),
    ...(publication ? { publication } : {}),
  };
  const next: ChannelDocumentRecord = {
    ...document,
    filename,
    currentRevisionId: revision.id,
    updatedAt: now,
  };
  const message: MessageRecord | undefined = messageId
    ? {
        id: messageId,
        teamId: document.teamId,
        channelId: document.channelId,
        threadId: messageId,
        senderKind: 'human',
        senderId: documentInput.userId,
        body: `分享了文档 ${filename}（版本 ${revision.revision}）`,
        createdAt: now,
        meta: {
          artifactIds: [artifact.id],
          channelDocumentId: document.id,
          channelDocumentRevisionId: revision.id,
        },
      }
    : undefined;
  const operation = {
    documentId: document.id,
    idempotencyKey,
    operationType,
    requestFingerprint,
    revisionId: revision.id,
  } as const;
  const committed = await repositories.channelDocuments.addRevision({
    documentId: document.id,
    expectedCurrentRevisionId: documentInput.baseRevisionId,
    document: next,
    revision,
    artifact,
    operation,
    ...(message ? { message } : {}),
  });
  if (!committed) {
    await artifactContentStore?.deleteContent?.({ teamId: documentInput.teamId, artifactId });
    return makeFailure('CONFLICT', 'Document has changed; reload before saving');
  }
  if (committed.replayed) {
    await artifactContentStore?.deleteContent?.({ teamId: documentInput.teamId, artifactId });
    if (committed.operation.operationType !== operationType
      || committed.operation.requestFingerprint !== requestFingerprint) {
      return makeFailure('VALIDATION_ERROR', 'Idempotency key was already used for a different document operation');
    }
  }
  const committedMessage = committed.revision.publication
    ? await repositories.messages.getById(committed.revision.publication.messageId)
    : null;
  return makeSuccess({
    document: toCommittedChannelDocumentDto(committed.document, committed.revision),
    ...(committedMessage ? { message: committedMessage } : {}),
  });
}

function channelDocumentOperationFingerprint(input: {
  operationType: 'save' | 'restore' | 'publish';
  baseRevisionId: string;
  filename: string;
  content?: string;
  sourceRevisionId?: string;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function toCommittedChannelDocumentDto(
  document: ChannelDocumentRecord,
  revision: ChannelDocumentRevisionRecord,
): ChannelDocumentDto {
  return {
    ...document,
    filename: revision.artifact.filename,
    currentRevisionId: revision.id,
    updatedAt: revision.createdAt,
    currentRevision: toChannelDocumentRevisionDto(revision),
  };
}

async function getOrCreateChannelDocument(
  repositories: Pick<ServerNextRepositories, 'artifacts' | 'channelDocuments' | 'messages'>,
  input: { teamId: string; channelId: string; documentId: string },
  options: { createIfMissing: boolean } = { createIfMissing: true },
): Promise<ChannelDocumentRecord | null> {
  const existing = await repositories.channelDocuments.getForTeam(input);
  if (existing) return existing;
  if (!options.createIfMissing) return null;
  const prefix = 'channel-document:';
  if (!input.documentId.startsWith(prefix)) return null;
  const artifactId = input.documentId.slice(prefix.length);
  if (!artifactId) return null;
  const artifact = await repositories.artifacts.getForTeam({ teamId: input.teamId, artifactId });
  if (!artifact || artifact.channelId !== input.channelId || artifact.workspaceRunId) return null;
  const role = artifact.role ?? (artifact.messageId ? 'attachment' : 'run_output');
  if (role === 'attachment' && artifact.messageId) {
    const sourceMessage = await repositories.messages.getById(artifact.messageId);
    if (!sourceMessage
      || sourceMessage.channelId !== artifact.channelId
      || isDeletedMessage(sourceMessage)) {
      return null;
    }
  }
  await createInitialChannelDocument(repositories, artifact, artifact.uploaderId, artifact.createdAt);
  return repositories.channelDocuments.getForTeam(input);
}

async function toChannelDocumentDto(
  repositories: ServerNextRepositories,
  document: ChannelDocumentRecord,
): Promise<ChannelDocumentDto> {
  const revisions = await repositories.channelDocuments.listRevisions({ documentId: document.id });
  const current = revisions.find((revision) => revision.id === document.currentRevisionId) ?? revisions[0];
  if (!current) throw new Error('Channel document has no current revision');
  return { ...document, currentRevision: toChannelDocumentRevisionDto(current) };
}

function toChannelDocumentRevisionDto(revision: ChannelDocumentRevisionRecord): ChannelDocumentRevisionDto {
  return {
    ...revision,
    source: revision.source ?? channelDocumentInitialRevisionSource(revision.artifact),
    published: revision.published ?? Boolean(revision.publication),
    artifact: toArtifactDto(revision.artifact),
  };
}

function pinChannelDocumentResources(
  content: string,
  source: ChannelDocumentSourceDto,
  artifacts: ArtifactRecord[],
): { ok: true; content: string; resources: ChannelDocumentResourceBindingDto[] } | { ok: false; message: string } {
  const candidates = new Map<string, ArtifactRecord>();
  const candidatesById = new Map<string, ArtifactRecord>();
  for (const artifact of artifacts) {
    if (artifact.sourceRoot?.id !== source.sourceRoot.id
      || artifact.sourceRoot.kind !== source.sourceRoot.kind
      || !artifact.relativePath) continue;
    const normalized = normalizeRootRelativePath(artifact.relativePath);
    const existing = normalized ? candidates.get(normalized) : undefined;
    if (normalized && (!existing
      || artifact.createdAt > existing.createdAt
      || (artifact.createdAt === existing.createdAt && artifact.id.localeCompare(existing.id) > 0))) {
      candidates.set(normalized, artifact);
    }
    candidatesById.set(artifact.id, artifact);
  }
  const resources: ChannelDocumentResourceBindingDto[] = [];
  let errorMessage: string | undefined;
  const pushBindings = (binding: ChannelDocumentResourceBindingDto, count: number): boolean => {
    if (resources.length + count > 500) {
      errorMessage = 'Markdown contains more than 500 relative resource references';
      return false;
    }
    for (let index = 0; index < count; index += 1) resources.push(binding);
    return true;
  };
  const bindTarget = (rawTarget: string, image: boolean, count = 1): string | null => {
    const target = rawTarget.startsWith('<') && rawTarget.endsWith('>')
      ? rawTarget.slice(1, -1)
      : rawTarget;
    const pinnedTarget = parsePinnedArtifactTarget(target);
    if (pinnedTarget) {
      const artifact = candidatesById.get(pinnedTarget.artifactId);
      if (!artifact || artifact.teamId !== pinnedTarget.teamId || !artifact.relativePath) {
        errorMessage = `Pinned resource is outside the source Run or source root: ${rawTarget}`;
        return rawTarget;
      }
      const normalizedPath = normalizeRootRelativePath(artifact.relativePath);
      if (!normalizedPath) {
        errorMessage = `Pinned resource path is invalid: ${rawTarget}`;
        return rawTarget;
      }
      pushBindings({
        original: rawTarget,
        normalizedPath,
        kind: image ? 'image' : artifact.mimeType.startsWith('video/') ? 'video' : 'file',
        status: 'resolved',
        artifactId: artifact.id,
      }, count);
      return rawTarget;
    }
    if (target.startsWith('/api/')) {
      errorMessage = `Pinned resource URL is invalid: ${rawTarget}`;
      return rawTarget;
    }
    if (target.startsWith('artifact-missing:')) {
      const normalizedPath = decodeMissingResourcePath(target);
      if (!normalizedPath) {
        errorMessage = `Missing resource path is invalid: ${rawTarget}`;
        return rawTarget;
      }
      pushBindings({
        original: rawTarget,
        normalizedPath,
        kind: image ? 'image' : 'file',
        status: 'missing',
      }, count);
      return rawTarget;
    }
    if (!isRelativeMarkdownResource(target)) return null;
    const normalizedPath = resolveSourceRelativePath(source.normalizedRelativePath, target);
    if (!normalizedPath) {
      errorMessage = `Relative resource path escapes its source root: ${target}`;
      return rawTarget;
    }
    const artifact = candidates.get(normalizedPath);
    const kind = image ? 'image' : artifact?.mimeType.startsWith('video/') ? 'video' : 'file';
    pushBindings({
      original: target,
      normalizedPath,
      kind,
      status: artifact ? 'resolved' : 'missing',
      ...(artifact ? { artifactId: artifact.id } : {}),
    }, count);
    return artifact
      ? `/api/teams/${encodeURIComponent(artifact.teamId)}/artifacts/${encodeURIComponent(artifact.id)}/${kind === 'file' ? 'download' : 'preview'}`
      : `artifact-missing:${encodeURIComponent(normalizedPath)}`;
  };

  const referenceUsage = new Map<string, { count: number; image: boolean }>();
  const searchableContent = mapMarkdownOutsideCode(content, (text) => text, true);
  for (const match of searchableContent.matchAll(/(!?)\[([^\]]*)]\[([^\]]*)]/g)) {
    const id = (match[3] || match[2] || '').trim().toLocaleLowerCase();
    if (!id) continue;
    const usage = referenceUsage.get(id);
    referenceUsage.set(id, {
      count: (usage?.count ?? 0) + 1,
      image: Boolean(match[1]) || Boolean(usage?.image),
    });
  }
  let rewritten = mapMarkdownOutsideCode(
    content,
    (text) => text.replace(
      /^(\s{0,3}\[([^\]]+)]:[ \t]*)(.*)$/gm,
      (line, prefix: string, id: string, remainder: string) => {
        const usage = referenceUsage.get(id.trim().toLocaleLowerCase());
        if (!usage) return line;
        const destination = parseMarkdownDestination(remainder, 0, false);
        if (!destination) return line;
        const target = bindTarget(destination.target, usage.image, usage.count);
        return target === null
          ? line
          : `${prefix}${target}${remainder.slice(destination.endIndex)}`;
      },
    ),
  );
  rewritten = mapMarkdownOutsideCode(
    rewritten,
    (text) => replaceInlineMarkdownDestinations(text, (token) => {
      const target = bindTarget(token.target, token.image);
      return target === null ? token.raw : `${token.image ? '!' : ''}[${token.label}](${target})`;
    }),
  );
  if (errorMessage) return { ok: false, message: errorMessage };
  return { ok: true, content: rewritten, resources };
}

interface MarkdownDestination {
  target: string;
  endIndex: number;
}

function parseMarkdownDestination(value: string, startIndex: number, stopAtClosingParen: boolean): MarkdownDestination | null {
  let index = startIndex;
  while (value[index] === ' ' || value[index] === '\t') index += 1;
  const targetStart = index;
  if (value[index] === '<') {
    const closing = value.indexOf('>', index + 1);
    if (closing < 0 || value.slice(index + 1, closing).includes('\n')) return null;
    return { target: value.slice(index, closing + 1), endIndex: closing + 1 };
  }
  let depth = stopAtClosingParen ? 1 : 0;
  let escaped = false;
  while (index < value.length) {
    const character = value[index]!;
    if (escaped) {
      escaped = false;
      index += 1;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      if (stopAtClosingParen && depth === 1) break;
      if (depth === 0) break;
      depth -= 1;
    } else if ((character === ' ' || character === '\t' || character === '\n') && depth <= (stopAtClosingParen ? 1 : 0)) {
      break;
    }
    index += 1;
  }
  return index > targetStart ? { target: value.slice(targetStart, index), endIndex: index } : null;
}

function replaceInlineMarkdownDestinations(
  content: string,
  replace: (token: { raw: string; label: string; target: string; image: boolean }) => string,
): string {
  const pattern = /(!?)\[([^\]]*)]\(/g;
  let output = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    const destination = parseMarkdownDestination(content, pattern.lastIndex, true);
    if (!destination) continue;
    let closingIndex = destination.endIndex;
    let quote: string | undefined;
    while (content[closingIndex] === ' ' || content[closingIndex] === '\t') closingIndex += 1;
    if (content[closingIndex] === '"' || content[closingIndex] === "'") {
      quote = content[closingIndex];
      closingIndex += 1;
      while (closingIndex < content.length && content[closingIndex] !== quote && content[closingIndex] !== '\n') {
        closingIndex += 1;
      }
      if (content[closingIndex] !== quote) continue;
      closingIndex += 1;
      while (content[closingIndex] === ' ' || content[closingIndex] === '\t') closingIndex += 1;
    }
    if (content[closingIndex] !== ')') continue;
    const raw = content.slice(match.index, closingIndex + 1);
    output += content.slice(cursor, match.index);
    output += replace({
      raw,
      label: match[2]!,
      target: destination.target,
      image: Boolean(match[1]),
    });
    cursor = closingIndex + 1;
    pattern.lastIndex = cursor;
  }
  return `${output}${content.slice(cursor)}`;
}

function mapMarkdownOutsideCode(
  content: string,
  map: (text: string) => string,
  maskCode = false,
): string {
  const lines = content.split(/(?<=\n)/);
  let fence: { character: '`' | '~'; length: number } | undefined;
  return lines.map((line) => {
    if (fence) {
      const closingFenceMatch = line.match(/^(?: {0,3})(`{3,}|~{3,})[ \t]*(?:\r?\n)?$/);
      const closesFence = closingFenceMatch?.[1]?.[0] === fence.character
        && closingFenceMatch[1].length >= fence.length;
      if (closesFence) fence = undefined;
      return maskCode ? line.replace(/[^\n]/g, ' ') : line;
    }
    const fenceMatch = line.match(/^(?: {0,3})(`{3,}|~{3,})/);
    if (fenceMatch) {
      fence = {
        character: fenceMatch[1]![0] as '`' | '~',
        length: fenceMatch[1]!.length,
      };
      return maskCode ? line.replace(/[^\n]/g, ' ') : line;
    }
    return mapInlineCodeSegments(line, map, maskCode);
  }).join('');
}

function mapInlineCodeSegments(line: string, map: (text: string) => string, maskCode: boolean): string {
  let output = '';
  let cursor = 0;
  while (cursor < line.length) {
    const opening = line.indexOf('`', cursor);
    if (opening < 0) return `${output}${map(line.slice(cursor))}`;
    let runLength = 1;
    while (line[opening + runLength] === '`') runLength += 1;
    const closing = findClosingBacktickRun(line, opening + runLength, runLength);
    if (closing < 0) return `${output}${map(line.slice(cursor))}`;
    output += map(line.slice(cursor, opening));
    const code = line.slice(opening, closing + runLength);
    output += maskCode ? code.replace(/[^\n]/g, ' ') : code;
    cursor = closing + runLength;
  }
  return output;
}

function findClosingBacktickRun(text: string, startIndex: number, expectedLength: number): number {
  let cursor = startIndex;
  while (cursor < text.length) {
    const opening = text.indexOf('`', cursor);
    if (opening < 0) return -1;
    let length = 1;
    while (text[opening + length] === '`') length += 1;
    if (length === expectedLength) return opening;
    cursor = opening + length;
  }
  return -1;
}

function parsePinnedArtifactTarget(target: string): { teamId: string; artifactId: string } | null {
  const match = target.match(/^\/api\/teams\/([^/]+)\/artifacts\/([^/]+)\/(?:preview|download)$/);
  if (!match) return null;
  try {
    return { teamId: decodeURIComponent(match[1]!), artifactId: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

function decodeMissingResourcePath(target: string): string | null {
  try {
    const decoded = decodeURIComponent(target.slice('artifact-missing:'.length));
    const normalized = normalizeRootRelativePath(decoded);
    return normalized === decoded ? normalized : null;
  } catch {
    return null;
  }
}

function isRelativeMarkdownResource(target: string): boolean {
  const trimmed = target.trim();
  return Boolean(trimmed)
    && !trimmed.startsWith('#')
    && !trimmed.startsWith('/')
    && !trimmed.startsWith('//')
    && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

function resolveSourceRelativePath(sourcePath: string, target: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(target.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return null;
  }
  const parts = sourcePath.split('/');
  parts.pop();
  for (const part of decoded.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (/[\u0000-\u001f]/.test(part)) return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

function normalizeRootRelativePath(value: string): string | null {
  if (!value || value.startsWith('/') || value.startsWith('\\')) return null;
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    if (/[\u0000-\u001f]/.test(part)) return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

async function createInitialChannelDocument(
  repositories: Pick<ServerNextRepositories, 'channelDocuments'>,
  artifact: ArtifactRecord,
  createdBy: string,
  createdAt: number,
): Promise<void> {
  if (!isMarkdownArtifact(artifact)) return;
  // Artifact ID 已由上传/运行结果分配且全局唯一；复用它生成文档身份，不额外消耗
  // message send 的有限测试/幂等 ID 序列，也让重放时身份稳定。
  const { documentId, revisionId } = initialChannelDocumentIds(artifact.id);
  const publication = artifact.messageId
    ? {
        id: `${revisionId}:publication`,
        messageId: artifact.messageId,
        publishedBy: createdBy,
        publishedAt: createdAt,
      }
    : undefined;
  const revision: ChannelDocumentRevisionRecord = {
    id: revisionId, documentId, artifact, revision: 1, createdBy, createdAt,
    source: channelDocumentInitialRevisionSource(artifact),
    published: Boolean(publication),
    ...(publication ? { publication } : {}),
  };
  await repositories.channelDocuments.create({
    document: {
      id: revision.documentId, teamId: artifact.teamId, channelId: artifact.channelId, filename: sanitizeMarkdownFilename(artifact.filename),
      currentRevisionId: revision.id, createdAt, updatedAt: createdAt,
    },
    revision,
  });
}

function channelDocumentInitialRevisionSource(
  artifact: ArtifactRecord,
): ChannelDocumentRevisionDto['source'] {
  return artifact.workspaceRunId || artifact.dispatchId ? 'run' : 'attachment';
}

async function createInitialChannelDocuments(
  repositories: Pick<ServerNextRepositories, 'channelDocuments'>,
  artifacts: ArtifactRecord[],
  createdBy: string,
  createdAt: number,
): Promise<void> {
  for (const artifact of artifacts) {
    await createInitialChannelDocument(repositories, artifact, createdBy, createdAt);
  }
}

async function listPublicChannelFiles(
  repositories: ServerNextRepositories,
  input: ListChannelFilesInput | SearchChannelFilesInput,
  resolveArtifactPreview?: (artifact: ArtifactRecord) => Promise<ArtifactPreviewDto | undefined>,
  options: {
    channelFileRollout: ChannelFileRolloutConfig;
    channelFileMetrics: ReturnType<typeof createChannelFileMetrics>;
  } = { channelFileRollout: DEFAULT_CHANNEL_FILE_ROLLOUT, channelFileMetrics: createChannelFileMetrics() },
): Promise<Ack<ChannelFilesResultDto>> {
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  const channelAccess = await ensureUserCanViewChannel(repositories, input);
  if (!channelAccess.ok) return channelAccess;
  if (!options.channelFileRollout.fileBrowser) {
    return makeFailure('NOT_FOUND', 'Channel file browser is disabled');
  }

  const cursor = decodeChannelFileCursor(input.cursor);
  if (input.cursor && !cursor) return makeFailure('VALIDATION_ERROR', 'Invalid channel file cursor');
  const query = 'query' in input ? input.query.trim().toLocaleLowerCase() : '';
  if ('query' in input && query.length < 1) return makeFailure('VALIDATION_ERROR', 'File search query is required');
  const requestedPath = normalizeChannelFilePath(input.path);
  if (requestedPath === null) return makeFailure('VALIDATION_ERROR', 'Invalid channel file path');
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 50)));
  const candidates = await repositories.artifacts.listByChannel({ teamId: input.teamId, channelId: input.channelId });
  const entries: ChannelFileEntryDto[] = [];
  const indexedShadowSnapshot: ChannelFileSnapshotEntry[] = [];
  const directories = new Map<string, ChannelFileDirectoryDto>();
  const currentDocumentArtifactIds = new Set<string>();
  const messageDocumentOriginArtifactIds = new Set<string>();
  const documents = await repositories.channelDocuments.listWithCurrentRevisionByChannel(input);
  for (const { document, currentRevision } of documents) {
    currentDocumentArtifactIds.add(currentRevision.artifact.id);
    const documentSource = currentRevision.derivationSource;
    const initialArtifactId = document.id.startsWith('channel-document:')
      ? document.id.slice('channel-document:'.length)
      : undefined;
    if (!documentSource && initialArtifactId) messageDocumentOriginArtifactIds.add(initialArtifactId);
    const originArtifactId = documentSource?.artifactId ?? initialArtifactId;
    const originArtifact = originArtifactId
      ? await repositories.artifacts.getForTeam({ teamId: input.teamId, artifactId: originArtifactId })
      : null;
    const source = documentSource
      ? {
          ...(documentSource.messageId ? { messageId: documentSource.messageId } : {}),
          ...(documentSource.threadId ? { threadId: documentSource.threadId } : {}),
          ...(documentSource.taskId ? { taskId: documentSource.taskId } : {}),
          workspaceRunId: documentSource.workspaceRunId,
          agentId: documentSource.agentId,
          senderKind: 'agent' as const,
          senderId: documentSource.agentId,
          messageCreatedAt: documentSource.messageCreatedAt,
        }
      : originArtifact
        ? await channelFileSource(repositories, originArtifact)
        : null;
    if (!source) continue;
    const artifact = currentRevision.artifact;
    const role: ArtifactRole = 'attachment';
    if (input.role && input.role !== 'all' && role !== input.role) continue;
    const logicalPath = document.filename;
    if (query && !`${artifact.filename} ${logicalPath}`.toLocaleLowerCase().includes(query)) continue;
    if (source.messageId) {
      indexedShadowSnapshot.push({ id: artifact.id, logicalPath, role });
    }
    const preview = await resolveArtifactPreview?.(artifact);
    if (!query) addChannelFileDirectories(
      directories,
      logicalPath,
      artifact,
      preview?.status === 'ready' ? preview.url : undefined,
    );
    if (!query && !isDirectChannelFileChild(logicalPath, requestedPath)) continue;
    if (cursor && !isAfterChannelFileCursor(artifact, cursor)) continue;
    entries.push({
      artifact: {
        ...toArtifactDto(artifact),
        ...(preview ? { preview } : {}),
      },
      source,
      logicalPath,
      role,
      documentId: document.id,
      documentRevision: currentRevision.revision,
      ...(documentSource ? { documentSource } : {}),
    });
  }
  for (const artifact of candidates) {
    if (currentDocumentArtifactIds.has(artifact.id)
      || messageDocumentOriginArtifactIds.has(artifact.id)) continue;
    if (isWorkspaceRunLogArtifact(artifact)) continue;
    const role = artifact.role ?? (artifact.messageId ? 'attachment' : 'run_output');
    if (input.role && input.role !== 'all' && role !== input.role) continue;
    if (!(await isPublicChannelFileArtifact(repositories, artifact))) continue;
    const source = await channelFileSource(repositories, artifact);
    if (!source) continue;
    const logicalPath = channelArtifactLogicalPath(artifact, source, role);
    if (query && !`${artifact.filename} ${logicalPath}`.toLocaleLowerCase().includes(query)) continue;
    if (source.messageId) {
      indexedShadowSnapshot.push({ id: artifact.id, logicalPath, role });
    }
    const preview = await resolveArtifactPreview?.(artifact);
    if (!query) addChannelFileDirectories(
      directories,
      logicalPath,
      artifact,
      preview?.status === 'ready' ? preview.url : undefined,
    );
    if (!query && !isDirectChannelFileChild(logicalPath, requestedPath)) continue;
    if (cursor && !isAfterChannelFileCursor(artifact, cursor)) continue;
    entries.push({
      artifact: {
        ...toArtifactDto(artifact),
        ...(preview ? { preview } : {}),
      },
      source,
      logicalPath,
      role,
    });
  }
  entries.sort((left, right) => compareChannelFiles(right.artifact, left.artifact));
  if (options.channelFileRollout.indexShadowCompare
    && !input.cursor
    && !requestedPath
    && !query
    && (!input.role || input.role === 'all')) {
    const legacySnapshot = await buildLegacyChannelAttachmentSnapshot(repositories, input.channelId);
    const diff = compareChannelFileSnapshots(legacySnapshot, indexedShadowSnapshot);
    options.channelFileMetrics.increment('indexShadowComparisons');
    if (!diff.equal) {
      options.channelFileMetrics.increment(
        'indexShadowMismatches',
        diff.missingFromIndex.length + diff.unexpectedInIndex.length + diff.changed.length,
      );
      options.channelFileMetrics.increment('indexShadowMissing', diff.missingFromIndex.length);
      options.channelFileMetrics.increment('indexShadowUnexpected', diff.unexpectedInIndex.length);
      options.channelFileMetrics.increment('indexShadowChanged', diff.changed.length);
    }
  }
  const page = entries.slice(0, pageSize);
  const last = page[page.length - 1]?.artifact;
  return makeSuccess({
    files: page,
    directories: query
      ? []
      : [...directories.values()]
          .filter((directory) => isDirectDirectoryChild(directory.path, requestedPath))
          .sort((left, right) => right.updatedAt - left.updatedAt
            || Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8'))),
    path: requestedPath,
    ...(entries.length > pageSize && last ? { nextCursor: encodeChannelFileCursor(last) } : {}),
  });
}

async function buildLegacyChannelAttachmentSnapshot(
  repositories: ServerNextRepositories,
  channelId: string,
): Promise<Array<{ id: string; logicalPath: string; role: string }>> {
  const messages = await repositories.messages.listByChannel(channelId, 10_000);
  const snapshot: Array<{ id: string; logicalPath: string; role: string }> = [];
  for (const message of messages) {
    if (message.channelId !== channelId || isDeletedMessage(message)) continue;
    const artifacts = await repositories.artifacts.listByMessage(message.id);
    for (const artifact of artifacts) {
      if (artifact.channelId !== channelId || isWorkspaceRunLogArtifact(artifact)) continue;
      if (!(await isPublicChannelFileArtifact(repositories, artifact))) continue;
      const source = await channelFileSource(repositories, artifact);
      if (!source) continue;
      const role = artifact.role ?? 'attachment';
      snapshot.push({
        id: artifact.id,
        logicalPath: channelArtifactLogicalPath(artifact, source, role),
        role,
      });
    }
  }
  return snapshot;
}

function normalizeChannelFilePath(value: string | undefined): string | null {
  if (!value || value === '/') return '';
  const parts = value.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  return parts.join('/');
}

async function channelFileSource(
  repositories: ServerNextRepositories,
  artifact: ArtifactRecord,
): Promise<ChannelFileSourceDto | null> {
  const directMessage = artifact.messageId
    ? await repositories.messages.getById(artifact.messageId)
    : null;
  const role = artifact.role ?? (artifact.messageId ? 'attachment' : 'run_output');
  if (directMessage
    && (directMessage.channelId !== artifact.channelId || isDeletedMessage(directMessage))
    && role === 'attachment') {
    return null;
  }
  if (directMessage
    && directMessage.channelId === artifact.channelId
    && !isDeletedMessage(directMessage)) {
    return {
      messageId: directMessage.id,
      ...(directMessage.threadId ? { threadId: directMessage.threadId } : {}),
      ...(messageTaskId(directMessage) ? { taskId: messageTaskId(directMessage) } : {}),
      ...(artifact.workspaceRunId ? { workspaceRunId: artifact.workspaceRunId } : {}),
      senderKind: directMessage.senderKind,
      senderId: directMessage.senderId,
      messageCreatedAt: directMessage.createdAt,
    };
  }
  if (!artifact.workspaceRunId) return null;
  const run = await repositories.workspaceRuns.getForTeam({
    teamId: artifact.teamId,
    runId: artifact.workspaceRunId,
  });
  if (!run) {
    if (!isLegacyBackfilledRunArtifact(artifact)) return null;
    return {
      workspaceRunId: artifact.workspaceRunId,
      senderKind: 'system',
      senderId: null,
      messageCreatedAt: artifact.createdAt,
    };
  }
  const dispatch = await repositories.dispatches.getById(run.dispatchId);
  const sourceMessageId = run.messageId ?? dispatch?.messageId;
  const sourceMessage = sourceMessageId
    ? await repositories.messages.getById(sourceMessageId)
    : null;
  const visibleSourceMessage = sourceMessage
    && sourceMessage.channelId === artifact.channelId
    && !isDeletedMessage(sourceMessage)
    ? sourceMessage
    : null;
  const taskId = visibleSourceMessage ? messageTaskId(visibleSourceMessage) : undefined;
  return {
    ...(visibleSourceMessage ? { messageId: visibleSourceMessage.id } : {}),
    ...(visibleSourceMessage?.threadId ? { threadId: visibleSourceMessage.threadId } : {}),
    ...(taskId ? { taskId } : {}),
    workspaceRunId: run.id,
    agentId: run.agentId,
    senderKind: 'agent',
    senderId: run.agentId,
    messageCreatedAt: visibleSourceMessage?.createdAt ?? run.createdAt,
  };
}

function messageTaskId(message: MessageRecord): string | undefined {
  return typeof message.meta?.taskId === 'string' && message.meta.taskId
    ? message.meta.taskId
    : undefined;
}

function channelArtifactLogicalPath(
  artifact: ArtifactRecord,
  source: ChannelFileSourceDto,
  role: ArtifactRole,
): string {
  const relativePath = normalizeChannelFilePath(artifact.relativePath ?? artifact.filename)
    ?? artifact.filename;
  if (!artifact.workspaceRunId || (role !== 'intermediate' && role !== 'run_output')) return relativePath;
  const taskSegment = source.taskId ? `任务 ${source.taskId}` : '未关联任务';
  const sourceRoot = artifact.sourceRoot
    ? `${artifact.sourceRoot.label} [${artifact.sourceRoot.id}]`
    : '默认运行输出';
  return ['运行产物', taskSegment, `Run ${artifact.workspaceRunId}`, sourceRoot, relativePath]
    .filter(Boolean)
    .join('/');
}

function isDirectChannelFileChild(logicalPath: string, requestedPath: string): boolean {
  const relative = requestedPath
    ? logicalPath.startsWith(`${requestedPath}/`) ? logicalPath.slice(requestedPath.length + 1) : ''
    : logicalPath;
  return Boolean(relative) && !relative.includes('/');
}

function isDirectDirectoryChild(directoryPath: string, requestedPath: string): boolean {
  const relative = requestedPath
    ? directoryPath.startsWith(`${requestedPath}/`) ? directoryPath.slice(requestedPath.length + 1) : ''
    : directoryPath;
  return Boolean(relative) && !relative.includes('/');
}

function addChannelFileDirectories(
  directories: Map<string, ChannelFileDirectoryDto>,
  logicalPath: string,
  artifact: ArtifactRecord,
  previewUrl?: string,
): void {
  const parts = logicalPath.split('/');
  for (let index = 0; index < parts.length - 1; index += 1) {
    const path = parts.slice(0, index + 1).join('/');
    const existing = directories.get(path);
    directories.set(path, {
      path,
      name: parts[index]!,
      fileCount: (existing?.fileCount ?? 0) + 1,
      updatedAt: Math.max(existing?.updatedAt ?? 0, artifact.createdAt),
      ...(artifact.sourceRoot ? { sourceRoot: artifact.sourceRoot } : {}),
      ...addDirectoryPreview(existing?.previewUrls, previewUrl),
    });
  }
}

function addDirectoryPreview(
  existing: string[] | undefined,
  previewUrl: string | undefined,
): { previewUrls?: string[] } {
  if (!previewUrl || existing?.includes(previewUrl) || (existing?.length ?? 0) >= 4) {
    return existing?.length ? { previewUrls: existing } : {};
  }
  return { previewUrls: [...(existing ?? []), previewUrl] };
}

async function isPublicChannelFileArtifact(
  repositories: ServerNextRepositories,
  artifact: ArtifactRecord,
): Promise<boolean> {
  if (artifact.workspaceRunId) {
    const run = await repositories.workspaceRuns.getForTeam({ teamId: artifact.teamId, runId: artifact.workspaceRunId });
    if (!run) {
      return isLegacyBackfilledRunArtifact(artifact)
        && await isPublicArtifact(repositories, artifact);
    }
    if (!(await isPublicWorkspaceRun(repositories, run))) return false;
  }
  return isPublicArtifact(repositories, artifact);
}

function isLegacyBackfilledRunArtifact(
  artifact: ArtifactRecord,
): artifact is ArtifactRecord & { workspaceRunId: string } {
  return Boolean(
    artifact.workspaceRunId
    && artifact.sourceRoot?.kind === 'legacy_run'
    && artifact.sourceRoot.id === `legacy_run:${artifact.workspaceRunId}`,
  );
}

function compareChannelFiles(left: Pick<ArtifactRecord, 'createdAt' | 'id'>, right: Pick<ArtifactRecord, 'createdAt' | 'id'>): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  return Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'));
}

function isAfterChannelFileCursor(artifact: ArtifactRecord, cursor: ChannelFileCursor): boolean {
  return compareChannelFiles(artifact, cursor) < 0;
}

function encodeChannelFileCursor(artifact: Pick<ArtifactRecord, 'createdAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ createdAt: artifact.createdAt, id: artifact.id }), 'utf8').toString('base64url');
}

function decodeChannelFileCursor(value: string | undefined): ChannelFileCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<ChannelFileCursor>;
    return typeof parsed.createdAt === 'number' && Number.isFinite(parsed.createdAt) && typeof parsed.id === 'string' && parsed.id.length > 0
      ? { createdAt: parsed.createdAt, id: parsed.id }
      : undefined;
  } catch {
    return undefined;
  }
}

// 判断 web 用户能否管理某设备：设备拥有者 或 系统管理员（user.role='admin'）。
// 团队角色（team owner/admin）不再放行 —— 业务规则：用户只能修改自己的设备。
async function canManageDeviceAsUser(
  repositories: ServerNextRepositories,
  input: { userId: string; device: DeviceRecord },
): Promise<boolean> {
  if (input.device.ownerId === input.userId) {
    return true;
  }
  const actor = await repositories.users.getById(input.userId);
  return actor?.role === 'admin';
}

// agent 路径：agent.deviceId 可能指向别名记录，先解析 canonical 代表再判设备所有权，
// 与 getDevice / 列表展示的 owner 来源一致（防 admin 转移 owner + 后续别名导致误拒合法 owner）。
async function canManageAgentAsUser(
  repositories: ServerNextRepositories,
  input: { userId: string; agent: AgentRecord },
): Promise<boolean> {
  if (!input.agent.deviceId) {
    return false; // fail-closed：无可定位设备的 agent 一律不可管理
  }
  const device = await repositories.devices.getById(input.agent.deviceId);
  if (!device) {
    return false;
  }
  const canonical = resolveCanonicalDeviceRecord(
    device,
    await repositories.devices.listByTeam(device.teamId),
  );
  return canManageDeviceAsUser(repositories, { userId: input.userId, device: canonical });
}

async function agentForManagement(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; agentId: string },
): Promise<Ack<{ agent: AgentRecord }>> {
  const agent = await repositories.agents.getById(input.agentId);
  if (!agent || agent.deletedAt !== undefined) {
    return makeFailure('NOT_FOUND', 'Agent not found');
  }
  if (agent.primaryTeamId !== input.teamId) {
    return makeFailure('FORBIDDEN', 'Agent is not managed by this team');
  }
  const role = await repositories.teams.getMemberRole(agent.primaryTeamId, input.userId);
  if (!role) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  // 仅设备拥有者 / 系统管理员可管理（deleteAgent、setAgentTeamVisibility）
  if (!(await canManageAgentAsUser(repositories, { userId: input.userId, agent }))) {
    return makeFailure('FORBIDDEN', 'User cannot manage agent');
  }
  return makeSuccess({ agent });
}

async function agentForConfigUpdate(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; agentId: string },
): Promise<Ack<{ agent: AgentRecord }>> {
  const agent = await repositories.agents.getById(input.agentId);
  if (!agent || agent.deletedAt !== undefined) {
    return makeFailure('NOT_FOUND', 'Agent not found');
  }
  if (agent.primaryTeamId !== input.teamId) {
    return makeFailure('FORBIDDEN', 'Agent is not managed by this team');
  }
  const role = await repositories.teams.getMemberRole(agent.primaryTeamId, input.userId);
  if (!role) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  // 仅设备拥有者 / 系统管理员可改配置（统一取代旧的 source 分支授权）
  if (!(await canManageAgentAsUser(repositories, { userId: input.userId, agent }))) {
    return makeFailure('FORBIDDEN', 'User cannot manage agent');
  }
  return makeSuccess({ agent });
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toPublicAgent(agent: AgentRecord): AgentDto {
  const {
    deletedAt: _deletedAt,
    nameSource: _nameSource,
    createdAt: _createdAt,
    ...publicAgent
  } = agent;
  return publicAgent;
}

/**
 * 组合扫描 descriptor 的「功能介绍」：frontmatter description（优先）+ 抽取的 capabilities。
 * 与 web 端添加自定义 Agent 的预填语义一致（AddCustomAgentDialog）。
 * 无 description 且无 capabilities → null（不写空描述）。
 */
function buildScannedAgentDescription(
  descriptor: AgentDescriptorDto | null | undefined,
): string | null {
  if (!descriptor) return null;
  const parts: string[] = [];
  if (descriptor.description) parts.push(descriptor.description);
  const caps = Array.isArray(descriptor.capabilities) ? descriptor.capabilities : [];
  if (caps.length > 0) parts.push(`具备能力：${caps.join('、')}`);
  return parts.length > 0 ? parts.join('\n') : null;
}

async function toAgentMemberDtos(
  repositories: ServerNextRepositories,
  teamId: string,
  agents: AgentRecord[],
): Promise<AgentMemberDto[]> {
  const ownerInfos = await resolveAgentOwnerInfos(repositories, agents);
  const deviceIds = uniqueIds(agents.map((agent) => agent.deviceId ?? ''));
  const devicesById = new Map<string, DeviceRecord>();
  await Promise.all(deviceIds.map(async (deviceId) => {
    const device = await repositories.devices.getById(deviceId);
    if (device) {
      devicesById.set(device.id, device);
    }
  }));
  const teamDevicesById = new Map<string, DeviceRecord[]>();
  async function canonicalDeviceFor(device: DeviceRecord): Promise<DeviceRecord> {
    let teamDevices = teamDevicesById.get(device.teamId);
    if (!teamDevices) {
      teamDevices = await repositories.devices.listByTeam(device.teamId);
      teamDevicesById.set(device.teamId, teamDevices);
    }
    return resolveCanonicalDeviceRecord(device, teamDevices);
  }

  const projections = await Promise.all(agents.map(async (agent): Promise<AgentMemberProjection> => {
    const rawDevice = agent.deviceId ? devicesById.get(agent.deviceId) : undefined;
    const canonicalDevice = rawDevice ? await canonicalDeviceFor(rawDevice) : undefined;
    const dto: AgentMemberDto = { ...toPublicAgent(agent) };
    const ownerInfo = ownerInfos.get(agent.id);
    if (ownerInfo?.ownerId) {
      dto.ownerId = ownerInfo.ownerId;
    }
    dto.ownerName = ownerInfo?.ownerName ?? null;
    if (canonicalDevice) {
      dto.deviceId = canonicalDevice.id;
      dto.deviceName = deviceDisplayName(canonicalDevice);
    } else if (rawDevice) {
      dto.deviceName = deviceDisplayName(rawDevice);
    }
    return { dto, rawDeviceId: rawDevice?.id };
  }));
  return dedupeAgentMemberDtos(projections, teamId);
}

/**
 * 为普通用户 snapshot 路径（listVisibleAgents → 成员页/Agent 详情页）富化 ownerName。
 *
 * 创建者语义 = agent.ownerId ?? 所在 canonical device 的 owner。扫描发现的 agentos-hosted
 * agent 入库时不携带 ownerId，必须回退到设备所有者；hostname 别名场景下取 canonical
 * device 的 owner（与 toAgentMemberDtos 同源的别名归并逻辑）。
 *
 * 注：admin 视图由 toAdminAgentDto 单独处理；本函数只补普通 snapshot 路径此前缺失的 join。
 */
async function enrichAgentOwnerNames(
  repositories: ServerNextRepositories,
  agents: AgentRecord[],
): Promise<AgentDto[]> {
  const ownerInfos = await resolveAgentOwnerInfos(repositories, agents);
  return agents.map((agent) => {
    const ownerInfo = ownerInfos.get(agent.id);
    const dto = toPublicAgent(agent);
    if (ownerInfo?.ownerId) {
      dto.ownerId = ownerInfo.ownerId;
    }
    return { ...dto, ownerName: ownerInfo?.ownerName ?? null };
  });
}

async function resolveAgentOwnerInfos(
  repositories: ServerNextRepositories,
  agents: Array<Pick<AgentDto, 'id' | 'ownerId' | 'deviceId'>>,
): Promise<Map<string, { ownerId?: string; ownerName: string | null }>> {
  const result = new Map<string, { ownerId?: string; ownerName: string | null }>();
  if (agents.length === 0) return result;

  const devicesById = new Map<string, DeviceRecord>();
  const teamDevicesCache = new Map<string, DeviceRecord[]>();
  await Promise.all(uniqueIds(agents.map((agent) => agent.deviceId ?? '')).map(async (deviceId) => {
    const device = await repositories.devices.getById(deviceId);
    if (device) devicesById.set(device.id, device);
  }));
  async function canonicalDeviceFor(device: DeviceRecord): Promise<DeviceRecord> {
    let teamDevices = teamDevicesCache.get(device.teamId);
    if (!teamDevices) {
      teamDevices = await repositories.devices.listByTeam(device.teamId);
      teamDevicesCache.set(device.teamId, teamDevices);
    }
    return resolveCanonicalDeviceRecord(device, teamDevices);
  }

  const ownerIdByAgentId = new Map<string, string | undefined>();
  const ownerIds = new Set<string>();
  await Promise.all(agents.map(async (agent) => {
    const rawDevice = agent.deviceId ? devicesById.get(agent.deviceId) : undefined;
    const canonicalDevice = rawDevice ? await canonicalDeviceFor(rawDevice) : undefined;
    const ownerId = agent.ownerId ?? canonicalDevice?.ownerId;
    ownerIdByAgentId.set(agent.id, ownerId);
    if (ownerId) ownerIds.add(ownerId);
  }));

  const usersById = new Map<string, UserRecord>();
  await Promise.all([...ownerIds].map(async (userId) => {
    const user = await repositories.users.getById(userId);
    if (user) usersById.set(user.id, user);
  }));

  for (const agent of agents) {
    const ownerId = ownerIdByAgentId.get(agent.id);
    const owner = ownerId ? usersById.get(ownerId) : undefined;
    result.set(agent.id, ownerId ? { ownerId, ownerName: owner?.username ?? null } : { ownerName: null });
  }
  return result;
}

function dedupeAgentMemberDtos(projections: AgentMemberProjection[], teamId: string): AgentMemberDto[] {
  const result: AgentMemberProjection[] = [];
  const indexByKey = new Map<string, number>();
  for (const projection of projections) {
    const key = agentMemberLogicalKey(projection.dto, teamId);
    const existingIndex = key ? indexByKey.get(key) : undefined;
    if (key === null || existingIndex === undefined) {
      if (key) indexByKey.set(key, result.length);
      result.push(projection);
      continue;
    }
    result[existingIndex] = preferAgentMemberProjection(projection, result[existingIndex]!);
    const preferredKey = agentMemberLogicalKey(result[existingIndex]!.dto, teamId);
    if (preferredKey) indexByKey.set(preferredKey, existingIndex);
    indexByKey.set(key, existingIndex);
  }
  return result.map((projection) => projection.dto);
}

function agentMemberLogicalKey(agent: AgentMemberDto, teamId: string): string | null {
  if (agent.source === 'custom' || agent.category !== 'agentos-hosted') {
    return null;
  }
  const gatewayKey = agentMemberGatewayLogicalKey(agent, teamId);
  return gatewayKey ?? agentMemberNameLogicalKey(agent, teamId);
}

function agentMemberNameLogicalKey(agent: AgentMemberDto, teamId: string): string | null {
  if (!agent.deviceId) return null;
  const adapterKind = normalizeAdapterKind(agent.adapterKind);
  const name = normalizeAgentName(agent.name);
  if (!adapterKind || !name) return null;
  return [teamId, agent.deviceId, adapterKind, 'name', name].join('\u0000');
}

function agentMemberGatewayLogicalKey(agent: AgentMemberDto, teamId: string): string | null {
  if (!agent.deviceId || !agent.gatewayInstanceKey) return null;
  const adapterKind = normalizeAdapterKind(agent.adapterKind);
  if (adapterKind !== 'hermes' && adapterKind !== 'openclaw') return null;
  return [teamId, agent.deviceId, adapterKind, 'gateway', normalizeAgentName(agent.gatewayInstanceKey)].join('\u0000');
}

function preferAgentMemberProjection(candidate: AgentMemberProjection, current: AgentMemberProjection): AgentMemberProjection {
  const display = preferAgentMemberDisplay(candidate, current);
  const status = preferAgentMemberStatus(candidate, current);
  return {
    rawDeviceId: display.rawDeviceId,
    dto: {
      ...display.dto,
      status: status.dto.status,
      lastSeenAt: Math.max(display.dto.lastSeenAt ?? 0, status.dto.lastSeenAt ?? 0) || (display.dto.lastSeenAt ?? status.dto.lastSeenAt),
      lastError: status.dto.lastError,
      visibleTeamIds: uniqueIds([...display.dto.visibleTeamIds, ...status.dto.visibleTeamIds]),
    },
  };
}

function preferAgentMemberDisplay(candidate: AgentMemberProjection, current: AgentMemberProjection): AgentMemberProjection {
  const canonicalDelta = agentMemberCanonicalRank(candidate) - agentMemberCanonicalRank(current);
  if (canonicalDelta !== 0) return canonicalDelta > 0 ? candidate : current;
  const sourceDelta = agentMemberSourceRank(candidate.dto.source) - agentMemberSourceRank(current.dto.source);
  if (sourceDelta !== 0) return sourceDelta > 0 ? candidate : current;
  return (candidate.dto.lastSeenAt ?? 0) > (current.dto.lastSeenAt ?? 0) ? candidate : current;
}

function preferAgentMemberStatus(candidate: AgentMemberProjection, current: AgentMemberProjection): AgentMemberProjection {
  const timeDelta = (candidate.dto.lastSeenAt ?? 0) - (current.dto.lastSeenAt ?? 0);
  if (timeDelta !== 0) return timeDelta > 0 ? candidate : current;
  const statusDelta = agentMemberStatusRank(candidate.dto.status) - agentMemberStatusRank(current.dto.status);
  if (statusDelta !== 0) return statusDelta > 0 ? candidate : current;
  return candidate;
}

function agentMemberCanonicalRank(projection: AgentMemberProjection): number {
  return projection.rawDeviceId && projection.rawDeviceId === projection.dto.deviceId ? 1 : 0;
}

function agentMemberSourceRank(source?: string | null): number {
  if (source === 'custom') return 3;
  if (source === 'self-register') return 2;
  return 1;
}

function agentMemberStatusRank(status?: string | null): number {
  if (status === 'busy') return 5;
  if (status === 'online') return 4;
  if (status === 'connecting') return 3;
  if (status === 'error') return 2;
  if (status === 'offline') return 1;
  return 0;
}

function toDeviceAgentListDto(agent: AgentRecord, device?: DeviceRecord): DeviceAgentListDto {
  return {
    ...toPublicAgent(agent),
    deviceName: device ? deviceDisplayName(device) : undefined,
  };
}

function agentIdentityKey(input: {
  teamId: string;
  deviceId: string;
  adapterKind: AdapterKind;
  name: string;
  category: AgentCategory;
  gatewayInstanceKey?: string;
}): string {
  if (input.gatewayInstanceKey) {
    return JSON.stringify({
      kind: 'agentos-gateway',
      teamId: input.teamId,
      deviceId: input.deviceId,
      adapterKind: input.adapterKind,
      gatewayInstanceKey: input.gatewayInstanceKey ?? normalizeAgentName(input.name),
    });
  }
  return JSON.stringify({
    kind: 'agentos-concrete',
    teamId: input.teamId,
    deviceId: input.deviceId,
    adapterKind: input.adapterKind,
    name: normalizeAgentName(input.name),
  });
}

// 取该 device 上的 custom agent（编程执行器，自定义来源）作为 scanRequested 下发目标，
// 供 daemon 扫描其 skills 并通过 reportCustomSkills 上报。
async function listCustomAgentsForDevice(
  repositories: ServerNextRepositories,
  deviceId: string,
): Promise<ScanRequestCustomAgent[]> {
  const deviceAgents = await repositories.agents.listByDevice(deviceId);
  return deviceAgents
    .filter((agent) => agent.category === 'executor-hosted' && agent.source === 'custom')
    .map((agent) => ({
      id: agent.id,
      adapterKind: agent.adapterKind,
      cwd: agent.cwd,
    }));
}

/** 判断用户是否为某频道的人类成员（Formal Memory channel scope 读门控，AC#5）。 */
async function isChannelMemberOf(
  repositories: ServerNextRepositories,
  channelId: string,
  userId: string,
): Promise<boolean> {
  const channel = await repositories.channels.getById(channelId);
  return Boolean(channel && channel.humanMemberIds.includes(userId));
}

/**
 * 把 Formal Memory service 抛出的错误码转成 Ack failure；未识别的错误返回 undefined
 * （由调用方 rethrow 经 socket 层 memoryErrorAck 兜底）。底层 collaborative-memory-service
 * 复用现有 MEMORY_* 错误码，由 socket-handlers memoryErrorAck 统一映射。
 */
function formalMemoryErrorAck(error: unknown): Ack<never> | undefined {
  if (!(error instanceof Error)) return undefined;
  switch (error.message) {
    case 'FORMAL_MEMORY_NOT_FOUND':
      return makeFailure('NOT_FOUND', 'Formal Memory not found');
    case 'MEMORY_NOT_FOUND':
      return makeFailure('NOT_FOUND', 'Memory record not found');
    case 'MEMORY_PERMISSION_DENIED':
    case 'MEMORY_SOURCE_PERMISSION_DENIED':
      return makeFailure('FORBIDDEN', 'Memory access denied');
    case 'MEMORY_INVALID_VALIDITY':
      return makeFailure('VALIDATION_ERROR', 'Memory request is invalid');
    case 'MEMORY_INVALID_TRANSITION':
    case 'MEMORY_UPDATE_CONFLICT':
    case 'MEMORY_DUPLICATE_CONTENT':
      return makeFailure('CONFLICT', 'Memory state changed; refresh and retry');
    default:
      return undefined;
  }
}

function systemUserMemoryErrorAck(error: unknown): Ack<never> | undefined {
  if (!(error instanceof Error)) return undefined;
  switch (error.message) {
    case 'SYSTEM_KNOWLEDGE_NOT_FOUND':
    case 'USER_MEMORY_NOT_FOUND':
      return makeFailure('NOT_FOUND', 'System/User Memory not found');
    case 'SYSTEM_KNOWLEDGE_ALREADY_SUPERSEDED':
    case 'USER_MEMORY_ALREADY_SUPERSEDED':
      return makeFailure('CONFLICT', 'Memory already superseded; refresh and retry');
    default:
      return undefined;
  }
}

function experiencePackErrorAck(error: unknown): Ack<never> | undefined {
  if (!(error instanceof Error)) return undefined;
  const msg = error.message;
  if (msg.startsWith('EXPERIENCE_PACK_DRAFT_INVALID:')) {
    return makeFailure('VALIDATION_ERROR', `Draft invalid: ${msg.slice('EXPERIENCE_PACK_DRAFT_INVALID:'.length)}`);
  }
  if (msg.startsWith('EXPERIENCE_PACK_APPROVE:')) {
    const reason = msg.slice('EXPERIENCE_PACK_APPROVE:'.length);
    if (reason === 'not_draft') return makeFailure('CONFLICT', 'Only draft packs can be approved');
    if (reason === 'forbidden') return makeFailure('FORBIDDEN', 'No permission to approve');
    return makeFailure('CONFLICT', reason);
  }
  if (msg.startsWith('EXPERIENCE_PACK_WITHDRAW:')) {
    const reason = msg.slice('EXPERIENCE_PACK_WITHDRAW:'.length);
    if (reason === 'not_withdrawable') return makeFailure('CONFLICT', 'Pack cannot be withdrawn in its current status');
    if (reason === 'forbidden') return makeFailure('FORBIDDEN', 'No permission to withdraw');
    return makeFailure('CONFLICT', reason);
  }
  if (msg.startsWith('EXPERIENCE_PACK_SOURCE_INVALID:')) {
    const reason = msg.slice('EXPERIENCE_PACK_SOURCE_INVALID:'.length);
    if (reason === 'not_approved') return makeFailure('CONFLICT', 'Only approved packs can be marked source-invalid');
    if (reason === 'forbidden') return makeFailure('FORBIDDEN', 'No permission');
    if (reason === 'reason_empty') return makeFailure('VALIDATION_ERROR', 'Reason is required');
    return makeFailure('CONFLICT', reason);
  }
  if (msg.startsWith('EXPERIENCE_PACK_RECOMMEND:')) {
    const reason = msg.slice('EXPERIENCE_PACK_RECOMMEND:'.length);
    if (reason === 'pack_not_approved') return makeFailure('CONFLICT', 'Only approved packs can be recommended');
    if (reason === 'channel_archived') return makeFailure('CONFLICT', 'Cannot recommend to archived channel');
    if (reason === 'cross_team') return makeFailure('FORBIDDEN', 'Pack and channel must be in same team');
    return makeFailure('CONFLICT', reason);
  }
  if (msg.startsWith('EXPERIENCE_PACK_CONFIRM:')) {
    const reason = msg.slice('EXPERIENCE_PACK_CONFIRM:'.length);
    if (reason === 'not_pending') return makeFailure('CONFLICT', 'Attachment is not in pending state');
    if (reason === 'not_channel_member') return makeFailure('FORBIDDEN', 'Only channel members can confirm');
    if (reason === 'pack_not_approved') return makeFailure('CONFLICT', 'Pack is no longer approved');
    return makeFailure('CONFLICT', reason);
  }
  if (msg.startsWith('EXPERIENCE_PACK_REVOKE:')) {
    const reason = msg.slice('EXPERIENCE_PACK_REVOKE:'.length);
    if (reason === 'not_revokable') return makeFailure('CONFLICT', 'Attachment cannot be revoked in its current status');
    if (reason === 'forbidden') return makeFailure('FORBIDDEN', 'No permission to revoke');
    return makeFailure('CONFLICT', reason);
  }
  switch (msg) {
    case 'EXPERIENCE_PACK_NOT_FOUND':
      return makeFailure('NOT_FOUND', 'Experience Pack not found');
    case 'EXPERIENCE_PACK_ATTACHMENT_NOT_FOUND':
      return makeFailure('NOT_FOUND', 'Channel attachment not found');
    case 'CHANNEL_NOT_FOUND':
      return makeFailure('NOT_FOUND', 'Channel not found');
    case 'EXPERIENCE_PACK_CONCURRENT_MODIFICATION':
      return makeFailure('CONFLICT', 'Pack was modified concurrently; refresh and retry');
    default:
      return undefined;
  }
}

/** formalMemoryErrorAck 未识别时重新抛出，交给 socket 层兜底处理。 */
function rethrow(error: unknown): never {
  throw error;
}
