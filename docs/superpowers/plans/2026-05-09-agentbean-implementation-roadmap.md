# AgentBean 实现路线图

**日期:** 2026-05-09
**版本:** 1.2
**状态:** Phase 0-3.5 已完成，Phase 4+ 待实现
**更新:** 2026-05-12 — 新增 Phase 3.5 稳定性修复里程碑

---

## 项目概况

- **项目名称：** AgentBean — 多 Agent 协作平台
- **仓库结构：** `apps/server`（服务端）、`apps/web`（前端）、`apps/daemon`（设备端 Daemon）
- **技术栈：** Express + Socket.IO + better-sqlite3 + Next.js 14 + Zustand + TypeScript + vitest
- **当前状态：** Phase 0-3 已完成，Phase 3.5（稳定性修复）已完成

---

## 已完成里程碑

### Phase 0: 基础架构 (2026-05-03 ~ 2026-05-06)

**关键文件：**
- `apps/server/src/index.ts` — Server 主入口
- `apps/server/src/db.ts` — 全局数据库
- `apps/daemon/src/bin.ts` — Daemon CLI 入口
- `apps/web/app/page.tsx` — Web 根页面

**功能点：**
- Server 骨架：Express + Socket.IO + SQLite
- Agent Daemon：CLI 入口 + codex/claude-code/openclaw/hermes 四种适配器
- Web 前端：Next.js App Router + 登录注册 + Agent 列表 + 频道系统
- 消息路由：`routeHumanMessage()` 解析 @mention + fallback
- 心跳机制：30s 超时检测
- 测试覆盖：10/10 通过

### Phase 1: 网络隔离 (2026-05-05 ~ 2026-05-07)

**关键文件：**
- `apps/server/src/db.ts` — users/networks/network_members/invites 表
- `apps/server/src/storage.ts` — StorageManager + per-network SQLite
- `apps/server/src/registry.ts` — AgentRegistry 扩展
- `apps/server/src/namespaces/agent.ts` — /agent namespace 认证
- `apps/daemon/src/scanner.ts` — 三层 Agent 扫描器

**功能点：**
- 全局数据库：用户、网络、成员、邀请码
- 每网络独立 SQLite 隔离
- 设备注册 + 三截 token 认证
- Agent 四类分类：executor-hosted/agentos-hosted/standalone-cli（standalone-cli 后续移除）
- macOS sandbox-exec 隔离公开 Agent
- 安全加固：scrypt 密码、timing-safe 比较
- 测试覆盖：59/59 通过

### Phase 2: 多网络可见性 + 频道系统 (2026-05-09)

**关键文件：**
- `apps/server/src/db.ts` — `agent_network_publish` 表 + `channel_user_members` 表
- `apps/server/src/registry.ts` — `publishedNetworkIds` 字段
- `apps/server/src/channels.ts` — `listForUser()` + 用户成员管理
- `apps/server/src/index.ts` — `agent:publish/unpublish`、`members:list`、`channel:add-member/remove-member` 事件
- `apps/web/lib/schema.ts` — `publishedNetworkIds`、`ChannelSummary.visibility`
- `apps/web/lib/socket.ts` — `agentEvents()`、`memberEvents()`、`channelEvents()`
- `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` — 多网络发布 toggle
- `apps/web/app/[networkPath]/members/page.tsx` — 真实成员数据
- `apps/web/app/[networkPath]/chat/page.tsx` — 私有频道锁图标
- `apps/web/components/new-channel-dialog.tsx` — 可见性 + 用户成员选择

**功能点：**
- `agent_network_publish` 多对多关联表替代单 `visibility` 字段
- Agent 可发布到用户加入的多个网络
- `channel_user_members` 表支持私有频道
- `channels.listForUser()` 使用 LEFT JOIN 过滤
- `members:list` 返回 `{ humans[], agents[] }` 真实数据
- 新建频道对话框：可见性选择 + 用户成员勾选
- 频道列表私有频道显示锁图标
- `message:send` 的 `senderId` 正确填入 userId
- TypeScript 编译通过

