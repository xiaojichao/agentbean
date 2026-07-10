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
| P2-04a | `join:create` 只允许 team member 创建 user join link，`join:validate` 可匿名返回目标 team display info，并区分无效、过期、已耗尽 code。 | UseCase/Socket | User join link 最小模型。 | `socket-protocol.md`, `contracts-dto.md`, `acceptance-tests.md` |
| P2-04b | `auth:register` 与 `auth:login` 提供 `joinCode` 时会加入受邀 team、消费 code，并把 current team 切换到受邀 team。 | UseCase/Socket | User invite/join flow 与 current team 持久化。 | `socket-protocol.md`, `acceptance-tests.md` |
| P2-04c | `device-invite:create` 只允许 team member 创建 device invite，`device-invite:wait` 记录等待 daemon，`device-invite:complete` 生成 credentials 并投递给等待 socket。 | UseCase/Socket/Daemon | Device invite + daemon onboarding 最小模型。 | `socket-protocol.md`, `contracts-dto.md`, `acceptance-tests.md` |
| P2-05 | Device hello upsert device，并调和 `machineId + profileId`。 | UseCase | Agent dedupe 前的 device identity。 | `agent-identity-rules.md`, `first-slice-schema-repositories.md` |
| P2-05a | `device:list` 成功后发送 initial snapshot，daemon hello/runtimes 后刷新 subscribed sockets。 | Socket | Device subscription broadcast。 | `socket-protocol.md`, `known-gaps.md` |
| P2-05b | `device:get` 返回 device detail、runtimes 与该 device 的 visible agents，并拒绝非 team member。 | UseCase/Socket | Device detail shell。 | `socket-protocol.md`, `contracts-dto.md` |
| P2-05c | `device:scan` 校验 team membership 与 online device，并只向匹配 device 的 daemon socket 发送 `device:scan-requested`。 | UseCase/Socket/Web | Device scan routing。 | `socket-protocol.md`, `current-protocol-inventory.md` |
| P2-06 | Runtime report 替换 device 的 runtimes，并保留 normalized path keys。 | Repository/UseCase | Runtime capability model。 | `contracts-dto.md`, `agent-identity-rules.md` |
| P2-07 | Agent register batch 使用 identity links 创建/链接 canonical agents。 | UseCase | Agent dedupe persisted。 | `agent-identity-rules.md`, `first-slice-schema-repositories.md` |
| P2-08 | Missing scanned agent 变为 offline，且不删除 membership/history。 | UseCase | Missing scan behavior。 | `acceptance-tests.md`, `agent-identity-rules.md` |
| P2-09 | `listVisibleAgents` 返回 primary-team 与 published agents，且没有 clones。 | UseCase | Visibility projection。 | `agent-identity-rules.md`, `feature-disposition.md` |
| P2-09a | `agents:subscribe` 成功后发送 initial snapshot，daemon agent batch/status 变化后刷新 subscribed sockets。 | Socket | Agent subscription broadcast。 | `socket-protocol.md`, `known-gaps.md` |
| P2-09b | `members:list` 返回 team human members 与当前 team 可见 agents，至少覆盖 scanned AgentOS agent 与 custom agent。 | UseCase/Socket | 成员页智能体成员不能退回 `agents: []`，也不能只依赖 `agents:subscribe` 或 `device:agents:list`。 | `socket-protocol.md`, `current-protocol-inventory.md`, `post-flip-follow-up-status.md` |
| P2-09c | `members:list`、`device:agents:list`、`agents:subscribe` 与 `channel:members` 分别按成员页、设备管理页、全局 agent snapshot 与频道成员语义验收，不能用其中一个接口的通过替代另一个。 | UseCase/Socket | 防止已迁移产品入口只按模块/API 名称验收，遗漏页面语义聚合。 | `socket-protocol.md`, `current-protocol-inventory.md`, `post-flip-follow-up-status.md` |
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
| P2-15a | Dispatch result 可以上报 artifact metadata 与 workspace run metadata，agent reply 投影 `MessageDto.artifacts` / `MessageDto.workspaceRun`，同 team 可读取 artifact，跨 team 返回 `NOT_FOUND`。 | Repository/UseCase | Agent output 可追溯性与 team-scoped artifact authorization 第一版。 | `contracts-dto.md`, `post-flip-gap-audit.md` |
| P2-15b | server-next HTTP route 支持 team-scoped artifact JSON/multipart upload、preview 与 download，并拒绝非 team member token。 | HTTP/UseCase | Artifact file bytes 接入 repository 授权与 SQLite data dir。 | `known-gaps.md`, `fifty-ninth-slice-status.md`, `sixty-third-slice-status.md` |
| P2-15c | `sendMessage` 可以把当前用户上传、同 team/channel 的 upload artifact ids 绑定到 human message，并在 `MessageDto.artifacts` 中投影。 | UseCase | Composer 上传的 artifact 不只停在独立 metadata，而是能随消息进入 conversation。 | `known-gaps.md`, `sixtieth-slice-status.md` |
| P2-15d | server-next HTTP route 支持按 session token 读取 workspace run detail，并返回该 run 的 artifact projection，非 team/channel 可见用户不能读取。 | HTTP/UseCase | Workspace run detail 不能只依赖消息内联投影，可分享入口需要有独立授权数据源。 | `known-gaps.md`, `sixty-sixth-slice-status.md` |
| P2-15e | `message:search` 使用 server-side simple DB search，并返回当前用户可见的普通 channels 与 DM 的匹配消息（DM 遵守 agent 可见性规则）。 | UseCase/Socket | Message search 不能由 web 本地过滤，也不能泄漏 private channel 或已隐藏 agent DM 的内容。 | `known-gaps.md`, `sixty-seventh-slice-status.md` |
| P2-15f | `task:list`、`task:create` 与 `task:update` 使用 server-side task model，并只暴露当前用户可见 channel/DM 关联 tasks。 | UseCase/Socket | Tasks 不能继续只存在旧 stack；private channel task 不能泄漏给非 channel member。 | `known-gaps.md`, `sixty-eighth-slice-status.md` |
| P2-15g | `message:react`、`message:save` 与 `message:list-saved` 使用 server-side SQLite/memory repositories，并由 fresh team migrations 创建对应 tables。 | Repository/UseCase/Socket | Saved/reaction 不能只停在 web local state；生产 fresh SQLite DB 必须具备持久化表。 | `known-gaps.md`, `first-slice-schema-repositories.md` |
| P2-15h | Daemon 上报 workspace run command 后，server-next SQLite/memory repositories、detail API 与 apps/web run 专页都保留并展示该 display command。 | Repository/UseCase/Web | Workspace run 详情不能只展示输出文件；替换旧版前需要能回看一次运行的执行入口。 | `contracts-dto.md`, `known-gaps.md`, `post-flip-follow-up-status.md` |
| P2-15i | Daemon 上报 workspace run `logExcerpt` 后，server-next 保存长度受限、基础脱敏后的尾部摘要，并由 detail API 与 apps/web run 专页展示。 | Repository/UseCase/Web | 替换旧版前需要能回看运行失败的关键日志片段，同时不能无界保存日志或直接暴露常见 secret assignment。 | `contracts-dto.md`, `known-gaps.md`, `post-flip-follow-up-status.md` |
| P2-16 | Dispatch error 将 dispatch 标记为 failed，并更新 agent last error。 | UseCase | Error propagation。 | `acceptance-tests.md` |
| P2-17 | `/web` login/team/channel/message socket flow 只使用 documented first-slice events。 | Socket | Transport adapter thinness。 | `socket-protocol.md`, `contracts-dto.md` |
| P2-18 | `/agent` device hello/runtime/agent batch/dispatch result flow 使用 documented DTOs。 | Socket | Agent namespace contract。 | `socket-protocol.md`, `contracts-dto.md` |
| P2-19 | custom agent dispatch request 会带上 private execution config，并只投递给绑定 device 的 daemon socket。 | UseCase/Socket | Dispatch-only secret transport，不向 web snapshot 或其他 daemon 泄露 raw env。 | `contracts-dto.md`, `socket-protocol.md` |
| P2-19a | `agent:publish` / `agent:unpublish` / `agent:update-config` / `agent:delete` 遵守 owner/admin 权限、visible projection、envKeys-only snapshot 与 custom-agent tombstone 删除语义。 | UseCase/Socket/Web | Agent 管理面第一版；删除不重写既有 message/dispatch 历史。 | `contracts-dto.md`, `socket-protocol.md`, `feature-disposition.md` |
| P2-20 | server-next 长驻 dev server 暴露 `/healthz`，并挂载真实 `/web` 与 `/agent` Socket.IO namespaces。 | Socket | 本地替换旧 server 的运行入口。 | `implementation-runbook.md`, `target-architecture.md` |
| P2-21 | server-next dev server 在 SQLite 文件模式下重启后保留注册用户、current team、channel 与 message history。 | Repository/Socket | 本地替换旧 server 的持久化入口。 | `first-slice-schema-repositories.md`, `target-architecture.md`, `production-cutover-runbook.md` |
| P2-21a | Web Next dashboard admin lists (`admin:list-teams`/users/devices/agents) 与 `admin:transfer-device-owner` 必须由 server-next 提供，并只允许全局 admin 调用；设备与 Agent 列表需包含团队名、用户名、设备名、公开/可见 Agent 归属字段。 | UseCase/Socket/Web | 已迁移 dashboard 不能只保留页面文件；旧版已有的 admin dashboard lists 与设备 owner 转移语义要有 server-next 回归测试和 readiness gate。 | `socket-protocol.md`, `post-flip-follow-up-status.md` |
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
| P3-11a | Daemon-next custom command executor 返回结构化 dispatch result，包含 body、workspace run display command、cwd、exitCode、started/completed timing 与脱敏后的日志摘要，并由 protocol client 上报到 `dispatch:result.workspaceRun`。 | Daemon/Socket | Workspace run command/log/timing 不能只停在 server 接收能力，真实 daemon 执行路径必须产生这些 metadata。 | `contracts-dto.md`, `known-gaps.md` |
| P3-11b | Daemon-next CLI 支持在不打开 socket 的情况下列出、清理、重命名本地 saved auth profiles，并且 profile rename 不覆盖已有目标 profile。 | Daemon/CLI | Daemon onboarding 不是只完成首次 invite；用户必须能安全管理已保存 profile，避免 stale profile 阻塞重新 onboarding 或 `--all-profiles`。 | `parity-backfill-audit.md`, `apps/daemon-next/tests/auth-store.test.ts`, `apps/daemon-next/tests/cli.test.ts` |
| P3-11c | Daemon-next 在初次 `device:hello` 与 Socket.IO reconnect 的 hello ack 中接收 server 续签 device credentials，并把刷新后的 token 持久化回当前 saved auth profile。 | Daemon/CLI | 首次 invite token 不是长期运行凭据；daemon restart 必须使用 server 续签后的 device-bound token，避免 stale invite token 让 custom agent env/artifact 路径失效。 | `apps/daemon-next/tests/protocol-client.test.ts`, `apps/daemon-next/tests/cli.test.ts`, `apps/server-next/tests/first-slice.test.ts` |
| P3-11d | Daemon-next 设备接入生命周期同时覆盖 invite wait/complete、saved profile、token refresh persistence、Socket.IO reconnect、latest successful scan snapshot、targeted scan 与 canonical npm install smoke，并进入 readiness gate。 | Daemon/CLI/CI | 设备连接入口不能只证明 scanner、profile 或 npm publish 各自存在；必须证明用户设备重启/重连后继续使用刷新后的设备凭据，并把最新扫描到的 AgentOS 托管 Agent / 自定义 Agent 能力重新上报。 | `parity-backfill-audit.md`, `apps/daemon-next/tests/protocol-client.test.ts`, `apps/daemon-next/tests/cli.test.ts`, `apps/server-next/tests/first-slice.test.ts`, `scripts/check-agentbean-next-readiness.mjs` |
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
| P3-27 | CI 的 `AgentBean Next production smoke` 在 final flip 前运行 ready-to-flip audit，在 repository variable `AGENTBEAN_DEPLOY_TARGET=next` 后运行 strict cutover audit，并且都必须发生在 public entry smoke 之前。 | Release/CI | 真正替换旧 AgentBean 后，production smoke 必须证明最终开关已生效，而不是继续只证明“等待授权”。 | `production-cutover-runbook.md`, `fifty-eighth-slice-status.md` |

