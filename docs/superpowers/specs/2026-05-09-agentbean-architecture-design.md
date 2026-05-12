# AgentBean 架构设计文档

**日期:** 2026-05-09
**版本:** 1.0
**状态:** 已完成 Phase 0-2，持续迭代中

---

## 1. 系统架构概览

AgentBean 采用三进程架构：Server（服务端）、Web（前端）、Agent Daemon（设备端）。三个进程通过 Socket.IO 实现实时通信。

```
┌─────────────────────────────────────────────────────────┐
│                    Tailscale Mesh Network                │
│                                                         │
│  ┌──────────┐    Socket.IO    ┌──────────────────┐     │
│  │   Web    │◄───────────────►│     Server       │     │
│  │ :3100    │    /web ns      │     :4000        │     │
│  │ Next.js  │                 │ Express+SocketIO │     │
│  └──────────┘                 └────────┬─────────┘     │
│                                        │               │
│                               Socket.IO /agent ns      │
│                                        │               │
│                    ┌───────────────────┼───────────┐   │
│                    │                   │           │   │
│              ┌─────┴─────┐      ┌─────┴─────┐     │   │
│              │ Device A  │      │ Device B  │     │   │
│              │ Daemon    │      │ Daemon    │ ... │   │
│              │           │      │           │     │   │
│              │ codex ──┐ │      │ claude ─┐ │     │   │
│              │ agent X  │ │      │ code    │ │     │   │
│              └──────────┘ └──────┴─────────┘ └─────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 2. 服务端架构 (apps/server)

### 2.1 入口与初始化

`src/index.ts` 的 `buildApp()` 函数完成所有初始化：

1. 创建 Express app + HTTP server
2. 初始化全局数据库 `global.db`
3. 创建 `StorageManager`（per-network SQLite 管理器）
4. 创建 `AgentRegistry` + `DeviceRegistry`
5. 创建 Socket.IO server，配置 `/web` 和 `/agent` 两个命名空间
6. 注册 HTTP 路由（healthz、artifacts）
7. 启动心跳扫描器

### 2.2 数据库层

#### 全局数据库 (`db.ts`)

```typescript
// 打开数据库，自动执行 schema 迁移
function openDb(dbPath: string): Database

// 全局数据库 DAO
interface GlobalDb {
  users: UserDao          // 注册、查询、密码验证
  networks: NetworkDao    // 创建、查询、成员管理
  agents: AgentDao        // 注册、更新、查询
  agentPublishes: PublishDao  // 多网络发布
  devices: DeviceDao      // 设备注册
  invites: InviteDao      // 邀请码
  joinLinks: JoinLinkDao  // 加入链接
  agentMetrics: MetricsDao  // 性能指标
}
```

**关键设计决策：**
- 使用 `better-sqlite3` 同步 API，避免异步复杂性
- `openDb()` 函数自动检测并执行 schema 迁移（ALTER TABLE IF NOT EXISTS）
- 每个 DAO 使用预编译的 prepared statements 提升性能

#### 每网络数据库 (`storage.ts`)

```typescript
class StorageManager {
  getSpace(networkId: string): StorageSpace
  // 返回 { db: Database, artifactsDir: string }
}

// StorageSpace.db 是原始 better-sqlite3 Database 实例
// NOT the GlobalDb wrapper — 直接使用 db.prepare() 执行 SQL
```

**NETWORK_SCHEMA** 包含：
- `channels` 表（含 `visibility`、`created_by` 列）
- `channel_agents` 表
- `channel_user_members` 表
- `messages` 表
- `artifacts` 表

### 2.3 Agent 注册中心 (`registry.ts`)

```typescript
interface AgentRuntime {
  id: string
  name: string
  role: string
  adapterKind: AdapterKind      // codex | claude-code | openclaw | hermes | standalone
  category: AgentCategory       // executor-hosted | agentos-hosted | standalone-cli
  networkId: string             // 主网络 ID
  visibility: 'public' | 'private'
  ownerId: string | null
  publishedNetworkIds: string[] // 已发布的额外网络
  status: AgentStatus           // connecting | online | busy | offline | error
  socketId: string | null
  lastHeartbeatAt: number
  firstSeenAt: number
  lastError?: { at: number; message: string }
}

