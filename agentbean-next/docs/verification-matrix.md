# 验证矩阵

本矩阵把 acceptance tests 转换为按 phase 设门的验证项。某个 phase 的必需 tests 未通过前，该 phase 不算完成。

测试层级：

- `Domain`：pure functions，无 DB 或 sockets。
- `Repository`：temp SQLite，无 Socket.IO。
- `UseCase`：application service，使用 fake ports/repositories 或 temp SQLite。
- `Socket`：带 Socket.IO test clients 的 server。
- `Daemon`：daemon protocol/executor tests。
- `Web`：component/client tests。
- `E2E`：server 加 test web/daemon clients，可选 browser UI。

## Phase 1：Contracts 与 Domain Core

| ID | 必需测试 | 层级 | 验证内容 | 来源文档 |
|---|---|---|---|---|
| P1-01 | `Ack<T>` success/failure shapes 可编译，并拒绝 invalid error codes。 | Domain | Shared result contract。 | `contracts-dto.md`, `socket-protocol.md` |
| P1-02 | `UserDto`, `TeamDto`, `DeviceDto`, `AgentDto`, `ChannelDto`, `MessageDto`, `DispatchDto` type fixtures 可编译。 | Domain | First-slice DTO contract。 | `contracts-dto.md` |
| P1-03 | Mention 路由到匹配的 online agent。 | Domain | Direct mention routing。 | `acceptance-tests.md`, `current-behavior.md` |
| P1-04 | Unknown mention 不会 fallback。 | Domain | 避免意外 dispatch。 | `acceptance-tests.md`, `current-behavior.md` |
| P1-05 | Human mention 不会 dispatch 给 agent。 | Domain | Human mention behavior。 | `acceptance-tests.md`, `current-behavior.md` |
| P1-06 | 无 mention 时 fallback 到第一个 eligible online agent。 | Domain | Fallback routing。 | `acceptance-tests.md`, `current-behavior.md` |
| P1-07 | No online agent 产生 non-fatal route result。 | Domain | Message send 可在无 dispatch 时持久化。 | `acceptance-tests.md`, `current-behavior.md` |
| P1-08 | Agent identity 会规范化 adapter aliases。 | Domain | Adapter canonicalization。 | `agent-identity-rules.md` |
| P1-09 | Linux path comparison 保留大小写；Windows comparison 大小写不敏感；unknown 默认大小写敏感。 | Domain | Path identity safety。 | `agent-identity-rules.md` |
| P1-10 | 同 team/device/name 下 self-register 胜过 scan-prefix duplicate。 | Domain | Canonical ID merge。 | `agent-identity-rules.md` |
| P1-11 | Custom agent 不与 scanned runtime 合并。 | Domain | Custom config identity。 | `agent-identity-rules.md` |
| P1-12 | Concrete AgentOS hosted agent 在 display 上胜过 generic gateway。 | Domain | Display precedence。 | `agent-identity-rules.md` |
| P1-13 | Same-adapter gateway instances 不合并，除非 `gatewayInstanceKey` 匹配。 | Domain | Gateway instance identity。 | `agent-identity-rules.md` |
| P1-14 | 较新的 status event 胜过较旧的 `busy`；status rank 只打破 same-batch conflict。 | Domain | Status merge ordering。 | `agent-identity-rules.md` |
| P1-15 | Published agent 在 visible teams 中保持同一 identity。 | Domain | Publication projection，无 clone。 | `agent-identity-rules.md`, `feature-disposition.md` |
| P1-16 | Private channel visibility 允许 members 并拒绝 non-members。 | Domain | Server-side visibility rule。 | `acceptance-tests.md`, `target-architecture.md` |

Phase 1 完成标准：

- 以上 tests 全部通过，且不依赖 SQLite、Socket.IO、web 或 daemon imports。
- Domain code 只导入 contracts。

## Phase 2：Server Core Slice

