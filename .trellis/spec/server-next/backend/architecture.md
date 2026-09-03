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
| `src/transport/` | socket.io adapter、事件绑定与 Server-owned projection | `socket-server.ts`、`socket-handlers.ts`、`message-socket-handlers.ts`、`message-socket-adapter.ts`、`agent-socket-projection.ts`、`device-socket-projection.ts`、`dispatch-socket-projection.ts`、`task-socket-projection.ts`、`task-claim-socket-delivery.ts` |
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
- `src/transport/agent-socket-projection.ts`：通过 `handleMutation(source, payload, result)` 与 `refresh(teamId)` 拥有 Web/daemon Agent mutation 的 Team 归一化、当前权限复验、Agent snapshot/status 顺序、Memory/Channel 后续投影、availability 通知，以及 discovered Agent runtime enrichment；Device 路由、在线状态与 Broker fencing 继续留在组装根和领域 owner。
- `src/transport/device-socket-projection.ts`：通过 `subscribe(...)`、`handleMutation(payload, result)` 与 `refresh(teamId)` 拥有 Device snapshot/status/runtime 的订阅首推、mutation fan-out、Team 去重，以及 Agent/Channel/availability 后续顺序；Device Socket 路由、`device:removed`、offline authority 与 Task Claim fencing 继续留在组装根和领域 owner。
- `src/transport/task-claim-socket-delivery.ts`：通过 `offerTaskClaims(...)` / `expireTaskClaims()` interface 拥有 Task Offer 的 Device Socket 定向交付、ACK/timeout 解释、接受计数，以及过期 Claim 的当前 Device 复验与定向通知；Broker 继续唯一拥有 eligibility、Offer/Claim 事实与状态机。

抽新模块时**必须**沿用相对路径 import（见 gotchas.md）。

### 深模块删除测试

只有删除候选 module 会把顺序敏感状态、authority 规则或跨事件协调重新泄漏给多个调用方时，才继续抽取：

- Message socket module 通过删除测试：删除后，mutation 投影顺序、每个 dispatch 独立的 quiet window、claim wake 与终态取消都会重新散回 handler。
- Project projection broadcast 已通过删除测试：删除 `project-socket-broadcast.ts` 会把三类投影共用的 failure policy、逐用户重读和 latency 观测重新泄漏回 `socket-server.ts`；入口认证与声明式 event → use case 映射仍留在 `socket-handlers.ts`。
- Task socket projection 已通过删除测试：删除 `task-socket-projection.ts` 会把 Task identity 去重、按 Team 单次 snapshot/Memory invalidation、受众差异和事件顺序重新泄漏到 Web Task、Message convert/send、Dispatch cancel 与 Agent result/error 路径。它不能与 Message/Project 共用泛型 fan-out seam。
- Dispatch socket projection 已通过删除测试：删除 `dispatch-socket-projection.ts` 会把 status audience、Agent reply 可见性、Team 去重、Agent refresh 与 Task/Memory 唯一 owner 顺序重新泄漏到 Message send、Web cancel/cancelChannel、Agent message/result/error 及 realtime timeout 路径。
- Agent socket projection 已通过删除测试：删除 `agent-socket-projection.ts` 会把 Agent Team 去重、订阅权限复验、snapshot/status 顺序、Memory/Channel/availability 协调和 discovered runtime enrichment 重新泄漏到 Web Agent mutation、daemon Agent report、Device mutation/disconnect 与 realtime refresh 多个入口。
- Device socket projection 已通过删除测试：删除 `device-socket-projection.ts` 会把订阅首推 runtime 重读、Device snapshot/status 顺序、mutation runtime fan-out，以及 Agent/Channel/availability 协调重新泄漏到 Web Device list、daemon hello/runtime report 与 disconnect refresh 多个入口。
- Task Claim socket delivery 已通过删除测试：删除 `task-claim-socket-delivery.ts` 会把 Offer 准备、当前 Device Socket 定位、ACK timeout/接受计数、Claim expiry 的候选解析与定向通知重新泄漏到 `socket-server.ts` 组装根；它不能吸收 Broker 的 authority 或自动重试策略。
- Channel Work Intake 已通过删除测试且保持现有边界：删除 `channel-work-intake.ts` 会把 authority、freshness、promotion、replay 与 Offer publication 顺序泄漏回 composition root；在没有第二个 route writer 或重复 authority 流程前，不要再包一层 facade。

