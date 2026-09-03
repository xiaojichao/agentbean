# 架构：裸 HTTP + socket.io 命名空间 + 深模块

## 何时适用

新增 API、改传输层、抽深模块、或第一次理解 server-next 请求如何流转时。本文描述的是**生产组装根**（`dev-server.ts`）的真实形态，不是某个理想框架模板。

## 本地模式

### 裸 node:http，不是 Hono/Express

服务端直接用 `node:http` 的 `createServer` 起 HTTP 服务，**没有 Web 框架**：

- `createServer` 从 `node:http` 导入（`src/dev-server.ts:3`），调用点在 `src/dev-server.ts:299`（`const httpServer = createServer(async (request, response) => {`）。
- HTTP 面极小，只有 `/healthz`（`src/dev-server.ts:310`）、`/metricsz`（`src/dev-server.ts:315`）、`/preview`（`src/dev-server.ts:305`）等少数端点。
- 所有客户端业务 API 走 socket.io 事件 handler，**不要**新增 REST 路由来承载业务逻辑。

### socket.io 三命名空间

传输层在 `src/transport/socket-server.ts` 挂三个命名空间：

- `/agent`：`src/transport/socket-server.ts:119`（`const agentNamespace = server.of('/agent');`）
- `/server-worker`：`src/transport/socket-server.ts:155-156`（`of('/server-worker')`）
- `/web`：`src/transport/socket-server.ts:280`（`server.of('/web').on('connection', ...)`）

事件名集中在 `packages/contracts/src/socket.ts`（`WEB_EVENTS` / `AGENT_EVENTS`）。

### 目录结构

| 目录 | 职责 | 代表文件 |
|---|---|---|
| `src/application/` | 用例、深模块、handler、repository 接口、UoW | `usecases.ts`、`channel-work-intake.ts`、`output-package-service.ts`、`channel-access.ts`、`repositories.ts`、`*-handler.ts`、`*-unit-of-work.ts` |
| `src/application/management/` | PI 内核（路由、worker 池、claim broker） | `management-kernel.ts`、`management-router.ts`、`server-worker-pool.ts`、`task-claim-broker.ts` |
| `src/infra/sqlite/` | SQLite 实现 + 迁移 | `repositories.ts`、`migrations/global/`、`migrations/team/` |
| `src/infra/memory/` | 测试用内存实现 | `repositories.ts` |
| `src/transport/` | socket.io adapter、事件绑定与 Server-owned projection | `socket-server.ts`、`socket-handlers.ts`、`message-socket-handlers.ts`、`message-socket-adapter.ts`、`dispatch-socket-projection.ts`、`task-socket-projection.ts` |
| `src/` 根 | 入口与组装根 | `dev-server.ts`（生产 host/storage）、`server-runtime-assembly.ts`（通用 runtime assembly）、`index.ts`（内存）、`bin.ts`（CLI） |

### god-interface 工厂：createServerNextUseCases

`src/application/usecases.ts` 仍是大型 god-interface 工厂：

- 类型 `ServerNextUseCases` 定义在 `src/application/usecases.ts:453`，包含数百个成员（handler 方法、服务、仓储引用）。
- 工厂函数 `createServerNextUseCases` 在 `src/application/usecases.ts:2046`，通过闭包持有仍未抽取的 helper 与可变状态。
- socket 层通过 `bind(socket, EVENT, app, 'handlerName')` 把 handler 方法名暴露成事件（详见 socket-and-readiness.md）。

**这是已知技术债**：新代码应优先放进新建深模块，而不是继续往 `usecases.ts` 塞方法。

### 深模块（抽取中）

为收敛 god-interface，正在把高内聚写事实抽成独立模块：

