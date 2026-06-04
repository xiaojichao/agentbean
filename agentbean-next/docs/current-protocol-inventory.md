# Current Protocol Inventory

This document inventories the current Socket.IO and HTTP protocol surface. It is a Phase 0 input for the rewrite, not a compatibility promise.

The current protocol is useful as a behavior map, but the rewrite does not need to preserve event names, payload shapes, ack shapes, or legacy aliases.

## `/web` Namespace

Browser clients connect to `/web`. The current implementation allows anonymous sockets for auth and invite flows, and authenticated sockets for app operations.

### Auth And Session

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `auth:register` | Web -> Server | Register a user, create private network, optionally consume invite. | Keep behavior, redesign payload/result. |
| `auth:login` | Web -> Server | Login and return token/current network. Also consumes join code when supplied. | Keep behavior, separate login from join consumption where cleaner. |
| `auth:whoami` | Web -> Server | Return current user. | Keep. |
| `auth:change-password` | Web -> Server | Change password after verifying current password. | Keep, but defer until account settings slice. |
| `auth:invite:validate` | Web/Daemon -> Server | Validate device or user invite; for device invite also records waiting daemon socket. | Split into explicit user-invite and device-invite flows. |
| `auth:device-login` | Web -> Server | Browser login for a waiting device invite; delivers token to daemon. | Keep behavior, redesign as device invite completion use case. |
| `auth:join:validate` | Web -> Server | Validate user join link and return target network display info. | Keep behavior, rename under join/invite domain. |
| `auth:token:deliver` | Server -> Waiting socket | Deliver token to daemon or invite session. | Keep behavior, but make delivery target explicit. |

### Networks

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `network:list` | Web -> Server | List networks visible to the current user. | Keep. |
| `network:create` | Web -> Server | Create network and default channel. | Keep. |
| `network:switch` | Web -> Server | Set socket current network and persist user current network. | Keep. |
| `network:update` | Web -> Server | Rename current network. | Keep, defer until settings slice. |
| `network:delete` | Web -> Server | Delete a network and broadcast fallback network state. | Keep behavior, defer until settings/admin slice. |
| `networks:snapshot` | Server -> Web | Broadcast visible network list. | Keep as snapshot, payload should be typed. |
| `network:deleted` | Server -> Web | Notify sockets when current network was deleted. | Keep behavior if delete remains in scope. |

### Members

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `members:list` | Web -> Server | List human members and visible agents for a network. | Keep. |
| `member:update-human` | Web -> Server | Update human description. | Keep, defer until profile/member settings slice. |

### Devices

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `devices:subscribe` | Web -> Server | Subscribe to device snapshot for current network. | Keep as `device:list` plus `devices:snapshot`. |
| `devices:list` | Web -> Server | List devices for current network. | Keep, normalize to singular command naming if desired. |
| `device:get` | Web -> Server | Get device detail. | Keep. |
| `device:agents:list` | Web -> Server | List agents and runtimes for one device. | Keep behavior, likely split into `device:get` detail DTO. |
| `device:scan` | Web -> Server -> Daemon | Ask online daemon to rescan. | Keep. |
| `device:select-directory` | Web -> Server -> Daemon | Ask daemon to open native directory picker. | Keep behavior, defer until custom agent setup slice. |
| `device:delete` | Web -> Server | Delete a device. | Keep, defer. |
| `device:rename` | Web -> Server | Rename device/hostname. | Keep, defer. |
| `devices:snapshot` | Server -> Web | Broadcast/list devices. | Keep. |
| `device:status` | Server -> Web | Broadcast device status or metadata changes. | Keep. |

