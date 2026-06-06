# AgentBean Next Preview 实施计划

> **给 agentic workers 的说明：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务逐项执行本计划。步骤使用 checkbox（`- [ ]`）语法追踪进度。

**目标：** 做出一个本地可运行的 AgentBean Next preview：能从 device runtime capability 创建 custom agent，发送消息，并收到 agent 回复。

**架构：** 沿用现有切片节奏。先把 public agent contracts 与中文文档对齐，再增加 server/web 的 custom agent 创建命令，并绑定到 runtime capability，同时保持 scanner 不自动创建 visible agent。最后补上最小本地 preview wiring，覆盖 daemon/server/web 的消息闭环。

**技术栈：** TypeScript、Vitest、Socket.IO test clients、临时 SQLite repositories，以及现有 `packages/contracts`、`packages/domain`、`apps/server-next`、`apps/daemon-next`、`apps/web-next`。

---

### 任务 1：对齐 Agent Public Contracts

**文件：**
- 修改：`packages/contracts/src/agent.ts`
- 修改：`packages/contracts/tests/contracts.test.ts`
- 验证：`agentbean-next/docs/contracts-dto.md`

- [ ] **步骤 1：编写失败的 contract test**

增加断言，证明 public `AgentDto` 支持 `source: "custom"`、`source: "self-register"`、`category: "agentos-hosted"`、`status: "error"`、`command`、`args`、`cwd`、`envKeys`，并证明 `DiscoveredAgentDto` 不要求 persisted IDs。

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:contracts
```

预期：TypeScript/Vitest 失败，因为当前 contract 仍使用 `created/imported`，缺少若干文档字段，并且 discovered-agent 仍要求 persisted fields。

- [ ] **步骤 3：实现最小 contract alignment**

修改 `packages/contracts/src/agent.ts`，让 `AdapterKind`、`AgentCategory`、`AgentSource`、`AgentStatus`、`AgentDto`、`RuntimeDto`、`DiscoveredAgentDto` 与 `agentbean-next/docs/contracts-dto.md` 保持一致。

- [ ] **步骤 4：运行 contract test 并确认变绿**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:contracts
```

预期：contract tests 通过。

### 任务 2：在对齐后的 contracts 下保持 Server/Web/Daemon 全绿

**文件：**
- 修改：`apps/server-next/src/application/usecases.ts`
- 修改：`apps/server-next/src/application/repositories.ts`
- 修改：`apps/server-next/src/infra/memory/repositories.ts`
- 修改：`apps/server-next/src/infra/sqlite/repositories.ts`
- 修改：`apps/server-next/tests/*`
- 修改：`apps/daemon-next/tests/*`
- 修改：`apps/web-next/tests/*`

- [ ] **步骤 1：运行 phase tests，暴露 contract fallout**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
```

预期：只在旧 contract 命名或旧 required fields 仍被引用的位置失败。

- [ ] **步骤 2：更新实现和测试 fixtures**

统一使用 canonical values：

```ts
source: "self-register" | "scanned" | "custom"
category: "executor-hosted" | "agentos-hosted"
status: "connecting" | "online" | "busy" | "offline" | "error"
```

- [ ] **步骤 3：运行完整 phase tests**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
```

预期：所有 phase tests 通过。

### 任务 3：增加 Custom Agent Create Contract 和 Use Case

**文件：**
- 修改：`packages/contracts/src/agent.ts`
- 修改：`packages/contracts/src/socket.ts`
- 修改：`apps/server-next/src/application/usecases.ts`
- 修改：`apps/server-next/src/transport/socket-handlers.ts`
- 修改：`apps/server-next/src/transport/socket-server.ts`
- 修改：`apps/server-next/tests/first-slice.test.ts`
- 修改：`apps/server-next/tests/socket-integration.test.ts`

- [ ] **步骤 1：编写失败的 server use-case test**

测试 team member 可以在 online device 上，基于 installed runtime 创建 custom agent。预期 agent fields：

```ts
{
  source: "custom",
  category: "executor-hosted",
  status: "online",
  visibleTeamIds: ["team-1"],
  deviceId: "device-1",
  command: "/opt/homebrew/bin/codex",
  cwd: "/opt/homebrew/bin",
  envKeys: ["OPENAI_API_KEY"]
}
```

- [ ] **步骤 2：确认测试失败**

使用 Node v24.15.0 运行 targeted server-next tests。

- [ ] **步骤 3：实现最小 `createCustomAgent` use case**

规则：

- 校验 user 是 device 所属 team 的 member。
- 校验目标 device 属于同一个 team。
- 如果传入 `runtimeId`，校验该 runtime 属于该 device，并且已安装。
- 持久化一个 visible custom `AgentDto`。
- Public DTO 只保存 env keys；不要在 snapshots 中暴露 raw env values。

- [ ] **步骤 4：为 `agent:create` 增加 socket handler**

将 `WEB_EVENTS.agent.create` 绑定到 `createCustomAgent`，并在成功后刷新 `agents:snapshot` subscribers。

- [ ] **步骤 5：验证 use-case 和 socket tests 通过**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next
```

### 任务 4：增加 Web Client Custom Agent Command

**文件：**
- 修改：`apps/web-next/src/index.ts`
- 修改：`apps/web-next/tests/socket-client.test.ts`

- [ ] **步骤 1：编写失败的 web client test**

测试 web-next 会发出 `agent:create`，收到 `Ack<{ agent }>`，并能刷新 agent snapshots。

- [ ] **步骤 2：实现最小 client method**

在 web socket client 中增加 `createAgent(input)`，复用现有 ack handling。

- [ ] **步骤 3：验证 web-next tests 通过**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:web-next
```

### 任务 5：增加 Preview Smoke

**文件：**
- 创建或修改：`apps/server-next/tests/preview-smoke.test.ts`
- 修改文档：`agentbean-next/README.md`
- 创建文档：`agentbean-next/docs/fifteenth-slice-status.md`

- [ ] **步骤 1：编写失败的 smoke test**

Smoke flow：

```text
register -> daemon hello -> runtime report -> device:get -> agent:create -> agents:subscribe -> channel:create -> message:send -> dispatch:result -> agent reply visible
```

- [ ] **步骤 2：只实现缺失的 preview pieces**

避免做大范围 UI 工作。只要能证明本地可运行和真实消息流，preview 可以先基于 socket/client。

- [ ] **步骤 3：验证完整 phase 和 build**

运行：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
git diff --check
```

预期：全部通过。
