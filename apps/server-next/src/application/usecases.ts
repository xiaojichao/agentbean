import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashPassword, isLegacyHash, verifyLegacySha256, verifyPassword } from './password.js';
import { makeFailure, makeSuccess, type Ack, type AdapterKind, type AgentDto, type AgentCategory, type AgentMetricsSummary, type ArtifactDto, type ChannelDto, type ChannelMembersDto, type DeviceDetailDto, type DeviceDto, type DeviceInviteAckDto, type DeviceInviteCredentialsDto, type DeviceInviteDto, type DispatchAttachmentDto, type DispatchDto, type DispatchHistoryMessageDto, type DispatchRequestDto, type DmChannelDto, type HumanMemberDto, type ID, type JoinLinkDto, type MessageDto, type RouteReason, type RuntimeDto, type SetAgentTeamVisibilityInput, type TaskDto, type TaskStatus, type TeamDto, type UnixMs, type UserDto, type WorkspaceRunDto, type WorkspaceRunStatus } from '../../../../packages/contracts/src/index.js';
import { canApplyChannelUpdate, channelHumanMembersForCreate, isDefaultChannel, normalizeAdapterKind, normalizeAgentName, normalizePathForComparison, routeMessage, type RouteResult } from '../../../../packages/domain/src/index.js';
import type { AgentConfigUpdate, AgentRecord, ArtifactRecord, ChannelRecord, DeviceInviteRecord, DeviceRecord, JoinLinkRecord, MessageRecord, ServerNextRepositories, UserRecord, WorkspaceRunRecord } from './repositories.js';
import { buildDeviceInviteCommand } from './device-invite-command.js';
import { buildDaemonVersionInfo } from '../daemon-version.js';

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
}

