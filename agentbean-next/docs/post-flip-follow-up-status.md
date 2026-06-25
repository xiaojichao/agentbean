# AgentBean Next post-flip follow-up status

本文记录 AgentBean Next final flip 后的 follow-up 收敛状态。它不是新的生产操作记录，而是给后续切片选择使用的当前项目地图。

## 核对时间

- 日期：2026-06-23
- 当前基线：`origin/main` = `dbf9291`（PR #340 已合并）
- GitHub 状态：open PR 为空；open issue 为空。
- 最新 main CI/CD：run `28015256812` 成功，包含 Validate web/server/daemon/AgentBean Next、Deploy production、Publish agent to npm 与 AgentBean Next production smoke。
- 已新增逐入口 parity backfill 账本：`agentbean-next/docs/parity-backfill-audit.md`。

这些状态会随 GitHub 与生产环境变化而漂移；执行外部操作前仍应重新核对。

## 已从 post-flip follow-up 中收敛的能力

以下能力已经不应继续作为未完成 blocker 处理：

- Final flip 与 post-flip production smoke gate。
  - strict cutover audit、public entry smoke、business smoke、rollback old-entry smoke guard 与 browser smoke CI gate 已进入主线验证。
- 生产观察证据 baseline。
  - #141 已关闭：生产写入 marker message、受控 Railway Next 重部署、同账号重登读取 channel history 后确认 marker message 仍存在；#140 已完成总审计并关闭。
  - 2026-06-15 再次复核 strict cutover audit、public entry smoke 与 business smoke 均通过。
- Authenticated socket session 与 current team 恢复。
  - web socket 可以通过 session token 恢复 user/current team；preview/browser smoke 覆盖刷新后的 session restore 与 resubscribe。
- Message search 第一版。
  - `message:search` 使用 server-side simple DB search，只返回当前用户可见普通 channels 的结果；preview 右侧工作区已有轻量搜索表单。
- Tasks 第一版。
  - `task:list`、`task:create` 与 `task:update` 使用 server-side task model；assignee 第一版支持 team human member 或当前 team 可见 agent；preview 右侧工作区已有轻量任务入口；browser smoke 已覆盖 task create/status update/reorder/delete/refresh restore。
- Team/join/device invite 第一版。
  - `team:create`、`team:switch`、`join:create`、`join:validate`、`device-invite:create`、`device-invite:wait`、`device-invite:complete` 已有 contracts、use cases 与 tests。
  - `join:list` 与 `join:revoke` 的协议层（contracts 常量 + server-next handler + usecase + memory/sqlite repository）已由 #267 进入主线；web-next 客户端绑定与 invite management UI 仍在后续 P2。
- Dispatch lifecycle 第一版。
  - `dispatch:cancel` 已进入 web/agent event contract；server-next runtime 会定期调度 `failTimedOutDispatches` 并广播 dispatch status。
- Agent 管理面第一版。
  - `agent:publish`、`agent:unpublish`、`agent:update-config` 与 `agent:delete` 已覆盖 owner/admin 权限、visible projection、envKeys-only snapshot 与 tombstone 删除语义。
- Channel archive/delete 第一版。
  - `channel:archive` 与 `channel:delete` 已进入 contracts、server-next use cases/repositories 与 apps/web 客户端；server 侧覆盖 default channel 保护、creator 权限、archive 从列表隐藏、delete cascade。
- DM/thread 第一版。
  - direct channel model、DM snapshot/history、thread id 继承与 dispatch history 去重已在 server-next 层落地。
  - web thread UI 与 browser E2E 已在 thread UI slice（P4-26 / E2E-10）覆盖：preview 按 `threadId` 嵌套渲染讨论串并可回复。
- Artifacts/workspace runs repository/usecase 第一版。
  - daemon `dispatch:result` 可以上报 artifact metadata 与 workspace run metadata；server-next 已做 team-scoped metadata authorization。
