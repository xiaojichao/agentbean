# Socket 事件：命名空间、版本化 payload、新增流程

## 何时适用

新增浏览器↔server 或 device/agent↔server 的 socket 事件，或给已有事件加 payload/ack 形状时适用。

## 两个 `as const` 命名空间

事件名全部在 `src/socket.ts` 集中定义，是 socket 唯一真相源。**禁止散落字符串字面量到 server/daemon/web**，一律走命名空间导入。

### WEB_EVENTS —— 浏览器 → server

`src/socket.ts:19` `export const WEB_EVENTS = { … } as const;`（结束于 `:364`）。嵌套对象按领域分组，逻辑键映射到带冒号的字面量：

```ts
auth: {
  login: 'auth:login',
  register: 'auth:register',
  whoami: 'auth:whoami',
  changePassword: 'auth:change-password',
  deleteAccount: 'auth:delete-account',
},
team: { list: 'team:list', create: 'team:create', switch: 'team:switch', snapshot: 'teams:snapshot', … },
piPolicy: { get: 'pi-policy:get', update: 'pi-policy:update' },
promotion: { semanticEvaluate: 'promotion:semantic-evaluate', proposalAction: 'promotion:proposal-action', … },
piProvider: { listPresets: 'pi-provider:list-presets', … },
…
```

（`src/socket.ts:19-364`，含 `auth`/`team`/`piPolicy`/`promotion`/`piProvider`/`channel`/`message`/`task`/`memory` 等十余领域。）

### AGENT_EVENTS —— device/agent/daemon → server

`src/socket.ts:366` `export const AGENT_EVENTS = { … } as const;`（结束于 `:445`）。同样按领域分组：

```ts
device: { hello: 'device:hello', runtimes: 'device:runtimes', readFileRequested: 'device:read-file-requested', removed: 'device:removed', … },
agent: { registerBatch: 'agent:register-batch', reportDescriptor: 'agent:report-descriptor', … },
dispatch: { request: 'dispatch:request', cancel: 'dispatch:cancel', accepted: 'dispatch:accepted', result: 'dispatch:result', … },
managementWorker: { register: 'management-worker:register', leaseOffer: 'management-worker:lease-offer', … },
taskClaim: { offer: 'task-claim:offer', acquire: 'task-claim:acquire', renew: 'task-claim:renew', release: 'task-claim:release', expired: 'task-claim:expired', respond: 'task-claim:respond', relinquish: 'task-claim:relinquish' },
workspace: { revisionCommitted: 'workspace:revision-committed' },
…
```

`as const` 让 `WEB_EVENTS.auth.login` 的类型是字面量 `'auth:login'` 而非 `string`，下游 `socket.emit(WEB_EVENTS.auth.login, payload)` 拿到精确事件名与 payload 类型对齐。

## 版本化 payload map

复杂事件族不只定义事件名，还配套 payload/ack map（见 [contracts-and-validation.md](contracts-and-validation.md)）：

- **Task claim**：`TaskClaimPayloadMapV1`（`src/socket.ts:650`）聚合 11 种 claim 形状（`offer`/`acquire`/`renew`/`release`/`respond`/`relinquish`/`*-ack`/`expired`）；`parseTaskClaimPayload`/`safeParseTaskClaimPayload`（`:666`/`:712`）做运行时校验。测试 `tests/task-claim-contracts.test.ts:5-10` 断言 `AGENT_EVENTS.taskClaim` 整对象与字面量。
- **Management worker**：三个 map 分方向声明 —— `ManagementWorkerClientToServerPayloadMapV1`（`:788`，7 个事件）、`ManagementWorkerServerToClientPayloadMapV1`（`:797`，1 个 `leaseOffer`）、`ManagementWorkerSocketAckMapV1`（`:801`，6 个 ack 形状）。
- 文件注释（`src/socket.ts:784-787`）明确边界：「Device hello/Dispatch claim 仍使用各自事件，不能据此推导 management worker 可调度」—— 防止把 worker 可达性错挂到 device 在线上。