- `src/application/output-package-service.ts`（87 行）：拥有 OutputPackage 生命周期的核心写事实（formation / review / finalize / reject + watermark bump）。头部 `src/application/output-package-service.ts:1-2` 声明相对路径 import 惯例。
- `src/application/channel-access.ts`（29 行）：`ensureUserCanViewChannel` 共享可见性 helper，不依赖任何 god-factory 闭包状态，作为后续"搬方法"切片的共享基建（`src/application/channel-access.ts:6-16` 注释）。
- `src/application/channel-work-intake.ts`：从已提交 Message/route analysis 开始，统一执行 intent analysis、Server authority、Promotion gate、replay fence 与 Offer wake。调用方只使用 `wakeAfterMessageCommitted(...)` 和 `processPending(limit?)`；不得把授权顺序重新散回 `usecases.ts`。
- `src/application/agent-eligibility-module.ts`：统一解释 Team Exposure、restriction、legacy capability 与 Project Document InputSet 合同；broker 与项目阶段调用方继续拥有各自的通道、设备、依赖和策略诊断。
- `src/server-runtime-assembly.ts`：统一组装 TaskClaimBroker、management runtime、use cases、readiness 与 server worker。Memory/SQLite adapter 只准备仓储、目录、迁移与 cleanup，再把准备好的依赖交给该模块。
- `src/transport/message-socket-handlers.ts` + `message-socket-adapter.ts`：前者通过本地 `MessageSocketPort` 统一拥有 Message 事件映射与 send 认证输入增强声明，后者拥有 send/edit/delete/convert-to-task 投影 fan-out，以及 send dispatch 的 quiet window、claim wake 与终态取消。共享 binder 仍统一执行认证身份注入和 ACK/error 整形。
- `src/transport/project-socket-broadcast.ts`：通过单一 `handleMutation(kind, payload, result)` interface 拥有 Project overview / artifact / document bundle 的 mutation failure 分类、Team 过滤、逐订阅者身份解析与 Server 投影重读、事件发送及 latency 观测。References 更新使用不同的频道可见性语义，由 Message socket module 只在提交成功且存在冻结引用集时触发，暂不进入该 module。
- `src/transport/task-socket-projection.ts`：通过单一 `handleMutation(result)` interface 拥有 `task` / `tasks` 归一化、Task identity 去重、按 Team 聚合，以及 `task.updated` → `task.snapshot` → `memory.changed` 顺序；Message 与 Dispatch 投影不得进入该 module。
- `src/transport/dispatch-socket-projection.ts`：通过 `handleMutation(source, payload, result)` interface 拥有 Dispatch status、Agent reply Message、Agent snapshot/status 与非 Task Memory invalidation 的统一顺序；调用方必须显式标注 mutation source，不能从 result shape 猜 owner。

抽新模块时**必须**沿用相对路径 import（见 gotchas.md）。

### 深模块删除测试

只有删除候选 module 会把顺序敏感状态、authority 规则或跨事件协调重新泄漏给多个调用方时，才继续抽取：

- Message socket module 通过删除测试：删除后，mutation 投影顺序、每个 dispatch 独立的 quiet window、claim wake 与终态取消都会重新散回 handler。
- Project projection broadcast 已通过删除测试：删除 `project-socket-broadcast.ts` 会把三类投影共用的 failure policy、逐用户重读和 latency 观测重新泄漏回 `socket-server.ts`；入口认证与声明式 event → use case 映射仍留在 `socket-handlers.ts`。
- Task socket projection 已通过删除测试：删除 `task-socket-projection.ts` 会把 Task identity 去重、按 Team 单次 snapshot/Memory invalidation、受众差异和事件顺序重新泄漏到 Web Task、Message convert/send、Dispatch cancel 与 Agent result/error 路径。它不能与 Message/Project 共用泛型 fan-out seam。
- Dispatch socket projection 已通过删除测试：删除 `dispatch-socket-projection.ts` 会把 status audience、Agent reply 可见性、Team 去重、Agent refresh 与 Task/Memory 唯一 owner 顺序重新泄漏到 Message send、Web cancel/cancelChannel、Agent message/result/error 及 realtime timeout 路径。
- Channel Work Intake 已通过删除测试且保持现有边界：删除 `channel-work-intake.ts` 会把 authority、freshness、promotion、replay 与 Offer publication 顺序泄漏回 composition root；在没有第二个 route writer 或重复 authority 流程前，不要再包一层 facade。

