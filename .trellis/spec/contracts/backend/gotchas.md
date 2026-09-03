# 陷阱：可选数组静默空、桶幽灵导出、哨兵承重、双站点谓词

## 何时适用

审 PR、改校验器、加 socket 事件、调整 message 可见性时，这五条是本仓反复踩过的坑。每条带真实路径与已合 PR 编号。

## 1. 可选数组静默空（PR#839）

可选数组字段（`field?: readonly T[]`）在调用方用 `(x ?? []).map`/`for…of` 默认空时，**字段会从序列化输出里彻底消失**。这会让「未提供」与「空数组」无法区分，破坏版本迁移与下游默认值检测。

佐证：

- `src/pi-authority-cutover.ts:624,630` —— `const runningLegacyJobs = (runningRaw ?? []).map(…)`、`const pendingLegacyJobIds = (pendingRaw ?? []).map(…)`：未提供 `runningLegacyJobIds` 时静默变空数组。
- `src/system-activity.ts:163,194,221` —— `readonly allowedCommands?: readonly string[]` 在多个 DTO 上是可选；调用方走默认 `[]` 时该键不写回输出（`:668,711,756` 的 `if (value.allowedCommands !== undefined) assertStringArray(value.allowedCommands)` 反向印证：解析时区分「缺键」与「空数组」）。
- `src/formal-memory.ts` —— `sourceRefs?: readonly MemorySourceRefDto[]`（`:134,147`）是可选；与之相对的必填版本 `sourceRefs: readonly MemorySourceRefDto[]`（`:75,101`）说明此字段在不同 DTO 上刻意有必填/可选两种姿态。

**纪律**：新增可选数组字段前，先确认调用方是否需要区分「缺省」与「显式空」。若需要区分，序列化侧永远写键、用 `null` 表缺省；若不需要，注释标明「调用方默认 `[]` 时此键消失」。PR#839 是此问题已合的修复先例。

## 2. 桶幽灵导出（vitest ≠ tsc 盲点）

`src/index.ts` 是手工维护的 `export * from './<domain>.js'` 列表（49 行），**无完整性测试**。

陷阱：`packages/contracts` 自测在 vitest 里直接 `import { … } from '../src/<domain>.js'`，绕过了桶；漏 `export *` 的领域文件在 `npm test` 全绿，但下游 `apps/server-next` 走 `import { … } from '@agentbean/contracts'`（解析 `dist/index.js`）会 tsc 报错「无导出成员」。

佐证：

- 桶本身：`packages/contracts/src/index.ts`（全文 49 行 `export *`，无测试）。
- vitest 直连 src 的范式：`tests/message-visibility.test.ts:2` `import { isHiddenSystemMessage } from '../src/message.js'`；`tests/task-claim-contracts.test.ts:2` `import { … } from '../src/index.js'`（部分走桶，部分走源文件，不保证完整覆盖）。
- CI 不替 contracts 建 `dist`（根 `package.json:13` `test:contracts` 直跑 vitest，无 `tsc` 步），幽灵导出只能靠 `apps/server-next` 的 tsc 兜底，反馈滞后。

**纪律**：新增领域文件后必须手动在 `src/index.ts` 追加 `export * from './<domain>.js'`；审 barrel/index 类 PR 必跑 `cd packages/contracts && npx tsc -p tsconfig.json --noEmit`（feedback 记忆 `feedback-vitest-not-tsc-blindspot.md`）。建议 PR 描述贴 tsc 输出佐证。

## 3. 哨兵错误字符串承重

校验器抛的 error.message 是**字面量字符串常量**，被测试用 `.toThrow('…_INVALID')` 与生产 catch 点同时消费。改名/拼写错误会静默破坏两边。

佐证（定义点 ↔ 测试消费点）：

| 哨兵 | 定义 | 消费 |
|---|---|---|
| `TASK_CLAIM_PAYLOAD_INVALID` | `src/socket.ts:782` `throw new Error('TASK_CLAIM_PAYLOAD_INVALID')` | `tests/task-claim-contracts.test.ts`（safeParse 期望 `{ok:false}`） |
| `PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID` | `src/pi-authority-cutover.ts:512`（`export const`）+ 全文 `throw new Error(…)` | `tests/pi-authority-cutover-contracts.test.ts:14` `const INVALID = /PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID/` |
| `DEVICE_WORKSPACE_SNAPSHOT_INVALID` | `src/project-channel-workspace.ts:155` | `tests/contracts.test.ts:74` `expect(…).toThrow('DEVICE_WORKSPACE_SNAPSHOT_INVALID')` |

