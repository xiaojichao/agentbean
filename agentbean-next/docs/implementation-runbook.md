# Implementation Runbook

This is the execution checklist for building the first AgentBean Next slice. It is more concrete than `migration-plan.md` and should be followed in order.

## Ground Rules

- Build new code separately from current `apps/web`, `apps/server`, and `apps/daemon`.
- Do not preserve old Socket.IO event names, old SQLite schemas, or old module shapes.
- Do not implement later-slice features while building the first slice.
- Every step must produce code plus tests or a typed contract.
- If a step needs a product decision, update docs before coding around it.

## Target Workspace

Recommended first implementation layout:

```text
packages/
  contracts/
    src/
      common.ts
      auth.ts
      network.ts
      device.ts
      agent.ts
      channel.ts
      message.ts
      dispatch.ts
      socket.ts
apps/
  server-next/
  daemon-next/
  web-next/
```

If the repository does not yet have a root package/workspace, create one before adding these projects.

## Step 1: Create `packages/contracts`

Inputs:

- `docs/contracts-dto.md`
- `docs/socket-protocol.md`
- `docs/agent-identity-rules.md`

Build:

- Shared DTO types.
- `Ack<T>` and `ErrorCode`.
- Adapter kind, agent category, agent status, dispatch status.
- Socket event names as constants or typed maps.

Tests:

- Type-only or runtime schema tests if a validator is introduced.
- No imports from server, web, or daemon apps.

Done when:

- Contracts build independently.
- Server, web, and daemon can import contracts without circular dependencies.
- No database row types exist in contracts.

## Step 2: Build Domain Pure Functions

Inputs:

- `docs/agent-identity-rules.md`
- `docs/current-behavior.md`
- `docs/acceptance-tests.md`

Build:

- Message routing: mention, human mention, unknown mention, fallback, no-online.
- Agent identity normalization and key generation.
- Agent merge/display/status resolution.
- Channel visibility rules.
- Agent visibility/publication rules.

Tests:

- All Phase 1 tests in `docs/verification-matrix.md`.

Done when:

- Domain tests run without Socket.IO, Express, Next.js, daemon code, or SQLite.
- Web does not need its own agent dedupe algorithm.

## Step 3: Create `apps/server-next`

Inputs:

- `docs/first-slice-schema-repositories.md`
- `docs/contracts-dto.md`
- `docs/socket-protocol.md`

Build:

- App bootstrap.
- SQLite migration runner.
- Global DB connection.
- Network DB/storage manager.
- Repository interfaces and SQLite implementations.
- Use-case layer.
- Thin Socket.IO `/web` and `/agent` adapters.

First use cases:

- `registerUser`
- `loginUser`
- `listNetworks`
- `switchNetwork`
- `deviceHello`
- `reportDeviceRuntimes`
- `registerDiscoveredAgents`
- `listVisibleAgents`
- `createChannel`
- `joinChannel`
- `sendMessage`
- `createDispatch`
- `receiveDispatchResult`
- `receiveDispatchError`

Tests:

- Repository tests with temp SQLite.
- Use-case tests.
- Socket integration tests using test clients.

Done when:

- A test web client can register/login and create/join a channel.
- A test daemon client can register a device, runtimes, and one agent.
- Sending a message creates a persisted dispatch.
- Receiving a daemon result persists an agent message.

## Step 4: Create `apps/daemon-next`

Inputs:

- `docs/contracts-dto.md`
- `docs/socket-protocol.md`
- Existing daemon scanner/adapter behavior as reference.

Build:

- CLI bootstrap.
- Agent protocol client.
- Device hello.
- Runtime report.
- Agent register batch.
- Dispatch request listener.
- Stub executor first.
- Optional one real local adapter after stub path passes.

Tests:

- Protocol client tests.
- Stub dispatch result/error tests.
- Reconnect test.
- Runtime normalization tests.

Done when:

- Daemon-next can connect to server-next.
- Daemon-next reports one runtime and one discovered agent.
- Daemon-next accepts dispatch and returns text.
- Server-next updates dispatch and agent status from daemon activity.

## Step 5: Create `apps/web-next`

Inputs:

- `docs/contracts-dto.md`
- `docs/socket-protocol.md`
- Existing UI information architecture as reference, not as code shape.

Build:

- Session token storage.
- Socket/API client.
- Login/register screen.
- Network shell.
- Device/agent status strip or panel.
- Channel list.
- Conversation view.
- Message composer.

Tests:

- API client tests with fake socket.
- Session store tests.
- Component tests for login, channel list, conversation, and status.
- Optional browser smoke test if tooling is available.

Done when:

- User can log in/register.
- User can see current network.
- User can see connected daemon and discovered agent.
- User can create/join a channel.
- User can send a message and see an agent reply.

## Step 6: Wire End-To-End Smoke

Build:

- One script or test harness that starts server-next and uses test web/daemon clients.
- If full browser testing is available, add a minimal Web smoke after protocol smoke.

Required scenario:

1. Register user.
2. Get current network.
3. Daemon hello.
4. Runtime report.
5. Agent register batch.
6. Create channel.
7. Join channel.
8. Send message.
9. Server creates dispatch.
10. Daemon returns result.
11. Server persists and broadcasts agent reply.

Done when:

- The scenario passes locally.
- It runs in CI or has a documented command ready for CI.

## Step 7: Freeze First Slice

Before implementing deferred features:

- Update docs if code made any contract or schema decision more precise.
- Confirm all Phase 1-4 verification matrix tests pass.
- Confirm no old compatibility adapters were introduced.
- Confirm web does not implement agent dedupe or permission decisions.
- Confirm daemon does not decide network visibility.

## Do Not Implement Yet

Until the first slice is green:

- Tasks.
- Artifacts.
- Workspace runs.
- Device invite flow.
- User join links.
- Admin.
- Search.
- Channel archive/delete.
- Saved messages/reactions.
- Metrics UI.
