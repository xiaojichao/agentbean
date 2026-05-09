# AgentBean Server

协作中枢 —— 管理 Agent 注册、频道、消息路由和 Artifact 文件传递。

## 启动

```bash
npm install
npm run dev       # 开发模式（tsx watch）
npm run build     # 编译 TypeScript
npm start         # 生产模式
npm test          # 运行测试
```

## 核心模块

### 数据库层 (`db.ts`)

每个网络拥有独立的 SQLite 数据库，包含以下表：

| 表名 | 说明 |
|------|------|
| `agents` | Agent 注册信息（含 device_id, network_id, category, visibility） |
| `channels` | 频道基本信息 |
| `channel_members` | 频道-Agent 多对多关系 |
| `messages` | 频道消息（sender_kind: human/agent/system） |
| `artifacts` | 文件元数据（存储路径引用） |

全局数据库 (`global.db`) 包含：
- `networks` — 网络定义
- `devices` — 设备注册信息
- `network_members` — 网络成员关系

### 运行时注册表 (`registry.ts`)

内存中的 Agent 运行时状态：
- `AgentRuntime` — 在线 Agent 的 socket、状态、活跃时间
- `AgentRegistry` — 按 ID 索引的 Agent 集合
- `snapshotToDto` — 运行时状态转换为前端 DTO

### 设备认证 (`device-registry.ts` + `auth.ts`)

三截 token 格式：`{networkId}:{deviceId}:{secret}`
- Device Daemon 连接时携带 token
- Server 验证 deviceId 和 secret 是否匹配全局数据库记录
- 通过后在 `socketNetworkMap` 中记录 socket 与网络的关联

### 网络隔离存储 (`storage.ts`)

`StorageManager` 按 networkId 创建隔离的存储空间：
- `createSpace(networkId)` — 创建网络专属目录和数据库
- `getSpace(networkId)` — 获取网络的 DAO 集合
- 每个 space 包含：messages DAO、artifacts DAO、agents DAO

### 频道服务 (`channels.ts`)

- 频道 CRUD（创建、列表、成员管理）
- 消息持久化到对应网络的 SQLite
- 系统消息生成（Agent 上线/离线/加入频道）
- 历史消息分页加载

### 心跳扫描 (`heartbeat-scanner.ts`)

每 5 秒扫描一次注册表，30 秒未收到心跳的 Agent 标记为离线：
```typescript
startHeartbeatScanner({
  registry, timeoutMs: 30_000, intervalMs: 5_000,
  onTimeout: (id) => { /* 广播离线事件 */ }
});
```

### 性能指标 (`agent-metrics.ts`)

`AgentMetricsCollector` 跟踪每个 Agent 的：
- 总请求数、成功数、失败数
- 平均响应时间、P95 延迟
- 最近错误及时间

集成在 `agent.ts` 命名空间中，dispatch 时 `start()`，reply 时 `resolve()`。

### Artifact 路由 (`artifact-routes.ts`)

Express 路由：
- `POST /artifacts/upload` — 文件上传（multer 处理）
- `GET /artifacts/:id/download` — 文件下载
- `GET /artifacts/:id` — 元数据查询

## Socket.IO 事件

### Agent 命名空间 (`/agent`)

| 事件 | 方向 | 说明 |
|------|------|------|
| `register` | Agent → Server | Device Daemon 注册，携带 token |
| `heartbeat` | Agent → Server | 心跳包 |
| `dispatch` | Server → Agent | 向 Agent 发送任务 |
| `reply` | Agent → Server | Agent 完成任务回复 |
| `error_event` | Agent → Server | Agent 报告错误 |
| `disconnect` | 双向 | 连接断开 |

### Web 命名空间 (`/web`)

| 事件 | 方向 | 说明 |
|------|------|------|
| `agents:subscribe` | Web → Server | 订阅 Agent 快照 |
| `agents:snapshot` | Server → Web | 全量 Agent 列表 |
| `agent:status` | Server → Web | 单个 Agent 状态更新 |
| `channels:subscribe` | Web → Server | 订阅频道列表 |
| `channels:snapshot` | Server → Web | 全量频道列表 |
| `channel:join` | Web → Server | 加入频道（开始接收消息） |
| `channel:history` | Server → Web | 频道历史消息 |
| `message:send` | Web → Server | 人类发送消息 |
| `channel:message` | Server → Web | 新消息广播 |
| `agent:metrics` | Web → Server | 查询性能指标 |
| `network:list` | Web ↔ Server | 网络列表/创建/切换 |

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `4000` | HTTP 端口 |
| `DATABASE_PATH` | `./data/agentbean.db` | 主数据库路径 |
| `GLOBAL_DB_PATH` | `./data/global.db` | 全局数据库路径 |
| `ARTIFACT_DIR` | `./data/artifacts` | 文件存储目录 |
| `AGENT_BEAN_AGENT_TOKEN` | `default:default:dev-token-change-me` | Agent 接入令牌 |

## 测试

```bash
npm test    # 运行 DAO、认证、消息路由等测试
```