### Phase 3: 设备管理 + Agent 扫描器 + 网络持久化 (2026-05-10)

**关键文件：**
- `apps/server/src/index.ts` — 设备 CRUD 事件、邀请流程、网络持久化
- `apps/server/src/namespaces/agent.ts` — Agent namespace legacy token 修复
- `apps/server/src/db.ts` — `users.current_network_id` 列
- `apps/server/src/invite.ts` — 邀请码生成与管理
- `apps/server/src/password.ts` — bcrypt 密码加密
- `apps/daemon/src/scanner.ts` — manus、anygen 运行时检测
- `apps/daemon/src/device-daemon.ts` — `/agent` 命名空间连接修复
- `apps/daemon/src/connection.ts` — `/agent` 命名空间连接修复
- `apps/web/lib/schema.ts` — `AgentSnapshot.source` 字段
- `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` — source badge、device info、runtime config
- `apps/web/app/login/page.tsx` — localStorage 网络持久化
- `apps/web/app/signup/page.tsx` — 注册后跳转当前网络
- `apps/web/app/join/[token]/page.tsx` — 邀请注册跳转
- `apps/web/app/device-login/[code]/page.tsx` — 设备登录页面
- `apps/web/components/sidebar.tsx` — 网络切换保存 localStorage
- `apps/web/components/app-shell.tsx` — 自动跳转当前网络

**功能点：**
- 设备邀请注册流程：invite:create → daemon 验证 → browser device-login → token:deliver
- `inviteSessions` Map 存储 Daemon socket（首次存储保护）
- Agent namespace middleware：legacy token 跳过 parseToken
- `users.current_network_id` 服务器端网络持久化
- 登录时优先使用 currentNetworkId（验证仍是成员）
- `network:switch` 自动保存到数据库
- Agent 扫描器扩展：manus、anygen 运行时检测
- Agent source 字段：self-register / scanned / custom
- Agent 详情页：source badge、设备信息、运行时配置
- 56/56 测试通过

---

## 进行中工作

Phase 3.5 已完成。下一步：Phase 4 任务系统。

---

### Phase 3.5: Agent 稳定性修复 (2026-05-12)

**关键文件：**
- `apps/server/src/registry.ts` — `findByDeviceAndName()`, `resolveScanId()` 新方法
- `apps/server/src/channels.ts` — `membersOf()` 增加 scan-prefix ID 回退
- `apps/server/src/namespaces/agent.ts` — 去重检查、离线标记、scan-prefix 清理
- `apps/daemon/src/scanner.ts` — PATH 扩展（nvm 全版本）、移除 standalone-cli
- `apps/daemon/src/device-daemon.ts` — 周期重扫（5 分钟）、扫描缓存
- `apps/daemon/src/config.ts` — AgentCategory 移除 standalone-cli
- `apps/web/app/[networkPath]/chat/page.tsx` — @mention 正则修复、DM 过滤
- `apps/web/app/[networkPath]/members/page.tsx` — 实时状态、UI 修复
- `apps/web/lib/schema.ts` — AgentCategory 类型更新

**功能点：**
- **Agent 去重：** `findByDeviceAndName(deviceId, name)` 按设备+名称查找，`register` 和 `device:register-agents` 两条路径不再创建重复条目
- **Scan-prefix 回退：** `resolveScanId()` 解析 `scan-{deviceId}-{name}` 格式 ID，`membersOf()` 用它回退查找 channel_members 中的旧 ID
- **@mention 正则修复：** `\w*` → `[\w-]*`，Agent 名含连字符时完整匹配
- **DM 私聊过滤：** DM 频道 @mention 下拉仅显示目标成员
- **成员页实时状态：** 订阅 `agent:status` 事件，Agent 状态变更即时反映
- **成员页 UI 修复：** 去掉"2网"badge、详情页显示"适配器"而非硬编码版本号
- **Scanner PATH 扩展：** `getAllNodeVersions()` 扫描 `~/.nvm/versions/node/` 所有版本目录
- **周期重扫：** Daemon 每 5 分钟触发 `scanAndRegister()`，服务端标记消失 Agent 为离线
- **standalone-cli 移除：** 类型定义、UI、服务端、Daemon 全面删除
- **apps/agent → apps/daemon：** 目录重命名，CI/CD、引用路径全部更新

