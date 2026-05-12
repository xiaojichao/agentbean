---
title: AgentBean Network Isolation — 多用户私有网络与存储隔离设计
date: 2026-05-05
branch: docs/demo001
related_specs:
  - 2026-05-03-agentbean-demo001-design.md (Phase 1 基线)
status: 草稿，待用户复核
---

# AgentBean Network Isolation — 多用户私有网络与存储隔离设计

## 1. 概览

本文档对应 AgentBean **Phase 2** 架构演进。在 Phase 1（demo001）已验证「真实 CLI Agent → 频道创建 → 人机协作」闭环的基础上，引入 **多用户、多私有网络、存储空间隔离、设备级 Agent Daemon** 四大核心能力。

设计原则:

- **向后兼容 Phase 1**: Phase 1 的 CLI 适配层、Artifact Registry、频道消息模型是可直接复用的资产。
- **每台设备一个 Agent Daemon**: 本机所有 Agent 共享同一个 Daemon 进程和 Server 连接，Daemon 内部管理多个 Agent Adapter 实例。
- **Agent 可见性由用户控制**: 用户通过 UI 决定哪些本机 Agent 对 Server 公开（出现在 Agent 列表中），哪些保持私有（仅 Daemon 本地可用）。
- **存储空间物理隔离**: 每个私有网络拥有独立的 SQLite 数据库文件和独立的 artifacts 文件目录。
- **所有交互统一走 Server**: 包括同一设备上的 Agent 之间交互，也走 Server 中转，确保消息持久化和统一路由。
- **TailScale 作为网络层**: 所有设备加入同一个 TailScale tailnet，Server 和 Agent Daemon 通过 TailScale IP 通信。

本文档不覆盖: 付费/配额、长期记忆、生产级安全沙箱、移动端 App。

## 2. 系统拓扑

### 2.1 网络层 (TailScale)

所有设备（用户本机、远程服务器、Server 主机）加入同一个 TailScale tailnet:

```
TailScale Tailnet (e.g. tailnet-agentbean)
├── Server Node        100.x.y.1:4000
├── User-A Laptop      100.x.y.10  (Agent Daemon: codex-肖 + claude-code-肖)
├── User-A Desktop     100.x.y.11  (Agent Daemon: openclaw-肖)
└── User-B Server      100.x.y.20  (Agent Daemon: codex-李)
```

### 2.2 应用层拓扑

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              TailScale Tailnet                               │
│                                                                              │
│   ┌──────────────┐                    ┌──────────────────────────────┐       │
│   │  Web (Next.js)│◄───Socket.IO─────►│  Server (Node + Express)     │       │
│   │  apps/web     │   /web namespace   │  apps/server                 │       │
│   │               │                    │  100.x.y.1:4000              │       │
│   └──────────────┘                    └──────────┬───────────────────┘       │
│                                                  │                           │
│                              Socket.IO /agent    │                           │
│                              (1 connection per   │                           │
│                               device)            │                           │
│                                                  │                           │
│   ┌──────────────────────────────────────────────┼──────────────────┐       │
│   │                                              │                  │       │
│   ▼                                              ▼                  ▼       │
│  Device A (User-A)                          Device B (User-A)   Device C (User-B)
│  100.x.y.10                                  100.x.y.11        100.x.y.20
│                                                                              │
│  ┌─────────────────────────────────────┐    ┌─────────────┐   ┌─────────────┐│
│  │ Agent Daemon (唯一进程)              │    │Agent Daemon │   │Agent Daemon ││
│  │                                     │    │  openclaw-肖 │   │  codex-李   ││
│  │  ┌─────────────┐ ┌───────────────┐  │    └─────────────┘   └─────────────┘│
│  │  │Adapter      │ │Adapter        │  │                                    │
│  │  │codex-肖     │ │claude-code-肖 │  │                                    │
│  │  │visibility:  │ │visibility:   │  │                                    │
│  │  │  public     │ │  private     │  │                                    │
│  │  └───┬─────────┘ └───────┬───────┘  │                                    │
│  │      │                   │          │                                    │
│  │      ▼                   ▼          │                                    │
│  │   spawn CLI           spawn CLI     │                                    │
│  │   (按需)               (按需)       │                                    │
│  └─────────────────────────────────────┘                                    │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

