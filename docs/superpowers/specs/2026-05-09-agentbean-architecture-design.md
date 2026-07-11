# AgentBean 架构设计文档

**日期：** 2026-05-09
**最后校准：** 2026-07-10
**状态：** 当前 Team 产品合同摘要；完整产品规则以 `2026-05-09-agentbean-prd.md` 为准

## 1. 系统边界

AgentBean 只有 Team 一种协作容器。Web、Server 与 Device Runtime 通过 HTTPS、Socket.IO 和共享 contracts 协作；所有成员、频道、任务、设备、Agent 与 Artifact 都归属于 Team。

```text
Human ── HTTPS / Socket.IO ──> apps/web-next
                                   │
                                   ▼
                             apps/server-next
                              │           │
                         SQLite/Files   /agent Socket.IO
                                          │
                                          ▼
                                    apps/daemon-next
                                     │          │
                               Custom Agent   AgentOS Agent
```

- `apps/web-next` 是生产 App Router Web，动态段统一为 `[teamPath]`，Team 管理入口为 `/:teamPath/teams`。
- `apps/server-next` 是协作中枢，负责身份、Team 权限、消息、任务、Device、Agent、Artifact 和调度状态。
- `apps/daemon-next` 是当前 Device Runtime，按 Team profile 保存身份并连接 `/agent` namespace。
- `packages/contracts` 定义 DTO、Ack、事件名与错误码；`packages/domain` 保存无 transport 依赖的领域规则。

## 2. Team 数据模型

全局 SQLite 保存跨 Team 实体和索引，核心表与字段使用 Team snake_case：

- `teams`
- `team_members`
- `users.current_team_id`
- `devices.team_id`
- `agents.primary_team_id`
- `device_revocations.team_id`

每个 Team 的协作数据由 Team repository 管理，包括频道、频道成员、消息、任务、dispatch、workspace run 与 Artifact 元数据。Repository 和 use case 必须显式接收 `teamId`，不能依赖 non-canonical alias 或重复标识。

## 3. Socket 与 HTTP 合同

Browser 连接 `/web`，Device Runtime 连接 `/agent`。共享事件常量是唯一事件名来源。

Team 与 admin 的关键事件包括：

- `team:list`、`team:create`、`team:switch`、`team:update`、`team:delete`
- `teams:snapshot`
- `admin:list-teams`、`admin:delete-team`

Admin Device projection 使用 `teamId`、`teamName`；Admin Agent projection 使用 `primaryTeamId`、`primaryTeamName`、`visibleTeamIds`。Server 和 Web 不再生成同义字段。

Artifact HTTP 只使用 Team 路由：

- `POST /api/teams/:teamId/artifacts/upload`
- `GET /api/teams/:teamId/artifacts/:artifactId/preview`
- `GET /api/teams/:teamId/artifacts/:artifactId/download`
- `GET /api/teams/:teamId/workspace-runs`

每个请求都要同时验证 session/device 身份、Team membership 与频道可见性。

## 4. Web 状态与路由

Web 从 `[teamPath]` 解析当前 Team，并通过 canonical Team API 取回 `teamId`。浏览器持久化只写 `agentbean.teamPath`。

Release A 允许隔离 helper 首次读取旧 key、写入 `agentbean.teamPath` 后立即删除旧 key；业务组件不得直接读取或写入旧 key。旧收藏兼容只保留一次 permanent redirect，不保留第二份页面实现。

## 5. Device 与 Agent

Device 是 AgentBean 的统一设备概念。Team-scoped 的 list 与 Agent 列表查询显式携带 `teamId`；device-bound 的 get、scan、select-directory、delete、rename 只携带 `deviceId`，由 Server 解析 Device 与归属 Team。get/select-directory 校验 Team 访问权，scan/rename/delete 校验 Device owner 或系统 admin 权限。Device invite/login 返回 Team 与 Device credentials；自定义 Agent 创建显式携带 `teamId` 与 `deviceId`。

Agent 只有两类产品形态：

- 自定义 Agent：绑定 Device 上的 Coding Agent runtime 和工作目录。
- AgentOS 托管型 Agent：由 OpenClaw、Hermes 等外部 AgentOS / Gateway 托管。

普通 Coding Agent runtime 是 Device 能力，不直接成为 Team 成员。Agent DTO 使用 `primaryTeamId` 表示稳定归属，使用 `visibleTeamIds` 表示当前可见 Team 集合。

## 6. Artifact 与 workspace

Device 收集执行产物后上传到 Team-scoped Artifact API。Server 保存文件与元数据，并通过 workspace run 把触发消息、Agent、Device、命令、状态、日志和文件树关联起来。

Artifact 的上传、预览、下载和 workspace 查询都只接受 Team 路由；Web proxy 也只暴露 `/api/teams/:teamId/...`。

## 7. 安全与隔离

- Team membership 是协作数据授权边界。
- Device owner 与系统 admin 是 Device 管理授权边界。
- Agent owner、Device owner 与系统 admin 是 Agent 管理授权边界。
- 私有频道成员关系继续限制消息、任务和 Artifact 可见性。
- Server 负责权限判断，Web 只负责交互与展示。

## 8. Release A 回退边界

Phase -1 Release A 期间，当前 workflow 仍验证旧栈、支持 old-target deploy，并维护 legacy daemon 发布/标签；默认开发和生产流量仍以 AgentBean Next 为准。

Release B 会移除旧源码和一次性 Web 兼容入口；从那时起回退只依赖 Git、Railway 与 npm artifact，不再从 `main` 重建已退役源码。生产证据在 Release A 发布后写入 Phase -1 验收矩阵，不用本地验证替代生产事实。

## 9. 事实来源

- 产品合同：`docs/superpowers/specs/2026-05-09-agentbean-prd.md`
- PI 管理 Agent 架构：`docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`
- Phase -1 计划：`docs/superpowers/plans/2026-07-10-agentbean-phase-minus-1-team-terminology.md`
- Phase -1 验收：`agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`
- Socket 合同：`agentbean-next/docs/socket-protocol.md`
- 总体验证：`agentbean-next/docs/verification-matrix.md`
