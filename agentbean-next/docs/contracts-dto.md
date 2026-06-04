# First-Slice Contracts And DTOs

This document defines the minimum shared DTO surface for the first AgentBean Next implementation slice.

Scope:

- User login/register.
- Current network selection.
- Daemon device registration.
- Runtime and agent discovery.
- Agent/device snapshots.
- Channel list/create/join.
- Message send.
- Agent dispatch request/result/error.

Out of scope for this first DTO pass:

- Tasks.
- Artifacts.
- Workspace runs.
- Invites/join links.
- Admin.
- Search.
- Channel settings beyond first-slice creation/join.

## Contract Rules

- DTOs are transport contracts, not database rows.
- IDs are opaque strings.
- Timestamps are Unix epoch milliseconds.
- Optional fields should be omitted when unknown unless `null` carries explicit meaning.
- Server owns all permission, visibility, identity, and dedupe decisions.
- Web and daemon may cache DTOs but must not infer domain truth from missing fields.
- All command acknowledgements use `Ack<T>`.

## Common Types

```ts
export type ID = string;
export type UnixMs = number;

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "DEVICE_OFFLINE"
  | "AGENT_OFFLINE"
  | "DISPATCH_TIMEOUT"
  | "EXECUTION_FAILED"
  | "UPLOAD_FAILED"
  | "INTERNAL";

export type Ack<T extends object = {}> =
  | ({ ok: true } & T)
  | { ok: false; error: ErrorCode; message?: string; details?: Record<string, unknown> };
```

## UserDto

```ts
export interface UserDto {
  id: ID;
  username: string;
  email?: string | null;
  displayName?: string | null;
  role: "user" | "admin";
}
```

Notes:

- `role` is included because current behavior already has admin/user roles, but admin protocol is out of first-slice scope.
- `displayName` is separate from `username` so UI naming can evolve without changing login identity.

## HumanMemberDto

```ts
export interface HumanMemberDto {
  userId: ID;
  username: string;
  displayName?: string | null;
  role: "owner" | "member" | "admin";
  description?: string | null;
  joinedAt: UnixMs;
}
```

Notes:

- `HumanMemberDto` is a network membership projection, not the full account record.
- `role` is scoped to the network/team membership.

## NetworkDto

```ts
export interface NetworkDto {
  id: ID;
  name: string;
  path: string;
  description?: string | null;
  visibility: "private" | "public";
  ownerId: ID;
  currentUserRole: "owner" | "member" | "admin";
  createdAt: UnixMs;
}
```

Notes:

- `path` is the stable UI route segment.
- The first slice can use `NetworkDto` even if product language later changes to `TeamDto`.

## DeviceDto

```ts
export type DeviceStatus = "connecting" | "online" | "offline" | "error";

export interface DeviceDto {
  id: ID;
  networkId: ID;
  ownerId: ID;
  machineId?: string | null;
  profileId?: string | null;
  hostname?: string | null;
  status: DeviceStatus;
  lastSeenAt: UnixMs;
  daemonVersion?: string | null;
  systemInfo?: DeviceSystemInfoDto | null;
}

export interface DeviceSystemInfoDto {
  platform?: string;
  arch?: string;
  release?: string;
  hostname?: string;
  cpus?: number;
  memoryBytes?: number;
}

export interface DeviceDetailDto extends DeviceDto {
  runtimes: RuntimeDto[];
  agents: AgentDto[];
  capabilities?: DeviceCapabilitiesDto;
}

export interface DeviceCapabilitiesDto {
  directoryPicker?: boolean;
}
```

Notes:

- `DeviceDto` is snapshot-friendly.
- `DeviceDetailDto` is the first-slice detail shell used by `device:get`; later slices may add workspace, logs, invite, and diagnostics fields.
- Runtime and agent lists may also arrive through snapshot events.

## RuntimeDto

```ts
export type AdapterKind =
  | "codex"
  | "claude-code"
  | "kimi-cli"
  | "hermes"
  | "openclaw";

export interface RuntimeDto {
  id: ID;
  deviceId: ID;
  adapterKind: AdapterKind;
  name: string;
  installed: boolean;
  command?: string | null;
  normalizedCommandKey?: string | null;
  cwd?: string | null;
  normalizedCwdKey?: string | null;
  version?: string | null;
  lastSeenAt: UnixMs;
}
```

Notes:

- `command` and `cwd` preserve display values.
- `normalizedCommandKey` and `normalizedCwdKey` are comparison keys generated using platform/filesystem rules from `agent-identity-rules.md`.
- Runtimes are capabilities. They are not visible product agents unless bound through an agent identity/config.

## AgentDto

```ts
export type AgentCategory = "executor-hosted" | "agentos-hosted";
export type AgentSource = "custom" | "self-register" | "scanned";
export type AgentStatus = "connecting" | "online" | "busy" | "offline" | "error";

export interface AgentDto {
  id: ID;
  primaryNetworkId: ID;
  visibleNetworkIds: ID[];
  name: string;
  role?: string | null;
  description?: string | null;
  adapterKind: AdapterKind;
  category: AgentCategory;
  source: AgentSource;
  status: AgentStatus;
  ownerId?: ID | null;
  deviceId?: ID | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  envKeys?: string[];
  lastSeenAt: UnixMs;
  lastError?: string | null;
}
```

Notes:

- `visibleNetworkIds` is a projection result from publication/visibility rules. Clients must not compute it.
- `envKeys` can show which variables are configured without exposing secret values.

## DiscoveredAgentDto

