# AgentBean 产品需求文档（PRD）

- 日期：2026-05-09
- 版本：1.5
- 状态：AgentBean Next 已成为生产基线，持续迭代中
- 更新：2026-07-10 — 全面采用 Team 产品模型，并纳入 Device Service 与 PI 管理 Agent 目标架构

---

## 1. 产品概述

AgentBean 是一个面向人类与 Agent 协作的本地优先团队平台。人类成员、本地自定义 Agent、远程设备上的自定义 Agent，以及 AgentOS 托管型 Agent，可以在同一个 Team 中通过频道、私聊、讨论串和任务共同工作。

Team 是 AgentBean 唯一的产品与数据隔离边界。频道、消息、任务、Artifact、Workspace Run、共享记忆、Device 和 Agent 可见性都必须归属于明确的 Team。

### 1.1 核心价值

- **统一协作**：在一个 Team 内管理人类成员、自定义 Agent 和 AgentOS 托管型 Agent。
- **任务编排**：用频道消息、讨论串、任务、认领和状态历史承载多 Agent 协作。
- **本地优先**：用户项目目录、完整运行日志和本地项目记忆默认留在 Device。
- **可靠执行**：Device Service 后台常驻，管理 Agent 发现、调用、恢复、Artifact 和 Workspace Run。
- **智能管理**：内置 PI 管理 Agent 负责请求理解、任务分解、Agent 调用、结果汇总和跨 Agent 记忆编排。
- **权限正确**：Team membership、Channel visibility、Agent ownership 和 Artifact scope 由 Server 统一校验。

### 1.2 目标用户

- 希望在统一界面中使用多个 Coding Agent 的个人开发者。
- 需要人类与多个 Agent 在频道和任务中协作的团队。
- 需要将本地 Agent 与 OpenClaw、Hermes Agent 等托管 Agent 统一管理的用户。
- 重视本地 Workspace、执行记录、Artifact 和记忆边界的用户。

### 1.3 核心术语

| 术语 | 定义 |
|---|---|
| Team | 唯一的产品、权限和数据隔离边界 |
| Device | 运行 Device Service、外部 Runtime 和本地 Agent 的机器身份 |
| Device Service | Device 上的后台服务，负责连接、Agent 调用、Workspace、Artifact、恢复和 PI Manager Worker |
| Agent | Team 中可被调用或认领任务的外部执行者 |
| 自定义 Agent | 运行在 Claude Code、Codex、Kimi CLI、Gemini CLI、PI CLI 等 Coding Agent 之上的 Agent |
| AgentOS 托管型 Agent | 由 OpenClaw、Hermes Agent 等 AgentOS/Gateway 托管的 Agent |
| PI 管理 Agent | AgentBean 内部管理组件，只负责编排，不直接执行用户领域任务 |
| ManagementRun | 一次需要调用外部 Agent 的管理流程；任务型请求关联根 Task，轻问答只关联根 Message |
| Workspace Run | 外部 Agent 在明确 cwd 中的一次执行记录 |
| Artifact | 输入附件、外部 Agent 产物或 Workspace Run 日志的受控文件记录 |
| Memory | 从消息、任务、执行和 Artifact 投影出的可追溯长期上下文 |

## 2. 系统架构

### 2.1 生产基线

```text
AgentBean/
├── apps/
│   ├── server-next/   # 协作控制平面、Socket/HTTP transport、SQLite repositories
│   ├── web-next/      # 当前 Web 产品界面
│   └── daemon-next/   # 当前 Device 兼容实现，目标迁移为 Device Service
├── packages/
│   ├── contracts/     # DTO、Socket event、错误码
│   └── domain/        # 纯领域规则
└── docs/superpowers/  # PRD、设计与实施计划
```

`apps/server`、`apps/web` 和 `apps/daemon` 是历史实现，不再作为新产品行为的事实来源。所有新增能力以 Next 应用和共享 packages 为准。

### 2.2 三层职责

#### AgentBean Server

Server 是协作事实源，负责：

- 用户认证和 Team membership。
- Team、Channel、DM、Message 和 Task 持久化。
- Device identity、Agent identity、Agent visibility 和在线状态。
- 路由、Dispatch、Task claim 和状态机。
- Artifact 元数据、下载授权和 Workspace Run 投影。
- 共享 Memory 的权限、来源、状态和审计。
- ManagementRun、Task DAG、Manager lease 和 Agent invocation。

