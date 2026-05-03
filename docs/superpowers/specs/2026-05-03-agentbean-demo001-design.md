---
title: AgentBean demo001 — Agent-Only Demo 设计
date: 2026-05-03
branch: docs/demo001
related_requirements: docs/demo001/agentbean-basic-demo-agent-only-requirements.md
status: 待用户复核
---

# AgentBean demo001 — Agent-Only Demo 设计

## 1. 概览

本设计文档对应 `docs/demo001/agentbean-basic-demo-agent-only-requirements.md` 中描述的 demo001 — Agent-Only 版。目标是用最小可演示闭环验证「人类从 Agent 池挑选真实 Agent → 创建频道 → Agent 自我介绍 → 频道内继续协作」这条核心人机协作链路。

设计原则:

- **演示可信度优先**: 所有 Agent 由真实 CLI 子进程驱动 (Codex CLI / Claude Code CLI / OpenClaw / Hermes),不引入规则回复或假数据 (D-2)。
- **状态驱动权威化**: Agent 在线状态由真实连接 + 应用层心跳决定,前端不做手动切换 (D-3, 技术考量)。
- **结构最小但可扩展**: 三层进程拆分 + CliAdapter 抽象,后续接入更多 CLI 不改动 daemon 核心。
- **人类负担最小**: 不强制登录,默认进入 Agent 协作页 (D-7, AC-1.1)。

本 demo 不覆盖: 多协作空间、私信、任务系统、长期记忆、生产级安全沙箱、移动端/桌面端 (见需求文档「非目标」节)。

## 2. 系统拓扑

三类长生命周期进程,通过 WebSocket (Socket.IO) 通信:

```
┌───────────────────────┐        Socket.IO /web (anonymous)
│  Web (Next.js 14)     │ ◄─────────────────────────────────┐
│  apps/web             │                                   │
│  Tailwind + shadcn/ui │                                   │
└───────────────────────┘                                   │
                                                            │
                                                ┌───────────▼───────────┐
                                                │  Server               │
                                                │  apps/server          │
                                                │  Node + Express       │
                                                │  + Socket.IO          │
                                                │  + better-sqlite3     │
                                                └───────────▲───────────┘
                                                            │
                              ┌─────────────────────────────┴────────────────────────┐
                              │ Socket.IO /agent (token = AGENT_BEAN_AGENT_TOKEN)    │
                              │                                                      │
              ┌───────────────▼──────────┐  ┌──────────────────┐  ┌──────────────────┐
              │  Agent daemon            │  │  Agent daemon    │  │  Agent daemon    │
              │  apps/agent              │  │  ...             │  │  ...             │
              │  agent.config.yaml       │  │                  │  │                  │
              │   ├ id / name / role     │  │                  │  │                  │
              │   └ adapter: codex|...   │  │                  │  │                  │
              └───────────┬──────────────┘  └──────────────────┘  └──────────────────┘
                          │ spawn / stdin-stdout
                          ▼
                  ┌───────────────┐
                  │  CLI process  │  e.g. `codex`, `claude`, `openclaw`, `hermes`
                  └───────────────┘
```

关键点:

- **Server 是唯一的状态权威**。它持有 `AgentRegistry` (in-memory) 和 SQLite (持久化),广播来自 daemon 的状态/消息事件给 Web 客户端,反向把 Web 发来的频道消息分发给 daemon。
- **Web 永不直接连 daemon**;反之亦然。所有跨方向通信走 Server 中转,这样登录/鉴权策略可以分别绑定到不同 namespace (`/web` 不要求登录,`/agent` 要求 token)。
- **Agent daemon 与 CLI 进程是 1:1**。一个 daemon 进程 = 一个 Agent 身份;多个身份就启动多个 daemon。daemon 重启即顶替旧连接 (last-writer-wins)。
- **Socket.IO 而非裸 ws**。原因: 自带房间 (room) 模型契合频道广播、自带断线重连、自带 ack 语义,可显著减少自研协议代码。

## 3. 仓库结构

外层仓库 `/Users/shaw/AgentBean/` 已存在并跟踪 `docs/`,以及未来在 `apps/` 下的子目录占位。每个子应用有自己的 `.git`,以便独立部署、独立提交历史。

