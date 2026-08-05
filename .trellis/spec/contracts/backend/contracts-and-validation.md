# DTO 形状与版本化 + 手写校验器纪律

## 何时适用

定义新的跨进程 wire payload（socket 事件、命令、ack）、给已有 payload 加字段，或写运行时校验器时适用。本文件写本仓**真实**约定，不是 zod 教程。

## 版本化 wire payload：`schemaVersion: 1` 字面量 + `V1` 后缀

凡是跨进程序列化、且未来可能演进的 payload，全部满足三件事：

1. **`readonly schemaVersion: 1` 字面量字段**（不是 `number`，是字面量 `1`）。校验器用 `value.schemaVersion !== 1` 显式拒绝。
2. **类型名带 `V1` 后缀**，配套 `*PayloadMapV1` / `*MapV1` 聚合。
3. **配套 `parse…`（抛哨兵）+ `safeParse…`（返回 `{ok:false}`）两个函数**。

佐证：

- `src/socket.ts:642` `TaskClaimExpiredV1 { readonly schemaVersion: 1; … }`，`src/socket.ts:650` `TaskClaimPayloadMapV1` 把 11 种 claim 形状聚合到一map，`TaskClaimPayloadKind = keyof TaskClaimPayloadMapV1`（`:664`）。
- `src/task-lifecycle.ts:22-26` `TaskLifecycleCommandEnvelopeV1` 含 `readonly schemaVersion: 1`；同文件 `TASK_LIFECYCLE_ENVELOPE_SCHEMA_VERSION = 1`、`COMMAND_SCHEMA_VERSION = 1`、`COMMAND_HASH_VERSION = 1` 三个版本常量（`src/task-lifecycle.ts:12-14`）配套 `canonicalizeTaskLifecycleCommand`（`:89`）做命令哈希。
- `src/pi-authority-cutover.ts` 约 25 处 `readonly schemaVersion: 1`（`:115,136,160,175,187,204,219,241,253,266,284,429,453,470` 等），是本仓版本化 payload 最密集的文件。
- Management worker 三件套：`ManagementWorkerClientToServerPayloadMapV1`（`src/socket.ts:788`）、`ManagementWorkerServerToClientPayloadMapV1`（`:797`）、`ManagementWorkerSocketAckMapV1`（`:801`）—— payload map 与 ack map 分开声明，方向明确。

## 手写校验器纪律（禁 zod）

**全仓零 zod**。本仓明确选择手写校验器路线，模式固定如下：

1. **`exactKeys` / `taskClaimExact` 强制精确键集合**：拒绝未知键和缺键。如 `taskClaimExact(value, ['schemaVersion','offerId','deviceId',…])`（`src/socket.ts:670,673`），多余/缺失字段都触发 `taskClaimInvalid()`。`parseDeviceWorkspaceSnapshot` 用 `exactKeys(snapshot, ['id','teamId','channelId',…])`（`src/project-channel-workspace.ts:80,140-144`）做同样事。
2. **类型断言 helper**：`taskClaimString`/`taskClaimStrings`/`taskClaimPositive`/`taskClaimNonNegative`/`taskClaimStringArray`（`src/socket.ts:775-781`），逐字段断言后 `return value as unknown as TaskClaimPayloadMapV1[K]`（`:709`）收窄类型。
3. **抛哨兵错误码（字符串常量）**，不抛 `Error('generic')`。哨兵字符串是测试的 catch 锚点（见下「哨兵承重」+ [gotchas.md](gotchas.md)）。
4. **`safeParse…` 包 `try/catch` 返回判别联合**：`safeParseTaskClaimPayload` 返回 `{ readonly ok: true; readonly value } | { readonly ok: false }`（`src/socket.ts:712-721`），调用方走判别分支而非 try/catch。

完整范式（`src/socket.ts:666-710`）：

```ts
export function parseTaskClaimPayload<K extends TaskClaimPayloadKind>(
  kind: K, input: unknown,
): TaskClaimPayloadMapV1[K] {
  const value = taskClaimRecord(input);          // 非对象/数组即抛
  switch (kind) {
    case 'offer':
      taskClaimExact(value, ['schemaVersion','offerId',…]);  // 精确键
      taskClaimSchema(value);                     // schemaVersion === 1
      taskClaimStrings(value, ['offerId','agentId']);
      taskClaimPositive(value.taskRevision);
      …
      break;
    …
  }
  return value as unknown as TaskClaimPayloadMapV1[K];
}
```

