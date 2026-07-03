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

/**
 * 可被收藏/合并的最小消息契约：仅需稳定 id 与时间戳。
 * 用泛型而非绑定 ChatMessage，便于测试与复用。
 */
export interface SaveableMessage {
  id: string;
  createdAt: number;
}

/**
 * 合并「服务端收藏快照」与「当前内存消息」，作为收藏列表的单一渲染真源。
 *
 * 修复「收藏 badge 数 ≠ 列表条数」的根因：列表此前套了 visibleConversationIds 过滤，
 * 会丢掉那些 channelId 已不在可见会话（如已删除/已离开的频道）里的收藏。
 * 此函数确保快照中所有收藏都被保留，内存只用来刷新同一条消息的最新内容。
 *
 * 契约：
 *  - 两份来源按 id union，去重；
 *  - 同 id 以 memoryMessages 版本优先（内存更新鲜）；
 *  - 结果按 createdAt 降序。
 *
 * TODO(contrib): 函数体待实现（见 tests/saved-messages-merge.test.ts 的契约）。
 */
export function mergeSavedMessages<T extends SaveableMessage>(
  savedSnapshot: T[],
  memoryMessages: T[],
): T[] {
  // 策略决策点（默认：内存优先）：Map.set 后写覆盖，因此把快照先放入、
  // 内存后放入，同 id 时内存版本胜出（内存更新鲜）。
  // 若想要「快照优先」交换两个 for 的顺序；「按 createdAt 最新」则比较时间戳决定写入。
  const byId = new Map<string, T>();
  for (const m of savedSnapshot) byId.set(m.id, m);
  for (const m of memoryMessages) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}
