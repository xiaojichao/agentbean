# AgentBean `.trellis/spec/` 编码规范总览

本目录是 AgentBean 仓库的**实战编码指南**，写给未来的 AI agent 与新成员。每条规则都来自真实源码取证（文件路径 + 行号），不是通用框架教程。

## 仓库架构

AgentBean 是一个 monorepo（npm workspaces：`packages/*` + `apps/*`），共 **6 个真实包**：

| 包 | 路径 | 角色 | spec 入口 |
|---|---|---|---|
| `@agentbean/contracts` | `packages/contracts` | 共享类型 / 手写运行时校验面（发布包） | [contracts](contracts/backend/index.md) |
| `@agentbean/domain` | `packages/domain` | 纯领域逻辑（无 IO / 时钟 / 随机） | [domain](domain/backend/index.md) |
| `@agentbean/pi-management-runtime` | `packages/pi-management-runtime` | PI 运行时 adapter（包住上游 SDK） | [pi-management-runtime](pi-management-runtime/backend/index.md) |
| `@agentbean/server-next` | `apps/server-next` | 生产服务端（裸 `node:http` + socket.io） | [server-next](server-next/backend/index.md) |
| `@agentbean/daemon-next` | `apps/daemon-next` | 设备端守护进程（Node 24，拉起 agent） | [daemon-next](daemon-next/backend/index.md) |
| `@agentbean/web-next` | `apps/web-next` | 生产 Web 前端（Next 14 App Router） | [web-next](web-next/frontend/index.md) |

> legacy `apps/server`、`apps/web`、`apps/daemon` 已废弃，**不再有 spec**。生产前端是 web-next（非 apps/web）。

## 跨包思维指南

[guides/index.md](guides/index.md) —— 改动前必读的**跨层 / 代码复用**思维清单（已是项目专属内容，从模板期保留至今）。

## 决策真相源（"为什么"）

编码规则背后的设计决策见 `docs/adr/`（69 条 ADR，`0001`–`0070`）。每个包的 `index.md` 末尾都列了治理它的**相关 ADR**。spec 讲"怎么动手"，ADR 讲"为什么这样设计"。

## 全局纪律

- 注释 / 文档用中文；代码标识符、文件路径、命令保持英文原文。
- 技术选型沿用现有惯例，实现细节照搬仓库现状——只产品决策问用户。
- 每条规则必须有源码佐证（真实路径 + 必要时行号）；**不留 TODO / 占位符 / 空标题**。
- 测试：声明全绿前跑完整 `npm run test:ci`，不要只跑子集（子集会漏集成路径与边界断言）。

## 测试入口（仓库根）

`npm run test:ci` = `test:packages` + `test:retained-boundaries`。各包的单包命令见各包 `index.md`。注意 `server-next` 占 `test:packages` 约 **53% 墙钟**，勿轻提性能改动。
