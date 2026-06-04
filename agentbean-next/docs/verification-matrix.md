# Verification Matrix

This matrix turns the acceptance tests into phase-gated verification. A phase is not complete until its required tests pass.

Test levels:

- `Domain`: pure functions, no DB or sockets.
- `Repository`: temp SQLite, no Socket.IO.
- `UseCase`: application service with fake ports/repositories or temp SQLite.
- `Socket`: server with Socket.IO test clients.
- `Daemon`: daemon protocol/executor tests.
- `Web`: component/client tests.
- `E2E`: server plus test web/daemon clients, optional browser UI.

## Phase 1: Contracts And Domain Core

| ID | Required Test | Level | Verifies | Source Docs |
|---|---|---|---|---|
| P1-01 | `Ack<T>` success/failure shapes compile and reject invalid error codes. | Domain | Shared result contract. | `contracts-dto.md`, `socket-protocol.md` |
| P1-02 | `UserDto`, `NetworkDto`, `DeviceDto`, `AgentDto`, `ChannelDto`, `MessageDto`, `DispatchDto` type fixtures compile. | Domain | First-slice DTO contract. | `contracts-dto.md` |
| P1-03 | Mention routes to matching online agent. | Domain | Direct mention routing. | `acceptance-tests.md`, `current-behavior.md` |
| P1-04 | Unknown mention does not fallback. | Domain | No accidental dispatch. | `acceptance-tests.md`, `current-behavior.md` |
| P1-05 | Human mention does not dispatch to agent. | Domain | Human mention behavior. | `acceptance-tests.md`, `current-behavior.md` |
| P1-06 | No mention falls back to first eligible online agent. | Domain | Fallback routing. | `acceptance-tests.md`, `current-behavior.md` |
| P1-07 | No online agent produces non-fatal route result. | Domain | Message send can persist without dispatch. | `acceptance-tests.md`, `current-behavior.md` |
| P1-08 | Agent identity normalizes adapter aliases. | Domain | Adapter canonicalization. | `agent-identity-rules.md` |
| P1-09 | Linux path comparison preserves case; Windows comparison is case-insensitive; unknown defaults case-sensitive. | Domain | Path identity safety. | `agent-identity-rules.md` |
| P1-10 | Self-register beats scan-prefix duplicate for same network/device/name. | Domain | Canonical ID merge. | `agent-identity-rules.md` |
| P1-11 | Custom agent does not merge with scanned runtime. | Domain | Custom config identity. | `agent-identity-rules.md` |
| P1-12 | Concrete AgentOS hosted agent beats generic gateway display. | Domain | Display precedence. | `agent-identity-rules.md` |
| P1-13 | Same-adapter gateway instances do not merge unless `gatewayInstanceKey` matches. | Domain | Gateway instance identity. | `agent-identity-rules.md` |
| P1-14 | Newer status event beats older `busy`; status rank only breaks same-batch conflict. | Domain | Status merge ordering. | `agent-identity-rules.md` |
| P1-15 | Published agent keeps one identity across visible networks. | Domain | Publication projection, no clone. | `agent-identity-rules.md`, `feature-disposition.md` |
| P1-16 | Private channel visibility allows members and denies non-members. | Domain | Server-side visibility rule. | `acceptance-tests.md`, `target-architecture.md` |

Phase 1 done when:

- All tests above pass without SQLite, Socket.IO, web, or daemon imports.
- Domain code imports contracts only.

## Phase 2: Server Core Slice

| ID | Required Test | Level | Verifies | Source Docs |
|---|---|---|---|---|
| P2-01 | Global migrations create first-slice tables and indexes. | Repository | Fresh schema exists. | `first-slice-schema-repositories.md` |
| P2-02 | Network migrations create channel/message/dispatch tables and indexes. | Repository | Network schema exists. | `first-slice-schema-repositories.md` |
| P2-03 | Register user creates private network, owner membership, default `all` channel, and current network. | UseCase | Registration transaction. | `acceptance-tests.md`, `first-slice-schema-repositories.md` |
| P2-04 | Login restores saved current network if membership is valid. | UseCase | Current network behavior. | `acceptance-tests.md` |
| P2-05 | Device hello upserts device and reconciles `machineId + profileId`. | UseCase | Device identity before agent dedupe. | `agent-identity-rules.md`, `first-slice-schema-repositories.md` |
| P2-06 | Runtime report replaces runtimes for device and preserves normalized path keys. | Repository/UseCase | Runtime capability model. | `contracts-dto.md`, `agent-identity-rules.md` |
| P2-07 | Agent register batch creates/links canonical agents using identity links. | UseCase | Agent dedupe persisted. | `agent-identity-rules.md`, `first-slice-schema-repositories.md` |
| P2-08 | Missing scanned agent becomes offline without deleting membership/history. | UseCase | Missing scan behavior. | `acceptance-tests.md`, `agent-identity-rules.md` |
| P2-09 | `listVisibleAgents` returns primary-network and published agents without clones. | UseCase | Visibility projection. | `agent-identity-rules.md`, `feature-disposition.md` |
| P2-10 | Public channel list is visible to network member. | UseCase | Channel visibility. | `acceptance-tests.md` |
| P2-11 | `sendMessage` persists server-derived human sender and ignores client sender input. | UseCase | Sender identity. | `acceptance-tests.md`, `contracts-dto.md` |
| P2-12 | `sendMessage` with online agent creates dispatch record. | UseCase | Dispatch first-class persistence. | `first-slice-schema-repositories.md`, `contracts-dto.md` |
| P2-13 | `sendMessage` with no online agent persists message and returns no-online dispatch result. | UseCase | Non-fatal no-dispatch path. | `acceptance-tests.md` |
| P2-14 | Dispatch timeout marks dispatch `timed_out` with `DISPATCH_TIMEOUT`. | UseCase | Stable timeout error. | `acceptance-tests.md`, `contracts-dto.md` |
| P2-15 | Dispatch result marks dispatch succeeded and appends agent message. | UseCase | Reply persistence. | `acceptance-tests.md` |
| P2-16 | Dispatch error marks dispatch failed and updates agent last error. | UseCase | Error propagation. | `acceptance-tests.md` |
| P2-17 | `/web` login/network/channel/message socket flow uses only documented first-slice events. | Socket | Transport adapter thinness. | `socket-protocol.md`, `contracts-dto.md` |
| P2-18 | `/agent` device hello/runtime/agent batch/dispatch result flow uses documented DTOs. | Socket | Agent namespace contract. | `socket-protocol.md`, `contracts-dto.md` |

