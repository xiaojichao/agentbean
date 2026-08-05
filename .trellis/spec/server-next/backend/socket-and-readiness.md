# socket 绑定与 readiness 剥离链

## 何时适用

新增/重命名 socket 事件、加新 transport（如 management-worker / server-worker）、或遇到 CI `phase-0-management-boundary-regression` 红灯时。

## 本地模式

### bind()：统一事件绑定

所有 `/web` 命名空间的事件 handler 通过 `bind()` 统一注册（`src/transport/socket-handlers.ts:1257-1264`）：

签名：`bind(socket, event, app, methodName, afterResult?, options?)`

- `socket.on(event)` 收到 payload（:1265）。
- `withAuthenticatedUserId` 注入鉴权（:1268，可用 `options.augmentInput` 增强，:1269）。
- 调 `app[methodName]`（:1267/:1270），`ack?.(result)` 回传（:1271）。
- 可选 `afterResult` 钩子在 ack 后跑（:1272，如投影刷新）。
- 异常走 `socketErrorAck`（:1274）。

绑定规模：`socket-handlers.ts` 中 **201 处 `bind(` 调用**，首个在 `:253`（`bind(socket, WEB_EVENTS.auth.register, app, 'registerUser');`）。事件名集中在 `packages/contracts/src/socket.ts`（`WEB_EVENTS` / `AGENT_EVENTS`）。

新增事件 = 在 contracts 加事件名 + 在 `socket-handlers.ts` 加一行 `bind(...)`。

### readiness 剥离链（新增 transport 事件必读）

`scripts/check-agentbean-next-readiness.mjs` 守护 Phase 0 direct Dispatch 边界。其中 `hasPhase0ManagementBoundary`（:894）把 contracts 源码中属于 management 子系统的引号串与 import **剥离**后再比对边界：

剥离链（:919-:924）：

- `management-worker:[a-z-]+`（:919，前面 :906-:916 是显式列表 + 正则兜底）
- `management-policy:[a-z-]+`（:921）
- `task-claim:[a-z-]+`（:922）
- `server-worker:[a-z-]+`（:923）
- `from './management-worker.js'`（:924）
- 注释（:926）：不改变 Phase 0 direct Dispatch 边界（与 management-worker 同等豁免）

**铁律**：新增任何含 `management-worker:` / `management-policy:` / `task-claim:` / `server-worker:` 前缀的 `AGENT_EVENTS.<transport>` 事件，**必须**确认该前缀已被剥离链覆盖。否则 `hasPhase0ManagementBoundary` 会把新事件算进 direct Dispatch 边界，CI `phase-0-management-boundary-regression` 直接红（PR#633 事故）。若是新前缀（如 `checkpoint:`），必须在 :919-:924 扩展剥离正则。

### 三个命名空间的绑定入口

- `/web`：`src/transport/socket-server.ts:280`（`server.of('/web').on('connection', ...)`），web 端事件在此挂 `bind()`。
- `/agent`：`src/transport/socket-server.ts:119`。
- `/server-worker`：`src/transport/socket-server.ts:155-156`，受 `serverWorkerTokenMatches` 鉴权（:159）。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/transport/socket-handlers.ts`（:1257-1264 bind 签名、:253 首个绑定、201 处调用）
- `/Users/shaw/AgentBean/apps/server-next/src/transport/socket-server.ts`（:119 /agent、:155-159 /server-worker、:280 /web）
- `/Users/shaw/AgentBean/packages/contracts/src/socket.ts`（事件名集中处）
- `/Users/shaw/AgentBean/scripts/check-agentbean-next-readiness.mjs`（:894 hasPhase0ManagementBoundary、:906-:924 剥离链）
- `/Users/shaw/AgentBean/apps/server-next/tests/phase-0-management-boundary.test.ts`（边界回归测试）

## 反模式

- **直接 `socket.on(event, ...)` 而不用 `bind()`**：丢失鉴权注入与统一错误处理。
- **加 `AGENT_EVENTS.<transport>` 新前缀不扩剥离链**：CI 边界回归红（PR#633）。
- **事件名硬编码在 handler 文件**：必须走 `packages/contracts/src/socket.ts`。
- **改完绑定不跑 readiness**：本地秒挂。

## 验证命令

```bash
cd /Users/shaw/AgentBean
# readiness 边界检查（提 PR 前必跑）
node scripts/check-agentbean-next-readiness.mjs
# 边界回归测试
npm run test:phase0-boundary
# server-next 单包（含 socket 集成）
npm run test:server-next
# 数绑定规模
grep -c "bind(" apps/server-next/src/transport/socket-handlers.ts
```