关键点:

- **每台设备只有一个 Agent Daemon**: Daemon 进程启动后加载一个配置文件，内含本机所有 Agent 定义。Daemon 与 Server 建立唯一的 Socket.IO 连接。
- **Agent 可见性**: Daemon 的 `register` 事件只上报 `visibility='public'` 的 Agent 到 Server。`visibility='private'` 的 Agent 只在 Daemon 本地运行，不出现在 Server 的 Agent 列表中。
- **所有 Agent 交互走 Server**: 即使同一设备上的两个 Agent 在同一个频道中，消息 dispatch 也走 Server → Daemon → Adapter 路径。Server 负责消息持久化和路由决策。
- **Storage Space 按 network 物理隔离**: Server 为每个私有网络创建独立目录，包含独立的 SQLite 和 artifacts 存储。
- **Device 作为 Agent 的宿主**: Server 维护 `deviceId → socket` 映射，对外展示的是 Agent 列表，但底层通过 Device Daemon 转发消息。

## 3. 仓库结构 (Phase 2 增量)

```
/Users/shaw/AgentBean/
├── docs/
│   └── superpowers/
│       ├── specs/2026-05-03-agentbean-demo001-design.md       # Phase 1 基线
│       ├── specs/2026-05-05-agentbean-network-isolation-design.md  # 本文档
│       └── plans/2026-05-05-agentbean-network-isolation.md         # 实现计划
└── apps/
    ├── server/
    │   ├── src/
    │   │   ├── index.ts              # [MODIFY] 多租户存储空间初始化
    │   │   ├── db.ts                 # [MODIFY] global.db + 网络独立库路由
    │   │   ├── storage.ts            # [NEW] StorageSpace 管理
    │   │   ├── device-registry.ts    # [NEW] DeviceRegistry: deviceId → socket
    │   │   ├── namespaces/
    │   │   │   ├── web.ts            # [MODIFY] 网络选择器 + Agent 添加 UI API
    │   │   │   └── agent.ts          # [MODIFY] 处理 Device Daemon 连接
    │   │   ├── artifact-routes.ts    # [MODIFY] 按 network 路由
    │   │   ├── channels.ts           # [MODIFY] 频道归属 network
    │   │   └── auth.ts               # [NEW] 用户/网络鉴权
    │   └── data/
    │       ├── global.db             # [NEW] 全局元数据库
    │       └── storage/              # [NEW] 每个 network 的独立存储
    │           └── {networkId}/
    │               ├── db.sqlite
    │               └── artifacts/
    │
    ├── agent/
    │   ├── src/
    │   │   ├── index.ts              # [MODIFY] 加载多 Agent 配置，启动 Device Daemon
    │   │   ├── device-daemon.ts      # [NEW] Device 级 Daemon（唯一进程）
    │   │   ├── agent-instance.ts     # [NEW] 单个 Agent 的运行时实例管理
    │   │   ├── adapters/             # [MODIFY] 保持不变
    │   │   ├── connection.ts         # [MODIFY] 改为 Device 级连接（非 Agent 级）
    │   │   └── config.ts             # [MODIFY] 支持多 Agent 配置
    │   └── examples/
    │       └── device-agent.yaml     # [NEW] 设备级 Agent Daemon 配置示例
    │
    └── web/
        ├── lib/
        │   ├── schema.ts             # [MODIFY] 新增 Device、Network 类型
        │   └── store.ts              # [MODIFY] 按网络组织数据
        └── components/
            ├── network-selector.tsx   # [NEW]
            ├── add-agent-modal.tsx    # [NEW] 自动扫描 + 手动输入添加 Agent
            └── agent-visibility-toggle.tsx  # [NEW]
```

