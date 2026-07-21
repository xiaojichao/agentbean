import type { ID, UnixMs } from './common.js';
import type { ArtifactDto, WorkspaceRunDto } from './artifact.js';
import type { DispatchStatus } from './dispatch.js';

export type SenderKind = 'human' | 'agent' | 'system';
export type RouteReason = 'MENTION' | 'DIRECT' | 'CHANNEL_DEFAULT' | 'MANUAL';

export const MESSAGE_BATCH_QUIET_WINDOW_MS = 15_000;

/**
 * 结构化 @提及：发送时把 body 里的 @name 关联到稳定 id，渲染/dispatch 用 id 解析当前 name，
 * 使提及跟随成员改名（Slack/Discord 做法）。body 仍存 @name 文本（给 LLM/人读 + 向后兼容）。
 * 旧消息无 mentions → 降级为按 body name 文本匹配（现状）。
 */
export interface MessageMentionDto {
  /** 被提及成员的稳定 id（agentId / userId）——改名后渲染/dispatch 仍可定位 */
  id: ID;
  kind: 'human' | 'agent';
  /** 发送时的 name 快照（id 失效或旧消息降级时 fallback） */
  name: string;
  /** @提及在 body 中的字符偏移区间 [start, end) */
  start: number;
  end: number;
}

export interface MessageMetaDto {
  routeReason?: RouteReason;
  mentionedName?: string;
  mentions?: MessageMentionDto[];
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
  /** DispatchDto.error 投影（如 DISPATCH_TIMEOUT / WORKSPACE_RUN_FAILED），供频道失败提示分类。 */
  dispatchError?: string;
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
