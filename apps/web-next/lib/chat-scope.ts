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
 *  - 同 id 以 memoryMessages 版本优先（内存更新新鲜）；
 *  - 结果按 createdAt 降序。
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

export interface ActivityMessage {
  channelId: string;
  senderKind: string;
  createdAt: number;
}

export function inboxActivityMessages<T extends ActivityMessage>(
  messages: T[],
  visibleIds: Set<string>,
  limit = 80,
): T[] {
  return messagesForVisibleConversations(messages, visibleIds)
    .filter((m) => m.senderKind !== 'system')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

/**
 * 判定一条 agent 回复是否属于「频道/DM 顶层对话」，应进主时间线，而非嵌套进隐式讨论串。
 *
 * 修复「agent 回复在主时间线不可见」：服务端给 agent 回复写 threadId = originMessage.id
 * （见 server-next usecases receiveDispatchResult）。当 origin 是顶层 root（threadId === 自身 id）
 * 时，这个 threadId 只是「对话归组」标记，不应让 agent 回复被前端 parentMessageId 判定为
 * 「有父消息」而嵌套——否则用户在主时间线只看到自己的消息，agent 回复藏在「讨论串」按钮后。
 *
 * 决策点：
 *  - 仅 agent 回复适用（人类消息的 threadId 仍按原语义）；
 *  - origin 是顶层 root（threadId === origin.id）→ 顶层对话 → 进主时间线（true）；
 *  - origin 在显式讨论串（threadId !== origin.id）→ agent 回复加入该讨论串（false，仍嵌套）；
 *  - 找不到 origin → 保守返回 false，维持原有嵌套行为，避免历史消息未加载时误判。
 */
export interface ThreadAnchorMessage {
  id: string;
  threadId?: string;
  senderKind: string;
}

export function isTopLevelAgentReply(
  reply: ThreadAnchorMessage,
  origin: ThreadAnchorMessage | undefined,
): boolean {
  return reply.senderKind === 'agent'
    && origin !== undefined
    && origin.threadId === origin.id;
}