- Project references 当前**未通过独立 module 的删除测试**：删除候选只会把单一 Message send callback 的频道可见性循环放回原处，不会把状态机、顺序或共享 fan-out 泄漏到多个调用方。其 interface 应保持窄的 committed facts，不得为复用 Project mutation failure policy 而重新接收任意 payload/result。未来只有当 references 出现可由单一 module 完整拥有的状态机、顺序策略或多个调用方共享规则时，才重新评估对应 adapter；事件数量本身不是抽取理由。

### Repository 接口 + 双实现

- 接口：`ServerNextRepositories` 在 `src/application/repositories.ts`。
- SQLite 实现：`src/infra/sqlite/repositories.ts`（生产）。
- 内存实现：`src/infra/memory/repositories.ts`（测试）。

新增仓储方法时，**两个实现都要改**，否则测试在 SQLite 路径下会缺方法。

### Unit-of-Work 与 handler/dispatcher 分离

- 事务边界由 `*-unit-of-work.ts` 管理（如 `task-coordination-unit-of-work.ts`、`package-review-repositories.ts` 配套的 UoW）。
- 领域决策与传输整形分离：`*-handler.ts`（纯领域决策，如 `output-package-handler.ts`、`package-review-handler.ts`）+ `*-dispatcher.ts`（socket 整形，如 `message-tracer-dispatcher.ts`、`pi-authority-cutover-dispatcher.ts`）。

### 生产组装根：dev-server.ts

`src/dev-server.ts` 是**生产 host 组装根**——它创建 HTTP 服务、attach socket.io 命名空间，并负责 Memory/SQLite 存储初始化、迁移、目录与 cleanup。两种存储 adapter 共有的 broker、management runtime、readiness、worker 与 use-case wiring 由 `src/server-runtime-assembly.ts:createServerRuntimeAssembly` 统一组装。`src/index.ts` 是内存入口（测试用），`src/bin.ts` 是 CLI 入口。

### Channel Work Intake interface

```typescript
interface ChannelWorkIntake {
  wakeAfterMessageCommitted(input: {
    teamId: string;
    messageId: string;
    clientMessageId: string | null;
  }): void;
  processPending(limit?: number): Promise<MessageRouteAnalysisRecord[]>;
}
```

行为合同：Message ACK 不等待 PI/Promotion；失败保留 deferred 并由 `processPending` 恢复；PI proposal 仍须经过 Capability Directory、risk、authority epoch、Team policy、Promotion gate、runtime connection fence 与 Offer publication。ADR-0062/0069/0073 的 Server-owned authority、单一 lineage 与 Offer/acceptance/Claim 分离不得因模块抽取改变。

### Message socket module interfaces

```typescript
interface MessageDispatchPort {
  getDispatchRequest(input: {
    dispatchId: string;
    purpose?: 'execute' | 'route';
  }): Promise<Ack<{ request: DispatchRequestDto & { id: string } }>>;
}

interface MessageSocketPort extends MessageDispatchPort {
  sendMessage(input: never): Promise<unknown>;
  dispatchMessageTracerCommand(input: never): Promise<unknown>;
  searchMessages(input: never): Promise<unknown>;
  getMessageContext(input: never): Promise<unknown>;
  reactMessage(input: never): Promise<unknown>;
  saveMessage(input: never): Promise<unknown>;
  listSavedMessages(input: never): Promise<unknown>;
  pinMessage(input: never): Promise<unknown>;
  listPinnedMessages(input: never): Promise<unknown>;
  editMessage(input: never): Promise<unknown>;
  deleteMessage(input: never): Promise<unknown>;
  convertMessageToTask(input: never): Promise<unknown>;
}

interface MessageSocketAdapter {
  handleMutation(
    kind: 'send' | 'edit' | 'delete' | 'convert-to-task',
    payload: unknown,
    result: unknown,
  ): Promise<void>;
  cancelPendingDispatch(dispatchId: string): void;
}

interface MessageSocketHandlers {
  registerIngress(): void;
  registerOperations(): void;
  cancelPendingDispatch(dispatchId: string): void;
}
```

