# apps/web dispatch:cancel 接入设计

- 日期：2026-06-19
- 范围：`apps/web`（纯前端接入，server-next / contracts 零改动）
- 关联：`agentbean-next/docs/known-gaps.md`（dispatch cancel web affordance 缺口）

## 1. 背景与目标

server-next 早已实现 dispatch 取消链路（`dispatch:cancel` 命令、`cancelDispatch` usecase、daemon cancel signal、`message:dispatch-status` 广播），但 `apps/web` **完全没有接入**——不监听 dispatch 状态、无取消按钮、消息流中无「agent 处理中」指示（用户发消息后只能干等 agent reply 到达）。

本设计在 web 侧补全：实时展示 dispatch 状态 + running 时可取消。

### 成功标准

- 用户发出触发 dispatch 的消息后，human message 下方显示「agent 正在处理…」指示。
- dispatch 状态变化（running → succeeded/failed/cancelled/timed_out）实时反映到指示。
- running 时提供「取消」按钮，点击后发 `dispatch:cancel`，dispatch 转为 cancelled。
- server-next 与 packages/contracts 零改动。

## 2. 基线

### 2.1 web 现状（缺口）

- `apps/web/lib/schema.ts:52-61`：`ChatMessage { id, channelId, senderKind, senderId, body, createdAt, metaJson?, artifacts? }` —— **无 dispatchStatus 字段**。
- `apps/web/components/conversation-page.tsx`（113 行）：只监听 `channels:snapshot`/`channel:history`/`channel:message`，**无 `message:dispatch-status` 监听**，无 loading/typing 指示。
- `apps/web/components/channel-message.tsx`：展示单条消息（senderKind human/agent/system），无 dispatch 状态。
- `OutboundMessage`（schema.ts:99-104）是 human 消息发送状态（pending/sent/failed），与 dispatch status 无关。
- 消息流：发 `message:send`（optimistic）→ 干等 `channel:message`（agent reply）。

### 2.2 协议（已就绪）

- `packages/contracts/src/socket.ts:78`：`message.dispatchStatus = 'message:dispatch-status'`。
- `packages/contracts/src/socket.ts:85`：`dispatch.cancel = 'dispatch:cancel'`。
- `apps/server-next/src/transport/socket-server.ts:722`：`message:dispatch-status` 广播 **`DispatchDto`**（含 `id`(dispatchId)/`messageId`/`status`/`error`/timestamps）。
- `apps/server-next/src/transport/socket-handlers.ts:190`：`dispatch:cancel` → `cancelDispatch` usecase（`usecases.ts:2366`），返回 `DispatchDto`，并经 `dispatchStatus` 回调广播状态。
- `packages/contracts/src/dispatch.ts:5-13`：`DispatchStatus = queued|sent|accepted|running|succeeded|failed|cancelled|timed_out`。

### 2.3 可复用模式

- 命令发送：`emitWithTimeout(socket, event, payload)`（`lib/socket.ts:178`）。
- 事件监听 + cleanup：`socket.on(event, handler)` + `useEffect` 返回 `socket.off`（`conversation-page.tsx:43-52`）。
- 状态胶囊：`runs/page.tsx:23-28` 的 `STATUS_CONFIG`（running 蓝/succeeded 绿/failed 红/cancelled 灰）。
- 危险/次要按钮：`settings/page.tsx` 的 Tailwind 按钮样式（含红色撤销按钮）。
- 状态管理：Zustand `useAgentBeanStore` + 本地 `useState/useEffect`。

## 3. 设计决策

| 决策 | 选定 | 理由 |
|------|------|------|
| 范围 | 状态展示 + 取消按钮 | 核心闭环，YAGNI；不做 history 面板/详细 error/重试 |
| 状态存储 | `ChatMessage` 加 `dispatchStatus?` + `dispatchId?` 字段 | message 自带状态，简单；避免额外 store map |
| 展示位置 | human message 下方「正在处理 [取消]」指示 | ChatGPT 式，触发 dispatch 的消息旁显示进展；agent reply 到达后更新 |
| 取消触发 | running 时按钮发 `dispatch:cancel { dispatchId }` | dispatchId 来自收到的 DispatchDto.id |

## 4. 架构

### 4.1 数据模型（`lib/schema.ts`）

`ChatMessage` 增加两个可选字段：

```typescript
export interface ChatMessage {
  id: string;
  channelId: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson?: string | null;
  artifacts?: Artifact[];
  dispatchStatus?: DispatchStatus;  // 新增
  dispatchId?: string;              // 新增
}
```

`DispatchStatus` 类型从 contracts 引入（或在 schema 本地镜像）。

### 4.2 监听（`conversation-page.tsx`）

在现有 `useEffect`（监听 channel:message 等）旁，新增对 `message:dispatch-status` 的监听：

- 收到 `DispatchDto`，按 `dispatch.messageId` 找到当前频道的 `ChatMessage`，更新其 `dispatchStatus = dispatch.status`、`dispatchId = dispatch.id`。
- cleanup 时 `socket.off('message:dispatch-status', handler)`。

消息匹配：仅更新当前频道可见消息（与现有 channel:message 处理一致的频道过滤）。

### 4.3 展示（`channel-message.tsx`）

