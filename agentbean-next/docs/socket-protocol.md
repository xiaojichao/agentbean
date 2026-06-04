# Socket 协议草案

这是 AgentBean Next 的第一版 contract draft。它有意比当前 protocol surface 更小、更严格。

当前实现盘点以及 keep/defer/drop 决策见：

- `docs/current-protocol-inventory.md`
- `docs/feature-disposition.md`

第一切片 DTO 定义见 `docs/contracts-dto.md`。

## 结果形状

所有 client-command ack 都应使用同一种形状：

```ts
type Ok<T = {}> = { ok: true } & T;
type Fail = { ok: false; error: ErrorCode; message?: string };
type Ack<T = {}> = Ok<T> | Fail;
```

Error codes 应是稳定字符串：

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

Browser clients 连接到 `/web`。

Auth modes：

- Anonymous：用于 login、signup、invite validation 与 device login screens。
- User session token：用于 normal app operations。

### Auth

#### `auth:login`

客户端：

```ts
{ username: string; password: string }
```

Ack：

```ts
Ack<{ token: string; user: UserDto; currentTeam: TeamDto }>
```

#### `auth:register`

客户端：

```ts
{ username: string; password: string; inviteCode?: string }
```

Ack：

```ts
Ack<{ token: string; user: UserDto; currentTeam: TeamDto }>
```

#### `auth:whoami`

客户端：

```ts
{}
```

Ack：

```ts
Ack<{ user: UserDto; currentTeam: TeamDto | null }>
```

#### 延后的 Auth Commands

这些是目标行为，但不是第一切片要求：

- `auth:change-password`：保留给 account settings。
- `join:validate`：替换当前 `auth:join:validate`。
- `join:create`：保留给 user invite links。
- `join:list`：保留给 invite management。
- `join:revoke`：保留给 invite management。
- `device-invite:create`：显式替换 `purpose: "device"` 的 `invite:create`。
- `device-invite:complete`：显式替换 browser `auth:device-login` token delivery。

### Teams

#### `team:list`

Ack：

```ts
Ack<{ teams: TeamDto[]; currentTeamId: string | null }>
```

#### `team:create`

客户端：

```ts
{ name: string; path?: string; description?: string; visibility?: "public" | "private" }
```

Ack：

```ts
Ack<{ team: TeamDto }>
```

#### `team:switch`

客户端：

```ts
{ teamId: string }
```

Ack：

```ts
Ack<{ team: TeamDto }>
```

服务器事件：

- `teams:snapshot`：`TeamDto[]`

延后的 team commands：

- `team:update`：保留给 settings。
- `team:delete`：如果 product UX 需要 owner delete，则保留。

### Members

#### `members:list`

客户端：

```ts
{ teamId: string }
```

Ack：

```ts
Ack<{ humans: HumanMemberDto[]; agents: AgentDto[] }>
```

延后的 member commands：

- `member:update-human`：保留给 profile/member settings。

### Devices

#### `device:list`

客户端：

```ts
{ teamId: string }
```

Ack：

```ts
Ack<{ devices: DeviceDto[] }>
```

#### `device:get`

客户端：

```ts
{ deviceId: string }
```

Ack：

```ts
Ack<{ device: DeviceDetailDto }>
```

#### `device:scan`

客户端：

```ts
{ deviceId: string }
```

Ack：

```ts
Ack
```

服务器事件：

- `devices:snapshot`：`DeviceDto[]`
- `device:status`：`DeviceDto`
- `device:runtimes`：`{ deviceId: string; runtimes: RuntimeDto[] }`

延后的 device commands：

- `device:rename`：保留给 device management。
- `device:delete`：如果 target UX 需要 device removal，则保留。
- `device:select-directory`：保留给 custom agent setup。

### Agents

#### `agents:subscribe`

客户端：

```ts
{ teamId: string }
```

Ack：

```ts
Ack<{ agents: AgentDto[] }>
```

#### `agent:create`

客户端：