export interface ServerNextUseCases {
  registerUser(input: RegisterUserInput): Promise<Ack<RegisterUserResult>>;
  loginUser(input: LoginUserInput): Promise<Ack<LoginUserResult>>;
  whoami(input: WhoamiInput): Promise<Ack<WhoamiResult>>;
  changePassword(input: { userId: string; currentPassword: string; newPassword: string }): Promise<Ack<{}>>;
  listTeams(input: { userId: string }): Promise<Ack<ListTeamsResult>>;
  listAdminTeams(input: { userId: string }): Promise<Ack<{ teams: AdminTeamDto[] }>>;
  listAdminNetworks(input: { userId: string }): Promise<Ack<{ networks: AdminTeamDto[] }>>;
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
  listDevices(input: { teamId: string; userId: string }): Promise<Ack<{ devices: DeviceDto[] }>>;
  listDeviceAgents(input: { teamId: string; userId: string; deviceId: string }): Promise<Ack<{ agents: DeviceAgentListDto[]; runtimes: RuntimeDto[] }>>;
  getDevice(input: { userId: string; deviceId: string }): Promise<Ack<{ device: DeviceDetailDto }>>;
  renameDevice(input: { userId: string; deviceId: string; hostname: string }): Promise<Ack<{ device: DeviceDto }>>;
  deleteDevice(input: { userId: string; deviceId: string }): Promise<Ack<{ device: DeviceDto; affectedTeamIds: string[]; channelTeamIds: string[] }>>;
  requestDeviceScan(input: RequestDeviceScanInput): Promise<Ack<RequestDeviceScanResult>>;
  deviceHello(input: DeviceHelloInput): Promise<Ack<{ device: DeviceDto; credentials?: DeviceInviteCredentialsDto; affectedTeamIds: string[] }>>;
  markDeviceOffline(input: { deviceId: string; timestamp: UnixMs }): Promise<Ack<{ device: DeviceDto; affectedTeamIds: string[] }>>;
  reconcileDisconnectedDevices(input: { timestamp: UnixMs }): Promise<Ack<{ devices: DeviceDto[]; affectedTeamIds: string[] }>>;
  reportDeviceRuntimes(input: ReportDeviceRuntimesInput): Promise<Ack<{ runtimes: RuntimeDto[] }>>;
  registerDiscoveredAgents(input: RegisterDiscoveredAgentsInput): Promise<Ack<RegisterDiscoveredAgentsResult>>;
  listVisibleAgents(input: { teamId: string }): Promise<Ack<{ agents: AgentDto[] }>>;
  createCustomAgent(input: CreateCustomAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  publishAgent(input: PublishAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  unpublishAgent(input: UnpublishAgentInput): Promise<Ack<{ agent: AgentDto }>>;
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
  getDispatchRequest(input: { dispatchId: string }): Promise<Ack<{ request: DispatchRequestDto & { id: string } }>>;
  cancelDispatch(input: CancelDispatchInput): Promise<Ack<{ dispatch: DispatchDto }>>;
  listChannelMessages(input: ListChannelMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  searchMessages(input: SearchMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  listTasks(input: ListTasksInput): Promise<Ack<{ tasks: TaskDto[] }>>;
  summarizeAgentMetrics(input: { userId: string; teamId: string }): Promise<Ack<{ summaries: AgentMetricsSummary[] }>>;
  createTask(input: CreateTaskInput): Promise<Ack<{ task: TaskDto }>>;
  updateTask(input: UpdateTaskInput): Promise<Ack<{ task: TaskDto }>>;
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
  failTimedOutDispatches(input: { olderThan: number }): Promise<Ack<{ dispatches: DispatchDto[] }>>;
  receiveDispatchResult(input: ReceiveDispatchResultInput): Promise<Ack<ReceiveDispatchResultResult>>;
  receiveDispatchError(input: ReceiveDispatchErrorInput): Promise<Ack<ReceiveDispatchErrorResult>>;
  reactMessage(input: ReactMessageInput): Promise<Ack<{ messageId: string }>>;
  saveMessage(input: SaveMessageInput): Promise<Ack<{ messageId: string }>>;
  listSavedMessages(input: ListSavedMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  updateMemberRole(input: UpdateMemberRoleInput): Promise<Ack<{ member: { id: string; teamId: string; userId: string; username: string; role: string } }>>;
  removeMember(input: RemoveMemberInput): Promise<Ack<{ userId: string }>>;
  transferOwner(input: TransferOwnerInput): Promise<Ack<{ team: { id: string; name: string }; member: { id: string; teamId: string; userId: string; username: string; role: string } }>>;
  listMembers(input: ListMembersInput): Promise<Ack<{ humans: Array<{ id: string; teamId: string; userId: string; username: string; role: string; displayName?: string; joinedAt: number }>; agents: any[] }>>;
  getAgentEnvForDevice(input: { token: string; teamId: string; agentId: string }): Promise<Ack<{ env: Record<string, string> }>>;
  updateMemberHuman(input: UpdateMemberHumanInput): Promise<Ack<{ human: { id: string; teamId: string; userId: string; username: string; role: string; displayName?: string; joinedAt: number } }>>;
  updateTeam(input: UpdateTeamInput): Promise<Ack<{ team: { id: string; name: string; path: string } }>>;
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
  networkId: string;
  publishedNetworkIds: string[];
  unpublishedNetworkIds: string[];
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
  networkId: string;
  networkName: string;
  ownerName?: string | null;
  userName?: string | null;
  deviceName?: string;
  deviceUserId?: string | null;
  deviceUserName?: string | null;
  publishedNetworkIds: string[];
  unpublishedNetworkIds: string[];
};

type AdminDeviceDto = DeviceDto & {
  userId: string;
  userName: string;
  networkId: string;
  networkName: string;
  agentCount: number;
  runtimes: RuntimeDto[];
  publicAgents: AdminAgentDto[];
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
}

export interface WhoamiResult {
  user: UserDto;
  currentTeam: TeamDto;
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
}

export interface DeviceHelloInput {
  teamId: string;
  ownerId: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: DeviceDto['systemInfo'];
}

export interface RequestDeviceScanInput {
  userId: string;
  deviceId: string;
}

export interface RequestDeviceScanResult {
  request: {
    requestId: string;
    deviceId: string;
  };
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
}

export interface PublishAgentInput {
  userId: string;
  teamId: string;
  agentId: string;
  targetTeamId: string;
}

export interface UnpublishAgentInput {
  userId: string;
  teamId: string;
  agentId: string;
  targetTeamId: string;
}

export interface UpdateAgentConfigInput {
  userId: string;
  teamId: string;
  agentId: string;
  runtimeId?: string;
  name?: string;
  description?: string;
  adapterKind?: AdapterKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
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
  threadId?: string;
  body: string;
  artifactIds?: string[];
  clientMessageId?: string;
  senderId?: string;
  senderKind?: string;
}

export interface SendMessageResult {
  message: MessageDto;
  dispatches: DispatchDto[];
  route: RouteResult;
}

export interface ListChannelMessagesInput {
  channelId: string;
  limit: number;
}

export interface SearchMessagesInput {
  userId: string;
  teamId: string;
  query: string;
  limit?: number;
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
}

export interface ReceiveDispatchResultResult {
  dispatch: DispatchDto;
  message: MessageDto;
}

export interface ReceiveDispatchErrorInput {
  dispatchId: string;
  agentId: string;
  error: string;
  retryable?: boolean;
}

export interface ReceiveDispatchErrorResult {
  dispatch: DispatchDto;
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
}

export function createServerNextUseCases(input: CreateServerNextUseCasesInput): ServerNextUseCases {
  const { repositories, clock, ids } = input;
  const joinCodes = input.joinCodes ?? { nextCode: generateJoinCode };
  const deviceInviteCodes = input.deviceInviteCodes ?? { nextCode: generateJoinCode };
  const sessionSecret = input.sessionSecret ?? 'agentbean-next-dev-session-secret';
  const artifactContentStore = input.artifactContentStore;

  return {
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
      return makeSuccess({
        user: { ...toUserDto(user), primaryTeamId: currentTeam.id },
        currentTeam: toTeamDto(currentTeam, currentTeam.currentUserRole),
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

    async listAdminNetworks(adminInput) {
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
      return makeSuccess({ networks: result });
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
        expiresAt: inviteInput.expiresAt,
        profileId: inviteInput.profileId,
      });

      return makeSuccess({
        invite: toDeviceInviteDto(invite, buildDeviceInviteCommand(invite.code, invite.profileId ?? team.path)),
        team: toTeamDto(team, role),
      });
    },

    async waitForDeviceInvite(inviteInput) {
      const usable = await getUsableDeviceInvite(repositories, clock, inviteInput.code);
      if (!usable.ok) {
        return usable;
      }
      const team = await repositories.teams.getById(usable.invite.teamId);
      if (!team) {
        return makeFailure('INVITE_INVALID', 'Device invite team no longer exists');
      }
      const updated = await repositories.deviceInvites.updateWaiter({
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
      const usable = await getUsableDeviceInvite(repositories, clock, inviteInput.code);
      if (!usable.ok) {
        return usable;
      }
      const team = await repositories.teams.getById(usable.invite.teamId);
      if (!team) {
        return makeFailure('INVITE_INVALID', 'Device invite team no longer exists');
      }
      const role = await repositories.teams.getMemberRole(team.id, inviteInput.userId);
      if (!role) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const completed = await repositories.deviceInvites.complete({
        code: usable.invite.code,
        completedAt: clock.now(),
        serverUrl: inviteInput.serverUrl,
      });
      if (!completed) {
        return makeFailure('INVITE_ALREADY_USED', 'Device invite has already been used');
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
      return this.deviceHello({
        teamId: credentials.teamId,
        ownerId: credentials.ownerId,
        machineId: deviceInput.machineId ?? credentials.machineId,
        profileId: deviceInput.profileId ?? credentials.profileId,
        hostname: deviceInput.hostname ?? credentials.hostname,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
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

      let connectCommand = existing?.connectCommand;
      if (!existing && connectCommand === undefined && deviceInput.machineId && deviceInput.profileId) {
        const invite = await repositories.deviceInvites.findCompletedByMachineProfile({
          teamId: deviceInput.teamId,
          machineId: deviceInput.machineId,
          profileId: deviceInput.profileId,
        });
        if (invite) {
          const team = await repositories.teams.getById(deviceInput.teamId);
          connectCommand = buildDeviceInviteCommand(invite.code, invite.profileId ?? team?.path, invite.serverUrl);
        }
      }

      const device = await repositories.devices.upsertHello({
        id: existing?.id ?? ids.nextId(),
        teamId: deviceInput.teamId,
        ownerId,
        status: 'online',
        name: deviceInput.hostname,
        machineId: deviceInput.machineId,
        profileId: deviceInput.profileId,
        canonicalDeviceId,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
        connectCommand,
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
        if (agent.source !== 'custom' || agent.status === 'online') {
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
            hostname: device.name,
          }, sessionSecret),
          teamId: device.teamId,
          ownerId: device.ownerId,
          deviceId: device.id,
          machineId: device.machineId,
          profileId: device.profileId,
          hostname: device.name,
        },
      });
    },

    async listDevices(deviceListInput) {
      if (!(await repositories.teams.isMember(deviceListInput.teamId, deviceListInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const devices = await repositories.devices.listByTeam(deviceListInput.teamId);
      return makeSuccess({
        devices: await toDeviceDtosWithOwnerNames(repositories, dedupeDeviceRecords(devices)),
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
          ...(await toDeviceDtoWithOwnerName(repositories, canonicalDevice)),
          runtimes: (await repositories.runtimes.listByDevice(canonicalDevice.id)).map(toRuntimeDto),
          agents: hostedAgents.map((agent) => toDeviceAgentListDto(agent, canonicalDevice)),
        },
      });
    },

    async renameDevice(renameInput) {
      const device = await repositories.devices.getById(renameInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, renameInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const updated = await repositories.devices.updateName({
        deviceId: device.id,
        hostname: renameInput.hostname,
        updatedAt: clock.now(),
      });
      if (!updated) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      return makeSuccess({ device: await toDeviceDtoWithOwnerName(repositories, updated) });
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
      const actor = await repositories.users.getById(deleteInput.userId);
      const isSystemAdmin = actor?.role === 'admin';
      if (!isSystemAdmin && device.ownerId !== deleteInput.userId && actorRole !== 'owner' && actorRole !== 'admin') {
        return makeFailure('FORBIDDEN', 'User cannot manage device');
      }
      const now = clock.now();
      const hostedAgents = await repositories.agents.listByDevice(device.id);
      const affectedTeamIds = uniqueIds([
        device.teamId,
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
      await repositories.devices.delete({ deviceId: device.id, timestamp: now });
      return makeSuccess({ device: await toDeviceDtoWithOwnerName(repositories, device), affectedTeamIds, channelTeamIds: affectedTeamIds });
    },

    async requestDeviceScan(scanInput) {
      const device = await repositories.devices.getById(scanInput.deviceId);
      if (!device) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(device.teamId, scanInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      if (device.status !== 'online') {
        return makeFailure('DEVICE_OFFLINE', 'Device is not online');
      }

      return makeSuccess({
        request: {
          requestId: ids.nextId(),
          deviceId: device.id,
        },
      });
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
        agents.push(agent);
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
      return makeSuccess({ agents: await repositories.agents.listVisibleInTeam(listInput.teamId) });
    },

    async createCustomAgent(agentInput) {
      const device = await repositories.devices.getById(agentInput.deviceId);
      if (!device || device.teamId !== agentInput.teamId) {
        return makeFailure('NOT_FOUND', 'Device not found');
      }
      if (!(await repositories.teams.isMember(agentInput.teamId, agentInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
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

    async publishAgent(agentInput) {
      const managed = await agentForManagement(repositories, agentInput);
      if (!managed.ok) {
        return managed;
      }
      if (!(await repositories.teams.getById(agentInput.targetTeamId))) {
        return makeFailure('NOT_FOUND', 'Target team not found');
      }
      if (!(await repositories.teams.isMember(agentInput.targetTeamId, agentInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a target team member');
      }
      if (agentInput.targetTeamId === managed.agent.primaryTeamId) {
        return makeFailure('VALIDATION_ERROR', 'Cannot publish agent to its primary team');
      }
      const agent = await repositories.agents.publish({
        agentId: managed.agent.id,
        teamId: agentInput.targetTeamId,
        publishedBy: agentInput.userId,
        timestamp: clock.now(),
      });
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      await ensureDefaultChannelMembership(repositories, clock, {
        teamId: agentInput.targetTeamId,
        agentId: agent.id,
      });
      return makeSuccess({ agent: toPublicAgent(agent) });
    },

    async unpublishAgent(agentInput) {
      const managed = await agentForManagement(repositories, agentInput);
      if (!managed.ok) {
        return managed;
      }
      if (agentInput.targetTeamId === managed.agent.primaryTeamId) {
        return makeFailure('VALIDATION_ERROR', 'Cannot unpublish agent from its primary team');
      }
      const agent = await repositories.agents.unpublish({
        agentId: managed.agent.id,
        teamId: agentInput.targetTeamId,
      });
      if (!agent) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }
      await repositories.channels.removeAgentFromTeamChannels({
        teamId: agentInput.targetTeamId,
        agentId: managed.agent.id,
        timestamp: clock.now(),
      });
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
        changes.description = agentInput.description.trim();
      }

      if (isCustom) {
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
          changes.env = agentInput.env;
          changes.envKeys = Object.keys(agentInput.env).sort();
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
        name: slugify(channelInput.name),
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
      const updated = await repositories.channels.update({
        channelId: channel.id,
        changes: {
          ...(channelInput.name ? { name: slugify(channelInput.name) } : {}),
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
      // Cascade: artifacts → messages → channel
      await repositories.artifacts.deleteByChannel(channel.id);
      await repositories.messages.deleteByChannel(channel.id);
      const deleted = await repositories.channels.delete({ channelId: channel.id });
      if (!deleted) {
        return makeFailure('NOT_FOUND', 'Channel not found');
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
      return makeSuccess({ agent });
    },

    async sendMessage(messageInput) {
      if (!(await repositories.teams.isMember(messageInput.teamId, messageInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const channel = await repositories.channels.getById(messageInput.channelId);
      if (!channel || channel.teamId !== messageInput.teamId) {
        return makeFailure('NOT_FOUND', 'Channel not found');
      }
      if (channel.visibility === 'private' && !channel.humanMemberIds.includes(messageInput.userId)) {
        return makeFailure('FORBIDDEN', 'User cannot view channel');
      }

      const now = clock.now();
      const messageId = ids.nextId();
      const threadId = messageInput.threadId ?? messageId;
      const visibleAgents = await repositories.agents.listVisibleInTeam(messageInput.teamId);
      const route = routeMessageForChannel({
        channel,
        visibleAgents,
        teamId: messageInput.teamId,
        body: messageInput.body,
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
          routeReason: toRouteReason(route),
        },
      });
      const attachedArtifacts: ArtifactRecord[] = [];
      for (const artifact of attachmentResult.artifacts) {
        attachedArtifacts.push(await repositories.artifacts.create({
          ...artifact,
          messageId: message.id,
        }));
      }
      const dispatches: DispatchDto[] = [];

      if (route.kind === 'dispatch') {
        const dispatch = await repositories.dispatches.create({
          id: ids.nextId(),
          teamId: messageInput.teamId,
          channelId: messageInput.channelId,
          messageId: message.id,
          agentId: route.agentId,
          status: 'queued',
          requestId: ids.nextId(),
          prompt: messageInput.body,
          createdAt: now,
          updatedAt: now,
        });
        dispatches.push(toDispatchDto(dispatch));
      }

      return makeSuccess({
        message: attachedArtifacts.length > 0
          ? { ...message, artifacts: attachedArtifacts.map(toArtifactDto) }
          : message,
        dispatches,
        route,
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
      const executionConfig = agent.source === 'custom' || (agent.source === 'scanned' && agent.command)
        ? await repositories.agents.getExecutionConfig(agent.id)
        : null;
      const originMessage = await repositories.messages.getById(dispatch.messageId);
      const history = originMessage?.threadId
        ? await repositories.messages.listThreadBefore({
            channelId: dispatch.channelId,
            threadId: originMessage.threadId,
            beforeMessageId: originMessage.id,
            limit: 20,
          })
        : [];
      const attachments = await repositories.artifacts.listByMessage(dispatch.messageId);

      return makeSuccess({
        request: {
          id: dispatch.id,
          teamId: dispatch.teamId,
          channelId: dispatch.channelId,
          messageId: dispatch.messageId,
          ...(originMessage?.threadId ? { threadId: originMessage.threadId } : {}),
          agentId: dispatch.agentId,
          deviceId: agent.deviceId,
          requestId: dispatch.requestId,
          prompt: dispatch.prompt,
          history: history.map(toDispatchHistoryMessageDto),
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
                  ...(agent.source === 'custom'
                    ? { envRef: { agentId: agent.id, teamId: agent.primaryTeamId } }
                    : {}),
                },
              }
            : {}),
        },
      });
    },

    async listChannelMessages(listInput) {
      const messages = await repositories.messages.listByChannel(listInput.channelId, listInput.limit);
      return makeSuccess({
        messages: await enrichMessagesWithArtifacts(repositories, messages),
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
      const channels = await repositories.channels.listForUser(searchInput.teamId, searchInput.userId);
      const directChannels = await visibleDirectChannelsForUser(repositories, searchInput.teamId, searchInput.userId);
      const channelIds = [
        ...channels.map((channel) => channel.id),
        ...directChannels.map(({ channel }) => channel.id),
      ];
      const messages = await repositories.messages.search({
        channelIds,
        query,
        limit: normalizeLimit(searchInput.limit),
      });
      return makeSuccess({
        messages: await enrichMessagesWithArtifacts(repositories, messages),
      });
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
      return makeSuccess({ task: updated });
    },

    async deleteTask(taskInput) {
      if (!(await repositories.teams.isMember(taskInput.teamId, taskInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const task = await repositories.tasks.getById(taskInput.taskId);
      if (!task || task.teamId !== taskInput.teamId) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
      const deleted = await repositories.tasks.delete({ taskId: task.id });
      if (!deleted) {
        return makeFailure('NOT_FOUND', 'Task not found');
      }
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
      return makeSuccess({ artifact: toArtifactDto(result.artifact) });
    },

    async getArtifactFile(artifactInput) {
      const result = await getAuthorizedArtifact(repositories, artifactInput);
      if (!result.ok) return result;
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
      return makeSuccess({ workspaceRun: await toWorkspaceRunDto(repositories, result.workspaceRun) });
    },

    async getWorkspaceRunDetail(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
      const artifacts = await repositories.artifacts.listByWorkspaceRunForChannel({
        teamId: result.workspaceRun.teamId,
        channelId: result.workspaceRun.channelId,
        runId: result.workspaceRun.id,
      });
      return makeSuccess({
        workspaceRun: await toWorkspaceRunDto(repositories, result.workspaceRun),
        artifacts: artifacts.map(toArtifactDto),
      });
    },

    async getWorkspaceRunLogFile(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
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
      const runs = await repositories.workspaceRuns.listByTeam({
        teamId: runInput.teamId,
        limit: pageSize * 10,
        agentId: runInput.agentId,
        deviceId: runInput.deviceId,
        status: runInput.status,
        cursor,
      });
      const visibleRuns: TeamWorkspaceRunListItemDto[] = [];
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

      const cancelled = await repositories.dispatches.markCancelled({
        dispatchId: cancelInput.dispatchId,
        completedAt: clock.now(),
      });
      if (!cancelled) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      return makeSuccess({ dispatch: toDispatchDto(cancelled.dispatch) });
    },

    async failTimedOutDispatches(timeoutInput) {
      const now = clock.now();
      const pending = await repositories.dispatches.listPendingOlderThan(timeoutInput.olderThan);
      const dispatches: DispatchDto[] = [];
      for (const dispatch of pending) {
        if (!isPendingDispatchStatus(dispatch.status)) {
          continue;
        }
        const timedOut = await repositories.dispatches.markTimedOut({
          dispatchId: dispatch.id,
          error: 'DISPATCH_TIMEOUT',
          completedAt: now,
        });
        if (timedOut?.changed) {
          dispatches.push(toDispatchDto(timedOut.dispatch));
        }
      }
      return makeSuccess({ dispatches });
    },

    async receiveDispatchResult(resultInput) {
      const dispatch = await repositories.dispatches.getById(resultInput.dispatchId);
      if (!dispatch) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (dispatch.agentId !== resultInput.agentId) {
        return makeFailure('FORBIDDEN', 'Dispatch does not belong to agent');
      }
      if (!isPendingDispatchStatus(dispatch.status)) {
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      const agent = await repositories.agents.getById(resultInput.agentId);
      if (!agent || agent.deletedAt !== undefined) {
        return makeFailure('NOT_FOUND', 'Agent not found');
      }

      const now = clock.now();
      const completed = await repositories.dispatches.markSucceeded({
        dispatchId: resultInput.dispatchId,
        completedAt: now,
      });
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
      const message = await repositories.messages.append({
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
          ...(reportedArtifactIds.length > 0 ? { artifactIds: reportedArtifactIds } : {}),
          ...(workspaceRunId ? { workspaceRunId } : {}),
        },
      });
      const workspaceRun = resultInput.workspaceRun
        ? await repositories.workspaceRuns.create({
            id: workspaceRunId!,
            teamId: completed.dispatch.teamId,
            channelId: completed.dispatch.channelId,
            messageId: message.id,
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
          messageId: message.id,
          dispatchId: completed.dispatch.id,
          workspaceRunId: workspaceRun?.id,
          pathKind: 'generated',
        });
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
          messageId: message.id,
          dispatchId: completed.dispatch.id,
          workspaceRunId: workspaceRun?.id,
          uploaderId: resultInput.agentId,
          filename: artifactInput.filename,
          mimeType: artifactInput.mimeType ?? 'application/octet-stream',
          sizeBytes: contentResult.content?.sizeBytes ?? artifactInput.sizeBytes ?? 0,
          storagePath: contentResult.content?.storagePath ?? artifactInput.storagePath,
          relativePath: artifactInput.relativePath,
          pathKind: artifactInput.pathKind ?? (workspaceRun ? 'workspace' : 'generated'),
          sha256: contentResult.content?.sha256 ?? artifactInput.sha256,
          createdAt: now,
        });
        artifacts.push(toArtifactDto(artifact));
      }
      const messageWithArtifacts: MessageDto = {
        ...message,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(workspaceRun ? { workspaceRun } : {}),
      };
      await repositories.agents.updateStatus({
        agentId: resultInput.agentId,
        status: 'online',
        lastSeenAt: now,
      });

      return makeSuccess({ dispatch: toDispatchDto(completed.dispatch), message: messageWithArtifacts });
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
      const failed = await repositories.dispatches.markFailed({
        dispatchId: errorInput.dispatchId,
        error: errorInput.error,
        completedAt: now,
      });
      if (!failed) {
        return makeFailure('NOT_FOUND', 'Dispatch not found');
      }
      if (!failed.changed) {
        return makeFailure('CONFLICT', 'Dispatch is already completed');
      }
      await repositories.agents.updateStatus({
        agentId: errorInput.agentId,
        status: 'offline',
        lastSeenAt: now,
        lastError: errorInput.error,
      });

      return makeSuccess({ dispatch: toDispatchDto(failed.dispatch) });
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

function toDeviceDto(device: DeviceDto): DeviceDto {
  const daemonVersionInfo = buildDaemonVersionInfo(
    device.systemInfo as Record<string, unknown> | null | undefined,
    device.daemonVersion,
  );
  return {
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
    connectCommand: device.connectCommand,
    lastSeenAt: device.lastSeenAt,
  };
}

async function toDeviceDtoWithOwnerName(repositories: ServerNextRepositories, device: DeviceDto): Promise<DeviceDto> {
  return (await toDeviceDtosWithOwnerNames(repositories, [device]))[0] ?? toDeviceDto(device);
}

async function toDeviceDtosWithOwnerNames(repositories: ServerNextRepositories, devices: DeviceDto[]): Promise<DeviceDto[]> {
  const dtos = devices.map(toDeviceDto);
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
  const publicAgents = agents
    .filter((agent) => agent.visibleTeamIds.includes(device.teamId))
    .map((agent) => toAdminAgentDto(agent, { device, usersById, teamsById }));
  return {
    ...toDeviceDto(device),
    userId: device.ownerId,
    userName: owner?.username ?? '未知用户',
    networkId: device.teamId,
    networkName: team?.name ?? '未知团队',
    agentCount: agents.length,
    runtimes: runtimes.map(toRuntimeDto),
    publicAgents,
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
    networkId: agent.primaryTeamId,
    networkName: team?.name ?? '未知团队',
    ownerId,
    ownerName: owner?.username ?? null,
    userName: owner?.username ?? null,
    deviceName: context.device ? deviceDisplayName(context.device) : '未分配设备',
    deviceUserId: context.device?.ownerId ?? null,
    deviceUserName: deviceOwner?.username ?? null,
    publishedNetworkIds: uniqueIds(agent.visibleTeamIds),
    unpublishedNetworkIds: [],
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
): Promise<WorkspaceRunDto> {
  const dispatch = await repositories.dispatches.getById(run.dispatchId);
  if (!dispatch?.messageId || dispatch.messageId === run.messageId) {
    return run;
  }
  return {
    ...run,
    sourceMessageId: dispatch.messageId,
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
    sha256: artifact.sha256,
    createdAt: artifact.createdAt,
  };
}

function isWorkspaceRunLogArtifact(artifact: ArtifactRecord): boolean {
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
    const artifacts = await repositories.artifacts.listByMessage(message.id);
    const workspaceRunId = typeof message.meta?.workspaceRunId === 'string' ? message.meta.workspaceRunId : undefined;
    const workspaceRun = workspaceRunId
      ? await repositories.workspaceRuns.getForTeam({ teamId: message.teamId, runId: workspaceRunId })
      : null;
    enriched.push({
      ...message,
      ...(artifacts.length > 0 ? { artifacts: artifacts.map(toArtifactDto) } : {}),
      ...(workspaceRun ? { workspaceRun } : {}),
    });
  }
  return enriched;
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

function routeMessageForChannel(input: {
  channel: ChannelRecord;
  visibleAgents: AgentDto[];
  teamId: string;
  body: string;
}): RouteResult {
  if (input.channel.kind === 'direct') {
    const targetAgentId = input.channel.dmTargetAgentId ?? input.channel.agentMemberIds[0];
    const targetAgent = input.visibleAgents.find((agent) =>
      agent.id === targetAgentId &&
      agent.visibleTeamIds.includes(input.teamId) &&
      agent.status === 'online'
    );
    return targetAgent
      ? { kind: 'dispatch', agentId: targetAgent.id, reason: 'direct' }
      : { kind: 'no-dispatch', reason: 'no-online-agent' };
  }
  return routeMessage({
    body: input.body,
    agents: input.visibleAgents,
    humanMembers: [],
    teamId: input.teamId,
    channelId: input.channel.id,
  });
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
  if (role === 'owner' || role === 'admin') {
    return makeSuccess({ agent });
  }
  if (agent.source === 'custom' && agent.ownerId === input.userId) {
    return makeSuccess({ agent });
  }
  return makeFailure('FORBIDDEN', 'User cannot manage agent');
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
  if (role === 'owner' || role === 'admin') {
    return makeSuccess({ agent });
  }
  if (agent.source === 'custom' && agent.ownerId === input.userId) {
    return makeSuccess({ agent });
  }
  if (agent.source === 'scanned' && agent.category === 'agentos-hosted' && agent.deviceId) {
    const device = await repositories.devices.getById(agent.deviceId);
    if (device?.teamId === agent.primaryTeamId && device.ownerId === input.userId) {
      return makeSuccess({ agent });
    }
  }
  return makeFailure('FORBIDDEN', 'User cannot manage agent');
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids.filter(Boolean)));
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function toPublicAgent(agent: AgentRecord): AgentDto {
  const { deletedAt: _deletedAt, ...publicAgent } = agent;
  return publicAgent;
}

async function toAgentMemberDtos(
  repositories: ServerNextRepositories,
  teamId: string,
  agents: AgentRecord[],
): Promise<AgentMemberDto[]> {
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
    networkId: agent.primaryTeamId,
    publishedNetworkIds: uniqueIds(agent.visibleTeamIds),
    unpublishedNetworkIds: [],
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
