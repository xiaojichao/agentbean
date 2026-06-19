# 已知缺口

本文档记录重写前或重写期间必须解决的缺口。它区分产品缺口与实现缺口，避免新系统意外复制旧的不明确性。

## 已由盘点文档关闭的 Phase 0 缺口

以下 Phase 0 artifacts 现在已经存在：

- 当前行为基线：`docs/current-behavior.md`
- 当前 Socket/HTTP 协议盘点：`docs/current-protocol-inventory.md`
- 当前数据模型盘点：`docs/current-data-model-inventory.md`
- 功能处置矩阵：`docs/feature-disposition.md`
- Agent identity 与 dedupe rule table：`docs/agent-identity-rules.md`
- Acceptance test list：`docs/acceptance-tests.md`

这些仍是活文档。实现开始后应继续细化。

## 产品词汇缺口

### Team 术语已确认

AgentBean 统一使用 `team` 作为产品与 domain model 术语。

已确认：

- UI、domain、contract、schema 与 protocol 都应使用 `team`。
- 不再保留第二套团队容器概念或同义术语。
- 旧实现中残留的旧命名只可在盘点历史时作为 identifier 出现；目标实现不应继续采用。

### Agent Types

当前 categories：

- `executor-hosted`
- `agentos-hosted`

当前 sources：

- `self-register`
- `scanned`
- `custom`

需要决策：

- 确认 source 与 category 是否都需要。
- 定义 custom agents 是否总是 `executor-hosted`。
- 定义 AgentOS gateway agents 是 devices、agents、runtimes 还是 connectors。

初始 identity 与 precedence rules 已在 `docs/agent-identity-rules.md` 中定义；剩余缺口是产品词汇与最终 category naming，而不是 merge algorithm 本身。

### Assignee Model

Tasks 第一版已经落地为 server-side task model。

已确认：

- `task:list`、`task:create` 与 `task:update` 已进入 contracts、server-next usecases/repositories 与 web socket binding。
- `assigneeId` 第一版可以指向 team human member 或当前 team 可见 agent。
- `task:list` 默认只返回 global tasks 与当前用户可见 channels/DMs 关联 tasks。
- private channel task 不会泄漏给非 channel member。
- web-next preview 右侧工作区提供轻量 task create/list/status update 入口。
- `npm run smoke:agentbean-next-browser` 已覆盖真实 Chrome 中的 task create、status update 与刷新后 `task:list` 恢复。

剩余：

- 是否把 assignee 升级为 typed `{ kind, id }` 仍需后续产品决策。
- 更完整 kanban/list task page、typed assignee、task 自动生成与更丰富的 browser-level 产品流仍是后续切片。`task:delete` 与 `task:reorder` 第一版已进入 server/web 主线。

## 协议缺口

### 统一 Error Codes

当前 errors 混用 `NOT_AUTHENTICATED`、`UNAUTHORIZED`、`FORBIDDEN`、`DEVICE_NOT_IN_TEAM` 与 raw exception messages 等字符串。

需要决策：

- 定义 canonical error codes。
- 将 transport errors 映射到 domain errors。

### Snapshot 语义

当前系统会为 agents、devices、teams、channels 与 DMs 发送 snapshots，但没有说明一致性保证。

需要决策：

- Snapshots 是 full replacements 还是 patches？
- Clients 应在什么时候 resubscribe？
- Reconnect 后的 recovery flow 是什么？

### Acknowledgement Shape

当前 ack payloads 因 event 而异。

需要决策：

- 所有 commands 使用统一的 `Ack<T>` result shape。
- 当 acks 足够时，避免使用单独 response events。

### Admin Protocol

当前实现有 admin events，但没有完整 admin product spec。

决策：

- 从初始重写中删除 admin protocol。
- 只有具备 role、permission 与 audit requirements 后才重新引入。

## 数据模型缺口

### Dispatch lifecycle 第一版已定义

Dispatch lifecycle 的第一版已经落地到 `server-next` repository/usecase/runtime 层。

已确认：

