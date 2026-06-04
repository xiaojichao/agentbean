# Agent Identity And Dedupe Rules

Agent identity is a high-risk part of the rewrite. The target implementation must define identity once in the domain/contracts layer and reuse it from server, web, and daemon-facing code.

The current implementation has useful lessons, but the rewrite should not preserve duplicated client/server dedupe logic. Server domain code should decide identity and visibility. Web should render server snapshots.

## Terms

- **Device**: a registered daemon endpoint. A device may have `deviceId`, `machineId`, and `profileId`.
- **Runtime**: an executable capability on a device, such as Codex, Claude Code, or Kimi CLI.
- **Discovered agent**: an agent-like entry reported by scanner or AgentOS gateway.
- **Custom agent**: user-created agent config bound to a device, runtime, command, cwd, args, and env.
- **AgentOS gateway**: a connector such as Hermes or OpenClaw that may expose one or more hosted agents.
- **Logical agent**: the canonical domain identity used for persistence, channel membership, dispatch, publication, and UI display.
- **Visible agent**: a projection of a logical agent into a network where it is visible.

## Normalization

All identity comparisons must normalize inputs before key generation.

| Field | Normalization |
|---|---|
| `networkId` | Exact canonical ID after network lookup. Do not compare by network name/path. |
| `deviceId` | Canonical registered device ID. If `machineId + profileId` maps to an existing device, reconcile device identity before agent dedupe. |
| `adapterKind` | Lowercase, replace `_` and spaces with `-`; aliases: `claude` -> `claude-code`, `codex-cli` -> `codex`, `kimi` -> `kimi-cli`. |
| `name` | Trim, lowercase, collapse spaces/underscores to `-`, strip duplicate separators for identity. Preserve display casing separately if needed. |
| `command` | Trim and normalize slashes for comparison. Apply platform/filesystem case rules when known; do not blindly lowercase on case-sensitive filesystems. Preserve display value separately and store a normalized comparison key. |
| `cwd` | Trim, normalize slashes, remove trailing slash, and apply platform/filesystem case rules when known. Preserve display value separately and store a normalized comparison key. |
| `args` | Convert to string array, trim empty args, join with an unambiguous separator for comparison. |
| `gatewayId` / `gatewayName` | Prefer stable gateway instance ID from the gateway. Fallback to normalized gateway name, then normalized endpoint/command if no explicit ID exists. |
| `source` | One of `custom`, `self-register`, `scanned`. |
| `category` | One of `executor-hosted`, `agentos-hosted`. |

Path comparison rules:

- Linux and other known case-sensitive filesystems should preserve case in comparison keys.
- Windows should compare paths case-insensitively.
- macOS should use detected filesystem behavior when possible; default to case-insensitive only for local paths known to live on the default case-insensitive volume.
- If platform/filesystem behavior is unknown, prefer case-sensitive comparison to avoid accidental merges.
- Store both original display paths and normalized comparison keys.

## Identity Key Rules

Use the first applicable row. `primaryNetworkId` means the network where the agent is owned. Published networks are visibility projections, not new identities.

| Agent Input | Same Logical Agent If | Do Not Merge If | Canonical ID Strategy |
|---|---|---|---|
| Existing persisted custom agent | Same persisted `agentId`. | Different `agentId`, even if name/runtime matches. Custom agents are user-created configs. | Server-issued `agentId`. |
| New custom agent create request | Never auto-merge by name alone. Optionally reject duplicate name per device/network as validation, but do not silently merge. | Existing custom agent with different ID. | New server-issued `agentId`. |
| Custom agent runtime availability | Match runtime by compatible adapter/command on same `deviceId`; this links availability, not identity. | Runtime belongs to different device or incompatible adapter. | Keep custom `agentId`; store runtime match separately. |
| Self-registered agent with stable server-known ID | Same `agentId`. | Same name but different device/network and no reconciled device identity. | Reuse `agentId`. |
| Self-registered agent without trusted ID | Same `primaryNetworkId + deviceId + adapterKind + normalizedName`. | Different device, different primary network, different adapter kind. | Server may assign canonical ID and remember source linkage. |
| Scanned AgentOS hosted concrete agent | Same `primaryNetworkId + deviceId + adapterKind + normalizedName`, when name is not a generic gateway name. | Different device, network, adapter, or concrete name. | Stable derived ID or existing canonical ID. |
| Scanned AgentOS generic gateway entry | Same `primaryNetworkId + deviceId + adapterKind + gatewayInstanceKey`. | Concrete hosted agent with distinct non-generic name should not be collapsed into generic display identity. Different gateway instances on the same device must not merge. | Stable gateway ID; may be hidden behind concrete agents in UI. |
| Scanned executor runtime | Same `primaryNetworkId + deviceId + adapterKind + runtimeLocation + args`. | Treating it as a product agent. It is a capability unless user creates/binds a custom agent. | Runtime ID or runtime record, not agent ID. |
| Published agent visible in another network | Same source `agentId`; visible through publication into `visibleNetworkId`. | Creating a second agent row for the target network. | Keep original `agentId`, add publication record. |
| Same name on different devices | Not the same logical agent. | Device reconciliation proves both device IDs are the same physical/profile identity. | Separate IDs unless device reconciliation merges first. |
| Same device/name across different primary networks | Not the same logical agent. | It is the same original agent published into another network. | Separate IDs by primary network; publication preserves original ID. |

