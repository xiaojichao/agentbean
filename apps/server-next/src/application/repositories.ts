import type { AgentDto, ArtifactDto, ChannelDto, DeviceDto, DispatchDto, HumanMemberDto, ID, MessageDto, RuntimeDto, TaskDto, TeamDto, UnixMs, UserDto, WorkspaceRunDto, WorkspaceRunStatus } from '../../../../packages/contracts/src/index.js';

export interface UserRecord extends UserDto {
  passwordHash: string;
  currentTeamId?: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}

export interface TeamRecord extends Omit<TeamDto, 'currentUserRole'> {}

export interface TeamMemberRecord {
  teamId: ID;
  userId: ID;
  username: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: UnixMs;
}

export interface JoinLinkRecord {
  id: ID;
  code: string;
  teamId: ID;
  createdBy: ID;
  createdAt: UnixMs;
  expiresAt?: UnixMs;
  maxUses?: number;
  usesCount: number;
  revokedAt?: UnixMs;
}

export interface DeviceInviteRecord {
  id: ID;
  code: string;
  teamId: ID;
  createdBy: ID;
  createdAt: UnixMs;
  expiresAt?: UnixMs;
  completedAt?: UnixMs;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  serverUrl?: string;
}

export interface ChannelRecord extends ChannelDto {
  humanMemberIds: ID[];
  agentMemberIds: ID[];
}