行为合同：`message-socket-handlers.ts` 拥有全部 Message event → use case 映射；为保持既有跨领域事件注册序列，facade 分 `registerIngress`（send / message-tracer）与 `registerOperations`（其余 Message query/mutation）两阶段注册。send 输入在认证身份注入后追加 connected/claim Device IDs，事件名、注册顺序、ACK/error 语义和 after-result 时序保持兼容。send 先执行 `afterMessageSend`，只有成功 ACK 才继续触发引用/Task/Dispatch 投影，其中 Dispatch refresh 仅在确实产生 dispatch 时执行；edit 只执行 `afterMessageSend`；delete 按 `afterMessageSend` → `afterMemoryMutation` 执行；convert-to-task 按 `afterTaskMutation` → `afterMessageSend` 执行。Task projection 不再发送 Message，因此 convert-to-task 的 Message 只由 `afterMessageSend` 投影一次。每个 send dispatch 的 quiet window 独立维护；支持 claim 的 dispatch 可以提前发 wake，终态 dispatch 必须取消尚未发出的 wake。Message module 只依赖本地 `MessageSocketPort` / `MessageDispatchPort`，不得 import 完整 `ServerNextUseCases` interface。

接口测试在 `apps/server-next/tests/message-socket-handlers.test.ts` 与 `message-socket-adapter.test.ts`，覆盖完整事件映射、send 输入增强、mutation 投影顺序、send 投影 fan-out、独立 quiet window、claim wake 与取消。共享 binder 与 `socket-handlers.test.ts` 继续覆盖认证输入注入、ACK 和错误整形。

### Project References Socket seam

#### 1. Scope / Trigger

- Trigger：`WEB_EVENTS.message.send` 已成功提交 Message，且结果包含冻结 `ProjectReferenceSetDto`。
- Scope：只向当前仍可见该频道的 Team 订阅者发送 `WEB_EVENTS.project.referencesUpdated`；不拥有引用解析、冻结、持久化、Message/Task/Dispatch 投影或 Project overview 重读。

#### 2. Signatures

```typescript
interface CommittedProjectReferences {
  readonly teamId: string;
  readonly channelId: string;
  readonly referenceSet: ProjectReferenceSetDto;
}

interface MessageSocketAdapterOptions {
  afterProjectReferencesUpdated?(
    committed: CommittedProjectReferences,
  ): Promise<void> | void;
}
```

#### 3. Contracts

- Message socket module 固定 send 顺序为 `afterMessageSend` → references → Task → Dispatch；references callback 只接收已提交 Message 的 `teamId/channelId` 与必有的冻结引用集。
- Message adapter 从 committed Message 读取 `teamId/channelId`，不得信任原始 payload 重建 scope；scope 不完整时不得调用 callback。
- 订阅者必须先匹配 Team，再以自己的 channel subscription 调用 `listChannels` 复核具体频道可见性；同 Team 不等于可见该频道。
- 每个可见订阅 socket 对一次 callback 恰好收到一次 `{ channelId, referenceSet }`；不重新解析 current/final revision。
- Project overview / artifact / document bundle 的逐用户投影重读和 failure/latency policy 继续由 `ProjectSocketBroadcast` 独占，references 不复用该 module 的 result interface。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| send ACK 失败 | Message adapter 不调用 references callback |
| 成功 send 无 `referenceSet` | 不调用 references callback |
| committed Message 缺 `teamId` 或 `channelId` | Message adapter 不调用 references callback |
| subscriber Team 不匹配 | 跳过且不调用 `listChannels` |
| `listChannels` 返回失败或不含目标频道 | 不广播 |
| `listChannels` 抛异常 | after-result 失败向现有 socket 错误日志路径冒泡；已发送 ACK 不回滚 Message |

#### 5. Good/Base/Bad Cases

- Good：私有频道发送带冻结引用集的 Message → 频道成员收到一次 references 更新，同 Team 非成员收到零次。
- Base：成功发送普通 Message → 只执行 Message 投影，不触发 references callback。
- Bad：把任意 payload/result 交给 references callback、从 payload 取 scope，或因事件同属 Project 命名空间而并入 Team-only Project broadcast module。

#### 6. Tests Required

- `message-socket-adapter.test.ts`：断言 committed-facts 参数形状、Message → references → Task → Dispatch 顺序，以及失败 ACK/无引用集不触发。
- `socket-integration.test.ts`：通过真实 Socket.IO 断言私有频道可见订阅者收到一次、同 Team 不可见订阅者零次，并校验冻结引用集 id。

