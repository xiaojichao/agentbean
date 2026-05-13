# AgentBean 产品需求文档 (PRD)

**日期:** 2026-05-09
**版本:** 1.2
**状态:** Phase 0-3 已完成，Phase 4+ 进行中
**更新:** 2026-05-12 — 移除 standalone-cli、Agent 去重、scanner PATH 扩展、周期重扫

---

## 1. 产品概述

AgentBean 是一个多 Agent 协作平台，支持用户在一个统一界面中管理、调度多个 AI Agent。它采用 Tailscale 网络隔离架构，每个用户拥有私有网络，通过 Web UI + Socket.IO 实现实时通信，支持频道式聊天、Agent 编排和任务管理。

### 1.1 核心价值

- **多 Agent 编排**：同时管理 codex、claude-code、openclaw 等多种 Agent
- **网络隔离**：每用户独立 SQLite 数据库，通过 Tailscale mesh 网络实现私有部署
- **实时协作**：Socket.IO 驱动的频道系统，支持人与 Agent 的混合对话
- **多网络发布**：Agent 可发布到用户加入的多个网络

### 1.2 目标用户

- 开发者和团队，需要在同一界面中调度多个 AI Agent
- 需要 Agent 协作的场景（编码、审查、设计等）

---

## 2. 系统架构

### 2.1 仓库结构

```
AgentBean/
├── apps/
│   ├── server/     # Express + Socket.IO 服务端
│   ├── web/        # Next.js 前端
│   └── daemon/     # 设备端 Daemon（原 agent/，2026-05-12 重命名）
└── docs/superpowers/  # PRD/Specs/Plans
```

### 2.2 技术栈

| 层 | 技术 |
|---|---|
| 服务端 | Express + Socket.IO + better-sqlite3 |
| 前端 | Next.js App Router + Tailwind CSS + Zustand |
| Agent 端 | TypeScript + node-pty (codex) + child_process (claude-code) |
| 数据库 | SQLite (全局 DB + 每网络独立 DB) |
| 网络 | Tailscale mesh 网络 |
| 认证 | 用户名密码 (scrypt) + JWT + 设备三截 token |

### 2.3 数据库架构

**全局 DB**（`global.db`）：
- `users` — 用户信息
- `networks` — 网络定义
- `network_members` — 用户-网络关联
- `agents` — Agent 全局注册
- `agent_network_publish` — Agent 多网络发布
- `invites` — 邀请码
- `join_links` — 加入链接
- `devices` — 设备注册
- `agent_metrics` — Agent 性能指标

**每网络 DB**（`<networkId>.sqlite`）：
- `channels` — 频道定义（含 visibility、created_by）
- `channel_agents` — 频道-Agent 关联
- `channel_user_members` — 私有频道用户成员
- `messages` — 消息记录
- `artifacts` — 文件附件

---

## 3. 功能需求

### 3.1 用户系统

#### 3.1.1 注册/登录
- 用户注册：用户名 + 密码（scrypt 加密），自动创建私有网络
- 用户登录：用户名 + 密码 → JWT token
- 邀请注册：通过邀请链接加入他人网络

#### 3.1.2 网络管理
- 每个用户拥有至少一个私有网络
- 通过邀请码/加入链接加入他人网络
- 网络成员管理：查看、移除成员
- 网络可见性：公开/私有

### 3.2 Agent 管理

#### 3.2.1 Agent 注册协议
Agent 通过 `/agent` Socket.IO 命名空间注册到服务端：
- 设备端 Daemon 启动 → 扫描本地 Agent 运行时 → 注册到所属网络
- 注册时验证：设备 token (userId:networkId:random) 或用户 JWT
- 支持断线重连（同 agentId 替换旧 socket）

#### 3.2.2 Agent 分类
- `executor-hosted`：codex (node-pty)、claude-code (spawn)、kimi-cli (spawn)
- `agentos-hosted`：hermes (gateway)、openclaw (gateway)

> 注：`standalone-cli` 分类已于 2026-05-12 移除，所有 Agent 统一归入上述两类。

#### 3.2.3 多网络发布
- Agent 属于创建者的私有网络（主网络）
- 可发布到用户加入的其他网络
- `agent_network_publish` 多对多关联表
- 网络内的 `agents:subscribe` 返回：主网络 Agent + 已发布 Agent

#### 3.2.4 Agent 扫描
设备端 Daemon 的三层扫描器：
- PATH 运行时扫描：检测 claude-code、codex、kimi-cli 等 CLI 是否已安装
  - PATH 扩展：自动包含所有 nvm Node 版本的 bin 目录（解决跨版本 CLI 检测）
