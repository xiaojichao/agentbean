export interface ConversationRef {
  id: string;
}

export interface ScopedMessage {
  channelId: string;
}

export function visibleConversationIds(channels: ConversationRef[], dms: ConversationRef[]): Set<string> {
  return new Set([...channels.map((item) => item.id), ...dms.map((item) => item.id)]);
}

export function activityConversationIds(
  visibleIds: Set<string>,
  mutedChannelIds: Set<string>,
  mutedChannelsReady = true,
): Set<string> {
  if (!mutedChannelsReady) return new Set();
  if (mutedChannelIds.size === 0) return new Set(visibleIds);
  return new Set([...visibleIds].filter((id) => !mutedChannelIds.has(id)));
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

export interface MessageId {
  id: string;
}

export function markMessagesDone<T extends MessageId>(doneIds: Set<string>, messages: T[]): Set<string> {
  const next = new Set(doneIds);
  for (const message of messages) next.add(message.id);
  return next;
}

export function setMessageDone(doneIds: Set<string>, messageId: string, done: boolean): Set<string> {
  const next = new Set(doneIds);
  if (done) {
    next.add(messageId);
  } else {
    next.delete(messageId);
  }
  return next;
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
 *  - 找不到 origin → 仅当新数据带有明确顶层 replyScope 时兜底为顶层；旧数据缺少信号时
 *    维持嵌套，避免把历史讨论串回复误提到主时间线。
 */
export interface ThreadAnchorMessage {
  id: string;
  threadId?: string;
  senderKind: string;
  meta?: Record<string, unknown>;
  metaJson?: string | null;
}

export function isTopLevelAgentReply(
  reply: ThreadAnchorMessage,
  origin: ThreadAnchorMessage | undefined,
): boolean {
  return reply.senderKind === 'agent'
    && (
      (origin !== undefined && origin.threadId === origin.id)
      || (origin === undefined && replyScope(reply) === 'channel')
    );
}

/**
 * 合并「服务端频道 history 快照」与「客户端当前消息」，作为频道消息的渲染真源。
 *
 * 修复「切频道/切页面后『正在处理…』消失」：dispatchStatus/dispatchId 是客户端实时累积的派生态
 * （由 message:dispatch-status 事件维护），不在服务端 MessageDto 里。applyChannelHistory 此前整体替换，
 * 会把客户端 running 态清成 undefined。此函数以服务端 history 为权威集合（决定消息去留与内容），
 * 但按 id 保留客户端的 dispatchStatus/dispatchId（服务端未带时）。
 *
 * 契约：
 *  - 结果集合与顺序以 incoming 为准（history 权威，反映删除）；current 仅用于补 dispatchState；
 *  - 同 id 消息：incoming 内容优先，dispatchStatus/dispatchId 缺省时回落到 current；
 *  - current 有但 incoming 没有的 pending dispatch 消息 → 暂时保留，避免切走再回来时
 *    limited history 把仍在处理的本地消息清掉；终态消息仍由 history 决定去留。
 *  - message:context 刚拉回来的搜索跳转上下文带客户端保护标记；limited history 不应覆盖掉它，
 *    否则旧 thread reply 会在滚动定位前消失。
 */
export interface DispatchStateMessage {
  id: string;
  dispatchStatus?: string;
  dispatchError?: string;
  dispatchId?: string;
  createdAt?: number;
  meta?: Record<string, unknown>;
}

export function mergeChannelHistory<T extends DispatchStateMessage>(
  incoming: T[],
  current: T[],
): T[] {
  const currentById = new Map<string, T>();
  for (const m of current) currentById.set(m.id, m);
  const incomingIds = new Set(incoming.map((message) => message.id));
  const merged = incoming.map((message) => {
    const existing = currentById.get(message.id);
    if (!existing) return message;
    return {
      ...message,
      dispatchStatus: message.dispatchStatus ?? existing.dispatchStatus,
      dispatchError: message.dispatchError ?? existing.dispatchError,
      dispatchId: message.dispatchId ?? existing.dispatchId,
    };
  });
  const oldestIncomingCreatedAt = incoming
    .map((message) => message.createdAt)
    .filter((createdAt): createdAt is number => typeof createdAt === 'number')
    .at(0);
  const pendingOnlyInCurrent = current.filter((message) => (
    !incomingIds.has(message.id)
    && (
      isContextLoadedMessage(message)
      || (isPendingDispatchStatus(message.dispatchStatus) && isWithinHistoryWindow(message, oldestIncomingCreatedAt))
    )
  ));
  if (pendingOnlyInCurrent.length === 0) return merged;
  const next = [...merged, ...pendingOnlyInCurrent];
  if (next.every((message) => typeof message.createdAt === 'number')) {
    next.sort((a, b) => a.createdAt! - b.createdAt!);
  }
  return next;
}

function isPendingDispatchStatus(status: string | undefined): boolean {
  return status === 'queued' || status === 'sent' || status === 'accepted' || status === 'running';
}

function isContextLoadedMessage(message: DispatchStateMessage): boolean {
  return message.meta?.__contextLoaded === true;
}

function isWithinHistoryWindow(message: DispatchStateMessage, oldestIncomingCreatedAt: number | undefined): boolean {
  return oldestIncomingCreatedAt === undefined
    || typeof message.createdAt !== 'number'
    || message.createdAt >= oldestIncomingCreatedAt;
}

function replyScope(message: ThreadAnchorMessage): string | undefined {
  if (typeof message.meta?.replyScope === 'string') return message.meta.replyScope;
  if (!message.metaJson) return undefined;
  try {
    const meta = JSON.parse(message.metaJson) as { replyScope?: unknown };
    return typeof meta.replyScope === 'string' ? meta.replyScope : undefined;
  } catch {
    return undefined;
  }
}