| ID | 必需测试 | 层级 | 验证内容 | 来源文档 |
|---|---|---|---|---|
| P2-01 | Global migrations 创建 first-slice tables 与 indexes。 | Repository | Fresh schema exists。 | `first-slice-schema-repositories.md` |
| P2-02 | Team migrations 创建 channel/message/dispatch tables 与 indexes。 | Repository | Team schema exists。 | `first-slice-schema-repositories.md` |
| P2-03 | Register user 创建 private team、owner membership、default `all` channel 与 current team。 | UseCase | Registration transaction。 | `acceptance-tests.md`, `first-slice-schema-repositories.md` |
| P2-04 | Login 在 membership 有效时恢复 saved current team。 | UseCase | Current team behavior。 | `acceptance-tests.md` |
| P2-05 | Device hello upsert device，并调和 `machineId + profileId`。 | UseCase | Agent dedupe 前的 device identity。 | `agent-identity-rules.md`, `first-slice-schema-repositories.md` |
| P2-05a | `device:list` 成功后发送 initial snapshot，daemon hello/runtimes 后刷新 subscribed sockets。 | Socket | Device subscription broadcast。 | `socket-protocol.md`, `known-gaps.md` |
| P2-05b | `device:get` 返回 device detail、runtimes 与该 device 的 visible agents，并拒绝非 team member。 | UseCase/Socket | Device detail shell。 | `socket-protocol.md`, `contracts-dto.md` |
| P2-05c | `device:scan` 校验 team membership 与 online device，并只向匹配 device 的 daemon socket 发送 `device:scan-requested`。 | UseCase/Socket/Web | Device scan routing。 | `socket-protocol.md`, `current-protocol-inventory.md` |
| P2-06 | Runtime report 替换 device 的 runtimes，并保留 normalized path keys。 | Repository/UseCase | Runtime capability model。 | `contracts-dto.md`, `agent-identity-rules.md` |
| P2-07 | Agent register batch 使用 identity links 创建/链接 canonical agents。 | UseCase | Agent dedupe persisted。 | `agent-identity-rules.md`, `first-slice-schema-repositories.md` |
| P2-08 | Missing scanned agent 变为 offline，且不删除 membership/history。 | UseCase | Missing scan behavior。 | `acceptance-tests.md`, `agent-identity-rules.md` |
| P2-09 | `listVisibleAgents` 返回 primary-team 与 published agents，且没有 clones。 | UseCase | Visibility projection。 | `agent-identity-rules.md`, `feature-disposition.md` |
| P2-09a | `agents:subscribe` 成功后发送 initial snapshot，daemon agent batch/status 变化后刷新 subscribed sockets。 | Socket | Agent subscription broadcast。 | `socket-protocol.md`, `known-gaps.md` |
| P2-10 | Public channel list 对 team member 可见。 | UseCase | Channel visibility。 | `acceptance-tests.md` |
| P2-10a | Private channel 创建时 creator 自动可见，非 member 不可见。 | UseCase | Channel creator visibility。 | `current-behavior.md`, `feature-disposition.md` |
| P2-10b | 非默认频道 settings 只允许 creator 更新。 | UseCase | Channel creator controls。 | `current-behavior.md`, `feature-disposition.md` |
| P2-10c | 默认 `all` 频道只允许 creator 更新 `title`。 | UseCase | Default channel boundary。 | `current-behavior.md`, `feature-disposition.md` |
| P2-10d | Creator 添加 human member 后 private channel 对该 member 可见。 | UseCase | Channel human membership。 | `current-behavior.md`, `feature-disposition.md` |
| P2-10e | Creator 移除 human member 后真实回收 private channel 可见性。 | UseCase | Channel human membership removal。 | `current-behavior.md`, `feature-disposition.md` |
| P2-10f | Creator 添加/移除 agent member，且 agent 必须对 team 可见。 | UseCase | Channel agent membership。 | `agent-identity-rules.md`, `feature-disposition.md` |
| P2-10g | `channel:members` 返回 human/agent member ids 与详情 DTO，并对 private channel 执行可见性检查。 | UseCase | Channel member listing。 | `socket-protocol.md`, `feature-disposition.md` |
| P2-10h | `channels:subscribe` 成功后发送 per-user snapshot，membership 变更后按订阅者重新计算并刷新 snapshot。 | Socket | Channel subscription broadcast。 | `socket-protocol.md`, `known-gaps.md` |
| P2-11 | `sendMessage` 持久化 server-derived human sender，并忽略 client sender input。 | UseCase | Sender identity。 | `acceptance-tests.md`, `contracts-dto.md` |
| P2-12 | 带 online agent 的 `sendMessage` 创建 dispatch record。 | UseCase | Dispatch first-class persistence。 | `first-slice-schema-repositories.md`, `contracts-dto.md` |
| P2-13 | 无 online agent 的 `sendMessage` 持久化 message，并返回 no-online dispatch result。 | UseCase | Non-fatal no-dispatch path。 | `acceptance-tests.md` |
| P2-14 | Dispatch timeout 将 dispatch 标记为 `timed_out`，并带有 `DISPATCH_TIMEOUT`。 | UseCase | Stable timeout error。 | `acceptance-tests.md`, `contracts-dto.md` |
| P2-15 | Dispatch result 将 dispatch 标记为 succeeded，并追加 agent message。 | UseCase | Reply persistence。 | `acceptance-tests.md` |
| P2-16 | Dispatch error 将 dispatch 标记为 failed，并更新 agent last error。 | UseCase | Error propagation。 | `acceptance-tests.md` |
| P2-17 | `/web` login/team/channel/message socket flow 只使用 documented first-slice events。 | Socket | Transport adapter thinness。 | `socket-protocol.md`, `contracts-dto.md` |
| P2-18 | `/agent` device hello/runtime/agent batch/dispatch result flow 使用 documented DTOs。 | Socket | Agent namespace contract。 | `socket-protocol.md`, `contracts-dto.md` |
| P2-19 | custom agent dispatch request 会带上 private execution config，并只投递给绑定 device 的 daemon socket。 | UseCase/Socket | Dispatch-only secret transport，不向 web snapshot 或其他 daemon 泄露 raw env。 | `contracts-dto.md`, `socket-protocol.md` |
| P2-20 | server-next 长驻 dev server 暴露 `/healthz`，并挂载真实 `/web` 与 `/agent` Socket.IO namespaces。 | Socket | 本地替换旧 server 的运行入口。 | `implementation-runbook.md`, `target-architecture.md` |
| P2-21 | server-next dev server 在 SQLite 文件模式下重启后保留注册用户、current team、channel 与 message history。 | Repository/Socket | 本地替换旧 server 的持久化入口。 | `first-slice-schema-repositories.md`, `target-architecture.md`, `production-cutover-runbook.md` |
| P2-22 | server-next 在平台提供 `PORT` 时默认监听 `0.0.0.0:$PORT`，并默认使用 SQLite storage。 | Config/Socket | 生产平台替换旧 server 的启动入口。 | `target-architecture.md`, `implementation-runbook.md` |
| P2-23 | register/login 返回 signed session token，`auth:whoami` 能用 token 恢复 user 与 current team，篡改 token 返回 `UNAUTHENTICATED`。 | UseCase/Socket | 正式 web 登录态恢复入口。 | `socket-protocol.md`, `target-architecture.md` |
| P2-24 | 平台式启动存在 `PORT` 时，server-next 必须显式配置 `AGENTBEAN_NEXT_SESSION_SECRET` 或 `--session-secret`。 | Config | 避免 production 使用 dev fallback session secret。 | `target-architecture.md`, `socket-protocol.md` |
| P2-25 | 平台式启动存在 `PORT` 且使用 SQLite storage 时，server-next 必须显式配置 `AGENTBEAN_NEXT_DATA_DIR` 或 `--data-dir`。 | Config | 避免 production 写入默认仓库目录或临时目录，导致部署重启后数据丢失。 | `target-architecture.md`, `implementation-runbook.md` |
| P2-26 | 根目录 Railway deploy config 必须显式声明 `npm run build`、`npm start` 与 `/healthz`。 | Config/CI | `AGENTBEAN_DEPLOY_TARGET=next` 时 root deploy 不依赖平台隐式推断。 | `target-architecture.md`, `implementation-runbook.md` |
| P2-27 | production readiness checker 必须能区分静态部署契约已就绪与 production flip env 未就绪。 | Config/CI | 真正替换旧 AgentBean 前，用一个可运行 preflight 明确列出缺少的生产配置。 | `target-architecture.md`, `implementation-runbook.md` |
| P2-28 | AgentBean Next CI 必须显式运行 `check:agentbean-next-readiness`，且 readiness checker 自身检查该 gate 存在。 | Config/CI | 防止部署契约检查只存在于本地命令或单测中，替换旧系统前必须进入主线 gate。 | `target-architecture.md`, `implementation-runbook.md` |
| P2-29 | production deploy job 在 `AGENTBEAN_DEPLOY_TARGET=next` 时必须先运行 `check:agentbean-next-readiness -- --production`。 | Config/CI | 防止缺少 session secret、data dir 或 deploy target 时直接执行 next production deploy。 | `target-architecture.md`, `implementation-runbook.md` |