### Agents

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `agents:subscribe` | Web -> Server | Send visible agent snapshot for current network. | Keep. |
| `agents:discover` | Web -> Server -> Daemon | Broadcast rescan request to daemons. | Keep behavior, probably route through `device:scan` for targeted scans. |
| `agents:snapshot` | Server -> Web | Visible agent snapshot. | Keep. |
| `agents:discovered` | Server -> Web | Relay daemon discovery payload. | Keep as typed discovery event. |
| `agent:status` | Server -> Web | Broadcast agent online/busy/error/offline state. | Keep. |
| `agent:metrics` | Web -> Server | Return metrics summaries. | Keep, defer until metrics slice. |
| `agent:create` | Web -> Server | Create custom or hosted agent config. | Keep, but redesign command/config DTO. |
| `agent:update` | Web -> Server | Update visibility/network fields for an agent. | Replace with explicit `agent:publish`, `agent:unpublish`, and config update. Do not keep as broad update. |
| `agent:config:update` | Web -> Server | Update custom agent name/runtime config. | Keep as `agent:update-config` or equivalent. |
| `agent:custom:list` | Web -> Server | List custom agents, optionally by device. | Merge into `agents:subscribe`, `device:get`, or a filtered `agent:list`. |
| `agent:delete` | Web -> Server | Delete custom or AgentOS agent where allowed. | Keep behavior, defer until agent management slice. |
| `agent:publish` | Web -> Server | Publish agent to network. | Keep. |
| `agent:unpublish` | Web -> Server | Unpublish agent from network. | Keep. |

### Channels, DMs, Messages

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `channels:subscribe` | Web -> Server | Send channel and DM snapshots. | Keep, but split channel and DM snapshots if cleaner. |
| `channels:snapshot` | Server -> Web | Channel list snapshot. | Keep. |
| `channel:create` | Web -> Server | Create public/private channel with agents and users. | Keep. |
| `channel:join` | Web -> Server | Join room and return message history. | Keep. |
| `channel:history` | Server -> Web | Channel history result. | Prefer ack result from `channel:join`; event optional. |
| `channel:message` | Server -> Web | Broadcast persisted message. | Keep. |
| `channel:members` | Web -> Server | Get human and agent members for channel. | Keep. |
| `channel:add-member` | Web -> Server | Add human member. | Keep. |
| `channel:remove-member` | Web -> Server | Remove human member. | Keep. |
| `channel:add-agent` | Web -> Server | Add agent member. | Keep. |
| `channel:remove-agent` | Web -> Server | Remove agent member. | Keep. |
| `channel:update` | Web -> Server | Rename/update description/visibility. | Keep, defer until channel settings slice. |
| `channel:leave` | Web -> Server | Mark user leave for channel. | Keep behavior if leave UX remains. |
| `channel:archive` | Web -> Server | Archive channel. | Defer; keep only if product needs archive. |
| `channel:delete` | Web -> Server | Delete channel. | Defer; keep only if product needs hard delete. |
| `channel:stop-agents` | Web -> Server | Cancel running agents associated with channel. | Keep behavior, redesign around dispatch cancellation. |
| `dm:start` | Web -> Server | Create/get DM channel with agent. | Keep. |
| `dm:list` | Web -> Server | List DMs. | Keep. |
| `dms:snapshot` | Server -> Web | DM list snapshot. | Keep. |
| `message:send` | Web -> Server | Persist human message, route and dispatch to agents. | Keep as first-slice behavior. |
| `message:search` | Web -> Server | Search messages in current network. | Keep, defer until search slice. |

### Tasks

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `task:create` | Web -> Server | Create network/channel task. | Keep, defer after first chat/dispatch slice unless needed. |
| `task:list` | Web -> Server | List tasks, optionally by channel. | Keep. |
| `task:update` | Web -> Server | Update fields/status/assignment/sort. | Keep. |
| `task:delete` | Web -> Server | Delete task. | Keep. |
| `task:reorder` | Web -> Server | Update task sort order. | Merge into `task:update` unless a dedicated command is clearer. |
| `task:updated` | Server -> Web | Broadcast task update. | Keep. |

