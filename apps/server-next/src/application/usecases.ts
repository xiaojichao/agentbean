import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, isLegacyHash, verifyLegacySha256, verifyPassword } from './password.js';
import { formalKindToStorageKind, makeFailure, makeSuccess, parseAgentCollaborationProposalV1, type Ack, type AdapterKind, type AgentArtifactSourceRootConfigDto, type AgentCollaborationProposalV1, type AgentDto, type AgentCategory, type DispatchMemoryContextItemDto, type AgentInvocationResultDto, type AgentMetricsSummary, type ArtifactDto, type ArtifactPreviewDto, type ArtifactSourceRootDto, type ChannelDocumentDto, type ChannelDocumentRevisionDto, type ChannelDto, type ChannelMembersDto, type ChannelFileEntryDto, type ChannelFileSourceDto, type ChannelFilesResultDto, type ChannelFileDirectoryDto, type ArtifactRole, type DeviceDetailDto, type DeviceDto, type DeviceInviteAckDto, type DeviceInviteCredentialsDto, type DeviceInviteDto, type DispatchAttachmentDto, type DispatchDto, type DispatchHistoryMessageDto, type DispatchRequestDto, type DmChannelDto, type HumanMemberDto, type ID, type JoinLinkDto, type MemoryContentKind, type MemoryGovernanceSnapshotDto, type MemoryKind, type MemoryRedactionLevel, type MemoryScopeType, type MessageDto, type MessageMetaDto, type RouteReason, type RuntimeDto, type ScanRequestCustomAgent, type SetAgentTeamVisibilityInput, type SkillDto, type TaskDagViewDto, type TaskDto, type TaskStatus, type TeamDto, type UnixMs, type UserDto, type WorkspaceRunDto, type WorkspaceRunStatus, type FormalMemoryDto, type FormalMemoryListDto, type FormalMemoryDetailDto, type FormalMemoryKind, type FormalMemoryScopeType, type SystemKnowledgeDto, type SystemKnowledgeDetailDto, type SystemKnowledgeListDto, type UserMemoryDto, type UserMemoryDetailDto, type UserMemoryListDto, type GetChannelDocumentInput, type ListChannelDocumentsInput, type ListChannelDocumentRevisionsInput, type SaveChannelDocumentInput, type RestoreChannelDocumentInput, type PublishChannelDocumentInput, type PublishChannelDocumentResultDto, type ChannelDocumentResultDto, type ChannelDocumentRevisionsResultDto } from '../../../../packages/contracts/src/index.js';
import { planMentionMigration } from './mention-migration.js';
import {
  initialChannelDocumentIds,
  isMarkdownArtifact,
  sanitizeMarkdownFilename,
} from './channel-document-policy.js';
import { canApplyChannelUpdate, channelHumanMembersForCreate, deriveManagementRunUsage, isDefaultChannel, normalizeAdapterKind, normalizeAgentName, normalizeMentionName, normalizePathForComparison, routeMessage, type RouteResult, canManageFormalMemory, canProposeFormalCorrection, canReadFormalMemory, canManageSystemKnowledge, canManageUserMemory, canReadSystemKnowledge, canReadUserMemory, evaluateTeamAgentMemoryOptIn } from '../../../../packages/domain/src/index.js';
import type { AgentExposureActiveProjectionDto, AgentExposureManifestRevisionDto, AgentExposureRestrictionDto, AgentTeamCoverageDto, CreateAgentExposureDraftInput, GetAgentExposureActiveInput, GetAgentTeamCoverageInput, ListAgentExposureRevisionsInput, PublishAgentExposureInput, RevokeAgentExposureInput, UpdateAgentExposureDraftInput, UpsertAgentExposureRestrictionInput } from '../../../../packages/contracts/src/index.js';
import type { AgentMemoryProjectionDto, CreateAgentMemoryProjectionDraftInput, GetConsumableAgentMemoryProjectionsInput, GetConsumableAgentMemoryProjectionsResult, ListAgentMemoryProjectionRevisionsInput, PublishAgentMemoryProjectionInput, TeamAgentMemoryOptInDto, UpdateAgentMemoryProjectionDraftInput, UpsertTeamAgentMemoryOptInInput, WithdrawAgentMemoryProjectionInput } from '../../../../packages/contracts/src/index.js';
import type { AgentConfigUpdate, AgentRecord, ArtifactRecord, ChannelDocumentRecord, ChannelDocumentRevisionRecord, ChannelRecord, DeviceInviteRecord, DeviceRecord, DispatchRecord, JoinLinkRecord, MessageRecord, ServerNextRepositories, UserRecord, WorkspaceRunRecord } from './repositories.js';
import { buildDeviceInviteCommand, DEVICE_SERVICE_OPERATION_COMMANDS } from './device-invite-command.js';
import { buildDaemonVersionInfo } from '../daemon-version.js';
import { createInvocationGateway } from './management/invocation-gateway.js';
import { createCollaborationService } from './management/collaboration-service.js';
import { appendManagementEventInTransaction, createManagementKernel } from './management/management-kernel.js';
import { createManagementRouter, type ManagementRoutingResult } from './management/management-router.js';
import { createTaskCoordinationKernel } from './management/task-coordination-kernel.js';
import { createMemorySourceInvalidationService } from './memory-source-invalidation-service.js';
import { createCollaborativeMemoryService, type MemoryView } from './collaborative-memory-service.js';
import { createMemoryCandidateService, type MemoryCandidateView } from './memory-candidate-service.js';
import { createMemoryGovernanceService } from './memory-governance-service.js';
import { createFormalMemoryService } from './formal-memory-service.js';
import { createSystemUserMemoryService } from './system-user-memory-service.js';
import { canReadMemoryCapsule, createServerMemoryCandidatePermissions, createServerMemoryWritePermissions } from './server-memory-permissions.js';
import type { MemoryGrantRecord } from './memory-repositories.js';
import type { ServerCapsuleRuntimeContextResolver } from './server-capsule-runtime-context-service.js';
import { createPiProviderService } from './pi-provider-service.js';
import { createAgentExposureService } from './agent-exposure-service.js';
import { createAgentMemoryProjectionService } from './agent-memory-projection-service.js';
import { createChannelCoordinator, type CoordinationCycleSummary, type CoordinationJobOutcome } from './channel-coordination-coordinator.js';
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

