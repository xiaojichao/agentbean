# AgentBean Next post-flip follow-up status

本文记录 AgentBean Next final flip 后的 follow-up 收敛状态。它不是新的生产操作记录，而是给后续切片选择使用的当前项目地图。

## 核对时间

- 日期：2026-06-15
- 本地分支：`codex/post-flip-status-convergence` 基于 `origin/main`
- GitHub 状态：#140 与 #141 均已 completed 关闭；#239 已合并并自动关闭 #238
- 当前生产复核：`npm run audit:agentbean-next-cutover -- --json` 通过 `11/11`，`pendingFinalFlip: false`
- 当前生产 smoke：`npm run smoke:agentbean-next-entry -- --url https://api.agentbean.dev` 通过 `4/4`；`npm run smoke:agentbean-next-business -- --url https://api.agentbean.dev` 通过 `8/8`

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
  - `task:list`、`task:create` 与 `task:update` 使用 server-side task model；assignee 第一版支持 team human member 或当前 team 可见 agent；preview 右侧工作区已有轻量任务入口；browser smoke 已覆盖 task create/status update/refresh restore。
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
  - `task:delete` 与 `task:reorder` 已进入 contracts、server-next use cases/repositories 与 apps/web payload adapter；server 侧覆盖可见性、已删除任务与无效 sortOrder 边界。
- Member role management 第一版。
  - `member:update-role`、`member:remove` 与 `member:transfer-owner` 已进入 socket/usecase/web detail surface；owner/admin 边界、admin 不能管理其他 admin、自我管理保护与 owner transfer 均有回归测试。
- 真正浏览器级 E2E 第一版。
  - `npm run smoke:agentbean-next-browser` 已覆盖真实 Chrome 登录/session restore、刷新重订阅、custom agent 创建、message dispatch、agent reply、artifact upload/viewer 与 task create/status update/refresh restore，并在 CI 上传截图/console artifacts。

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
- apps/web 的 workspace run 专页已支持从 agent/device 工作区列表进入，在 run 有 `messageId` 时回链到原 chat message，并在 daemon 上报时展示执行命令与可折叠日志摘要。
- apps/web 的 workspace run 专页已提供日志摘要排障工具：失败默认展开、复制、下载、换行切换、行数/字符数与尾部摘要提示。
- server-next 原生 agent workspace run 列表 route 已补齐；apps/web 的 agent/device 工作区入口可展示最新 runs、状态、命令上下文与关联 workspace artifacts，并继续链接到 workspace run 专页。
- server-next 团队级 workspace runs 最新列表 route 已补齐；apps/web 侧栏新增“运行”入口，可按当前用户可见 channel 展示团队最近 runs、来源消息跳转、agent/device、退出码与文件数量。
- daemon-next custom command 的完整 stdout/stderr 日志已 artifact 化为 `logs/workspace-run.log`，server-next 写入自身 artifact storage 后复用现有 preview/download 授权，apps/web run detail 会提示完整日志可在文件列表下载。

剩余边界：

- 更完整的 workspace run 专用页面布局、复杂 team-wide workspace explorer 与分段日志存储/检索仍需后续产品切片；跨页面导航、执行命令投影、受限日志摘要排障工具、agent/device 列表入口、团队 latest list 与完整日志 artifact v1 已补第一步。

### P2：后续产品 parity

- 更完整的 workspace run 专用页面布局、team-wide workspace explorer 与分段日志存储/检索。
- Admin、metrics 与 audit requirements；`agent:metrics` request/ack 已有，但完整 admin/metrics/audit 产品面仍未冻结。
- 更完整的 settings/device 页面，以及 member management 的浏览器级 smoke 覆盖。
- Typed assignee、task 自动生成与更丰富的 task 产品流；delete/reorder 的协议与 usecase 第一版已收敛。
- Join link management UI（web-next 客户端 list/revoke 绑定 + preview 邀请管理面板）；`join:list` / `join:revoke` 协议层已由 #267 落地。

### npm canonical 入口 dist-tag

canonical npm 包 `@agentbean/daemon` 已发布基于 daemon-next 的 `0.2.0`，但 npm `@latest` dist-tag 目前仍指向旧守护进程 `0.1.35`（2026-06-16 核对 `npm view @agentbean/daemon dist-tags` = `{ latest: '0.1.35' }`）。也就是说默认 `npm install @agentbean/daemon` 仍安装旧守护进程，daemon-next 只能通过显式 `@agentbean/daemon-next@0.2.0` / `@agentbean/daemon@0.2.0` 安装。根因：旧 `0.1.x` 仍在迭代并在发布时回占 `latest`。推进 `@latest` 到 daemon-next（并停止旧 `0.1.x` 回占 latest）是替换主线尚未收尾的一条 npm 用户入口边界，不属于 runtime/生产部署范畴。

## 下一步判定

当前不应再从旧 #141-#148 follow-up 清单直接挑“未完成项”开工。P0 生产观察 baseline 已完成，下一步应开新的 scoped issue/PR 继续产品能力或运维增强；若沿当前替换主线推进，优先在更完整的 workspace run 专用页面、复杂 team-wide workspace explorer、分段日志存储/检索、admin/audit 产品面、settings/device 后续页中选一个小切片。
