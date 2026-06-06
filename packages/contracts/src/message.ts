import type { ID, UnixMs } from './common.js';

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
  senderKind: SenderKind;
  senderId: ID;
  body: string;
  createdAt: UnixMs;
  updatedAt?: UnixMs;
  meta?: MessageMetaDto;
}