## 4. 数据模型

### 4.1 全局元数据库 (`data/global.db`)

```sql
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT UNIQUE,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 私有网络表
CREATE TABLE IF NOT EXISTS networks (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  created_at    INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 用户-网络成员关系
CREATE TABLE IF NOT EXISTS network_members (
  network_id    TEXT NOT NULL,
  user_id       TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (network_id, user_id),
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE CASCADE
);

-- 设备表（新增）
CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,           -- deviceId，由 Daemon 自报
  user_id       TEXT NOT NULL,
  network_id    TEXT NOT NULL,
  tailscale_ip  TEXT,                       -- TailScale IP
  hostname      TEXT,
  last_seen_at  INTEGER NOT NULL,
  FOREIGN KEY (user_id)    REFERENCES users(id)    ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);

-- Agent 全局索引（只存已公开的 Agent）
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT,
  adapter_kind  TEXT NOT NULL,
  device_id     TEXT NOT NULL,              -- 所属设备
  network_id    TEXT NOT NULL,              -- 所属网络
  visibility    TEXT NOT NULL DEFAULT 'public',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  last_error    TEXT,
  FOREIGN KEY (device_id)  REFERENCES devices(id)  ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agents_network ON agents(network_id, visibility);
CREATE INDEX IF NOT EXISTS idx_devices_network ON devices(network_id);
```

### 4.2 网络独立数据库 (`data/storage/{networkId}/db.sqlite`)

```sql
-- 频道表
CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  created_by   TEXT
);

-- 频道成员表
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_members_agent ON channel_members(agent_id);

-- 消息表
CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  sender_kind  TEXT NOT NULL,
  sender_id    TEXT,
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  meta_json    TEXT,
  artifact_ids TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);

-- Artifacts 表
CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  message_id   TEXT,
  uploader_id  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  meta_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id);
```

## 5. Agent Daemon 架构 (核心变化)

### 5.1 配置文件 (`device-agent.yaml`)

每台设备的 Agent Daemon 加载一个配置文件，内含本机所有 Agent 定义:

```yaml
deviceId: user-a-laptop
networkId: n1
server:
  url: ${AGENT_BEAN_SERVER_URL}
  token: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000

agents:
  - id: codex-肖
    name: Codex-肖
    role: Codex 代理 — 通用编码助手
    adapter:
      kind: codex
      command: codex
      args: ['exec', '--skip-git-repo-check']
      workspace: ${HOME}
      systemPrompt: |
        你是一个被 AgentBean 框架托管的 Codex CLI Agent...
    visibility: public

  - id: claude-code-肖
    name: Claude-肖
    role: Claude Code 代理 — 全能编码助手
    adapter:
      kind: claude-code
      command: claude
      args: []
      workspace: ${HOME}
      systemPrompt: |
        你是一个被 AgentBean 框架托管的 Claude Code Agent...
    visibility: private
```

### 5.2 Device Daemon 启动流程

```
1. 加载 device-agent.yaml
2. 验证每个 Agent 配置的有效性（adapter kind、command 是否存在）
3. 建立 Socket.IO 连接到 Server（通过 TailScale IP）
4. 发送 register 事件:
   {
     deviceId: "user-a-laptop",
     networkId: "n1",
     tailscaleIp: "100.x.y.10",
     agents: [
       { id, name, role, adapterKind, visibility },  // 只上报 public 的
       ...
     ]
   }
5. Server 校验 networkId → 热加载 Storage Space → 返回 ack { ok: true }
6. 启动心跳定时器
7. 监听 dispatch 事件，按 requestId/agentId 路由到对应 Agent adapter
```

### 5.3 Agent Instance 生命周期

