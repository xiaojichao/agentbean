# Daemon Dispatch Outbox 设计

- 日期：2026-06-26
- 分支：`fix/daemon-dispatch-outbox`
- 范围：`apps/daemon-next`
- 状态：已批准，待写实现计划

## 背景

Daemon（`@agentbean/daemon`）运行期间出现进程崩溃退出，崩溃栈：

```
Error: socket has been disconnected
    at socket.io-client/.../socket.js:487 (_clearAcks)
    at Socket.onclose → Manager.onclose → engine WS close
```

崩溃发生在 daemon 已完成连接、注册、首次 scan 上报之后的"运行期间"。崩溃导致设备整体掉线，server 端 `markDeviceAndHostedAgentsOffline` 会把该设备名下所有 agent（含 custom agent）拉成 offline——直到 daemon 被手动重启重连才恢复。

## 根因

daemon-next 通过 `socket.emitWithAck(event, payload)` 向 server 上报状态，运行期间共有 6 个裸 `await emitWithAck` 调用点（`apps/daemon-next/src/index.ts`）：

| 行 | 事件 | 触发时机 |
|---|---|---|
| 274 | `dispatch.result` | 任务执行成功后上报（在 try 块） |
| 286 | `dispatch.error` | 任务失败上报（在 catch 块，裸 await） |
| 334 | `device.hello` | 重连 announce |
| 349 | `device.runtimes` | rescan 周期 + 重连 announce |
| 354 | `agent.registerBatch` | rescan 周期 + 重连 announce |

socket 断开时（server 重启部署 / 网络抖动），socket.io-client 的 `_clearAcks` 会**同步 reject** 所有 pending ack。这些 reject 没有被任何 try/catch 或 `.catch` 接住，且**全局没有** `process.on('unhandledRejection' / 'uncaughtException')` 兜底——Node 24 默认把 unhandled rejection 当致命错误，直接 crash 进程。

最致命的是 `dispatch.error`（286 行）：它位于 catch 块内。当 socket 断开导致 `dispatch.result` reject 时进入 catch，catch 又对**同一个已经断开的 socket** 再次 emit，必然再次 reject，且这次无人接住 → crash。**错误恢复路径反而成了崩溃源。**

附带的语义 bug：当前代码里 `dispatch.result` 上报失败会被 catch 块**误判为任务执行失败**从而发 `dispatch.error`——即"网络瞬断"被记录成"agent 执行失败"。

## 目标 / 非目标

**目标**
1. daemon 在 socket 断开/重连期间**绝不因上报失败而崩溃**。
2. 任务执行结果（`dispatch.result` / `dispatch.error`）在断线期间**不丢失**，重连后补发。
3. 防御未来：任何漏网的未捕获 reject 不再杀进程。

**非目标**
- 不持久化 outbox 到磁盘（内存即可；dispatch 产物本身已由 `persistWorkspaceRun*` 持久化，进程崩溃时 server 端 dispatch 会超时重试）。
- 不为 `device.hello` / snapshot 上报做"排队重发"——daemon 已有重连 announce 流程（`announceDeviceSnapshot`）覆盖重发，只需让它不 crash。
- 不改 server 端协议。

## 方案选择

考虑过三种 outbox 集成方式：

- **方案 A：独立 `DispatchOutbox` 模块**（选定）。新文件 `outbox.ts`，单一职责，可独立单测，把"任务结果"与"上报传输"解耦。
- 方案 B：内联进 dispatch handler——handler 臃肿、难独立测、业务与传输逻辑纠缠。否决。
- 方案 C：包装一层"可靠 socket"覆盖所有 emitWithAck——超出"仅 dispatch"范围，且 `device.hello` 的 ack 带 deviceId/credentials 不能简单重发。否决。

## 详细设计

### 1. 核心组件 `DispatchOutbox`

新文件 `apps/daemon-next/src/outbox.ts`。

为便于测试，outbox 只依赖 socket 的最小能力，而非完整 `DaemonProtocolSocket`：

