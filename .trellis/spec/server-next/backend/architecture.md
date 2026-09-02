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
| `src/transport/` | socket.io 绑定 | `socket-server.ts`、`socket-handlers.ts` |
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

抽新模块时**必须**沿用相对路径 import（见 gotchas.md）。

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
# Agent eligibility 边界与关键调用方
npx vitest run apps/server-next/tests/agent-eligibility-module.test.ts apps/server-next/tests/agent-eligibility-decomposition.test.ts apps/server-next/tests/task-claim-broker.test.ts apps/server-next/tests/project-stage-overview.test.ts apps/server-next/tests/project-stage-edges.test.ts
```
