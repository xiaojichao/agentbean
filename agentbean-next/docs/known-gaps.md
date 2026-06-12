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

Tasks 可以拥有 `assignee_id`，但目标类型还没有完全指定。

需要决策：

- Tasks 能否分配给 humans、agents，或两者都可以？
- Assignees 是否应类型化为 `{ kind, id }`？

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

- `dispatches` model，包含 request ID、agent ID、channel ID、message ID、status、error、timestamps、timeout 与 artifact links。
- `dispatch:cancel` 会把 pending dispatch 标记为 `cancelled`，late result/error 不再改写已完成状态。
- server-next 长驻 runtime 会定期调用 `failTimedOutDispatches`，把超时 pending dispatch 标记为 `timed_out` 并广播 dispatch status。

剩余：

- Web 上的 cancel affordance 与更完整的 dispatch history/diagnostics UI 仍需后续产品切片覆盖。
- 长时间运行 adapter 的真实进程级 cancel 语义仍需要按 adapter 逐个验证。

### Workspace Runs 第一版已定义

Workspace run persistence 的第一版已经落地到 `server-next` repository/usecase 层。

已确认：

- `workspace_runs` model 记录 `teamId`、`channelId`、`messageId`、`dispatchId`、`agentId`、`deviceId` 与 `artifactIds`。
- daemon 可以在 `dispatch:result` 上报 workspace run metadata，server 会把 run 绑定到 agent reply message。

剩余：

- Web workspace run 视图与真实 HTTP download/preview handler 仍需后续 UI/API slice 覆盖。

### Threads 第一版已定义

Thread behavior 的第一版边界已经落地到 `server-next`，不再需要在 #147 中悬置数据模型选择。

已确认：

- 第一版使用 `messages.thread_id` 与 root-message convention，不引入独立 `threads` table。
- 新 root message 默认 `threadId = message.id`；thread reply 由 client 传入既有 `threadId`。
- Agent reply 继承原始 human message 的 `threadId`。
- Dispatch request 的 `history` 只包含当前 message 之前、同一 `threadId` 的 messages；当前 user input 只出现在 `prompt`，避免重复。

剩余：

- Web thread UI 与 browser E2E 仍需在后续 UI/E2E slice 中覆盖。

### Artifact HTTP 与 Access Control 第一版已定义

Artifact metadata、HTTP route 与 preview viewer 的第一版已经落地。

已确认：

- `artifacts` model 记录 `teamId`、`channelId`、`messageId`、`dispatchId`、`workspaceRunId`、filename/mime/size/path/hash metadata。
- `getArtifact` 按 team membership 与 artifact `teamId` 授权；跨 team 读取返回 `NOT_FOUND`。
- `MessageDto.artifacts` 可以投影 agent reply 的 artifact metadata。
- server-next 提供 `POST /api/teams/:teamId/artifacts/upload`、`GET /api/teams/:teamId/artifacts/:artifactId/preview` 与 `GET /api/teams/:teamId/artifacts/:artifactId/download`，upload route 支持 JSON/base64 兼容入口与 multipart form-data 产品入口。
- web-next preview 会在消息中按 workspace output 与 message attachment 分组展示 artifact 文件、workspace run id/status、cwd、device、exit code、duration、artifact count，并生成预览/下载链接。
- web-next preview composer 可以选择文件，先通过 artifact HTTP upload route 以 `FormData` 上传，再将返回的 artifact id 绑定到 human message。

剩余：

- Workspace tree 与独立 run detail 页面仍需后续 UI/API 切片。

### Search Projection

当前 message search 是直接 DB search。

需要：

- 决定第一版是否 simple SQL search 就足够。
- 除非确实需要，否则延后 full-text indexing。

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

当前 UI 有 saved/reaction local state。

需要决策：

- 作为 local-only UX 保留、server-side 持久化，或从 first release 删除。

## Daemon 缺口

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

剩余：

- 浏览器 smoke 仍主要覆盖核心 chat/custom-agent 路径与 artifact 基础链路；tasks/search、settings/member/device 等后续产品面需要随着切片补浏览器级证据。
- production browser smoke 与 24-72 小时生产观察记录仍属于运维观察，不等同于每次 PR 的本地/CI smoke。

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
