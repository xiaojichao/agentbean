# 实时层：socket 单例、Zustand、按 id 合并 history

## 何时适用

新增/修改实时事件流、给 store 加消息/状态字段、改服务端 history 合并、过滤系统消息、判定顶层 Agent 回复时。

## 本地模式

### 1. socket 是懒单例，token 在 localStorage

`apps/web-next/lib/socket.ts` 是实时层唯一入口：

- `getWebSocket()`（`:211-226`）懒初始化单例 `webSocket`，`io(`${getServerUrl()}/web`, { transports: ['websocket'], autoConnect: true, auth: { token, currentDeviceId, deviceToken } })`。
- server URL：`getServerUrl()`（`:80-84`）优先 `process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL`，否则 `window.location.origin`，再否则 `http://localhost:4100`。
- token 三件套存 localStorage（`:32-34`）：`agentbean.token`、`agentbean.deviceId`、`agentbean.deviceToken`；`getStoredToken()`/`getStoredAuthToken()`/`getStoredDeviceToken()` 读，`clearStoredAuth()`（`:68-74`）清。
- HTTP 数据获取用 `authedApiUrl(path)`（`:90-93`），把 token 拼成 `?token=` query。
- ack 超时用 `emitWithTimeout`（`:254-264`）：默认 10s，超时 resolve `{ ok: false, error: 'timeout' }`（**不 reject**，避免未 catch 时 Unhandled (in promise)），调用方一律 `if (res.ok)` 守卫。

### 2. 事件工厂包 `socket.on`/`emitWithAck`，返 `{ onX, subscribe, emitX }`

每个领域一个 `xxxEvents(socket = getWebSocket())` 工厂，返回的方法既封装 emit 也封装订阅。代表 `agentEvents`（`:278-311`）：

```ts
export function agentEvents(socket: Socket = getWebSocket()): AgentEvents {
  return {
    onSnapshot(handler) { /* socket.on + 返回 unsubscribe */ },
    metrics(teamId) { return emitWithTimeout(socket, WEB_EVENTS.agent.metrics, { teamId }); },
    subscribe(teamId) { socket.emit(WEB_EVENTS.agent.subscribe, { teamId }); },
    ...
  };
}
```

现有工厂（同文件）：`agentEvents`、`teamEvents`、`channelEvents`、`dmEvents`、`memberEvents`、`projectEvents`、`memoryEvents`、`deviceEvents`、`taskEvents`、`dispatchEvents`、`authEvents`、`joinEvents`、`piProviderEvents`、`agentExposureEvents`、`agentMemoryProjectionEvents`、`systemActivityEvents`、`taskRemediationEvents`、`experiencePackEvents`、`systemKnowledgeEvents`、`userMemoryEvents`、`piUsageEvents`、`piPolicyEvents`、`messageReactionEvents`。事件名常量统一来自 `@agentbean/contracts` 的 `WEB_EVENTS`。

**新增实时流规矩**：在 `lib/socket.ts` 加 `xxxEvents` 工厂，返回 `{ subscribe, onX, emitX }`；页在 `useEffect` 内订阅、return 清理（见 [components-and-state.md](./components-and-state.md) §4）。

### 3. store.ts 的 State 与 reducer

`apps/web-next/lib/store.ts` 的 `interface State`（`:171-215`）持有：`conn`、`agents`（alias map）、`agentRecords`、`visibleAgents`、`channels`、`dms`、`messagesByChannel`、`activityMessages`、`outbox`、`teams`、`currentTeamId`、`currentUser`、`devices`、`humans`、`agentMetrics` 等，加一组类型化 action（`applyAgentsSnapshot`、`applyChannelHistory`、`appendMessage`、`applyDispatchStatus` 等）。

纯 reducer 单独 `export` 供测试，如 `mergeMessagesByChannel`（store.ts 内）、`mergeChannelHistory`/`isTopLevelAgentReply`（在 `lib/chat-scope.ts`）。

### 4. mergeChannelHistory：服务端 history 对集合/顺序/内容权威，按 id 保留客户端派生态

切频道/切页面回来时，server 经 `channel:history` 下发频道快照。`apps/web-next/lib/store.ts:338-343` 的 `applyChannelHistory` 调 `mergeChannelHistory(msgs, existing)`（**不是**整数组替换）。

`apps/web-next/lib/chat-scope.ts:158-192` 的 `mergeChannelHistory` 契约（docblock 在 `:133-148`）：

- 结果集合与顺序以 `incoming` 为准（history 权威，反映删除/编辑）；
- 同 id 消息：incoming 内容优先；`dispatchStatus`/`dispatchError`/`dispatchId` 缺省时回落到 current（`:168-173`，`message.dispatchStatus ?? existing.dispatchStatus`）。这些字段是客户端由 `message:dispatch-status` 事件累积的派生态，不在服务端 `MessageDto` 里。
- current 有但 incoming 没有的消息：仅当带 `meta.__contextLoaded`（搜索跳转拉回的上下文）或 `dispatchStatus` 仍 pending（`queued`/`sent`/`accepted`/`running`）且在历史时间窗内（`createdAt >= oldestIncomingCreatedAt`）才暂时保留（`:179-185`），避免 limited history 把仍在处理的本地消息清掉。
- 调用方：`apps/web-next/components/conversation-page.tsx` 的 `onHistory` 回调里 `applyChannelHistory(channelId, payload.messages)`（见 store.ts grep 与 conversation-page.tsx:30-35 区域）。