P3-24 与 P3-25 在 Release A 仍是有效回退门禁：当前 workflow 继续验证旧栈、支持 old-target deploy，并维护 legacy daemon 发布/标签。Release B 删除旧源码后，回退改为只依赖 Git、Railway 与 npm 已发布 artifact。

Phase 3 完成标准：

- Daemon-next 可以通过针对 fake 或 real server-next 的 protocol tests。
- Stub executor 在迁移 real adapters 前证明 dispatch。

## Phase 4：Web Minimal Slice

| ID | 必需测试 | 层级 | 验证内容 | 来源文档 |
|---|---|---|---|---|
| P4-01 | Web API client 使用 first-slice event names 与 `Ack<T>` handling。 | Web | Client contract。 | `socket-protocol.md`, `contracts-dto.md` |
| P4-02 | Session store 只持久化 token 与 current team path，并使用 `agentbean.teamPath` 作为唯一写入键。 | Web | Web state ownership；Release A 只允许隔离 helper 读取一次旧键，不允许任何业务流程继续写旧键。 | `target-architecture.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| P4-03 | Login/register screen 处理 success 与 failure ack shapes。 | Web | Auth contract。 | `contracts-dto.md` |
| P4-04 | Team shell 从 `TeamDto` 渲染 current team。 | Web | Team projection。 | `contracts-dto.md` |
| P4-05 | Device/agent status UI 渲染 server snapshots，不做 local dedupe。 | Web | Server-owned identity。 | `agent-identity-rules.md`, `target-architecture.md` |
| P4-06 | Channel list 渲染 `ChannelDto` 与 selected channel history。 | Web | Channel/message DTOs。 | `contracts-dto.md` |
| P4-07 | Message composer 在 authenticated socket session 下可省略 `userId`，并发送 `teamId`、`channelId`、`body` 与 `clientMessageId`；不发送 `senderKind`/`senderId`。 | Web | Sender trust boundary。 | `contracts-dto.md`, `acceptance-tests.md` |
| P4-08 | Conversation 追加 `channel:message` 与 dispatch status updates。 | Web | Realtime projection。 | `socket-protocol.md` |
| P4-09 | Reconnect 会 resubscribe 并替换 snapshots，而不是 patch stale state。 | Web | Snapshot recovery。 | `known-gaps.md`, `acceptance-tests.md` |
| P4-10 | server-next dev server 托管 web-next preview 页面，页面包含 register、custom agent create、message send 三个主要操作面。 | Web/Socket | 本地可视化 preview 入口。 | `implementation-runbook.md`, `target-architecture.md` |
| P4-11 | web-next preview 保存 token，并在 reconnect/refresh 时通过 `auth:whoami` 恢复 user 与 current team；token 无效时清除本地 session。 | Web/Socket | 可视化 preview 使用服务端登录态恢复。 | `socket-protocol.md`, `target-architecture.md` |
| P4-11 | full local preview launcher 启动 SQLite server，bootstrap/login preview 用户，并把 daemon-next 连接到同一个 team。 | Web/Socket/Daemon | 一条命令启动本地替换 preview。 | `implementation-runbook.md`, `target-architecture.md` |
| P4-12 | preview 页面刷新或 Socket.IO reconnect 后恢复 session 并重新订阅 devices、agents 与 channels。 | Web | 本地 preview 会话恢复。 | `target-architecture.md`, `known-gaps.md` |
| P4-13 | web-next preview 可以通过 `channel:create` 创建 channel，刷新 channel snapshot，并在新 channel 中继续发送消息。 | Web/Socket | 本地 preview 不只依赖默认 `all` channel，开始覆盖真实产品 channel 工作流。 | `socket-protocol.md`, `target-architecture.md` |
| P4-14 | preview 内联脚本在 DOM harness 中覆盖 `auth:whoami` session restore、snapshot resubscribe、`channel:create` submit 与新 channel message selection。 | Web | 防止静态 preview 的关键交互在无浏览器测试时回退。 | `socket-protocol.md`, `known-gaps.md` |
| P4-15 | 本地 preview 第一屏必须自动进入默认 team，并呈现旧 AgentBean 风格的左侧频道、中间聊天、右侧成员/设备/runtime/custom agent 工作台。 | Web/UX | 防止把临时协议验证器误当成可替换旧 AgentBean 的产品 UI。 | `target-architecture.md`, `known-gaps.md`, `forty-fifth-slice-status.md` |
| P4-16 | web-next preview 在 message artifacts 中展示 filename、workspace run id/status，并生成带 session token 的 preview/download links。 | Web | Artifact metadata 不应只停在 server projection，用户需要在消息里看到并打开输出文件。 | `known-gaps.md`, `fifty-ninth-slice-status.md` |
| P4-17 | web-next preview composer 会将选中文件上传到 artifact HTTP route，并把返回的 artifact ids 随 `message:send` 发送。 | Web/HTTP | 用户可以从 composer 创建 artifact-backed human message。 | `known-gaps.md`, `sixtieth-slice-status.md` |
| P4-18 | web-next preview 在 message workspace run 区域展示 cwd、device、exit code、duration 与 artifact count。 | Web | Workspace run metadata 不应只停留在 id/status，用户需要看到执行上下文与输出规模。 | `known-gaps.md`, `sixty-second-slice-status.md` |
| P4-19 | web-next preview composer 使用 `FormData` multipart 上传文件，不再手动 base64 编码。 | Web/HTTP | 浏览器 file input 路径应走真实 multipart upload，而不是只依赖 JSON/base64 兼容入口。 | `known-gaps.md`, `sixty-third-slice-status.md` |
| P4-20 | web-next preview 在同一条 message 内按 workspace output 与 message attachment 分组展示 artifacts。 | Web | Artifact metadata 不应只平铺展示，用户需要区分 agent workspace 输出与用户上传附件。 | `known-gaps.md`, `sixty-fourth-slice-status.md` |
| P4-21 | web-next preview 在 Workspace 输出组内按 `relativePath` 展示轻量目录树。 | Web | Workspace output 不应只平铺文件名，用户需要看到输出文件的相对路径结构。 | `known-gaps.md`, `sixty-fifth-slice-status.md` |
| P4-22 | web-next preview 可以从 message workspace run 摘要打开独立详情面板，并在面板内展示 run metadata 与 workspace output tree。 | Web | 用户需要脱离单条消息气泡查看一次 workspace run 的执行上下文与输出文件。 | `known-gaps.md`, `post-flip-follow-up-status.md` |
| P4-23 | web-next preview 的 workspace run 详情入口会写入 `workspaceRunId` URL，并能在刷新/直达该 URL 后通过 HTTP API 恢复详情。 | Web/HTTP | Workspace run detail 需要可分享、可恢复，而不是只能依赖当前消息 DOM 状态。 | `known-gaps.md`, `sixty-sixth-slice-status.md` |
| P4-24 | web-next preview 右侧工作区提供 message search 表单，并通过 `message:search` 渲染结果。 | Web/Socket | 用户需要在 preview shell 内直接查找历史消息，而不是依赖当前 DOM 或浏览器查找。 | `known-gaps.md`, `sixty-seventh-slice-status.md` |
| P4-25 | web-next preview 右侧工作区提供轻量 task create/list/status update 入口。 | Web/Socket | Tasks 第一版需要在 preview shell 内可见可操作，而不是只停留在 server API。 | `known-gaps.md`, `sixty-eighth-slice-status.md` |
| P4-26 | web-next preview 按 `threadId` 将讨论串回复嵌套渲染在 root message 之下，root 提供「回复讨论串」按钮，message-form 在回复态携带 `threadId` 发送 thread reply。 | Web/Socket | Threads 第一版不能只在 server 层定义，用户必须在 preview shell 内看到嵌套讨论串并能回复。 | `known-gaps.md`, `seventieth-slice-status.md` |

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
| E2E-07 | `npm run smoke:agentbean-next-browser` 启动或连接 AgentBean Next 入口，用真实 Chrome 完成浏览器登录/session restore、刷新重订阅、custom agent 创建、message dispatch 与 agent reply 可见，并输出 console log 与截图 artifacts。 | Browser E2E/CI | 防止只依赖 DOM harness 与 Socket.IO smoke，把替代旧 AgentBean 的核心用户路径放进浏览器级证据。 | `post-flip-gap-audit.md`, `apps/web-next/tests/preview-page.test.ts`, `scripts/smoke-agentbean-next-business.mjs` |
| E2E-08 | `npm run smoke:agentbean-next-browser` 在真实 Chrome 中选择 composer 文件、上传 artifact-backed human message、等待 viewer 渲染，并 fetch preview/download 链接校验 bytes。 | Browser E2E/CI | Artifact upload/viewer 不能只由 DOM harness 证明，必须在真实 browser/file input/HTTP route 链路中覆盖。 | `sixty-first-slice-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-09 | `npm run smoke:agentbean-next-browser` 在真实 Chrome 中通过 preview task form 创建 task、更新状态，并在刷新后通过 `task:list` 恢复同一 task。 | Browser E2E/CI | Tasks 第一版不能只由 usecase/socket/DOM harness 证明，必须覆盖真实浏览器 UI 与 session restore 路径。 | `sixty-ninth-slice-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-10 | `npm run smoke:agentbean-next-browser` 在真实 Chrome 中点击 root message 的「回复讨论串」按钮、输入 thread reply、提交，并断言 reply 嵌套在 root 之下（`.thread-reply`）。 | Browser E2E/CI | Thread UI 不能只由 DOM harness 证明，必须覆盖真实浏览器点击/输入/提交/嵌套渲染链路。 | `seventieth-slice-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11 | 已迁移产品入口不得只按模块完成验收；每个入口都要有页面语义、server query、subscription/broadcast 与协议兼容的最小闭环测试或明确的未覆盖记录。 | Parity E2E/CI | 已经迁移的 surface 要做 backfill audit：补测试、补 readiness gate、补文档状态；不能把“代码已迁入”当成“旧版行为已等价”。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `current-protocol-inventory.md`, `socket-protocol.md` |
| E2E-11a | `webui-devices-business-flow` 在 App Router 设备入口覆盖 list -> detail、runtime 投影、自定义 Agent 投影、targeted scan 后 AgentOS 托管 Agent 投影、rename/refresh restore 与 delete redirect/list disappearance。 | Browser E2E/CI | 设备页不能只证明 `device:agents:list` 或 daemon scanner 单测；必须证明用户进入设备详情后能看到运行时、扫描发现的 AgentOS 托管 Agent 与添加的自定义 Agent，并能完成旧版已有的重命名/删除主路径。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11b | `webui-agents-business-flow` 在 App Router 智能体入口覆盖 custom agent create、list/detail、config update、metrics dispatch 与 delete/list disappearance。 | Browser E2E/CI | 智能体页不能只证明 `agent:create`、`agents:subscribe` 或 metrics API 存在；必须证明用户能在全局 Agent 管理入口完成配置、指标与删除主路径。当前不在 Agent detail 提供跨 Team 可见性切换，primary Team 内可见性由 Device 管理入口负责。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11c | `webui-task-business-flow` 在 App Router 任务入口覆盖 task create、status update、reorder、delete/list disappearance 与 refresh restore。 | Browser E2E/CI | 任务页不能只证明 `task:create`、`task:update` 或 usecase 存在；必须证明用户能在任务入口完成旧版已有的排序、删除与刷新恢复主路径。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11d | `webui-settings-business-flow` 在 App Router 设置入口覆盖 account 当前用户身份/logout 入口、browser preferences 持久化/刷新恢复/reset、team rename、join link create/revoke 与刷新恢复。 | Browser E2E/CI | 设置页不能只证明 `team:update`、`join:create` 或 localStorage helper 存在；必须证明用户在设置入口跨 account/browser/team tab 完成旧版已有的账号查看、浏览器偏好、团队资料与邀请链接主路径。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11e | `webui-admin-dashboard-business-flow` 在 App Router dashboard/admin 入口覆盖 global admin 访问、teams/users/devices/agents tab、设备详情 runtime/public agent 投影、owner transfer 与 Agent owner projection。 | Browser E2E/CI | Admin dashboard 不能只证明 `admin:list-*` 或 `admin:transfer-device-owner` socket/usecase 存在；必须证明全局管理员能在 dashboard 页面看到跨实体列表，并完成旧版已有的设备 owner 转移主路径。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11f | `daemon-onboarding-lifecycle-green` readiness gate 覆盖设备连接入口：invite wait/complete、saved profile 管理、token 续签持久化、断线重连重新上报、latest scan snapshot、targeted scan、custom agent env device-token boundary 与 canonical npm install smoke。 | Daemon/CLI/CI | 设备连接入口不能只靠 daemon scanner 单测或 npm 发布成功判 Green；必须证明用户运行连接命令后的设备身份、凭据、扫描结果和 Agent 能力在重启/重连后仍正确。 | `parity-backfill-audit.md`, `scripts/check-agentbean-next-readiness.mjs`, `apps/daemon-next/tests/protocol-client.test.ts`, `apps/daemon-next/tests/cli.test.ts`, `apps/server-next/tests/first-slice.test.ts` |
| E2E-11g | `webui-runs-business-flow` 在 App Router 运行记录入口覆盖执行列表、状态/Agent/设备筛选、状态分组、详情路由、刷新恢复、完整日志 artifact、文件树、inline 日志搜索、返回列表与返回触发消息。 | Browser E2E/CI | 运行记录不能只证明 `workspaceRun` DTO、server route 或消息内联摘要存在；必须证明用户能从侧栏进入执行记录、定位一次 Agent 执行、查看日志和输出，并回到业务上下文。 | `parity-backfill-audit.md`, `post-flip-follow-up-status.md`, `scripts/smoke-agentbean-next-browser.mjs` |
| E2E-11h | `webui-teams-business-flow` 在 canonical `/:teamPath/teams` 入口覆盖 Team create、switch、delete、fallback restore，并在每个状态转换后刷新验证 current Team 持久化；Release A 的旧收藏兼容必须经过一次性 308 permanent redirect（永久重定向）并最终落到 `/:teamPath/teams`。 | Browser E2E/CI | settings / teams 不能只证明 `team:create`、`team:switch` 或路由文件存在；必须证明浏览器状态只写 `agentbean.teamPath`，canonical Team 页面可完成管理主路径，且限时 redirect 没有形成重复业务实现。 | `scripts/smoke-agentbean-next-browser.mjs`, `apps/server-next/tests/browser-smoke-script.test.ts` |

