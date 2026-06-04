---
title: AgentBean Current Behavior Baseline Spec
date: 2026-06-01
status: current-behavior-baseline
scope: product-and-technical-spec
supersedes_for_current_behavior:
  - 2026-05-09-agentbean-prd.md
  - 2026-05-09-agentbean-architecture-design.md
related_history:
  - 2026-05-29-team-daemon-profile-isolation-design.md
---

# AgentBean 当前行为基线 Spec

## 1. 文档定位

本文档描述 AgentBean 在当前代码库中的真实产品和技术行为，用作后续重构、拆分模块、补测试和重新设计架构的基线。

本文档不是旧 PRD 的续写，也不是愿景规划。旧文档只能解释项目演进背景；当旧文档和本文档冲突时，以本文档为准。

当前基线来自以下实现面：

- `apps/web`：Next.js 前端，提供团队、聊天、成员、设备、任务、Agent 和设置界面。
- `apps/server`：Express + Socket.IO 协作中枢，维护用户、团队、设备、Agent、频道、消息、任务和产物。
- `apps/daemon`：运行在用户设备上的 daemon，负责本地 profile、设备注册、能力扫描、Agent dispatch、目录选择和工作区产物同步。

本文档特别区分四类内容：

- **当前事实**：代码已经实现，重构时应保持行为。
- **兼容行为**：为了历史数据或旧 daemon 存在，重构时必须有迁移或明确移除计划。
- **不继承旧说法**：旧文档中已经过期，不能作为实现依据。
- **待确认缺口**：代码有雏形或界面入口，但产品规则还需要单独定稿。

## 2. 核心产品模型

AgentBean 当前是一个本地优先的团队 Agent 协作系统。用户加入 Team 后，可以在同一个界面中和人类成员、AgentOS 托管 Agent、自定义 Agent 协作。

核心实体如下：

- **User**：人类用户。用户有用户名、邮箱、密码哈希、角色、描述和当前团队。
- **Team / Network**：代码中主要字段名是 `network` / `networkId`，产品语义是 Team。团队有 owner、成员、路径、可见性、类型和独立数据空间。
- **Device Instance**：某台机器在某个 Team 下的设备实例。当前实现已经包含 `machineId` 和 `profileId`，但服务端主键仍是 `devices.id`。
- **Daemon Profile**：某台机器上某个 Team 对应的本地 profile。profile 持有独立 token、扫描缓存、本地 Agent 配置和工作区目录。
- **Agent**：产品上只把 AgentOS 托管 Agent 和自定义 Agent 当作团队成员。普通本地 runtime 是执行能力，不应直接作为团队成员展示。
- **Channel / DM**：团队内对话空间。公开频道、私有频道、默认 `all` 频道和 Agent DM 都落在团队空间数据库中。
- **Message**：频道或 DM 内消息，sender 可以是 human、agent 或 system。
- **Task**：团队空间内持久化任务，可和频道/消息关联。
- **Artifact / Workspace File**：Agent 或用户上传的文件产物，存储在团队空间 artifact 目录，并通过 HTTP API 预览、下载或聚合成 Agent workspace runs。

## 3. Team 与存储隔离

### 当前事实

服务端有两层存储：

- 全局数据库保存 `users`、`networks`、`network_members`、`devices`、全局 `agents`、邀请和 Agent 发布关系。
- 每个 Team 有独立 SQLite 数据库和 artifact 目录，保存频道、DM、消息、任务和 artifact 元数据。

Team 以 `networkId` 为代码级隔离键。Socket 连接会维护当前 `networkId`，多数 `/web` 事件都从当前 socket 的团队上下文取数据。

用户注册时会创建一个私有 Team，并自动加入所有 public Team。用户登录时优先进入 join code 指定 Team，其次是用户保存的 current network，其次是第一个成员 Team。

Team 支持：

- 创建、切换、改名、删除。
- public/private 可见性。
- member 关系。
- join link 和 invite code。

### 兼容行为