- Project references 当前**未通过独立 module 的删除测试**：删除候选只会把单一 Message send callback 的频道可见性循环放回原处，不会把状态机、顺序或共享 fan-out 泄漏到多个调用方。其 interface 应保持窄的 committed facts，不得为复用 Project mutation failure policy 而重新接收任意 payload/result。未来只有当 references 出现可由单一 module 完整拥有的状态机、顺序策略或多个调用方共享规则时，才重新评估对应 adapter；事件数量本身不是抽取理由。
- Workspace revision committed fan-out 当前**未通过独立 module 的删除测试**：它只有 `commitWorkspacePublishStaging` 一个 committed-facts 入口，Socket 侧也只有一次 Device 解析与 fire-and-forget emit；没有 ACK、重试、共享状态机或跨调用方顺序。保持 `ServerNextRealtime.emitWorkspaceRevisionCommitted(...)` 窄 seam 即可。只有出现第二个 revision writer、共享的 replay/ACK/能力协商/权限复验策略，或多个入口需要共同维护通知顺序时，才重新评估独立 delivery module。

### 最终残余审计与收口边界

本轮完成 Agent/Device projection 后，`socket-server.ts` 剩余候选均不再计划抽取：

| 候选 | 删除测试结论 | 保留原因 |
|---|---|---|
| Message pin / tracer delivered fan-out | 未通过 | 各自只有一个 committed callback；抽 module 只会搬移一次 Channel/DM 可见性循环 |
| Web DM start/list/snapshot | 未通过 | 只服务单个 Web subscriber，并直接依赖其当前 Channel subscription 与 ACK 顺序 |
| Workspace revision committed | 未通过 | 单 writer、单 fire-and-forget delivery seam；无共享状态机或 ACK/retry 策略 |
| server-worker namespace | 不抽取 | 授权、connection id、Pool/Scheduler fallback、V1/V2/V3 ACK 协议共同绑定同一连接闭包；拆出会扩大接口而不隐藏复杂度 |
| daemon disconnect / invite / `device:removed` | 不抽取 | 依赖 Socket route 与 invite maps，且清理、Broker fence、offline write、removed-before-disconnect 顺序必须在组装根可见 |
| payload/result parser helpers | 未通过 | 仅为本文件协议适配细节，调用方少，无独立 authority 或跨入口协调 |

因此本次 transport 架构提升以 Agent/Device projection 为最后两个新深模块。未来只有新的生产需求让上述候选出现第二入口或共享状态/顺序策略时，才重新执行删除测试；不得因为文件行数或测试覆盖缺口本身继续拆 module。缺失的行为测试应作为测试任务独立处理，不能伪装成架构抽取。

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

### Workspace Revision Committed Socket seam

#### 1. Scope / Trigger

- Trigger：`commitWorkspacePublishStaging` 真正提交出新的 Workspace revision。
- Scope：只把已提交的 `{ teamId, channelId, workspaceId, revisionId }` 事实通知给该频道当前在线的 Agent Device；不拥有 revision authority、staging/CAS、OutputPackage formation、设备本地物化或离线恢复。

#### 2. Contracts

- `commitWorkspacePublishStaging` 只有在本次调用新建 revision 时调用 `onWorkspaceRevisionCommitted`；已 committed staging 的幂等 replay 不重复通知。
- `resolveChannelAgentDeviceIds` 是 server 内部、无 `userId` 的系统查询：先校验 Channel 属于 Team，再只返回频道成员中仍对该 Team 可见且绑定 Device 的 Agent。
- `ServerNextRealtime.emitWorkspaceRevisionCommitted` 使用 `.emit`，不得改为等待 Device ACK；revision 已提交，慢或离线 Device 不能改变 commit 结果。
- 单个通知或 Device fan-out 失败保持 best-effort，不回滚 Workspace commit。daemon reconnect reconcile 才是最终收敛路径，实时事件只是低延迟提示。
- 协议事件、Server sender 与 daemon listener 必须成套保留；不得留下永远不会发送或无人消费的假能力。