```ts
export interface OutboxSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
}

export interface DispatchOutbox {
  /** 入队或立即发送；永不抛。 */
  sendOrEnqueue(event: string, payload: unknown): void;
  /** 重连后调用：顺序补发，成功删、失败留队。 */
  flush(): Promise<void>;
  /** 当前待发条数（测试与监控用）。 */
  size(): number;
}

export function createDispatchOutbox(socket: OutboxSocket, options?: {
  onWarn?: (message: string) => void;
}): DispatchOutbox;
```

内部数据结构：

```ts
type OutboxItem = { event: string; payload: unknown };
const queue = new Map<string, OutboxItem>(); // key = dispatchId
```

**关键算法**

- `sendOrEnqueue(event, payload)`：
  - 取 `dispatchId = (payload as { dispatchId?: string }).dispatchId`。若取不到 dispatchId（理论上不应发生），退化为直接 `emitWithAck` 并 catch（不入队，因为无法去重）。
  - `socket.connected === true` → 尝试 `await socket.emitWithAck(event, payload)`；成功则结束，reject 则落入 `enqueue`（`onWarn` 记一条）。
  - `socket.connected === false` → 直接 `enqueue`。
  - 整个方法用内部 async + 顶层 catch 包裹，**对外永不 reject**（void 返回）。
- `enqueue(item)`：`queue.set(dispatchId, item)`——按 dispatchId 去重，一个 dispatch 只有一个终态（result 或 error），后到的覆盖先到的。
- `flush()`：快照当前 `queue` 的 entries，逐个 `emitWithAck`；成功 `queue.delete(dispatchId)`，reject 则保留（等下次 connect 再 flush）。flush 期间新 `sendOrEnqueue` 入队的项，本次不处理，留待下次 flush。

### 2. dispatch handler 改造（`index.ts`）

在 daemon 创建 socket 后构造 outbox，并把 socket `connect` 事件接到 `flush`：

```ts
const outbox = createDispatchOutbox(socket);
socket.on('connect', () => { void outbox.flush(); });
```

dispatch handler（274 / 286）改为：

```ts
// 原 try 块末尾（274）：
outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.result, { dispatchId, agentId, body, ... });

// 原 catch 块（286）：
} catch (error) {
  if (cancelledDispatchIds.delete(request.id)) return;
  outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.error, {
    dispatchId: request.id, agentId: request.agentId, error: readErrorMessage(error),
  });
}
```

改造后：
- `sendOrEnqueue` 永不抛，dispatch handler 不再因上报失败 crash。
- result 上报失败时入队重发，**不再误进 catch 发 error**——顺带修复"网络瞬断被记成任务失败"的语义 bug。

### 3. 配套（达成"不 crash"的必要部分，非 outbox 范围）

这些不属于 outbox（用户选定的 outbox 范围仅 dispatch result/error），但是"daemon 不再因断线 crash"的必要配套：

- **其他裸 emit 容错**：`reportDeviceSnapshot`（349 runtimes / 354 registerBatch）和 `announceDeviceSnapshot` 的 `device.hello`（334），各自用 try/catch 包裹——断线时 `onWarn` 记录、不抛、不入队。这些消息靠现有重连 announce 流程自动重发，无需入队。
- **全局兜底**：在 daemon 入口（`cli.ts` 启动处）注册 `process.on('unhandledRejection')` 与 `process.on('uncaughtException')`，回调里记录日志、**不退出进程**。防御未来任何漏网的未捕获 reject。

### 数据流

- 正常：dispatch 完成 → `sendOrEnqueue(result)` → connected → 立即 emit →（隐式不入队）。
- 断线：dispatch 完成 → `sendOrEnqueue(result)` → disconnected → 入队 → socket.io 自动重连 → `connect` 事件 → `flush()` → emit → 成功删。
- 任务失败：catch → `sendOrEnqueue(error)` → 同上路径。
- flush 中途又断线：本次失败项留队，等下次 `connect` 再 flush。

### 幂等性

