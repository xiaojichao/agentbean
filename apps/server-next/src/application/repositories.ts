import type { AgentDto, ChannelDto, DeviceDto, DispatchDto, HumanMemberDto, ID, MessageDto, RuntimeDto, TeamDto, UnixMs, UserDto } from '../../../../packages/contracts/src/index.js';

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

export interface ChannelRecord extends ChannelDto {
  humanMemberIds: ID[];
  agentMemberIds: ID[];
}

export type MessageRecord = MessageDto;
export type DispatchRecord = DispatchDto & { prompt: string };
export interface AgentExecutionConfig {
  adapterKind: AgentDto['adapterKind'];
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
export type AgentRecord = AgentDto;
export type AgentUpsertRecord = AgentRecord & { env?: Record<string, string> };
export interface DeviceRecord extends DeviceDto {
  machineId?: string;
  profileId?: string;
  daemonVersion?: string;
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
  setCurrentTeam(userId: ID, teamId: ID): Promise<void>;
}

export interface TeamRepository {
  create(input: TeamRecord): Promise<TeamRecord>;
  getById(id: ID): Promise<TeamRecord | null>;
  listForUser(userId: ID): Promise<Array<TeamRecord & { currentUserRole: 'owner' | 'admin' | 'member' }>>;
  addMember(input: TeamMemberRecord): Promise<void>;
  isMember(teamId: ID, userId: ID): Promise<boolean>;
  getMemberRole(teamId: ID, userId: ID): Promise<'owner' | 'admin' | 'member' | null>;
  listMembersByIds(teamId: ID, userIds: ID[]): Promise<HumanMemberDto[]>;
}

export interface ChannelRepository {
  create(input: ChannelRecord): Promise<ChannelRecord>;
  getById(channelId: ID): Promise<ChannelRecord | null>;
  listForUser(teamId: ID, userId: ID): Promise<ChannelRecord[]>;
  update(input: {
    channelId: ID;
    changes: Partial<Pick<ChannelRecord, 'name' | 'title' | 'visibility' | 'humanMemberIds' | 'agentMemberIds' | 'updatedAt'>>;
  }): Promise<ChannelRecord | null>;
}

export interface DeviceRepository {
  upsertHello(input: DeviceRecord): Promise<DeviceRecord>;
  getById(id: ID): Promise<DeviceRecord | null>;
  findByMachineProfile(machineId: string, profileId: string): Promise<DeviceRecord | null>;
  listByTeam(teamId: ID): Promise<DeviceRecord[]>;
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
  linkIdentity(input: { identityKey: string; agentId: ID; kind: string; timestamp: UnixMs }): Promise<void>;
  markMissingScannedOffline(input: { teamId: ID; deviceId: ID; seenIdentityKeys: string[]; timestamp: UnixMs }): Promise<ID[]>;
  updateStatus(input: { agentId: ID; status: AgentRecord['status']; lastSeenAt: UnixMs; lastError?: string }): Promise<void>;
  listVisibleInTeam(teamId: ID): Promise<AgentRecord[]>;
}

export interface MessageRepository {
  append(input: MessageRecord): Promise<MessageRecord>;
  getById(messageId: ID): Promise<MessageRecord | null>;
  listByChannel(channelId: ID, limit: number): Promise<MessageRecord[]>;
}

export interface DispatchRepository {
  create(input: DispatchRecord): Promise<DispatchRecord>;
  getById(id: ID): Promise<DispatchRecord | null>;
  markSucceeded(input: { dispatchId: ID; completedAt: UnixMs }): Promise<DispatchRecord | null>;
  markTimedOut(input: { dispatchId: ID; error: string; completedAt: UnixMs }): Promise<DispatchRecord | null>;
  markFailed(input: { dispatchId: ID; error: string; completedAt: UnixMs }): Promise<DispatchRecord | null>;
  listPendingOlderThan(timestamp: UnixMs): Promise<DispatchRecord[]>;
  listByMessage(messageId: ID): Promise<DispatchRecord[]>;
}

export interface ServerNextRepositories {
  users: UserRepository;
  teams: TeamRepository;
  channels: ChannelRepository;
  devices: DeviceRepository;
  runtimes: RuntimeRepository;
  agents: AgentRepository;
  messages: MessageRepository;
  dispatches: DispatchRepository;
}