```ts
{
  teamId: string;
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

Ack：

```ts
Ack<{ agent: AgentDto }>
```

#### `agent:publish`

客户端：

```ts
{ agentId: string; teamId: string }
```

Ack：

```ts
Ack<{ agent: AgentDto }>
```

#### `agent:unpublish`

客户端：

```ts
{ agentId: string; teamId: string }
```

Ack：

```ts
Ack<{ agent: AgentDto }>
```

服务器事件：

- `agents:snapshot`：`AgentDto[]`
- `agent:status`：`AgentDto`
- `agents:discovered`：`{ deviceId: string; runtimes: RuntimeDto[]; agents: DiscoveredAgentDto[] }`

延后的 agent commands：

- `agent:update-config`：替换当前 `agent:config:update`。
- `agent:delete`：在 delete semantics 指定后，保留给 custom-agent management。
- `agent:metrics`：保留给 metrics slice。

有意不保留的 commands：

- `agent:update`：过于宽泛；替换为 `agent:publish`、`agent:unpublish` 与 `agent:update-config`。
- `agent:custom:list`：合并进 filtered agent list 或 device detail。

### Channels 与 Messages

#### `channel:create`

客户端：

```ts
{
  userId: string;
  teamId: string;
  name: string;
  title?: string;
  visibility: "public" | "private";
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}
```

Ack：

```ts
Ack<{ channel: ChannelDto }>
```

#### `channel:update`

客户端：

```ts
{
  userId: string;
  teamId: string;
  channelId: string;
  name?: string;
  title?: string;
  visibility?: "public" | "private";
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}
```

Ack：

```ts
Ack<{ channel: ChannelDto }>
```

规则：

- 非默认频道只允许 creator 更新 settings。
- 默认 `all` 频道只允许 creator 更新 `title`。

#### `channel:add-member`

客户端：

```ts
{
  userId: string;
  teamId: string;
  channelId: string;
  memberUserId: string;
}
```

Ack：

```ts
Ack<{ channel: ChannelDto }>
```

#### `channel:remove-member`

客户端：

```ts
{
  userId: string;
  teamId: string;
  channelId: string;
  memberUserId: string;
}
```

Ack：

```ts
Ack<{ channel: ChannelDto }>
```

#### `channel:add-agent`

客户端：

```ts
{
  userId: string;
  teamId: string;
  channelId: string;
  agentId: string;
}
```

Ack：

```ts
Ack<{ channel: ChannelDto }>
```

#### `channel:remove-agent`

客户端：

```ts
{
  userId: string;
  teamId: string;
  channelId: string;
  agentId: string;
}
```

Ack：

```ts
Ack<{ channel: ChannelDto }>
```

#### `channel:members`

客户端：

```ts
{
  userId: string;
  teamId: string;
  channelId: string;
}
```

Ack：

```ts
Ack<{ humanMemberIds: string[]; agentMemberIds: string[] }>
```

#### `channels:subscribe`

客户端：

```ts
{ teamId: string }
```

Ack：

```ts
Ack<{ channels: ChannelDto[] }>
```

#### `channel:join`

客户端：

```ts
{ channelId: string; limit?: number }
```

Ack：

```ts
Ack<{ channel: ChannelDto; messages: MessageDto[] }>
```

#### `message:send`

客户端：

```ts
{
  channelId: string;
  body: string;
  clientMessageId?: string;
  threadId?: string;
  artifactIds?: string[];
}
```

Ack：

```ts
Ack<{ message: MessageDto; dispatches: DispatchDto[] }>
```

服务器事件：

- `channels:snapshot`：`ChannelDto[]`
- `channel:message`：`MessageDto`
- `message:dispatch-status`：`DispatchDto`

延后的 channel、DM 与 message commands：

- `channel:leave`：仅当 hidden/left channel UX 保留时保留。
- `channel:archive`：延后；需要产品决策。
- `channel:delete`：延后；需要产品决策。
- `channel:stop-agents`：替换为 dispatch cancellation commands。
- `dm:start`：保留。
- `dm:list`：保留。
- `message:search`：保留给 search slice。

### Tasks（延后切片）

Task commands 仅保留产品方向。不要在第一切片实现这些 commands，也不要在 task slice 开始前定义 `TaskDto`。

#### `task:list`

客户端：

```ts
{ teamId: string; channelId?: string }
```

Ack：

```ts
Ack<{ tasks: TaskDto[] }>
```

#### `task:create`

客户端：

```ts
{
  teamId: string;
  title: string;
  description?: string;
  channelId?: string;
  assigneeId?: string;
  tags?: string[];
}
```

Ack：

```ts
Ack<{ task: TaskDto }>
```

#### `task:update`

客户端：

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

Ack：

```ts
Ack<{ task: TaskDto }>
```

服务器事件：

- `tasks:snapshot`：`TaskDto[]`
- `task:updated`：`TaskDto`

延后的 task commands：

- `task:delete`：保留。
- `task:reorder`：除非 dedicated command 仍更清晰，否则合并进 `task:update`。

## 从目标协议中移除

当前实现有 admin events，但旧产品尚未发布，且 admin surface 还不足以被带入。

初始目标协议中不要包含：

- `admin:list-users`
- `admin:delete-user`
- `admin:list-teams`
- `admin:delete-team`
- `admin:list-devices`
- `admin:transfer-device-owner`
- `admin:list-agents`
- `admin:delete-agent`

这些只能在后续具备显式 role、permission 与 audit requirements 后重新引入。

## `/agent` Namespace

Daemon clients 连接到 `/agent`。

Auth modes：

- Device token。
- Transitional user token 仅在 invite completion 或 local development 明确允许时使用。

### Device 注册

#### `device:hello`

Daemon：

```ts
{
  deviceId: string;
  teamId: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: Record<string, unknown>;
}
```

Ack：

```ts
Ack<{ device: DeviceDto; scanIntervalMs: number }>
```

### Runtime 与 Agent Discovery

#### `device:runtimes`

Daemon：

```ts
{ deviceId: string; teamId: string; runtimes: RuntimeDto[] }
```

Ack：

```ts
Ack
```

#### `agent:register-batch`

Daemon：

```ts
{
  deviceId: string;
  teamId: string;
  agents: DiscoveredAgentDto[];
}
```

Ack：

```ts
Ack<{ agents: AgentDto[] }>
```

服务器事件：

- `device:scan-requested`：`{ requestId: string }`
- `dispatch:request`：`DispatchRequestDto`
- `dispatch:cancel`：`{ dispatchId: string; reason?: string }`

### Dispatch 结果

#### `dispatch:accepted`

Daemon：

```ts
{ dispatchId: string }
```

Ack：

```ts
Ack
```

#### `dispatch:result`

Daemon：

```ts
{
  dispatchId: string;
  agentId: string;
  body: string;
  artifactIds?: string[];
  usage?: AgentUsageDto;
}
```

Ack：

```ts
Ack
```

#### `dispatch:error`

Daemon：

```ts
{
  dispatchId: string;
  agentId: string;
  error: string;
  retryable?: boolean;
}
```

Ack：

```ts
Ack
```

## DTO 说明

DTOs 不应直接暴露 database rows。

### 第一切片 DTOs

这些 DTOs 定义在 `docs/contracts-dto.md` 中，是第一切片必需项：

- `UserDto`
- `TeamDto`
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

### 后续切片 DTOs

这些 DTO families 在第一切片 contract 中有意不定义：

- `ArtifactDto`
- `TaskDto`
- `WorkspaceRunDto`
- `InviteDto`
- `JoinLinkDto`

Protocol 可以提到 later-slice commands 来保留产品方向，但实现不应在对应切片开始前发明这些 DTOs。

## 兼容性说明

当前实现使用了几个较旧的 event names。只有确有需要时，重写版才可以支持临时 adapter；目标协议应使用上面的名称，并避免保留偶然 aliases。
