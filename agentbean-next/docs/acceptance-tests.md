# Acceptance Tests

These tests define the behavior that must survive the semi-rebuild. They are written as product-level scenarios, not as current implementation tests.

## Auth And Network

### Register Creates A Private Network

Given a new user registers with username and password,
when registration succeeds,
then the user receives a session token,
and a private network is created,
and that network becomes the user's current network.

### Login Restores Current Network

Given a user belongs to multiple networks,
and the user previously switched to one network,
when the user logs in again,
then the server returns the saved current network if the user is still a member.

### Invite Join Adds Network Membership

Given an invite code for a network,
when a new user registers through that invite,
then the user is added to the invited network,
and can list that network after login.

## Device And Daemon

### Device Invite Delivers Token To Daemon

Given a daemon is waiting with a device invite code,
when a logged-in user completes device login in the browser,
then the server delivers a device token to the waiting daemon session,
and the daemon reconnects to `/agent` with that token.

### Daemon Registers Runtimes And Agents

Given a daemon connects with a valid device token,
when it sends device hello, runtimes, and discovered agents,
then the server persists the device,
stores runtime metadata,
dedupes agents,
and broadcasts updated device and agent snapshots to web clients.

### Missing Agent Becomes Offline

Given a daemon previously reported an agent,
when a later scan omits that agent,
then the server marks the agent offline instead of deleting its historical identity.

## Agent Identity

### Scanned And Self-Registered Agent Dedupe

Given a daemon reports the same agent through a scan path and a self-register path,
when both reports share device and logical name or runtime identity,
then the UI sees one logical agent, not duplicates.

### AgentOS Gateway Dedupe

Given a Hermes or OpenClaw gateway agent is discovered,
when the gateway also exposes concrete hosted agents,
then generic gateway entries do not override better display entries for the same logical hosted agent.

### Custom Agent Uses Device Runtime

Given a user creates a custom agent on a device,
when the device reports compatible runtimes,
then dispatch uses the best available runtime command,
and reports a clear error if the runtime or working directory is unavailable.

## Channels And Messages

### Public Channel Is Visible To Network Members

Given a public channel exists in a network,
when any network member lists channels,
then the channel is visible.

### Private Channel Is Visible Only To Members

Given a private channel exists with selected human members,
when a non-member lists channels or attempts to join,
then the server denies access.

### Message Send Persists Human Sender

Given a logged-in user sends a channel message,
when the message is persisted,
then `senderKind` is `human`,
and `senderId` is the authenticated user ID,
not a client-provided value.

### Mention Routes To Target Agent

Given a channel has online agents,
when a user sends a message starting with `@AgentName`,
then the server dispatches only to the matching online agent.

### Unknown Mention Does Not Fallback

Given a channel has online agents,
when a user sends a message starting with an unknown `@Name`,
then the server does not dispatch to a fallback agent.

### Human Mention Does Not Dispatch To Agent

Given a channel has human members and agents,
when a user mentions a human member by name,
then the server persists the message,
and does not dispatch to an agent.

### Fallback Dispatch Uses First Online Agent

Given a channel has online agents,
when a message has no mention,
then the server dispatches to the first eligible online agent.

### No Online Agent Is A Non-Fatal State

Given a channel has no online agents,
when a user sends a message,
then the human message is still persisted,
and the server returns a no-online dispatch result rather than failing the send.

### Thread Dispatch Does Not Duplicate Current Prompt

Given a user replies inside a thread,
when the server builds dispatch history,
then previous messages are included as history,
and the current user input appears only as the dispatch prompt.

## Dispatch And Replies

### Dispatch Timeout Is Visible

Given the server dispatches to an agent,
when the daemon does not return before timeout,
then the dispatch is marked failed with `DISPATCH_TIMEOUT`,
and the original human message remains persisted.

### Agent Reply Persists With Artifacts

Given an agent returns text and artifact IDs,
when the server receives the dispatch result,
then it persists an agent message,
binds artifacts to that message,
and broadcasts the message to web clients.

### Agent Error Updates Status

Given a daemon reports execution failure,
when the server receives the error,
then it records the dispatch failure,
updates agent last error,
and notifies web clients.

## Artifacts And Workspace

### Artifact Upload Is Authenticated

Given an artifact upload request,
when the token is missing or invalid,
then the server rejects the upload.

### Artifact Metadata Is Network Scoped

Given a file is uploaded for a channel message,
when another network tries to fetch it,
then access is denied.

### Workspace Run Links Back To Agent

Given a daemon creates files during an agent run,
when it uploads artifacts,
then the server can list those artifacts from the agent workspace view.

## Tasks

### Task Create Persists Network Scope

Given a user creates a task in a network,
when the task is listed,
then it appears only for that network.

### Task Can Link To Channel

Given a task is created from a channel context,
when the channel task list is loaded,
then the task appears in that channel.

### Task Status Update Broadcasts

Given a task exists,
when a user moves it to another status,
then the server persists the new status and broadcasts `task:updated`.

## Web Smoke Tests

### First End-To-End Slice

Given server-next, daemon-next, and web-next are running,
when a user logs in, selects a network, connects a daemon, opens a channel, and sends a message,
then the user sees:

- the connected device
- the discovered agent
- the sent human message
- the persisted agent reply

### Reconnect Keeps UI Consistent

Given a web client loses and restores the socket connection,
when it resubscribes to the current network,
then agents, devices, channels, DMs, tasks, and messages are reloaded from server snapshots.

## Regression Seeds From Current Tests

Existing tests should be reviewed and migrated where they describe product behavior:

- `apps/server/tests/routing.test.ts`
- `apps/server/tests/channels.test.ts`
- `apps/server/tests/agent-namespace.test.ts`
- `apps/server/tests/web-namespace.test.ts`
- `apps/server/tests/artifact-routes.test.ts`
- `apps/server/tests/db.test.ts`
- `apps/daemon/tests/scanner.test.ts`
- `apps/daemon/tests/device-daemon.test.ts`
- `apps/daemon/tests/workspace-manager.test.ts`
- `apps/web/tests/socket.test.ts`
- `apps/web/tests/store-agent-dedupe.test.ts`
- `apps/web/tests/task-status.test.ts`
- `apps/web/tests/chat-scope.test.ts`
