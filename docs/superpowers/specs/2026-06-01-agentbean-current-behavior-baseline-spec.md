---
title: AgentBean Current Behavior Baseline Spec
date: 2026-06-01
updated: 2026-07-10
status: current-behavior-baseline
scope: product-and-technical-spec
---

# AgentBean 当前行为基线 Spec

## 1. 文档定位

本文记录当前 AgentBean Next 源码、测试与 verification matrix 共同保护的行为合同。主产品规则以 `2026-05-09-agentbean-prd.md` 为准；PI 管理 Agent 的后续演进以 `2026-07-10-agentbean-pi-management-agent-design.md` 为准。

当前默认实现面是：

- `apps/web-next`：生产 App Router Web。
- `apps/server-next`：Express、Socket.IO 与 SQLite 协作中枢。
- `apps/daemon-next`：Device Runtime 与 CLI。
- `packages/contracts`、`packages/domain`：共享协议和领域规则。

Release A 仍验证旧栈、支持 old-target deploy，并维护 legacy daemon 发布/标签；旧栈不是默认开发或生产入口。Release B 完成源码退役后，回退才只依赖版本化 artifact。

## 2. 核心产品模型

AgentBean 只有 Team 一种协作容器。User、Device、Agent、Channel、DM、Message、Task、Artifact 与 Workspace Run 都通过 `teamId` 归属或授权。

- **User**：人类用户，具有系统角色和当前 Team。
- **Device**：某个 Team 中由 owner 管理的设备实例，可承载 runtime、自定义 Agent 与 AgentOS 托管型 Agent。
- **Agent**：Team 成员型能力，只包括自定义 Agent 与 AgentOS 托管型 Agent。
- **Channel / DM**：Team 内对话空间；DM 当前以可见 Agent 为目标。
- **Task**：可关联 Channel、DM、Message 与 assignee 的持久化协作对象。
- **Artifact / Workspace Run**：执行输入、输出、日志及其可追溯上下文。

## 3. Auth、Team 与邀请

### 注册与登录

- 注册创建 private Team、owner membership、当前 Team 与默认 `all` Channel。
- 创建 Team 同样创建 owned private Team 与默认 `all` Channel，并持久化切换当前 Team。
- 登录和注册可以消费 user join code；成功后加入目标 Team 并把它设为当前 Team。
- `auth:whoami` 从 session token 恢复 User 与当前 Team；Web 刷新后据此恢复 session 和 subscriptions。
- 修改密码要求已认证 session，并验证当前密码。

### Team 生命周期

- `team:list/create/switch/update/delete` 是唯一 Team 生命周期事件组。
- `team:switch` 只允许切到当前 User 已加入的 Team。
- 删除 Team 后，Server 选择仍可访问的 fallback Team 并更新当前 Team。
- Admin Team 入口只使用 `admin:list-teams` 与 `admin:delete-team`。

### User join 与 Device invite

- User join link 与 Device invite 是两套不同用途的凭据。
- User join link 支持 create/list/revoke/validate，并返回 `{ link, team }`。
- Device invite 支持 create/wait/complete；complete 返回 Team、Device credentials 与 device identity。
- Device login 先完成用户登录，再消费 Device invite；Web 从返回的 Team 与 credentials 取得 `teamId`、`teamPath` 与 `deviceId`。

## 4. 数据与 schema

Fresh global SQLite 使用 Team snake_case：

- `teams`
- `team_members`
- `users.current_team_id`
- `devices.team_id`
- `agents.primary_team_id`
- `device_revocations.team_id`、`profile_id`、`revoked_at`

0011 形状的 `device_revocations` 通过追加 migration 升级，必须保留普通 profile、`NULL profile_id`、复合主键和索引。已部署 migration 不直接改写；生产升级前必须备份 global DB。

Team repository 隔离频道、消息、任务、dispatch、workspace run 与 Artifact 元数据。跨 Team 读取返回 `NOT_FOUND` 或 `FORBIDDEN`，不能通过客户端传入另一个 id 绕过授权。

## 5. Web 路由与浏览器状态