#### 3. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| 新 revision 提交成功 | 调用一次 committed callback，并通知当前在线目标 Device |
| committed staging 幂等 replay | 返回既有成功结果，不重复 callback |
| Channel 不存在或 Team 不匹配 | resolver 返回空数组，不发送 |
| Agent 已移出频道、撤销 Team 可见性或无 Device | 不进入目标 Device 集合 |
| 目标 Device 离线 | 跳过，不抛错、不影响其他 Device |
| resolver / Socket fan-out 抛异常 | 不改变已成功的 commit；由 reconnect reconcile 最终收敛 |

#### 4. Deletion Test Decision

当前不抽 `workspace-revision-socket-delivery.ts`：删除这样的候选 module 只会把一个 resolver 调用和一个 emit 循环放回 `socket-server.ts`，不会把顺序敏感状态、authority 或共享策略泄漏给多个调用方。未来重评必须先证明出现了可由单一 module 完整拥有的多入口协调，而不是只因为 `socket-server.ts` 仍然较大。

#### 5. Tests Required

- `apps/server-next/tests/workspace-revision-fanout.test.ts`：覆盖系统侧 Device 解析、跨 Team/未知 Channel 静默、新 revision 单次 callback、幂等 replay 不重复，以及真实 Socket.IO 的在线/离线 fan-out。
- `apps/daemon-next/tests/workspace-revision-fanout.test.ts`：覆盖收到通知后的本地物化、重复事件幂等、错误 Device 忽略与 reconnect reconcile。

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

### Agent Socket Projection interface

#### 1. Scope / Trigger

- Trigger：Web Agent mutation、daemon Agent report，或 Device mutation/disconnect 与 realtime 显式要求刷新 Agent 投影。
- Scope：拥有 Agent Team 归一化、订阅权限复验、snapshot/status 顺序、Agent mutation 导致的 Memory/Channel/availability 后续投影，以及 daemon report 的 discovered Agent enrichment；不拥有 Agent/Device 持久状态、Device Socket 路由、删除断连、Dispatch/Task 投影或 Broker fencing。

#### 2. Signatures

```typescript
type AgentSocketMutationSource = 'web-command' | 'agent-report';

interface AgentSocketProjection {
  handleMutation(
    source: AgentSocketMutationSource,
    payload: unknown,
    result: unknown,
  ): Promise<void>;
  refresh(teamId: string): Promise<void>;
}

interface AgentSocketProjectionPort extends Pick<
  ServerNextUseCases,
  'listChannels' | 'listVisibleAgents' | 'getDevice'
> {}
```

#### 3. Contracts

- 失败 ACK 不读取任何投影、不发送事件，也不调用 Memory/Channel/availability callback。
- `web-command` 从 payload Team/target/affected、result Agent visibility 与 Dispatch Team 合并去重；每 Team 固定执行 Agent refresh → Memory invalidation，最后再刷新 `channelTeamIds`。
- `agent-report` 要求 payload Team 或 result Dispatch Team；合并 target/visible Team 去重后，每 Team 固定执行 Agent refresh → availability callback，最后投影 discovered Agent。
- `refresh(teamId)` 先以每个 agents subscription 调用 `listChannels` 复验当前 Team access；失败即清除该 subscription，不得继续发送 snapshot/status。
- 权限复验成功后按 `agent.snapshot` → 每个 `agent.status` 的顺序发送；`listVisibleAgents` 失败时静默跳过当前订阅者。
- discovered Agent 只发给同 Team 的 devices subscriber，并以该订阅者 `userId` 调用 `getDevice`；adapter kind 归一化后匹配 runtime，不能把任意 mutation result 当成投影输入。
- availability callback 失败保持 best-effort，不阻断其他 Team 与 discovered 投影。Device mutation/disconnect 只复用 `refresh`；设备路由表、offline write 与删除断连仍留在 `socket-server.ts`。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| mutation `result.ok !== true` | 不读取、不发送、不调用 callback |
| 多个来源重复同一 Team | 每个 mutation 只刷新该 Team 一次 |
| agents subscription Team 不匹配 | 不读取该 subscriber |
| `listChannels` 返回失败 | 清除 agents subscription，不发送 snapshot/status |
| `listVisibleAgents` 返回失败 | 保留 subscription，本轮不发送 |
| availability callback reject | 吞掉并继续后续 Team/discovered 投影 |
| daemon report 缺 Team/device/有效 agents | 保留适用的 Agent refresh；不发送 discovered |
| `getDevice` 返回失败 | 仅跳过该 devices subscriber |

