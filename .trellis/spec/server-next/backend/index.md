# server-next 后端实战编码指南

面向未来 AI agent 与新成员的 `@agentbean/server-next`（`apps/server-next`）生产服务端编码规范。每条规则均来自真实源码路径与行号，无占位符。

## 角色

`server-next` 是 AgentBean 的生产服务端。它**不使用 Hono/Express 等框架**，而是直接基于 `node:http` 的 `createServer` 起裸 HTTP 服务，几乎所有客户端 API 走 socket.io 命名空间事件，HTTP 面只有 `/healthz`、`/metricsz`、`/preview` 等极少数端点。数据库为 better-sqlite3（Global DB + 每 Team DB 双轨），传输层为 socket.io。

新增功能时，先判断它是否属于已有深模块：Channel Work Intake 进入 `src/application/channel-work-intake.ts`，Agent 资格事实进入 `src/application/agent-eligibility-module.ts`，通用 Server runtime wiring 进入 `src/server-runtime-assembly.ts`；只有尚未抽取的用例才继续进入 `src/application/usecases.ts`。事件绑定仍在 `src/transport/socket-handlers.ts`。改 DB schema 要同步迁移注册与表守卫，新 transport 事件要同步 readiness 剥离链。

## 主题导航

| 主题 | 文件 | 一句话 |
|---|---|---|
| 整体架构 | [architecture.md](./architecture.md) | 裸 node:http + socket.io 三命名空间 + god-interface 工厂 + 深模块抽取中 |
| 迁移与 schema | [migrations.md](./migrations.md) | 静态注册 + sqliteTableExists 表守卫 + 重复号以函数序为准 |
| 数据模型 | [data-model.md](./data-model.md) | 投影表 FK 必须 CASCADE；team_id 无 REFERENCES（跨库） |
| 授权 | [authorization.md](./authorization.md) | route() 二次读防双投递 + 频道可见性 + 设备归属 |
| socket 与 readiness | [socket-and-readiness.md](./socket-and-readiness.md) | bind() 统一绑定 + 新 transport 事件须扩展剥离链 |
| 陷阱汇总 | [gotchas.md](./gotchas.md) | 相对路径强制 + workspace-run.log 过滤 + readonly 幻觉 |
| 测试 | [testing.md](./testing.md) | 真实 socket.io + 内存 usecases；server-next 占 test:packages 53% 墙钟 |

## 常用命令（仓库根目录）

| 目的 | 命令 |
|---|---|
| 全部门禁（提 PR 前必跑） | `npm run test:ci` |
| 仅 server-next 单包（含集成） | `npm run test:server-next` |
| server-next CI 子集（排除两个 phase smoke） | `npm run test:server-next-ci` |
| 单包快速迭代 | `cd apps/server-next && npm run test` |
| readiness 边界检查 | `node scripts/check-agentbean-next-readiness.mjs` |

## 53% 墙钟提示

`server-next` 的测试占整个 `test:packages` 门禁约 **53% 墙钟**（见「CI 性能基线」memory）。**不要轻易改动既有测试或迁移动既有用例**：一处慢下来的改动会让全员 PR 变慢。优化前先测量、先讨论。

## 关键源码入口（绝对路径）

- 生产 host/storage 组装根：`/Users/shaw/AgentBean/apps/server-next/src/dev-server.ts`
- 通用 runtime assembly：`/Users/shaw/AgentBean/apps/server-next/src/server-runtime-assembly.ts`
- Channel Work Intake：`/Users/shaw/AgentBean/apps/server-next/src/application/channel-work-intake.ts`
- Agent eligibility：`/Users/shaw/AgentBean/apps/server-next/src/application/agent-eligibility-module.ts`
- god-interface 工厂：`/Users/shaw/AgentBean/apps/server-next/src/application/usecases.ts`
- socket 绑定：`/Users/shaw/AgentBean/apps/server-next/src/transport/socket-handlers.ts`
- 迁移注册：`/Users/shaw/AgentBean/apps/server-next/src/infra/sqlite/repositories.ts`
- 授权路由：`/Users/shaw/AgentBean/apps/server-next/src/application/management/management-router.ts`
- readiness 脚本：`/Users/shaw/AgentBean/scripts/check-agentbean-next-readiness.mjs`

## 相关 ADR（决策真相源）

server-next 是权威编排与持久化所在，其约定由以下 ADR 治理（spec 讲"怎么动手"，ADR 讲"为什么"）：

- `docs/adr/0062-server-owns-pi-orchestration-authority.md` — server 持有 PI 编排权威
- `docs/adr/0067-server-uses-a-closed-named-command-registry.md` — 闭命令注册表（registry / handler wiring）
- `docs/adr/0069-message-and-pi-orchestration-use-one-end-to-end-authority-path.md` — 消息与 PI 编排端到端权威路径
- `docs/adr/0068-pi-authority-migration-uses-a-one-way-team-cutover.md` — PI 权威单向 cutover（migration）
- `docs/adr/0066-system-activity-uses-audience-scoped-projections.md` — 系统活动受众投影（投影表）
- `docs/adr/0063-task-lifecycles-use-role-gated-transitions.md` — task 生命周期 role-gated 转换
- `docs/adr/0064-subtasks-publish-atomic-contracts-and-use-channel-scoped-offers.md` / `docs/adr/0065-subtask-failures-use-bounded-attempts-and-conditional-reassignment.md` — 子 Task 契约 / 失败改派
- `docs/adr/0015-channel-archive-is-the-project-end-boundary.md` / `0016` / `0017` — 频道归档边界（FK CASCADE）
- `docs/adr/0055-channel-files-use-a-server-owned-index.md` — 频道文件 server-owned 索引
- `docs/adr/0010-server-hosts-the-default-channel-coordinator.md` — server 托管默认协调者
- `docs/adr/0060-system-admin-console-hosts-global-ops-and-pi-management.md` — 系统管理台