```
/Users/shaw/AgentBean/
├── .git/                         (外层仓库,管理 docs/, apps/ 目录占位)
├── .gitignore                    (排除 apps/<name>/.git 内容,只跟踪占位)
├── README.md
├── docs/
│   ├── demo001/                  (需求与示意图)
│   └── superpowers/specs/        (本设计文档所在)
└── apps/
    ├── web/                      (独立 .git)
    │   ├── package.json
    │   ├── next.config.mjs
    │   ├── app/
    │   │   ├── layout.tsx
    │   │   ├── (agents)/page.tsx        # /agents
    │   │   ├── (agents)/[agentId]/page.tsx
    │   │   └── (channels)/[channelId]/page.tsx
    │   ├── components/ui/        (shadcn/ui)
    │   └── lib/socket.ts         (Socket.IO 客户端封装)
    │
    ├── server/                   (独立 .git)
    │   ├── package.json
    │   ├── src/
    │   │   ├── index.ts          (HTTP + Socket.IO 启动)
    │   │   ├── namespaces/
    │   │   │   ├── web.ts        (/web namespace)
    │   │   │   └── agent.ts      (/agent namespace,token 校验)
    │   │   ├── registry.ts       (AgentRegistry: in-memory 在线表)
    │   │   ├── channels.ts       (频道与成员关系)
    │   │   ├── routing.ts        (人类消息 → daemon 分发策略)
    │   │   ├── db.ts             (better-sqlite3 schema 与 DAO)
    │   │   └── log.ts            (pino,结构化日志)
    │   └── data/agentbean.db     (SQLite 文件,运行时生成)
    │
    └── agent/                    (独立 .git)
        ├── package.json
        ├── src/
        │   ├── index.ts          (启动一个 daemon)
        │   ├── adapters/
        │   │   ├── adapter.ts    (CliAdapter 接口)
        │   │   ├── codex.ts
        │   │   ├── claude-code.ts
        │   │   ├── openclaw.ts
        │   │   └── hermes.ts
        │   ├── connection.ts     (与 server 的 Socket.IO 客户端 + 心跳)
        │   └── config.ts         (读取 agent.config.yaml)
        ├── examples/
        │   └── agent.config.yaml.example
        └── README.md             (含「接入命令」文档片段,UI 也复用这段)
```

`.gitignore` 关键行 (外层仓库):

```
apps/*/.git/
apps/*/node_modules/
apps/server/data/
```

## 4. 组件设计

### 4.1 apps/web (Next.js 14 + App Router)

页面:

- `/agents` (默认入口) — Agent 池卡片网格。每张卡片展示 名称 / 角色标签 / 状态徽标 (在线/处理中/离线/异常)。空态展示「启动一个 Agent daemon 即可看到它出现」。
- `/agents/[agentId]` — Agent 详情页。展示名称、角色摘要、状态、最近活跃时间、最近一次连接错误摘要 (若有),以及该 Agent 的接入命令 (例如 `cd apps/agent && AGENT_CONFIG=examples/codex-shaw.yaml npm run dev`)。
- `/channels/[channelId]` — 频道页。左侧导航 (`agents` / `频道` 两入口),主区为消息流 + 底部输入框。
- 创建频道使用 modal/对话框,触发自 `/channels` 入口的「新建频道」按钮。表单: 频道名 (可选,不填默认 `频道 1`) + Agent 多选。

状态管理:

- Zustand store (`useAgentBeanStore`):
  - `agents: Map<AgentId, AgentSnapshot>`
  - `channels: Map<ChannelId, ChannelSnapshot>`
  - `messagesByChannel: Map<ChannelId, ChatMessage[]>`
  - `connection: 'connecting' | 'open' | 'lost'`
- 所有变更都来自 server 推送,前端不做乐观更新 (除发消息时的 `pending` 占位)。

### 4.2 apps/server (Node + Express + Socket.IO)

模块:

- `index.ts`: 启动 HTTP server (健康检查 `/healthz`) + Socket.IO server,监听 `:4000`。
- `namespaces/web.ts`: 处理 `connection`, `subscribeAgents`, `subscribeChannel`, `createChannel`, `sendMessage`。
- `namespaces/agent.ts`: 校验 `auth.token === process.env.AGENT_BEAN_AGENT_TOKEN`;处理 `register`, `heartbeat`, `joinChannel`, `reply`, `error`。
- `registry.ts`: `AgentRegistry` 类,维护 `Map<AgentId, AgentRuntime>`。`AgentRuntime` 包含 `socketId`, `lastHeartbeatAt`, `status`, `currentChannels`。提供 `register`, `kick (旧连接被踢)`, `heartbeat`, `markOffline`, `snapshot`。
- `channels.ts`: 频道 CRUD;`addMember`, `members(channelId)`, `channelsContaining(agentId)`。所有写操作落库,内存只是查询缓存。
- `routing.ts`: 见 §8。
- `db.ts`: 模式见 §5。所有 SQL 通过 prepared statement,DAO 暴露 `agents.upsert/getAll`, `channels.create/get`, `channelMembers.add/list`, `messages.append/listByChannel`。

后台任务:

- 心跳扫描器: 每 5 秒扫一次 `AgentRegistry`,把超过 30 秒未心跳的 Agent 标记为离线,广播 `agent:status` (`status=offline`, reason=`heartbeat-timeout`),并向受影响频道发系统消息。
- 优雅关闭: SIGINT 时主动通知所有 Web 客户端 `server:shutdown` 并关闭 db。

### 4.3 apps/agent (TypeScript daemon)

启动流程:

1. 加载 `agent.config.yaml` (路径来自 `AGENT_CONFIG` 环境变量,默认 `./agent.config.yaml`)。
2. 实例化对应 `CliAdapter`。
3. 建立 Socket.IO 连接到 `process.env.AGENT_BEAN_SERVER_URL` (默认 `http://localhost:4000/agent`),`auth: { token, agentId }`。
4. 收到 `connect` 后发送 `register` 事件,内容来自 config。
5. 启动心跳定时器: 每 10 秒发 `heartbeat` (服务端 30 秒视为离线,留 3x 容错)。
6. 监听 `dispatch` 事件,逐条转发到 adapter,adapter 输出后发 `reply` 事件回服务端。

config 示例 (`agent.config.yaml.example`):

```yaml
id: shaw-a1-social
name: 肖-a1-社媒
role: 社交媒体运营
adapter:
  kind: codex            # codex | claude-code | openclaw | hermes
  command: codex          # 必须在 PATH 中可执行
  args: ['--no-banner']
  cwd: ~/projects/social
  systemPrompt: |
    你是肖团队的社媒运营助手。简洁地用中文回答。
server:
  url: http://localhost:4000/agent
  token: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000
```

## 5. 数据模型

SQLite 通过 `better-sqlite3` 同步驱动。模式 (`apps/server/src/db.ts` 内部 `init()` 创建):

```sql
CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  role            TEXT,
  adapter_kind    TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  last_error      TEXT
);

CREATE TABLE IF NOT EXISTS channels (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)   REFERENCES agents(id)   ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_members_agent
  ON channel_members(agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,            -- ulid
  channel_id   TEXT NOT NULL,
  sender_kind  TEXT NOT NULL,               -- 'human' | 'agent' | 'system'
  sender_id    TEXT,                        -- agentId,system 消息为 NULL
  body         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,            -- epoch ms
  meta_json    TEXT,                        -- 系统消息分类、错误码等
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created
  ON messages(channel_id, created_at);
```

In-memory 状态 (`AgentRegistry`):

```ts
type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';

interface AgentRuntime {
  id: string;
  name: string;
  role: string;
  adapterKind: 'codex' | 'claude-code' | 'openclaw' | 'hermes';
  status: AgentStatus;
  socketId: string | null;
  lastHeartbeatAt: number;     // epoch ms
  lastError?: { at: number; message: string };
}
```

`agents` 表上的 `last_seen_at` 由心跳扫描器周期性 flush;不在每次 heartbeat 都写库,以避免 IO 压力。

## 6. 通信协议

### 6.1 `/web` namespace (Web ↔ Server)

匿名连接,无 token (D-7)。客户端订阅模式:

