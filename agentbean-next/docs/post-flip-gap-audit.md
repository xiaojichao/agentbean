# AgentBean Next post-flip gap audit

本文承接 GitHub issue #140，用于记录 AgentBean Next final flip 之后的生产观察证据，以及对照旧 AgentBean 主线后的能力分级。

## 审计时间

- 日期：2026-06-08
- 生产入口：`https://api.agentbean.dev/`
- 当前目标：判断 Next 是否达到替代旧 AgentBean 的产品完成度，而不是继续证明 final flip 能否执行。
- 2026-06-15 复核：#140 与 #141 已 completed 关闭；strict cutover audit、entry smoke 与 business smoke 当前仍通过。

## 生产观察证据

### 已验证

- Final flip 已生效：`npm run audit:agentbean-next-cutover -- --json` 通过，结果为 `ok: true`，`11/11` checks passed，且 `pendingFinalFlip: false`。
- 生产入口 smoke 通过：`npm run smoke:agentbean-next-entry -- --url https://api.agentbean.dev` 通过 `4/4`，覆盖 `/healthz`、根页面、Socket.IO client assets。
- 生产业务 smoke 通过：`npm run smoke:agentbean-next-business -- --url https://api.agentbean.dev` 通过 `8/8`，覆盖 web/daemon socket 连接、注册/登录、daemon hello、runtime 上报、custom agent 创建、message dispatch、agent reply 可见。
- GitHub Actions post-flip 复验通过：CI/CD run `27120700026` 为 `success`，其中 `AgentBean Next production smoke` job 运行 strict cutover audit、public entry smoke、business smoke，均为 success。
- Railway env / volume preflight 有切换前证据：CI/CD run `27067398886` 中 `Railway Next env sync` 为 success，包含 production readiness checks、Railway env sync 和 Railway preflight。
- Production volume 重部署持久化观察已通过 #141 关闭：生产写入 marker message 后执行受控 Railway Next 重部署，同账号重登读取 channel history，确认 marker message 仍存在。
- 2026-06-15 当前生产复核通过：
  - `npm run audit:agentbean-next-cutover -- --json`：`ok: true`，`11/11`，`pendingFinalFlip: false`。
  - `npm run smoke:agentbean-next-entry -- --url https://api.agentbean.dev`：`4/4`。
  - `npm run smoke:agentbean-next-business -- --url https://api.agentbean.dev`：`8/8`。

### 仍需继续观察

- #140 的 24-72 小时生产观察 baseline 已完成并关闭；后续 production logs、socket/API 错误、浏览器手工观察应随 deploy、incident 或 rollback drill 追加到新的运维记录。
- Old target rollback 路径和 old entry smoke 保留；当前公开入口已经是 Next，old entry smoke 应在 rollback/old deploy 演练时运行，不能直接拿当前入口证明旧服务仍在提供流量。

## 能力分级

### 已完成

- 生产切换与 gate：`AGENTBEAN_DEPLOY_TARGET=next` 生效，strict cutover audit、public entry smoke、business smoke 已通过。
  - 参考：`scripts/audit-agentbean-next-cutover.mjs`、`scripts/smoke-agentbean-next-entry.mjs`、`scripts/smoke-agentbean-next-business.mjs`、`.github/workflows/ci-cd.yml`
- 核心协作链路：注册/登录、current team、channel join/history、message send、dispatch request/result/error、agent reply 持久化和广播已具备。
  - 参考：`apps/server-next/src/application/usecases.ts`、`apps/server-next/src/transport/socket-handlers.ts`、`apps/server-next/src/transport/socket-server.ts`
- Device/runtime/custom agent 主链路：daemon hello、runtime capability 上报、device snapshot、custom agent 创建、dispatch-only secret transport 已具备。
  - 参考：`apps/daemon-next/src/index.ts`、`apps/daemon-next/src/scanner.ts`、`apps/daemon-next/src/executor.ts`