## Source Precedence

When multiple records resolve to the same logical agent, keep one canonical identity and merge fields using this precedence.

### Display And Configuration Precedence

Higher rows win for display/config fields unless a field is empty.

| Rank | Source | Fields It May Own |
|---|---|---|
| 1 | User-edited custom agent config | `name`, `description`, `command`, `args`, `cwd`, `env`, `ownerId`, publication intent. |
| 2 | Self-registered agent | `name`, `role`, `adapterKind`, `category`, live socket identity, richer non-scan display info. |
| 3 | Concrete AgentOS hosted scan | `name`, `adapterKind`, `category`, gateway-backed execution metadata. |
| 4 | Generic AgentOS gateway scan | Connector availability and gateway status. Should not replace concrete hosted agent display. |
| 5 | Runtime scan | Runtime availability only. Should not create or overwrite product agent display. |

Rules:

- A scan must not overwrite a user-edited custom agent name, description, env, cwd, command, or args.
- A generic gateway entry such as `hermes-agent` or `openclaw-agent` must not overwrite a concrete hosted agent name.
- A self-register event may update live status and socket binding for an existing scanned AgentOS identity if it has the same logical key.
- A scan may refresh `lastSeenAt`, runtime command availability, and category/source evidence.
- A missing scan marks scanned/gateway availability offline; it must not delete custom agent config or publication records.

### Status Precedence

Status is merged independently from display/config. A lower display-rank record can still provide the freshest status.

Status merge order:

1. Partition status events by status source, such as daemon connection, gateway scan, dispatch lifecycle, heartbeat timeout, or manual/config event.
2. For each source, keep only the latest event by monotonic sequence if available, otherwise by `lastSeenAt`/event timestamp.
3. Merge the latest per-source events by timestamp. Newer events win over older events, even if the older event has a higher status rank.
4. Use status priority only to break same-timestamp or same-batch conflicts.

| Rank | Status |
|---|---|
| 1 | `busy` |
| 2 | `online` |
| 3 | `connecting` |
| 4 | `error` |
| 5 | `offline` |

Tie breakers:

1. Prefer the event with the highest status rank only when events are from the same timestamp/batch after per-source compaction.
2. Preserve `lastError` only from the status source that produced `error`, or from the most recent failed dispatch.
3. Do not let any older event override a newer event. For example, an old `busy` must not override a newer `offline`, `online`, or `error`.
4. A heartbeat timeout may produce `offline`, but it must carry a timestamp/sequence newer than the last successful heartbeat to take effect.

## Conflict Resolution Table

