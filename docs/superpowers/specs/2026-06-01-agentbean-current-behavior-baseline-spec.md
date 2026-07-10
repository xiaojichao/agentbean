---
title: AgentBean Current Behavior Baseline Spec
date: 2026-06-01
updated: 2026-07-10
status: current-behavior-baseline
scope: product-and-technical-spec
---

# AgentBean 当前行为基线 Spec

## 1. 文档定位

本文记录 Phase -1 Release A 后可由当前源码和本地 gate 复现的产品行为。主产品规则以 `2026-05-09-agentbean-prd.md` 为准；PI 管理 Agent 的后续演进以 `2026-07-10-agentbean-pi-management-agent-design.md` 为准。

当前实现面是：

- `apps/web-next`：生产 App Router Web。
- `apps/server-next`：Express、Socket.IO 与 SQLite 协作中枢。
- `apps/daemon-next`：Device Runtime 与 CLI。
- `packages/contracts`、`packages/domain`：共享协议和领域规则。

旧源码在 Release A 只作为限时回退参考，不参与 build、deploy 或 publish。

## 2. Team 产品模型

AgentBean 只有 Team 一种协作容器。User、Device、Agent、Channel、Message、Task、Artifact 与 Workspace Run 都通过 `teamId` 归属或授权。

- 注册用户会创建 private Team 与默认频道。
- `team:list/create/switch/update/delete` 提供 Team 生命周期。
- `teams:snapshot` 提供 Team snapshot。
- `admin:list-teams` 与 `admin:delete-team` 是管理端 Team 事件。
- User 当前 Team 存在 `users.current_team_id`。

## 3. 数据与 schema

Fresh global SQLite 使用：

- `teams`
- `team_members`
- `users.current_team_id`
- `devices.team_id`
- `agents.primary_team_id`
- `device_revocations.team_id`、`profile_id`、`revoked_at`

0011 形状的 `device_revocations` 会迁移到 canonical snake_case，并保留普通 profile、`NULL profile_id`、复合主键和索引。

每个 Team 的频道、消息、任务、dispatch、workspace run 与 Artifact 元数据由 Team repository 隔离。服务层必须显式传递 `teamId`。

## 4. Web 路由与浏览器状态

App Router 动态段是 `[teamPath]`，Team 管理入口是 `/:teamPath/teams`。Artifact Web proxy 只存在 `/api/teams/:teamId/...`。

浏览器状态只写 `agentbean.teamPath`。Release A 的一次性迁移 helper 可以读取历史 key，随后写 canonical key 并删除历史 key；业务组件不直接访问历史 key。历史 Team 管理收藏入口只做 permanent redirect，不保留第二套页面实现。

## 5. Device 与 profile

Device Runtime 采用一个 profile 连接一个 Team 的模型。profile 保存 token、`teamId`、`ownerId`、扫描缓存和本地 Agent 配置。

Device login、invite、hello、list/detail、scan、rename、目录选择与自定义 Agent 创建都使用 `teamId`。Server 以 Device owner 或系统 admin 判断管理权限；目录选择发送到目标 Device，而不是默认在浏览器所在机器执行。

## 6. Agent 分类与可见性

团队成员型 Agent 包括：

- AgentOS 托管型 Agent。
- 自定义 Agent。

Codex、Claude Code、Kimi CLI 等普通 runtime 是 Device 能力；只有绑定为自定义 Agent 后才成为团队成员。

Agent DTO 使用：

- `primaryTeamId`：稳定归属 Team。
- `visibleTeamIds`：当前可见 Team 集合。
- `deviceId`：承载该 Agent 的 Device。

Admin Agent projection 在上述字段上补 `primaryTeamName` 与 owner/device 展示字段，不生成第二套空间字段。

## 7. 频道、消息与任务

- Team 有默认频道、公开频道、私有频道与 DM。
- 私有频道 membership 限制消息、任务与 Artifact 可见性。
- 任务持久化支持 create/list/update/reorder/delete。
- Agent 接单后先发送简短确认；交付后默认进入 `in_review`，用户确认后进入 `done`。
- Thread 通过 `threadId` 关联 root 与回复。

## 8. Artifact 与 workspace

Artifact HTTP 只使用 Team 路由：

- `POST /api/teams/:teamId/artifacts/upload`
- `GET /api/teams/:teamId/artifacts/:id/preview`
- `GET /api/teams/:teamId/artifacts/:id/download`
- `GET /api/teams/:teamId/workspace-runs`

Workspace Run 关联消息、Agent、Device、执行状态、命令、日志与文件树。Server 同时校验身份、Team membership 与频道可见性。

## 9. 当前验证边界

Phase -1 Tasks 1-7 已建立 contracts、Server、SQLite migration、Web client、App Router、browser storage、Device flow 与 readiness gate 的本地证据。可复现命令和精确状态记录在：

- `agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`
- `agentbean-next/docs/verification-matrix.md`
- `agentbean-next/docs/parity-backfill-audit.md`

本地 Green 不等于 production Green。Release A merge、CI、deployment、SQLite backup 和 production smoke 必须在发布后补录；未发生的生产动作不得写成已完成。

## 10. 回退边界

Release A 不从 `main` 构建旧源码。回退使用 Git 固定提交、Railway 历史 deployment 或 npm registry 中的已发布 artifact。Release B 删除旧源码和一次性兼容入口后，回退仍只依赖这些版本化 artifact。
