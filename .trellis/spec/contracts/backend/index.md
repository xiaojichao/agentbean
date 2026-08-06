# @agentbean/contracts 编码规范

`@agentbean/contracts`（`packages/contracts`）是全仓库唯一共享的**类型与运行时校验面**：跨进程 DTO、命令/输入形状、socket 事件名、手写运行时校验器都在这里一次定义，被 `apps/server-next`、`apps/daemon-next`、`packages/pi-management-runtime`、`apps/web-next` 共同消费。它是发布包（`packages/contracts/package.json`：`private:false`、`version:"0.2.5"`、`exports` 指向 `./dist/index.js`），任何破坏性变更都会顺着依赖链放大。

本目录是写给未来 AI agent 和新成员的实战编码指南，不是 TypeScript 教程。每条规则都带仓库内真实路径佐证。

## 主题文件

| 文件 | 主题 |
|---|---|
| [architecture.md](architecture.md) | 包角色、扁平 `src/` 结构、手工维护的桶 `src/index.ts`、核心抽象（`Ack`/`ERROR_CODES`、socket 命名空间、手写校验器） |
| [contracts-and-validation.md](contracts-and-validation.md) | DTO 形状与 `schemaVersion: 1` 版本化约定、`V1` 后缀命名、**手写运行时校验器纪律（禁 zod）**、哨兵错误码 |
| [socket-events.md](socket-events.md) | `WEB_EVENTS`/`AGENT_EVENTS` 命名空间、版本化 payload map、新增 socket 事件的完整流程 |
| [gotchas.md](gotchas.md) | 可选数组静默空（PR#839）、桶幽灵导出（vitest≠tsc 盲点）、哨兵字符串承重、`isHiddenSystemMessage` 双站点 |
| [testing.md](testing.md) | vitest 风格、代表测试文件、运行命令 |

## 可靠验证命令

```bash
# 根目录（推荐，CI 调用同一入口）
npm run test:contracts

# 包内直跑
cd packages/contracts && npm test

# 单文件
cd packages/contracts && npx vitest run tests/message-visibility.test.ts

# 类型检查（CI 不替 contracts 建 dist，但下游消费 .d.ts，必须本地守）
cd packages/contracts && npx tsc -p tsconfig.json --noEmit
```

`npm run test:contracts` 属 `test:packages`/`test:ci`（根 `package.json:13,20,22`）；改完 contracts 跑通此项才能保证下游 `apps/server-next` 等的导入解析。

## 相关 ADR（决策真相源）

本包约定由以下 ADR 治理（spec 讲"怎么动手"，ADR 讲"为什么"）：

- `docs/adr/0067-server-uses-a-closed-named-command-registry.md` — 闭命令注册表：**contracts 须提供** discriminated runtime schemas + canonical 序列化/hash
- `docs/adr/0064-subtasks-publish-atomic-contracts-and-use-channel-scoped-offers.md` — 子 Task 发布原子契约
- `docs/adr/0056-project-stage-edges-carry-the-dependency-fact.md` / `docs/adr/0057-required-input-evidence-starts-at-stage-level.md` — stage edges / 必填输入证据
- `docs/adr/0070-daily-changelog-uses-user-facing-manual-entries-with-llm-fallback.md` — 更新日志契约