- App Router 动态段是 `[teamPath]`，Team 管理入口是 `/:teamPath/teams`。
- Artifact Web proxy 只存在 `/api/teams/:teamId/...`。
- 浏览器状态只写 `agentbean.teamPath`。
- Release A 的隔离 migration helper 可以首次读取旧 key，随后写 canonical key 并删除旧 key；业务组件不直接访问旧 key。
- 旧收藏兼容只做 permanent redirect，不保留重复业务页面；Release B 删除该 redirect 和一次性 key migration。

## 6. Device 与本地 profile

Device Runtime 采用一个 profile 连接一个 Team 的模型。profile 保存 token、`teamId`、`ownerId`、扫描缓存和本地 Agent 配置；token 续签后持久化回当前 profile，重启和 reconnect 使用刷新后的 device-bound credential。

Device Web 合同分两类：

- Team-scoped 查询：Device list、subscription、Device Agent/runtime list 显式携带 `teamId`。
- Device-bound 操作：get、scan、select-directory、delete、rename 只携带 `deviceId`；Server 根据 Device record 解析 Team。get/select-directory 要求 Team 访问权，scan/rename/delete 要求 Device owner 或系统 admin 权限。

Team owner/admin 角色本身不能管理其他成员的 Device。系统 admin 仍可执行跨 owner 管理和 owner transfer。

目录选择请求必须转发给 owning Device 的 daemon。浏览器原生 picker 只用于没有目标 Device 的本机兜底，不能把远程目录选择错误地落到浏览器所在机器。

## 7. Agent 身份、分类与可见性

团队成员型 Agent 只有两类：

- AgentOS 托管型 Agent：由扫描与 Server ingest 自动注册。
- 自定义 Agent：通过 `agent:create` 显式创建，payload 必须包含 `teamId`、`deviceId`、name 及可选 runtime/command/cwd 配置。

Codex、Claude Code、Kimi CLI 等普通 executor runtime 是 Device 能力。扫描到 executor runtime 只为自定义 Agent 创建提供参数，不代表稳定 Agent identity，也不能被降级注册为 AgentOS 或自动匹配既有自定义 Agent。

Agent DTO 使用：

- `primaryTeamId`：稳定归属 Team。
- `visibleTeamIds`：当前可见 Team 集合。
- `deviceId`：承载 Agent 的 Device。

Server 与 Web 直接消费 canonical 字段，不生成 non-canonical alias、projection 或重复字段。Admin Agent 在上述字段上补 `primaryTeamName` 与 owner/device 展示字段。

## 8. Channel、membership 与 mention

### 默认与私有 Channel

- 每个 Team 有受保护的默认 `all` Channel。
- 默认 Channel 不能 archive/delete；管理能力受到比普通 Channel 更严格的限制。
- private Channel 对 creator 可见，即使创建时没有额外成员。
- private Channel 的 history、message、task、search、Artifact 与成员管理都必须检查 Channel membership。
- Channel creator 可以管理成员；非 creator 不能借 Team 角色绕过 creator 边界。
- Agent 从 Team 可见性移除时，相关默认 Channel membership 同步收敛，避免成员页、频道成员与调度权限漂移。

### Mention 与路由

- 消息开头对在线可见 Agent 的明确 mention 优先路由到该 Agent；多词名称按最长匹配。
- human mention 不触发 Agent dispatch。
- 未知 Agent mention 不回退到其他 Agent，避免误派。
- 无 mention 时可以回退到第一个 eligible online Agent；busy、offline 或不可见 Agent 不参与。
- 没有在线 Agent 时，Server 仍先持久化 human message，再返回非致命 `no-online-agent` route result；消息不会因无法 dispatch 而丢失。

## 9. DM、Thread 与消息恢复

- `dm:start` 以当前 Team 可见 Agent 为目标；不能用普通 Channel API 绕过 DM participant 限制。
- DM list、snapshot、history 与 search 只对参与者可见；非参与 Team member 不能读取。
- Agent 可见性变化后，DM 列表和搜索遵循当前可见性；已有上下文仍由专用授权 use case 控制。
- DM human message、Agent reply 与 channel event 使用同一持久化消息模型；刷新或 reconnect 后可以从 snapshot/history 恢复。
- 新 root message 默认以自身 id 作为 thread root；thread reply 和 Agent reply 继承同一 `threadId`。
- Task thread reply 路由回已分配 Agent；该 Agent offline 时不能由其他 Agent 抢占。

