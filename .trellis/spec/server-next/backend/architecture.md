# 架构：裸 HTTP + socket.io 命名空间 + god-interface

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
| `src/application/` | 用例、服务、handler、repository 接口、UoW | `usecases.ts`、`output-package-service.ts`、`channel-access.ts`、`repositories.ts`、`*-handler.ts`、`*-unit-of-work.ts` |
| `src/application/management/` | PI 内核（路由、worker 池、claim broker） | `management-kernel.ts`、`management-router.ts`、`server-worker-pool.ts`、`task-claim-broker.ts` |
| `src/infra/sqlite/` | SQLite 实现 + 迁移 | `repositories.ts`、`migrations/global/`、`migrations/team/` |
| `src/infra/memory/` | 测试用内存实现 | `repositories.ts` |
| `src/transport/` | socket.io 绑定 | `socket-server.ts`、`socket-handlers.ts` |
| `src/` 根 | 入口与组装根 | `dev-server.ts`（生产）、`index.ts`（内存）、`bin.ts`（CLI） |

### god-interface 工厂：createServerNextUseCases

`src/application/usecases.ts` 是 19401 行的 god-interface 工厂：

- 类型 `ServerNextUseCases` 定义在 `src/application/usecases.ts:392`，包含数百个成员（handler 方法、服务、仓储引用）。
- 工厂函数 `createServerNextUseCases` 在 `src/application/usecases.ts:1914`，通过闭包持有所有本地 helper 与可变状态。
- socket 层通过 `bind(socket, EVENT, app, 'handlerName')` 把 handler 方法名暴露成事件（详见 socket-and-readiness.md）。

**这是已知技术债**：新代码应优先放进新建深模块，而不是继续往 `usecases.ts` 塞方法。

### 深模块（抽取中）

为收敛 god-interface，正在把高内聚写事实抽成独立模块：

- `src/application/output-package-service.ts`（87 行）：拥有 OutputPackage 生命周期的核心写事实（formation / review / finalize / reject + watermark bump）。头部 `src/application/output-package-service.ts:1-2` 声明相对路径 import 惯例。
- `src/application/channel-access.ts`（29 行）：`ensureUserCanViewChannel` 共享可见性 helper，不依赖任何 god-factory 闭包状态，作为后续"搬方法"切片的共享基建（`src/application/channel-access.ts:6-16` 注释）。

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

`src/dev-server.ts`（2920 行）是**生产组装根**——它创建 HTTP 服务、attach socket.io 命名空间、注入所有仓储与依赖、wire 所有 socket handler。`src/index.ts` 是内存入口（测试用），`src/bin.ts` 是 CLI 入口。改组装顺序或注入依赖时，`dev-server.ts` 是唯一权威位置。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/dev-server.ts`（:3 导入、:299 createServer、:305/:310/:315 端点）
- `/Users/shaw/AgentBean/apps/server-next/src/transport/socket-server.ts`（:119 /agent、:155-156 /server-worker、:280 /web）
- `/Users/shaw/AgentBean/apps/server-next/src/application/usecases.ts`（:392 接口、:1914 工厂、19401 行）
- `/Users/shaw/AgentBean/apps/server-next/src/application/output-package-service.ts`（87 行）
- `/Users/shaw/AgentBean/apps/server-next/src/application/channel-access.ts`（29 行）
- `/Users/shaw/AgentBean/apps/server-next/src/application/repositories.ts`、`src/infra/sqlite/repositories.ts`、`src/infra/memory/repositories.ts`

## 反模式

- **不要引入 Hono/Express 等框架**：HTTP 面刻意保持极小，业务走 socket 事件。
- **不要在 `usecases.ts` 里直接新建大块逻辑**：优先建深模块（参考 `output-package-service.ts` 形态）。
- **不要只改 SQLite 实现忘改内存实现**：仓储接口是双实现的契约。
- **不要绕过 `dev-server.ts` 改组装**：它是唯一生产组装根。

## 验证命令

```bash
# 确认没有偷偷引入 web 框架
cd /Users/shaw/AgentBean/apps/server-next && grep -rn "from 'hono'\|from 'express'" src/ | grep -v node_modules
# 确认 createServer 来自 node:http
grep -n "createServer" src/dev-server.ts
# 确认三命名空间
grep -n "\.of('/" src/transport/socket-server.ts
```
