export interface ConversationRef {
  id: string;
}

export interface ScopedMessage {
  channelId: string;
}

export function visibleConversationIds(channels: ConversationRef[], dms: ConversationRef[]): Set<string> {
  return new Set([...channels.map((item) => item.id), ...dms.map((item) => item.id)]);
}

export function messagesForVisibleConversations<T extends ScopedMessage>(messages: T[], ids: Set<string>): T[] {
  if (ids.size === 0) return [];
  return messages.filter((message) => ids.has(message.channelId));
}
