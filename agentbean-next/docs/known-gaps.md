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

### Team vs Network

当前文档和代码同时使用 `team` 与 `network`。

需要决策：

- 为 UI 和 domain model 选择一个主要产品术语。
- 如果两者都保留，精确定义它们之间的关系。

推荐方向：

- 在 product/UI language 中使用 `team`。
- 仅在仍需要描述 infrastructure 或 isolation 时使用 `network`。

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

当前系统会为 agents、devices、networks、channels 与 DMs 发送 snapshots，但没有说明一致性保证。

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

### Dispatch 不够一等

当前 dispatch lifecycle 主要通过内存与 message metadata 协调。

需要：

- `dispatches` model，包含 request ID、agent ID、channel ID、message ID、status、error、timestamps、timeout 与 artifact links。

### Workspace Runs 建模不足

当前产品期待 agent workspace views，但 persistence 没有清晰定义。

需要：

- `workspace_runs` model。
- run、agent、device、dispatch、artifacts 与 generated files 之间的链接。

### Threads 定义不足

Thread behavior 已存在，但 data model 应显式化。

需要：

- 要么使用 `messages.thread_id` 与 root-message convention，要么使用独立 `threads` table。
- Threads 的 dispatch history rules。

### Artifact Access Control

当前 artifact metadata 需要更清晰的 network/channel/message/workspace linkage。

需要：

- Network-scoped artifact authorization。
- Message 与 workspace bindings。

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

### 尚无真正端到端测试

当前测试有用，但大多局限于单 app。

需要：

- 一个覆盖 Web-like client、Server 与 Daemon-like client 的组合测试或 smoke script。

### Acceptance Tests 需要优先级

`docs/acceptance-tests.md` 范围很广。

需要：

- 标出 first-slice tests 与 later-feature tests。

### Contract Tests

需要：

- 在 web 与 daemon 两侧边界验证 protocol DTOs。

## 显式非缺口

这些不是缺口，因为旧兼容性被有意放弃：

- 旧 Socket.IO event names。
- 旧 SQLite schemas。
- 旧 daemon client compatibility。
- 现有本地 `.agentbean` data shape。
- Legacy `standalone-cli`。
- 没有 product spec 的 admin events。