server 端 `receiveDispatchResult` / `receiveDispatchError`（`apps/server-next/src/application/usecases.ts`）都会先检查 `isPendingDispatchStatus(dispatch.status)`，对已完成的 dispatch 返回 `CONFLICT`。因此补发安全——即使 server 在断线瞬间其实收到了结果、重连后又收到一次，也不会重复记账或报错。daemon 侧对 CONFLICT ack 视为成功（消息已落地）。

## 错误处理

| 场景 | 行为 |
|---|---|
| connected 时 emit reject | 入队，`onWarn` 记录，不抛 |
| disconnected 时 sendOrEnqueue | 入队，不抛 |
| flush 单项失败 | 该项留队，继续下一项，不抛 |
| payload 缺 dispatchId | 直接 emit + catch，不入队（无法去重） |
| 任何漏网 reject | 全局 `process.on` 兜底，记日志不退出 |

队列无硬上限：dispatch 终态数量天然有界（断线期间完成的任务有限），且 flush 成功即清。若担心异常堆积，可后续加 size 监控告警（非本期范围）。

## 测试计划（TDD）

### 新增 `apps/daemon-next/tests/outbox.test.ts`

用纯 mock socket（实现 `OutboxSocket`：`connected` 布尔 + `emitWithAck` 可控 resolve/reject）。逐条 RED→GREEN：

1. connected 时 `sendOrEnqueue` 立即 emit，队列不增长。
2. disconnected 时 `sendOrEnqueue` 入队，不抛、不 emit。
3. connected 但 `emitWithAck` reject 时，入队、不抛。
4. `flush()` 顺序补发全部待发项，成功后队列为空。
5. `flush()` 中途某项 reject 时，该项留队、其余继续、不抛。
6. 同 `dispatchId` 多次 `sendOrEnqueue` 只保留最新（去重覆盖）。
7. payload 缺 dispatchId 时直接 emit，不入队。

### 扩展 `apps/daemon-next/tests/dispatch-pipeline.test.ts`

socket 断开期间 dispatch 执行完成：断言 daemon 不抛未捕获错误、且重连（socket 重新 connected + 触发 flush）后 `dispatch.result` 被补发到 server（mock 记录收到）。

### 扩展 `apps/daemon-next/tests/rescan-integration.test.ts`

rescan 上报（`reportDeviceSnapshot`）期间 socket emit reject：断言不抛、daemon 继续运行。

## 文件清单

| 文件 | 改动 |
|---|---|
| `apps/daemon-next/src/outbox.ts` | 新增：`DispatchOutbox` 组件 |
| `apps/daemon-next/src/index.ts` | dispatch handler 接 outbox；其他裸 emit 加容错；socket connect 接 flush |
| `apps/daemon-next/src/cli.ts` | daemon 入口注册全局 `process.on` 兜底 |
| `apps/daemon-next/tests/outbox.test.ts` | 新增：outbox 单元测试 |
| `apps/daemon-next/tests/dispatch-pipeline.test.ts` | 扩展：断线不 crash + 重连补发 |
| `apps/daemon-next/tests/rescan-integration.test.ts` | 扩展：rescan emit 失败不 crash |

## 风险与权衡

- **内存队列不持久化**：daemon 进程被强杀（OOM/手动 kill）时，已入队未补发的 result 丢失。可接受——产物已持久化在 workspace，server 端 dispatch 超时会重试或标记失败。
- **全局兜底可能掩盖未来真 bug**：`uncaughtException` 不退出会把"本该崩溃暴露的问题"压成日志。缓解：兜底只对已知可恢复类型（socket 断开相关）静默，其余仍详细记录，便于排查。本期实现以"不退出 + 记日志"为底线。
- **outbox 与既有重连 announce 的边界**：outbox 只管 dispatch result/error；snapshot/hello 由既有 `announceDeviceSnapshot` 重连流程负责（本期仅加容错）。两者不重叠。

## 后续（非目标，留待评估）

- outbox size 监控/告警。
- dispatch 结果落盘持久化（覆盖进程强杀场景）。
- 全局兜底的分级处理（可恢复 vs 致命）。