- AgentOS 网关扫描：检测 Hermes、OpenClaw 等网关注册的 Agent
- 本地文件系统扫描：检测 `~/.agentbean/agents/` 配置文件中定义的 Agent

**周期重扫：** Daemon 每 5 分钟自动重新扫描，服务端标记消失的 Agent 为离线。

#### 3.2.5 Agent 去重
两条注册路径可能注册同一 Agent（`register` 事件使用 Daemon 自定义 ID，`device:register-agents` 使用 `scan-{deviceId}-{name}` ID）：
- `findByDeviceAndName(deviceId, name)` 按设备+名称查找已有注册
- 已存在则更新 DB 而不创建重复条目
- `resolveScanId(scanId)` 解析旧的 scan-prefix ID，用于 channel_members 回退查找

### 3.3 频道系统

#### 3.3.1 频道类型
- **公开频道**：网络内所有用户可见
- **私有频道**：仅被邀请的用户可见（通过 `channel_user_members`）

#### 3.3.2 消息系统
- 消息类型：`human`、`agent`、`system`
- 消息中的 @mention 高亮显示
- 消息持久化（per-network SQLite）
- 人类消息的 `senderId` 从 JWT/Socket context 填入

#### 3.3.3 频道-Agent 关联
- 频道中可添加 Agent 参与者
- Agent 自动回复频道消息（通过 Pipeline 编排）
- `@AgentName` 提及触发 Agent 响应（正则 `[\w-]*` 支持连字符名称）

#### 3.3.4 私信 (DM)
- 用户可向 Agent 发起私信（创建 DM 频道）
- DM 中 @mention 下拉仅显示私聊目标成员，不列出其他成员
- DM 输入框 placeholder 显示目标 Agent 名称

### 3.4 任务系统

#### 3.4.1 当前状态
- UI 已有任务看板框架（chat 页面的 "任务" tab）
- 后端任务持久化尚未实现

#### 3.4.2 需求
- 任务创建/更新/删除
- 任务与频道/消息关联
- 任务状态跟踪

### 3.5 设备管理

#### 3.5.1 设备注册（邀请流程）
1. 用户从 Web UI 创建设备邀请码（`invite:create`，purpose=device）
2. 用户在目标设备上运行邀请命令（`npx tsx agent/src/bin.ts --invite <code>`）
3. Daemon 连接到 `/web` 命名空间（invite auth），验证邀请码，等待 token
4. 浏览器打开 `device-login/<code>` 页面，用户登录
5. 服务器通过 `auth:token:deliver` 将用户 token 推送给 Daemon
6. Daemon 断开 `/web`，携带 token 重新连接到 `/agent` 命名空间
7. Daemon 扫描本地 Agent 运行时，注册到服务端

**关键机制：**
- `inviteSessions` Map 存储 Daemon socket（key: `device:<code>`）
- 首次存储保护：浏览器验证不会覆盖 Daemon socket
- 三截 token 认证：`userId:networkId:random`
- Agent namespace middleware：legacy token 跳过 parseToken 检查

#### 3.5.2 设备页面
- 显示设备状态、hostname、Tailscale IP
- 显示设备上运行的 Agent 列表
- Agent 可见性配置（发布到多网络）
- 设备状态：在线/离线取决于 Daemon 是否运行（心跳机制）
- Agent 状态：在线/离线/忙碌，通过 `agent:status` 实时推送到 Web 端

#### 3.5.3 服务器端网络持久化
- `users.current_network_id` 列表储用户当前工作网络
- 登录时优先使用 `currentNetworkId`（需验证仍是网络成员）
- `network:switch` 事件自动保存到数据库
- 注册时自动将私有网络设为当前网络
- 设备登录时自动将邀请网络设为当前网络

---

## 4. Socket.IO 事件设计

### 4.1 `/web` 命名空间（浏览器客户端）