旧代码和旧文档使用 `network` 命名；产品文案现在更接近 Team。重构时可以逐步统一为 Team，但协议和数据库字段仍需要兼容 `networkId`。

### 不继承旧说法

旧文档中“每用户独立 SQLite 数据库”的说法不再准确。当前实际是全局库加每 Team 独立空间库。

## 4. Device Profile 与 daemon 模型

### 当前事实

Daemon 当前采用“一个 profile 连接一个 Team”的模型。它通过 `AGENTBEAN_HOME`、`AGENTBEAN_PROFILE` / `--profile`、`AGENTBEAN_PROFILE_DIR` 解析本地状态路径。

默认本地路径模型：

```text
~/.agentbean/
  auth.json                  # legacy fallback
  teams/
    {profileId}/
      auth.json
      scanned-agents.json
      agents/
```

`apps/daemon/src/profile-paths.ts` 是本地 profile 路径的事实来源。它提供：

- `agentbeanHome()`
- `profileIdForNetwork()`
- `profileRoot()`
- `authFile()`
- `scanCacheFile()`
- `localAgentsDir()`
- `deviceInstanceId(machineId, networkId)`

Daemon 连接 `/agent` 时上报：

- `token`
- `deviceId`
- `machineId`
- `profileId`
- `networkId`
- `agents`
- `systemInfo`
- `capabilities`
- `protocolVersion`
- `daemonVersion`

服务端会把设备注册到全局 `devices` 表和内存 `DeviceRegistry`。`machineId` + `networkId` 已经用于 legacy device merge，但当前服务端仍以 `deviceId` 查找在线设备。

### 兼容行为

`auth-store.ts` 会同时支持 profile auth 和 legacy `~/.agentbean/auth.json`。如果 legacy auth 存在，会映射成对应 network profile。

服务端注册设备时会尝试把 legacy machine device 合并到新的 team-scoped device id，避免旧设备记录和新设备实例并存。

### 待确认缺口

当前还没有完全把 `DeviceRegistry` 的唯一键从 `deviceId` 升级为严格的 `teamId + machineId/profileId`。这应作为后续架构重构的一项核心任务。

## 5. Agent 身份与分类

### 当前事实

当前团队成员型 Agent 只有两类：

- `agentos-hosted`：Hermes、OpenClaw 等 AgentOS/Gateway 托管 Agent。
- `custom` source 的自定义 Agent：用户绑定某台设备、runtime 和项目目录创建的团队 Agent。

普通 executor runtime，例如 Codex、Claude Code、Kimi CLI，在产品上是设备能力，不应直接作为成员 Agent 发布或显示，除非它被封装成 custom Agent。

Agent 字段包括：

- `id`
- `name`
- `role`
- `adapterKind`
- `category`
- `source`
- `deviceId`
- `networkId`
- `visibility`
- `ownerId`
- `command`
- `args`
- `cwd`
- `env`
- `description`
- `publishedNetworkIds`
- `unpublishedNetworkIds`

服务端和前端都存在 Agent 去重和身份合并逻辑。核心合并维度包括：

- Team / `networkId`
- `deviceId`
- `adapterKind`
- runtime location：`cwd` 或 command dirname
- args
- AgentOS gateway identity
- name slug fallback

当前这套规则分散在 Server 和 Web 中。重构时应抽为共享领域逻辑，避免两端继续各自修补。

### Agent ID 规则

Daemon 本地扫描 Agent 时会创建 device-local id：

```text
scan-{deviceId}-{agentSlug(name)}
```

Server 在非 default Team 中注册 scanned Agent 时会创建 network-aware id：

```text
scan-{scanSlug(networkId)}-{deviceId}-{nameSlug}
```

这个差异是历史 bug 的来源之一。后续重构必须统一“用于展示/持久化的 Agent ID”和“daemon 本地 dispatch lookup ID”的映射规则，不能靠前后端各自猜测。

### 兼容行为