### Phase 3.6: CI/CD + 部署 (2026-05-12)

**关键文件：**
- `.github/workflows/ci-cd.yml` — CI/CD 流水线（matrix: server, web, daemon）
- `apps/daemon/package.json` — npm 发布配置 `@agentbean/daemon`
- `CI_CD.md` — 部署文档
- `.nvmrc` — Node 22 版本锁定

**功能点：**
- GitHub Actions CI：lint + build + test（server/web/daemon 矩阵）
- npm publish 步骤：main 分支推送时自动发布 `@agentbean/daemon`
- Vercel 自动部署 Web（Git integration）
- Railway 自动部署 Server
- `.nvmrc` 锁定 Node 22

---

## 待实现功能

### Phase 3: 自定义 Agent + 独立 Agent (优先级：高) — ✅ 已完成 2026-05-10
### Phase 3.5: Agent 稳定性修复 — ✅ 已完成 2026-05-12
### Phase 3.6: CI/CD + 部署 — ✅ 已完成 2026-05-12

**涉及文件：**
- `apps/web/app/[networkPath]/agents/` — 新建"创建自定义 Agent"表单
- `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` — 完整运行时配置
- `apps/server/src/index.ts` — 扩展 `agent:create` 事件
- `apps/daemon/src/scanner.ts` — 扩展独立 Agent 检测

**功能点：**
- 自定义 Agent 配置 UI（名称、命令、参数、工作目录、适配器类型）
- 网络发布 checkbox 列表
- Agent 详情页完整运行时配置展示
- 独立 Agent 扫描器扩展（manus、anygen.io 等）
- standalone 适配器实现

**依赖关系：** 无（可独立实现）

### Phase 4: 任务系统 (优先级：中)

**涉及文件：**
- `apps/server/src/db.ts` — tasks 表
- `apps/server/src/index.ts` — task CRUD 事件
- `apps/web/app/[networkPath]/tasks/page.tsx` — 任务看板（替换 Mock 数据）
- `apps/web/lib/store.ts` — tasks 状态

**功能点：**
- 任务数据持久化（当前 tasks 页面使用 Mock 数据）
- 任务创建/更新/删除 API
- 任务与频道/消息关联
- 任务拖拽排序持久化

**依赖关系：** 无（UI 框架已存在）

### Phase 5: 用户体验增强 (优先级：中)

**涉及文件：**
- `apps/web/app/[networkPath]/devices/page.tsx` — 设备名称持久化
- `apps/web/app/[networkPath]/chat/page.tsx` — 消息搜索、频道编辑
- `apps/web/lib/store.ts` — 收藏/私信状态

**功能点：**
- 设备名称持久化（当前 `saveName` 是 TODO）
- 频道编辑功能
- 消息搜索功能
- 私信系统
- 收藏/已收藏功能对接
- Agent DMs / Reminders / Workspace / Activity 标签页
- 环境变量配置 UI
- 技能管理 UI

**依赖关系：** 部分功能依赖 Phase 4（任务关联）

### Phase 6: 生产化 (优先级：低)

**涉及文件：**
- `apps/server/src/` — 日志聚合、备份恢复
- `apps/daemon/src/` — Tailscale 集成
- `apps/web/` — 性能看板 UI

**功能点：**
- Tailscale 深度集成（数据模型已支持 `tailscale_ip`）
- 文件预览增强（图片/PDF/代码）
- 日志聚合
- Agent 性能看板（`agent-metrics.ts` 已实现，UI 未对接）
- 备份/恢复
- 多语言支持