Dispatch request 的 `history` 只包含当前输入之前、符合 Channel/DM 与 thread scope 的消息。当前 human input 只出现在 `prompt`，不得同时出现在 history 中造成重复。

## 10. Task 行为

- Task 支持 create/list/update/reorder/delete，并持久化 Team、Channel/DM、Message、assignee、status 与 sort order。
- private Channel Task 不泄漏给非成员。
- 明确任务意图或 `asTask` 可以由消息创建关联 Task；轻量能力问答仍保留为普通消息。
- Agent 接单后先发送简短确认；正式处理和交付随后进行。
- Agent 交付后默认进入 `in_review`；只有用户明确确认后进入 `done`。
- Thread reply 延续已有 assignee，不允许无关 Agent 抢占；human assignee 的普通回复不触发 Agent dispatch。

## 11. Artifact 与 Workspace Run

Artifact HTTP 只使用 Team 路由：

- `POST /api/teams/:teamId/artifacts/upload`
- `GET /api/teams/:teamId/artifacts/:id/preview`
- `GET /api/teams/:teamId/artifacts/:id/download`
- `GET /api/teams/:teamId/workspace-runs`
- `GET /api/teams/:teamId/workspace-runs/:runId`

上传、预览、下载和 workspace 查询同时校验 session/device 身份、Team membership 与 Channel visibility。上传的 Artifact 只能绑定到同 Team/Channel 的当前 human message，不能重复绑定到其他 Message。

Workspace Run 关联 Message、Dispatch、Agent、Device、命令、cwd、状态、退出码、日志摘要与文件树。完整日志作为受控 Artifact 保存；浏览器可从 run 返回列表或触发消息。

Device 下载附件和上传产物使用 device-bound credential。附件下载或产物上传失败采用 best-effort skip，不阻断主 dispatch；当前没有单独失败状态，这部分可观测性是后续缺口。

## 12. 权限与 Admin 不变量

- 未认证 socket 只能使用明确允许的 auth/invite validation 入口。
- Team membership 控制 Team 数据访问；private Channel membership 进一步收窄可见性。
- Device owner 或系统 admin 可以管理 Device；Team owner/admin 不能自动管理他人 Device。
- Agent owner、承载 Device owner 或系统 admin 可以管理 Agent；自定义 Agent runtime 配置受 Device ownership 限制。
- 全局 admin 与 Team owner/admin 是不同权限边界。
- Admin Device projection 使用 `teamId/teamName`；Admin Agent projection 使用 `primaryTeamId/primaryTeamName/visibleTeamIds`。
- owner transfer、admin role、self-management 与最后 owner 等边界由 use case tests 保护。

## 13. 验证事实来源

上述行为由以下当前证据保护：

- `apps/server-next/tests/first-slice.test.ts`
- `apps/server-next/tests/e2e-first-slice.test.ts`
- `apps/server-next/tests/socket-integration.test.ts`
- `apps/server-next/tests/channel-controls.test.ts`
- `apps/server-next/tests/default-channel-membership.test.ts`
- `apps/server-next/tests/device-management.test.ts`
- `apps/server-next/tests/device-permissions.test.ts`
- `packages/domain/tests/domain-core.test.ts`
- `agentbean-next/docs/socket-protocol.md`
- `agentbean-next/docs/verification-matrix.md`
- `agentbean-next/docs/parity-backfill-audit.md`
- `agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`

本地 Green 不等于 production Green。Release A merge、CI、deployment、SQLite backup 和 production smoke 必须在真实发生后补录。

## 14. Release A / Release B 回退边界

Release A 的当前 workflow 仍会验证 `apps/web`、`apps/server`、`apps/daemon`，支持 old-target deploy，并维护旧 daemon 的 publish/legacy tag。默认开发、默认 npm 安装与生产流量已经使用 AgentBean Next，但不能把“默认是 Next”写成“旧源码已经退出流水线”。

Release B 删除旧源码、一次性 browser migration 与兼容 redirect 后，回退只依赖 Git 固定提交、Railway 历史 deployment 和 npm 已发布 artifact；届时不再从 `main` 构建已退役源码。