当前 E2E-07、E2E-08、E2E-09 与 E2E-10 已进入 AgentBean Next CI gate。E2E-11 是所有已迁移入口的 backfill 规则：如果发现旧版已存在但 Next 入口缺少同等行为，要先补 regression test 与 readiness/static gate，再把状态写回本矩阵与 `parity-backfill-audit.md`。`webui-channel-members-business-flow` 已覆盖频道成员入口的 App Router browser-level parity。`webui-teams-business-flow` 已覆盖 canonical `/:teamPath/teams` create/switch/delete/fallback restore、逐阶段刷新 current Team 持久化，以及 Release A 旧收藏兼容的一次性 308 redirect。Device、Agent、Task、Run、Settings、Admin 与 daemon onboarding 的入口级证据分别由对应 `webui-*-business-flow` 与 readiness gate 保护。后续新增更完整 search、完整 task page、admin audit/member/device、设备接入异常演练等产品切片时，应在本节追加对应入口级 gate，而不是把已有 smoke 误判为覆盖全部旧产品表面。

只有对应 phase 的 E2E gates 通过后，该 phase 才可冻结。

## 延后的验收测试

这些仍保留在 `docs/acceptance-tests.md` 中，但第一切片冻结前不强制要求：

- Join link management UI（web-next 客户端 list/revoke 绑定 + preview 邀请管理面板）；`join:list` / `join:revoke` 协议层已由 #267 落地。
- Admin。
- Metrics。
- Audit requirements。