| 事件 | 方向 | 用途 |
|------|------|------|
| `auth:login` | C→S | 用户登录 |
| `auth:register` | C→S | 用户注册 |
| `networks:list` | C→S | 列出用户所属网络 |
| `network:create` | C→S | 创建网络 |
| `agents:subscribe` | C→S | 订阅网络内 Agent 列表 |
| `agent:status` | S→C | Agent 状态更新广播 |
| `agent:publish` | C→S | 发布 Agent 到网络 |
| `agent:unpublish` | C→S | 取消发布 |
| `channels:subscribe` | C→S | 订阅频道列表 |
| `channel:create` | C→S | 创建频道 |
| `channel:join` | C→S | 加入频道（获取历史消息） |
| `channel:add-member` | C→S | 添加频道用户成员 |
| `channel:remove-member` | C→S | 移除频道用户成员 |
| `message:send` | C→S | 发送消息 |
| `channel:message` | S→C | 频道新消息广播 |
| `members:list` | C→S | 列出网络成员（人+Agent） |
| `device:register` | C→S | 设备注册 |
| `device:heartbeat` | C→S | 设备心跳 |
| `device:save-name` | C→S | 保存设备名称 |
| `device:list` | C→S | 列出设备 |
| `device:get` | C→S | 获取设备详情 |
| `device:scan` | C→S | 触发设备扫描 |
| `device:agents:list` | C→S | 列出设备上的 Agent |
| `invite:create` | C→S | 创建邀请码（user/device） |
| `auth:invite:validate` | C→S | 验证邀请码 |
| `auth:device-login` | C→S | 设备登录（用户名+密码+邀请码） |
| `auth:token:deliver` | S→C | 向 Daemon 推送 token |
| `auth:whoami` | C→S | 获取当前用户信息 |
| `auth:change-password` | C→S | 修改密码 |
| `network:switch` | C→S | 切换网络（自动保存到 DB） |

### 4.2 `/agent` 命名空间（设备端 Daemon）

| 事件 | 方向 | 用途 |
|------|------|------|
| `register` | C→S | Agent 注册（含去重检查） |
| `heartbeat` | C→S | 心跳（驱动设备+Agent 状态更新） |
| `device:register-agents` | C→S | 扫描结果批量注册（含去重+离线标记） |
| `reply` | C→S | Agent 执行结果回复 |
| `error_event` | C→S | Agent 错误上报 |
| `agents:discovered` | S→C | 扫描发现的 Agent 广播 |
| `agents:discover` | S→C | 服务端触发重新扫描 |
| `dispatch` | S→C | 服务端分发执行任务 |
| `message` | C→S | Agent 发送消息 |
| `response` | C→S | Agent 执行结果 |
| `error` | C→S | Agent 错误上报 |
| `token` | S→C | Server 分发执行任务 |
| `cancel` | S→C | 取消执行 |

---

## 5. 安全需求

- 密码加密：使用 Node.js `crypto.scrypt`，不可逆哈希
- Token 认证：JWT (用户) + 三截 token (设备)
- 时间安全比较：`crypto.timingSafeEqual` 防止时序攻击
- Artifact 认证：下载 URL 需要有效 token
- 每网络 SQLite 隔离：网络间数据物理隔离
- 队列捕获：serial dispatch queue 防止并发冲突

---

## 6. 非功能需求

- **性能**：Socket.IO 实时通信延迟 < 100ms
- **可靠性**：Agent 断线自动重连，消息持久化
- **可扩展性**：每网络独立 SQLite，支持多用户部署
- **可用性**：Next.js App Router 前端，响应式设计

---

## 7. 待实现功能

### 7.1 Phase 3: 自定义 Agent（已完成 2026-05-10）
- [x] 自定义 Agent 配置 UI（名称/命令/参数/工作目录/适配器类型）
- [x] Agent 详情页完整运行时配置（source badge、device info、runtime config）
- [x] standalone-cli 分类已移除（2026-05-12）

### 7.1.5 Phase 3.5: Agent 稳定性修复（已完成 2026-05-12）
- [x] Agent 去重：findByDeviceAndName + resolveScanId
- [x] @mention 正则修复（支持连字符 Agent 名）
- [x] NO_ONLINE 路由修复（channel_members scan-prefix 回退）
- [x] DM 私聊 @mention 过滤（仅显示目标成员）
- [x] 成员页实时 Agent 状态更新（agent:status 订阅）
- [x] 成员页 UI 修复（去掉"2网"badge、修复详情页显示）
- [x] Scanner PATH 扩展（nvm 全版本 bin 目录）
- [x] Daemon 周期重扫（5 分钟间隔）
- [x] apps/agent → apps/daemon 重命名

### 7.2 Phase 4: 任务系统
- 任务数据持久化
- 任务 CRUD API
- 任务与频道/消息关联
- 任务拖拽排序

### 7.3 Phase 5: 用户体验
- ~~设备名称持久化~~ (已完成 2026-05-12)
- 频道编辑功能
- 消息搜索
- ~~私信系统~~ (已完成 2026-05-12)
- 收藏功能对接
- Agent DMs/Reminders/Workspace/Activity 标签页

### 7.4 Phase 6: 生产化
- Tailscale 深度集成
- 文件预览增强（图片/PDF/代码）
- Agent 性能看板
- 日志聚合
- 备份/恢复