```typescript
// apps/daemon/src/agent-instance.ts
interface AgentInstance {
  id: string;
  config: AgentConfig;        // 来自 device-agent.yaml
  adapter: CliAdapter;
  status: 'idle' | 'busy' | 'error';
  currentRequestId?: string;
}

class DeviceDaemon {
  private agents = new Map<string, AgentInstance>();
  private socket: Socket;

  // 收到 Server dispatch → 找到对应 Agent → 转发
  async handleDispatch(request: DispatchRequest) {
    const agent = this.agents.get(request.agentId);
    if (!agent) { ... }
    agent.status = 'busy';
    const result = await agent.adapter.ask({...});
    // 上传 artifacts → 发 reply 回 Server
    this.socket.emit('reply', { agentId: agent.id, ... });
  }
}
```

### 5.4 Agent 添加流程

用户通过 Web UI 添加本机 Agent:

```
1. Web UI 打开「添加 Agent」模态框
2. 自动扫描：检测本地 PATH 中是否有 codex、claude、openclaw、hermes 等 CLI
   → 展示可一键添加的 Agent 卡片
3. 手动输入：表单填写 name、role、adapter kind、command、args、systemPrompt
4. Web 发送 `agent:add` 事件到 Server
5. Server 转发到对应 Device Daemon
6. Daemon 将新 Agent 配置追加到 device-agent.yaml
7. Daemon 实例化新 Agent adapter
8. 若 visibility=public，Daemon 下次 register 时上报新 Agent
9. Web UI 刷新 Agent 列表
```

### 5.5 Agent 可见性切换

```
1. 用户在 Agent 详情页切换 visibility: public ↔ private
2. Web 发送 `agent:updateVisibility` 到 Server
3. Server 转发到 Device Daemon
4. Daemon 修改本地配置文件的 visibility 字段
5. 若改为 public → 立即发送 `agents:update` 事件到 Server 补充上报
6. 若改为 private → 立即发送 `agents:remove` 事件到 Server 移除
```

## 6. 通信协议调整

### 6.1 `/agent` namespace (Device Daemon ↔ Server)

| 方向 | 事件 | payload |
| --- | --- | --- |
| D→S | `register` | `{ deviceId, networkId, tailscaleIp?, agents: PublicAgentMeta[] }` |
| D→S | `heartbeat` | `{ at: number }` |
| D→S | `agents:update` | `{ agents: PublicAgentMeta[] }` | 新增/更新公开 Agent |
| D→S | `agents:remove` | `{ agentIds: string[] }` | 移除公开 Agent |
| D→S | `reply` | `{ agentId, channelId, body, requestId, artifactIds? }` |
| D→S | `error` | `{ agentId, at, message, scope }` |
| S→D | `dispatch` | `{ requestId, channelId, agentId, prompt, history, sender }` |
| S→D | `agent:add` | `{ config: AgentConfig }` | Server 转发用户添加请求 |
| S→D | `agent:updateVisibility` | `{ agentId, visibility }` | Server 转发可见性变更 |

`PublicAgentMeta`:
```typescript
interface PublicAgentMeta {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
  visibility: 'public';
}
```

### 6.2 `/web` namespace (Web ↔ Server)

新增事件:

| 方向 | 事件 | payload |
| --- | --- | --- |
| C→S | `networks:list` | `{}` |
| C→S | `networks:create` | `{ name, description? }` |
| C→S | `network:switch` | `{ networkId }` |
| C→S | `agents:scan` | `{}` | 请求本机 Device Daemon 扫描可添加的 Agent |
| C→S | `agent:add` | `{ deviceId, config: AgentConfig }` |
| C→S | `agent:updateVisibility` | `{ agentId, visibility }` |
| S→C | `networks:snapshot` | `NetworkSummary[]` |
| S→C | `agents:scanResult` | `{ candidates: ScannedAgent[] }` | 自动扫描结果 |

## 7. 存储层设计

与 Phase 1 相比，Phase 2 将存储从「单库单目录」升级为「全局元数据库 + 网络独立库」:

```
data/
├── global.db                 # 全局元数据库（users, networks, devices, agents 索引）
└── storage/
    └── {networkId}/
        ├── db.sqlite         # 网络独立数据库（channels, messages, artifacts）
        └── artifacts/
            └── {ulid-shard}/ # ULID 分片存储
```

