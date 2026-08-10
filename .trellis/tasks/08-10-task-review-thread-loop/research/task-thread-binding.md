# Research: Task ↔ Thread 绑定与 Thread 打开机制（web 端）

- **Query**: task 有 threadId 吗？频道里 thread 如何打开（路由/状态）？现有从别处跳进 thread 的机制
- **Scope**: internal（apps/web-next）
- **Date**: 2026-08-10

## Findings

### Task → Thread 的绑定表达

Web 端 Task DTO 本身**没有 threadId 字段**；绑定通过两条路径：

1. **Server 投影直下**：`StageDeliveryReviewWorkspaceV1.threadRootMessageId?: ID`（packages/contracts/src/stage-delivery-review-workspace.ts:104-105，注释「管理型根任务存在时指向持久化的来源 Thread；普通阶段任务可为空」）。这是阶段工作区「回到讨论串」按钮的数据源。
2. **消息 meta 反推**：`metaTaskId(msg) = taskRootIdFromMessageMeta(parseMeta(msg))`（chat/page.tsx:6492-6494；`taskRootIdFromMessageMeta` 在 apps/web-next/lib/task-status-event.ts:29）。反方向 task → root message 用 `findTaskRootMessage(task, messages)`（tasks/page.tsx:1716；chat page 内也有同名局部实现），在频道消息里找 meta 指向该 task 的根消息。tasks 页还有回落：`threadParentId = threadRoot?.id ?? selectedTask?.id`（tasks/page.tsx:395）。

### Thread 打开机制（chat 页）

- 状态：`const [threadRootId, setThreadRootId] = useState<string | null>(null)`（chat/page.tsx:435）。
- `openThread(messageId)`（:1485-1491）：setThreadRootId + 清 task 详情态 + `setThreadUrl(messageId)`。
- `closeThread()`（:1493-1503）：清 rootId/threadInput/threadSelections/threadAttachments + 移除 URL 参数。
- URL 深链：`setThreadUrl`（:1453-1465）写 `?thread=<channelId>:<messageId>`（router.replace，scroll:false）；`threadParam` 经 `parseThreadMessageId`（:6522-6524 → `parseScopedMessageId` :6526-6538，校验冒号左侧等于当前 channelId）在 effect（:1581-1588）里回灌 state。刷新/分享链接可直达讨论串。
- 渲染：`threadRoot = visibleMessages.find(msg => msg.id === threadRootId)`（:1837），`threadReplies` 按 `parentMessageId(...) === threadRootId` 过滤（:1839，parentMessageId 含 isTopLevelAgentReply 顶层回落逻辑 :6496-6520）。`{!profileTarget && !taskDetailMessage && threadRoot && ...}` 时渲染右侧 `ThreadPanel`（:2933-2948+），带宽度拖拽把手（useThreadPanelWidth, lib/thread-panel-resize）。

### 现有「从别处跳进 thread」的机制

| 入口 | 位置 | 机制 |
|---|---|---|
| 消息气泡/上下文菜单「打开讨论串」 | chat/page.tsx:5699, 5839, 5859, 2594 | `openThread(msg.id)` |
| 阶段工作区「回到讨论串」 | chat/page.tsx:2895-2900 | `openThread(rootMessageId ?? taskDetailMessage?.id)` + 预填「要求后续变更：」 |
| 任务详情「交给智能体处理」(delegate-to-agent) | chat/page.tsx:2909-2919 | openThread + `setThreadInput('@')` + 聚焦；task-only 回落主 composer |
| Tasks 页「交给 Agent 处理」（#1064 AC1/AC2） | tasks/page.tsx:366-375 | **跨页 URL 导航**：`router.push('/<team>/channel/<cid>?thread=<cid>:<rootId>&compose=<urlencoded JSON>')`，compose JSON = `{ text, selections }`；chat 页 effect（:1590-1613）解析 compose → 写 `threadInput`/`threadSelections` 本地 state → 聚焦 → 立即从 URL 删除 compose 参数。注释明示「预填不创建任何事实」 |
| Tasks 页行内 thread 面板 | tasks/page.tsx:140,405-411,537-542 | 自有 `?thread=<channelId>:<itemId>` 参数（itemId 可以是 taskId 或 messageId，`parseThreadParam` + `selectedTask` 反查 :348-355），面板内直接发 thread 消息（message.send 带 threadId） |
| 回复（handleReply） | chat/page.tsx:2200-2204 | openThread + 预填「回复 <speaker>: 」 |

### 关键语义（#1064 确立，#1065 沿用）

预填导航只携带 `text + selections`（`ProjectReferenceSelectionRequestDto[]`），落笔均为**本地 state**——未发送不创建 Message/Offer/claim/Invocation/负责人事实（chat/page.tsx:1590-1592 注释；tasks/page.tsx:369 注释）。发送时由 Server 把 selections 冻结为消息 ProjectReferenceSet。

## Caveats / Not Found

- chat 页与 tasks 页各有一套 thread 状态/参数实现，互不共享组件（ThreadPanel 定义在 chat/page.tsx:4714；tasks 页有自己的面板 :725 附近）。
- task-only 任务（看板直接创建、无关联消息）在 chat 页没有可打开的 thread——delegate 动作回落到主 composer；阶段工作区「回到讨论串」按钮在 `threadRootMessageId` 为空时 disabled。
