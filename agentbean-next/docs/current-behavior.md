# Current Behavior Baseline

This is a compact baseline extracted from the current repository docs and implementation. It should be refined before implementation begins, but it is enough to guide the first rewrite slice.

## Product Model

AgentBean is a local-first collaboration product where humans and agents work inside a team or network.

Core objects:

- User
- Network or team
- Network membership
- Device
- Agent
- Runtime
- Channel
- DM
- Thread
- Message
- Task
- Artifact
- Workspace run
- Invite or join link

## Process Model

AgentBean runs as three cooperating processes:

- Web: Next.js UI for humans.
- Server: Express and Socket.IO collaboration hub.
- Daemon: local device bridge that discovers runtimes and executes agents.

Current communication:

- Web connects to Server `/web`.
- Daemon connects to Server `/agent`.
- Web uploads artifacts through HTTP routes.
- Daemon uploads or reports generated artifacts after execution.

## Identity And Membership

- Users register with username and password.
- Registration creates or joins a network.
- Login returns a user token and current network.
- A user can belong to multiple networks.
- The server persists the user's current network.
- Private channels are visible only to selected members.
- Public channels are visible to all members in the network.

## Agent Model

Agent categories:

- `executor-hosted`: local runtimes such as Codex, Claude Code, Kimi CLI.
- `agentos-hosted`: gateway-backed agents such as Hermes and OpenClaw.

Agent sources:

- `self-register`
- `scanned`
- `custom`

Important behavior:

- Agents belong to a primary network.
- Agents can be published to additional networks.
- Agent online status depends on daemon/device state and heartbeat.
- Custom agent online status depends on device online state, runtime availability, and project directory availability.
- Agent identity must dedupe scan registrations, self-registrations, and custom-agent representations.

## Device And Daemon Behavior

Daemon startup behavior:

1. Read local profile/device config.
2. Connect to Server.
3. Report device metadata.
4. Scan local runtimes.
5. Scan AgentOS gateways.
6. Scan local agent configs.
7. Register discovered agents.
8. Periodically rescan.
9. Receive dispatch requests and execute them.

Device invite behavior:

1. Web creates a device invite.
2. User runs a daemon command with the invite.
3. Daemon waits for token delivery.
4. Browser device-login authenticates the user.
5. Server delivers token to the waiting daemon.
6. Daemon reconnects to `/agent` with the token.

## Message Behavior

- Channel messages are persisted.
- Human messages derive sender identity from the authenticated socket.
- `@AgentName` at the start of a message targets a matching online agent.
- `@HumanName` should not dispatch to agents.
- Unknown mentions should not fallback to another agent.
- Messages with no mention fallback to a first eligible online agent.
- If no agent is online, the human message still persists.
- Thread dispatch must not include the current prompt twice.

## Dispatch Behavior

Server dispatch responsibilities:

- Determine target agent.
- Build prompt, history, attachments, network/team context.
- Send request to the right connected daemon or AgentOS socket.
- Track timeout.
- Persist reply or error.
- Broadcast message and dispatch status to web clients.

Daemon dispatch responsibilities:

- Resolve runtime command.
- Validate working directory where relevant.
- Execute adapter.
- Collect generated artifacts.
- Upload or report artifacts.
- Return text, artifact IDs, and errors.

## Artifact Behavior

- Artifacts are uploaded to server storage.
- Artifact metadata is persisted with network/channel/message context.
- Agent replies can include generated artifacts.
- Web can preview images and download files.
- Agent workspace views should show generated files from runs.

## Task Behavior

Current status:

- UI has a task board/list experience.
- Server has task persistence and socket APIs in the current branch.
- Tasks belong to a network and can link to channels/messages.

Required behavior:

- Create, list, update, delete tasks.
- Change task status.
- Persist task ordering.
- Broadcast task updates.

## Current Technical Shape

Useful technology choices:

- TypeScript across apps.
- Socket.IO for realtime protocol.
- SQLite for local-first persistence.
- Vitest for focused tests.
- Next.js App Router for Web.

Problematic implementation shape:

- Server core is too concentrated in `apps/server/src/index.ts`.
- DB schema and repository behavior are too concentrated in `apps/server/src/db.ts`.
- Agent namespace behavior mixes transport, persistence, registry, and dispatch coordination.
- Web socket client is too broad.
- Web store contains domain rules that should move to server/domain contracts.
- Several large pages mix data loading, UI state, and feature logic.

## First Slice Baseline

The first rewrite slice should prove:

1. User can log in or register.
2. User has a current network.
3. Daemon can connect and report a device.
4. Daemon can report one runtime and one agent.
5. Web can see the device and agent.
6. User can create or join a channel.
7. User can send a message.
8. Server dispatches to the agent.
9. Daemon returns a reply.
10. Server persists and broadcasts the reply.