- Saved messages 与 reactions 第一版。
  - `message:react`、`message:save` 与 `message:list-saved` 已由 server-side repository 持久化；apps/web 的 chat/tasks surface 已接入 socket-backed optimistic update，保留 local cache 只作为界面恢复兜底。
- Task delete/reorder 第一版。
  - `task:delete` 与 `task:reorder` 已进入 contracts、server-next use cases/repositories 与 apps/web payload adapter；server 侧覆盖可见性、已删除任务与无效 sortOrder 边界；App Router 任务入口已通过 browser smoke 覆盖排序与删除后列表消失。
- Member role management 第一版。
  - `member:update-role`、`member:remove` 与 `member:transfer-owner` 已进入 socket/usecase/web detail surface；owner/admin 边界、admin 不能管理其他 admin、自我管理保护与 owner transfer 均有回归测试。
- 真正浏览器级 E2E 第一版。
  - `npm run smoke:agentbean-next-browser` 已覆盖真实 Chrome 登录/session restore、刷新重订阅、custom agent 创建、message dispatch、agent reply、artifact upload/viewer 与 task create/status update/reorder/delete/refresh restore，并在 CI 上传截图/console artifacts。

## 仍需补齐的边界

### P0：生产观察证据

P0 baseline 已经收敛，不应继续作为下一条产品切片 blocker。

已确认：

- #141 已关闭，记录了 final flip 后真实 Railway production volume 重部署持久化证据。
- #140 已关闭，作为 post-flip 生产观察与替代旧服务 gap audit 的总审计入口已经完成。
- 2026-06-15 当前生产复核仍通过 strict cutover audit、entry smoke 与 business smoke。

剩余边界：

- production logs、socket/API 错误与 rollback 演练仍应在实际 deploy、incident、rollback drill 时作为运维记录追加；它们不再阻塞当前替换主线的下一条产品切片。

### P1：artifact HTTP/viewer 第一版

`artifact HTTP upload/download/preview route + web artifact viewer` 第一版已经在第五十九切片落地。

已确认：

- server-next 提供 JSON/base64 兼容 upload、multipart upload、preview route 与 download route。
- route 复用 session token、team membership 与 channel visibility 授权。
- web-next preview 会在消息中展示 artifacts 与 workspace run id/status，并生成 preview/download links。
- web-next preview composer 可以选择文件并以 multipart `FormData` 随 human message 上传/绑定 artifact。
- `npm run smoke:agentbean-next-browser` 已覆盖真实浏览器 artifact upload、preview 与 download bytes 验证。
- web-next preview 会在 message workspace run 区域展示 cwd、device、exit code、duration 与 artifact count。
- web-next preview 会在 message artifact 区域按 workspace output 与 message attachment 分组展示 artifacts。
- web-next preview 会在 Workspace 输出组内按 `relativePath` 展示轻量目录树。
- web-next preview 可以从 message workspace run 摘要打开右侧独立详情面板，集中查看 run metadata 与 workspace output tree。
- server-next 与 web-next preview 支持 workspace run detail 的授权 HTTP API 与 `workspaceRunId` URL 恢复路径。
- apps/web 的执行详情页已支持从 agent/device 工作区列表进入，在 run 有 `messageId` 时回链到原 chat message，并在 daemon 上报时展示执行命令与可折叠日志摘要。
- apps/web 的执行详情页已提供日志摘要排障工具：失败默认展开、复制、下载、换行切换、行数/字符数与尾部摘要提示。
- server-next 原生 agent workspace run 列表 route 已补齐；apps/web 的 agent/device 工作区入口可展示最新 runs、状态、命令上下文与关联 workspace artifacts，并继续链接到执行详情。
- server-next 团队级 workspace runs 最新列表 route 已补齐；apps/web 侧栏把 `/runs` 降级为诊断区“执行记录”，可按当前用户可见 channel 展示团队最近执行记录、来源消息跳转、agent/device、退出码与文件数量。
- daemon-next custom command 的完整 stdout/stderr 日志已 artifact 化为 `logs/workspace-run.log`，server-next 写入自身 artifact storage 后复用现有 preview/download 授权，apps/web run detail 会提示完整日志可在文件列表下载。