Phase 2 完成标准：

- Server tests 使用 temp SQLite 运行。
- Socket handlers 调用 use cases，不包含 SQL 或 domain merge logic。
- 不存在 old event compatibility adapter。

## Phase 3：Daemon Protocol 与 Execution

| ID | 必需测试 | 层级 | 验证内容 | 来源文档 |
|---|---|---|---|---|
| P3-01 | Daemon protocol client 发送 `device:hello` 并处理 `Ack`。 | Daemon | Device handshake。 | `socket-protocol.md`, `contracts-dto.md` |
| P3-02 | Runtime scanner 产出包含 display command 与 normalized keys 的 `RuntimeDto`。 | Daemon | Runtime contract 与 path rules。 | `contracts-dto.md`, `agent-identity-rules.md` |
| P3-03 | Agent discovery 产出 `DiscoveredAgentDto`，并在可用时包含 gateway instance fields。 | Daemon | Gateway identity input。 | `contracts-dto.md`, `agent-identity-rules.md` |
| P3-04 | Daemon 接收 `DispatchRequestDto`，且 history 中不重复 current prompt。 | Daemon | Dispatch request contract。 | `contracts-dto.md`, `acceptance-tests.md` |
| P3-05 | Stub executor 返回 successful dispatch result。 | Daemon | Execution success path。 | `implementation-runbook.md`, `socket-protocol.md` |
| P3-06 | Stub executor 返回 dispatch error。 | Daemon | Execution failure path。 | `socket-protocol.md`, `contracts-dto.md` |
| P3-07 | Raw `customAgent.env` 只在被选中 daemon dispatch 时消费，且不记录到日志。 | Daemon | First-slice env safety。 | `contracts-dto.md` |
| P3-08 | Reconnect 会重新发送 device hello、runtimes 与 agent batch。 | Daemon | Reconnect consistency。 | `known-gaps.md`, `acceptance-tests.md` |
| P3-09 | Daemon 收到匹配当前 device 的 `device:scan-requested` 后重新扫描并上报 runtimes 与 agents；不匹配 deviceId 不触发扫描。 | Daemon | Targeted rescan command。 | `socket-protocol.md`, `current-protocol-inventory.md` |
| P3-10 | Builtin scanner 发现 known CLI runtimes，并只为 installed runtimes 生成 runtime capability，不生成 visible product agent report。 | Daemon | Runtime capability scan provider。 | `contracts-dto.md`, `agent-identity-rules.md`, `contract-alignment-handoff.md` |
| P3-11 | Daemon-next CLI 可以解析本地 device config、桥接 Socket.IO reconnect，并在 custom dispatch 中执行 server 发送的 command/args/cwd/env。 | Daemon | 真实 daemon-next 运行入口与 custom command executor。 | `implementation-runbook.md`, `contracts-dto.md` |
| P3-12 | `@agentbean/contracts` 与 `@agentbean/daemon-next` 具备 public npm package manifest，daemon-next 依赖 registry contracts 与 `socket.io-client`，CI 在 `next` 目标下先发布 contracts 再发布 daemon-next。 | Daemon/CI | 替换旧 daemon 前，用户必须能从 npm 安装 daemon-next。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-13 | CI 在 `next` 目标下基于 daemon-next 生成 canonical `@agentbean/daemon` release package，保留旧 `daemon` / `agentbean-daemon` bin，并使用高于 `0.1.35` 的版本发布。 | Daemon/CI | 替换旧 daemon npm 用户入口，而不要求用户改装另一个包名。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-14 | CI 在 build 后执行 daemon install smoke：pack `@agentbean/contracts` 与 canonical `@agentbean/daemon`，在临时空项目安装 tarball，并确认 `daemon` / `agentbean-daemon` / `agentbean-next-daemon` 三个 bin 能进入 daemon-next CLI。 | Daemon/CI | 替换旧 daemon 前，必须验证旧 npm 用户入口不是只在 manifest 上存在，而是在真实安装路径中可执行。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-15 | 本地 external cutover audit 可以只读检查 GitHub variables、GitHub secrets、production smoke URL 与 npm registry 版本，明确 production flip 前还缺哪些外部条件。 | Release/CI | 真正替换旧 AgentBean 前，必须把代码就绪、production smoke 目标 URL 与外部配置/发布状态分开验收。 | `production-cutover-runbook.md`, `target-architecture.md`, `fiftieth-slice-status.md` |
| P3-16 | 本地 full preview 对晚订阅的 web session replay 已持久化 device runtimes，并让 Custom Agent 表单按当前 device 过滤 runtime。 | Preview/Web/Server | 替换旧 AgentBean 前，本地 UI 必须能稳定看到 runtime、创建 custom agent，而不是只在协议测试里成立。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-17 | CI 可以手动发布 AgentBean Next npm packages，而不触发 Railway production deploy；production deploy 需要单独显式打开。 | Release/CI | 替换旧 AgentBean 前，应先发布 next daemon npm 用户入口，但不能因此提前替换生产后端。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-18 | CI 可以手动运行 Railway Next 只读 preflight，验证 production runtime env 与 volume 覆盖 `AGENTBEAN_NEXT_DATA_DIR`，且不触发 deploy。 | Release/CI | 替换旧 AgentBean 前，必须用生产侧证据确认 Next SQLite 数据目录落在持久化 volume 上。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-19 | CI 可以手动把 GitHub Actions 中的 Next runtime env 同步到 Railway variables，并使用 `--skip-deploys` 避免触发 deploy 或 npm publish。 | Release/CI | 替换旧 AgentBean 前，必须能补齐 Railway service variables，同时保持 final flip 仍由单独步骤控制。 | `production-cutover-runbook.md`, `target-architecture.md` |
| P3-20 | CI 的 Railway deploy step 必须给每次 `railway up` 设置命令级 timeout，避免 production deploy 因 CLI 卡住而无限等待。 | Release/CI | 替换旧 AgentBean 前，deploy、production smoke 与 rollback 都必须有可控失败边界。 | `production-cutover-runbook.md`, `fifty-first-slice-status.md` |
| P3-21 | 本地 ready-to-flip audit 可以在唯一缺口是 `AGENTBEAN_DEPLOY_TARGET=next` 时返回成功，同时严格 cutover audit 继续保持红灯。 | Release/CI | 替换旧 AgentBean 前，需要把“已经准备好等待授权”和“已经完成 final flip”分成两个不同证据。 | `production-cutover-runbook.md`, `fifty-second-slice-status.md` |
| P3-22 | CI 的 `AgentBean Next production smoke` job 必须先运行 ready-to-flip audit，再运行 public entry smoke 与 business smoke。 | Release/CI | 防止 final smoke 在 GitHub variables/secrets、production URL 或 npm registry 状态漂移时才暴露问题。 | `production-cutover-runbook.md`, `fifty-third-slice-status.md` |
| P3-23 | CI 必须阻止手动 `agentbean_deploy_target=next` 且 `run_production_deploy=true` 但未请求 `run_agentbean_next_production_smoke=true` 的 workflow dispatch；push 上 `AGENTBEAN_DEPLOY_TARGET=next` 时必须自动运行 production smoke。 | Release/CI | 真正替换旧 AgentBean 时不能只切不验。 | `production-cutover-runbook.md`, `fifty-fourth-slice-status.md` |
| P3-24 | CI 可以手动运行 `Old AgentBean production smoke`，验证 rollback 或 old-target deploy 后公开入口 `/healthz` 已恢复旧 AgentBean payload，并拒绝 AgentBean Next health payload。 | Release/CI | 真正替换旧 AgentBean 前，rollback 不能只靠手工观察，必须有可执行 smoke 证明旧系统可恢复。 | `production-cutover-runbook.md`, `fifty-fifth-slice-status.md` |
| P3-25 | CI 必须阻止手动 `agentbean_deploy_target=old` 且 `run_production_deploy=true` 但未请求 `run_agentbean_old_production_smoke=true` 的 workflow dispatch。 | Release/CI | rollback/old deploy 也不能反向只切不验。 | `production-cutover-runbook.md`, `fifty-sixth-slice-status.md` |
| P3-26 | CI 必须阻止手动 `agentbean_deploy_target=next` 且 `run_production_deploy=true`，但 repository variable `AGENTBEAN_DEPLOY_TARGET` 仍不是 `next` 的 workflow dispatch。 | Release/CI | workflow input 不能临时绕过最终生产开关；final flip 必须落在 repository variable 上，后续 push 才会保持 Next deploy 与 production smoke。 | `production-cutover-runbook.md`, `fifty-seventh-slice-status.md` |