class AgentRegistry {
  register(socketId, info): AgentRuntime   // 注册 agent，替换同 ID 的旧 socket
  updatePublishedNetworks(agentId, ids)    // 更新多网络发布列表
  markOffline(socketId)                    // 标记离线
  heartbeat(socketId)                      // 更新心跳时间
  markError(socketId, message)             // 记录错误
  snapshot(networkId): AgentRuntime[]       // 获取网络内 agent 快照
  all(): AgentRuntime[]                     // 获取所有 agent
}
```

**关键设计决策：**
- 内存中的 Map<agentId, AgentRuntime> 存储，不持久化状态
- 同 ID 重连时自动踢掉旧 socket（`kickListeners` 回调）
- `snapshot()` 根据 networkId + publishedNetworkIds 过滤

### 2.4 消息路由 (`routing.ts`)

```typescript
function routeHumanMessage(
  body: string,
  agents: AgentRuntime[]
): { agentId: string | null; isDirectMention: boolean }
```

**路由逻辑：**
1. 解析 `@AgentName` 提及 → 匹配 agent name
2. 匹配到 → 返回该 agent（直接提及）
3. 未匹配到 → fallback 到第一个在线 agent
4. 无在线 agent → 返回 null

### 2.5 频道系统 (`channels.ts`)

```typescript
interface CreateChannelInput {
  name: string
  networkId: string
  agentIds: string[]
  visibility?: 'public' | 'private'  // 默认 public
  createdBy?: string                  // 创建者 userId
  userIds?: string[]                  // 私有频道用户成员
}

class ChannelService {
  create(input: CreateChannelInput): ChannelRow
  list(networkId: string): ChannelRow[]
  listForUser(networkId: string, userId: string): ChannelRow[]  // LEFT JOIN 过滤私有频道
  addUserMember(channelId: string, userId: string): void
  removeUserMember(channelId: string, userId: string): void
  isUserMember(channelId: string, userId: string): boolean
}
```

**关键设计：** `ChannelService` 直接使用 `db.prepare()` 原始 SQL，因为 `StorageSpace.db` 返回的是原始 `better-sqlite3.Database`，不是 `Db` DAO 包装器。

### 2.6 Socket.IO 命名空间

#### `/web` 命名空间

浏览器客户端连接。认证方式：
- 匿名连接（仅用于登录/注册页面）
- JWT token 认证（已登录用户）

主要事件：
- `auth:login` / `auth:register` — 认证
- `agents:subscribe` — 订阅 agent 列表
- `channels:subscribe` — 订阅频道列表
- `channel:create` / `channel:join` — 频道管理
- `message:send` — 发送消息
- `agent:publish` / `agent:unpublish` — 多网络发布
- `members:list` — 网络成员列表
- `channel:add-member` / `channel:remove-member` — 频道成员管理

#### `/agent` 命名空间

设备端 Daemon 连接。认证方式：
- 三截 token：`userId:networkId:random`
- 使用 `crypto.timingSafeEqual` 进行时间安全比较

主要事件：
- `register` — agent 注册
- `heartbeat` — 心跳
- `message` — agent 消息
- `response` — agent 执行结果
- `error` — agent 错误
- `token` ← server 分发执行任务
- `cancel` ← server 取消执行

---

## 3. 前端架构 (apps/web)

### 3.1 路由结构

```
app/
├── page.tsx                    # 根页面（重定向到登录或网络）
├── login/page.tsx              # 登录
├── signup/page.tsx             # 注册
├── join/page.tsx               # 通过邀请链接加入
├── device-login/page.tsx       # 设备端登录
├── register/page.tsx           # 设备注册
└── [networkPath]/
    ├── layout.tsx              # 网络布局（侧边栏 + 内容）
    ├── agents/
    │   └── [agentId]/page.tsx  # Agent 详情页（多网络发布管理）
    ├── chat/page.tsx           # 频道聊天（频道列表 + 消息区）
    ├── members/page.tsx        # 网络成员（人类 + Agent）
    ├── devices/page.tsx        # 设备管理
    ├── tasks/page.tsx          # 任务看板（Mock 数据）
    └── settings/page.tsx       # 网络设置