剩余边界：

- 不再把 `runs` 当旧版一等产品入口补齐；跨页面导航、执行命令投影、受限日志摘要排障工具、agent/device 列表入口、团队 latest list 与完整日志 artifact v1 已补第一步。后续只按排障、audit 或脱敏新需求补分段日志存储/检索。

### P2：后续产品 parity

- 旧 `apps/web` App Router 页面树已在第七十一切片迁入 `apps/web-next/app`，并且 `npm run build:web-next` 可以同时构建 socket client package 与 Next app。`server-next` 生产式 `PORT` 启动默认 `webEntry=app`，`/preview` 保留为诊断入口；第一版 WebUI browser smoke 已覆盖 4 个公开页面与 7 个登录后业务页面，并在 `/runs` 抓到/修复旧 `/api/teams/default/workspace-runs` 403；后续加深的 business smoke 已覆盖 `chat` 发送/刷新恢复、`channels` 创建/归档/列表消失、`networks` 团队创建/切换/删除/恢复原团队、`tasks` 创建/状态更新/排序/删除/刷新恢复、canonical `dispatch:result.workspaceRun` 产出的 `runs` 列表/详情/刷新恢复、`members` 的 join/role update/刷新恢复、`devices` 的 list/detail、runtime 投影、自定义 Agent 投影、targeted scan 后 AgentOS 托管 Agent 投影、rename/refresh restore 与 delete redirect/list disappearance、`settings` 的 account 当前用户身份/logout 入口、browser preferences 持久化/刷新恢复/reset、team rename、join link create/revoke 与刷新恢复，`agents` 的 custom agent create、list/detail、config update、publish/unpublish、metrics 与 delete/list disappearance，以及 `dashboard / admin` 的 global admin 访问、teams/users/devices/agents tab、设备详情 runtime/public agent 投影、owner transfer 与 Agent owner projection。剩余风险从“页面文件未迁入/生产入口仍托管 preview shell”收窄为“执行记录只作为诊断面、daemon onboarding 长尾与更完整 audit trail”。
- 执行记录只保留为诊断面，不再优先推进 team-wide explorer；后续只按排障、audit 或脱敏新需求补分段日志存储/检索。
- Admin、metrics 与 audit requirements；`admin:list-teams`/users/devices/agents 与 `admin:transfer-device-owner` 已回填 server-next socket/usecase 回归和 readiness gate，App Router dashboard 已补 global admin tab/list/detail/owner transfer browser smoke，`agent:metrics` request/ack 已有；更完整 audit trail、批量删除/恢复与 metrics drilldown 仍按后续产品切片补。
- Daemon onboarding 已有 invite wait/complete、CLI token persistence、多 profile/YAML、profile list/clear/rename CLI、token refresh persistence、scan summary、scanner parity、reconnect latest-scan snapshot、canonical npm install smoke 与 production smoke 证据；profile lifecycle、token refresh persistence 与 reconnect snapshot evidence 已进入 readiness gate。剩余风险集中在更完整 reconnect guarantees 与 onboarding UX drill。
- 团队改名（`team:update`）已在 preview 团队设置面板覆盖；App Router `devices` 已覆盖 device rename/refresh restore；App Router `settings` 已覆盖 account 当前用户身份/logout 入口、browser preferences 持久化/刷新恢复/reset、team update、join link create/revoke 与刷新恢复；App Router `networks` 已覆盖受控 team create/switch/delete/fallback restore，并补 SQLite delete cascade 回归。
- Typed assignee、task 自动生成与更丰富的 task 产品流；task create/status/reorder/delete/refresh restore 已有入口级 browser smoke。
- Join link management UI（web-next 客户端 list/revoke 绑定 + preview 邀请管理面板）；`join:list` / `join:revoke` 协议层已由 #267 落地。