#### 7. Wrong vs Correct

```typescript
// Wrong：重新暴露任意 result，并复用不属于 references seam 的失败策略。
afterProjectReferencesUpdated(payload, result);
recordProjectSocketMutationFailure(metrics, result);

// Correct：Message module 只在成功提交且存在引用集时交付最小 committed facts。
afterProjectReferencesUpdated({
  teamId: result.message.teamId,
  channelId: result.message.channelId,
  referenceSet: result.referenceSet,
});
```

### Task Socket Projection interface

#### 1. Scope / Trigger

- Trigger：任何成功结果包含单个 `task` 或 `tasks[]`，并需要向 Web 订阅者投影 Task 事实。
- Scope：只拥有 Task 增量、Task snapshot 与 Task 导致的 Memory invalidation；不拥有 Message、Dispatch status、Agent refresh 或 Project projection。

#### 2. Signatures

```typescript
interface TaskSocketProjection {
  handleMutation(result: unknown): Promise<void>;
}

interface TaskSocketProjectionPort {
  listTasks(input: {
    userId: string;
    teamId: string;
    currentDeviceId?: string | null;
  }): ReturnType<ServerNextUseCases['listTasks']>;
}
```

`MessageSocketAdapterOptions`、`WebSocketHandlerOptions` 与 `AgentSocketHandlerOptions` 使用 `afterDispatchMutation(source, payload, result)` 表达 Dispatch projection；不得再借 `afterAgentMutation` 承载 Dispatch 或 Task 投影。

#### 3. Contracts

- 输入只读取成功 ACK 中的 `task` 与 `tasks[]`；Task 必须带稳定 `teamId` 才能投影。
- 同一结果按 Task `id` 去重，按首次出现顺序分组；每个 Task 发送一次 `WEB_EVENTS.task.updated`。
- 每个 Team、每个 channel subscriber 只调用一次 `listTasks(subscription)` 并在成功时发送一次 `WEB_EVENTS.task.snapshot`。
- 每个 Team 向 channels/agents/devices 任一归属该 Team 的 subscriber 发送一次 `WEB_EVENTS.memory.changed`。
- 固定顺序为同 Team 全部 `task.updated` → 每订阅者 `task.snapshot` → `memory.changed`。
- Message 由 `afterMessageSend` 或 Agent Dispatch projection 唯一发送；Task module 不检查 `dispatches`，也不发送 `channel.message`。
- `WEB_EVENTS.task.update` 的成功结果可能包含已提交的 `task-status-updated` Message；该来源必须在 Task projection 之后显式调用 `afterMessageSend`，其他 Task mutation 不得用泛化 Task module 代发 Message。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `result.ok !== true` | 不发送任何 Task/Memory 事件，不重读 |
| 成功结果无 `task` / 非空 `tasks[]` | 不发送、不重读 |
| Task 缺少字符串 `teamId` | 跳过该 Task |
| 同一结果重复 Task `id` | 只保留第一次 |
| `listTasks` 返回失败 | 不发送 snapshot；仍发送该 Team 的 Memory invalidation |
| subscriber 只有 agents/devices 订阅 | 接收 update 与 Memory，不接收 Task snapshot |

#### 5. Good/Base/Bad Cases

- Good：批量取消返回同 Team 两个 Task → 两次 update、一次 listTasks/snapshot、一次 Memory invalidation。
- Base：单 Task mutation → 一次 update、一次 snapshot、一次 Memory invalidation。
- Bad：Task module 同时发送 `channel.message`，或调用方按 Task 数量重复重读同一 Team snapshot。

#### 6. Tests Required

- `task-socket-projection.test.ts`：断言 Task id 去重、Team 单次重读、事件精确次数与顺序、失败/空结果静默。
- `socket-integration.test.ts`：断言 Task-linked send/result、convert-to-task、dispatch cancel 的 Message/Task/Memory 精确次数。
- `message-socket-adapter.test.ts` 与 `socket-handlers.test.ts`：断言 Message/Task/Dispatch callback 的职责与调用顺序，并覆盖 task.update 的 Task → Message 投影顺序。

