# Feature Disposition Matrix

This matrix maps the current feature surface to the rewrite plan.

Status values:

- `First Slice`: required for the first end-to-end rewrite slice.
- `Keep`: product behavior should remain, but not necessarily in the first slice.
- `Defer`: useful behavior, implement after core flows are stable.
- `Merge/Rename`: keep behavior but replace current event/API shape.
- `Drop`: do not carry into the rewrite unless a new product requirement asks for it.

## Auth And Accounts

| Current Surface | Status | Target Direction |
|---|---|---|
| Register user and create private network | First Slice | `auth:register` use case and typed contract. |
| Login and restore current network | First Slice | `auth:login` use case. |
| `auth:whoami` | First Slice | Keep. |
| `auth:change-password` | Defer | Keep under account settings. Not needed for first slice. |
| User invite registration | Keep | Keep as user invite flow. |
| Device invite login/token delivery | Keep | Keep as device onboarding flow after first daemon slice. |

## Networks And Members

| Current Surface | Status | Target Direction |
|---|---|---|
| Network list/create/switch | First Slice | Keep. |
| Network rename/update | Defer | Keep for settings. |
| Network delete | Defer | Keep owner delete only if product UX needs it. |
| Admin network delete | Drop | No admin surface until explicitly specified. |
| Network members list | Keep | Keep. |
| Human profile/description update | Defer | Keep as member/profile settings. |
| Public network auto-join | Reevaluate | Clarify product rule before implementation. |

## Devices

| Current Surface | Status | Target Direction |
|---|---|---|
| Daemon/device registration | First Slice | Replace with `device:hello`. |
| Device runtime report | First Slice | Replace with `device:runtimes`. |
| Device list/status snapshots | First Slice | Keep typed snapshots. |
| Device detail | Keep | Keep. |
| Device scan request | Keep | Keep as `device:scan-requested`. |
| Native directory picker | Defer | Keep for custom agent creation. |
| Device rename | Defer | Keep. |
| Device delete | Defer | Keep if device management UX requires it. |
| Device ownership transfer | Drop | Replace with re-invite/reconnect unless a clear admin need appears. |

## Agents

| Current Surface | Status | Target Direction |
|---|---|---|
| Agent visible snapshot/status | First Slice | Keep. |
| Agent discovery from daemon | First Slice | Replace old discovery payloads with typed runtime/agent reports. |
| `agent:create` custom agent | Keep | Keep, after device/runtime slice. |
| `agent:update` broad update | Merge/Rename | Remove. Split into publish/unpublish and config update. |
| `agent:config:update` | Keep | Keep as explicit custom agent config update. |
| `agent:delete` | Defer | Keep for custom agents; define permissions and delete semantics first. |
| `agent:custom:list` | Merge/Rename | Merge into filtered agent list or device detail. |
| `agent:publish` / `agent:unpublish` | Keep | Keep. |
| Agent metrics | Defer | Keep after core collaboration flow. |
| Legacy `standalone-cli` | Drop | Do not preserve. |

## Channels And Membership

| Current Surface | Status | Target Direction |
|---|---|---|
| Channel list/snapshot | First Slice | Keep. |
| Channel create | First Slice | Keep minimal public channel creation first; private membership can follow. |
| Channel join/history | First Slice | Keep, prefer ack result for history. |
| `channel:add-member` / `channel:remove-member` | Keep | Keep for private channel management. |
| `channel:add-agent` / `channel:remove-agent` | Keep | Keep for channel-agent membership. |
| `channel:members` | Keep | Keep. |
| Channel update/rename/visibility | Defer | Keep for channel settings. |
| Channel leave | Defer | Keep only if left/hidden channel UX remains. |
| Channel archive | Reevaluate | Defer or drop; needs product decision. |
| Channel delete | Reevaluate | Defer; decide hard-delete vs archive. |
| Stop agents in channel | Keep | Keep as dispatch cancellation, not channel-specific transport logic. |

## DMs And Threads

| Current Surface | Status | Target Direction |
|---|---|---|
| `dm:start` | Keep | Keep as start/get DM with agent. |
| `dm:list` / `dms:snapshot` | Keep | Keep. |
| DM mention filtering | Keep | Preserve behavior in UI and server routing. |
| Thread message context | Keep | Preserve. Dispatch history must not duplicate current prompt. |
| Formal thread data model | Missing | Add explicit thread fields or model in rewrite. |

## Messages, Search, Dispatch

| Current Surface | Status | Target Direction |
|---|---|---|
| `message:send` | First Slice | Keep core behavior: persist human message, route, dispatch, persist reply. |
| `channel:message` broadcast | First Slice | Keep. |
| `message:search` | Defer | Keep after message persistence is stable. |
| Agent dispatch `dispatch` | First Slice | Rename to `dispatch:request`. |
| Agent reply `reply` | First Slice | Rename to `dispatch:result`. |
| Agent error `error_event` | First Slice | Rename to `dispatch:error`. |
| `dispatch:cancel` | Keep | Keep. |
| Dispatch persistence | Missing | Add first-class dispatch table/model. |

## Artifacts And Workspace

| Current Surface | Status | Target Direction |
|---|---|---|
| Artifact upload/download | Keep | Keep after text dispatch slice, before rich agent workspace. |
| Artifact preview | Defer | Keep. |
| Artifact-message binding | Keep | Keep. |
| Workspace runs | Keep | Add explicit model; current behavior is under-modeled. |
| Web upload proxy route | Reevaluate | Keep only if deployment constraints require it. |

## Tasks

| Current Surface | Status | Target Direction |
|---|---|---|
| `task:create` | Defer | Keep after core chat/dispatch. |
| `task:list` | Defer | Keep. |
| `task:update` | Defer | Keep. |
| `task:delete` | Defer | Keep. |
| `task:reorder` | Merge/Rename | Merge into `task:update` unless UI benefits from explicit command. |
| `task:updated` | Defer | Keep. |
| Task-channel/message link | Keep | Preserve as product behavior. |

## Invites And Join Links

| Current Surface | Status | Target Direction |
|---|---|---|
| `invite:create` with `purpose: device` | Keep | Replace with explicit `device-invite:create`. |
| `invite:create` with `purpose: user` | Merge/Rename | Prefer user join link commands. |
| `join:create` | Keep | Keep as user invite creation. |
| `join:list` | Defer | Keep. |
| `join:revoke` | Defer | Keep. |
| `auth:join:validate` | Keep | Rename to `join:validate` or `invite:validate-user`. |

## Admin Surface

| Current Surface | Status | Target Direction |
|---|---|---|
| `admin:list-users` | Drop | Not part of first product. |
| `admin:delete-user` | Drop | Reintroduce only with explicit admin spec and audit model. |
| `admin:list-networks` | Drop | Not part of first product. |
| `admin:delete-network` | Drop | Owner network delete may remain separately. |
| `admin:list-devices` | Drop | Not part of first product. |
| `admin:transfer-device-owner` | Drop | Use re-invite/reconnect unless admin spec requires transfer. |
| `admin:list-agents` | Drop | Not part of first product. |
| `admin:delete-agent` | Drop | Not part of first product. |

## Minimum First Slice

Only these behaviors are required before building the rest:

1. Register/login.
2. Current network selection.
3. Device hello.
4. Runtime and agent report.
5. Agent/device snapshots.
6. Channel list/create/join.
7. Message send.
8. Dispatch request/result/error.
9. Persisted human and agent messages.

Everything else should be implemented after the first slice is stable.
