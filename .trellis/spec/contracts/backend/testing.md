# 测试风格、代表文件、运行命令

## 何时适用

给 `packages/contracts` 加/改测试时适用。本仓不写通用 vitest 教程；只写本包真实约定。

## 风格

- **框架**：vitest，`environment:'node'`，`include:['tests/**/*.test.ts']`（`packages/contracts/vitest.config.ts`）。无 jsdom、无 DOM、无 mock 外部服务。
- **导入**：从 `../src/<domain>.js` 直连源文件（ESM `.js` 后缀），不走 `@agentbean/contracts` 包导入 —— 这是桶幽灵导出盲点的根因（见 [gotchas.md](gotchas.md)），也是本仓既定写法，不要改。
- **结构**：`describe('<domain> contracts', …)` + `test('<中文用例描述>', …)`。用例名用中文，断言用英文 API。
- **断言范式**：
  - 事件名整对象：`expect(AGENT_EVENTS.taskClaim).toEqual({ offer:'task-claim:offer', … })`（`tests/task-claim-contracts.test.ts:6-10`）。
  - 校验器正路：`expect(parseTaskClaimPayload('respond', {…})).toMatchObject({ kind:'needs_info', detail:'缺上下文' })`（同文件 `:12-14`）。
  - 校验器异常路径：`expect(safeParseTaskClaimPayload('respond', {…kind:'bogus'})).toEqual({ ok:false })`（`:15-17`），或 `expect(() => parseDeviceWorkspaceSnapshot({…unexpected:true})).toThrow('DEVICE_WORKSPACE_SNAPSHOT_INVALID')`（`tests/contracts.test.ts:74`）。
  - 谓词分支：`expect(isHiddenSystemMessage({ senderKind:'system', meta:{kind:'task-created'} })).toBe(true)`（`tests/message-visibility.test.ts:6-7`）。
- **fixtures**：复杂 DTO 样本放 `tests/fixtures/`（如 snapshot、task claim 全字段对象），用例里 spread 后扰动单字段。
- **未知键/缺键必测**：每个校验器至少一条「多余字段抛哨兵」+「缺字段抛哨兵」用例（`tests/contracts.test.ts:74` 是多余键范式）。

## 代表测试文件

| 文件 | 覆盖内容 |
|---|---|
| `tests/contracts.test.ts` | 全局 DTO 形状、`ERROR_CODES`/`Ack` 原语、`parseDeviceWorkspaceSnapshot` 哨兵（`:74`） |
| `tests/message-visibility.test.ts` | `isHiddenSystemMessage` 全分支（system/human/agent、task-created/management-status/coordination/management-question） |
| `tests/task-claim-contracts.test.ts` | `AGENT_EVENTS.taskClaim` 事件名常量、`parseTaskClaimPayload`/`safeParseTaskClaimPayload` 各 kind、未知键拒绝、ack 最小披露 |
| `tests/pi-authority-cutover-contracts.test.ts` | 版本化 payload、`PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID` 哨兵（`:14` `const INVALID = /…/`） |
| `tests/management-worker-v2-contracts.test.ts` / `tests/management-worker-contracts.test.ts` | management worker 三 map（client→server/server→client/ack） |
| `tests/system-activity-contracts.test.ts` | `allowedCommands?` 可选数组解析路径 |
| `tests/project-channel-workspace` 相关（在 `tests/contracts.test.ts`） | snapshot 解析 + 哨兵 |

镜像规则：`src/<domain>.ts` ↔ `tests/<domain>-contracts.test.ts`（或并入 `tests/contracts.test.ts`）。新领域文件要配同名测试文件。

## 运行命令

```bash
# 根目录（推荐；CI 入口）
npm run test:contracts

# 包内全量
cd packages/contracts && npm test

# 单文件
cd packages/contracts && npx vitest run tests/message-visibility.test.ts

# watch（本地迭代）
cd packages/contracts && npx vitest tests/task-claim-contracts.test.ts

# 类型 + .d.ts 自洽（盲点兜底，必跑）
cd packages/contracts && npx tsc -p tsconfig.json --noEmit

# 下游接线验证（contracts 单绿不够；CI 真正入口）
npm run test:packages
```

`npm run test:contracts`（根 `package.json:13`）属 `test:packages`/`test:ci`（`:20,22`）。改完 contracts 跑通此项是最低门槛；要确认下游 tsc 不破，还要本地跑 `npx tsc --noEmit` 与 `npm run test:packages`。

## 反模式

- **`import { … } from '@agentbean/contracts'`**：本包测试一律直连 `../src/`，走包导入会引入 dist 构建依赖，且掩盖桶幽灵导出。
- **mock 校验器内部 helper**：`parse…` 的私有 helper 不导出，测试只通过公开 `parse…`/`safeParse…` 驱动，断言其抛哨兵或返回值。
- **只测 happy path**：校验器必须有未知键/错误 schemaVersion/类型错误 三类负样本用例。
- **用 `try/catch + expect().toThrow()` 混 `safeParse`**：`safeParse…` 已包 try/catch，直接断言 `{ ok:false }` 即可；`parse…` 才用 `.toThrow('…_INVALID')`。
- **断言整个 DTO 对象用 `toEqual`**：字段易漂移，优先 `toMatchObject` 锁关键字段，整对象快照仅用于事件名常量这种稳定结构。

## 佐证文件

- `packages/contracts/vitest.config.ts`、`packages/contracts/package.json`
- `packages/contracts/tests/contracts.test.ts`、`packages/contracts/tests/message-visibility.test.ts`、`packages/contracts/tests/task-claim-contracts.test.ts`、`packages/contracts/tests/pi-authority-cutover-contracts.test.ts`
- 根 `package.json:13,20,22`