- 当 `msg.senderKind === 'human'` 且 `msg.dispatchStatus` 存在时，在消息气泡下方渲染 dispatch 指示行。
- 指示行内容依状态：
  - `running`（含 `queued/sent/accepted` 视作处理中）：蓝色胶囊「agent 正在处理…」+ 「取消」按钮。
  - `succeeded`：不显示（agent reply 已到达，无需指示）；或短暂绿勾后消失（第一版直接不显示）。
  - `failed`：红色胶囊 + `error` 摘要。
  - `cancelled`：灰色胶囊「已取消」。
  - `timed_out`：橙色胶囊「超时」。
- 复用 `runs/page.tsx` 的 STATUS_CONFIG 风格（颜色/图标/Lucide icon）。

### 4.4 取消（`channel-message.tsx` + `lib/socket.ts`）

- running 指示行的「取消」按钮：调 `emitWithTimeout(socket, 'dispatch:cancel', { dispatchId: msg.dispatchId })`。
- 成功（`res.ok`）：本地立即把 `msg.dispatchStatus` 置 `cancelled`（optimistic），等 server `message:dispatch-status` 确认。
- 失败：按钮恢复可点（或提示），不阻断。
- `lib/socket.ts` 的 web socket 封装增加 `dispatch.cancel` 命令（沿用既有 command 封装模式），或在组件内直接 `emitWithTimeout`。

## 5. 端到端数据流

```
用户发 message:send (human message, optimistic pending→sent)
  │
server 创建 dispatch(messageId = human msg) → 广播 message:dispatch-status(running, DispatchDto)
  │
web 收 message:dispatch-status → 更新 human msg.dispatchStatus = running, dispatchId
  │
channel-message.tsx 渲染 human msg 下方「agent 正在处理… [取消]」
  │
  ├─ 用户点「取消」→ dispatch:cancel { dispatchId } → server cancelDispatch
  │     → 广播 message:dispatch-status(cancelled) → 指示变「已取消」
  │
  └─ daemon 处理完 → server 广播 message:dispatch-status(succeeded/failed)
        + channel:message(agent reply 到达)
        → 指示更新/消失，agent reply 显示
```

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| dispatch:cancel 失败（超时/server 拒绝） | 按钮恢复，提示「取消失败」，不阻断 |
| 收到 dispatch-status 但 message 不在当前视图 | 忽略（仅更新可见消息，与 channel:message 一致） |
| dispatch 已 succeeded/failed 后点取消 | 按钮不应出现（仅 running 显示）；若竞态，server 返回当前状态 |
| 断线重连 | 重新订阅后 server 会重发当前 dispatch 状态（依赖现有 resubscribe 机制） |
| 多条 dispatch 并发（同频道多 agent） | 按 messageId 各自更新，互不影响 |

## 7. 测试策略（vitest，参照既有 web 测试）

- **dispatch 状态更新**：mock socket，emit `message:dispatch-status`(DispatchDto)，断言对应 ChatMessage 的 dispatchStatus/dispatchId 更新；非当前频道的不更新。
- **展示逻辑**：`channel-message` 在 human + running 时渲染取消按钮；succeeded 不渲染指示；failed/cancelled/timed_out 渲染对应胶囊。
- **取消交互**：点取消触发 `emitWithTimeout('dispatch:cancel', {dispatchId})`，成功后 optimistic 置 cancelled。
- **回归**：既有 69 web tests 不破坏。

## 8. 改动文件清单

| 文件 | 改动 |
|------|------|
| `apps/web/lib/schema.ts` | `ChatMessage` 加 `dispatchStatus?` + `dispatchId?`；引入/镜像 `DispatchStatus` 类型 |
| `apps/web/components/conversation-page.tsx` | 加 `message:dispatch-status` 监听 + 更新 message + cleanup |
| `apps/web/components/channel-message.tsx` | human message 下方 dispatch 指示行（状态胶囊 + running 取消按钮） |
| `apps/web/lib/socket.ts` | （可选）封装 `dispatch.cancel` 命令 |
| `apps/web/tests/*.test.ts(x)` | 新增 dispatch 状态更新 / 展示 / 取消交互测试 |
| `packages/contracts` / `apps/server-next` | **零改动** |

## 9. 非目标（out of scope）

- dispatch history / diagnostics 面板。
- 详细 error 展示（堆栈/重试）。
- 非 running 状态的持久指示（succeeded 不显示，failed/cancelled/timed_out 显示胶囊即可，不做展开详情）。
- web-next preview 的对应接入（本 task 只做 apps/web）。

## 10. 风险与待验证

- **`dispatch.messageId` 语义**：需在 plan/实现阶段确认 `DispatchDto.messageId` 确实是触发 dispatch 的 human message id（而非 agent reply message id）。若是后者，展示位置逻辑需调整。
- **`CancelDispatchInput` 字段**：需确认 `dispatch:cancel` payload 是 `{ dispatchId }` 还是 `{ messageId }`（`usecases.ts:2366` 的 `CancelDispatchInput`）。若是 messageId，取消命令改发 messageId。
- **状态胶囊统一**：`runs/page.tsx` 的 STATUS_CONFIG 是 `WorkspaceRunStatus`（4 态），dispatch 是 `DispatchStatus`（8 态），需为 dispatch 单独定义胶囊配置（queued/sent/accepted 归类为「处理中」）。