当前服务端会通过 `findByDeviceAndName`、`resolveScanId`、旧 scan-prefix 清理和旧 id fallback 来兼容历史 Agent 记录。

AgentOS 托管 Agent 的名称和描述在 upsert 时会尽量保留历史配置，避免 gateway 重新扫描把用户编辑过的显示名称覆盖回通用名称。

## 6. Agent 发布与可见性

### 当前事实

Agent 可见性由三组信息共同决定：

- Agent 自己的 `networkId`。
- `agent_network_publish` 中显式发布到其他 Team 的记录。
- `agent_network_unpublish` 中从原 Team 或发布 Team 取消可见的记录。

`members:list` 和 `agents:subscribe` 只返回当前 Team 可见的团队成员型 Agent，也就是 AgentOS-hosted 或 custom Agent。

`device:agents:list` 有不同语义：它是设备管理视图。设备管理者即使已经从成员列表取消发布某个设备自有 AgentOS Agent，仍应能在设备详情中看到该 Agent，并看到 `unpublishedNetworkIds`。

### 权限边界

发布和取消发布需要用户能管理该 Agent。管理权来自：

- 系统 admin。
- Agent owner。
- Agent 所属设备 owner。

executor runtime 不能随意发布到普通 Team。当前实现限制 executor-hosted Agent 只能发布到 private 或 owner 自己拥有的 Team；但产品上应优先把 executor runtime 作为设备能力，而不是成员 Agent。

## 7. 频道、DM 与消息

### 当前事实

每个 Team 有独立频道表。频道支持：

- 默认 `all` 频道。
- 公开频道。
- 私有频道。
- 归档。
- 删除。
- 用户离开频道。
- Agent 成员。
- 用户成员。
- DM 频道。

默认 `all` 频道特殊规则：

- 永远公开。
- 不能离开。
- 不能删除。
- 不能归档。
- 不能改名。
- 不能改 visibility。
- 参与者语义是当前 Team 中所有可见 Agent 和人类成员。

私有频道规则：

- 只有创建者和显式 `channel_user_members` 可见。
- 变成 private 时，创建者会自动加入成员表。
- 非默认频道的成员管理当前只允许频道创建者执行。

DM 规则：

- DM 是 `channels` 表中的 `is_dm = 1` 频道。
- DM 目标必须是 AgentOS-hosted 或 custom Agent。
- 一个用户和一个 Agent 之间复用已有 DM。
- DM 名称跟随目标 Agent 名称更新。
- 如果 DM 目标 Agent 不再有效，`listDms` 会删除该 DM。

消息规则：

- `message:send` 会先持久化 human message，再根据路由结果决定是否 dispatch Agent。
- 支持附件 artifactIds。
- 支持 thread parent message。
- Agent dispatch history 会排除 system message，并避免把当前用户输入重复放进 history。
- `@AgentName` 触发目标 Agent；`@human` 是人类提及，不触发 Agent dispatch。
- 如果没有在线 Agent 或未知 Agent mention，会写 system message 说明消息已保存。

## 8. 任务系统

### 当前事实

任务已经持久化在每 Team 空间数据库中。任务字段包括：

- `id`
- `title`
- `description`
- `status`
- `creatorId`
- `assigneeId`
- `channelId`
- `tags`
- `sortOrder`
- `createdAt`
- `updatedAt`

状态集合：

- `todo`
- `in_progress`
- `in_review`
- `done`
- `closed`

Socket 事件包括：

- `task:create`
- `task:list`
- `task:update`
- `task:delete`
- `task:reorder`
- `task:updated`

聊天中向 Agent 发送消息或显式 `asTask` 时，可以自动创建任务。dispatch 开始时任务进入 `in_progress`，Agent 成功回复时进入 `done`，失败时进入 `in_review`。

### 不继承旧说法

旧 PRD 中“后端任务持久化尚未实现”已经过期。

### 待确认缺口

任务的产品语义还不够完整，例如 assignee 是否只能是 Agent、任务与 thread 的强绑定方式、关闭和归档规则、跨频道移动规则，都需要后续单独定稿。

