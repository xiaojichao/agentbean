# 活动图标徽标显示真实未读数 — 设计文档

- 日期: 2026-07-03
- 分支: `fix-activity-badge-unread`(基于 `main`,含 PR#395)
- 关联: PR#395(已 merged `bbf1c46`)— 活动页"标记已读"本地持久化

## 1. 背景

聊天页侧边栏"活动"图标上有一个粉色徽标,显示一个数字。用户反馈:**数字变来变去,不知道代表什么**。

## 2. 根因

徽标当前实现(`apps/web-next/app/[teamPath]/chat/page.tsx:898`):

```tsx
{Object.values(messagesByChannel).flat().filter((m) => m.senderKind !== 'system').length}
```

即"全局 store(`messagesByChannel`)里所有已加载 channel 的非系统消息**堆叠总数**"。这个数字:

- 随 store 内容实时跳:点不同 channel → join 历史 → 涨;切 team → 清空 → 归零;来新消息 → +1;
- **与"已读"完全无关**:点"全部标记已读"后纹丝不动(PR#395 的 `doneIds` 在 `ActivityView` 内部,徽标够不着);
- 与 `ActivityView` 内部的 `unreadCount`(`page.tsx:3597`,基于 `doneIds`)是两套互不相干的口径。

对比同文件收藏徽标(`page.tsx:903` `{savedIds.size}`)——它用顶层 state,数字有意义。活动徽标缺的正是"有意义的、顶层可见的未读口径"。

## 3. 目标

- 活动图标徽标显示**真实未读活动数**,且:
  - 点"全部标记已读" → 徽标降为 0;
  - 收到新活动消息 → 徽标 +1;
  - 切页/切 channel → 不乱跳;
  - 与活动页内部显示的"X 条未读"**完全一致**;
  - `ActivityView` 关闭(切到别的侧边栏视图)时,徽标仍实时准确;
  - 未读为 0 时隐藏徽标;颜色沿用粉色。

## 4. 非目标(YAGNI)

- **不做跨设备已读同步** — 继承 PR#395 的本地(localStorage)范围,不新增服务端事件/migration。
- **不做消息存储重构** — 不改 `messagesByChannel` 的整体语义,只新增一个 merge action。
- 不处理"未读数超过活动页显示的 80 条上限"的场景(活动页 `slice(0, 80)` 是既有行为,徽标跟随)。

## 5. 设计

核心矛盾:徽标在顶层,但"未读数 = (可见活动消息) − (已读 id 集合)"的两个集合当前都困在 `ActivityView` 内部(`doneIds` 是它的 `useState`;活动消息 `recent` 是它本地 join 的结果,没进全局 store)。解法 = 把这两个集合都上移到全局可见。

### 5.1 全局消息源:`store.ts` 新增 `upsertMessages`

```ts
upsertMessages(msgs: ChatMessage[]) {
  set((s) => {
    const next = { ...s.messagesByChannel };
    let changed = false;
    for (const msg of msgs) {
      const list = next[msg.channelId];
      if (list && list.some((m) => m.id === msg.id)) continue; // 已存在,跳过(不覆盖)
      changed = true;
      next[msg.channelId] = list ? [...list, msg] : [msg];
    }
    return changed ? { messagesByChannel: next } : s;
  });
}
```

- 按 `channelId` 分组、按 `id` 去重 merge;**已存在的 id 跳过,不覆盖**(保护 active channel 用户滚动加载的更多消息);
- 一次 `set`(批量),避免逐条 `appendMessage` 触发多次渲染;
- 无变化时返回 `s`(Zustand 不触发更新)。

### 5.2 已读状态上移:`doneIds` 提到顶层 `page.tsx`

- 从 `ActivityView` 内部移到顶层(与 `savedIds`/`reactionIds` 并列,约 `page.tsx:169`);
- 顶层加 hydrate/persist effect,**复用 PR#395 已 merged 的 `lib/chat-read-state`**(`loadReadIds`/`saveReadIds`/`readKey`);
- 沿用 PR#395 的 `loadedDoneKey` guard 防初始化竞态、按 `teamPath` 隔离 key;
- `ActivityView` 改为接收 `doneIds`/`setDoneIds` 作为 props(不再自持 state)。

### 5.3 共享未读计算:`lib/chat-scope.ts` 新增 `inboxActivityMessages`

```ts
export function inboxActivityMessages<T extends { channelId: string; senderKind: string; createdAt: number }>(
  messages: T[],
  visibleIds: Set<string>,
  limit = 80,
): T[] {
  return messagesForVisibleConversations(messages, visibleIds)
    .filter((m) => m.senderKind !== 'system')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}
```

- 顶层(算徽标)和 `ActivityView`(算列表 + 内部未读)共用此函数 → **数字完全一致,无重复逻辑、口径不会漂移**;
- 放 `chat-scope.ts`(它已是"聊天消息可见性过滤"的归属地,含 `messagesForVisibleConversations`)。

### 5.4 徽标改造:`page.tsx:898`

```tsx
const inboxUnread = inboxActivityMessages(Object.values(messagesByChannel).flat(), visibleIds)
  .filter((m) => !doneIds.has(m.id)).length;
// 渲染:inboxUnread > 0 时显示粉色徽标,否则不渲染
{inboxUnread > 0 && (
  <span className="ml-auto rounded bg-pink-100 px-1.5 py-0.5 text-[10px] font-medium text-pink-600">{inboxUnread}</span>
)}
```

### 5.5 `ActivityView` 改造

- 去掉 `recent` 本地 state;
- join effect 的结果改为 `upsertMessages(joinedMsgs)`(写进全局 store),替代原来的 `setRecent(...)`;
- `allMessages` 改为直接用 store:`inboxActivityMessages(Object.values(messagesByChannel).flat(), visibleIds)`;
- "全部标记已读"/单条"标记完成"改用 props 的 `setDoneIds`(逻辑不变,只是数据源换成 props)。

## 6. 数据流

```
ActivityView mount → join visible channels → upsertMessages → store
新消息到达        → appendMessage(已有)   → store
store 变化        → 顶层 inboxUnread 重算  → 徽标更新
标记已读          → 顶层 setDoneIds        → persist(localStorage) + 徽标更新
ActivityView 卸载 → store + doneIds 都在顶层 → 徽标仍实时准确
切 team           → store 清空 + doneIds 按 teamPath 重新 hydrate
```

## 7. 测试策略

- **`tests/chat-scope.test.ts`(新)**:`inboxActivityMessages` — visible 过滤、非系统过滤、sort desc、slice limit、空输入。
- **store `upsertMessages`**(扩展 `tests/state.test.ts` 或新文件):跨多 channel 分组、已存在 id 不覆盖、新 id 追加、无变化时不触发更新。
- **回归**:PR#395 的 `tests/chat-read-state.test.ts` 11 个测试保持不变且仍绿。
- 全量 `vitest run` + `tsc --noEmit` 通过。

## 8. 风险与边界

- **store 消息累积**:`upsertMessages` 只增不减。缓解:切 team 时 `setCurrentTeamId` 已清空 `messagesByChannel`;活动页 `slice(0, 80)` 限制显示。可接受(与现状 `recent` 行为等价)。
- **ActivityView join 性能**:多 channel × 20 条。`upsertMessages` 一次 `set` 批量,不逐条触发渲染。
- **active channel 滚动保护**:`upsertMessages` 的"已存在跳过"语义确保不覆盖用户滚动加载的更多消息。