| 方向 | 事件 | payload | 用途 |
| --- | --- | --- | --- |
| C→S | `agents:subscribe` | `{}` | 进入 `/agents` 时订阅全量 Agent 快照 + 增量更新 |
| C→S | `channels:subscribe` | `{}` | 进入频道列表/侧栏时订阅 |
| C→S | `channel:join` | `{ channelId }` | 进入频道页,加入 Socket.IO room `channel:<id>` |
| C→S | `channel:create` | `{ name?, agentIds[] }` | 创建频道。校验 `agentIds.length>=1`,否则返回 ack `{ ok:false, error:'NO_AGENT' }` |
| C→S | `message:send` | `{ channelId, body, clientMsgId }` | 用户发文本。空白/全空白返回 `{ ok:false, error:'EMPTY' }` |
| S→C | `agents:snapshot` | `AgentSnapshot[]` | 订阅成功后第一帧 |
| S→C | `agent:status` | `AgentSnapshot` | Agent 状态/活跃时间增量 |
| S→C | `channels:snapshot` | `ChannelSummary[]` | |
| S→C | `channel:message` | `ChatMessage` | 转发 daemon 回复或回放用户消息 |
| S→C | `channel:system` | `SystemMessage` | 上线/离线/失败 等系统消息 |

`AgentSnapshot`:

```ts
interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
  status: 'connecting' | 'online' | 'busy' | 'offline' | 'error';
  lastSeenAt: number;
  lastError?: string;
  connectCommand: string;       // server 渲染的接入命令字符串(详情页用)
}
```

### 6.2 `/agent` namespace (Daemon ↔ Server)

Connection-time auth: `auth: { token, agentId, name, role, adapterKind }`。token 不匹配直接断开,记录 `auth-failed` 错误。

| 方向 | 事件 | payload |
| --- | --- | --- |
| D→S | `register` | `{ id, name, role, adapterKind, connectCommand }` (rebroadcast 给 web) |
| D→S | `heartbeat` | `{ at: number }` |
| D→S | `reply` | `{ channelId, body, inReplyToMsgId?, requestId }` |
| D→S | `error` | `{ at, message, scope: 'startup'\|'reply'\|'health' }` |
| S→D | `channel:join` | `{ channelId, history: ChatMessage[] (最近 N 条) }` |
| S→D | `channel:leave` | `{ channelId }` |
| S→D | `dispatch` | `{ requestId, channelId, prompt, sender: { kind, name }, history }` |

注意:

- daemon 收到 `dispatch` 后转 adapter,**串行处理本 daemon 的请求** (一个 CLI 进程同时只能有一个推理)。多并发请求在 daemon 侧排队,服务端等待 `reply` 或 `error`,30 秒未回视为超时。
- 重连后重新走 `register`,服务端按 `agentId` last-writer-wins,旧 socket 被踢并广播一条 `agent:status` 离线→在线切换。

## 7. CLI 适配层

```ts
// apps/agent/src/adapters/adapter.ts
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  speaker: string;        // 名字 (用户名 / Agent 名)
  body: string;
  at: number;
}

export interface CliAdapter {
  readonly kind: 'codex' | 'claude-code' | 'openclaw' | 'hermes';

  /** 一次问答。实现内部负责喂入 system prompt + history + prompt,并阻塞到 CLI 输出完成。*/
  ask(input: { prompt: string; history: ChatTurn[] }, signal: AbortSignal): Promise<string>;

  /** 用于 daemon 启动时探测可用性。失败 → daemon 进入 status=error,注册时即报告。*/
  health(): Promise<{ ok: boolean; detail?: string }>;
}
```

四个具体适配器在 demo 范围内可分阶段实现:

- M2 必须有: `codex`, `claude-code` (二者均提供命令行交互模式)。
- M3 加上: `openclaw`, `hermes` (用户已确认两者均有可运行 CLI)。

每个适配器通过 `child_process.spawn` 拉起 CLI,使用「单次任务,单次进程」策略以避免长生命周期里的状态污染:

1. `ask()` 调用时 spawn 一个新 CLI 进程。
2. 把 history 与 system prompt 拼成一段输入,通过 stdin 写入。
3. 收集 stdout 直到子进程退出。
4. stderr 累计,如非空则计入 result.detail (但只要 stdout 有内容就视为成功)。
5. `signal.aborted` → `child.kill('SIGTERM')`,2 秒后 SIGKILL。

如某 CLI 不支持 stdin 一把梭 (例如需要交互式 prompt),则在该 adapter 内部使用 pty (`node-pty`),demo 阶段先不引入,留 §12 TBD。

## 8. 消息路由与会话流转

### 8.1 创建频道