- SQLite 基础持久化与生产启动 guard：server-next 在平台 `PORT` 下强制 session secret 和 data dir，SQLite schema/repository 已覆盖 first slice。
  - 参考：`apps/server-next/src/dev-server.ts`、`apps/server-next/src/infra/sqlite/repositories.ts`
- 契约对齐：`Ack<T>`、核心 DTO、runtime capability fields、canonical dispatch status、scanner 不自动生成 visible agent 已对齐。
  - 参考：`packages/contracts/src`、`agentbean-next/docs/contract-alignment-handoff.md`
- 验证体系：phase tests、build、daemon install smoke、preview smoke、production smoke、rollback smoke guard、runbook 已形成主线 gate。
  - 参考：`agentbean-next/docs/verification-matrix.md`、`agentbean-next/docs/production-cutover-runbook.md`

### 第一版可接受

- Web 入口仍是 `web-next` preview shell，不是完整 Next.js App Router 产品界面。它已能支撑 core workflow，但任务、成员详情、设备详情、设置等旧版页面仍未迁入。
  - 参考：`apps/web-next/preview/index.html`、`agentbean-next/docs/forty-second-slice-status.md`
- `message:send`、`channel:join` 等 web socket payload 仍显式携带 `teamId`。`userId` 已可由 authenticated socket session 派生，显式 `userId` 仅作为兼容路径保留；后续 team switch 完成后再评估 current team 派生。
  - 参考：`apps/server-next/src/transport/socket-handlers.ts`、`apps/server-next/src/transport/socket-server.ts`
- `customAgent.env` 不进入 web snapshot，但仍在 dispatch request 中以 raw env 发送给被选中的 daemon。第一版可接受，后续应改为 secret reference 或 daemon-local storage。
  - 参考：`apps/server-next/src/application/usecases.ts`、`agentbean-next/docs/contracts-dto.md`
- Agent 管理面已补齐第一版：`agent:publish` / `agent:unpublish` 影响 target team visible projection，`agent:update-config` 只允许 custom agent 并只向 web 暴露 `envKeys`，`agent:delete` 使用 server-side tombstone 隐藏 agent 且保留既有 message/dispatch 历史。
  - 参考：`packages/contracts/src/agent.ts`、`apps/server-next/src/application/usecases.ts`、`agentbean-next/docs/socket-protocol.md`
- Old target rollback 路径与 old entry smoke 已保留。当前状态可接受，但真正替代旧版前建议至少做一次受控 rollback 演练或记录不演练的原因。
  - 参考：`scripts/smoke-agentbean-old-entry.mjs`、`agentbean-next/docs/fifty-fifth-slice-status.md`

### 必须补齐

以下是 2026-06-08 审计时的原始缺口分组。2026-06-12 后的 follow-up 收敛状态以 `post-flip-follow-up-status.md` 为准。

1. Production volume 重启持久化证据。
   - 目标：记录 final flip 后生产重启、重新访问、跨 session 后 user/team/channel/message/device/runtime/agent 状态是否保留。
   - 收敛：#141 已关闭，已记录生产 marker message 在受控 Railway Next 重部署后仍可从 channel history 读取；2026-06-15 当前 strict cutover audit、entry smoke 与 business smoke 仍通过。
   - 参考：`scripts/smoke-agentbean-next-persistence.mjs`、`agentbean-next/docs/production-cutover-runbook.md`

2. Team create/switch 与 invite/onboarding 第一版。
   - 目标：补齐多 team 创建/切换、user invite、device invite/token delivery，恢复旧 AgentBean 的真实 onboarding 链路。
   - 收敛：`team:create`、`team:switch`、`join:create`、`join:validate`、auth `joinCode` 消费与 `device-invite:*` 第一版的 contracts、use cases 与 tests 已进入主线。
   - 收敛：`join:list` 与 `join:revoke` 的协议层（contracts 常量、server-next handler、usecase、memory/sqlite repository）已由 #267 进入主线。
   - 剩余：web-next 客户端 list/revoke 绑定、invite management UI/UX 与完整 onboarding parity 仍需后续产品切片覆盖。
   - 参考：`packages/contracts/src/socket.ts`、`agentbean-next/docs/feature-disposition.md`、`agentbean-next/docs/acceptance-tests.md`