#### 5. Good/Base/Bad Cases

- Good：Agent visibility mutation 同时影响多个 Team → Team 去重、逐 Team snapshot/status 后各发一次 Memory，最后刷新受影响 Channel。
- Base：daemon registerBatch → 当前 Team snapshot/status、availability，再向 Device subscriber 发送一次规范化 discovered payload。
- Bad：Device mutation 自己重写 Agent snapshot/status 循环；或 projection module 修改 Device 路由、Agent 在线状态与 Claim fencing。

#### 6. Tests Required

- `agent-socket-projection.test.ts`：覆盖 Web Team 去重与顺序、daemon report/availability/discovered enrichment、撤权 fail-closed 和失败 ACK 静默。
- `socket-handlers.test.ts`：继续覆盖 Web/Agent event 到 callback 的职责分离与 affected/channel Team 输入增强。
- `socket-integration.test.ts`：继续通过真实 Socket.IO 覆盖 daemon report、撤权、Device runtime、discovered payload、disconnect 与 `realtime.refreshAgents`。

#### 7. Wrong vs Correct

```typescript
// Wrong：每个入口自行解释 Team、权限与 snapshot/status 顺序。
await refreshAgentSubscribers(webSubscribers, app, teamId);
emitMemoryChanged(webSubscribers, teamId);

// Correct：入口只标注 owner 语义，Device/realtime 只请求共享 refresh。
await agentSocketProjection.handleMutation('web-command', payload, result);
await agentSocketProjection.refresh(affectedTeamId);
```

### Device Socket Projection interface

#### 1. Scope / Trigger

- Trigger：Web Device list 建立订阅、daemon Device hello/runtime report 成功提交，或当前 daemon socket disconnect 后需要刷新 Device 投影。
- Scope：拥有 Device snapshot/status/runtime 的订阅首推、mutation fan-out 与相关 Agent/Channel/availability 后续顺序；不拥有 Device 持久状态、Socket 路由、`device:removed`、offline authority 或 Task Claim fencing。

#### 2. Signatures

```typescript
interface DeviceSocketProjection {
  subscribe(
    subscriber: DeviceSocketSubscriber,
    subscription: DeviceProjectionSubscription,
    devices: readonly { readonly id: string }[],
  ): Promise<void>;
  handleMutation(payload: unknown, result: unknown): Promise<void>;
  refresh(teamId: string): Promise<void>;
}

interface DeviceSocketProjectionPort extends Pick<
  ServerNextUseCases,
  'listDevices' | 'getDevice'
> {}
```

#### 3. Contracts

- `subscribe` 保存已认证 subscription，先发送 `device.snapshot`，再以订阅者 `userId` 逐 Device 调用 `getDevice`；只为非空已存 runtimes 发送 `device.runtimes`。
- `refresh(teamId)` 只重读目标 Team 的 Device subscriber；成功结果固定发送一次 snapshot，再按结果顺序逐 Device 发送 status。失败读取不发送、不清除 subscription。
- `handleMutation` 只处理成功 ACK，并从 payload Team 或 committed Device Team 解析 scope；固定顺序为 Device refresh → affected Agent Teams → affected Channel Teams → mutation runtimes → availability callback。
- `affectedTeamIds` / `channelTeamIds` 分别去重；Device 主 Team 的 availability callback 只调用一次，失败保持 best-effort。
- daemon hello 成功后，组装根必须先更新 `connectedDeviceId`、Socket route 与 Broker reconnect fence，再调用 projection；disconnect 必须先确认当前 socket 仍拥有 Device route，再写 offline authority，最后调用 `refresh`。
- `device:removed` 必须在 socket disconnect 前发送给 delete result 中全部 alias Device；该流程继续由 `socket-server.ts` 拥有，不进入 projection。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| Device list 成功 | 保存 subscription；snapshot 后发送各 Device 已存 runtime |
| mutation `result.ok !== true` | 不读取、不发送、不调用 callback |
| mutation 缺 payload/result Team | 不刷新、不发送 |
| `listDevices` 返回失败 | 保留 subscription，本轮不发送 snapshot/status |
| stored `getDevice` 失败或 runtimes 为空 | 仅跳过该 Device runtime，继续后续 Device |
| 重复 affected/channel Team | 每类 callback 对该 Team 只调用一次 |
| availability callback reject | 吞掉，不改变已完成投影 |
| stale daemon socket disconnect | 不写 offline、不刷新；新 socket 继续拥有 route |

