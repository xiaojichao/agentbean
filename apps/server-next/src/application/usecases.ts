import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { makeFailure, makeSuccess, type Ack, type AdapterKind, type AgentDto, type AgentCategory, type ArtifactDto, type ChannelDto, type ChannelMembersDto, type DeviceDetailDto, type DeviceDto, type DeviceInviteAckDto, type DeviceInviteCredentialsDto, type DeviceInviteDto, type DispatchDto, type DispatchHistoryMessageDto, type DispatchRequestDto, type DmChannelDto, type JoinLinkDto, type MessageDto, type RouteReason, type RuntimeDto, type TaskDto, type TaskStatus, type TeamDto, type UserDto, type WorkspaceRunDto } from '../../../../packages/contracts/src/index.js';
import { canApplyChannelUpdate, channelHumanMembersForCreate, isDefaultChannel, normalizeAdapterKind, normalizeAgentName, normalizePathForComparison, routeMessage, type RouteResult } from '../../../../packages/domain/src/index.js';
import type { AgentConfigUpdate, AgentRecord, ArtifactRecord, ChannelRecord, DeviceInviteRecord, JoinLinkRecord, MessageRecord, ServerNextRepositories, UserRecord, WorkspaceRunRecord } from './repositories.js';

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

export interface ServerNextUseCases {
  registerUser(input: RegisterUserInput): Promise<Ack<RegisterUserResult>>;
  loginUser(input: LoginUserInput): Promise<Ack<LoginUserResult>>;
  whoami(input: WhoamiInput): Promise<Ack<WhoamiResult>>;
  listTeams(input: { userId: string }): Promise<Ack<ListTeamsResult>>;
  createTeam(input: CreateTeamInput): Promise<Ack<CreateTeamResult>>;
  switchTeam(input: SwitchTeamInput): Promise<Ack<SwitchTeamResult>>;
  createJoinLink(input: CreateJoinLinkInput): Promise<Ack<JoinLinkResult>>;
  validateJoinLink(input: ValidateJoinLinkInput): Promise<Ack<JoinLinkResult>>;
  createDeviceInvite(input: CreateDeviceInviteInput): Promise<Ack<DeviceInviteAckDto>>;
  waitForDeviceInvite(input: WaitForDeviceInviteInput): Promise<Ack<DeviceInviteAckDto>>;
  completeDeviceInvite(input: CompleteDeviceInviteInput): Promise<Ack<DeviceInviteAckDto & { credentials: DeviceInviteCredentialsDto }>>;
  deviceHelloFromCredentials(input: DeviceHelloFromCredentialsInput): Promise<Ack<{ device: DeviceDto }>>;
  listDevices(input: { teamId: string; userId: string }): Promise<Ack<{ devices: DeviceDto[] }>>;
  getDevice(input: { userId: string; deviceId: string }): Promise<Ack<{ device: DeviceDetailDto }>>;
  requestDeviceScan(input: RequestDeviceScanInput): Promise<Ack<RequestDeviceScanResult>>;
  deviceHello(input: DeviceHelloInput): Promise<Ack<{ device: DeviceDto }>>;
  reportDeviceRuntimes(input: ReportDeviceRuntimesInput): Promise<Ack<{ runtimes: RuntimeDto[] }>>;
  registerDiscoveredAgents(input: RegisterDiscoveredAgentsInput): Promise<Ack<RegisterDiscoveredAgentsResult>>;
  listVisibleAgents(input: { teamId: string }): Promise<Ack<{ agents: AgentDto[] }>>;
  createCustomAgent(input: CreateCustomAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  publishAgent(input: PublishAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  unpublishAgent(input: UnpublishAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  updateAgentConfig(input: UpdateAgentConfigInput): Promise<Ack<{ agent: AgentDto }>>;
  deleteAgent(input: DeleteAgentInput): Promise<Ack<{ agent: AgentDto }>>;
  listChannels(input: { teamId: string; userId: string }): Promise<Ack<{ channels: ChannelDto[] }>>;
  createChannel(input: CreateChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  updateChannel(input: UpdateChannelInput): Promise<Ack<{ channel: ChannelDto }>>;
  addChannelHumanMember(input: ChannelHumanMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
  removeChannelHumanMember(input: ChannelHumanMemberInput): Promise<Ack<{ channel: ChannelDto }>>;
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
  createTask(input: CreateTaskInput): Promise<Ack<{ task: TaskDto }>>;
  updateTask(input: UpdateTaskInput): Promise<Ack<{ task: TaskDto }>>;
  deleteTask(input: DeleteTaskInput): Promise<Ack<{ task: TaskDto }>>;
  reorderTask(input: ReorderTaskInput): Promise<Ack<{ task: TaskDto }>>;
  uploadArtifact(input: UploadArtifactInput): Promise<Ack<{ artifact: ArtifactDto }>>;
  getArtifact(input: GetArtifactInput): Promise<Ack<{ artifact: ArtifactDto }>>;
  getArtifactFile(input: GetArtifactInput): Promise<Ack<{ artifact: ArtifactDto; storagePath?: string }>>;
  getWorkspaceRun(input: GetWorkspaceRunInput): Promise<Ack<{ workspaceRun: WorkspaceRunDto }>>;
  getWorkspaceRunDetail(input: GetWorkspaceRunInput): Promise<Ack<{ workspaceRun: WorkspaceRunDto; artifacts: ArtifactDto[] }>>;
  failTimedOutDispatches(input: { olderThan: number }): Promise<Ack<{ dispatches: DispatchDto[] }>>;
  receiveDispatchResult(input: ReceiveDispatchResultInput): Promise<Ack<ReceiveDispatchResultResult>>;
  receiveDispatchError(input: ReceiveDispatchErrorInput): Promise<Ack<ReceiveDispatchErrorResult>>;
  reactMessage(input: ReactMessageInput): Promise<Ack<{ messageId: string }>>;
  saveMessage(input: SaveMessageInput): Promise<Ack<{ messageId: string }>>;
  listSavedMessages(input: ListSavedMessagesInput): Promise<Ack<{ messages: MessageDto[] }>>;
  updateMemberRole(input: UpdateMemberRoleInput): Promise<Ack<{ member: { id: string; teamId: string; userId: string; username: string; role: string } }>>;
  removeMember(input: RemoveMemberInput): Promise<Ack<{ userId: string }>>;
  transferOwner(input: TransferOwnerInput): Promise<Ack<{ team: { id: string; name: string }; member: { id: string; teamId: string; userId: string; username: string; role: string } }>>;
}

export interface RegisterUserInput {
  username: string;
  password: string;
  teamName: string;
  joinCode?: string;
}

export interface RegisterUserResult {
  token: string;
  user: UserDto;
  currentTeam: TeamDto;
  defaultChannel: ChannelDto;
  joinedTeam?: TeamDto;
}

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

export interface GetWorkspaceRunInput {
  userId: string;
  teamId: string;
  runId: string;
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
}

export interface ReceiveDispatchWorkspaceRunInput {
  id?: string;
  status?: WorkspaceRunDto['status'];
  cwd?: string;
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
  actorUserId: string;
  teamId: string;
  targetUserId: string;
  role: 'owner' | 'admin' | 'member';
}

export interface RemoveMemberInput {
  actorUserId: string;
  teamId: string;
  targetUserId: string;
}

export interface TransferOwnerInput {
  actorUserId: string;
  teamId: string;
  targetUserId: string;
}

export interface CreateServerNextUseCasesInput {
  repositories: ServerNextRepositories;
  clock: ServerNextClock;
  ids: ServerNextIds;
  joinCodes?: ServerNextJoinCodes;
  deviceInviteCodes?: ServerNextDeviceInviteCodes;
  sessionSecret?: string;
}

export function createServerNextUseCases(input: CreateServerNextUseCasesInput): ServerNextUseCases {
  const { repositories, clock, ids } = input;
  const joinCodes = input.joinCodes ?? { nextCode: generateJoinCode };
  const deviceInviteCodes = input.deviceInviteCodes ?? { nextCode: generateJoinCode };
  const sessionSecret = input.sessionSecret ?? 'agentbean-next-dev-session-secret';

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
      const teamPath = slugify(registerInput.teamName);

      const user = await repositories.users.create({
        id: userId,
        username,
        role: 'user',
        primaryTeamId: teamId,
        currentTeamId: teamId,
        passwordHash: hashPassword(registerInput.password),
        createdAt: now,
        updatedAt: now,
      });
      const team = await repositories.teams.create({
        id: teamId,
        name: registerInput.teamName.trim(),
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
      if (!user || user.passwordHash !== hashPassword(loginInput.password)) {
        return makeFailure('UNAUTHENTICATED', 'Invalid username or password');
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
        invite: toDeviceInviteDto(invite),
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
        serverUrl: inviteInput.serverUrl,
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

    async deviceHello(deviceInput) {
      if (!(await repositories.teams.isMember(deviceInput.teamId, deviceInput.ownerId))) {
        return makeFailure('FORBIDDEN', 'Device owner is not a team member');
      }

      const now = clock.now();
      const existing =
        deviceInput.machineId && deviceInput.profileId
          ? await repositories.devices.findByMachineProfile(deviceInput.machineId, deviceInput.profileId)
          : null;
      const device = await repositories.devices.upsertHello({
        id: existing?.id ?? ids.nextId(),
        teamId: deviceInput.teamId,
        ownerId: deviceInput.ownerId,
        status: 'online',
        name: deviceInput.hostname,
        machineId: deviceInput.machineId,
        profileId: deviceInput.profileId,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
        lastSeenAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });

      return makeSuccess({ device: toDeviceDto(device) });
    },

    async listDevices(deviceListInput) {
      if (!(await repositories.teams.isMember(deviceListInput.teamId, deviceListInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      return makeSuccess({
        devices: (await repositories.devices.listByTeam(deviceListInput.teamId)).map(toDeviceDto),
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
      const visibleAgents = await repositories.agents.listVisibleInTeam(device.teamId);
      return makeSuccess({
        device: {
          ...toDeviceDto(device),
          runtimes: (await repositories.runtimes.listByDevice(device.id)).map(toRuntimeDto),
          agents: visibleAgents.filter((agent) => agent.deviceId === device.id),
        },
      });
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
          lastSeenAt: now,
        });
        await repositories.agents.linkIdentity({
          identityKey,
          agentId: agent.id,
          kind: discovered.gatewayInstanceKey ? 'agentos-gateway' : 'agentos-concrete',
          timestamp: now,
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

    async updateAgentConfig(agentInput) {
      const managed = await agentForManagement(repositories, agentInput);
      if (!managed.ok) {
        return managed;
      }
      if (managed.agent.source !== 'custom') {
        return makeFailure('VALIDATION_ERROR', 'Only custom agents can be configured');
      }

      const now = clock.now();
      const changes: AgentConfigUpdate = {};
      if (agentInput.name !== undefined) {
        changes.name = agentInput.name.trim();
      }
      if (agentInput.description !== undefined) {
        changes.description = agentInput.description.trim();
      }
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
      const channels = await repositories.channels.listDirectForUser(dmInput.teamId, dmInput.userId);
      const dms: DmChannelDto[] = [];
      for (const channel of channels) {
        const agentId = channel.dmTargetAgentId ?? channel.agentMemberIds[0];
        const agent = agentId ? await repositories.agents.getById(agentId) : null;
        if (agent && agent.visibleTeamIds.includes(dmInput.teamId)) {
          dms.push(toDmChannelDto(channel, agent));
        }
      }
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
      const executionConfig = agent.source === 'custom'
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
          ...(executionConfig
            ? {
                customAgent: {
                  id: agent.id,
                  name: agent.name,
                  adapterKind: executionConfig.adapterKind,
                  command: executionConfig.command,
                  args: executionConfig.args,
                  cwd: executionConfig.cwd,
                  env: executionConfig.env,
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
      const channelIds = channels.map((channel) => channel.id);
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

    async getWorkspaceRun(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
      return makeSuccess({ workspaceRun: result.workspaceRun });
    },

    async getWorkspaceRunDetail(runInput) {
      const result = await getAuthorizedWorkspaceRun(repositories, runInput);
      if (!result.ok) return result;
      const artifacts = await repositories.artifacts.listByWorkspaceRun(result.workspaceRun.id);
      return makeSuccess({
        workspaceRun: result.workspaceRun,
        artifacts: artifacts.map(toArtifactDto),
      });
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
            exitCode: resultInput.workspaceRun.exitCode,
            startedAt: resultInput.workspaceRun.startedAt,
            completedAt: resultInput.workspaceRun.completedAt ?? now,
            createdAt: now,
            updatedAt: now,
            artifactIds: reportedArtifactIds,
          })
        : null;
      const artifacts: ArtifactDto[] = [];
      for (const artifactInput of resultInput.artifacts ?? []) {
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
          sizeBytes: artifactInput.sizeBytes ?? 0,
          storagePath: artifactInput.storagePath,
          relativePath: artifactInput.relativePath,
          pathKind: artifactInput.pathKind ?? (workspaceRun ? 'workspace' : 'generated'),
          sha256: artifactInput.sha256,
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
      const actorRole = await repositories.teams.getMemberRole(roleInput.teamId, roleInput.actorUserId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'Actor is not a team member');
      }
      if (actorRole === 'member') {
        return makeFailure('FORBIDDEN', 'Only owner or admin can change roles');
      }
      if (roleInput.actorUserId === roleInput.targetUserId) {
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
      const actorRole = await repositories.teams.getMemberRole(removeInput.teamId, removeInput.actorUserId);
      if (!actorRole) {
        return makeFailure('FORBIDDEN', 'Actor is not a team member');
      }
      if (actorRole === 'member') {
        return makeFailure('FORBIDDEN', 'Only owner or admin can remove members');
      }
      if (removeInput.actorUserId === removeInput.targetUserId) {
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
      return makeSuccess({ userId: removeInput.targetUserId });
    },

    async transferOwner(transferInput) {
      const actorRole = await repositories.teams.getMemberRole(transferInput.teamId, transferInput.actorUserId);
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
        userId: transferInput.actorUserId,
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
  };
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
      artifact.pathKind !== 'upload'
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

function toDeviceInviteDto(invite: DeviceInviteRecord): DeviceInviteDto {
  return {
    id: invite.id,
    code: invite.code,
    teamId: invite.teamId,
    createdBy: invite.createdBy,
    createdAt: invite.createdAt,
    expiresAt: invite.expiresAt,
    completedAt: invite.completedAt,
    profileId: invite.profileId,
  };
}

function toDeviceDto(device: DeviceDto): DeviceDto {
  return {
    id: device.id,
    teamId: device.teamId,
    ownerId: device.ownerId,
    status: device.status,
    name: device.name,
    systemInfo: device.systemInfo,
    capabilities: device.capabilities,
    lastSeenAt: device.lastSeenAt,
  };
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

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
}

function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
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
  credentials: Pick<DeviceInviteCredentialsDto, 'teamId' | 'ownerId' | 'machineId' | 'profileId' | 'hostname'>,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64url');
  return `abn_device.${payload}.${signSessionPayload(payload, secret)}`;
}

function verifyDeviceToken(
  token: string,
  secret: string,
): Pick<DeviceInviteCredentialsDto, 'teamId' | 'ownerId' | 'machineId' | 'profileId' | 'hostname'> | null {
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
    repositories.channels.listDirectForUser(teamId, userId),
  ]);
  return uniqueIds([...channels, ...dms].map((channel) => channel.id));
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