#### AgentBean Web

Web 是交互与投影层，负责：

- 登录、Team 切换和 Team 管理。
- 频道、DM、讨论串和消息交互。
- Agent、Device、Task、Artifact、Workspace Run 和 Memory 页面。
- 展示 Server 下发的 snapshot、状态事件和执行详情。

Web 不自行推断权限、Agent 归属、Task 真相或跨 Agent 路由结果。

#### AgentBean Device Service

Device Service 是 Device bridge，负责：

- 后台启动、重连、升级和诊断。
- 每个 Team/Profile 独立 Runner。
- Runtime 与外部 Agent 扫描。
- 自定义 Agent 调用和 AgentOS Connector。
- Workspace Run、输入附件、Artifact 收集与补报。
- 本地 Workspace Memory。
- Device-hosted PI Manager Worker。

### 2.3 PI 管理 Agent 与外部执行 Agent

PI 只用于 AgentBean 内部管理事务：

- 理解用户请求。
- 检索权限允许的协作记忆。
- 查询团队 Agent 能力和状态。
- 定向调用外部 Agent。
- 分解复杂任务并发布可认领子任务。
- 等待、重试、重派和汇总外部结果。
- 提交根任务交付并等待用户审核。

PI 管理 Agent 不具备 shell、文件读写、浏览器或项目代码工具。没有合适外部 Agent 时，它必须报告阻塞或请求用户输入，不能自行完成用户领域任务。

用户具体任务仍由两类外部 Agent 执行：

1. 自定义 Agent。
2. AgentOS 托管型 Agent。

详细设计见 `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`。

### 2.4 Team 命名合同

Team 语义必须贯穿文档、代码、协议、路由和数据库：

- 领域对象：`Team`、`TeamDto`、`TeamRecord`。
- 标识符：`teamId`、`primaryTeamId`、`visibleTeamIds`、`currentTeamId`。
- Web 路由：`teamPath`。
- HTTP 路径：`/api/teams/:teamId/...`。
- 数据库：`teams`、`team_members`、`team_id`、`current_team_id`、`primary_team_id`。
- Socket commands：`team:list`、`team:create`、`team:switch`、`teams:snapshot`。
- 本地状态键和测试 fixture 使用 Team 命名。

新代码不得引入 Team 的历史同义命名。迁移完成标准是产品代码、共享 contracts、数据库 schema、路由参数、持久化键和测试中只保留 Team 术语；兼容别名必须有明确删除版本，且不能出现在用户可见响应中。

## 3. 数据与隔离架构

### 3.1 Global DB

Global DB 保存跨 Team 但仍有明确 Team 归属的身份和配置：

| 表 | 用途 |
|---|---|
| `users` | 用户身份、认证信息和 `current_team_id` |
| `teams` | Team 定义、owner、名称、path 和可见性 |
| `team_members` | 用户与 Team 的 membership 和 role |
| `join_links` | 用户加入 Team 的邀请链接 |
| `device_invites` | Device 接入 Team 的一次性邀请 |
| `devices` | Device identity、owner、machine/profile 和状态 |
| `device_runtimes` | Device 上发现的 Runtime |
| `device_revocations` | 被撤销的 Device 凭据边界 |
| `agents` | Agent identity、配置、owner、primary Team 和状态 |
| `agent_identity_links` | 扫描、Gateway 和自定义 Agent 身份关联 |
| `agent_publications` | Agent 对额外 Team 的显式可见关系 |

所有 Team 归属列使用 `team_id` 或 `primary_team_id`。用户当前 Team 使用 `current_team_id`。

### 3.2 Team DB

每个 Team 使用独立的 Team 数据空间，保存协作内容：

| 表 | 用途 |
|---|---|
| `channels` | 公开频道、私有频道和 DM channel |
| `channel_human_members` | 频道人类成员 |
| `channel_agent_members` | 频道 Agent 成员 |
| `messages` | 频道、DM 和讨论串消息 |
| `dispatches` | Server 到外部 Agent 的调用状态 |
| `tasks` | Task、assignee、状态、频道和排序 |
| `artifacts` | 输入、生成文件和运行日志元数据 |
| `workspace_runs` | 外部 Agent 执行记录 |
| `message_reactions` | 消息 reaction |
| `saved_messages` | 用户收藏消息 |
| `pinned_messages` | 频道置顶消息 |

后续 PI 管理 Agent 切片增加：

