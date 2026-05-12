# AgentBean Device Daemon

Agent 适配器层 —— 运行在用户机器上，将真实 Coding Agent 接入 AgentBean Server。

## 启动

```bash
npm install
npm run dev    # 开发模式（tsx watch）
npm start      # 运行（tsx）
npm test       # 运行测试
```

### 带配置文件启动

```bash
npx tsx src/index.ts ~/.agentbean/device-agent.yaml
```

### 自动扫描模式

如果不提供配置文件，或配置文件中 `agents` 数组为空，Daemon 会自动扫描本机 Agent：

```bash
npx tsx src/index.ts
# 扫描 Coding Agent (which claude-code, codex, kimi...)
# 扫描 AgentOS Gateway (localhost:PORT)
# 扫描 ~/.agentbean/agents/ 目录
```

## 配置文件格式

`device-agent.yaml`：

```yaml
deviceId: my-macbook-pro      # 设备标识
networkId: default            # 所属网络
server:
  url: http://localhost:3000/agent    # Server Socket.IO 地址
  token: default:default:dev-token-change-me    # 三截 token
heartbeatIntervalMs: 10000    # 心跳间隔（默认 10s）

agents:                       # Agent 配置列表
  - id: claude-shaw
    name: Claude
    role: 高级编程助手
    category: coding          # coding | executor-hosted | agentos-hosted | standalone-cli
    visibility: public        # public | private
    adapter:
      kind: claude-code       # claude-code | codex | openclaw | hermes | standalone
      command: claude         # 可执行命令
      args: []                # 命令参数
      cwd: ~/projects          # 工作目录（可选）
      systemPrompt: |          # 系统提示词（可选）
        You are a helpful coding assistant.
```

支持环境变量插值：`${SERVER_URL}`

## 核心模块

### 设备守护进程 (`device-daemon.ts`)

`DeviceDaemon` 类：
- 维护与 Server 的 Socket.IO 连接
- 管理多个 `AgentInstance`
- 定期发送心跳
- 处理 Server 下发的 `dispatch` 任务

### Agent 实例 (`agent-instance.ts`)

`AgentInstance` 封装单个 Agent：
- 持有 `CliAdapter`（适配器实例）
- 管理 Agent 生命周期（启动、运行、停止）
- 将 Server 的 `dispatch` 转换为适配器输入
- 将适配器输出包装为 `reply` 发送回 Server

### 扫描器 (`scanner.ts`)

三类自动发现：

**`scanCodingAgents()`** — 通过 `which` 发现本机 Coding Agent：
```typescript
const CODING_BINARIES = ['claude-code', 'codex', 'kimi'];
// 对每个执行 which，存在的加入结果
```

**`scanAgentOSAgents()`** — 扫描 OpenClaw / Hermes gateway：
- 尝试连接 `http://localhost:PORT/openclaw/agents`
- 如果 gateway 未运行，返回空数组

**`scanLocalAgents(scanDir)`** — 扫描约定目录：
- 扫描 `~/.agentbean/agents/` 或指定目录
- 查找 `agent.json` / `agent.yaml` 配置文件
- 识别执行器承载型（有 `executor` 字段）和独立 CLI Agent

### 连接管理 (`connection.ts`)

`createConnection()`：
- 建立 Socket.IO 连接到 Server `/agent` 命名空间
- 发送 `register` 事件进行认证
- 自动重连和心跳
- 处理 `dispatch` 事件并路由到对应 Agent

### CLI 适配器 (`adapters/`)

| 适配器 | 说明 | 命令 |
|--------|------|------|
| `ClaudeCodeAdapter` | Anthropic Claude Code | `claude` |
| `CodexAdapter` | OpenAI Codex CLI | `codex` |
| `OpenClawAdapter` | OpenClaw gateway | `openclaw` |
| `HermesAdapter` | Hermes gateway | `hermes` |

所有适配器实现 `CliAdapter` 接口：
```typescript
interface CliAdapter {
  start(): void;
  stop(): void;
  send(input: string): void;
  onOutput(handler: (text: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
}
```

底层使用 `node-pty` 创建伪终端与 CLI 工具交互，支持实时流式输出。

### 配置解析 (`config.ts`)

- `loadConfig()` — 解析单 Agent 配置
- `loadDeviceConfig()` — 解析设备级多 Agent 配置
- `AgentCategory` — 四类 Agent 分类
- `AdapterKind` — 五种适配器类型
- 支持 YAML 环境变量插值

## 启动流程

```
1. 解析命令行参数（配置文件路径）
2. 尝试 loadDeviceConfig() — 静态配置优先
3. 如果无静态配置或 agents 数组为空：
   a. scanCodingAgents() — 扫描本机 CLI 工具
   b. scanAgentOSAgents() — 扫描 gateway
   c. scanLocalAgents() — 扫描约定目录
   d. 合并去重，生成 AgentConfigEntry 列表
4. 对每个 entry 创建 AgentInstance + 适配器
5. 创建 DeviceDaemon，连接 Server
6. 发送 register + 定期 heartbeat
7. 等待 dispatch 任务
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `SERVER_URL` | Server WebSocket 地址 |
| `SERVER_TOKEN` | 接入令牌 |
| `DEVICE_ID` | 设备标识 |
| `NETWORK_ID` | 所属网络 |