### 5. shouldHideSystemMessage：委托 contracts 的 isHiddenSystemMessage

`apps/web-next/lib/system-messages.ts:14-16` 的 `shouldHideSystemMessage(msg)` 把 `{ senderKind, meta }` 传给 `@agentbean/contracts` 的 `isHiddenSystemMessage`。跨 transport 隐藏合同的单一真相源在 contracts（服务端在序列化边界同样用它）；前端这层是防御兜底。**保留可见**的例外：`management-question`（需回应）、`management-delivery`（需验收）。修改跨 transport 规则要改 contracts，不要在前端单方面加白名单/黑名单；只影响特定界面的 presentation projection 见下一节。

### 6. projectChatViewMessages：transport 原始消息与聊天投影分层

`apps/web-next/lib/chat-message-projection.ts` 负责 Web 聊天消费面的统一投影：

- transport/store 的原始消息集合继续保留 `task-status-updated`，供 TaskDetail 通过
  `taskStatusMessagesForTask(...)` 恢复完整状态历史；
- 频道主线、Thread 回复/计数、Activity 与消息搜索统一消费
  `projectChatViewMessages(...)`，不展示任务状态流水；
- 历史 `?message=` 指向被隐藏的状态事件时，使用
  `taskIdForStatusMessageDeepLink(...)` 改道 TaskDetail；
- 投影复用 `taskStatusEventSummary` / `taskStatusEventForTask` 与
  `mergedStandalonePackageCardIds`，不在页面重复解析任务状态语义；
- 这是 presentation projection，不得下沉为 Contracts/Server 的 Message 序列化过滤，
  也不得把里程碑卡重新制造成 Message。

`shouldHideSystemMessage` 仍只委托 Contracts 的跨 transport 隐藏合同；
`task-status-updated` 的 chat-view 分层是上述受控例外，不扩写该合同。

### 7. isTopLevelAgentReply：判定 Agent 回复进主时间线还是嵌套

`apps/web-next/lib/chat-scope.ts:122-131` 的 `isTopLevelAgentReply(reply, origin)`：

- 仅 agent 回复适用；
- `origin.threadId === origin.id`（origin 是顶层 root）→ true（进主时间线）；
- origin 在显式讨论串（`threadId !== origin.id`）→ false（嵌套进该串）；
- 找不到 origin 时，仅当 `reply.meta.replyScope === 'channel'` 兜底为 true。

背景（docblock `:99-113`）：服务端给 agent 回复写 `threadId = originMessage.id` 作「对话归组」标记；当 origin 是顶层 root 时这个 threadId 不应让前端把 agent 回复判成「有父消息」而嵌套，否则用户主时间线只看到自己的消息，Agent 回复藏在「讨论串」按钮后。

## 佐证文件

- `apps/web-next/lib/socket.ts:31-34`（env key 与 storage key）、`:80-93`（server URL 与 authedApiUrl）、`:211-226`（getWebSocket 单例）、`:254-264`（emitWithTimeout）、`:278-311`（agentEvents 工厂样板）。
- `apps/web-next/lib/store.ts:171-215`（State）、`:202`（applyChannelHistory 签名）、`:338-343`（实现调 mergeChannelHistory）。
- `apps/web-next/lib/chat-scope.ts:122-131`（isTopLevelAgentReply）、`:133-192`（mergeChannelHistory docblock+实现）、`:194-206`（pending/contextLoaded/window 辅助判定）。
- `apps/web-next/lib/system-messages.ts:14-16`（shouldHideSystemMessage 委托）。
- `apps/web-next/components/conversation-page.tsx:17-62`（订阅+清理样板，onHistory/onMessage/onDispatchStatus）。
- `apps/web-next/lib/chat-message-projection.ts`（transport 原始消息 → chat-view 投影、TaskDetail 状态恢复、历史深链改道）。

## 反模式

- 用 `applyChannelHistory` 整数组替换 `messagesByChannel[channelId]`——会抹掉客户端 `dispatchStatus`/`dispatchId`（切频道时「正在处理…」消失）。必须走 `mergeChannelHistory`。
- 在前端自行扩 `shouldHideSystemMessage` 的跨 transport 可见/隐藏名单——真相源在 contracts 的 `isHiddenSystemMessage`；仅界面分层规则进入 `chat-message-projection.ts`。
- 直接 `socket.emit(...)` 不走 `emitWithTimeout`——调用方未 catch 时 ack 超时会变 Unhandled rejection。
- 订阅事件不在 effect return 里 `socket.off`——跨页泄漏。
- 把 `dispatchStatus` 当服务端字段写进 history merge 的「权威内容」——它只是 `?? existing` 的兜底。

## 验证命令

```bash
cd apps/web-next && npm test                                # 含 chat-scope.test.ts
cd apps/web-next && npx vitest run tests/chat-scope.test.ts # mergeChannelHistory/isTopLevelAgentReply 单测
cd apps/web-next && npx vitest run tests/chat-message-collapse.test.ts tests/chat-task-surface.test.ts
cd apps/web-next && npx vitest run tests/chat-message-projection.test.ts tests/task-thread-activity-section.test.tsx
```