- `management_runs`
- `management_events`
- `manager_leases`
- `task_dependencies`
- `task_claim_leases`
- `agent_invocations`
- Memory 相关表

### 3.3 隔离规则

1. 所有 Team DB 读写必须携带明确 `teamId`。
2. Server 先验证 Team membership，再验证 Channel visibility。
3. DM 只对参与人类和目标 Agent 可见。
4. Device token 必须绑定 Team、owner、machine/profile，并在可用时绑定 canonical deviceId。
5. Agent 只能在 `visibleTeamIds` 范围内展示、被调用或认领任务。
6. Artifact 必须同时满足 Team 和 Channel 可见性。
7. Workspace Run 必须关联 Team、Channel、Dispatch、Agent 和 Device。
8. Memory 先做 Team/Channel/DM/Agent/User scope 硬过滤，再做相关性排序。
9. 删除 Team 时必须级联清理 Team DB 内容、Agent 可见关系、Device invite 和共享 Memory。

## 4. 用户、Team 与成员

### 4.1 注册和登录

- 用户使用用户名和密码注册。
- 密码使用 `scrypt` 哈希，不保存明文。
- 注册创建用户的初始 private Team 和默认 `all` 频道。
- 登录返回用户 session 和当前 Team。
- `currentTeamId` 必须指向用户仍然加入的 Team，否则回退到可用 Team。

### 4.2 Team 管理

- 用户可以创建 Team。
- Team 创建者成为 owner。
- Team 创建时自动建立默认频道。
- 用户可以通过 join link 加入 Team。
- Team owner/admin 可以管理成员角色和移除成员。
- 用户可以在已加入的 Team 之间切换。
- 删除 Team 属于高风险操作，必须二次确认并展示影响范围。

### 4.3 成员模型

Team 成员页统一展示：

- 人类成员。
- Team 中可见的外部 Agent。

内置 PI 管理 Agent 是系统基础设施，不作为 Team 成员展示，也不参与普通 @mention。

## 5. Device 与 Device Service

### 5.1 Device 接入

1. 用户在 Web 创建 Device invite。
2. 用户在目标机器运行 Device 安装或接入命令。
3. Device Service 使用 invite 完成认证。
4. Server 返回绑定 Team、owner、machine/profile 的 Device 凭据。
5. Device Service 使用凭据连接 `/agent` namespace。
6. Device 上报 Runtime、Agent 和 capability snapshot。

用户 join link 与 Device invite 是两种独立凭据，不能混用。

### 5.2 Device 状态

- Device 状态来自当前有效 Socket 和 heartbeat/lastSeenAt。
- Device 下的 Agent 状态不能仅由历史扫描结果推导。
- Device 断开时，Server 将受影响 Agent 标记为离线。
- Device reconnect 后重新上报 canonical snapshot。
- 删除 Device 后，Server 通知 Device Service 停止重连并清理凭据。

### 5.3 Profile 隔离

- 一个 Team/Profile 对应一个独立 Runner。
- Token、缓存、Workspace、Memory 和进程状态不得跨 Profile 混用。
- 单个 Runner 崩溃不能影响其他 Runner。
- Device Service 负责 Runner 重启、退避和 degraded 状态。

### 5.4 后台服务目标

Device Service 支持：

```text
agentbean device install
agentbean device start
agentbean device stop
agentbean device restart
agentbean device status
agentbean device logs
agentbean device doctor
agentbean device update
agentbean device uninstall
```

关闭终端和设备重启后，Device Service 应继续或自动恢复运行。

## 6. Agent 管理

### 6.1 Agent 分类

产品层只使用两类外部 Agent：

#### 自定义 Agent

- 运行在 Coding Agent 或用户自定义命令之上。
- 绑定明确 Device、adapter、command、args 和可选 cwd。
- 由 Device Service 调用并管理 Workspace Run。

#### AgentOS 托管型 Agent

- 由 AgentOS/Gateway 托管。
- 通过 Gateway Connector 上报 identity、capability 和状态。
- AgentBean 不控制其内部 Runtime。

### 6.2 Agent Identity

- Agent identity 必须稳定，不因重复扫描创建重复成员。
- 自定义 Agent 使用持久化 Agent ID。
- 扫描结果使用 machine/profile、Device、adapter、normalized name 和 Gateway instance key 解析 identity。
- 删除 Agent 使用 soft delete，旧扫描结果不得自动复活已删除 Agent。
- canonical alias 必须归并到同一 Agent。

