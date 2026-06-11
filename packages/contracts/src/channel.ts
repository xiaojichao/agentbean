import type { ID, UnixMs } from './common.js';
import type { AgentDto } from './agent.js';
import type { HumanMemberDto } from './auth.js';

export type ChannelKind = 'channel' | 'direct';
export type ChannelVisibility = 'public' | 'private';

export interface ChannelDto {
  id: ID;
  teamId: ID;
  kind: ChannelKind;
  name: string;
  visibility: ChannelVisibility;
  title?: string;
  dmTargetAgentId?: ID;
  createdBy?: ID;
  createdAt: UnixMs;
  updatedAt?: UnixMs;
}

export interface CreateChannelCommandDto {
  userId: ID;
  teamId: ID;
  name: string;
  title?: string;
  visibility: ChannelVisibility;
  humanMemberIds?: ID[];
  agentMemberIds?: ID[];
}

export interface UpdateChannelCommandDto {
  userId: ID;
  teamId: ID;
  channelId: ID;
  name?: string;
  title?: string;
  visibility?: ChannelVisibility;
  humanMemberIds?: ID[];
  agentMemberIds?: ID[];
}

export interface ChannelHumanMemberCommandDto {
  userId: ID;
  teamId: ID;
  channelId: ID;
  memberUserId: ID;
}

export interface ChannelAgentMemberCommandDto {
  userId: ID;
  teamId: ID;
  channelId: ID;
  agentId: ID;
}

export interface ListChannelMembersCommandDto {
  userId: ID;
  teamId: ID;
  channelId: ID;
}

export interface ChannelMembersDto {
  humanMemberIds: ID[];
  agentMemberIds: ID[];
  humans: HumanMemberDto[];
  agents: AgentDto[];
}

export interface DmChannelDto {
  channel: ChannelDto;
  agent: AgentDto;
}

export interface StartDmCommandDto {
  userId: ID;
  teamId: ID;
  agentId: ID;
}

export interface ListDmsCommandDto {
  userId: ID;
  teamId: ID;
}

export interface SnapshotDmCommandDto {
  userId: ID;
  teamId: ID;
  channelId: ID;
  limit?: number;
}