```
Web                 Server                   Daemons (member set)
 │  channel:create   │                          │
 ├──────────────────►│ persist channel + members
 │                   │ for each online member: dispatch自我介绍 prompt
 │  ack {ok, id}     │ ─────────────────────────► (per agent) ask("自我介绍...")
 │◄──────────────────│
 │                   │ ◄─────── reply (intro)
 │  channel:message  │
 │◄──────────────────│
```

`自我介绍 prompt` 模板 (server 拼装):

```
你刚被加入频道「{channelName}」。请用 1-2 句中文自我介绍,说清你的角色「{role}」与你最擅长的事。不要讨好,不要表情。
```

### 8.2 人类消息分发

服务端 `routing.ts` 有一个待用户实现的核心函数 `routeHumanMessage`。逻辑要点:

- 解析 `body` 中 `@<name>` 提及。
- 若有命中且 Agent 在线 → 仅这些 Agent 收到 `dispatch`。
- 若没有命中 → 选择频道内**第一个在线 Agent** (按加入时间) 收到 `dispatch`。
- 没有任何在线 Agent → 不 dispatch,但写入 system 消息 `当前没有在线 Agent 可响应`。

```ts
// apps/server/src/routing.ts
export interface RouteContext {
  channelId: string;
  body: string;
  members: AgentRuntime[];   // 频道全部成员快照,顺序 = 加入顺序
}

export interface RouteDecision {
  recipients: string[];      // agentId 列表
  systemHint?: string;       // 若没有人能响应,server 据此发系统消息
}

/**
 * TODO(用户实现 5-10 行): 根据 body 中是否包含 `@name` 提及决定接收者。
 * 设计意图见 §8.2;命名匹配规则: 大小写不敏感、允许中文,要求紧跟 `@`。
 * 没有命中且至少有一个在线 Agent → 返回该频道内第一个在线者。
 * 全部离线 → recipients=[], systemHint='当前没有在线 Agent 可响应'。
 */
export function routeHumanMessage(ctx: RouteContext): RouteDecision {
  // implement here
  throw new Error('not implemented');
}
```

(此函数属于 §12 中明确请用户参与实现的位置。)

### 8.3 心跳与状态机

```
status 状态机:
  connecting --register--► online
  online   --no heartbeat 30s--► offline
  online   --dispatch--► busy --reply--► online
  busy     --dispatch err--► error --next heartbeat--► online
  *        --socket disconnect--► offline
```

## 9. 错误处理与降级

| 场景 | 行为 |
| --- | --- |
| daemon 心跳超时 (>30s) | 标记 offline,频道发系统消息 `<name> 已离线` |
| daemon Ctrl-C | 同上,但 `disconnect` 立即触发 |
| daemon 重连 (相同 agentId) | 旧 socket 被踢 (`kick`),新连接覆盖。频道发 `<name> 已重新上线` |
| daemon `error` 事件 | 若 scope=startup → 状态=error,UI 详情页显示 lastError |
| dispatch 30s 无 reply | 频道发 `<name> 处理超时`,状态恢复 online (假设 daemon 仍存活) |
| 用户消息为空白 | server ack `{ok:false, error:'EMPTY'}`,UI 不清空输入框 |
| 频道无在线 Agent 时发消息 | 消息照常入库 (sender=human),server 发系统消息提示 |
| 离线 Agent 被选入新频道 | 允许创建,频道展示 `<name> 当前不可用`,Agent 上线后不会自动追加自我介绍 (M2 范围) |
| Web 断线 | Socket.IO 自动重连,UI 顶部展示 `连接中...` 横幅 |

## 10. 验收标准映射