export interface ServerNextUseCases {
  registerUser(input: RegisterUserInput): Promise<Ack<RegisterUserResult>>;
  loginUser(input: LoginUserInput): Promise<Ack<LoginUserResult>>;
  whoami(input: WhoamiInput): Promise<Ack<WhoamiResult>>;
  changePassword(input: { userId: string; currentPassword: string; newPassword: string }): Promise<Ack<{}>>;
  listTeams(input: { userId: string }): Promise<Ack<ListTeamsResult>>;
  listAdminTeams(input: { userId: string }): Promise<Ack<{ teams: AdminTeamDto[] }>>;
  listAdminUsers(input: { userId: string }): Promise<Ack<{ users: AdminUserDto[] }>>;
  listAdminDevices(input: { userId: string }): Promise<Ack<{ devices: AdminDeviceDto[] }>>;
  listAdminAgents(input: { userId: string }): Promise<Ack<{ agents: AdminAgentDto[] }>>;
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
  deviceHello(input: DeviceHelloInput): Promise<Ack<{ device: DeviceDto; credentials?: DeviceInviteCredentialsDto; affectedTeamIds: string[] }>>;
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
  createChannel(input: CreateChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  updateChannel(input: UpdateChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  addChannelHumanMember(input: ChannelHumanMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  removeChannelHumanMember(input: ChannelHumanMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  leaveChannel(input: { teamId: ID; userId: ID; channelId: ID }): Promise<Ack<{ channel: ChannelDto }>>;
  addChannelAgentMember(input: ChannelAgentMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  removeChannelAgentMember(input: ChannelAgentMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  listChannelMembers(input: ListChannelMembersInput): Promise<Ack<ChannelMembersDto>>;
  archiveChannel(input: ArchiveChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  deleteChannel(input: DeleteChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  startDirectMessage(input: StartDirectMessageInput): Promise<Ack<{ dm: DmChannelDto }>>;
  listDirectMessages(input: ListDirectMessagesInput): Promise<Ack<{ dms: DmChannelDto[] }>>;
  snapshotDirectMessage(input: SnapshotDirectMessageInput): Promise<Ack<{ dm: DmChannelDto; messages: MessageDto[] }>>;
  registerAgent(input: AgentDto): Promise<Ack<{ agent: AgentDto }>>;
  sendMessage(input: SendMessageInput): Promise<Ack<SendMessageResult>>;
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
  listChannelDocuments(input: ListChannelDocumentsInput): Promise<Ack<{ documents: ChannelDocumentDto[] }>>;
  getChannelDocument(input: GetChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  listChannelDocumentRevisions(input: ListChannelDocumentRevisionsInput): Promise<Ack<ChannelDocumentRevisionsResultDto>>;
  saveChannelDocument(input: SaveChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  restoreChannelDocument(input: RestoreChannelDocumentInput): Promise<Ack<ChannelDocumentResultDto>>;
  publishChannelDocument(input: PublishChannelDocumentInput): Promise<Ack<PublishChannelDocumentResultDto>>;
  searchMessages(input: SearchMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  getMessageContext(input: GetMessageContextInput): Promise<Ack<{ targetMessageId: ID; messages: MessageDto[]; threadRootId?: ID }>>;
  convertMessageToTask(input: ConvertMessageToTaskInput): Promise<Ack<{ message: MessageDto; task: TaskDto }>>;
  listTasks(input: ListTasksInput): Promise<Ack<{ tasks: TaskDto[] }>>;
  getTaskDag(input: { userId: string; teamId: string; rootTaskId: string }): Promise<Ack<{ dag: TaskDagViewDto }>>;
  summarizeAgentMetrics(input: { userId: string; teamId: string }): Promise<Ack<{ summaries: AgentMetricsSummary[] }>>;
  createTask(input: CreateTaskInput): Promise<Ack<{ task: TaskDto }>>;
  updateTask(input: UpdateTaskInput): Promise<Ack<{ task: TaskDto; message?: MessageDto }>>;
  deleteTask(input: DeleteTaskInput): Promise<Ack<{ task: TaskDto }>>;
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
  failTimedOutDispatches(input: { olderThan: number }): Promise<Ack<{ dispatches: DispatchDto[]; tasks?: TaskDto[] }>>;
  receiveDispatchResult(input: ReceiveDispatchResultInput): Promise<Ack<ReceiveDispatchResultResult>>;
  receiveDispatchError(input: ReceiveDispatchErrorInput): Promise<Ack<ReceiveDispatchErrorResult>>;
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
  getManagementPolicy(input: { userId: string; teamId: string }): Promise<Ack<{ policy: import('./management-repositories.js').ManagementPolicyRecord; canManage: boolean }>>;
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
  updateManagementPolicy(input: { userId: string; teamId: string; mode: import('../../../../packages/contracts/src/index.js').ManagementMode; maxManagementPhase?: 1 | 2 | 3; placementPolicy?: import('../../../../packages/contracts/src/index.js').ManagerPlacementPolicyDto; budgetOverrides?: Partial<import('../../../../packages/contracts/src/index.js').ManagementBudgetDto> }): Promise<Ack<{ policy: import('./management-repositories.js').ManagementPolicyRecord; canManage: boolean }>>;
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

type AdminUserDto = UserDto & {
  createdAt: number;
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
}

export interface SendMessageResult {
  message: MessageDto;
  dispatches: DispatchDto[];
  route?: RouteResult;
  coalescedDispatchId?: string;
  task?: TaskDto;
  acknowledgementMessage?: MessageDto;
  management?: ManagementRoutingResult;
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
}

export interface DeviceUploadArtifactInput extends Omit<UploadArtifactInput, 'userId'> {
  token: string;
}

export interface DeviceGetArtifactInput {
  token: string;
  teamId: string;
  artifactId: string;
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
}

export interface ReceiveDispatchResultInput {
  dispatchId: string;
  agentId: string;
  body: string;
  artifactIds?: string[];
  artifacts?: ReceiveDispatchArtifactInput[];
  workspaceRun?: ReceiveDispatchWorkspaceRunInput;
  collaborationProposals?: readonly AgentCollaborationProposalV1[];
}

export interface ReceiveDispatchResultResult {
  dispatch: DispatchDto;
  message?: MessageDto;
  task?: TaskDto;
  collaborationProposalDiagnostics?: readonly string[];
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

export interface CreateServerNextUseCasesInput {
  repositories: ServerNextRepositories;
  clock: ServerNextClock;
  ids: ServerNextIds;
  joinCodes?: ServerNextJoinCodes;
  deviceInviteCodes?: ServerNextDeviceInviteCodes;
  sessionSecret?: string;
  artifactContentStore?: ArtifactContentStore;
  resolveArtifactPreview?: (artifact: ArtifactRecord) => Promise<ArtifactPreviewDto | undefined>;
  onArtifactCommitted?: (artifact: ArtifactRecord) => Promise<void>;
  managementRouter?: ReturnType<typeof createManagementRouter>;
  managementKernel?: ReturnType<typeof createManagementKernel>;
  taskCoordinationKernel?: ReturnType<typeof createTaskCoordinationKernel>;
  serverCapsuleRuntimeContextResolver?: ServerCapsuleRuntimeContextResolver;
  /** Production uses durable-job; legacy exists only for explicitly unmigrated callers. */
  messageIngestionMode?: 'legacy' | 'durable-job';
}

export function createServerNextUseCases(input: CreateServerNextUseCasesInput): ServerNextUseCases {
  const { repositories, clock, ids } = input;
  const joinCodes = input.joinCodes ?? { nextCode: generateJoinCode };
  const deviceInviteCodes = input.deviceInviteCodes ?? { nextCode: generateJoinCode };
  const sessionSecret = input.sessionSecret ?? 'agentbean-next-dev-session-secret';
  const artifactContentStore = input.artifactContentStore;
  const resolveArtifactPreview = input.resolveArtifactPreview;
  const onArtifactCommitted = input.onArtifactCommitted;
  // #706 已为 durable-job 入队接好 Channel Coordinator 消费者：消费 Job、调 Active PI Model、
  // 产出无副作用 Decision。生产默认仍走 legacy（rollout 待后续切换）；durable-job+Coordinator
  // 作为完整可用的可选路径，经 messageIngestionMode:'durable-job' 激活。
  const messageIngestionMode = input.messageIngestionMode ?? 'legacy';
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
    clock,
    ids,
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

  async function sendLegacyMessage(messageInput: SendMessageInput): Promise<Ack<SendMessageResult>> {
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
    const messageId = ids.nextId();
    const threadId = messageInput.threadId ?? messageId;
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
      channel,
      route,
      threadId: messageInput.threadId,
    });
    const taskId = shouldCreateTask ? ids.nextId() : undefined;
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
    const task = shouldCreateTask
      ? await repositories.tasks.create({
          id: taskId!, teamId: messageInput.teamId, title: messageInput.body.trim() || '附件',
          description: undefined,
          status: route.kind === 'dispatch' || coordinatedManagedRoot ? 'in_progress' : 'todo',
          creatorId: messageInput.userId,
          assigneeId: route.kind === 'dispatch' && !coordinatedManagedRoot ? route.agentId : undefined,
          channelId: messageInput.channelId, tags: [], sortOrder: now, createdAt: now, updatedAt: now,
        })
      : null;
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
    const message = await repositories.messages.append({
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
        ...(task ? { taskId: task.id } : {}),
        ...(mentions.length ? { mentions } : {}),
        routeReason: toRouteReason(route),
      },
    });
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
      await createInitialChannelDocuments(repositories, attachedArtifacts, messageInput.userId, now);
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
          ? { ...message, artifacts: attachedArtifacts.map(toArtifactDto) }
          : message,
        dispatches,
        route,
        ...(coalescedDispatchId ? { coalescedDispatchId } : {}),
        ...(task ? { task } : {}),
        ...(acknowledgementMessage ? { acknowledgementMessage } : {}),
        management,
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
      const teams = await repositories.teams.listAll();
      const result: AdminTeamDto[] = [];
      for (const team of teams) {
        result.push({
          ...team,
          members: await repositories.teams.listAllMembers(team.id),
        });
      }
      return makeSuccess({ teams: result });
    },

    async listAdminUsers(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      const users = await repositories.users.listAll();
      return makeSuccess({
        users: users.map((user) => ({
          ...toUserDto(user),
          email: user.email ?? null,
          createdAt: user.createdAt,
        })),
      });
    },

    async listAdminDevices(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      return makeSuccess({
        devices: await listAdminDeviceDtos(repositories),
      });
    },

    async listAdminAgents(adminInput) {
      const admin = await requireGlobalAdmin(repositories, adminInput.userId);
      if (!admin.ok) {
        return admin;
      }
      return makeSuccess({
        agents: await listAdminAgentDtos(repositories),
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
      if (adminInput.targetUserId === adminInput.adminUserId || adminInput.targetUserId === 'system') {
        return makeFailure('VALIDATION_ERROR', 'Cannot delete protected user');
      }
      const user = await repositories.users.getById(adminInput.targetUserId);
      if (!user) {
        return makeFailure('NOT_FOUND', 'User not found');
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

      return makeSuccess({
        device: await toDeviceDtoWithOwnerName(repositories, device),
        affectedTeamIds: uniqueIds(affectedTeamIds),
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
      if (!canApplyChannelUpdate(channel, channelInput.userId, updateIntent)) {
        return makeFailure('FORBIDDEN', 'User cannot manage channel');
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
      const updated = await repositories.channels.update({
        channelId: channel.channel.id,
        changes: {
          agentMemberIds: channel.channel.agentMemberIds.filter((agentId) => agentId !== memberInput.agentId),
          updatedAt: clock.now(),
        },
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      return makeSuccess({ channel: updated });
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
      const archived = await repositories.channels.archive({
        channelId: channel.id,
        timestamp: now,
      });
      if (!archived) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      return makeSuccess({ channel: archived });
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
      if (!canApplyChannelUpdate(channel, deleteInput.userId, {})) {
        return makeFailure('FORBIDDEN', 'Only channel creator can delete');
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

    async sendMessage(messageInput) {
      if (messageIngestionMode === 'legacy') return sendLegacyMessage(messageInput);
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

      const clientIdempotencyKey = messageInput.clientMessageId
        ? `client:${messageInput.teamId}:${messageInput.clientMessageId}`
        : null;
      const outcome = await repositories.piProviderUnitOfWork.run(async (piRepositories) => {
        const active = await piRepositories.activeModel.get();
        const revision = active ? await piRepositories.revisions.getById(active.revisionId) : null;
        const activeModel = active && revision?.status === 'published' && revision.cardId === active.cardId
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
              && (!messageInput.threadId || existingMessage.threadId === messageInput.threadId);
            if (!sameRequest) return { kind: 'conflict' as const };
            const replayArtifacts = await transaction.artifacts.listByMessage(existingMessage.id);
            return { kind: 'saved' as const, message: existingMessage, artifacts: replayArtifacts };
          }

          const messageId = messageInput.messageId ?? ids.nextId();
          const jobId = ids.nextId();
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
            },
          });
          const attachedArtifacts: ArtifactRecord[] = [];
          for (const artifact of attachmentResult.artifacts) {
            attachedArtifacts.push(await transaction.artifacts.create({ ...artifact, messageId }));
          }
          await transaction.jobs.create({
            id: jobId,
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
          return { kind: 'saved' as const, message, artifacts: attachedArtifacts };
        });
      });

      if (outcome.kind === 'conflict') {
        return makeFailure('CONFLICT', 'Client message id was already used for a different message');
      }

      await createInitialChannelDocuments(repositories, outcome.artifacts, messageInput.userId, now);

      const message = outcome.artifacts.length > 0
        ? { ...outcome.message, artifacts: outcome.artifacts.map(toArtifactDto) }
        : outcome.message;
      return makeSuccess({ message, dispatches: [] });
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

      const request = await buildDispatchRequest(
        repositories, dispatch, agent, now, true, input.serverCapsuleRuntimeContextResolver,
      );
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
      return listPublicChannelFiles(repositories, fileInput, resolveArtifactPreview);
    },

    async searchChannelFiles(fileInput) {
      return listPublicChannelFiles(repositories, fileInput, resolveArtifactPreview);
    },

    async listChannelDocuments(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      let records = await repositories.channelDocuments.listWithCurrentRevisionByChannel(documentInput);
      const knownDocumentIds = new Set(records.map(({ document }) => document.id));
      const artifacts = await repositories.artifacts.listByChannel(documentInput);
      const missingDocuments = artifacts.filter((artifact) =>
        Boolean(artifact.messageId || artifact.workspaceRunId)
        && isMarkdownArtifact(artifact)
        && !knownDocumentIds.has(`channel-document:${artifact.id}`));
      if (missingDocuments.length > 0) {
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
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      return makeSuccess({ document: await toChannelDocumentDto(repositories, document) });
    },

    async listChannelDocumentRevisions(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const revisions = await repositories.channelDocuments.listRevisions({ documentId: document.id });
      return makeSuccess({
        document: await toChannelDocumentDto(repositories, document),
        revisions: revisions.map(toChannelDocumentRevisionDto),
      });
    },

    async saveChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      return commitChannelDocumentRevision({
        repositories, artifactContentStore, clock, ids, document, input: documentInput,
        operationType: 'save', source: 'edit',
      });
    },

    async restoreChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const sourceRevision = await repositories.channelDocuments.getRevision({
        documentId: document.id,
        revisionId: documentInput.revisionId,
      });
      if (!sourceRevision) return makeFailure('NOT_FOUND', 'Channel document revision not found');
      return commitChannelDocumentRevision({
        repositories, artifactContentStore, clock, ids, document, input: documentInput,
        operationType: 'restore', source: 'restore', sourceRevision,
      });
    },

    async publishChannelDocument(documentInput) {
      const access = await ensureUserCanViewChannel(repositories, documentInput);
      if (!access.ok) return access;
      if (access.channel.archivedAt != null) return makeFailure('FORBIDDEN', 'Archived channels are read-only');
      const document = await getOrCreateChannelDocument(repositories, documentInput);
      if (!document) return makeFailure('NOT_FOUND', 'Channel document not found');
      const result = await commitChannelDocumentRevision({
        repositories, artifactContentStore, clock, ids, document, input: documentInput,
        operationType: 'publish', source: 'edit',
      });
      if (!result.ok) return result;
      if (!result.message) throw new Error('Published channel document is missing its message');
      return makeSuccess({
        document: result.document,
        message: {
          ...result.message,
          artifacts: [result.document.currentRevision.artifact],
        },
      });
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
      let managedCompletion: { managementRunId: string; deliveryMessageId: string } | null = null;
      if (taskInput.status === 'in_progress' && task.status === 'in_review') {
        const managementRun = await repositories.management.runs.getByRootTaskId(task.id);
        const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
        if (managementRun && coordination?.nodeKind === 'root'
          && coordination.managementRunId === managementRun.id) {
          await taskCoordinationKernel.reopenRootTaskFromHuman({
            managementRunId: managementRun.id,
            taskId: task.id,
            userId: taskInput.userId,
            expectedTaskRevision: task.revision,
          });
        }
      }
      if (taskInput.status === 'done' && task.status !== 'done') {
        const managementRun = await repositories.management.runs.getByRootTaskId(task.id);
        if (managementRun) {
          if (managementRun.status !== 'in_review' && managementRun.status !== 'completed') {
            return makeFailure('CONFLICT', 'Managed Task is not ready for human completion');
          }
          const events = await repositories.management.events.list(managementRun.id);
          const deliveryEvent = [...events].reverse()
            .find(({ event }) => event.type === 'root-delivery-submitted');
          if (!deliveryEvent || deliveryEvent.event.type !== 'root-delivery-submitted') {
            return makeFailure('CONFLICT', 'Managed Task has no review delivery');
          }
          managedCompletion = { managementRunId: managementRun.id, deliveryMessageId: deliveryEvent.event.payload.messageId };
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
      if (managedCompletion) {
        await managementKernel.completeRunFromHumanTask({
          managementRunId: managedCompletion.managementRunId,
          taskId: updated.id,
          userId: taskInput.userId,
          deliveryMessageId: managedCompletion.deliveryMessageId,
        });
      }
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
      if (!(await repositories.teams.isMember(artifactInput.teamId, artifactInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channelAccess = await ensureUserCanViewChannel(repositories, {
        userId: artifactInput.userId,
        teamId: artifactInput.teamId,
        channelId: artifactInput.channelId,
      });
      if (!channelAccess.ok) {
        return channelAccess;
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
      const actor = await resolveDeviceTokenActor(repositories, sessionSecret, artifactInput);
      if (!actor.ok) {
        return actor;
      }
      return this.uploadArtifact({
        ...artifactInput,
        userId: actor.userId,
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
      const actor = await resolveDeviceTokenActor(repositories, sessionSecret, artifactInput);
      if (!actor.ok) {
        return actor;
      }
      return this.getArtifactFile({
        userId: actor.userId,
        teamId: artifactInput.teamId,
        artifactId: artifactInput.artifactId,
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
      const pending = await repositories.dispatches.listPendingOlderThan(timeoutInput.olderThan);
      const dispatches: DispatchDto[] = [];
      const tasks: TaskDto[] = [];
      for (const dispatch of pending) {
        if (!isPendingDispatchStatus(dispatch.status)) {
          continue;
        }
        const managedAttempt = await repositories.management.dispatchAttempts.getByDispatchId(dispatch.id);
        const timedOut = managedAttempt
          ? await invocationGateway.completeAttempt({ dispatchId: dispatch.id, status: 'timed_out', error: 'DISPATCH_TIMEOUT' })
          : await repositories.dispatches.markTimedOut({ dispatchId: dispatch.id, error: 'DISPATCH_TIMEOUT', completedAt: now });
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
              errorCode: 'DISPATCH_TIMEOUT',
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

    async receiveDispatchResult(resultInput) {
      const dispatch = await repositories.dispatches.getById(resultInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (dispatch.agentId !== resultInput.agentId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to agent');
      }
      if (!isCompletableDispatchStatus(dispatch.status)) {
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
      const message = publishResult ? await repositories.messages.append({
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
      await createInitialChannelDocuments(repositories, committedArtifacts, resultInput.agentId, now);
      // The real-time broadcast of this agent reply goes straight to the chat view, so the internal
      // workspace-run.log must be stripped here too — matching enrichMessagesWithArtifacts. The log
      // stays persisted (created above) and is served by the workspace-run detail endpoint.
      const chatArtifacts = artifacts.filter((artifact) => !isWorkspaceRunLogArtifact(artifact));
      const messageWithArtifacts: MessageDto | null = message ? {
        ...message,
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
      const failed = managedAttempt
        ? await invocationGateway.completeAttempt({ dispatchId: errorInput.dispatchId, status: 'failed', error: errorInput.error, actorKind: 'agent', actorId: errorInput.agentId })
        : await repositories.dispatches.markFailed({ dispatchId: errorInput.dispatchId, error: errorInput.error, completedAt: now });
      if (!failed) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (!failed.changed) {
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      await markAgentOfflineIfIdle(repositories, {
        agentId: errorInput.agentId,
        teamId: failed.dispatch.teamId,
        lastSeenAt: now,
        lastError: errorInput.error,
      });
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

    async getManagementPolicy(policyInput) {
      const result = await managementRouter.getPolicy(policyInput);
      return result.ok
        ? makeSuccess({ policy: result.policy, canManage: result.canManage })
        : makeFailure('FORBIDDEN', 'Management policy is not available');
    },

    async updateManagementPolicy(policyInput) {
      const result = await managementRouter.updatePolicy(policyInput);
      return result.ok
        ? makeSuccess({ policy: result.policy, canManage: result.canManage })
        : makeFailure(result.error === 'FORBIDDEN' ? 'FORBIDDEN' : 'VALIDATION_ERROR', 'Management policy update rejected');
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

async function isPublicWorkspaceRun(
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

async function listAdminDeviceDtos(repositories: ServerNextRepositories): Promise<AdminDeviceDto[]> {
  const devices = await repositories.devices.listAll();
  const result: AdminDeviceDto[] = [];
  for (const device of devices) {
    result.push(await toAdminDeviceDto(repositories, device));
  }
  return result;
}

async function listAdminAgentDtos(repositories: ServerNextRepositories): Promise<AdminAgentDto[]> {
  const [agents, devices, users, teams] = await Promise.all([
    repositories.agents.listAll(),
    repositories.devices.listAll(),
    repositories.users.listAll(),
    repositories.teams.listAll(),
  ]);
  const devicesById = new Map(devices.map((device) => [device.id, device]));
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
    enriched.push({
      ...message,
      ...(artifacts.length > 0 ? { artifacts: artifacts.map(toArtifactDto) } : {}),
      ...(workspaceRun ? { workspaceRun } : {}),
      ...(chosenDispatch ? { dispatchStatus: chosenDispatch.status, dispatchId: chosenDispatch.id } : {}),
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

async function buildDispatchRequest(
  repositories: ServerNextRepositories,
  dispatch: DispatchRecord,
  agent: AgentRecord,
  now: UnixMs,
  includeRuntimeMemory: boolean,
  serverCapsuleRuntimeContextResolver?: ServerCapsuleRuntimeContextResolver,
): Promise<DispatchRequestDto & { id: string }> {
  const executionConfig = agent.source === 'custom' || (agent.source === 'scanned' && agent.command)
    ? await repositories.agents.getExecutionConfig(agent.id)
    : null;
  const originMessage = await repositories.messages.getById(dispatch.messageId);
  const managementAttempt = await repositories.management.dispatchAttempts.getByDispatchId(dispatch.id);
  const managementInvocation = managementAttempt
    ? await repositories.management.invocations.getById(managementAttempt.invocationId)
    : null;
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
  const attachments: ArtifactRecord[] = [];
  if (managementInvocation) {
    for (const artifactId of uniqueIds([...managementInvocation.intent.attachmentIds])) {
      const artifact = await repositories.artifacts.getForTeam({ teamId: dispatch.teamId, artifactId });
      if (artifact?.channelId === dispatch.channelId) attachments.push(artifact);
    }
  } else {
    const attachmentMessageIds = promptMessages.length > 0
      ? promptMessages.map((message) => message.id)
      : [dispatch.messageId];
    for (const messageId of attachmentMessageIds) {
      attachments.push(...await repositories.artifacts.listByMessage(messageId));
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
    prompt: requestPrompt,
    history: dispatchHistory.map(toDispatchHistoryMessageDto),
    ...(attachments.length > 0 ? { attachments: attachments.map(toDispatchAttachmentDto) } : {}),
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
  return /^[A-Za-z0-9_-]{1,128}$/.test(sourceRoot.id)
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
  const bodyStart = input.body.length - input.body.trimStart().length;
  const structuredLeadingMention = input.mentions?.find((mention) => mention.start === bodyStart);
  if (structuredLeadingMention?.kind === 'human') {
    return { kind: 'no-dispatch', reason: 'human-mention' };
  }
  if (structuredLeadingMention?.kind === 'agent') {
    const targetAgent = input.visibleAgents.find((agent) => agent.id === structuredLeadingMention.id);
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
      ? input.visibleAgents.map((agent) => canQueueForBusyAgent(agent)
          ? { ...agent, status: 'online' as const }
          : agent)
      : input.visibleAgents,
    humanMembers: [],
    teamId: input.teamId,
    channelId: input.channel.id,
  });
  if ((route.kind === 'dispatch' && route.reason === 'mention') || (route.kind === 'no-dispatch' && route.reason !== 'no-online-agent')) {
    if (route.kind !== 'dispatch') {
      return route;
    }
    const agent = input.visibleAgents.find((candidate) => candidate.id === route.agentId);
    return agent && isSocketReachable(agent)
      ? route
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  const contextOwner = input.contextOwner;
  if (contextOwner?.kind === 'human') {
    return { kind: 'no-dispatch', reason: 'human-assignee' };
  }
  if (contextOwner?.kind === 'agent') {
    const contextAgent = input.visibleAgents.find((agent) => agent.id === contextOwner.agentId);
    return contextAgent && isDispatchEligibleAgent(contextAgent, input) && isSocketReachable(contextAgent)
      ? { kind: 'dispatch', agentId: contextAgent.id, reason: 'fallback' }
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
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
  return true;
}

function shouldAutoCreateTaskThread(input: {
  body: string;
  channel: ChannelRecord;
  route: RouteResult;
  threadId?: string;
}): boolean {
  if (input.threadId || input.channel.kind === 'direct' || input.route.kind !== 'dispatch') {
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

async function markAgentOfflineIfIdle(
  repositories: ServerNextRepositories,
  input: { agentId: ID; teamId: ID; lastSeenAt: UnixMs; lastError: string },
): Promise<void> {
  if (await hasPendingDispatchForAgent(repositories, input)) {
    return;
  }
  await repositories.agents.updateStatus({
    agentId: input.agentId,
    status: 'offline',
    lastSeenAt: input.lastSeenAt,
    lastError: input.lastError,
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
  return status === 'todo' || status === 'in_progress' || status === 'in_review' || status === 'done' || status === 'closed';
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

async function ensureUserCanViewChannel(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; channelId: string },
): Promise<Ack<{ channel: ChannelDto & { humanMemberIds: string[]; agentMemberIds: string[] } }>> {
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) {
    return makeFailure('NOT_FOUND', 'Channel not found');
  }
  if (channel.visibility === 'private' && !channel.humanMemberIds.includes(input.userId)) {
    return makeFailure('FORBIDDEN', 'User cannot view channel');
  }
  return makeSuccess({ channel });
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
  const contentInput = 'content' in documentInput ? documentInput.content : undefined;
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
  const latestRevision = (await repositories.channelDocuments.listRevisions({ documentId: document.id }))[0];
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
): Promise<ChannelDocumentRecord | null> {
  const existing = await repositories.channelDocuments.getForTeam(input);
  if (existing) return existing;
  const prefix = 'channel-document:';
  if (!input.documentId.startsWith(prefix)) return null;
  const artifactId = input.documentId.slice(prefix.length);
  if (!artifactId) return null;
  const artifact = await repositories.artifacts.getForTeam({ teamId: input.teamId, artifactId });
  if (!artifact || artifact.channelId !== input.channelId) return null;
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
): Promise<Ack<ChannelFilesResultDto>> {
  if (!(await repositories.teams.isMember(input.teamId, input.userId))) {
    return makeFailure('FORBIDDEN', 'User is not a team member');
  }
  const channelAccess = await ensureUserCanViewChannel(repositories, input);
  if (!channelAccess.ok) return channelAccess;

  const cursor = decodeChannelFileCursor(input.cursor);
  if (input.cursor && !cursor) return makeFailure('VALIDATION_ERROR', 'Invalid channel file cursor');
  const query = 'query' in input ? input.query.trim().toLocaleLowerCase() : '';
  if ('query' in input && query.length < 1) return makeFailure('VALIDATION_ERROR', 'File search query is required');
  const requestedPath = normalizeChannelFilePath(input.path);
  if (requestedPath === null) return makeFailure('VALIDATION_ERROR', 'Invalid channel file path');
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize ?? 50)));
  const candidates = await repositories.artifacts.listByChannel({ teamId: input.teamId, channelId: input.channelId });
  const entries: ChannelFileEntryDto[] = [];
  const directories = new Map<string, ChannelFileDirectoryDto>();
  for (const artifact of candidates) {
    if (isWorkspaceRunLogArtifact(artifact)) continue;
    const role = artifact.role ?? (artifact.messageId ? 'attachment' : 'run_output');
    if (input.role && input.role !== 'all' && role !== input.role) continue;
    if (!(await isPublicChannelFileArtifact(repositories, artifact))) continue;
    const source = await channelFileSource(repositories, artifact);
    if (!source) continue;
    const logicalPath = channelArtifactLogicalPath(artifact, source, role);
    if (query && !`${artifact.filename} ${logicalPath}`.toLocaleLowerCase().includes(query)) continue;
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
  const { deletedAt: _deletedAt, nameSource: _nameSource, ...publicAgent } = agent;
  return publicAgent;
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

/** formalMemoryErrorAck 未识别时重新抛出，交给 socket 层兜底处理。 */
function rethrow(error: unknown): never {
  throw error;
}