## 9. Artifact 与 workspace

### 当前事实

Artifact 通过 HTTP API 上传、预览和下载：

- `POST /api/networks/:networkId/artifacts/upload`
- `GET /api/networks/:networkId/artifacts/:id/download`
- `GET /api/networks/:networkId/artifacts/:id/preview`
- `GET /api/networks/:networkId/agents/:agentId/workspace`
- `GET /api/networks/:networkId/workspace`

Artifact 存储在 Team 空间 artifact 目录。上传成功后返回 `downloadUrl` 和 `previewUrl`。

Artifact 可先上传为未绑定 message 的文件，再由 `message:send` 或 Agent reply 绑定到 message。

Workspace 文件通过 artifact `metaJson.kind = "agent-workspace-file"` 聚合成 runs。workspace API 会按 `runId` 分组，并返回文件的 pathKind、relativePath、originalPath、sha256 和 deviceId。

### 认证规则

Artifact API 接受：

- legacy agent token。
- 用户 token，且用户必须能访问该 Team；public Team 允许通过有效用户 token 访问。

## 10. 权限边界

### 当前事实

权限目前不是独立 ACL 系统，而是分散在事件 handler 中的条件判断。

主要规则：

- 未登录用户只能走登录、注册、邀请校验等入口。
- Team 成员可以看到所在 Team 的成员、频道、设备和 Agent。
- public Team 对有效用户更开放。
- 设备管理权来自设备 owner 或 admin。
- Agent 管理权来自 Agent owner、设备 owner 或 admin。
- 非默认频道的成员管理当前只允许频道创建者。
- 自定义 Agent 的运行时设置只能由本机设备上下文编辑；远程设备上的自定义 Agent 只能编辑允许的元数据。
- 系统 admin 可使用 dashboard 相关 admin 事件。

### 待重构要求

权限判断应抽出成统一 policy 层。当前事件 handler 中重复实现了 `canManageDevice`、`canViewDevice`、`canManageAgent`、`canManageChannelMembers` 等逻辑，后续继续堆功能会扩大权限不一致风险。

## 11. Socket 协议基线

### `/web` namespace

浏览器主要事件：

- Auth：`auth:register`、`auth:login`、`auth:whoami`、`auth:change-password`、`auth:invite:validate`、`auth:device-login`、`auth:join:validate`
- Invite / join：`invite:create`、`join:create`、`join:list`、`join:revoke`
- Team：`network:list`、`network:create`、`network:switch`、`network:update`、`network:delete`、`networks:snapshot`、`network:deleted`
- Agent：`agents:subscribe`、`agents:snapshot`、`agent:status`、`agent:metrics`、`agents:discover`、`agents:discovered`、`agent:create`、`agent:custom:list`、`agent:config:update`、`agent:delete`、`agent:publish`、`agent:unpublish`
- Device：`devices:subscribe`、`devices:snapshot`、`device:status`、`devices:list`、`device:get`、`device:scan`、`device:agents:list`、`device:select-directory`、`device:delete`、`device:rename`
- Member：`members:list`、`member:update-human`
- Channel：`channels:subscribe`、`channels:snapshot`、`channel:join`、`channel:history`、`channel:create`、`channel:update`、`channel:add-member`、`channel:add-agent`、`channel:remove-member`、`channel:remove-agent`、`channel:members`、`channel:leave`、`channel:archive`、`channel:delete`、`channel:stop-agents`
- DM：`dm:start`、`dm:list`、`dms:snapshot`
- Message：`message:send`、`message:search`、`channel:message`
- Task：`task:create`、`task:list`、`task:update`、`task:delete`、`task:reorder`、`task:updated`
- Admin：`admin:list-users`、`admin:delete-user`、`admin:list-networks`、`admin:delete-network`、`admin:list-devices`、`admin:transfer-device-owner`、`admin:list-agents`、`admin:delete-agent`

### `/agent` namespace

Daemon 主要事件：