3. Dispatch lifecycle 第一版。
   - 目标：实现 `dispatch:cancel`，并让 `failTimedOutDispatches` 在 server-next runtime 中被调度，而不是只存在 use case/test。
   - 收敛：`dispatch:cancel`、daemon cancel handling 与 server-next timeout scheduler 已进入主线。
   - 参考：`packages/contracts/src/socket.ts`、`apps/server-next/src/application/usecases.ts`、`apps/server-next/src/dev-server.ts`、`apps/daemon-next/src/index.ts`

4. DM/thread、artifacts/workspace runs、tasks/search。
   - 目标：按产品优先级恢复旧 AgentBean 的协作长尾能力；其中 artifacts/workspace runs 影响 agent 输出可追溯性，tasks 与更完整 search 更偏第二轮产品完整度。
   - 收敛：DM/thread 第一版、artifacts/workspace runs metadata 第一版、HTTP upload/download/preview route、web artifact viewer、message search 第一版、tasks 第一版与 tasks browser smoke 已进入主线；完整 task page 与更完整 search 仍需后续切片。
   - 参考：`agentbean-next/docs/current-behavior.md`、`agentbean-next/docs/known-gaps.md`、`agentbean-next/docs/acceptance-tests.md`

5. 真正浏览器级 E2E 第一版。
   - 目标：覆盖生产或 staging 上的登录/session 恢复、刷新重订阅、custom agent 创建、消息发送、agent reply 可见，避免只依赖 DOM harness 和 socket smoke。
   - 收敛：`npm run smoke:agentbean-next-browser` 已进入 CI，覆盖真实 Chrome 路径、artifact upload/viewer 与 task create/status update/refresh restore，并上传 console/screenshot artifacts。
   - 参考：`agentbean-next/docs/verification-matrix.md`、`apps/web-next/tests/preview-page.test.ts`

## 已拆分 follow-up issues

已优先拆成小 issue，不在 #140 中堆实现细节。2026-06-12 核对时 open issues 与 open PR 均为空，以下条目应视为历史 follow-up 索引，而不是当前活跃 backlog：

1. #141 `补充 AgentBean Next production volume 重启持久化观察`
2. #142 `为 AgentBean Next 引入 authenticated socket session`
3. #143 `补齐 AgentBean Next team 切换与 invite onboarding`
4. #144 `补齐 AgentBean Next dispatch cancel 与 timeout 调度`
5. #145 `补齐 AgentBean Next agent publish/config/delete 管理面`
6. #146 `定义并实现 AgentBean Next artifacts 与 workspace runs 第一版`
   - 状态：server-next DTO/schema/repository/usecase 第一版已落地；HTTP upload/download/preview route 与 workspace run UI 仍作为后续 API/UI 接入项。
7. #147 `定义 AgentBean Next DM/thread 第一版数据模型与协议`
8. #148 `补齐 AgentBean Next 浏览器级 E2E smoke`

当前活跃路线图见 `post-flip-follow-up-status.md`。其中 #140/#141 已完成关闭，不应继续作为活跃 blocker。

## 当前结论

AgentBean Next 已经能替代旧 AgentBean 的最小生产入口和核心 chat/daemon/custom-agent 业务闭环。#140/#141 的 post-flip 生产观察 baseline 已完成；下一步不应继续混合在 final flip 议题里，也不应再直接照旧 #141-#148 清单挑项。应按 `post-flip-follow-up-status.md` 的当前状态开新的 scoped issue/PR，优先推进更完整的 workspace run 专用页面/日志体验、admin/audit 产品面、settings/device 后续页等产品切片。