```ts
export interface DiscoveredAgentDto {
  deviceId: ID;
  networkId: ID;
  name: string;
  adapterKind: AdapterKind;
  category: AgentCategory;
  source: "scanned" | "self-register";
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  gatewayId?: string | null;
  gatewayName?: string | null;
  gatewayInstanceKey?: string | null;
  metadata?: Record<string, unknown>;
}
```

Notes:

- This is daemon/gateway report data, not necessarily a persisted visible `AgentDto`.
- Server identity rules decide whether this creates, updates, aliases, or only refreshes availability for a logical agent.

## ChannelDto

```ts
export type ChannelKind = "channel" | "dm";
export type ChannelVisibility = "public" | "private";

export interface ChannelDto {
  id: ID;
  networkId: ID;
  kind: ChannelKind;
  name: string;
  description?: string | null;
  visibility: ChannelVisibility;
  createdBy?: ID | null;
  createdAt: UnixMs;
  archivedAt?: UnixMs | null;
  dmTargetAgentId?: ID | null;
  humanMemberIds?: ID[];
  agentMemberIds?: ID[];
}
```

Notes:

- First slice may only create public channels.
- Private channel and DM fields are included because first-slice snapshots should not need a breaking DTO change later.

## MessageDto

```ts
export type SenderKind = "human" | "agent" | "system";

export interface MessageDto {
  id: ID;
  networkId: ID;
  channelId: ID;
  threadId?: ID | null;
  senderKind: SenderKind;
  senderId?: ID | null;
  senderName?: string | null;
  body: string;
  createdAt: UnixMs;
  clientMessageId?: string | null;
  dispatchIds?: ID[];
  artifactIds?: ID[];
  meta?: MessageMetaDto;
}

export interface MessageMetaDto {
  routeReason?: "MENTION" | "HUMAN_MENTION" | "FALLBACK" | "UNKNOWN_MENTION" | "NO_ONLINE";
  mentionedName?: string | null;
  taskId?: ID | null;
}
```

Notes:

- Server sets `senderKind` and `senderId`; clients must not be trusted for sender identity.
- `threadId` should not cause the current prompt to appear twice in dispatch history.

## DispatchDto

```ts
export type DispatchStatus =
  | "queued"
  | "sent"
  | "accepted"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export interface DispatchDto {
  id: ID;
  networkId: ID;
  channelId: ID;
  messageId: ID;
  agentId: ID;
  deviceId?: ID | null;
  status: DispatchStatus;
  requestId: string;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  acceptedAt?: UnixMs | null;
  completedAt?: UnixMs | null;
  error?: ErrorCode | null;
  errorMessage?: string | null;
}
```

Notes:

- `DispatchDto` is first-class in the rewrite, unlike the current mostly in-memory lifecycle.
- `requestId` is the daemon protocol correlation ID and may differ from persisted `id`.

## DispatchRequestDto

```ts
export interface DispatchRequestDto {
  dispatchId: ID;
  requestId: string;
  networkId: ID;
  channelId: ID;
  messageId: ID;
  agentId: ID;
  teamName?: string | null;
  prompt: string;
  history: DispatchHistoryItemDto[];
  attachments?: DispatchAttachmentDto[];
  customAgent?: DispatchCustomAgentDto | null;
}

export interface DispatchHistoryItemDto {
  role: "user" | "assistant" | "system";
  speaker: string;
  body: string;
  at: UnixMs;
}

export interface DispatchAttachmentDto {
  id: ID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  previewUrl?: string | null;
}

export interface DispatchCustomAgentDto {
  id: ID;
  name: string;
  adapterKind: AdapterKind;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string>;
}
```

Notes:

- `prompt` is the current user input.
- `history` must not include the current user input again.
- First slice may send raw `customAgent.env` values, but only to the single daemon selected to execute that custom agent and only inside the dispatch request.
- Server must not broadcast raw env values to web clients, snapshots, logs, or unrelated daemons.
- Later slices should replace raw env transport with a server-issued secret reference or daemon-local secret storage.

## First-Slice Event DTO Usage

```ts
// /web
type AuthLoginAck = Ack<{ token: string; user: UserDto; currentNetwork: NetworkDto }>;
type NetworkListAck = Ack<{ networks: NetworkDto[]; currentNetworkId: ID | null }>;
type DeviceListAck = Ack<{ devices: DeviceDto[] }>;
type AgentSubscribeAck = Ack<{ agents: AgentDto[] }>;
type ChannelJoinAck = Ack<{ channel: ChannelDto; messages: MessageDto[] }>;
type MessageSendAck = Ack<{ message: MessageDto; dispatches: DispatchDto[] }>;

// /agent
type DeviceHelloAck = Ack<{ device: DeviceDto; scanIntervalMs: number }>;
type RuntimeReportAck = Ack;
type AgentRegisterBatchAck = Ack<{ agents: AgentDto[] }>;
type DispatchAcceptedAck = Ack;
type DispatchResultAck = Ack;
type DispatchErrorAck = Ack;
```

## Phase 1 DTO Decisions

- Keep `NetworkDto` for the first slice. Product copy may say "team" later, but contracts should not rename it before the first slice is implemented.
- Keep `DeviceSystemInfoDto` loose and optional for the first slice. Tighten it only after daemon platform reporting stabilizes.
- Do not include `AgentDto.displayRank` in the first-slice public DTO. Display precedence stays server-side and is verified through ordered/projection results, not exposed as a client contract field.
- Keep `humanMemberIds` and `agentMemberIds` on first-slice `ChannelDto` as optional snapshot fields. A later `channel:members` command may provide richer member details.
- First slice may send raw `DispatchCustomAgentDto.env` only to the selected daemon inside `DispatchRequestDto`. Replace with secret references or daemon-local secret storage in a later security hardening slice.