- `dispatches` model，包含 request ID、agent ID、channel ID、message ID、status、error 与 timestamps。
- Timeout 由 server-next 长驻 runtime 的 scheduler 判定并更新 dispatch status，不是 `DispatchDto` 或 `dispatches` table 的 per-dispatch 字段。
- Artifact/workspace run metadata 通过 message meta、`artifacts` 与 `workspace_runs` 的 `dispatchId` 关联 dispatch，不是 dispatch DTO/table 的内联 artifact links。
- `dispatch:cancel` 会把 pending dispatch 标记为 `cancelled`，late result/error 不再改写已完成状态。
- server-next 长驻 runtime 会定期调用 `failTimedOutDispatches`，把超时 pending dispatch 标记为 `timed_out` 并广播 dispatch status。

剩余：

- Web 上的 cancel affordance 与更完整的 dispatch history/diagnostics UI 仍需后续产品切片覆盖。
- 长时间运行 adapter 的真实进程级 cancel 语义仍需要按 adapter 逐个验证。

### Workspace Runs 第一版已定义

Workspace run persistence 的第一版已经落地到 `server-next` repository/usecase 层。

已确认：

- `workspace_runs` model 记录 `teamId`、`channelId`、`messageId`、`dispatchId`、`agentId`、`deviceId`、`command`、受限 `logExcerpt` 与 `artifactIds`。
- daemon 可以在 `dispatch:result` 上报 workspace run metadata，server 会把 run 绑定到 agent reply message；daemon-next custom command executor 会把执行命令、cwd、exitCode 与脱敏日志摘要带入该 metadata。
- server-next 提供授权 HTTP workspace run detail route，web-next preview 可以从消息摘要打开详情面板，并通过 `workspaceRunId` URL 恢复。
- apps/web 的 workspace run 专页可从 agent/device 工作区列表进入，在 run 有 `messageId` 时回链到原 chat message，并在 daemon 上报时展示执行命令与可折叠日志摘要。
- apps/web 的 workspace run 专页为受限日志摘要提供失败默认展开、复制、下载、换行切换、行数/字符数与尾部摘要提示，方便直接排障。
- server-next 原生 agent workspace run 列表 route 已补齐，apps/web 的 agent/device 工作区入口可按 team membership 与 channel visibility 展示最新 runs、状态、命令上下文与关联 workspace artifacts。
- server-next 提供团队级最新 workspace runs route，apps/web 侧栏新增“运行”入口，可按当前用户可见 channel 展示团队最近 runs、来源消息跳转、agent/device、退出码与文件数量。
- daemon-next custom command executor 会把脱敏后的 stdout/stderr 作为 `logs/workspace-run.log` workspace artifact 上报；server-next 将 inline content 写入自身 artifact storage，apps/web run detail 可通过现有文件列表预览/下载完整日志 artifact。

剩余：

- 更完整的 workspace run 专用页面布局、复杂 team-wide workspace explorer 与分段日志存储/检索仍需后续产品切片覆盖；更强脱敏规则尚未冻结。

### Threads 第一版已定义

Thread behavior 的第一版边界已经落地到 `server-next`，不再需要在 #147 中悬置数据模型选择。

已确认：

- 第一版使用 `messages.thread_id` 与 root-message convention，不引入独立 `threads` table。
- 新 root message 默认 `threadId = message.id`；thread reply 由 client 传入既有 `threadId`。
- Agent reply 继承原始 human message 的 `threadId`。
- Dispatch request 的 `history` 只包含当前 message 之前、同一 `threadId` 的 messages；当前 user input 只出现在 `prompt`，避免重复。

剩余：

- （已收敛）Web thread UI 与 browser E2E 已在 thread UI slice（`seventieth-slice-status.md` / P4-26 / E2E-10）中覆盖：preview 按 `threadId` 嵌套渲染讨论串、root 提供「回复讨论串」按钮、message-form 携带 `threadId` 发送 reply，browser smoke 覆盖真实浏览器点击/输入/嵌套链路。

### Artifact HTTP 与 Access Control 第一版已定义

Artifact metadata、HTTP route 与 preview viewer 的第一版已经落地。

