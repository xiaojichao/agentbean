# 目标架构

AgentBean Next 保留三进程架构，但用显式边界替换当前的大文件协调风格。

## 系统形态

```text
apps/
  server-next/
    src/
      domain/
      application/
      infra/
      transport/
      bootstrap/
  web-next/
    app/
    features/
    lib/api/
    lib/session/
  daemon-next/
    src/
      execution/
      scanner/
      workspace/
      protocol/
      bootstrap/
```

该结构既可以作为新 apps 存在，也可以在当前 apps 内渐进替换。重要的是边界，而不是精确的文件夹名称。

## Server 边界

Server 是协作权威。它拥有 authentication、membership、persistence、routing decisions、device state、agent visibility、task state 与 artifact metadata。

### `domain/`

Pure types 与 rules。不包含 Socket.IO、Express、SQLite、file system 或 environment variables。

建议模块：

- `auth`
- `network`
- `member`
- `agent`
- `device`
- `channel`
- `message`
- `dm`
- `task`
- `artifact`
- `dispatch`

Domain rules 示例：

- 用户能看到哪些 channels。
- Agent 是否在某 network 中可见。
- 如何在 custom、self-register、scanned、runtime 与 AgentOS gateway reports 之间解析 agent identity 与 dedupe。见 `docs/agent-identity-rules.md`。
- Message 如何 route 到 agents。
- Daemon 是否允许 register device 或 agent。
- 如何从 heartbeat 与 device state 推导 agent status。

### `application/`

Use cases。每个 use case 协调 repositories、domain rules 与 outbound ports。

建议 use cases：

- `registerUser`
- `loginUser`
- `createNetwork`
- `switchNetwork`
- `createInvite`
- `completeDeviceInvite`
- `registerDevice`
- `publishAgent`
- `listVisibleAgents`
- `createChannel`
- `joinChannel`
- `sendMessage`
- `dispatchMessageToAgent`
- `receiveAgentReply`
- `createTask`
- `updateTaskStatus`
- `uploadArtifact`

Use cases 应返回 typed results 与 domain errors。Transport handlers 再把它们转换为 Socket.IO ack payloads 或 HTTP responses。

### `infra/`

在 interfaces 后面实现技术细节：

- SQLite repositories。
- Schema migrations。
- Artifact file storage。
- Password hashing。
- Token signing and verification。
- Clock 与 ID generation。
- 面向 connected sockets dispatch 的 daemon gateway。
- 面向 web snapshots 的 event publisher。

SQLite 可以保留。主要变化是停止把 raw database shape 暴露给 transport code。

### `transport/`

只做 adapters：

- `transport/socket/web`
- `transport/socket/agent`
- `transport/http/artifacts`
- `transport/http/health`

Transport 可以：

- Validate payload shape。
- 读取 auth context。
- 调用一个 use case。
- 将 result 映射为 ack 或 event。

Transport 不得：

- 构造 SQL。
- 直接 mutate registries。
- 决定 cross-domain behavior。
- 知道 artifacts 如何存储。
- 重新实现 agent visibility 或 dedupe rules。

## Web 边界

Web 是交互层，不应成为业务事实来源。

建议 feature modules：

- `features/auth`
- `features/networks`
- `features/chat`
- `features/agents`
- `features/devices`
- `features/tasks`
- `features/artifacts`
- `features/members`

每个 feature 应拥有：

- UI components。
- Feature hooks。
- Presentation-only state。
- 调用 typed API clients。

共享 client modules：

- `lib/api/socket-client`
- `lib/api/web-events`
- `lib/api/artifact-api`
- `lib/session/auth-token`
- `lib/session/network-selection`

Zustand store 应缩小为：

- Connection state。
- Current session。
- Current network。
- Server snapshots。
- Short-lived UI cache。

它不应包含：

- Agent dedupe algorithms。
- Permission rules。
- Channel visibility rules。
- Protocol-specific fallback behavior。

## Daemon 边界

Daemon 是 device bridge。即使 server 与 web 演进，它也应保持可靠。

建议模块：

- `protocol/agent-client`
  - Socket connection、auth、reconnect、event subscription、ack handling。
- `scanner/runtime-scanner`
  - PATH 与已知 runtime discovery。
- `scanner/agentos-scanner`
  - Hermes/OpenClaw gateway discovery。
- `scanner/local-agent-scanner`
  - Local config discovery。
- `execution/executor`
  - 所有 adapters 共用的 dispatch abstraction。
- `execution/adapters`
  - Codex、Claude Code、Kimi、Hermes、OpenClaw。
- `workspace/workspace-manager`
  - Run directories、artifact detection、metadata。
- `workspace/artifact-uploader`
  - 将 generated files 上传到 server。
- `bootstrap/cli`
  - CLI parsing 与 startup。

Daemon protocol code 不应知道 UI concepts。Execution code 不应知道 Socket.IO。

## 共享 Contracts

重写版需要一个单一 contract source，覆盖：

- Socket event names。
- Ack result shapes。
- DTOs。
- Domain error codes。
- Agent categories 与 adapter kinds。
- Task statuses。

它可以从一个共享 TypeScript package 开始：

```text
packages/contracts/
  src/
    auth.ts
    network.ts
    agent.ts
    device.ts
    channel.ts
    message.ts
    task.ts
    artifact.ts
    socket.ts
```

避免把 server domain modules 直接导入 web 或 daemon。Contracts 是边界 DTOs，不是完整 domain model。

## 持久化模型

保留两个 storage scopes：

- Global DB：
  - users
  - networks
  - network members
  - devices
  - agents
  - agent publishes
  - invites
  - join links
  - metrics
- Network DB：
  - channels
  - channel members
  - channel agent members
  - messages
  - DMs
  - tasks
  - artifacts
  - workspace runs

第一版重写可以使用 SQLite，但 migrations 必须是显式文件，而不是嵌入在大型 DB module 中的 ad hoc `ALTER TABLE` logic。

## 实现原则

- 每个 user-visible behavior 对应一个 use case。
- Transport handlers 保持薄。
- Domain rules 可在无 sockets 或 databases 的情况下测试。
- Repositories 隐藏 storage details。
- Web 接收 snapshots 与 command results；不推断 server-side truth。
- Daemon 报告 capabilities 与 execution results；不决定 network visibility。
- 每个迁移切片都先有 regression tests，再删除旧行为。