`StorageManager` 职责:
- `createSpace(networkId)` → 创建目录 + db.sqlite + 初始化 schema
- `getSpace(networkId)` → 返回已缓存的 Database 连接
- 所有业务逻辑调用 `storage.getDb(networkId)` 获取对应网络的数据库

## 8. 鉴权模型

简化版（M2 范围）:

- **User Token**: Web 用户输入用户名即完成「注册/登录」，Server 生成 token 绑定到 userId。
- **Network Token**: Agent Daemon 的 `token` 编码 `userId:networkId:random`，Server 解析后验证用户是否属于该网络。
- **Device 识别**: Daemon 自报 `deviceId`（来自配置文件），Server 用 `(userId, deviceId)` 联合标识设备。

## 9. Web UI 调整

### 9.1 新增组件

- **网络选择器**: 顶部栏下拉框，切换当前活跃网络。
- **添加 Agent 模态框**: 两栏布局 — 左侧「自动扫描」结果（本地检测到的 CLI），右侧「手动配置」表单。
- **Agent 可见性开关**: Agent 卡片/详情页上的 public/private 切换。

### 9.2 状态管理

```typescript
interface AgentBeanStore {
  currentNetworkId: string | null;
  networks: Map<string, NetworkSummary>;
  devices: Map<string, DeviceSnapshot>;       // 当前网络内的设备
  agents: Map<string, AgentSnapshot>;         // 当前网络内的公开 Agent
  channels: Map<string, ChannelSnapshot>;
  messagesByChannel: Map<string, ChatMessage[]>;
}
```

## 10. 里程碑 (Phase 2)

| ID | 范围 | 验收门 |
| --- | --- | --- |
| M0 | StorageManager + 全局/独立 DB 架构 | `createSpace()` 能创建独立目录和 DB；两个网络的 Agent 数据互相不可见 |
| M1 | Device Daemon 重构：单进程多 Agent + register 上报 | 一台设备一个 Daemon，加载 device-agent.yaml，上报 public Agent |
| M2 | Web UI 网络选择器 + Agent 添加（扫描+手动）+ 可见性切换 | 用户可在 UI 添加 Agent、切换可见性、在不同网络间切换 |
| M3 | 同网络内完整 Phase 1 功能 | 在每个网络内独立创建频道、协作、Artifacts 上传到对应 Storage Space |
| M4 (可选) | 跨网络公开 Agent 邀请 | 公开 Agent 可被其他网络搜索并邀请加入频道 |

## 11. 与 Phase 1 的兼容性

### 11.1 代码复用清单

| Phase 1 组件 | 复用方式 |
|-------------|---------|
| CLI 适配层 (`adapters/*.ts`) | **100% 复用** |
| Artifact upload/download | **90% 复用**，路由加上 `networkId` |
| 消息/频道/历史模型 | **100% 复用**，仅数据库存放位置变化 |
| Web UI 消息组件 | **100% 复用** |
| Socket.IO room 模型 | **100% 复用** |

### 11.2 迁移路径

将现有单库 demo001 数据迁移到 Phase 2:
1. 创建默认网络 `network-default`，默认用户 `user-default`
2. 将 `data/agentbean.db` 移动到 `data/storage/network-default/db.sqlite`
3. 将所有现有 Agent 注册为 `public`，归属到默认网络

## 12. 待定事项 (TBD)

- **[TBD-1] device-agent.yaml 热重载**: Daemon 是否需要监听配置文件变化并自动重载？
- **[TBD-2] Agent 配置持久化格式**: YAML（当前）还是 JSON？是否支持环境变量插值（如 `${HOME}`）？
- **[TBD-3] 设备离线后的 Agent 状态**: 设备断开连接后，Server 中该设备的公开 Agent 是否立即标记为 offline？
- **[TBD-4] 自动扫描的 CLI 列表**: 默认扫描哪些命令？codex、claude、openclaw、hermes，是否可配置？
