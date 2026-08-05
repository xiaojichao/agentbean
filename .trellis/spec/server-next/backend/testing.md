# 测试：真实 socket.io + 内存 usecases

## 何时适用

新增测试、跑门禁、或排查 CI 红时。`server-next` 测试用真实 socket.io Server + client 打到内存 usecases，不用 mock 传输层。本包占 `test:packages` 约 53% 墙钟，改动要谨慎。

## 本地模式

### 风格：起真实 socket.io

代表文件 `tests/socket-integration.test.ts`（:1-:30）展示了标准模式：

- 用 `node:http` 的 `createServer`（:1）起真实 HTTP 服务。
- 用 `socket.io` 的 `Server`（:26，经 `createRequire` 引入）attach 命名空间。
- 用 `socket.io-client` 的 `io`（:27）建 client 连接。
- 数据层用 `createInMemoryRepositories`（:8，`src/infra/memory/repositories.ts`），不走真实 SQLite。
- 入口用 `createInMemoryServerNext`（:9，`src/index.ts`）+ `attachServerNextNamespaces`（:10，`src/transport/socket-server.ts`）。

即：**传输层真实、数据层内存**。不要 mock socket.io；要测的事件直接 `emitWithAck` 打真实 client socket。

### 测试规模

- `tests/` 下 **146 个 `*.test.ts`** 文件（vitest glob `tests/**/*.test.ts`）。
- 涵盖 socket 集成、迁移、readiness 边界、PI 管理、OutputPackage、workspace 等。

### 命令（仓库根 `package.json`）

| 脚本 | 命令 | 用途 | 佐证 |
|---|---|---|---|
| 全门禁 | `npm run test:ci` | `test:packages` + `test:retained-boundaries`；提 PR 前必跑 | `package.json:22` |
| 仅 server-next（含集成） | `npm run test:server-next` | 本地迭代首选 | `package.json:16` |
| server-next CI 子集 | `npm run test:server-next-ci` | 排除两个 phase smoke | `package.json:17` |
| 单包最快 | `cd apps/server-next && npm run test` | 即 `vitest run` | `apps/server-next/package.json:20` |

`test:server-next-ci`（`package.json:17`）显式 `--exclude tests/phase-2-managed-team-smoke.test.ts --exclude tests/phase-4-managed-server-worker-smoke.test.ts`——这两个 smoke 需要真实 managed 环境，CI 里跳。

`test:packages`（`package.json:20`）串联跑 contracts / pi-management-runtime / domain / server-next-ci / daemon-next / web-next，是 PR 的核心门禁。

### 53% 墙钟

`server-next` 占 `test:packages` 约 **53% 墙钟**（见「CI 性能基线」memory）。含义：

- **不要轻提性能改动**：一处慢下来全员 PR 变慢。
- **声明全绿前跑完整 `test:ci`**，不要只跑子集（子集测试漏集成路径，见 「子集测试漏集成路径」memory）。
- **审查意见先复现再改**，不要凭评论直接改（见「review 跟进票先核对已合代码」memory）。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/tests/socket-integration.test.ts`（:1-:30 标准模式）
- `/Users/shaw/AgentBean/apps/server-next/src/infra/memory/repositories.ts`（内存实现）
- `/Users/shaw/AgentBean/apps/server-next/src/index.ts`（`createInMemoryServerNext`）
- `/Users/shaw/AgentBean/package.json`（:16 test:server-next、:17 test:server-next-ci、:20 test:packages、:22 test:ci）
- `/Users/shaw/AgentBean/apps/server-next/package.json`（:20 `"test": "vitest run"`）

## 反模式

- **mock socket.io**：失去传输层集成覆盖；用真实 Server + client。
- **只跑子集就声明全绿**：子集漏集成路径，必须 `npm run test:ci`。
- **加慢测试不计时**：53% 墙钟会继续膨胀。
- **测 SQLite 路径用内存仓储**：内存与 SQLite 实现可能不一致；SQLite 专属测试用真实 better-sqlite3。

## 验证命令

```bash
cd /Users/shaw/AgentBean
# 提 PR 前完整门禁
npm run test:ci
# 本地快速迭代 server-next
npm run test:server-next
# 或在包内
cd apps/server-next && npm run test
# 数测试文件规模
find apps/server-next/tests -name "*.test.ts" | wc -l
```
