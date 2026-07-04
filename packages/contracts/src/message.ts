import type { ID, UnixMs } from './common.js';
import type { ArtifactDto, WorkspaceRunDto } from './artifact.js';
import type { DispatchStatus } from './dispatch.js';

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
  /**
   * 进行中 dispatch 的状态投影。dispatchStatus/dispatchId 不在 MessageRecord，
   * 由 server 在消息读路径（channel:history、DM snapshot、search）用 dispatches.listByMessage 投影，
   * 使前端切频道/刷新后能恢复「正在处理」指示（不在客户端实时事件流时也能拿到真相）。
   */
  dispatchStatus?: DispatchStatus;
  dispatchId?: ID;
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