### 6.3 Agent 可见性

- `primaryTeamId` 表示 Agent 的主要归属 Team。
- `visibleTeamIds` 表示 Agent 当前可以出现和被调用的 Team。
- Team 内隐藏使用 `agent:set-visibility` 语义。
- Agent visibility 是 Server 事实，Device 不自行决定。
- Agent 只在可见 Team 的成员、频道、DM、任务和搜索结果中出现。

### 6.4 Agent Skills 与 Capability

- Device Service 扫描自定义 Agent 可用 Skills。
- Agent 详情展示 skill name、description、scope 和来源。
- Capability Registry 综合显式配置、Skills、adapter 能力和历史成功任务。
- 自动推断 capability 只用于候选排序，不能扩大权限。

## 7. 频道、消息与讨论串

### 7.1 Channel 类型

- 默认频道：Team 创建时建立，所有 Team 成员可见。
- 公开频道：Team 成员可发现和加入。
- 私有频道：仅显式成员可见。
- DM：人类用户与目标 Agent 的特殊私有 Channel。

### 7.2 Message

- Message 必须持久化到所属 Team DB。
- 支持 Markdown、mention、附件、reaction、收藏、置顶、编辑和软删除。
- 软删除消息不能继续 reaction、收藏、置顶、转任务或作为 Artifact/Run 投影入口。
- 搜索必须先确定用户可见的 Channel 集合。
- 搜索和 deep link 可以加载目标消息的 thread context。

### 7.3 Thread

- 顶层消息保留在频道主时间线。
- 明确任务和长执行输出进入讨论串。
- 普通轻问答保持在主时间线，不因存在外部 Agent 回复就自动转任务。
- Thread 负责人优先继承 Task assignee 或最近有效外部 Agent。

### 7.4 多 Agent 路由优先级

1. **显式点名优先**：`@AgentName` 只调用被点名 Agent。
2. **任务归属优先**：有 assignee 或 claimant 时由负责人继续处理。
3. **线程上下文负责人优先**：未重新点名时沿用原负责人。
4. **DM 目标优先**：DM 只调用目标 Agent。
5. **状态与可达性约束**：只调用当前 Team 可见、在线且可达的 Agent。
6. **可执行工作先认领**：开放任务必须 claim 成功后才执行。
7. **普通聊天克制响应**：已有有效回复后其他 Agent 不重复刷屏。

系统消息、管理事件、Task 状态事件和 Dispatch 结果不得被重新当作用户请求。

## 8. Task 与跨 Agent 协作

### 8.1 Task 状态

```text
todo -> in_progress -> in_review -> done
  \         |             |
   \--------+-----------> closed
```

- `todo`：等待处理或认领。
- `in_progress`：已分配/认领并正在执行。
- `in_review`：外部 Agent 已交付，等待审核。
- `done`：审核确认完成。
- `closed`：取消或不再继续。

### 8.2 认领与分配

- Task 可以分配给人类或外部 Agent。
- 未分配 Task 可以由能力匹配的外部 Agent 认领。
- claim 必须由 Server 原子执行，同一时刻只有一个成功者。
- claim 失败的 Agent 不得继续执行同一 Task。
- 转交、取消认领、重派和状态变化必须可追溯。
- Agent 交付后默认进入 `in_review`；用户明确确认根 Task 后才进入 `done`。

### 8.3 接单确认

任务成功派发后，线程中先发送简短接单确认。确认只表示已接住，不是正式交付。正式执行、进度和结果随后进入同一线程。

### 8.4 PI 管理 Agent

- 所有需要调用外部 Agent 的请求创建 `ManagementRun`。
- 普通轻问答不创建 Task，由 PI 管理 Agent 定向调用外部 Agent。
- 复杂请求创建根 Task，并允许 PI 生成有限深度、无环 Task DAG。
- 子 Task 可以公开认领或定向分配。
- 子 Task 由 PI 管理 Agent 按验收条件审核。
- 根 Task 汇总交付后进入 `in_review`，仍由用户最终确认。
- PI Worker 失联后，Server 从 Management Event、Task DAG 和 Invocation 结果恢复。

## 9. Agent Invocation

### 9.1 统一生命周期

自定义 Agent 和 AgentOS 托管型 Agent 都映射到同一调用生命周期：

```text
queued -> sent -> accepted -> running
  -> succeeded | failed | cancelled | timed_out
```