### Invites And Join Links

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `invite:create` | Web -> Server | Create user/device invite. | Keep behavior, split explicit user invite and device invite commands. |
| `join:create` | Web -> Server | Create user join link for current network. | Keep, rename under invite/join domain. |
| `join:list` | Web -> Server | List active join links. | Keep, defer. |
| `join:revoke` | Web -> Server | Revoke join link. | Keep, defer. |

### Admin

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `admin:list-users` | Web -> Server | Admin user inventory. | Drop from first product. Reintroduce only with explicit admin requirements. |
| `admin:delete-user` | Web -> Server | Delete user. | Drop/defer. |
| `admin:list-networks` | Web -> Server | Admin network inventory. | Drop/defer. |
| `admin:delete-network` | Web -> Server | Delete network as admin. | Drop/defer; normal owner delete can remain. |
| `admin:list-devices` | Web -> Server | Admin device inventory. | Drop/defer. |
| `admin:transfer-device-owner` | Web -> Server | Transfer device ownership. | Drop/defer; likely support through device re-invite instead. |
| `admin:list-agents` | Web -> Server | Admin agent inventory. | Drop/defer. |
| `admin:delete-agent` | Web -> Server | Delete arbitrary agent as admin. | Drop/defer. |

## `/agent` Namespace

Daemon clients connect to `/agent`.

### Daemon -> Server

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `register` | Daemon -> Server | Register one agent. | Replace with device hello plus typed batch registration unless single-agent registration is still needed. |
| `heartbeat` | Daemon -> Server | Refresh agent/device heartbeat and status. | Keep behavior, define explicit heartbeat DTO. |
| `reply` | Daemon -> Server | Return agent text/artifact result for request. | Replace with `dispatch:result`. |
| `error_event` | Daemon -> Server | Report agent execution or request error. | Replace with `dispatch:error` and device/agent error events. |
| `agents:discovered` | Daemon -> Server | Send discovered agents, relayed to web. | Replace with typed discovery/report events. |
| `device:register-agents` | Daemon -> Server | Batch register scanned agents and mark missing agents offline. | Keep behavior as `agent:register-batch`. |
| `device:register-runtimes` | Daemon -> Server | Report installed runtimes. | Keep as `device:runtimes`. |

### Server -> Daemon

| Event | Direction | Current Purpose | Rewrite Disposition |
|---|---|---|---|
| `agents:discover` | Server -> Daemon | Request rescan. | Keep as `device:scan-requested`. |
| `device:select-directory` | Server -> Daemon | Request native directory picker. | Keep, defer until custom agent setup. |
| `dispatch` | Server -> Daemon | Execute an agent request. | Keep behavior as `dispatch:request`. |
| `dispatch:cancel` | Server -> Daemon | Cancel pending/running request. | Keep. |

## HTTP Routes

| Route | Current Purpose | Rewrite Disposition |
|---|---|---|
| `GET /healthz` | Health check. | Keep. |
| Artifact upload/download routes under `/api/networks/:networkId/artifacts/*` | Upload, preview, and download artifacts. | Keep behavior; define auth, network scoping, and metadata contract. |
| Web proxy artifact upload route in `apps/web/app/api/networks/[networkId]/artifacts/upload/route.ts` | Frontend fallback/proxy upload. | Reevaluate. Prefer direct typed server route unless deployment requires proxy. |

## Current Protocol Problems

- Event naming is inconsistent: singular and plural forms both exist (`device:*` and `devices:*`).
- Some events do too much, especially `message:send`, `agent:create`, and invite/auth flows.
- Current ack shapes are not uniform.
- Some server-to-client responses use events where request acks would be clearer, such as `channel:history`.
- Admin events exist without a fully specified product surface.
- Current web client centralizes nearly all protocol calls in `apps/web/lib/socket.ts`.
- Daemon protocol mixes agent registration, device registration, runtime report, dispatch, and discovery concerns.