**纪律**：新增校验器照 `<DOMAIN>_INVALID` 命名；优先 `export const FOO_INVALID = 'FOO_INVALID'`（参考 `PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID` 模式）让本文件与测试共享同一常量，避免字符串重复拼写漂移。改名前 `grep -rn '<OLD_SENTINEL>' packages/contracts tests apps/` 全仓核对 catch 点。

## 4. `isHiddenSystemMessage` 双站点

`src/message.ts:100` `isHiddenSystemMessage` 是「PI 系统消息是否从用户视图隐藏」的**唯一真相谓词**，但它必须在**两个独立站点**各自应用，漂移任一处都会导致 PI 系统消息泄漏成可见气泡或计入回复数：

- **server 序列化边界**：server 在投影/序列化消息时调用谓词过滤掉应隐藏的系统消息，不投递给前端。
- **web 渲染/计数处**：前端在渲染频道主时间线、Thread、计算未读/回复数时再次调用同一谓词，作为防御性二次过滤。

文件注释（`src/message.ts:92-99`）明确：「服务端在序列化边界、前端在渲染/计数处各自应用同一规则。」隐藏条件（`src/message.ts:104-109`）：`senderKind==='system'` 且 `meta.kind` 属于 `HIDDEN_SYSTEM_MESSAGE_KINDS`（包括 `task-created`、`management-status`、`artifact-version-revision`、`task-delivery-accepted` 及历史 `channel-collaboration-summary`），或 `meta.coordination !== undefined`。保留可见：`management-question`（PI 向用户提问）、`management-delivery`（交付物，需验收）。

陷阱：死守卫 `senderKind === 'pi'` 不存在 —— PI 不以独立 senderKind 出现，只发 `system` 消息再靠 `meta.kind`/`meta.coordination` 区分（feedback 记忆 `agentbean-pi-system-message-thread-leak.md`「死守卫陷阱」）。新增应隐藏的 meta.kind 时，**同步改 server 投影 + web 渲染/计数两处**，并扩 `tests/message-visibility.test.ts`。

## 5. PR#839 之外的复合教训

「可选数组静默空」与「桶幽灵导出」共同说明：本仓**类型正确 ≠ 运行时正确**。`readonly`/可选字段是编译期幻觉，序列化默认值与桶完整性是运行期行为，vitest 直连源文件无法覆盖。任何改动都要跑 `npx tsc -p tsconfig.json --noEmit` 与下游 `npm run test:packages` 才算可靠验证。

## 反模式汇总

- 把 `allowedCommands?: readonly string[]` 当「总是数组」用，不写键就 `.map`。
- 改完领域文件不更新 `src/index.ts`，靠 vitest 全绿自我安慰。
- 校验器抛 `throw new Error('invalid input')`（无哨兵），测试无法精确 catch。
- 只在 server 改 `isHiddenSystemMessage` 判定，忘了同步 web 计数，PI 消息又冒泡。
- 把 PI 消息标 `senderKind:'pi'` 试图靠 senderKind 过滤（不存在的枚举值）。

## 佐证文件

- `packages/contracts/src/pi-authority-cutover.ts`（`:512,620-634,668,711,756`）
- `packages/contracts/src/system-activity.ts`（`:163,194,221`）
- `packages/contracts/src/formal-memory.ts`（`:75,101,134,147`）
- `packages/contracts/src/index.ts`（全文 49 行桶）
- `packages/contracts/src/socket.ts`（`:782`）、`packages/contracts/src/project-channel-workspace.ts`（`:155`）、`packages/contracts/src/message.ts`（`:92-110`）
- `packages/contracts/tests/pi-authority-cutover-contracts.test.ts:14`、`packages/contracts/tests/contracts.test.ts:74`、`packages/contracts/tests/message-visibility.test.ts`

## 可靠验证命令

```bash
# 盲点兜底（必跑）
cd packages/contracts && npx tsc -p tsconfig.json --noEmit

# 哨兵与谓词测试
cd packages/contracts && npx vitest run tests/message-visibility.test.ts tests/contracts.test.ts tests/pi-authority-cutover-contracts.test.ts

# 改哨兵前全仓核对 catch 点：
grep -rn 'TASK_CLAIM_PAYLOAD_INVALID\|DEVICE_WORKSPACE_SNAPSHOT_INVALID\|PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID' packages/ apps/
```