| Conflict | Resolution |
|---|---|
| Scan reports `scan-{device}-{name}` but self-register already exists for same device/name/network. | Keep self-register canonical ID; delete or alias stale scan ID; update scan metadata onto canonical record only where allowed. |
| AgentOS gateway reports generic `hermes-agent`, then concrete `Reviewer`. | Keep both identities internally if needed, but visible list should prefer concrete hosted agent. Generic gateway can be connector/device capability. |
| Same device and adapter report two gateway instances. | Do not merge unless `gatewayInstanceKey` matches. Use gateway ID first, then gateway name, then endpoint/command-derived key. |
| Custom agent has same name as scanned AgentOS agent on same device. | Do not auto-merge. Custom agent is a user config. Validation may ask user to rename if confusing. |
| Custom agent command points to a scanned runtime. | Link custom agent to runtime availability; do not merge identities. |
| Same agent name appears on two devices. | Separate logical agents. |
| Same device appears with new `deviceId` but same `machineId + profileId`. | Reconcile device first; then dedupe agents under canonical device ID. |
| Same agent is published to another network. | Same `agentId`; add visible projection/publication. Do not clone. |
| Scan omits a previously scanned agent. | Mark scanned/gateway identity offline. Do not remove channel membership, history, or publications until explicit cleanup. |
| User edits custom agent config while daemon scan is stale. | User edit wins for config; runtime availability updates when daemon reconnects/scans. |
| Adapter aliases differ (`codex-cli` vs `codex`). | Normalize and compare canonical adapter kind. |
| Adapter kinds are genuinely different but names match. | Do not merge unless a specific adapter bridge rule exists and is tested. |

## Field Ownership

| Field | Owner |
|---|---|
| `id` | Server identity service. |
| `primaryNetworkId` | Creation/persistence use case. |
| `publishedNetworkIds` | Agent publication use cases. |
| `ownerId` | Creation/ownership use cases. |
| `name` | User config or highest display precedence source. |
| `description` | User config. |
| `adapterKind` | User config for custom; daemon/gateway report for discovered hosted agents. |
| `category` | Domain classification from source report, normalized by server. |
| `source` | Server-derived from creation/report path. |
| `deviceId` | Device registration and agent report. |
| `command`, `args`, `cwd`, `env` | User config for custom; scan report for discovered/gateway metadata. |
| `status`, `lastSeenAt`, `lastError` | Live registry/dispatch/heartbeat events. |
| `channelMembership` | Channel use cases. |
| `runtimeAvailability` | Daemon runtime reports. |

## Target Domain API

The rewrite should implement identity as pure functions plus a small service:

```ts
type AgentIdentityKey =
  | { kind: "custom"; agentId: string }
  | { kind: "self-register"; networkId: string; deviceId: string; adapterKind: string; name: string }
  | { kind: "agentos-concrete"; networkId: string; deviceId: string; adapterKind: string; name: string }
  | { kind: "agentos-gateway"; networkId: string; deviceId: string; adapterKind: string; gatewayInstanceKey: string }
  | { kind: "runtime"; networkId: string; deviceId: string; adapterKind: string; location: string; argsKey: string };

function normalizeAgentIdentityInput(input: AgentIdentityInput): NormalizedAgentIdentityInput;
function identityKeysFor(input: NormalizedAgentIdentityInput): AgentIdentityKey[];
function resolveAgentMerge(existing: AgentRecord[], incoming: AgentReport): AgentMergeDecision;
function mergeAgentRecords(display: AgentRecord, status: AgentRecord): AgentProjection;
```

`runtime` keys should be used for runtime availability and custom-agent binding, not for creating visible product agents.

## Required Tests

The first contracts/domain package should include tests for:

- Self-register beats scan-prefix duplicate for same `networkId + deviceId + name`.
- Concrete AgentOS hosted agent beats generic gateway display.
- Multiple same-adapter AgentOS gateway instances on one device do not merge unless `gatewayInstanceKey` matches.
- Generic gateway status can still show connector availability without replacing concrete agent display.
- Custom agent does not merge with scanned runtime.
- Linux path comparison preserves case; Windows path comparison is case-insensitive; unknown filesystem behavior defaults to case-sensitive.
- Custom agent config is not overwritten by daemon scan.
- Newer `offline` or `online` status beats older `busy`; status rank only breaks same-batch conflicts.
- Runtime availability links to custom agent on same device and compatible adapter.
- Same name on two devices creates two logical agents.
- Same device reconnected under same `machineId + profileId` reconciles before dedupe.
- Published agent keeps same ID across visible networks.
- Missing scan marks scanned agent offline without deleting memberships/history.
- Adapter aliases normalize.
- Different adapter kinds with same name do not merge.

## Implementation Placement

- Put these rules in server/domain or shared contracts/domain.
- Web must not implement its own agent dedupe beyond stable list rendering.
- Daemon may normalize adapter/runtime reports, but server remains the authority for identity.
- Persist canonical identity decisions so reconnects do not depend on in-memory ordering.
