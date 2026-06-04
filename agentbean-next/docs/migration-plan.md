# Migration Plan

The migration should proceed by vertical slices. Each slice must include server behavior, protocol contracts, minimal web integration, daemon behavior when relevant, and tests.

For task-by-task execution, follow `docs/implementation-runbook.md`.
For first-slice persistence and repositories, follow `docs/first-slice-schema-repositories.md`.
For phase-gated tests, follow `docs/verification-matrix.md`.

## Phase 0: Freeze Existing Behavior

Goal: make the current product understandable enough to replace.

Outputs:

- Current behavior spec: `docs/current-behavior.md`.
- Current Socket/HTTP protocol inventory: `docs/current-protocol-inventory.md`.
- Current data model inventory: `docs/current-data-model-inventory.md`.
- Existing feature disposition matrix: `docs/feature-disposition.md`.
- Acceptance test list: `docs/acceptance-tests.md`.
- Verification matrix: `docs/verification-matrix.md`.
- Known gaps and intentionally dropped implementation assumptions: `docs/known-gaps.md`.

Do not write replacement app code until this phase is done.

Definition of done:

- Product flows are described without relying on current file names.
- Current event surfaces are mapped to keep, defer, merge, or drop decisions.
- Current persistence concepts are mapped to fresh-schema decisions.
- The first implementation slice is agreed.
- Tests that protect the first slice are identified.

## Phase 1: Contracts And Domain Core

Goal: create the shared language of the rewrite.

Build:

- `packages/contracts` or equivalent shared contract module.
- First-slice DTOs from `docs/contracts-dto.md`.
- Domain types for user, network, agent, device, channel, message, task, artifact, and dispatch.
- Domain services for:
  - message routing
  - channel visibility
  - agent visibility
  - agent identity and dedupe, following `docs/agent-identity-rules.md`
  - task status transitions

Tests:

- Mention routing.
- Human mention behavior.
- No-online routing behavior.
- Private channel visibility.
- Agent publish visibility.
- Agent identity and dedupe cases listed in `docs/agent-identity-rules.md`.

Definition of done:

- Domain tests run without Socket.IO, Express, Next.js, or SQLite.
- Web and daemon cannot import server implementation modules.

## Phase 2: Server Core Slice

Goal: build the smallest server that can authenticate, manage a network, register a daemon, create a channel, persist messages, and dispatch to an agent.

Build:

- App bootstrap.
- SQLite migration runner.
- Global and network-scoped repositories from `docs/first-slice-schema-repositories.md`.
- Use cases:
  - `registerUser`
  - `loginUser`
  - `listNetworks`
  - `registerDevice`
  - `registerDiscoveredAgents`
  - `createChannel`
  - `joinChannel`
  - `sendMessage`
  - `dispatchMessageToAgent`
  - `receiveAgentReply`
- Thin `/web` and `/agent` Socket.IO adapters.
- Artifact HTTP upload/download can be stubbed in this phase if dispatch can return text.

Tests:

- Use-case tests with in-memory or temp SQLite.
- Socket integration test for login to message send.
- Agent namespace test for daemon registration and dispatch result.

Definition of done:

- A daemon test client can register one agent.
- A web test client can send a message.
- The server persists human and agent messages.
- Dispatch timeout produces a stable error code.

## Phase 3: Daemon Protocol And Execution

Goal: migrate daemon behavior behind a new protocol client and execution interface.

Build:

- Agent protocol client.
- Device hello.
- Runtime scan report.
- Agent register batch.
- Dispatch request handling.
- Execution abstraction.
- Adapter migration for one local runtime first, preferably `codex` or a stub executor.
- Workspace run creation.
- Artifact collection and upload interface.

Tests:

- Runtime scanner tests from existing daemon suite.
- Adapter stub dispatch test.
- Reconnect and rescan behavior.
- Dispatch result and dispatch error reporting.

Definition of done:

- Daemon can connect to server-next.
- Daemon can report runtimes and agents.
- Daemon can execute a stub/local adapter and return a message.
- Server can update device and agent status from daemon activity.

## Phase 4: Web Minimal Slice

Goal: replace the UI path for the first end-to-end workflow without porting all current pages.

Build:

- Session management.
- Login/register pages.
- Network shell.
- Channel list.
- Conversation view.
- Agent/device status summary.
- Typed API clients for the new protocol.

Tests:

- API client tests.
- Store/session tests.
- Component tests for message rendering and agent status.
- One browser-level smoke test if tooling is available.

Definition of done:

- User can log in.
- User can see the current network.
- User can see connected daemon/agent status.
- User can create or join a channel.
- User can send a message and see an agent reply.

## Phase 5: Feature Migration

Migrate features in this order:

1. Device invite flow.
2. Agent publishing and custom agent creation.
3. Private channels and members.
4. DMs and thread behavior.
5. Artifacts and workspace runs.
6. Tasks.
7. Agent metrics and activity.
8. Search, saved messages, reminders, and other UX enhancements.

Each feature should follow the same loop:

1. Extract current behavior from old code and docs.
2. Add or update contract types.
3. Add use case tests.
4. Implement server use case.
5. Implement transport adapter.
6. Implement web/daemon integration.
7. Run regression tests.
8. Delete old assumptions instead of preserving compatibility shims.

## Phase 6: Cutover

Goal: make the new implementation the default.

Requirements:

- Fresh data/bootstrap plan for the new implementation.
- Backup/restore procedure for future production use.
- Deployment updates for Web, Server, and Daemon.
- Release notes only if any external users exist by then.

Definition of done:

- CI validates all apps from a single root command.
- Existing behavior acceptance tests pass.
- Manual smoke test covers Web, Server, and Daemon together.
- Rollback instructions exist.

## Compatibility Policy

The old implementation has not shipped, so compatibility with old code, old SQLite files, old Socket.IO events, and old daemon clients is not required.

Preserve:

- Product intent captured in docs and accepted behavior.
- Useful domain rules discovered in the old implementation.
- Tests that describe desired behavior rather than old file shapes.
- CLI/package names only if they remain the best product surface, not because the old implementation used them.

Do not preserve:

- Old Socket.IO event names or payload shapes.
- Existing SQLite schemas or migration compatibility.
- Internal row shapes and IDs.
- Current module boundaries.
- UI-local workarounds.
- Transitional aliases.
- Legacy `standalone-cli` category.
- Test stubs that do not represent product behavior.
- Backward compatibility for old daemon clients.

If a behavior exists only because the current implementation needed a workaround, rewrite it as a clean requirement or drop it.

## Suggested Work Items

Initial work queue:

1. Create `packages/contracts`.
2. Move message routing into a pure domain module.
3. Define agent identity and dedupe rules as pure functions.
4. Add temp-SQLite repository interfaces for users, networks, devices, agents, channels, and messages.
5. Implement `/web` login and network list.
6. Implement `/agent` device hello and agent register batch.
7. Implement message send and stub dispatch.
8. Add a tiny web shell for the first workflow.
