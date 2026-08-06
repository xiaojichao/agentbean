# 架构：角色、扁平结构、手工桶、核心抽象

## 何时适用

新增/修改 `packages/contracts/src/**` 任意文件，或在 `server-next`/`daemon-next`/`web-next`/`pi-management-runtime` 引入新的跨进程类型、socket 事件、命令形状时适用。本项目不写通用分层教程；只写本包真实结构。

## 包角色与边界

- **唯一类型面**：跨进程 DTO、命令输入/输出、socket 事件名、运行时校验器集中在此。`packages/contracts/package.json` 声明 `private:false`、`version:"0.2.5"`、`type:"module"`、`exports.".".import="./dist/index.js"` —— 这是发布包，下游靠编译产物 `dist/` 消费，不是源码直连。
- **编译目标**：`packages/contracts/tsconfig.json` 用 `moduleResolution:"Bundler"`、`strict:true`、`noUncheckedIndexedAccess:true`、`module:"ESNext"`、`target:"ES2022"`。相对导入必须以 `.js` 结尾（ESM 约定），如 `import type { ID } from './common.js'`（`src/message.ts:1`）。
- **无 zod**：全仓零 zod 依赖（见 [contracts-and-validation.md](contracts-and-validation.md)）。运行时校验全部手写。

## 扁平 src/ 结构

`src/` 约 50 个领域文件，**扁平无子目录**，一领域一文件：`common.ts`、`auth.ts`、`socket.ts`、`message.ts`、`task.ts`、`task-lifecycle.ts`、`pi-authority-cutover.ts`、`project-channel-workspace.ts`、`output-package.ts` 等（完整列表见 `src/index.ts`）。`tests/` 镜像同结构（`tests/<domain>-contracts.test.ts`），加 `tests/fixtures/`。

## 手工维护的桶 src/index.ts

`src/index.ts` 是**手工维护、有序**的 `export * from './<domain>.js'` 列表（共 49 行，对应 49 个领域），**无完整性测试**。新增领域文件必须手动在此追加一行：

```ts
export * from './<domain>.js';
```

注意 `.js` 后缀（ESM）。漏 export 不会在 `packages/contracts` 自测暴露 —— vitest 直接 import `../src/<domain>.js` —— 但会破坏下游 `apps/server-next` 的 tsc 构建（详见 [gotchas.md](gotchas.md) 桶幽灵导出）。

## 核心抽象

### 错误码与 Ack 原语 —— `src/common.ts`

- `ERROR_CODES` 是 `as const` 字符串数组（`src/common.ts:4`），`ErrorCode` 联合类型由 `(typeof ERROR_CODES)[number]` 派生（`:24`）。新增错误码只能往数组末尾追加，**不要改名/插队**。
- `Ack<T>` 是判别联合：`SuccessAck<T> = { ok:true } & T` 与 `FailureAck = { ok:false; error:ErrorCode; message?; details? }`（`:26-35`）。
- 工厂函数 `makeSuccess<T>(payload?)` / `makeFailure(error, message?, details?)`（`:43-58`）是构造 Ack 的唯一入口，保证 `ok` 字面量与字段散布正确。
- `isErrorCode(value): value is ErrorCode`（`:39`）用 `Set` 做 type guard，供 catch 路径收窄类型。

### Socket 命名空间 —— `src/socket.ts`

两个 `as const` 嵌套对象是 socket 事件名的唯一真相源（详见 [socket-events.md](socket-events.md)）：

- `WEB_EVENTS`（`src/socket.ts:19`）：浏览器/前端 → server，逻辑键映射到字面量如 `auth.login → 'auth:login'`。
- `AGENT_EVENTS`（`src/socket.ts:366`）：device/agent/daemon → server，如 `taskClaim.offer → 'task-claim:offer'`（`src/socket.ts:425-433`）、`workspace.revisionCommitted → 'workspace:revision-committed'`（`:443`）。

事件名字面量带冒号前缀命名空间（`auth:`、`task-claim:`、`workspace:`），与 Socket.IO room/emitter 约定对齐。`as const` 让逻辑键保留字面量类型，下游 `socket.emit(WEB_EVENTS.auth.login, ...)` 拿到精确字符串。

### 手写运行时校验器 —— 多文件

校验器集中定义在 payload 所属的领域文件里，模式统一（见 [contracts-and-validation.md](contracts-and-validation.md)）：

- `parseTaskClaimPayload` / `safeParseTaskClaimPayload`（`src/socket.ts:666`/`:712`）配私有 helper `taskClaimExact`/`taskClaimSchema`/`taskClaimStrings`/`taskClaimPositive`（`:770-781`），失败抛哨兵 `'TASK_CLAIM_PAYLOAD_INVALID'`（`:782`）。
- `parseDeviceWorkspaceSnapshot`（`src/project-channel-workspace.ts:78`）配 `exactKeys`/`asRecord`/`isId`（`:135-152`），失败抛 `'DEVICE_WORKSPACE_SNAPSHOT_INVALID'`（`:155`）。
- `pi-authority-cutover.ts` 约 25 处 `schemaVersion:1` 字面量、配 `PI_AUTHORITY_CUTOVER_PAYLOAD_INVALID` 哨兵常量（`src/pi-authority-cutover.ts:512`，约 30 处 `throw new Error(...)` 调用点）。

## 本地模式（写新代码时照搬）

1. 新领域 → 建 `src/<domain>.ts`，在 `src/index.ts` 末尾加 `export * from './<domain>.js'`。
2. 字段优先 `readonly`；ID 类型用 `ID = string`、时间戳用 `UnixMs = number`（`src/common.ts:1-2`）。
3. 相对导入以 `.js` 结尾：`import type { ID, UnixMs } from './common.js'`。
4. 跨进程 wire payload → 加 `readonly schemaVersion: 1` 字面量 + `V1` 后缀 + 配套 `parse…`/`safeParse…` 校验器。
5. 任何 `as const` 数组（错误码、命令名、枚举）→ 同文件立即派生联合类型（`(typeof X)[number]`）。

## 反模式

- **加子目录**：`src/` 是扁平的，不要建 `src/foo/bar.ts`；桶与 vitest 配置都按扁平扫描。
- **改名 `ERROR_CODES` 已有项或重排**：下游已散落 `isErrorCode` 收窄与字面量比较，重命名会静默破坏 catch 分支。
- **改用 zod**：本仓已选择手写校验器路线（精确键 + type guard + 抛哨兵），引入 zod 会破坏既有 catch 点与包体积（见 [contracts-and-validation.md](contracts-and-validation.md)）。
- **绕过 `makeSuccess`/`makeFailure` 手拼 Ack**：会漏掉 `ok` 字面量或字段散布逻辑，TS 不一定能拦住。
- **桶里加侧 effect**：`src/index.ts` 只允许 `export *`，不要在此 `import` 副作用模块。

## 佐证文件

- `packages/contracts/package.json`、`packages/contracts/tsconfig.json`、`packages/contracts/vitest.config.ts`
- `packages/contracts/src/common.ts`、`packages/contracts/src/index.ts`、`packages/contracts/src/socket.ts`、`packages/contracts/src/message.ts`
- `packages/contracts/src/project-channel-workspace.ts`、`packages/contracts/src/pi-authority-cutover.ts`

## 可靠验证命令

```bash
cd packages/contracts && npm test                    # vitest run
cd packages/contracts && npx tsc -p tsconfig.json --noEmit   # 类型 + .d.ts 自洽
# 根目录：
npm run test:contracts
```