export type MessageRecord = MessageDto;
export type DispatchRecord = DispatchDto & { prompt: string };
export interface ArtifactRecord extends Omit<ArtifactDto, 'downloadUrl' | 'previewUrl'> {
  uploaderId: ID;
  storagePath?: string;
}
export type WorkspaceRunRecord = WorkspaceRunDto;
export type TaskRecord = TaskDto;
export interface DispatchMutationResult {
  dispatch: DispatchRecord;
  changed: boolean;
}
export interface AgentExecutionConfig {
  adapterKind: AgentDto['adapterKind'];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export type AgentRecord = AgentDto & { deletedAt?: UnixMs };
export type AgentUpsertRecord = AgentRecord & { env?: Record<string, string> };

export interface AgentConfigUpdate {
  name?: string;
  description?: string;
  adapterKind?: AgentDto['adapterKind'];
  deviceId?: ID;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  envKeys?: string[];
  status?: AgentDto['status'];
  lastSeenAt?: UnixMs;
}
export interface DeviceRecord extends DeviceDto {
  machineId?: string;
  profileId?: string;
  canonicalDeviceId?: string | null;
  daemonVersion?: string;
  connectCommand?: string;
  createdAt: UnixMs;
  updatedAt: UnixMs;
}
export interface RuntimeRecord extends RuntimeDto {
  teamId: ID;
  installed: boolean;
  command?: string;
  normalizedCommandKey?: string;
  cwd?: string;
  normalizedCwdKey?: string;
}

export interface UserRepository {
  create(input: UserRecord): Promise<UserRecord>;
  getById(id: ID): Promise<UserRecord | null>;
  getByUsername(username: string): Promise<UserRecord | null>;
  listAll(): Promise<UserRecord[]>;
  setCurrentTeam(userId: ID, teamId: ID): Promise<void>;
  updateDescription(input: { userId: ID; description: string | null; updatedAt: UnixMs }): Promise<UserRecord | null>;
  updatePassword(input: { userId: ID; passwordHash: string; updatedAt: UnixMs }): Promise<UserRecord | null>;
  delete(userId: ID): Promise<void>;
}

export interface TeamRepository {
  create(input: TeamRecord): Promise<TeamRecord>;
  getById(id: ID): Promise<TeamRecord | null>;
  listAll(): Promise<TeamRecord[]>;
  listForUser(userId: ID): Promise<Array<TeamRecord & { currentUserRole: 'owner' | 'admin' | 'member' }>>;
  addMember(input: TeamMemberRecord): Promise<void>;
  isMember(teamId: ID, userId: ID): Promise<boolean>;
  getMemberRole(teamId: ID, userId: ID): Promise<'owner' | 'admin' | 'member' | null>;
  listMembersByIds(teamId: ID, userIds: ID[]): Promise<HumanMemberDto[]>;
  getMember(input: { teamId: ID; userId: ID }): Promise<TeamMemberRecord | null>;
  updateMemberRole(input: { teamId: ID; userId: ID; role: TeamMemberRecord['role'] }): Promise<TeamMemberRecord | null>;
  removeMember(input: { teamId: ID; userId: ID }): Promise<void>;
  updateOwner(input: { teamId: ID; ownerId: ID }): Promise<TeamRecord | null>;
  listAllMembers(teamId: ID): Promise<Array<HumanMemberDto & { joinedAt: UnixMs }>>;
  update(input: { teamId: ID; name?: string; path?: string; description?: string; visibility?: string }): Promise<TeamRecord | null>;
  delete(teamId: ID): Promise<void>;
}

export interface JoinLinkRepository {
  create(input: JoinLinkRecord): Promise<JoinLinkRecord>;
  getByCode(code: string): Promise<JoinLinkRecord | null>;
  incrementUses(code: string): Promise<JoinLinkRecord | null>;
  listByTeam(teamId: ID): Promise<JoinLinkRecord[]>;
  revoke(input: { teamId: ID; code: string; revokedAt: UnixMs }): Promise<JoinLinkRecord | null>;
}

export interface DeviceInviteRepository {
  create(input: DeviceInviteRecord): Promise<DeviceInviteRecord>;
  getByCode(code: string): Promise<DeviceInviteRecord | null>;
  updateWaiter(input: {
    code: string;
    machineId?: string;
    profileId?: string;
    hostname?: string;
    serverUrl?: string;
  }): Promise<DeviceInviteRecord | null>;
  complete(input: { code: string; completedAt: UnixMs; serverUrl?: string }): Promise<DeviceInviteRecord | null>;
  findCompletedByMachineProfile(input: { teamId: ID; machineId: string; profileId: string }): Promise<DeviceInviteRecord | null>;
}

export interface ChannelRepository {
  create(input: ChannelRecord): Promise<ChannelRecord>;
  getById(channelId: ID): Promise<ChannelRecord | null>;
  getDefaultChannel(teamId: ID): Promise<ChannelRecord | null>;
  getDirectByAgent(input: { teamId: ID; userId: ID; agentId: ID }): Promise<ChannelRecord | null>;
  listForUser(teamId: ID, userId: ID): Promise<ChannelRecord[]>;
  listDirectForUser(teamId: ID, userId: ID): Promise<ChannelRecord[]>;
  addDefaultChannelMembers(input: { teamId: ID; humanMemberIds?: ID[]; agentMemberIds?: ID[]; timestamp: UnixMs }): Promise<ChannelRecord | null>;
  update(input: {
    channelId: ID;
    changes: Partial<Pick<ChannelRecord, 'name' | 'title' | 'visibility' | 'humanMemberIds' | 'agentMemberIds' | 'updatedAt' | 'archivedAt'>>;
  }): Promise<ChannelRecord | null>;
  removeAgentFromTeamChannels(input: { teamId: ID; agentId: ID; timestamp: UnixMs }): Promise<void>;
  removeHumanFromTeamChannels(input: { teamId: ID; userId: ID; timestamp: UnixMs }): Promise<void>;
  archive(input: { channelId: ID; timestamp: UnixMs }): Promise<ChannelRecord | null>;
  delete(input: { channelId: ID }): Promise<ChannelRecord | null>;
}

export interface DeviceRepository {
  upsertHello(input: DeviceRecord): Promise<DeviceRecord>;
  getById(id: ID): Promise<DeviceRecord | null>;
  findByMachineProfile(input: {
    teamId: ID;
    machineId: string;
    profileId: string;
  }): Promise<DeviceRecord | null>;
  findCanonicalByDisplay(input: { teamId: ID; ownerId: ID; name: string }): Promise<DeviceRecord | null>;
  listByTeam(teamId: ID): Promise<DeviceRecord[]>;
  listAll(): Promise<DeviceRecord[]>;
  listConnected(): Promise<DeviceRecord[]>;
  markOffline(input: { deviceId: ID; timestamp: UnixMs }): Promise<DeviceRecord | null>;
  updateName(input: { deviceId: ID; hostname: string; updatedAt: UnixMs }): Promise<DeviceRecord | null>;
  transferOwner(input: { deviceId: ID; ownerId: ID; updatedAt: UnixMs }): Promise<DeviceRecord | null>;
  delete(input: { deviceId: ID; timestamp: UnixMs }): Promise<void>;
}

export interface RuntimeRepository {
  replaceForDevice(input: { teamId: ID; deviceId: ID; runtimes: RuntimeRecord[] }): Promise<RuntimeRecord[]>;
  getById(runtimeId: ID): Promise<RuntimeRecord | null>;
  listByDevice(deviceId: ID): Promise<RuntimeRecord[]>;
}

export interface AgentRepository {
  upsert(input: AgentUpsertRecord): Promise<AgentRecord>;
  getByIdentityKey(identityKey: string): Promise<AgentRecord | null>;
  getById(agentId: ID): Promise<AgentRecord | null>;
  getExecutionConfig(agentId: ID): Promise<AgentExecutionConfig | null>;
  publish(input: { agentId: ID; teamId: ID; publishedBy: ID; timestamp: UnixMs }): Promise<AgentRecord | null>;
  unpublish(input: { agentId: ID; teamId: ID }): Promise<AgentRecord | null>;
  updateConfig(input: { agentId: ID; changes: AgentConfigUpdate; timestamp: UnixMs }): Promise<AgentRecord | null>;
  softDelete(input: { agentId: ID; timestamp: UnixMs }): Promise<AgentRecord | null>;
  linkIdentity(input: { identityKey: string; agentId: ID; kind: string; timestamp: UnixMs }): Promise<void>;
  markMissingScannedOffline(input: { teamId: ID; deviceId: ID; seenIdentityKeys: string[]; timestamp: UnixMs }): Promise<ID[]>;
  updateStatus(input: { agentId: ID; status: AgentRecord['status']; lastSeenAt: UnixMs; lastError?: string }): Promise<void>;
  listVisibleInTeam(teamId: ID): Promise<AgentRecord[]>;
  listByDevice(deviceId: ID): Promise<AgentRecord[]>;
  listAll(): Promise<AgentRecord[]>;
  updateOwnerByDevice(input: { deviceId: ID; ownerId: ID; timestamp: UnixMs }): Promise<AgentRecord[]>;
}

export interface MessageRepository {
  append(input: MessageRecord): Promise<MessageRecord>;
  getById(messageId: ID): Promise<MessageRecord | null>;
  listByChannel(channelId: ID, limit: number): Promise<MessageRecord[]>;
  search(input: { channelIds: ID[]; query: string; limit: number }): Promise<MessageRecord[]>;
  listThreadBefore(input: { channelId: ID; threadId: ID; beforeMessageId: ID; limit: number }): Promise<MessageRecord[]>;
  deleteByChannel(channelId: ID): Promise<void>;
}

export interface DispatchRepository {
  create(input: DispatchRecord): Promise<DispatchRecord>;
  getById(id: ID): Promise<DispatchRecord | null>;
  markSucceeded(input: { dispatchId: ID; completedAt: UnixMs }): Promise<DispatchMutationResult | null>;
  markTimedOut(input: { dispatchId: ID; error: string; completedAt: UnixMs }): Promise<DispatchMutationResult | null>;
  markFailed(input: { dispatchId: ID; error: string; completedAt: UnixMs }): Promise<DispatchMutationResult | null>;
  markCancelled(input: { dispatchId: ID; completedAt: UnixMs }): Promise<DispatchMutationResult | null>;
  listPendingOlderThan(timestamp: UnixMs): Promise<DispatchRecord[]>;
  listByMessage(messageId: ID): Promise<DispatchRecord[]>;
  listByTeam(teamId: ID): Promise<DispatchRecord[]>;
}

export interface ArtifactRepository {
  create(input: ArtifactRecord): Promise<ArtifactRecord>;
  getForTeam(input: { teamId: ID; artifactId: ID }): Promise<ArtifactRecord | null>;
  listByMessage(messageId: ID): Promise<ArtifactRecord[]>;
  listByWorkspaceRunForChannel(input: { teamId: ID; channelId: ID; runId: ID }): Promise<ArtifactRecord[]>;
  deleteByChannel(channelId: ID): Promise<void>;
}

export interface WorkspaceRunRepository {
  create(input: WorkspaceRunRecord): Promise<WorkspaceRunRecord>;
  getForTeam(input: { teamId: ID; runId: ID }): Promise<WorkspaceRunRecord | null>;
  listByTeam(input: { teamId: ID; limit: number; agentId?: ID; deviceId?: ID; status?: WorkspaceRunStatus; cursor?: { updatedAt: number; id: string } }): Promise<WorkspaceRunRecord[]>;
  listByAgent(input: { teamId: ID; agentId: ID; limit: number }): Promise<WorkspaceRunRecord[]>;
  listByDispatch(dispatchId: ID): Promise<WorkspaceRunRecord[]>;
}

export interface TaskRepository {
  create(input: TaskRecord): Promise<TaskRecord>;
  getById(taskId: ID): Promise<TaskRecord | null>;
  list(input: { teamId: ID; channelIds: ID[]; includeGlobal: boolean }): Promise<TaskRecord[]>;
  update(input: { taskId: ID; changes: Partial<Pick<TaskRecord, 'title' | 'description' | 'status' | 'assigneeId' | 'channelId' | 'tags' | 'sortOrder' | 'updatedAt'>> }): Promise<TaskRecord | null>;
  delete(input: { taskId: ID }): Promise<TaskRecord | null>;
}

export interface ServerNextRepositories {
  users: UserRepository;
  teams: TeamRepository;
  joinLinks: JoinLinkRepository;
  deviceInvites: DeviceInviteRepository;
  channels: ChannelRepository;
  devices: DeviceRepository;
  runtimes: RuntimeRepository;
  agents: AgentRepository;
  messages: MessageRepository;
  dispatches: DispatchRepository;
  artifacts: ArtifactRepository;
  workspaceRuns: WorkspaceRunRepository;
  tasks: TaskRepository;
  reactions: ReactionRepository;
  savedMessages: SavedMessageRepository;
}

export interface ReactionRecord {
  id: ID;
  messageId: ID;
  userId: ID;
  emoji: string;
  createdAt: UnixMs;
}

export interface SavedMessageRecord {
  id: ID;
  messageId: ID;
  userId: ID;
  teamId: ID;
  channelId: ID;
  createdAt: UnixMs;
}

export interface ReactionRepository {
  toggle(input: { id: ID; messageId: ID; userId: ID; emoji: string; createdAt: UnixMs; on: boolean }): Promise<void>;
  countByMessage(messageId: ID): Promise<Record<string, number>>;
  getUserReaction(messageId: ID, userId: ID): Promise<string | null>;
}

export interface SavedMessageRepository {
  toggle(input: { id: ID; messageId: ID; userId: ID; teamId: ID; channelId: ID; createdAt: UnixMs; on: boolean }): Promise<void>;
  listByUser(input: { userId: ID; teamId: ID }): Promise<SavedMessageRecord[]>;
  isSaved(messageId: ID, userId: ID): Promise<boolean>;
}