## 新增 socket 事件流程

以「给 `AGENT_EVENTS.workspace` 加一个 server→daemon 通知」为例，照搬真实 `revisionCommitted`（`src/socket.ts:440-444`）的引入路径：

1. **加事件名叶子**：在对应命名空间的对应领域对象里加一行逻辑键→字面量，保持 `as const`：
   ```ts
   workspace: {
     revisionCommitted: 'workspace:revision-committed',
     fooBar: 'workspace:foo-bar',          // 新增
   },
   ```
   字面量约定：`<领域>:<kebab-case-verb>`。
2. **加 payload DTO**（若有）：在 `src/socket.ts` 或对应领域文件（`src/project-channel-workspace.ts`、`src/management-worker.ts` 等）定义 `interface FooBarV1 { readonly schemaVersion: 1; … }`。复杂族族再加 `FooBarPayloadMapV1`。
3. **加校验器**（若 wire payload）：`parseFooBar` + `safeParseFooBar` + 哨兵 `FOO_BAR_INVALID`（见 [contracts-and-validation.md](contracts-and-validation.md)）。
4. **加 ack 形状**（若 socket.io callback ack）：归入对应 `*SocketAckMapV1` 或新建。
5. **加测试** `tests/<domain>-contracts.test.ts`：断言事件名常量、payload 形状、未知键/错误 schemaVersion 抛哨兵。
6. **同步消费方**：`apps/server-next` 的 socket 注册中心与 `apps/daemon-next`/`apps/web-next` 的事件清单必须同步引入新常量。本仓教训：**新 socket 事件不同步 server/daemon 测试清单会让 CI 假绿**（feedback 记忆 `agentbean-issue-1022-agent-exposure-descriptor-scan.md` 记录「新 socket 事件必同步测试清单」）。

## 本地模式

- 浏览器事件 → `WEB_EVENTS`；device/agent/daemon 事件 → `AGENT_EVENTS`。不要混。
- 字面量用 kebab-case 动词：`team:list`、`promotion:proposal-action`、`workspace:revision-committed`、`task-claim:offer`。
- 注释写方向（`// 服务端→daemon 单向通知`）与触发场景，参考 `src/socket.ts:382-386,440-444`。
- payload 走 `schemaVersion: 1` + `V1` 后缀；事件族上 `*PayloadMapV1`。

## 反模式

- **散落字面量 `'task-claim:offer'` 到 server/daemon**：必须 `import { AGENT_EVENTS } from '@agentbean/contracts'` 走常量，否则重命名静默漂移。
- **给 `WEB_EVENTS`/`AGENT_EVENTS` 去掉 `as const`**：会丢失字面量类型，`socket.emit` 的 overload 对齐失效。
- **新增事件不加 payload/ack DTO**：靠 `any` 传 payload 等于放弃类型面，下游会自己造重复 interface 导致漂移。
- **新增事件不加测试断言常量**：事件名 typo（如 `taskClaim.ofefr`）不会被静态检查抓到，必须 `expect(AGENT_EVENTS.taskClaim).toEqual({…})`（参考 `tests/task-claim-contracts.test.ts:5-10`）。
- **忘了同步下游测试清单**：contracts 包测过 ≠ server/daemon 已接线。

## 佐证文件

- `packages/contracts/src/socket.ts`（`:19-364` WEB_EVENTS、`:366-445` AGENT_EVENTS、`:642-662` payload map、`:666-721` 校验器、`:784-808` management worker 三 map）
- `packages/contracts/tests/task-claim-contracts.test.ts`（事件名断言范式）
- 根 `package.json:13`（`test:contracts` 入口）

## 可靠验证命令

```bash
cd packages/contracts && npm test
# 事件契约专项：
cd packages/contracts && npx vitest run tests/task-claim-contracts.test.ts tests/management-worker-contracts.test.ts
# 全链（验证下游接线，CI 入口）：
npm run test:packages
```