Phase 3 完成标准：

- Daemon-next 可以通过针对 fake 或 real server-next 的 protocol tests。
- Stub executor 在迁移 real adapters 前证明 dispatch。

## Phase 4：Web Minimal Slice

| ID | 必需测试 | 层级 | 验证内容 | 来源文档 |
|---|---|---|---|---|
| P4-01 | Web API client 使用 first-slice event names 与 `Ack<T>` handling。 | Web | Client contract。 | `socket-protocol.md`, `contracts-dto.md` |
| P4-02 | Session store 只持久化 token 与 current team。 | Web | Web state ownership。 | `target-architecture.md` |
| P4-03 | Login/register screen 处理 success 与 failure ack shapes。 | Web | Auth contract。 | `contracts-dto.md` |
| P4-04 | Team shell 从 `TeamDto` 渲染 current team。 | Web | Team projection。 | `contracts-dto.md` |
| P4-05 | Device/agent status UI 渲染 server snapshots，不做 local dedupe。 | Web | Server-owned identity。 | `agent-identity-rules.md`, `target-architecture.md` |
| P4-06 | Channel list 渲染 `ChannelDto` 与 selected channel history。 | Web | Channel/message DTOs。 | `contracts-dto.md` |
| P4-07 | Message composer 按当前协议发送 `userId`、`teamId`、`channelId`、`body` 与 `clientMessageId`；不发送 `senderKind`/`senderId`。 | Web | Sender trust boundary。 | `contracts-dto.md`, `acceptance-tests.md` |
| P4-08 | Conversation 追加 `channel:message` 与 dispatch status updates。 | Web | Realtime projection。 | `socket-protocol.md` |
| P4-09 | Reconnect 会 resubscribe 并替换 snapshots，而不是 patch stale state。 | Web | Snapshot recovery。 | `known-gaps.md`, `acceptance-tests.md` |
| P4-10 | server-next dev server 托管 web-next preview 页面，页面包含 register、custom agent create、message send 三个主要操作面。 | Web/Socket | 本地可视化 preview 入口。 | `implementation-runbook.md`, `target-architecture.md` |
| P4-11 | web-next preview 保存 token，并在 reconnect/refresh 时通过 `auth:whoami` 恢复 user 与 current team；token 无效时清除本地 session。 | Web/Socket | 可视化 preview 使用服务端登录态恢复。 | `socket-protocol.md`, `target-architecture.md` |
| P4-11 | full local preview launcher 启动 SQLite server，bootstrap/login preview 用户，并把 daemon-next 连接到同一个 team。 | Web/Socket/Daemon | 一条命令启动本地替换 preview。 | `implementation-runbook.md`, `target-architecture.md` |
| P4-12 | preview 页面刷新或 Socket.IO reconnect 后恢复 session 并重新订阅 devices、agents 与 channels。 | Web | 本地 preview 会话恢复。 | `target-architecture.md`, `known-gaps.md` |
| P4-13 | web-next preview 可以通过 `channel:create` 创建 channel，刷新 channel snapshot，并在新 channel 中继续发送消息。 | Web/Socket | 本地 preview 不只依赖默认 `all` channel，开始覆盖真实产品 channel 工作流。 | `socket-protocol.md`, `target-architecture.md` |
| P4-14 | preview 内联脚本在 DOM harness 中覆盖 `auth:whoami` session restore、snapshot resubscribe、`channel:create` submit 与新 channel message selection。 | Web | 防止静态 preview 的关键交互在无浏览器测试时回退。 | `socket-protocol.md`, `known-gaps.md` |
| P4-15 | 本地 preview 第一屏必须自动进入默认 team，并呈现旧 AgentBean 风格的左侧频道、中间聊天、右侧成员/设备/runtime/custom agent 工作台。 | Web/UX | 防止把临时协议验证器误当成可替换旧 AgentBean 的产品 UI。 | `target-architecture.md`, `known-gaps.md`, `forty-fifth-slice-status.md` |

