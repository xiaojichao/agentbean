# AgentBean Next Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local AgentBean Next preview that can run locally, create a custom agent from a device runtime capability, send a message, and receive an agent reply.

**Architecture:** Keep the existing slice rhythm. First align public agent contracts with the Chinese docs, then add a server/web custom-agent creation command that binds to runtime capability without letting scanner auto-create visible agents, then add minimal local preview wiring for daemon/server/web.

**Tech Stack:** TypeScript, Vitest, Socket.IO test clients, temp SQLite repositories, existing `packages/contracts`, `packages/domain`, `apps/server-next`, `apps/daemon-next`, and `apps/web-next`.

---

### Task 1: Align Agent Public Contracts

**Files:**
- Modify: `packages/contracts/src/agent.ts`
- Modify: `packages/contracts/tests/contracts.test.ts`
- Verify: `agentbean-next/docs/contracts-dto.md`

- [ ] **Step 1: Write the failing contract test**

Add assertions that prove the public `AgentDto` accepts `source: "custom"`, `source: "self-register"`, `category: "agentos-hosted"`, status `error`, command/args/cwd/envKeys, and that `DiscoveredAgentDto` does not require persisted IDs.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:contracts
```

Expected: TypeScript/Vitest fails because current contract still uses `created/imported`, lacks several documented fields, and requires discovered-agent persisted fields.

- [ ] **Step 3: Implement minimal contract alignment**

Change `packages/contracts/src/agent.ts` to match `agentbean-next/docs/contracts-dto.md` for `AdapterKind`, `AgentCategory`, `AgentSource`, `AgentStatus`, `AgentDto`, `RuntimeDto`, and `DiscoveredAgentDto`.

- [ ] **Step 4: Run contract test to verify green**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:contracts
```

Expected: contract tests pass.

### Task 2: Keep Server/Web/Daemon Green Under Aligned Contracts

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/server-next/src/application/repositories.ts`
- Modify: `apps/server-next/src/infra/memory/repositories.ts`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`
- Modify: `apps/server-next/tests/*`
- Modify: `apps/daemon-next/tests/*`
- Modify: `apps/web-next/tests/*`

- [ ] **Step 1: Run phase tests to expose contract fallout**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
```

Expected: failures only where old contract names or required fields remain.

- [ ] **Step 2: Update implementation and fixtures**

Use canonical values:

```ts
source: "self-register" | "scanned" | "custom"
category: "executor-hosted" | "agentos-hosted"
status: "connecting" | "online" | "busy" | "offline" | "error"
```

- [ ] **Step 3: Run full phase tests**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
```

Expected: all phase tests pass.

### Task 3: Add Custom Agent Create Contract and Use Case

**Files:**
- Modify: `packages/contracts/src/agent.ts`
- Modify: `packages/contracts/src/socket.ts`
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/server-next/src/transport/socket-handlers.ts`
- Modify: `apps/server-next/src/transport/socket-server.ts`
- Modify: `apps/server-next/tests/first-slice.test.ts`
- Modify: `apps/server-next/tests/socket-integration.test.ts`

- [ ] **Step 1: Write failing server use-case test**

Test that a team member can create a custom agent bound to an installed runtime on an online device. Expected agent fields:

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

- [ ] **Step 2: Verify the test fails**

Run targeted server-next tests with Node v24.15.0.

- [ ] **Step 3: Implement minimal `createCustomAgent` use case**

Rules:
- Validate user is a member of the device team.
- Validate target device belongs to the same team.
- If `runtimeId` is supplied, validate runtime belongs to the device and is installed.
- Persist a visible custom `AgentDto`.
- Store only env keys in public DTO; never expose raw env values in snapshots.

- [ ] **Step 4: Add socket handler for `agent:create`**

Bind `WEB_EVENTS.agent.create` to `createCustomAgent` and refresh `agents:snapshot` subscribers after success.

- [ ] **Step 5: Verify use-case and socket tests pass**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:server-next
```

### Task 4: Add Web Client Custom Agent Command

**Files:**
- Modify: `apps/web-next/src/index.ts`
- Modify: `apps/web-next/tests/socket-client.test.ts`

- [ ] **Step 1: Write failing web client test**

Test that web-next emits `agent:create`, receives `Ack<{ agent }>` and refreshes agent snapshots.

- [ ] **Step 2: Implement minimal client method**

Add `createAgent(input)` to the web socket client using existing ack handling.

- [ ] **Step 3: Verify web-next tests pass**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:web-next
```

### Task 5: Add Preview Smoke

**Files:**
- Create or modify: `apps/server-next/tests/preview-smoke.test.ts`
- Modify docs: `agentbean-next/README.md`
- Create docs: `agentbean-next/docs/fifteenth-slice-status.md`

- [ ] **Step 1: Write failing smoke test**

Smoke flow:

```text
register -> daemon hello -> runtime report -> device:get -> agent:create -> agents:subscribe -> channel:create -> message:send -> dispatch:result -> agent reply visible
```

- [ ] **Step 2: Implement only missing preview pieces**

Avoid broad UI work. The preview can be socket/client based as long as it proves local runnability and real message flow.

- [ ] **Step 3: Verify full phase and build**

Run:

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run test:phase1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
git diff --check
```

Expected: all pass.