#### 7. Wrong vs Correct

```typescript
// Wrong：用结果形状猜 Message 是否已被其他路径投影。
if (!Array.isArray(result.dispatches)) emitChannelMessage(result);

// Correct：Task module 只处理 Task；来源路径各自唯一拥有 Message/Dispatch。
await taskSocketProjection.handleMutation(result);
await afterMessageSend(payload, result);
```

### Dispatch Socket Projection interface

#### 1. Scope / Trigger

- Trigger：Message send 创建 `dispatches[]`、Web cancel/cancelChannel 返回 Dispatch，或 Agent message/result/error 返回 Dispatch 已提交事实。
- Scope：只拥有 `dispatch.status`、Agent 回报产生的可见 Message、Agent snapshot/status 与非 Task 结果的 Memory invalidation；不拥有 ACK、Task projection、quiet window、claim wake、daemon cancel 或 PI recovery。

#### 2. Signatures

```typescript
type DispatchSocketMutationSource = 'message-send' | 'web-command' | 'agent-report';

interface DispatchSocketProjection {
  handleMutation(
    source: DispatchSocketMutationSource,
    payload: unknown,
    result: unknown,
  ): Promise<void>;
  emitStatus(dispatch: unknown): void;
}

interface DispatchSocketProjectionPort {
  listChannels: ServerNextUseCases['listChannels'];
  listDirectMessages: ServerNextUseCases['listDirectMessages'];
  listVisibleAgents: ServerNextUseCases['listVisibleAgents'];
}
```

#### 3. Contracts

- 调用方必须显式传入 source；不得以 `dispatch` / `dispatches` 的 shape 推断 Message 是否已被其他 owner 投影。
- 成功结果将单个 `dispatch` 与 `dispatches[]` 合并并按 Dispatch `id` 首次出现去重；每个 Dispatch 按其 `teamId` 向 channels/agents/devices 任一属于该 Team 的 subscriber 发送一次 `WEB_EVENTS.message.dispatchStatus`。
- 只有 `agent-report` source 才读取 `message` / `messages[]`；`message-send` 的原消息已由 Message adapter 唯一投影，Dispatch module 不得重复发送。
- Agent reply Message 必须先匹配 Team，再以 subscriber 自己的 channel subscription 重读 `listChannels` / `listDirectMessages` 复核频道或 DM 可见性；不得先广播正文再由客户端隐藏。
- 受影响 Team 从 payload team/targetTeam、Agent visibility、Dispatch 与 Message 的 committed team facts 合并去重；每 Team、每 agents subscriber 最多重读一次 `listVisibleAgents`，固定发送 snapshot 后逐 Agent status。
- 固定顺序为全部 Dispatch status → 全部可见 Agent reply Message → 每 Team Agent snapshot/status → Memory invalidation。
- 结果包含 `task` 或非空 `tasks[]` 时，Memory invalidation 由后续 `TaskSocketProjection` 唯一发送；否则 Dispatch module 每 Team 发送一次。
- `emitStatus` 供 realtime timeout 等已提交 Dispatch 状态入口复用相同 audience 规则，不触发 Message、Agent 或 Memory 投影。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `result.ok !== true` | 不发送、不重读 |
| Dispatch 缺少字符串 `teamId` | 不发送该 status；仍可由其他 committed Team fact 驱动 refresh |
| 重复 Dispatch `id` | 只发送第一次 |
| source 非 `agent-report` 且结果含 Message | 不发送 Message |
| Message 缺少 `channelId` 或没有可见频道/DM | 不发送正文 |
| agents subscriber 的 Team access 重读失败 | 清除该 agents subscription，不发送 snapshot/status |
| `listVisibleAgents` 失败 | 不发送 snapshot/status；仍执行适用的 Memory invalidation |
| 结果含 Task projection | Dispatch module 不发送 Memory invalidation |

#### 5. Good/Base/Bad Cases

- Good：cancelChannel 返回同 Team 多个 Dispatch/Task → 每个 status 一次、Agent refresh 一次、Memory 由 Task module 一次发送。
- Base：Agent result 返回 Dispatch + reply Message → status、可见 Message、Agent refresh、适用的 Memory 依次发生。
- Bad：message.send 的 committed human Message 被 Message adapter 与 Dispatch module各发送一次；或 handler 在 module 后再次手工发送 status。