```

### 3.2 状态管理

使用 Zustand 的单一 store：

```typescript
interface AgentBeanStore {
  // 连接状态
  conn: ConnState  // 'connecting' | 'open' | 'lost'

  // 认证
  currentUser: UserInfo | null
  token: string | null

  // 网络
  networks: NetworkSummary[]
  activeNetwork: string | null

  // Agent
  agents: Record<string, AgentSnapshot>  // key: agentId

  // 频道
  channels: ChannelSummary[]

  // 消息
  messagesByChannel: Record<string, ChatMessage[]>  // key: channelId

  // 设备
  devices: DeviceInfo[]

  // Actions
  applyAgentsSnapshot(list: AgentSnapshot[]): void
  applyChannelsSnapshot(list: ChannelSummary[]): void
  applyChannelHistory(channelId: string, messages: ChatMessage[]): void
  appendMessage(msg: ChatMessage): void
  upsertAgent(agent: AgentSnapshot): void
  // ...
}
```

### 3.3 Socket.IO 客户端

`lib/socket.ts` 封装了 Socket.IO 客户端连接和事件接口：

```typescript
// 获取 socket 实例
function getWebSocket(): Socket

// Agent 事件接口
function agentEvents(): {
  publish(agentId: string, networkId: string): Promise<{ ok: boolean }>
  unpublish(agentId: string, networkId: string): Promise<{ ok: boolean }>
}

// 成员事件接口
function memberEvents(): {
  list(): Promise<{ humans: UserInfo[]; agents: AgentSnapshot[] }>
}

// 频道事件接口
function channelEvents(): {
  addMember(channelId: string, userId: string): Promise<{ ok: boolean }>
  removeMember(channelId: string, userId: string): Promise<{ ok: boolean }>
}
```

---

## 4. Agent Daemon 架构 (apps/daemon)

### 4.1 启动流程

1. `bin.ts` → 解析 CLI 参数 → 加载 `config.yaml`
2. 创建 `DeviceDaemon` → 连接 Server `/agent` namespace
3. 扫描本地 Agent 运行时（三层扫描）
4. 注册所有发现的 Agent 到 Server
5. 监听 `token` 事件 → 创建 `AgentInstance` → 执行任务

### 4.2 适配器抽象

```typescript
interface CliAdapter {
  ask(options: {
    prompt: string
    cwd: string
    onToken: (text: string) => void
    abort: AbortSignal
  }): Promise<void>

  health(): Promise<boolean>
}
```

| 适配器 | 启动方式 | 通信协议 |
|--------|----------|----------|
| CodexAdapter | `node-pty` spawn | PTY escape sequence (`__ABORT__`) |
| ClaudeCodeAdapter | `child_process` spawn | stdin/stdout readline |
| OpenClawAdapter | `child_process` spawn | JSON stdin 写入 |
| HermesAdapter | `child_process` spawn | CLI `-z` flag 传入 |

### 4.3 三层扫描器

`scanner.ts` 的 `scanRuntimes()` 方法：

1. **PATH 运行时扫描**：检查 `$PATH` 中是否存在 codex、claude-code 等命令
2. **AgentOS 网关扫描**：读取 AgentOS 配置文件，发现注册的 Agent
3. **本地文件系统扫描**：读取配置目录中的 Agent 定义文件

---

## 5. 安全架构

### 5.1 认证体系

| 客户端 | 认证方式 | Token 格式 |
|--------|----------|-----------|
| Web 用户 | 用户名 + 密码 | JWT token |
| 设备 Daemon | 三截 token | `userId:networkId:random` |
| Agent 注册 | 继承设备 token | 通过设备 socket 传递 |

### 5.2 密码安全

- 使用 Node.js `crypto.scrypt` 进行密码哈希
- 每个用户独立的随机 salt
- 使用 `crypto.timingSafeEqual` 进行时间安全比较

### 5.3 网络隔离

- 每个网络拥有独立的 SQLite 数据库文件
- `StorageManager` 确保网络间数据物理隔离
- Agent 只能看到其所属或被发布的网络

### 5.4 执行安全

- macOS `sandbox-exec` 隔离公开 Agent 的执行环境
- serial dispatch queue 防止同一 Agent 的并发执行冲突
- Abort signal 支持取消长时间运行的任务

---

## 6. 数据流

### 6.1 消息发送流程

```
用户输入消息 → Web socket emit('message:send')
  → Server 收到 → 验证频道权限
  → 持久化到 per-network DB
  → 广播 channel:message 给频道内所有客户端
  → routeHumanMessage() 解析提及
  → 找到目标 agent → emit('token', { agentId, prompt })
  → Agent Daemon 收到 → adapter.ask()
  → Agent 回复 → emit('response', { body })
  → Server 收到 → 持久化 → 广播
