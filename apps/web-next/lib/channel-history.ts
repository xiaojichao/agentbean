import type { ChannelHistoryPaginationDto } from '@agentbean/contracts';
import type { ChatMessage } from './schema';

export interface ChannelHistoryState extends ChannelHistoryPaginationDto {
  /** Once older pages are loaded, fresh snapshots must not discard the accumulated history. */
  loadedOlder: boolean;
}

export function channelHistoryPagination(value: Partial<ChannelHistoryPaginationDto>): ChannelHistoryPaginationDto | undefined {
  if (typeof value.hasMore !== 'boolean') return undefined;
  if (value.hasMore && typeof value.nextBeforeMessageId !== 'string') return undefined;
  return { hasMore: value.hasMore, nextBeforeMessageId: value.nextBeforeMessageId ?? null };
}

/** Prepend an older page, retaining current values for overlapping live messages. */
export function mergeOlderChannelMessages(current: ChatMessage[], older: ChatMessage[]): ChatMessage[] {
  const byId = new Map(older.map((message) => [message.id, message]));
  for (const message of current) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt);
}