#### 6. Tests Required

- `dispatch-socket-projection.test.ts`：断言顺序、Dispatch/Team 去重、频道与 DM 可见性、Task/Memory 唯一 owner、失败与缺失 Team 输入。
- `message-socket-adapter.test.ts`：断言 `message-send` source 与 Message → references → Task → Dispatch callback 顺序。
- `socket-handlers.test.ts`：断言 `web-command` / `agent-report` source，以及 Dispatch → Task callback 顺序。
- `socket-integration.test.ts`：真实 Socket.IO 断言 message send 与 cancel 各发送一次 status、Agent busy/online refresh、reply Message 不重复及 Memory 精确次数。

#### 7. Wrong vs Correct

```typescript
// Wrong：用结果 shape 猜来源，并在 handler 继续补发 status。
await dispatchSocketProjection.handleMutation(payload, result);
dispatchStatus(result.dispatch);

// Correct：入口显式交付 owner 语义，所有 Socket 投影委托一个 module。
await dispatchSocketProjection.handleMutation('web-command', payload, result);
```

### Agent Eligibility interface

```typescript
interface AgentEligibilityModule {
  resolveTaskCandidateCapabilities(input: {
    teamId: string;
    agent: AgentRecord;
  }): Promise<ReadonlySet<string>>;

  filterStrictProjectStageAgentIds(input: {
    teamId: string;
    candidateAgentIds: readonly string[];
    requiredCapabilities: readonly string[];
    requiredProjectDocumentInputSetVersion?: number;
    now: number;
  }): Promise<string[]>;
}
```

资格合同：

- 普通 Task 候选优先读取当前 Team 的 active Exposure，并应用同 manifest 的 restriction；过期 manifest 必须标记 `expired`，再保留 legacy `agent.skills` 名称兼容。legacy 只提供 capability 名，不带入工具、路径或权限。
- 项目阶段自动推进是严格路径：只接受有效期内且 `availability.status === 'available'` 的 active Exposure，不允许 legacy fallback；若稳定输入含文档修订，还必须同时校验 Agent 与 Device 声明相同的 `projectDocumentInputSetVersions`。
- eligibility 模块不拥有通道成员、Agent/Device 在线、依赖、祖先环或 targeted policy 诊断；这些仍由 `TaskClaimBroker.resolveCandidates` 产生原稳定诊断码。
- decomposition allocatability 对同一 parent Task 只读取一次 broker 候选，并为每个 eligible candidate 只读取一次当前 Exposure 投影，再按各 subtask requirement 计算 `qualified | not_qualified | unknown`；不要按 subtask 重复读取相同候选事实。
- Offer 发布与 accept/claim 必须各自重新读取资格事实。不要把一次 eligibility 结果缓存并跨越并发状态变化；Exposure/Restriction/availability/InputSet 改变后，旧 Offer 不应绕过复验形成 Claim。
- `availability` 或 Exposure Manifest 只证明候选可被评估，绝不直接创建 Claim 或 Invocation。ADR-0073 的 Candidate → Evidence → Exposure → eligibility 链与 Offer/acceptance/Claim 分离保持不变。

