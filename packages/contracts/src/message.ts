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
}
