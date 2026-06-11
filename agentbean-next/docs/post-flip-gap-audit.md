# AgentBean Next post-flip gap audit

本文承接 GitHub issue #140，用于记录 AgentBean Next final flip 之后的生产观察证据，以及对照旧 AgentBean 主线后的能力分级。

## 审计时间

- 日期：2026-06-08
- 生产入口：`https://api.agentbean.dev/`
- 当前目标：判断 Next 是否达到替代旧 AgentBean 的产品完成度，而不是继续证明 final flip 能否执行。

## 生产观察证据

### 已验证

- Final flip 已生效：`npm run audit:agentbean-next-cutover -- --json` 通过，结果为 `ok: true`，`11/11` checks passed，且 `pendingFinalFlip: false`。
- 生产入口 smoke 通过：`npm run smoke:agentbean-next-entry -- --url https://api.agentbean.dev` 通过 `4/4`，覆盖 `/healthz`、根页面、Socket.IO client assets。
- 生产业务 smoke 通过：`npm run smoke:agentbean-next-business -- --url https://api.agentbean.dev` 通过 `8/8`，覆盖 web/daemon socket 连接、注册/登录、daemon hello、runtime 上报、custom agent 创建、message dispatch、agent reply 可见。
- GitHub Actions post-flip 复验通过：CI/CD run `27120700026` 为 `success`，其中 `AgentBean Next production smoke` job 运行 strict cutover audit、public entry smoke、business smoke，均为 success。
- Railway env / volume preflight 有切换前证据：CI/CD run `27067398886` 中 `Railway Next env sync` 为 success，包含 production readiness checks、Railway env sync 和 Railway preflight。

### 仍需继续观察

- Railway production volume 的真实重启后数据保留仍需 post-flip 观察证据。现有证据证明 `/data/agentbean-next` 配置和 preflight 通过，但还没有把 final flip 后的真实生产重启、重新访问、跨 session 数据保留记录到 #140。
- 浏览器手工观察已在 #138 记录过一次，但 #140 的 24-72 小时窗口仍应继续记录 session 恢复、刷新、重新打开后的表现。
- Railway runtime logs 与生产 socket/API 错误日志需要在观察窗口内追加记录。当前 smoke 证明业务链路可用，不等价于 24-72 小时无错误日志。
- Old target rollback 路径和 old entry smoke 保留，但当前公开入口已经是 Next；old entry smoke 应在 rollback/old deploy 演练时运行，不能直接拿当前入口证明旧服务仍在提供流量。

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

1. Production volume 重启持久化证据。
   - 目标：记录 final flip 后生产重启、重新访问、跨 session 后 user/team/channel/message/device/runtime/agent 状态是否保留。
   - 参考：`scripts/smoke-agentbean-next-persistence.mjs`、`agentbean-next/docs/production-cutover-runbook.md`

2. Team create/switch 与 invite/onboarding。
   - 目标：补齐多 team 创建/切换、user invite、device invite/token delivery，恢复旧 AgentBean 的真实 onboarding 链路。
   - 参考：`packages/contracts/src/socket.ts`、`agentbean-next/docs/feature-disposition.md`、`agentbean-next/docs/acceptance-tests.md`

3. Dispatch lifecycle 完整化。
   - 目标：实现 `dispatch:cancel`，并让 `failTimedOutDispatches` 在 server-next runtime 中被调度，而不是只存在 use case/test。
   - 参考：`packages/contracts/src/socket.ts`、`apps/server-next/src/application/usecases.ts`、`apps/server-next/src/dev-server.ts`、`apps/daemon-next/src/index.ts`

4. DM/thread、artifacts/workspace runs、tasks/search。
   - 目标：按产品优先级恢复旧 AgentBean 的协作长尾能力；其中 artifacts/workspace runs 影响 agent 输出可追溯性，tasks/search 更偏第二轮产品完整度。
   - 参考：`agentbean-next/docs/current-behavior.md`、`agentbean-next/docs/known-gaps.md`、`agentbean-next/docs/acceptance-tests.md`

5. 真正浏览器级 E2E。
   - 目标：覆盖生产或 staging 上的登录/session 恢复、刷新重订阅、custom agent 创建、消息发送、agent reply 可见，避免只依赖 DOM harness 和 socket smoke。
   - 参考：`agentbean-next/docs/verification-matrix.md`、`apps/web-next/tests/preview-page.test.ts`

## 已拆分 follow-up issues

已优先拆成小 issue，不在 #140 中堆实现细节：

1. #141 `补充 AgentBean Next production volume 重启持久化观察`
2. #142 `为 AgentBean Next 引入 authenticated socket session`
3. #143 `补齐 AgentBean Next team 切换与 invite onboarding`
4. #144 `补齐 AgentBean Next dispatch cancel 与 timeout 调度`
5. #145 `补齐 AgentBean Next agent publish/config/delete 管理面`
6. #146 `定义并实现 AgentBean Next artifacts 与 workspace runs 第一版`
   - 状态：server-next DTO/schema/repository/usecase 第一版已落地；HTTP upload/download/preview route 与 workspace run UI 仍作为后续 API/UI 接入项。
7. #147 `定义 AgentBean Next DM/thread 第一版数据模型与协议`
8. #148 `补齐 AgentBean Next 浏览器级 E2E smoke`

## 当前结论

AgentBean Next 已经能替代旧 AgentBean 的最小生产入口和核心 chat/daemon/custom-agent 业务闭环。要把判断提升到“可以长期替代旧 AgentBean”，下一步不应继续混合在 final flip 议题里，而应按上面的必须补齐项拆 issue/PR，并在 #140 里持续记录 24-72 小时生产观察证据。