#### 5. Good/Base/Bad Cases

- Good：daemon runtime report → Device snapshot/status、受影响 Agent/Channel 刷新、runtime 增量、availability 按固定顺序完成。
- Base：Web Device list → snapshot 后补发持久化 runtimes；late subscriber 获得当前事实。
- Bad：projection 直接修改 `agentSocketsByDeviceId`、调用 `markDeviceOffline`、发送 `device:removed`，或操作 Task Claim disconnected fence。

#### 6. Tests Required

- `device-socket-projection.test.ts`：覆盖订阅 snapshot/runtime 首推、Team 定向 refresh 与 snapshot/status 顺序、mutation 跨投影顺序/去重、失败静默。
- `agent-socket-projection.test.ts`：继续覆盖 Device mutation 复用的 Agent refresh、权限撤销和 availability 隔离。
- `socket-integration.test.ts`：继续通过真实 Socket.IO 覆盖 hello/runtime、late subscriber、disconnect/reconnect、alias delete 与 `device:removed`。
- `device-management.test.ts` / `device-agent-lifecycle.test.ts`：继续覆盖 Device authority、别名、撤销、offline 与 hosted Agent 级联，不把领域规则搬入 transport module。

#### 7. Wrong vs Correct

```typescript
// Wrong：projection 接管连接身份、offline authority 或 Claim fence。
agentSocketsByDeviceId.set(deviceId, socket);
taskClaimBroker.disconnectDevice(deviceId);
await app.markDeviceOffline({ deviceId, timestamp });

// Correct：组装根先处理 route/authority，再把 committed result 交给投影。
connectedDeviceTeamId = teamId;
await deviceSocketProjection.handleMutation(payload, result);
```

### Task Claim Socket Delivery interface

#### 1. Scope / Trigger

- Trigger：Server runtime 发布已准备的 Task Offer，或周期回收已过期 Agent execution claim。
- Scope：只拥有 Agent Socket 的定向 delivery、Offer ACK/timeout 解释与过期通知；不拥有 eligibility、Offer/Claim 持久事实、accept/acquire、allocation round、自动 re-offer 或 execution attempt。

#### 2. Signatures

```typescript
interface TaskClaimSocketDelivery {
  offerTaskClaims(
    taskId: string,
    options?: {
      readonly allowedAgentIds?: readonly string[];
      readonly projectStageAuto?: boolean;
    },
  ): Promise<{ taskId: string; offered: number; accepted: number }>;
  expireTaskClaims(): Promise<readonly TaskClaimExpiredV1[]>;
}

interface TaskClaimSocketDeliveryPort extends Pick<
  TaskClaimBroker,
  'prepareOffers' | 'expireClaims' | 'resolveCandidates'
> {}
```

#### 3. Contracts