测试断言至少覆盖：restriction 大小写归一、过期 Exposure 的状态转换与 legacy 兼容、严格路径拒绝 legacy-only Agent、Agent/Device InputSet 任一缺失时拒绝、decomposition 单次读取 broker/Manifest 快照，以及 broker 的稳定诊断码与项目阶段 Offer 二次复验。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/dev-server.ts`（:3 导入、:299 createServer、:305/:310/:315 端点）
- `/Users/shaw/AgentBean/apps/server-next/src/transport/socket-server.ts`（:119 /agent、:155-156 /server-worker、:280 /web）
- `/Users/shaw/AgentBean/apps/server-next/src/server-runtime-assembly.ts`（`:120 createServerRuntimeAssembly`）
- `/Users/shaw/AgentBean/apps/server-next/src/application/channel-work-intake.ts`（`:16 ChannelWorkIntake`、`:64 createChannelWorkIntake`）
- `/Users/shaw/AgentBean/apps/server-next/src/application/agent-eligibility-module.ts`（Agent eligibility 事实边界）
- `/Users/shaw/AgentBean/apps/server-next/src/application/usecases.ts`（`:453 ServerNextUseCases`、`:2046 createServerNextUseCases`）
- `/Users/shaw/AgentBean/apps/server-next/src/application/output-package-service.ts`（87 行）
- `/Users/shaw/AgentBean/apps/server-next/src/application/channel-access.ts`（29 行）
- `/Users/shaw/AgentBean/apps/server-next/src/application/repositories.ts`、`src/infra/sqlite/repositories.ts`、`src/infra/memory/repositories.ts`

## 反模式

- **不要引入 Hono/Express 等框架**：HTTP 面刻意保持极小，业务走 socket 事件。
- **不要在 `usecases.ts` 里直接新建大块逻辑**：优先建深模块（参考 `output-package-service.ts` 形态）。
- **不要只改 SQLite 实现忘改内存实现**：仓储接口是双实现的契约。
- **不要把 Memory/SQLite 共有 runtime wiring 复制回 `dev-server.ts`**：共有组装改 `server-runtime-assembly.ts`；存储初始化、迁移、目录与 cleanup 仍改 `dev-server.ts`。
- **不要绕过 Channel Work Intake 创建第二条 route writer**：Message 之后的分析、授权、promotion 与 Offer wake 必须经 `channel-work-intake.ts` 收敛。
- **不要在 broker、项目阶段或 overview helper 中自行重新解释 Exposure/Restriction/InputSet**：统一调用 `agent-eligibility-module.ts`；但不要删除 Offer 发布与 accept/claim 的独立新鲜度复验。
- **不要把 Message 事件映射、mutation 投影 fan-out、send dispatch quiet window 或 claim wake 散回 `socket-handlers.ts`**：统一调用 Message socket module；module 通过本地 port 依赖 use case，不得重新 import `ServerNextUseCases` god-interface。
- **不要从 Task projection 发送 Message 或 Dispatch/Agent 事件**：Task 投影只调用 `taskSocketProjection.handleMutation(result)`；同一结果必须按 Task id 去重、按 Team 单次刷新 snapshot 与 Memory invalidation。
- **不要在 handler 或 Message adapter 外重复解释 Dispatch 结果**：统一传入明确 source 并调用 `dispatchSocketProjection.handleMutation(...)`；Task 结果的 Memory invalidation 只由 Task module 发送。

## 验证命令

```bash
# 确认没有偷偷引入 web 框架
cd /Users/shaw/AgentBean/apps/server-next && grep -rn "from 'hono'\|from 'express'" src/ | grep -v node_modules
# 确认 createServer 来自 node:http
grep -n "createServer" src/dev-server.ts
# 确认三命名空间
grep -n "\.of('/" src/transport/socket-server.ts
# 深模块改动的最小验证
npm run build:server-next
npx vitest run apps/server-next/tests/message-route-analysis-service.test.ts apps/server-next/tests/automatic-channel-collaboration-routing.test.ts apps/server-next/tests/dev-server.test.ts
# Message transport seam
npx vitest run apps/server-next/tests/message-socket-handlers.test.ts apps/server-next/tests/message-socket-adapter.test.ts apps/server-next/tests/socket-handlers.test.ts
# Task transport seam
npx vitest run apps/server-next/tests/task-socket-projection.test.ts apps/server-next/tests/socket-integration.test.ts
# Dispatch transport seam
npx vitest run apps/server-next/tests/dispatch-socket-projection.test.ts apps/server-next/tests/message-socket-adapter.test.ts apps/server-next/tests/socket-handlers.test.ts apps/server-next/tests/socket-integration.test.ts
# Agent eligibility 边界与关键调用方
npx vitest run apps/server-next/tests/agent-eligibility-module.test.ts apps/server-next/tests/agent-eligibility-decomposition.test.ts apps/server-next/tests/task-claim-broker.test.ts apps/server-next/tests/project-stage-overview.test.ts apps/server-next/tests/project-stage-edges.test.ts
```
