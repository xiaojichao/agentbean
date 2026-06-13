import type { ID, UnixMs } from './common.js';
import type { ArtifactDto, WorkspaceRunDto } from './artifact.js';

export type SenderKind = 'human' | 'agent' | 'system';
export type RouteReason = 'MENTION' | 'DIRECT' | 'CHANNEL_DEFAULT' | 'MANUAL';

export interface MessageMetaDto {
  routeReason?: RouteReason;
  mentionedName?: string;
  attachments?: ID[];
  [key: string]: unknown;
}

export interface MessageDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  threadId?: ID;
  senderKind: SenderKind;
  senderId: ID;
  body: string;
  createdAt: UnixMs;
  updatedAt?: UnixMs;
  meta?: MessageMetaDto;
  artifacts?: ArtifactDto[];
  workspaceRun?: WorkspaceRunDto;
  reactionCounts?: Record<string, number>;
  saved?: boolean;
}

export interface ReactInputDto {
  userId?: ID;
  teamId: ID;
  messageId: ID;
  emoji?: string;
  on: boolean;
}

export interface SaveInputDto {
  userId?: ID;
  teamId: ID;
  messageId: ID;
  on: boolean;
}

export interface ListSavedInputDto {
  userId?: ID;
  teamId: ID;
}

export interface MessageSearchInputDto {
  userId?: ID;
  teamId: ID;
  query: string;
  limit?: number;
}

export interface MessageSearchResultDto {
  messages: MessageDto[];
}
