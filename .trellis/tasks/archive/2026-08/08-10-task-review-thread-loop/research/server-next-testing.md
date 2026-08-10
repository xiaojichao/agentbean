# Research: server-next 集成测试惯例

- **Query**: 测试目录、双后端（sqlite/memory）模式、命令测试怎么写
- **Scope**: internal（含 .trellis/spec）
- **Date**: 2026-08-10

## Findings

### 目录与规模

- `apps/server-next/tests/`，146 个 `*.test.ts`（vitest glob `tests/**/*.test.ts`）。
- 两种主流形态：
  1. **usecase 直调集成测试**（本议题相关测试全是这种）：直接 `createServerNextUseCases` + 内存/SQLite 仓储，不走 socket。
  2. **真实 socket.io 集成测试**：`tests/socket-integration.test.ts:1-30` 标准模式——`node:http` createServer + socket.io Server + socket.io-client，数据层仍内存（spec: 「传输层真实、数据层内存」，禁 mock socket.io）。

### 双后端 variants 模式（标准样板）

`apps/server-next/tests/task-linked-request-offer.test.ts:44-62` 与 `unified-delivery-journey.test.ts:44-62` 同一模板：

```ts
const variants: Array<{ name: string; make: () => { repositories: ServerNextRepositories; close: () => void } }> = [
  { name: 'memory', make: () => ({ repositories: createInMemoryRepositories(), close: () => undefined }) },
  { name: 'sqlite', make: () => {
      const globalDb = new Database(':memory:');
      const teamDb = new Database(':memory:');
      applyGlobalMigrations(globalDb);      // Global DB
      applyTeamMigrations(teamDb);          // 每 Team DB（双轨）
      return { repositories: createSqliteRepositories({ globalDb, teamDb }),
               close: () => { globalDb.close(); teamDb.close(); } };
  } },
];
```

- SQLite 用 **better-sqlite3 `:memory:` 双库**（Global + Team），migration 静态注册经 `applyGlobalMigrations`/`applyTeamMigrations`（`src/infra/sqlite/repositories.ts` 导出）。
- 每个 variant 跑同一组 test（`describe.each` 或 for 循环包 seed + test）。
- 注意：「usecase 直调测试是盲区」memory——bind 层注入的 `currentDeviceId` 等字段在直调时不存在，涉及 exact-key parse 的 usecase 要手动剥/补（usecases.ts:9058 的 `currentDeviceId` 剥离模式，PR#1131）。

### Seed 模式

- 每个测试文件自建 `Seed` 接口 + seed 函数：建 team/user/channel/agent、（需要时）`addChannelAgentMember`（memory：#993 seed 必须 addChannelAgentMember）、造 coordination/management run。
- task-linked 类测试额外注入 `createTaskClaimBroker` / `createInvocationGateway` 与 `resolveEligibleAgentIds` mock（task-linked-request-offer.test.ts:26-28 import 区）。
- 时钟/id：`createServerNextUseCases` 注入 clock/ids（测试可用固定值）。

### 命令（command）测试怎么写

参考 `tests/package-review-command.test.ts`（7 测试）：

- 直调 usecase 方法（如 `app.submitPackageReviewAndRejectDelivery({...})`），传 `{teamId, userId, channelId, ...commandInput}`；
- 断言 `Ack` 结果：`ok:true` 时校验 receipt/result（committedRevisions、review 记录、taskTransition）；`ok:false` 时校验稳定 code 与结构化 `rejectedReason`（如 `task-revision-stale`）；
- 幂等：同 idempotencyKey 二次调用 → `replayed`/同 receipt；同 key 不同 payload → conflict；
- fence：先推进事实（改 revision/attempt），再带旧 expected 值调命令 → 断言 stale 拒绝且无部分事实（复查 task/review 状态未变）。

### 运行命令

| 目的 | 命令 |
|---|---|
| 全门禁（提 PR 前必跑） | `npm run test:ci`（根 package.json:22） |
| server-next 全量 | `npm run test:server-next`（:16） |
| server-next CI 子集 | `npm run test:server-next-ci`（:17，排除两个 phase smoke） |
| 包内迭代 | `cd apps/server-next && npm run test`（= `vitest run`） |
| 单文件 | `cd apps/server-next && npx vitest run tests/task-linked-request-offer.test.ts` |

### 纪律（spec + memory）

- server-next 占 `test:packages` **约 53% 墙钟**——不轻易改既有测试、不加慢测试。
- 声明全绿前必须跑完整 `test:ci`，不信子集（memory「子集测试漏集成路径」）。
- 内存与 SQLite 实现可能不一致——SQLite 专属行为（如事务内复核 SQL）必须靠 sqlite variant 覆盖，这也是双后端 variants 的存在意义。
- 新 socket 事件必须同步测试清单（memory #1022 gotcha）；新 transport 事件同步 readiness 剥离链。
- `vitest ≠ tsc`：barrel 幽灵导出 vitest 绿灯下隐藏，改 barrel 必跑 tsc。

### 代表测试文件（本议题相关）

| 文件 | 主题 | 测试数 |
|---|---|---|
| `tests/task-linked-request-offer.test.ts` | #1064 冻结输入 Offer（双后端样板） | — |
| `tests/project-reference.test.ts` | #826 引用冻结 | 8 |
| `tests/output-package-reference.test.ts` | #1063 整包四策略 | 11 |
| `tests/package-review-command.test.ts` | #1061 三命令 | 7 |
| `tests/task-delivery-overview.test.ts` | #1065 聚合视图 | 13 |
| `tests/unified-delivery-journey.test.ts` | #1065 三处一致贯穿旅程 | 2 |
| `tests/task-claim-broker.test.ts` | offer acceptance/claim | — |
| `tests/task-offers-persistence.test.ts` | offer 持久化 | — |
| `tests/output-package-consistency.test.ts` | 水位 not_ready | — |

## Caveats / Not Found

- 无 pg 后端——「双后端」指 memory + sqlite（better-sqlite3），不是 sqlite + postgres。
- stage-delivery-review-workspace（#1176）目前未见独立测试文件（tests/ 下无 stage-delivery 命名文件；可能被 task-delivery-overview.test.ts 或 unified-delivery-journey 覆盖，未逐文件确认）。
