# 第一切片 Contracts 与 DTOs

本文档定义 AgentBean Next 第一实现切片所需的最小共享 DTO 表面。

范围：

- User login/register。
- Current team selection。
- Daemon device registration。
- Runtime 与 agent discovery。
- Agent/device snapshots。
- Channel list/create/join。
- Message send。
- Agent dispatch request/result/error。

第一轮 DTO 不包含：

- Tasks。
- Artifacts。
- Workspace runs。
- Invites/join links。
- Admin。
- Search。
- 第一切片 create/join 之外的 channel settings。

## Contract 规则

- DTOs 是 transport contracts，不是 database rows。
- IDs 是 opaque strings。
- Timestamps 使用 Unix epoch milliseconds。
- Optional fields 在 unknown 时应省略，除非 `null` 携带显式含义。
- Server 拥有所有 permission、visibility、identity 与 dedupe decisions。
- Web 与 daemon 可以缓存 DTOs，但不得从 missing fields 推断 domain truth。
- 所有 command acknowledgements 使用 `Ack<T>`。

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

说明：

- 包含 `role` 是因为当前行为已经有 admin/user roles，但 admin protocol 不属于第一切片范围。
- `displayName` 与 `username` 分开，使 UI 命名可以演进而不改变 login identity。

## HumanMemberDto

```ts
export interface HumanMemberDto {
  id: ID;
  teamId: ID;
  userId: ID;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  role: "owner" | "member" | "admin";
}
```

说明：

- `HumanMemberDto` 是 team membership projection，不是完整 account record。
- `role` 的作用域是 team membership。
- `id` 是 membership projection id，当前实现使用 `${teamId}:${userId}`。

## TeamDto

```ts
export interface TeamDto {
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

说明：

- `path` 是稳定的 UI route segment。
- `TeamDto` 是第一切片的团队投影，也是统一后的产品术语。

## DeviceDto

```ts
export type DeviceStatus = "connecting" | "online" | "offline" | "error";

export interface DeviceDto {
  id: ID;
  teamId: ID;
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

说明：

- `DeviceDto` 适合 snapshot。
- `DeviceDetailDto` 是 `device:get` 在第一切片中的 detail shell；后续切片可添加 workspace、logs、invite 与 diagnostics fields。
- Runtime 与 agent lists 也可能通过 snapshot events 到达。

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

说明：

- `command` 与 `cwd` 保留 display values。
- `normalizedCommandKey` 与 `normalizedCwdKey` 是按照 `agent-identity-rules.md` 中平台/文件系统规则生成的 comparison keys。
- Runtimes 是 capabilities。除非通过 agent identity/config 绑定，否则不是 visible product agents。

## AgentDto

```ts
export type AgentCategory = "executor-hosted" | "agentos-hosted";
export type AgentSource = "custom" | "self-register" | "scanned";
export type AgentStatus = "connecting" | "online" | "busy" | "offline" | "error";

export interface AgentDto {
  id: ID;
  primaryTeamId: ID;
  visibleTeamIds: ID[];
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

说明：

- `visibleTeamIds` 是 publication/visibility rules 的 projection result。Clients 不得自行计算。
- `envKeys` 可以展示已配置哪些变量，而不会暴露 secret values。

## DiscoveredAgentDto

```ts
export interface DiscoveredAgentDto {
  deviceId: ID;
  teamId: ID;
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

说明：

- 这是 daemon/gateway report data，不一定是已持久化的 visible `AgentDto`。
- Server identity rules 决定它会为某个 logical agent 创建、更新、alias，还是仅刷新 availability。

## ChannelDto

```ts
export type ChannelKind = "channel" | "dm";
export type ChannelVisibility = "public" | "private";

export interface ChannelDto {
  id: ID;
  teamId: ID;
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

说明：

- 第一切片可能只创建 public channels。
- Private channel 与 DM fields 已包含进来，是为了让第一切片 snapshots 后续不需要破坏性 DTO 变更。

## ChannelMembersDto

```ts
export interface ChannelMembersDto {
  humanMemberIds: ID[];
  agentMemberIds: ID[];
  humans: HumanMemberDto[];
  agents: AgentDto[];
}
```

说明：

- `channel:members` 返回 id 列表与详情 projection，方便 UI 保持兼容同时直接渲染成员弹窗。
- `humanMemberIds` / `agentMemberIds` 是 channel membership 的原始 id 顺序。
- `humans` / `agents` 是 server 已做 team visibility 与 repository projection 后的详情列表。旧数据中缺失或不可见的 agent 可以保留在 id 列表中，但不会出现在 `agents` 详情里。

## MessageDto

```ts
export type SenderKind = "human" | "agent" | "system";

export interface MessageDto {
  id: ID;
  teamId: ID;
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

说明：

- Server 设置 `senderKind` 与 `senderId`；sender identity 不可信任 clients。
- `threadId` 不应导致当前 prompt 在 dispatch history 中出现两次。

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
  teamId: ID;
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

说明：

- 不同于当前基本在内存中协调的 lifecycle，`DispatchDto` 在重写版中是一等模型。
- `requestId` 是 daemon protocol correlation ID，可能不同于 persisted `id`。

## DispatchRequestDto

```ts
export interface DispatchRequestDto {
  dispatchId: ID;
  requestId: string;
  teamId: ID;
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

说明：

- `prompt` 是当前 user input。
- `history` 不得再次包含当前 user input。
- 第一切片可以发送 raw `customAgent.env` values，但只能发给被选中执行该 custom agent 的单个 daemon，且只能放在 dispatch request 内。
- Server 不得把 raw env values 广播到 web clients、snapshots、logs 或无关 daemons。
- 后续切片应将 raw env transport 替换为 server-issued secret reference 或 daemon-local secret storage。

## 第一切片 Event DTO 用法

```ts
// /web
type AuthLoginAck = Ack<{ token: string; user: UserDto; currentTeam: TeamDto }>;
type TeamListAck = Ack<{ teams: TeamDto[]; currentTeamId: ID | null }>;
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

## Phase 1 DTO 决策

- 第一切片统一使用 `TeamDto`，不再引入旧团队 DTO 别名。
- 第一切片保留宽松且可选的 `DeviceSystemInfoDto`。只有在 daemon platform reporting 稳定后再收紧。
- 第一切片 public DTO 不包含 `AgentDto.displayRank`。Display precedence 留在 server-side，并通过 ordered/projection results 验证，而不是暴露成 client contract field。
- 在第一切片 `ChannelDto` 上保留可选的 `humanMemberIds` 与 `agentMemberIds` snapshot fields。第七切片的 `channel:members` command 已提供 `ChannelMembersDto`，同时返回 ids 与 human/agent detail projections。
- 第一切片只允许在 `DispatchRequestDto` 内，把 raw `DispatchCustomAgentDto.env` 发给被选中的 daemon。后续 security hardening slice 应替换为 secret references 或 daemon-local secret storage。