**依赖关系：** 无

---

## 关键文件清单

| 文件 | 职责 | 已完成阶段 |
|------|------|-----------|
| `apps/server/src/index.ts` | Server 主入口 + Socket.IO 事件 | 0, 1, 2, 3 |
| `apps/server/src/db.ts` | 全局数据库 schema + DAO | 0, 1, 2, 3 |
| `apps/server/src/storage.ts` | per-network SQLite 管理 | 1 |
| `apps/server/src/registry.ts` | Agent 注册中心 | 0, 1, 2, 3.5 |
| `apps/server/src/channels.ts` | 频道服务 | 0, 2 |
| `apps/server/src/routing.ts` | 消息路由 | 0 |
| `apps/server/src/auth.ts` | 用户认证 | 1 |
| `apps/server/src/password.ts` | 密码加密 | 1 |
| `apps/server/src/invite.ts` | 邀请码 | 1 |
| `apps/server/src/namespaces/agent.ts` | /agent namespace | 0, 1, 3, 3.5 |
| `apps/server/src/device-registry.ts` | 设备注册 | 1 |
| `apps/server/src/invite.ts` | 邀请码管理 | 1, 3 |
| `apps/server/src/password.ts` | 密码加密 (bcrypt) | 1, 3 |
| `apps/server/src/agent-metrics.ts` | Agent 性能指标 | 1 |
| `apps/server/src/intro.ts` | Agent 自我介绍 | 0 |
| `apps/server/src/artifact-routes.ts` | 文件上传下载 | 1 |
| `apps/server/src/connect-command.ts` | CLI 连接命令渲染 | 0 |
| `apps/server/src/heartbeat-scanner.ts` | 心跳超时扫描 | 0 |
| `apps/daemon/src/index.ts` | Daemon 主入口 | 0 |
| `apps/daemon/src/scanner.ts` | 三层 Agent 扫描 + PATH 扩展 | 1, 3.5 |
| `apps/daemon/src/device-daemon.ts` | 设备 Daemon + 周期重扫 | 0, 3.5 |
| `apps/daemon/src/adapters/codex.ts` | Codex 适配器 | 0 |
| `apps/daemon/src/adapters/claude-code.ts` | Claude Code 适配器 | 0 |
| `apps/daemon/src/adapters/openclaw.ts` | OpenClaw 适配器 | 0 |
| `apps/daemon/src/adapters/hermes.ts` | Hermes 适配器 | 0 |
| `apps/daemon/src/sandbox.ts` | macOS sandbox-exec | 1 |
| `apps/daemon/src/config.ts` | YAML 配置加载 | 0 |
| `apps/web/lib/schema.ts` | TypeScript 类型定义 | 0, 1, 2 |
| `apps/web/lib/store.ts` | Zustand 状态管理 | 0, 1, 2 |
| `apps/web/lib/socket.ts` | Socket.IO 客户端 | 0, 2 |
| `apps/web/app/[networkPath]/chat/page.tsx` | 频道聊天页 | 0, 2, 3.5 |
| `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` | Agent 详情页 | 1, 2 |
| `apps/web/app/[networkPath]/members/page.tsx` | 网络成员页 | 2, 3.5 |
| `apps/web/app/[networkPath]/devices/page.tsx` | 设备管理页 | 1 |
| `apps/web/app/[networkPath]/tasks/page.tsx` | 任务看板 | 0（Mock） |
| `apps/web/components/new-channel-dialog.tsx` | 新建频道对话框 | 2 |
| `apps/web/components/sidebar.tsx` | 侧边栏导航 | 0 |
| `apps/web/components/agent-card.tsx` | Agent 卡片 | 0 |
| `apps/web/app/login/page.tsx` | 登录页 | 1 |
| `apps/web/app/signup/page.tsx` | 注册页 | 1 |
| `apps/web/app/join/page.tsx` | 邀请加入页 | 1 |