- Client to server：`register`、`heartbeat`、`reply`、`error_event`、`agents:discovered`、`device:register-agents`、`device:register-runtimes`
- Server to client：`dispatch`、`dispatch:cancel`、`agents:discover`、`device:select-directory`

### 协议重构要求

当前事件 payload 和 ack 类型分散在 Server、Web 和 Daemon 中。后续应抽出共享协议包，至少覆盖：

- Event name 常量。
- Payload 类型。
- Ack 类型。
- DTO 类型。
- 错误码枚举。

## 12. 目录选择与本地设备边界

### 当前事实

当 Web 端选择项目目录且传入 `deviceId` 时，实际路径是：

```text
Web deviceEvents().selectDirectory(deviceId)
  -> Server /web device:select-directory
  -> owning daemon /agent device:select-directory
  -> native picker
```

浏览器目录选择器只是没有设备上下文时的 fallback。

macOS native picker 当前使用：

```text
osascript -e 'POSIX path of (choose folder with prompt "选择项目目录" default location (path to home folder))'
```

不应重新引入 Finder activation 或其他会把已有 Finder 窗口前置的副作用。

## 13. 不继承旧文档的内容

以下旧说法不能作为当前实现依据：

- “任务后端持久化尚未实现”：已过期。
- “standalone-cli 是当前 Agent 分类”：当前产品成员模型不应继续继承 standalone-cli。
- “Pipeline 编排是当前聊天核心”：pipeline 相关文档已归档，不代表当前实现。
- “每用户独立 SQLite 数据库”：当前实际是全局库加每 Team 空间库。
- “Daemon 只是一个物理设备连接一个团队”：当前已引入 profile、machineId、profileId 和 legacy merge，但服务端唯一键仍需继续重构。
- 旧 README 中 daemon npm 版本和部分路由说明可能过期，不能作为发布事实来源。

## 14. 后续重构边界

重构应优先保持当前行为，并按以下顺序拆分：

1. 抽出共享协议和 DTO。
2. 抽出 Agent identity / dedupe / visibility 领域逻辑。
3. 抽出权限 policy。
4. 拆分 Server `/web` namespace handlers。
5. 拆分 Web 大页面和 store 中的领域逻辑。
6. 完成 DeviceRegistry 的 team-scoped identity。
7. 为当前事实行为补端到端或集成测试。

重构期间不应顺手改变以下用户可见行为：

- Team 切换和保存 current network。
- `all` 频道特殊规则。
- DM 目标限制和 DM 名称跟随。
- 设备管理者在设备详情中看到未发布的设备自有 Agent。
- 自定义 Agent 只能在所属本地设备上编辑运行时设置。
- 目录选择走 owning daemon，而不是用户浏览器所在机器。
- Agent dispatch history 不重复包含当前输入。

## 15. 待确认产品问题

以下问题不应在重构中被隐式决定：

- Team 是否最终要完全替换代码层的 Network 命名。
- Device Instance 的公开产品文案是“设备”还是“设备 profile”。
- AgentOS 扫描 Agent 的稳定 ID 规则是否允许破坏历史 id，还是必须永久迁移兼容。
- Task 是否成为一等协作对象，还是只是聊天派生视图。
- Admin dashboard 是否保留为产品功能，还是仅作为内部维护工具。
- public Team 的访问和 artifact 权限是否符合未来生产安全要求。
- 自定义 Agent 是否允许远程编辑运行时配置，还是永久限制为本机设备上下文。

## 16. 当前验证基线

整理本文档时的验证结果：

- `apps/server`: `npm test` 通过，157 tests。
- `apps/web`: `npm test` 通过，40 tests。
- `apps/daemon`: `npm test` 通过，59 tests。
- `apps/server`: `npm run build` 通过。
- `apps/daemon`: `npm run build` 通过。
- `apps/web`: `npm run build` 通过。

这些验证说明当前行为基线可编译、可测试，但不代表行为已经架构清晰。本文档的主要用途是为后续重构提供行为边界。
