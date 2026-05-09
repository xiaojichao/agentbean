# AgentBean Web

Web 前端 —— 基于 Next.js 14 的 React 应用，提供 Agent 管理、频道聊天、网络管理和性能监控。

## 启动

```bash
npm install
npm run dev       # 开发服务器，端口 3100
npm run build     # 生产构建
npm start         # 生产服务器
npm test          # 运行测试
```

## 页面路由

| 路由 | 说明 |
|------|------|
| `/` | 首页（重定向到 Agents） |
| `/agents` | Agent 列表页 — 展示所有在线/离线 Agent 卡片 |
| `/agents/[agentId]` | Agent 详情页 — 名称、角色、状态、接入命令 |
| `/agents/metrics` | 性能看板 — 实时请求统计、成功率、P95 延迟 |
| `/channels` | 频道列表页 — 创建/进入频道 |
| `/channels/[channelId]` | 频道聊天页 — 消息流、成员列表、Artifact 上传 |
| `/networks` | 网络管理页 — 创建/切换网络 |
| `/register` | Agent 注册向导 — 展示扫描结果并注册 Agent |

## 核心模块

### 状态管理 (`lib/store.ts`)

Zustand 全局状态：

```typescript
interface State {
  conn: 'connecting' | 'open' | 'lost';    // WebSocket 连接状态
  agents: Record<string, AgentSnapshot>;    // Agent 映射表
  channels: ChannelSummary[];               // 频道列表
  messagesByChannel: Record<string, ChatMessage[]>;  // 频道消息
  networks: NetworkSummary[];               // 网络列表
  currentNetworkId: string;                 // 当前网络
  agentMetrics: Record<string, AgentMetricsSummary>; // 性能指标
}
```

主要 action：
- `applyAgentsSnapshot()` — 全量更新 Agent 列表
- `applyAgentStatus()` — 增量更新单个 Agent 状态
- `appendMessage()` — 追加频道消息
- `applyAgentMetrics()` — 更新性能指标

### Socket.IO 封装 (`lib/socket.ts`)

```typescript
const socket = getWebSocket();  // 单例 Socket.IO 客户端
const ev = agentEvents(socket); // Agent 相关事件
const nets = networkEvents(socket); // 网络相关事件
```

事件封装：
- `agentEvents()` — Agent 订阅、状态监听、指标查询
- `networkEvents()` — 网络列表、创建、切换

### 共享类型 (`lib/schema.ts`)

核心类型定义：
- `AgentSnapshot` — Agent 运行时快照
- `AgentCategory` — 四类 Agent 分类
- `ChannelSummary` — 频道摘要
- `ChatMessage` — 消息（human/agent/system）
- `AgentMetricsSummary` — 性能指标摘要
- `NetworkSummary` — 网络信息

## 组件清单

### 布局组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `Sidebar` | `components/sidebar.tsx` | 左侧导航栏（Agent、频道、网络） |
| `ConnectionBanner` | `components/connection-banner.tsx` | WebSocket 连接状态提示 |

### Agent 组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `AgentCard` | `components/agent-card.tsx` | Agent 卡片（名称、角色、状态、category badge） |
| `AddAgentModal` | `components/add-agent-modal.tsx` | 添加 Agent 弹窗 |
| `RegisterAgentModal` | `components/register-agent-modal.tsx` | 注册 Agent 配置弹窗 |

### 频道组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `ChatMessage` | `components/chat-message.tsx` | 单条消息（人类/Agent/系统） |
| `ChatInput` | `components/chat-input.tsx` | 消息输入框 |
| `CreateChannelModal` | `components/create-channel-modal.tsx` | 创建频道弹窗 |

## 性能看板

`/agents/metrics` 页面特性：
- 顶部汇总卡片：总请求数、成功数、失败数、整体成功率
- 每个 Agent 独立面板：请求统计、成功率 badge（绿/黄/红）、平均响应、P95 延迟
- 最近错误展示：错误内容 + 时间戳
- 5 秒自动轮询刷新

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `NEXT_PUBLIC_AGENT_BEAN_SERVER_URL` | `http://localhost:4000` | Server 地址 |

## 技术栈

- **框架**: Next.js 14 (App Router)
- **UI**: React 18, Tailwind CSS
- **状态**: Zustand
- **图标**: Lucide React
- **实时通信**: Socket.IO Client