已确认：

- `artifacts` model 记录 `teamId`、`channelId`、`messageId`、`dispatchId`、`workspaceRunId`、filename/mime/size/path/hash metadata。
- `getArtifact` 按 team membership 与 artifact `teamId` 授权；跨 team 读取返回 `NOT_FOUND`。
- `MessageDto.artifacts` 可以投影 agent reply 的 artifact metadata。
- server-next 提供 `POST /api/teams/:teamId/artifacts/upload`、`GET /api/teams/:teamId/artifacts/:artifactId/preview` 与 `GET /api/teams/:teamId/artifacts/:artifactId/download`，upload route 支持 JSON/base64 兼容入口与 multipart form-data 产品入口。
- server-next 提供 `GET /api/teams/:teamId/workspace-runs/:runId`，按 session token、team membership 与 channel visibility 返回 workspace run detail 及其 artifact projection。
- server-next 提供 `GET /api/teams/:teamId/workspace-runs`，按 session token、team membership 与 channel visibility 返回当前用户可见的团队最新 workspace runs 及其 artifact projection。
- web-next preview 会在消息中按 workspace output 与 message attachment 分组展示 artifact 文件，并在 Workspace 输出组内按 `relativePath` 呈现轻量目录树；workspace run id/status、cwd、device、exit code、duration、artifact count 与预览/下载链接也会一起展示。
- web-next preview 可以从消息里的 workspace run 摘要打开独立详情面板，在右侧工作区查看该 run 的 metadata 与 workspace output tree。
- web-next preview 的 workspace run 详情入口会写入 `workspaceRunId` URL，并能在刷新/直达该 URL 后通过 HTTP API 恢复详情。
- web-next preview composer 可以选择文件，先通过 artifact HTTP upload route 以 `FormData` 上传，再将返回的 artifact id 绑定到 human message。
- daemon-next custom command 的完整日志第一版复用 artifacts：`logs/workspace-run.log` 会绑定到对应 workspace run，并继续沿用 artifact preview/download 的访问控制。

剩余：

- 更完整的 workspace run 专用页面布局、复杂 team-wide workspace explorer 与分段日志存储/检索仍需后续产品切片。

### Search Projection

Message search 第一版已经落地为 server-side simple DB search。

已确认：

- `message:search` 只搜索当前用户在 team 内可见的普通 channels。
- private channel 搜索结果不会泄漏给非 channel member。
- web-next preview 右侧工作区提供轻量消息搜索表单与结果列表。

剩余：

- Direct message search 已收敛：`message:search` 现在同时纳入用户可见的 direct channels（`listDirectForUser`），且不会泄漏给 DM 非参与者。
- full-text indexing、ranking/highlight 与 saved filters 仍需后续产品切片。

## Web 缺口

### State Ownership

当前 Zustand store 包含 agent dedupe 等 domain logic。

需要：

- 将 dedupe 与 permission decisions 移到 server/domain。
- Web store 聚焦 session、connection、snapshots 与 UI state。

### 大页面拆分

当前 chat 与 task pages 混合 data loading、socket calls、feature state 与 rendering。

需要：

- 迁移期间拆分为 feature modules 与 hooks。

### Saved Messages 与 Reactions

Saved messages 与 reactions 的第一版已经落地为 server-side persistence。

已确认：

- `message:react`、`message:save` 与 `message:list-saved` 已进入 contracts、server-next socket/usecase/repository 与 SQLite/memory repositories。
- `apps/web` 的 chat/tasks surfaces 已通过 `messageReactionEvents` 接入 socket-backed optimistic update。
- 本地 `localStorage` 只作为界面恢复兜底，不再是唯一 source of truth。

剩余：

- 更完整 reaction counts/multi-emoji 展示、saved filters 与 browser-level saved/reaction smoke 仍属后续产品增强。

## Daemon 缺口

### 附件支持与产物归档（已落地）

custom agent dispatch 的输入附件下载与输出产物归档第一版已在 daemon-next 落地：