Phase 2 done when:

- Server tests run against temp SQLite.
- Socket handlers call use cases and do not contain SQL or domain merge logic.
- No old event compatibility adapter exists.

## Phase 3: Daemon Protocol And Execution

| ID | Required Test | Level | Verifies | Source Docs |
|---|---|---|---|---|
| P3-01 | Daemon protocol client sends `device:hello` and handles `Ack`. | Daemon | Device handshake. | `socket-protocol.md`, `contracts-dto.md` |
| P3-02 | Runtime scanner emits `RuntimeDto` with display command and normalized keys. | Daemon | Runtime contract and path rules. | `contracts-dto.md`, `agent-identity-rules.md` |
| P3-03 | Agent discovery emits `DiscoveredAgentDto` including gateway instance fields when available. | Daemon | Gateway identity input. | `contracts-dto.md`, `agent-identity-rules.md` |
| P3-04 | Daemon receives `DispatchRequestDto` and does not duplicate current prompt in history. | Daemon | Dispatch request contract. | `contracts-dto.md`, `acceptance-tests.md` |
| P3-05 | Stub executor returns successful dispatch result. | Daemon | Execution success path. | `implementation-runbook.md`, `socket-protocol.md` |
| P3-06 | Stub executor returns dispatch error. | Daemon | Execution failure path. | `socket-protocol.md`, `contracts-dto.md` |
| P3-07 | Raw `customAgent.env` is only consumed for selected daemon dispatch and not logged. | Daemon | First-slice env safety. | `contracts-dto.md` |
| P3-08 | Reconnect resends device hello, runtimes, and agent batch. | Daemon | Reconnect consistency. | `known-gaps.md`, `acceptance-tests.md` |

Phase 3 done when:

- Daemon-next can pass protocol tests against a fake or real server-next.
- Stub executor proves dispatch before real adapters are migrated.

## Phase 4: Web Minimal Slice

| ID | Required Test | Level | Verifies | Source Docs |
|---|---|---|---|---|
| P4-01 | Web API client uses first-slice event names and `Ack<T>` handling. | Web | Client contract. | `socket-protocol.md`, `contracts-dto.md` |
| P4-02 | Session store persists token and current network only. | Web | Web state ownership. | `target-architecture.md` |
| P4-03 | Login/register screen handles success and failure ack shapes. | Web | Auth contract. | `contracts-dto.md` |
| P4-04 | Network shell renders current network from `NetworkDto`. | Web | Network projection. | `contracts-dto.md` |
| P4-05 | Device/agent status UI renders server snapshots without local dedupe. | Web | Server-owned identity. | `agent-identity-rules.md`, `target-architecture.md` |
| P4-06 | Channel list renders `ChannelDto` and selected channel history. | Web | Channel/message DTOs. | `contracts-dto.md` |
| P4-07 | Message composer sends body/clientMessageId only; sender identity is not client-provided. | Web | Sender trust boundary. | `contracts-dto.md`, `acceptance-tests.md` |
| P4-08 | Conversation appends `channel:message` and dispatch status updates. | Web | Realtime projection. | `socket-protocol.md` |
| P4-09 | Reconnect resubscribes and replaces snapshots rather than patching stale state. | Web | Snapshot recovery. | `known-gaps.md`, `acceptance-tests.md` |

Phase 4 done when:

- Web-next can drive the first-slice workflow against server-next and daemon-next.
- No web feature implements permission, channel visibility, or agent dedupe decisions.

## First End-To-End Gate

| ID | Required Test | Level | Verifies | Source Docs |
|---|---|---|---|---|
| E2E-01 | Register -> daemon hello -> runtime report -> agent batch -> channel create/join -> message send -> dispatch result -> agent reply visible. | E2E | Complete first slice. | `implementation-runbook.md`, `acceptance-tests.md` |
| E2E-02 | Same flow with no online agent persists human message and returns no-online dispatch result. | E2E | Non-fatal no-agent behavior. | `acceptance-tests.md` |
| E2E-03 | Daemon disconnect/reconnect refreshes device and agent snapshots. | E2E | Reconnect behavior. | `acceptance-tests.md`, `known-gaps.md` |

First slice is frozen only after all E2E gates pass.

## Deferred Acceptance Tests

These remain in `docs/acceptance-tests.md` but are not required before the first slice is frozen:

- Device invite token delivery.
- User invite/join links.
- Artifact upload/download and workspace run linkage.
- Tasks.
- Message search.
- Channel archive/delete.
- Admin.
- Metrics.
- Saved messages and reactions.