私有 helper 末尾的 `taskClaimInvalid(): never { throw new Error('TASK_CLAIM_PAYLOAD_INVALID'); }`（`src/socket.ts:782`）是唯一抛错出口。

## 哨兵错误码（承重字符串）

校验器抛的 error.message 是**字面量字符串**，被测试用 `toThrow('…_INVALID')` 消费：

| 哨兵 | 定义点 | 测试消费点 |
|---|---|---|
| `TASK_CLAIM_PAYLOAD_INVALID` | `src/socket.ts:782` | `tests/task-claim-contracts.test.ts`（safeParse 期望 `{ok:false}`） |
| `PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID` | `src/pi-authority-cutover.ts:512`（常量）+ 全文 `throw` | `tests/pi-authority-cutover-contracts.test.ts:14` `const INVALID = /PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID/` |
| `DEVICE_WORKSPACE_SNAPSHOT_INVALID` | `src/project-channel-workspace.ts:155` | `tests/contracts.test.ts:74` `expect(…).toThrow('DEVICE_WORKSPACE_SNAPSHOT_INVALID')` |

改名任何一条哨兵字符串都会破坏对应测试与生产 catch 点。新增校验器要照此命名：`<DOMAIN>_INVALID` 形式，定义 `export const` 常量供本文件与测试共用（参考 `PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID` 模式）。

## 本地模式

1. 新 wire payload：`interface FooV1 { readonly schemaVersion: 1; readonly … }`。
2. 多形态聚合：`interface FooPayloadMapV1 { readonly offer: FooOfferV1; readonly ack: FooAckV1; … }`，类型键 `FooPayloadKind = keyof FooPayloadMapV1`。
3. 校验器三件套：`parseFooPayload(kind, input)` + `safeParseFooPayload(kind, input)` + 私有 `fooInvalid(): never`。
4. 字段断言逐个走 helper；未知键必拒；可选字段用 `if (value.x !== undefined) assertX(value.x)`（见 `src/pi-authority-cutover.ts:668,711,756` 对 `allowedCommands?` 的处理）。
5. 导出哨兵常量字符串供测试消费。

## 反模式

- **`schemaVersion: number`**：必须是字面量 `1`，否则 `taskClaimSchema`/版本演进检测失效。
- **用 zod**：本仓零 zod，PR 引入会被回退；手写路线是约定。
- **抛 `Error('validation failed')` 等模糊消息**：测试 catch 不到，下游也无法按错误分支处理。
- **`parse…` 内吞错返回 `null`/默认值**：`parse…` 必须 throw，`safeParse…` 才是返回判别联合的入口；职责不能互换。
- **校验器漏拒未知键**：只用 `as Record<string, unknown>` 取字段、不调 `exactKeys` 会放过拼写错误的字段，破坏版本演进时的迁移检测。
- **可选数组字段不加默认值兜底**：见 [gotchas.md](gotchas.md)「可选数组静默空」（PR#839）。

## 佐证文件

- `packages/contracts/src/socket.ts`（`:642-721`、`:766-782`、`:788-808`）
- `packages/contracts/src/task-lifecycle.ts`（`:6-91`）
- `packages/contracts/src/pi-authority-cutover.ts`（`:512`、`:560`、多处 `schemaVersion:1` 与 `throw`）
- `packages/contracts/src/project-channel-workspace.ts`（`:78-156`）
- `packages/contracts/tests/pi-authority-cutover-contracts.test.ts:14`、`packages/contracts/tests/contracts.test.ts:74`、`packages/contracts/tests/task-claim-contracts.test.ts`

## 可靠验证命令

```bash
cd packages/contracts && npm test
# 重点跑校验器测试：
cd packages/contracts && npx vitest run tests/task-claim-contracts.test.ts tests/pi-authority-cutover-contracts.test.ts tests/contracts.test.ts
```
