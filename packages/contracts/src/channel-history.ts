import type { ID } from './common.js';
import type { MessageDto } from './message.js';

/** 主消息分页信息；讨论串回复不占用 limit。游标是本页最早的主消息 ID。 */
export interface ChannelHistoryPaginationDto {
  readonly hasMore: boolean;
  readonly nextBeforeMessageId: ID | null;
}

export interface ChannelHistoryPageDto extends ChannelHistoryPaginationDto {
  readonly messages: MessageDto[];
}