- `prepareOffers`、`expireClaims` 与 `resolveCandidates` 仍由 Broker 实现；delivery module 不解释 eligibility、Offer kind、Claim revision/attempt 或状态转换。
- 每个已准备 Offer 使用其 committed `deviceId` 在发送时解析当前 Socket；离线或不支持 ACK 的 Device 不接收，但仍计入 `offered`。
- Offer 通过 `timeout(offerTimeoutMs).emitWithAck` 并发交付；只有 `{ ok: true }` 计入 `accepted`，negative ACK、timeout 与单 Device 异常只影响该候选。
- Claim expiry 每轮只调用一次 `expireClaims`，保持返回 notice 顺序；每个 notice 都通过当前候选事实重新解析 `agentId → deviceId`，再定向发送 `taskClaim.expired`。
- 未配置 Broker 时保持 transport 可选：Offer 返回零计数、expiry 返回空列表，并且不读取 Socket。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| Broker 未配置 | Offer `{ offered: 0, accepted: 0 }`；expiry `[]` |
| Offer 对应 Device 离线或无 `emitWithAck` | 不发送、不计 accepted；其他候选继续 |
| Offer ACK 为 `{ ok: false }` 或其他 shape | 不计 accepted；不改变 Broker 事实 |
| Offer delivery timeout/抛异常 | 仅当前候选视为未接受；不向调用方抛出 |
| `prepareOffers` / `expireClaims` / `resolveCandidates` 抛异常 | 向调用方传播，保留 Host scheduler 的现有失败处理 |
| expiry 找不到 Agent 的当前 Device | 保留并返回 expired notice，不发送 Socket event |

#### 5. Good/Base/Bad Cases

- Good：连续两个过期 Claim notice → 各自复验当前 Agent Device，并按原 notice 顺序定向通知。
- Base：三个 Offer 中一台接受、一台拒绝、一台离线 → `offered: 3, accepted: 1`。
- Bad：transport 自行判断 Agent 是否 eligible、在 timeout 后创建新 Offer，或把 Socket ACK 当作 Claim acceptance。

#### 6. Tests Required

- `task-claim-socket-delivery.test.ts`：覆盖在线/离线 Device、positive/negative ACK、timeout 隔离、逐 notice Device 复验、缺失 Agent 与无 Broker no-op。
- `management-socket-integration.test.ts`：继续通过完整 namespace 接线覆盖 Offer/expiry 事件、ACK 计数和目标 Agent 隔离。
- `dev-server.test.ts`：继续覆盖 Host expiry scheduler 的有界自动 re-offer 与关闭清理；该策略不进入 delivery module。

#### 7. Wrong vs Correct

```typescript
// Wrong：组装根重新解释 ACK，并把 timeout 当作领域拒绝或自动重试。
const offer = await broker.prepareOffers(taskId);
await socket.emitWithAck(AGENT_EVENTS.taskClaim.offer, offer);
await broker.prepareOffers(taskId);

// Correct：组装根只委托 transport delivery；Broker/Host 保留各自 authority。
return taskClaimSocketDelivery.offerTaskClaims(taskId, options);
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
  emitStatus(dispatch: unknown): Promise<void>;
}

interface DispatchSocketProjectionPort {
  listChannels: ServerNextUseCases['listChannels'];
  listDirectMessages: ServerNextUseCases['listDirectMessages'];
  listVisibleAgents: ServerNextUseCases['listVisibleAgents'];
}
```

#### 3. Contracts

- 调用方必须显式传入 source；不得以 `dispatch` / `dispatches` 的 shape 推断 Message 是否已被其他 owner 投影。
- 发送任何事件前，按 Team 为每个匹配 subscriber 使用其 channel/agent/device subscription 调用一次 `listChannels` 复验当前成员权限；失败时清除该 socket 对此 Team 的三类缓存 subscription，并从本次 audience 排除。
- 成功结果将单个 `dispatch` 与 `dispatches[]` 合并并按 Dispatch `id` 首次出现去重；每个 Dispatch 按其 `teamId` 向 channels/agents/devices 任一属于该 Team 的 subscriber 发送一次 `WEB_EVENTS.message.dispatchStatus`。
- 只有 `agent-report` source 才读取 `message` / `messages[]`；`message-send` 的原消息已由 Message adapter 唯一投影，Dispatch module 不得重复发送。
- Agent reply Message 必须先匹配 Team，再以 subscriber 自己的 channel subscription 重读 `listChannels` / `listDirectMessages` 复核频道或 DM 可见性；不得先广播正文再由客户端隐藏。
- 受影响 Team 从 payload team/targetTeam、Agent visibility、Dispatch 与 Message 的 committed team facts 合并去重；每 Team、每 agents subscriber 最多重读一次 `listVisibleAgents`，固定发送 snapshot 后逐 Agent status。
- 固定顺序为全部 Dispatch status → 全部可见 Agent reply Message → 每 Team Agent snapshot/status → Memory invalidation。
- 结果包含 `task` 或非空 `tasks[]` 时，Memory invalidation 由后续 `TaskSocketProjection` 唯一发送；否则 Dispatch module 每 Team 发送一次。
- `emitStatus` 供 realtime timeout 等已提交 Dispatch 状态入口异步复用相同权限复验与 audience 规则，不触发 Message、Agent 或 Memory 投影；调用方必须 `await`。

