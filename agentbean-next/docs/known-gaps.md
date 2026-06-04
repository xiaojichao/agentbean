# Known Gaps

This document records gaps that must be resolved before or during the rewrite. It distinguishes product gaps from implementation gaps so the new system does not accidentally copy old ambiguity.

## Phase 0 Gaps Now Closed By Inventory Docs

The following Phase 0 artifacts now exist:

- Current behavior baseline: `docs/current-behavior.md`
- Current Socket/HTTP protocol inventory: `docs/current-protocol-inventory.md`
- Current data model inventory: `docs/current-data-model-inventory.md`
- Feature disposition matrix: `docs/feature-disposition.md`
- Agent identity and dedupe rule table: `docs/agent-identity-rules.md`
- Acceptance test list: `docs/acceptance-tests.md`

These are still living documents. They should be refined as implementation starts.

## Product Vocabulary Gaps

### Team vs Network

Current docs and code use both `team` and `network`.

Decision needed:

- Pick one primary product term for the UI and domain model.
- If both remain, define their relationship exactly.

Recommended direction:

- Use `team` in product/UI language.
- Use `network` only when referring to infrastructure or isolation if still needed.

### Agent Types

Current categories:

- `executor-hosted`
- `agentos-hosted`

Current sources:

- `self-register`
- `scanned`
- `custom`

Decision needed:

- Confirm whether source and category are both needed.
- Define whether custom agents are always `executor-hosted`.
- Define whether AgentOS gateway agents are devices, agents, runtimes, or connectors.

Initial identity and precedence rules are defined in `docs/agent-identity-rules.md`; the remaining gap is product vocabulary and final category naming, not the merge algorithm itself.

### Assignee Model

Tasks can have an `assignee_id`, but the target type is not fully specified.

Decision needed:

- Can tasks be assigned to humans, agents, or both?
- Should assignees be typed as `{ kind, id }`?

## Protocol Gaps

### Uniform Error Codes

Current errors use mixed strings such as `NOT_AUTHENTICATED`, `UNAUTHORIZED`, `FORBIDDEN`, `DEVICE_NOT_IN_TEAM`, and raw exception messages.

Decision needed:

- Define canonical error codes.
- Map transport errors to domain errors.

### Snapshot Semantics

Current snapshots are sent for agents, devices, networks, channels, and DMs, but consistency guarantees are not specified.

Decision needed:

- Are snapshots full replacements or patches?
- When should clients resubscribe?
- What is the recovery flow after reconnect?

### Acknowledgement Shape

Current ack payloads differ by event.

Decision needed:

- Use one `Ack<T>` result shape across all commands.
- Avoid separate response events where acks are sufficient.

### Admin Protocol

Current implementation has admin events, but no complete admin product spec.

Decision:

- Drop admin protocol from the initial rewrite.
- Reintroduce only with role, permission, and audit requirements.

## Data Model Gaps

### Dispatch Is Not First-Class Enough

Current dispatch lifecycle is mostly coordinated in memory and message metadata.

Needed:

- `dispatches` model with request ID, agent ID, channel ID, message ID, status, error, timestamps, timeout, and artifact links.

### Workspace Runs Are Under-Modeled

Current product expects agent workspace views, but persistence is not cleanly defined.

Needed:

- `workspace_runs` model.
- Links between run, agent, device, dispatch, artifacts, and generated files.

### Threads Are Under-Specified

Thread behavior exists, but the data model should be explicit.

Needed:

- Either `messages.thread_id` and root-message convention, or a separate `threads` table.
- Dispatch history rules for threads.

### Artifact Access Control

Current artifact metadata needs clearer network/channel/message/workspace linkage.

Needed:

- Network-scoped artifact authorization.
- Message and workspace bindings.

### Search Projection

Current message search is direct DB search.

Needed:

- Decide whether simple SQL search is enough for first release.
- Defer full-text indexing unless needed.

## Web Gaps

### State Ownership

Current Zustand store includes domain logic such as agent dedupe.

Needed:

- Move dedupe and permission decisions to server/domain.
- Keep web store focused on session, connection, snapshots, and UI state.

### Large Page Decomposition

Current chat and task pages mix data loading, socket calls, feature state, and rendering.

Needed:

- Split into feature modules and hooks during migration.

### Saved Messages And Reactions

Current UI has saved/reaction local state.

Decision needed:

- Keep as local-only UX, persist server-side, or drop for first release.

## Daemon Gaps

### Runtime Resolution

Current daemon has useful runtime matching rules, but source of truth is spread across daemon, server, and web.

Needed:

- One shared contract for adapter kinds.
- Server-side persisted config.
- Daemon-side execution resolution with typed error reporting.

### Directory Picker

Native directory selection is useful but not core to first slice.

Decision:

- Defer until custom agent setup.

### Reconnect Guarantees

Current reconnect and periodic scan behavior exist, but exact guarantees are not formalized.

Needed:

- Define heartbeat interval.
- Define offline timeout.
- Define scan interval.
- Define server behavior when daemon reconnects with same device ID.

## Testing Gaps

### No True End-To-End Test Yet

Current tests are useful but mostly app-local.

Needed:

- One test or smoke script covering Web-like client, Server, and Daemon-like client together.

### Acceptance Tests Need Prioritization

`docs/acceptance-tests.md` is broad.

Needed:

- Mark first-slice tests versus later-feature tests.

### Contract Tests

Needed:

- Validate protocol DTOs at both web and daemon boundaries.

## Explicit Non-Gaps

These are not gaps because old compatibility is intentionally dropped:

- Old Socket.IO event names.
- Old SQLite schemas.
- Old daemon client compatibility.
- Existing local `.agentbean` data shape.
- Legacy `standalone-cli`.
- Admin events without product spec.
