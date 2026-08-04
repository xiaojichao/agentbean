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
  archivedAt?: UnixMs | null;
  revision?: number;
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

export type ChannelArchiveWorkKind =
  | 'task'
  | 'invocation'
  | 'claim'
  | 'lease'
  | 'offer'
  | 'pending_review'
  /**
   * #1066：package 级（#1061 reviews 表）待审核 delivery——Task 状态
   * 未必是 in_review，但存在尚未收敛的审核事实。
   */
  | 'pending_review_delivery'
  /** #1066：publish 已 committed 且带 provenance、但尚未形成 OutputPackage 的交付。 */
  | 'pending_delivery';

export interface ChannelArchivePreflightItemDto {
  kind: ChannelArchiveWorkKind;
  id: ID;
  title?: string;
  status: string;
}

export interface ChannelArchivePreflightDto {
  channelId: ID;
  channelRevision: number;
  confirmationToken: string;
  expiresAt: UnixMs;
  summary: {
    tasks: number;
    invocations: number;
    claims: number;
    leases: number;
    offers: number;
    pendingReviews: number;
    /** #1066：尚未收敛为 OutputPackage 的 committed 交付数（pendingDeliveries）。 */
    pendingDeliveries: number;
  };
  items: ChannelArchivePreflightItemDto[];
}

export interface ChannelArchiveConfirmationDto {
  channel: ChannelDto;
  cancelledTaskIds: ID[];
  releasedClaimIds: ID[];
  invalidatedOfferIds: ID[];
  cancelledInvocationIds: ID[];
  pendingReviewTaskIds: ID[];
  /** #1066：归档时列出的 package 级待审核 delivery（只读历史保留，不删除）。 */
  pendingReviewDeliveryIds: ID[];
  /** #1066：归档时显式收口为 failed 的 open/failed publish staging 数。 */
  cancelledStagingCount: number;
}

export interface ChannelArchiveCommandDto {
  userId: ID;
  teamId: ID;
  channelId: ID;
  confirmationToken?: string;
}