```

### 6.2 Agent 注册流程

```
Daemon 启动 → scanRuntimes()
  → 找到 codex、claude-code 等
  → connect to /agent namespace
  → emit('register', { name, adapterKind, ... })
  → Server 验证 token
  → upsert agent to global DB
  → 加载 publish 记录 → set publishedNetworkIds
  → 注册到 AgentRegistry
  → 广播 agent:status 给 /web 客户端
```

### 6.3 多网络发布流程

```
用户在 Agent 详情页点击发布 toggle
  → Web emit('agent:publish', { agentId, networkId })
  → Server 验证用户是 agent owner + 是目标网络成员
  → INSERT INTO agent_network_publish
  → 更新 AgentRuntime.publishedNetworkIds
  → 广播 agent:status 给目标网络的 /web 客户端
  → 目标网络的 agents:subscribe 返回更新后的列表
```

---

## 7. 关键文件清单

| 文件 | 职责 | 关键接口/类 |
|------|------|------------|
| `apps/server/src/index.ts` | 主入口，Socket.IO 事件注册 | `buildApp()`, 所有 socket handler |
| `apps/server/src/db.ts` | 全局数据库 schema + DAO | `openDb()`, `initGlobalDb()`, DAO 接口 |
| `apps/server/src/storage.ts` | per-network 存储管理 | `StorageManager`, `StorageSpace` |
| `apps/server/src/registry.ts` | Agent 注册中心 | `AgentRegistry`, `AgentRuntime` |
| `apps/server/src/channels.ts` | 频道服务 | `ChannelService`, `CreateChannelInput` |
| `apps/server/src/routing.ts` | 消息路由 | `routeHumanMessage()` |
| `apps/server/src/namespaces/agent.ts` | /agent namespace | `setupAgentNamespace()` |
| `apps/server/src/auth.ts` | 用户认证 | `setupAuthRoutes()` |
| `apps/server/src/device-registry.ts` | 设备注册 | `DeviceRegistry` |
| `apps/daemon/src/index.ts` | Daemon 主入口 | `main()` |
| `apps/daemon/src/scanner.ts` | Agent 扫描器 | `scanRuntimes()` |
| `apps/daemon/src/adapters/*.ts` | CLI 适配器 | `CodexAdapter`, `ClaudeCodeAdapter`, etc. |
| `apps/web/lib/schema.ts` | TypeScript 类型定义 | `AgentSnapshot`, `ChatMessage`, etc. |
| `apps/web/lib/store.ts` | Zustand 状态管理 | `useAgentBeanStore` |
| `apps/web/lib/socket.ts` | Socket.IO 客户端 | `getWebSocket()`, `agentEvents()` |
| `apps/web/app/[networkPath]/chat/page.tsx` | 频道聊天页 | `ChatPage`, `ChatBubble` |
| `apps/web/app/[networkPath]/members/page.tsx` | 成员页面 | `MembersPage` |
| `apps/web/components/new-channel-dialog.tsx` | 新建频道对话框 | `NewChannelDialog` |