| AC | 实现位点 |
| --- | --- |
| AC-1.1 / AC-1.2 / AC-1.3 | Web 路由层默认放行;若启用 LOGIN_MODE=test-account 则 middleware 校验固定账号 |
| AC-2.1 / AC-2.3 | `/agents` 页面 + `agents:snapshot` |
| AC-2.2 | `/agents` 空态组件 |
| AC-2.4 | `agent:status` 增量推送 + Zustand 合并 |
| AC-3.1 / AC-3.2 | `/agents/[id]` 页面渲染 AgentSnapshot |
| AC-3.3 | server 用模板生成 `connectCommand` 字段 |
| AC-3.4 | 心跳扫描器 + status=offline |
| AC-4.1 / AC-4.2 | 频道创建 modal + `channel:create` |
| AC-4.3 | server 校验 + UI 表单校验 |
| AC-4.4 | UI 在选择中的离线 Agent 旁标识 `当前不可用` |
| AC-4.5 | `channels:snapshot` 增量 |
| AC-5.1 | server 在 `channel:create` 后向在线成员 dispatch 自我介绍 prompt |
| AC-5.2 | 离线成员跳过,发 system 消息 |
| AC-5.3 | dispatch 超时/失败 → 系统消息 |
| AC-5.4 | 服务端串行 emit,前端按 `created_at` 排序 |
| AC-6.1 / AC-6.4 | `message:send` + 路由分发 |
| AC-6.2 | server + UI 双重空白校验 |
| AC-6.3 | UI 在 ack timeout 后展示 `重试` 按钮 |
| AC-7.1 / AC-7.2 / AC-7.5 | dispatch 仅发给频道成员 + `sender_kind=agent` |
| AC-7.3 / AC-7.4 | error/timeout 分支 + 状态机 |
| AC-8.1 / AC-8.4 | routing.ts `systemHint` 路径 |
| AC-8.2 | UI 卡片状态徽标 |
| AC-8.3 | 重连流 |

## 11. 里程碑

| ID | 范围 | 验收门 |
| --- | --- | --- |
| M0 | 三个独立仓库脚手架 + .gitignore + 占位 README | 三个 `npm run dev` 都能起,server `:4000/healthz` 200 |
| M1 | Server `/agent` namespace + 1 个 codex daemon 能 register/heartbeat,Web `/agents` 显示 1 张卡片 | 关掉 daemon 30s 后 UI 变离线 |
| M2 | 频道创建 + 自我介绍 + 人类消息分发 + 单 Agent 回复 (codex 一种) | demo 闭环跑通 (G-1..G-7 路径) |
| M3 | 接入第二个 adapter (claude-code),@-mention 路由,失败/超时系统消息,UI 接入命令展示 | 多 Agent 频道协作演示 |
| M4 (可选) | OpenClaw / Hermes adapter,多人多 daemon 演示 | 真机演示 |

每个里程碑结束都做一次 `git commit` 三个仓库 + 外层仓库 doc 同步。

## 12. 待定事项 (TBD)

- **[TBD-1] 无认证下的 abuse**: Web 完全匿名,任何打开页面的人都能发消息触发 LLM 调用产生计费。本地开发可接受,生产化前需要补一层简单 token。M2 先不处理,留作 §10 之外的待评估项。
- **[TBD-2] 长 history 截断策略**: 目前 dispatch 把全部频道历史发给 daemon。当频道很长时会撑爆 CLI 上下文。M2 暂定截断为最近 50 条,M3 再优化。
- **[TBD-3] CLI 输出非纯文本**: 部分 CLI 默认输出彩色 ANSI 或思考过程标记,需要在 adapter 中剥离。具体每个 adapter 的解析逻辑在实现时再确定。
- **[TBD-4] 自我介绍消息归类**: 当前作为普通 `agent` 消息入库;若想区分,可引入 `meta_json.kind='intro'`,M3 视 UI 需求决定。
- **[TBD-5] node-pty 依赖**: 如果某个 CLI 必须通过 PTY 才能跑,需要引入 `node-pty`,会带来跨平台编译。M2 内不引入,M3 评估。
- **[TBD-6] 用户自填的 routeHumanMessage**: 见 §8.2,该函数留给用户写 5-10 行,作为本 demo 中最有「设计参与感」的代码点。

---

附: 与需求文档已确认决策的对应关系

| 需求决策 | 设计落点 |
| --- | --- |
| D-1 仅 Agent 维度 | 全部组件围绕 Agent 池/详情/频道 |
| D-2 真实 Agent | §7 CLI 适配层,无 mock 路径 |
| D-3 心跳 30s | §4.2 / §8.3 心跳扫描器 |
| D-4 创建频道选择 Agent | §6.1 `channel:create` 校验 + UI 表单 |
| D-5 自我介绍 | §8.1 流程 |
| D-6 接入命令 | `AgentSnapshot.connectCommand` |
| D-7 不强制登录 | `/web` 匿名,`/agent` 仅 daemon 用 token |