### npm canonical 入口 dist-tag（已收敛）

canonical npm 包 `@agentbean/daemon` 的 `@latest` dist-tag 已推进到基于 daemon-next 的 `0.2.0`（2026-06-17 核对 `npm view @agentbean/daemon dist-tags` = `{ latest: '0.2.0', legacy: '0.1.35' }`）。默认 `npm install @agentbean/daemon` 现在安装 daemon-next；旧守护进程 `0.1.35` 保留在 `legacy` dist-tag 作 rollback。cutover audit 的 `npm-canonical-daemon-latest-dist-tag` check 持续验证 latest 指向 daemon-next 版本，防止回退。该 npm 用户入口边界已随 #269 的受控推进机制 + 一次性 flip 关闭。

## 下一步判定

当前不应再从旧 #141-#148 follow-up 清单直接挑“未完成项”开工。P0 生产观察 baseline 已完成，页面入口也已经迁入 App Router；下一步进入 parity backfill 阶段，按 `parity-backfill-audit.md` 的 Red/Yellow/Green 逐入口推进。`channels / channel members` 已补 App Router browser smoke 与 readiness gate，覆盖 creator 添加/移除 human 与 agent member、private channel visibility 回收、mention scope，以及 `channel:members` projection 不能被其他接口替代。`devices` 已补 App Router browser smoke 与 readiness gate，覆盖设备 list/detail、runtime 投影、自定义 Agent 投影、targeted scan 后 AgentOS 托管 Agent 投影、rename/refresh restore 与 delete redirect/list disappearance。`agents` 已补 App Router browser smoke 与 readiness gate，覆盖 custom agent create、list/detail、config update、publish/unpublish、metrics 与 delete/list disappearance。`tasks` 已补 App Router browser smoke 与 readiness gate，覆盖 task create/status/reorder/delete/refresh restore。`settings / networks` 已补 App Router browser smoke 与 readiness gate，覆盖 account 当前用户身份/logout 入口、browser preferences 持久化/刷新恢复/reset、team rename、join link create/revoke、team create/switch/delete/fallback restore。`dashboard / admin` 已补 App Router browser smoke 与 readiness gate，覆盖 global admin 访问、teams/users/devices/agents tab、设备详情 runtime/public agent 投影、owner transfer 与 Agent owner projection。`daemon onboarding` 已补 profile list/clear/rename CLI、token refresh persistence 与 readiness gate，保留 Yellow 直到更完整 reconnect guarantees 与 onboarding UX drill 冻结。`runs` 本轮仍先放一边；当前建议的下一条小切片继续在 `daemon onboarding` 内做 reconnect/onboarding drill 证据。

## 已迁移入口的回头验规则

已经迁移到 AgentBean Next 的功能不能只按“代码已搬到 `apps/web-next` / `apps/server-next`”判定完成。发现旧版已有、Next 缺失或退化的行为时，按以下顺序补账：

1. 先补最小 regression test，直接覆盖旧版产品语义。例如成员页要测 `members:list` 是否返回 human members 与当前 team 可见 agents，而不是只测 `agents:subscribe` 或 `device:agents:list`。
2. 再补 readiness/static gate，确保关键测试、协议合同或兼容 adapter 不会从主线移除。
3. 最后更新 `verification-matrix.md` 或本文，把该入口归入“已收敛”或“仍需补齐的边界”。

成员页、设备页、全局 agent snapshot 与频道成员是四个不同产品入口：`members:list`、`device:agents:list`、`agents:subscribe`、`channel:members` 不能互相替代验收。已迁移 surface 如果只证明了其中一个接口通过，其他入口仍视为未完成 parity backfill。

逐入口状态以 `parity-backfill-audit.md` 为准。本文保留阶段性地图；具体 Green/Yellow/Red、证据与下一条 slice 不再分散写在旧 follow-up 清单里。