- 附件：dispatch 携带 attachments 时，daemon 从 server HTTP download route 下载到 per-run `inputs/`，清单注入 prompt，本地路径经 `AGENTBEAN_INPUT_DIR` 暴露给命令。
- 产物：命令执行后扫描 `outputs/` + cwd 兜底（mtime/扩展名/忽略目录过滤、SHA256 去重），HTTP multipart upload 后以 artifact id 引用随 `dispatch:result` 上报，server 自动关联 message/workspaceRun。
- per-run 目录：`{customAgent.cwd}/.agentbean/runs/{runId}/{inputs,outputs,logs}` + `manifest.json` + `response.md`，并发 dispatch 互不污染。
- 错误语义：附件下载、产物上传、manifest 持久化任一失败均跳过，不阻断 `dispatch:result`。
- 编排位置：附件/目录/扫描/上传/manifest 编排在 dispatch handler（`apps/daemon-next/src/index.ts`），executor 保持纯执行（只 spawn）；产物 artifact 以 id 引用合并进 `dispatch.result`，workspace-run.log 仍走 inline。
- 参考实现：`apps/daemon-next/src/{attachments,workspace-run,artifact-collector,artifact-uploader}.ts`、`apps/daemon-next/src/index.ts`（dispatch handler 编排）。server-next 零改动。

注：`.agentbean/` 目录建议在用户项目 `.gitignore` 中忽略（per-run 产物与本地运行历史不纳入版本控制）。

### Runtime Resolution

当前 daemon 有有用的 runtime matching rules，但 source of truth 分散在 daemon、server 与 web 中。

需要：

- 一个共享 contract 定义 adapter kinds。
- Server-side persisted config。
- Daemon-side execution resolution 与 typed error reporting。

### Directory Picker

Native directory selection 有用，但不是第一切片核心。

决策：

- 延后到 custom agent setup。

### Reconnect Guarantees

当前 reconnect 与 periodic scan behavior 存在，但精确保证尚未形式化。

需要：

- 定义 heartbeat interval。
- 定义 offline timeout。
- 定义 scan interval。
- 定义 daemon 以相同 device ID reconnect 时的 server behavior。

## 测试缺口

### 浏览器级 E2E 第一版已定义

真正浏览器级 E2E 的第一版已经落地。

已确认：

- `npm run smoke:agentbean-next-browser` 可以启动或连接 AgentBean Next 入口，用真实 Chrome 覆盖登录/session restore、刷新重订阅、custom agent 创建、message dispatch 与 agent reply 可见。
- CI 在 AgentBean Next 相关路径变更时运行 browser smoke，并上传 console log 与 screenshot artifacts。
- Browser smoke 现在也覆盖 artifact composer upload、消息内 artifact viewer、preview bytes 与 download bytes。
- Browser smoke 现在也覆盖 task create、status update 与刷新后 task list restore。

剩余：

- 浏览器 smoke 仍主要覆盖核心 chat/custom-agent、artifact 基础链路与 tasks 第一版；更完整 search、完整 task page、settings/member/device 等后续产品面需要随着切片补浏览器级证据。
- production browser smoke 与 post-flip 生产观察 baseline 已经有独立证据；后续 production logs、socket/API 错误与 rollback drill 仍属于运维观察，不等同于每次 PR 的本地/CI smoke。

### Acceptance Tests 需要优先级

`docs/acceptance-tests.md` 范围很广。

需要：

- 标出 first-slice tests 与 later-feature tests。

### Contract Tests 第一版已定义

已确认：

- `packages/contracts/tests` 覆盖核心 DTO、socket event constants、device invite、DM、artifacts/workspace runs 与 dispatch cancel event constants。

剩余：

- 后续每引入新的 HTTP route 或 product-facing DTO，都应同步补 contract fixtures 与 web/daemon 边界测试。

## 显式非缺口

这些不是缺口，因为旧兼容性被有意放弃：

- 旧 Socket.IO event names。
- 旧 SQLite schemas。
- 旧 daemon client compatibility。
- 现有本地 `.agentbean` data shape。
- Legacy `standalone-cli`。
- 没有 product spec 的 admin events。
