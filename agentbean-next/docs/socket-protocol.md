# Socket Protocol Draft

This is the first contract draft for AgentBean Next. It is intentionally smaller and stricter than the current protocol surface.

For the current implementation inventory and keep/defer/drop decisions, see:

- `docs/current-protocol-inventory.md`
- `docs/feature-disposition.md`

For first-slice DTO definitions, see `docs/contracts-dto.md`.

## Result Shape

Every client-command ack should use one shape:

```ts
type Ok<T = {}> = { ok: true } & T;
type Fail = { ok: false; error: ErrorCode; message?: string };
type Ack<T = {}> = Ok<T> | Fail;
```

Error codes should be stable strings:

- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_FAILED`
- `CONFLICT`
- `DEVICE_OFFLINE`
- `AGENT_OFFLINE`
- `DISPATCH_TIMEOUT`
- `EXECUTION_FAILED`
- `UPLOAD_FAILED`
- `INTERNAL`

## `/web` Namespace

Browser clients connect to `/web`.

Auth modes:

- Anonymous for login, signup, invite validation, and device login screens.
- User session token for normal app operations.

### Auth

#### `auth:login`

Client:

```ts
{ username: string; password: string }
```

Ack:

```ts
Ack<{ token: string; user: UserDto; currentNetwork: NetworkDto }>
```

#### `auth:register`

Client:

```ts
{ username: string; password: string; inviteCode?: string }
```

Ack:

```ts
Ack<{ token: string; user: UserDto; currentNetwork: NetworkDto }>
```

#### `auth:whoami`

Client:

```ts
{}
```

Ack:

```ts
Ack<{ user: UserDto; currentNetwork: NetworkDto | null }>
```

#### Deferred Auth Commands

These are target behaviors, but not first-slice requirements:

- `auth:change-password`: keep for account settings.
- `join:validate`: replaces current `auth:join:validate`.
- `join:create`: keep for user invite links.
- `join:list`: keep for invite management.
- `join:revoke`: keep for invite management.
- `device-invite:create`: explicit replacement for `invite:create` with `purpose: "device"`.
- `device-invite:complete`: explicit replacement for browser `auth:device-login` token delivery.

### Networks

#### `network:list`

Ack:

```ts
Ack<{ networks: NetworkDto[]; currentNetworkId: string | null }>
```

#### `network:create`

Client:

```ts
{ name: string; path?: string; description?: string; visibility?: "public" | "private" }
```

Ack:

```ts
Ack<{ network: NetworkDto }>
```

#### `network:switch`

Client:

```ts
{ networkId: string }
```

Ack:

```ts
Ack<{ network: NetworkDto }>
```

Server events:

- `networks:snapshot`: `NetworkDto[]`

Deferred network commands:

- `network:update`: keep for settings.
- `network:delete`: keep for owner delete if product UX needs it.

### Members

#### `members:list`

Client:

```ts
{ networkId: string }
```

Ack:

```ts
Ack<{ humans: HumanMemberDto[]; agents: AgentDto[] }>
```

Deferred member commands:

- `member:update-human`: keep for profile/member settings.

### Devices

#### `device:list`

Client:

```ts
{ networkId: string }
```

Ack:

```ts
Ack<{ devices: DeviceDto[] }>
```

#### `device:get`

Client:

```ts
{ deviceId: string }
```

Ack:

```ts
Ack<{ device: DeviceDetailDto }>
```

#### `device:scan`

Client:

```ts
{ deviceId: string }
```

Ack:

```ts
Ack
```

Server events:

- `devices:snapshot`: `DeviceDto[]`
- `device:status`: `DeviceDto`
- `device:runtimes`: `{ deviceId: string; runtimes: RuntimeDto[] }`

Deferred device commands:

- `device:rename`: keep for device management.
- `device:delete`: keep if target UX needs device removal.
- `device:select-directory`: keep for custom agent setup.

### Agents

#### `agents:subscribe`

Client:

```ts
{ networkId: string }
```

Ack:

```ts
Ack<{ agents: AgentDto[] }>
```

#### `agent:create`

Client:

```ts
{
  networkId: string;
  name: string;
  description?: string;
  adapterKind: AdapterKind;
  deviceId: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
```

Ack:

```ts
Ack<{ agent: AgentDto }>
```

#### `agent:publish`

Client:

```ts
{ agentId: string; networkId: string }
```

Ack:

```ts
Ack<{ agent: AgentDto }>
```

#### `agent:unpublish`

Client:

```ts
{ agentId: string; networkId: string }
```

Ack:

```ts
Ack<{ agent: AgentDto }>
```

Server events:

- `agents:snapshot`: `AgentDto[]`
- `agent:status`: `AgentDto`
- `agents:discovered`: `{ deviceId: string; runtimes: RuntimeDto[]; agents: DiscoveredAgentDto[] }`

Deferred agent commands:

- `agent:update-config`: replacement for current `agent:config:update`.
- `agent:delete`: keep for custom-agent management after delete semantics are specified.
- `agent:metrics`: keep for metrics slice.

Commands intentionally not preserved:

- `agent:update`: too broad; replace with `agent:publish`, `agent:unpublish`, and `agent:update-config`.
- `agent:custom:list`: merge into filtered agent list or device detail.

### Channels And Messages

#### `channel:create`

Client:

```ts
{
  networkId: string;
  name: string;
  description?: string;
  visibility: "public" | "private";
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}
```

Ack:

```ts
Ack<{ channel: ChannelDto }>
```

#### `channels:subscribe`

Client:

```ts
{ networkId: string }
```

Ack:

```ts
Ack<{ channels: ChannelDto[] }>
```

#### `channel:join`

Client:

```ts
{ channelId: string; limit?: number }
```

Ack:

```ts
Ack<{ channel: ChannelDto; messages: MessageDto[] }>
```

#### `message:send`

Client:

```ts
{
  channelId: string;
  body: string;
  clientMessageId?: string;
  threadId?: string;
  artifactIds?: string[];
}
```

Ack:

```ts
Ack<{ message: MessageDto; dispatches: DispatchDto[] }>
```

Server events:

- `channels:snapshot`: `ChannelDto[]`
- `channel:message`: `MessageDto`
- `message:dispatch-status`: `DispatchDto`

Deferred channel, DM, and message commands:

- `channel:update`: keep for channel settings.
- `channel:add-member`: keep for private channel management.
- `channel:remove-member`: keep for private channel management.
- `channel:add-agent`: keep for channel-agent membership.
- `channel:remove-agent`: keep for channel-agent membership.
- `channel:members`: keep for channel detail views.
- `channel:leave`: keep only if hidden/left channel UX remains.
- `channel:archive`: defer; product decision required.
- `channel:delete`: defer; product decision required.
- `channel:stop-agents`: replace with dispatch cancellation commands.
- `dm:start`: keep.
- `dm:list`: keep.
- `message:search`: keep for search slice.

### Tasks (Deferred Later Slice)

Task commands reserve product direction only. Do not implement these in the first slice, and do not define `TaskDto` until the task slice begins.

#### `task:list`

Client:

```ts
{ networkId: string; channelId?: string }
```

Ack:

```ts
Ack<{ tasks: TaskDto[] }>
```

#### `task:create`

Client:

```ts
{
  networkId: string;
  title: string;
  description?: string;
  channelId?: string;
  assigneeId?: string;
  tags?: string[];
}
```

Ack:

```ts
Ack<{ task: TaskDto }>
```

#### `task:update`

Client:

```ts
{
  taskId: string;
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  assigneeId?: string | null;
  channelId?: string | null;
  tags?: string[];
  sortOrder?: number;
}
```

Ack:

```ts
Ack<{ task: TaskDto }>
```

Server events:

- `tasks:snapshot`: `TaskDto[]`
- `task:updated`: `TaskDto`

Deferred task commands:

- `task:delete`: keep.
- `task:reorder`: merge into `task:update` unless a dedicated command remains clearer.

## Removed From Target Protocol

The current implementation has admin events, but the old product has not shipped and the admin surface is not specified enough to carry forward.

Do not include these in the initial target protocol:

- `admin:list-users`
- `admin:delete-user`
- `admin:list-networks`
- `admin:delete-network`
- `admin:list-devices`
- `admin:transfer-device-owner`
- `admin:list-agents`
- `admin:delete-agent`

They can be reintroduced later only with explicit role, permission, and audit requirements.

## `/agent` Namespace

Daemon clients connect to `/agent`.

Auth modes:

- Device token.
- Transitional user token only for invite completion or local development, if explicitly allowed.

### Device Registration

#### `device:hello`

Daemon:

```ts
{
  deviceId: string;
  networkId: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: Record<string, unknown>;
}
```

Ack:

```ts
Ack<{ device: DeviceDto; scanIntervalMs: number }>
```

### Runtime And Agent Discovery

#### `device:runtimes`

Daemon:

```ts
{ deviceId: string; networkId: string; runtimes: RuntimeDto[] }
```

Ack:

```ts
Ack
```

#### `agent:register-batch`

Daemon:

```ts
{
  deviceId: string;
  networkId: string;
  agents: DiscoveredAgentDto[];
}
```

Ack:

```ts
Ack<{ agents: AgentDto[] }>
```

Server events:

- `device:scan-requested`: `{ requestId: string }`
- `dispatch:request`: `DispatchRequestDto`
- `dispatch:cancel`: `{ dispatchId: string; reason?: string }`

### Dispatch Result

#### `dispatch:accepted`

Daemon:

```ts
{ dispatchId: string }
```

Ack:

```ts
Ack
```

#### `dispatch:result`

Daemon:

```ts
{
  dispatchId: string;
  agentId: string;
  body: string;
  artifactIds?: string[];
  usage?: AgentUsageDto;
}
```

Ack:

```ts
Ack
```

#### `dispatch:error`

Daemon:

```ts
{
  dispatchId: string;
  agentId: string;
  error: string;
  retryable?: boolean;
}
```

Ack:

```ts
Ack
```

## DTO Notes

DTOs should not expose database rows directly.

### First-Slice DTOs

These DTOs are defined in `docs/contracts-dto.md` and are required for the first slice:

- `UserDto`
- `NetworkDto`
- `HumanMemberDto`
- `AgentDto`
- `RuntimeDto`
- `DiscoveredAgentDto`
- `DeviceDto`
- `DeviceDetailDto`
- `ChannelDto`
- `MessageDto`
- `DispatchDto`
- `DispatchRequestDto`

### Later-Slice DTOs

These DTO families are intentionally not defined in the first-slice contract yet:

- `ArtifactDto`
- `TaskDto`
- `WorkspaceRunDto`
- `InviteDto`
- `JoinLinkDto`

The protocol may mention later-slice commands to reserve product direction, but implementation should not invent those DTOs until the corresponding slice begins.

## Compatibility Notes

The current implementation uses several older event names. The rewrite can support a temporary adapter only if needed, but the target protocol should use the names above and avoid preserving accidental aliases.
