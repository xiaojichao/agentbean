# Target Architecture

AgentBean Next keeps the three-process architecture, but replaces the current large-file coordination style with explicit boundaries.

## System Shape

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

This structure can live either as new apps or as a gradual replacement inside the current apps. The important decision is the boundary, not the exact folder names.

## Server Boundary

Server is the collaboration authority. It owns authentication, membership, persistence, routing decisions, device state, agent visibility, task state, and artifact metadata.

### `domain/`

Pure types and rules. No Socket.IO, Express, SQLite, file system, or environment variables.

Suggested modules:

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

Examples of domain rules:

- Which channels a user can see.
- Whether an agent is visible in a network.
- How agent identity and dedupe are resolved across custom, self-register, scanned, runtime, and AgentOS gateway reports. See `docs/agent-identity-rules.md`.
- How a message routes to agents.
- Whether a daemon is allowed to register a device or agent.
- How agent status is derived from heartbeat and device state.

### `application/`

Use cases. Each use case coordinates repositories, domain rules, and outbound ports.

Suggested use cases:

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

Use cases should return typed results and domain errors. Transport handlers should translate those into Socket.IO ack payloads or HTTP responses.

### `infra/`

Implement technical details behind interfaces:

- SQLite repositories.
- Schema migrations.
- Artifact file storage.
- Password hashing.
- Token signing and verification.
- Clock and ID generation.
- Daemon gateway for dispatching to connected sockets.
- Event publisher for web snapshots.

SQLite can stay. The main change is to stop exposing raw database shape to transport code.

### `transport/`

Adapters only:

- `transport/socket/web`
- `transport/socket/agent`
- `transport/http/artifacts`
- `transport/http/health`

Transport may:

- Validate payload shape.
- Read auth context.
- Call one use case.
- Map result to ack or event.

Transport must not:

- Build SQL.
- Mutate registries directly.
- Decide cross-domain behavior.
- Know how artifacts are stored.
- Reimplement agent visibility or dedupe rules.

## Web Boundary

Web is the interaction layer. It should not be the source of business truth.

Suggested feature modules:

- `features/auth`
- `features/networks`
- `features/chat`
- `features/agents`
- `features/devices`
- `features/tasks`
- `features/artifacts`
- `features/members`

Each feature should own:

- UI components.
- Feature hooks.
- Presentation-only state.
- Calls into typed API clients.

Shared client modules:

- `lib/api/socket-client`
- `lib/api/web-events`
- `lib/api/artifact-api`
- `lib/session/auth-token`
- `lib/session/network-selection`

The Zustand store should shrink to:

- Connection state.
- Current session.
- Current network.
- Server snapshots.
- Short-lived UI cache.

It should not contain:

- Agent dedupe algorithms.
- Permission rules.
- Channel visibility rules.
- Protocol-specific fallback behavior.

## Daemon Boundary

Daemon is a device bridge. It should be reliable even when server and web evolve.

Suggested modules:

- `protocol/agent-client`
  - Socket connection, auth, reconnect, event subscription, ack handling.
- `scanner/runtime-scanner`
  - PATH and known runtime discovery.
- `scanner/agentos-scanner`
  - Hermes/OpenClaw gateway discovery.
- `scanner/local-agent-scanner`
  - Local config discovery.
- `execution/executor`
  - Dispatch abstraction used by all adapters.
- `execution/adapters`
  - Codex, Claude Code, Kimi, Hermes, OpenClaw.
- `workspace/workspace-manager`
  - Run directories, artifact detection, metadata.
- `workspace/artifact-uploader`
  - Upload generated files to server.
- `bootstrap/cli`
  - CLI parsing and startup.

Daemon protocol code should not know UI concepts. Execution code should not know Socket.IO.

## Shared Contracts

The rewrite needs a single contract source for:

- Socket event names.
- Ack result shapes.
- DTOs.
- Domain error codes.
- Agent categories and adapter kinds.
- Task statuses.

This can start as a shared TypeScript package:

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

Avoid importing server domain modules directly into web or daemon. Contracts are boundary DTOs, not the entire domain model.

## Persistence Model

Keep two storage scopes:

- Global DB:
  - users
  - networks
  - network members
  - devices
  - agents
  - agent publishes
  - invites
  - join links
  - metrics
- Network DB:
  - channels
  - channel members
  - channel agent members
  - messages
  - DMs
  - tasks
  - artifacts
  - workspace runs

The first rewrite can use SQLite, but migrations must be explicit files rather than ad hoc `ALTER TABLE` logic embedded in a large DB module.

## Implementation Principles

- One use case per user-visible behavior.
- Transport handlers are thin.
- Domain rules are testable without sockets or databases.
- Repositories hide storage details.
- Web receives snapshots and command results; it does not infer server-side truth.
- Daemon reports capabilities and execution results; it does not decide network visibility.
- Every migrated slice gets regression tests before old behavior is deleted.