每次调用关联：

- Team、Channel、Message。
- 可选 ManagementRun、根 Task 和子 Task。
- 目标 Agent 和所属 Device/Gateway。
- 输入附件和 Memory Capsule。
- Workspace Run、Artifact 和最终结果。
- attempt、deadline 和 idempotency key。

### 9.2 Capability 协商

Adapter 可以声明：

- streaming
- cancel
- steer
- persistent session
- attachments
- structured result
- skills/capabilities

不支持的能力必须保守降级。补充要求无法 steer 时创建 follow-up invocation。

## 10. Workspace Run 与 Artifact

### 10.1 Workspace Run

- 每次自定义 Agent 执行使用独立 Run 目录。
- Run 记录 command、cwd、status、startedAt、completedAt、exitCode 和脱敏 log excerpt。
- 完整 stdout/stderr 以受控日志 Artifact 保存，不直接塞入频道消息。
- Device 重启或断线后，未上报终态可以从 manifest 恢复并补报。

### 10.2 Artifact

- 用户附件先上传 Server，再按 Dispatch 下载到 Run input 目录。
- 外部 Agent 输出从 Run output 和允许的生成目录收集。
- Artifact 记录 filename、mimeType、size、sha256、relativePath 和 storagePath。
- Preview、download 和列表都必须执行 Team membership 与 Channel visibility 校验。
- 用户源代码目录不是 AgentBean 管理的可删除 Artifact 空间。

## 11. Memory

### 11.1 分层

- Role：Agent 身份、职责、Skills 和默认行为。
- Key Knowledge：Team 协作记忆与 Device 本地项目记忆。
- Active Context：当前 Message、Thread、Task、Attachment、Memory Capsule 和 Run 状态。

### 11.2 事实源与权限

- Message、Task、Artifact、Workspace Run 和 Agent Invocation 是事实源。
- Memory 是可编辑、可废弃和可替代的投影。
- Server 只保存协作级 Memory。
- Device 本地项目 Memory 默认不上报。
- 检索先做权限过滤，再做关键词、embedding 或其他排序。

### 11.3 跨 Agent Memory

- PI 管理 Agent 为每次外部调用生成最小必要 Memory Capsule。
- Capsule 只包含目标 Agent 完成当前 Task/Invocation 所需内容。
- 外部 Agent 可以返回带来源的 Memory Candidate。
- 强规则、Team 决策、冲突和敏感摘要默认等待确认。
- 跨 Agent 共享不等于共享其他 Agent 的私有 Session、DM 或本地 Workspace 历史。

详细设计见 `docs/superpowers/specs/2026-07-06-agentbean-memory-design.md`。

## 12. 协议要求

### 12.1 `/web` namespace

核心 commands/events：

| 范围 | Commands / Events |
|---|---|
| Auth | `auth:login`、`auth:register`、`auth:whoami` |
| Team | `team:list`、`team:create`、`team:switch`、`teams:snapshot` |
| Member | `members:list`、`member:update-role`、`member:remove` |
| Device | `device:list`、`device:get`、`device:scan`、`devices:snapshot` |
| Agent | `agents:subscribe`、`agent:create`、`agent:set-visibility`、`agents:snapshot` |
| Channel | `channels:subscribe`、`channel:create`、`channel:message`、`channel:history` |
| Message | `message:send`、`message:search`、`message:context`、`message:edit`、`message:delete` |
| Task | `task:list`、`task:create`、`task:update`、`task:delete`、`tasks:snapshot` |
| Dispatch | `dispatch:cancel`、`dispatch:cancel-channel`、`message:dispatch-status` |

所有 authenticated command 从 Socket session 派生 userId，不信任客户端自由指定身份。

### 12.2 `/agent` namespace

核心 Device commands/events：

| 范围 | Commands / Events |
|---|---|
| Device | `device:hello`、`device:runtimes`、`device:scan-requested`、`device:removed` |
| Agent | `agent:register-batch`、`agent:report-custom-skills` |
| Dispatch | `dispatch:request`、`dispatch:accepted`、`dispatch:cancel`、`dispatch:result`、`dispatch:error` |

Device event payload 必须携带或由凭据派生明确 Team scope。Server 必须验证 Device、Agent 和 Team 绑定。

### 12.3 HTTP

