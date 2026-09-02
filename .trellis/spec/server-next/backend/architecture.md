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
| `src/transport/` | socket.io adapter 与事件绑定 | `socket-server.ts`、`socket-handlers.ts`、`message-socket-handlers.ts`、`message-socket-adapter.ts` |
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

抽新模块时**必须**沿用相对路径 import（见 gotchas.md）。

### 深模块删除测试

只有删除候选 module 会把顺序敏感状态、authority 规则或跨事件协调重新泄漏给多个调用方时，才继续抽取：

- Message socket module 通过删除测试：删除后，mutation 投影顺序、每个 dispatch 独立的 quiet window、claim wake 与终态取消都会重新散回 handler。
- Task / Project 剩余 socket 绑定未通过删除测试：`socket-handlers.ts` 中主要是声明式 event → use case 映射；真实 Task fan-out 与 Project subscriber refresh/metrics 仍由 `socket-server.ts` 的 `afterTaskMutation` / `afterProject*Mutation` 拥有。只搬动这些 `bind(...)` 不会形成更深接口，不要为“按领域分文件”创建薄 adapter。
- Channel Work Intake 已通过删除测试且保持现有边界：删除 `channel-work-intake.ts` 会把 authority、freshness、promotion、replay 与 Offer publication 顺序泄漏回 composition root；在没有第二个 route writer 或重复 authority 流程前，不要再包一层 facade。

未来只有当 Task / Project transport 出现可由单一 module 完整拥有的状态机、顺序策略或多个调用方共享的 fan-out 规则时，才重新评估对应 adapter；事件数量本身不是抽取理由。

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

行为合同：`message-socket-handlers.ts` 拥有全部 Message event → use case 映射；为保持既有跨领域事件注册序列，facade 分 `registerIngress`（send / message-tracer）与 `registerOperations`（其余 Message query/mutation）两阶段注册。send 输入在认证身份注入后追加 connected/claim Device IDs，事件名、注册顺序、ACK/error 语义和 after-result 时序保持兼容。send 先执行 `afterMessageSend`，只有成功 ACK 才继续触发引用/Task/Agent 投影，其中 Agent 全量刷新仅在确实产生 dispatch 时执行；edit 只执行 `afterMessageSend`；delete 按 `afterMessageSend` → `afterMemoryMutation` 执行；convert-to-task 按 `afterTaskMutation` → `afterMessageSend` 执行。每个 send dispatch 的 quiet window 独立维护；支持 claim 的 dispatch 可以提前发 wake，终态 dispatch 必须取消尚未发出的 wake。Message module 只依赖本地 `MessageSocketPort` / `MessageDispatchPort`，不得 import 完整 `ServerNextUseCases` interface。

接口测试在 `apps/server-next/tests/message-socket-handlers.test.ts` 与 `message-socket-adapter.test.ts`，覆盖完整事件映射、send 输入增强、mutation 投影顺序、send 投影 fan-out、独立 quiet window、claim wake 与取消。共享 binder 与 `socket-handlers.test.ts` 继续覆盖认证输入注入、ACK 和错误整形。

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
# Agent eligibility 边界与关键调用方
npx vitest run apps/server-next/tests/agent-eligibility-module.test.ts apps/server-next/tests/agent-eligibility-decomposition.test.ts apps/server-next/tests/task-claim-broker.test.ts apps/server-next/tests/project-stage-overview.test.ts apps/server-next/tests/project-stage-edges.test.ts
```