Phase 4 完成标准：

- Web-next 可以驱动针对 server-next 与 daemon-next 的 first-slice workflow。
- 没有 web feature 实现 permission、channel visibility 或 agent dedupe decisions。

## 第一条端到端 Gate

| ID | 必需测试 | 层级 | 验证内容 | 来源文档 |
|---|---|---|---|---|
| E2E-01 | Register -> daemon hello -> runtime report -> agent batch -> channel create/join -> message send -> dispatch result -> agent reply visible。 | E2E | 完整第一切片。 | `implementation-runbook.md`, `acceptance-tests.md` |
| E2E-02 | 同一流程在无 online agent 时持久化 human message，并返回 no-online dispatch result。 | E2E | Non-fatal no-agent behavior。 | `acceptance-tests.md` |
| E2E-03 | Daemon disconnect/reconnect 会刷新 device 与 agent snapshots。 | E2E | Reconnect behavior。 | `acceptance-tests.md`, `known-gaps.md` |
| E2E-04 | Register -> daemon hello -> runtime report -> `agent:create` custom agent -> message send -> dispatch result -> agent reply visible。 | E2E | 本地 AgentBean Next preview flow。 | `socket-protocol.md`, `contract-alignment-handoff.md` |
| E2E-05 | CI 在 AgentBean Next 相关路径变更时运行 readiness checks、phase tests、packages build 与 preview smoke，并阻止 deploy/publish 继续。 | CI | 替换旧系统前的持续验证 gate。 | `implementation-runbook.md`, `migration-plan.md` |
| E2E-06 | production cutover 前必须按 runbook 完成 repository variable/secret、Railway volume/env、production readiness、deploy flip、entry smoke、business smoke、production smoke workflow gate 与 rollback 验证。 | Ops/CI | 防止把本地 preview readiness 或旧 Vercel 入口误当成生产替换完成。 | `production-cutover-runbook.md`, `migration-plan.md`, `forty-sixth-slice-status.md`, `forty-seventh-slice-status.md`, `forty-ninth-slice-status.md` |

只有全部 E2E gates 通过后，第一切片才可冻结。

## 延后的验收测试

这些仍保留在 `docs/acceptance-tests.md` 中，但第一切片冻结前不强制要求：

- Device invite token delivery。
- User invite/join links。
- Artifact upload/download 与 workspace run linkage。
- Tasks。
- Message search。
- Channel archive/delete。
- Admin。
- Metrics。
- Saved messages 与 reactions。