- `/api/teams/:teamId/artifacts/upload`
- `/api/teams/:teamId/artifacts/:artifactId/preview`
- `/api/teams/:teamId/artifacts/:artifactId/download`
- Health、readiness 和 production smoke endpoints

HTTP artifact 路由使用与 Socket 相同的 Team 和 Channel 授权规则。

## 13. 安全需求

1. 密码使用 `scrypt` 哈希。
2. 用户 session、Device credential 和 invite 使用不同 token purpose。
3. Device credential 绑定 Team、owner、machine/profile 和 canonical identity。
4. 私有 Channel 和 DM 的权限在 Server 强制执行。
5. Artifact storage path 不得接受用户任意绝对路径。
6. Workspace 下载必须阻止目录穿越和符号链接越界。
7. 自定义 Agent 环境变量由 Device 按 `envRef` 拉取，不通过普通频道消息传播。
8. PI 管理 Agent 只加载内置管理工具和签名扩展，不加载 coding tools。
9. 所有管理工具从 ManagementRun 派生 scope，并使用 lease 和 idempotency key。
10. 删除 Team、Device、Agent、Memory 或 Artifact 前必须展示真实影响范围。

## 14. 非功能需求

- **可靠性**：Server、Device 和外部 Agent 断线可恢复；终态通过 outbox 幂等补报。
- **一致性**：Team、Task、Dispatch、ManagementRun 和 Memory 有单一事实源。
- **隔离性**：Team 数据、Device profile、Workspace Run 和 Memory scope 不串用。
- **可观测性**：记录调用耗时、状态、模型用量、Task DAG、重派、恢复和 Artifact。
- **可扩展性**：新增外部 Agent adapter 不改变 Team、Task、Memory 和 Invocation 事实模型。
- **可测试性**：Domain rules 可脱离 Socket、文件系统和 SQLite 单测。
- **可迁移性**：旧字段和兼容入口有明确移除版本，不能成为新增产品 API。
- **可用性**：频道主时间线保持克制，长执行和管理事件进入线程或详情面板。

## 15. 交付路线

### Phase A：当前 AgentBean Next 基线

- Team、用户、成员和切换。
- Device invite、identity、runtime 和 Agent snapshot。
- Channel、DM、Message、Thread、Task 和搜索。
- 自定义 Agent 与 AgentOS Connector。
- Dispatch、Workspace Run、Artifact 和恢复。
- Agent Skills、状态、可见性和基础指标。

### Phase B：Device Service

- 后台安装、启动、停止、状态、日志和诊断。
- 每个 Team/Profile 独立 Runner。
- 自包含二进制、升级和回滚。
- 旧前台进程配置和凭据迁移。

### Phase C：PI 管理 Agent

- PI SDK wrapper 和无 coding tools 安全边界。
- Device-hosted Manager Worker。
- ManagementRun、lease 和单外部 Agent 调用。
- 轻问答与任务型请求统一经过管理调用。

### Phase D：多 Agent 协作

- Task DAG、dependency、claim lease 和 capability matching。
- 子 Task 认领、验收、重派和根 Task 汇总。
- 跨 Agent Memory Capsule 和 Candidate。

### Phase E：混合 Manager Worker Pool

- Server-hosted Manager Worker。
- managed/device/auto placement。
- 跨 host checkpoint 恢复。
- 预算、容量、费用和隐私策略。

## 16. 总体验收标准

- 产品文案、领域对象、共享 contracts、路由、持久化键和数据库 schema 统一使用 Team 术语。
- 全部业务数据都能追溯到明确 Team。
- Server 对 Team membership 和 Channel visibility 做强制校验。
- Device Service 在关闭终端和设备重启后继续运行。
- 自定义 Agent 与 AgentOS 托管型 Agent 使用统一 Invocation 生命周期。
- PI 管理 Agent 只能管理和调用外部 Agent，不能直接执行用户领域任务。
- 普通轻问答不创建 Task；复杂任务可以生成有界 Task DAG。
- 多 Agent 同时 claim 时只有一个成功。
- 外部 Agent 原始结果、Workspace Run 和 Artifact 正确归因。
- 根 Task 交付后进入 `in_review`，用户明确确认后才进入 `done`。
- 跨 Agent Memory 不越过 Team、Channel、DM、Agent 和 User scope。
- Worker、Device 或外部 Agent 掉线后，已持久化任务和结果能够恢复。
- 用户源代码目录不因 Team、Device、Agent 或 Workspace Run 删除而被误删。