#### 4. Validation & Error Matrix

| 条件 | 行为 |
|---|---|
| `result.ok !== true` | 不发送、不重读 |
| Team access 复验失败 | 清除该 Team 的 channels/agents/devices subscription；不向该 socket 发送任何事件 |
| 单个 subscriber 的 Team access 读取抛异常 | 本次排除该 subscriber、保留 subscription 供后续重试，并继续处理其他合法受众；warning 包含固定 event、Team/User correlation、error class 与 suppressed count，在 projection 内跨 Socket 共享 Team/User/error class 的 60 秒去重窗口，首次立即记录、窗口后汇总；汇总时续期、成功读取时主动清除，并在最后一次日志后 2 个窗口自动淘汰；不得记录原始错误消息或对象 |
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

- `dispatch-socket-projection.test.ts`：断言顺序、Dispatch/Team 去重、Team 权限复验、撤权清理、单订阅者异常隔离、同用户多 Socket 的限流汇总与离线过期诊断、频道与 DM 可见性、Task/Memory 唯一 owner、失败与缺失 Team 输入。
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
- **不要在 Web/Agent/Device callback 中重写 Agent snapshot/status 与权限复验**：Agent mutation 统一调用 `agentSocketProjection.handleMutation(source, payload, result)`，Device/disconnect/realtime 只调用 `refresh(teamId)`；模块不得接管 Device 路由、offline write 或 Claim fencing。
- **不要在 Device list/hello/runtime/disconnect 路径中重写 Device snapshot/status/runtime 顺序**：订阅首推、mutation 与显式刷新统一委托 `deviceSocketProjection`；`agentSocketsByDeviceId`、`device:removed`、offline write 与 Claim fencing 必须留在组装根和领域 owner。
- **不要在 `socket-server.ts` 解释 Task Offer ACK、Claim expiry 接收方或自动 re-offer**：前两者委托 `task-claim-socket-delivery.ts`，自动 re-offer 继续由 Host scheduler 与 Broker authority 决定。
- **不要仅因 Workspace revision 通知仍在 `socket-server.ts` 就包一层 module**：它目前是单一 committed-facts seam；在没有多入口状态/顺序/重试策略前，额外 facade 不会形成深模块。

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
# Agent transport seam
npx vitest run apps/server-next/tests/agent-socket-projection.test.ts apps/server-next/tests/socket-handlers.test.ts apps/server-next/tests/socket-integration.test.ts
# Device transport seam
npx vitest run apps/server-next/tests/device-socket-projection.test.ts apps/server-next/tests/agent-socket-projection.test.ts apps/server-next/tests/socket-integration.test.ts apps/server-next/tests/device-management.test.ts apps/server-next/tests/device-agent-lifecycle.test.ts
# Task Claim Agent Socket delivery seam
npx vitest run apps/server-next/tests/task-claim-socket-delivery.test.ts apps/server-next/tests/management-socket-integration.test.ts apps/server-next/tests/dev-server.test.ts
# Workspace revision committed seam（Server fan-out + daemon materialize/reconcile）
npx vitest run apps/server-next/tests/workspace-revision-fanout.test.ts apps/daemon-next/tests/workspace-revision-fanout.test.ts
# Dispatch transport seam
npx vitest run apps/server-next/tests/dispatch-socket-projection.test.ts apps/server-next/tests/message-socket-adapter.test.ts apps/server-next/tests/socket-handlers.test.ts apps/server-next/tests/socket-integration.test.ts
# Agent eligibility 边界与关键调用方
npx vitest run apps/server-next/tests/agent-eligibility-module.test.ts apps/server-next/tests/agent-eligibility-decomposition.test.ts apps/server-next/tests/task-claim-broker.test.ts apps/server-next/tests/project-stage-overview.test.ts apps/server-next/tests/project-stage-edges.test.ts
```
