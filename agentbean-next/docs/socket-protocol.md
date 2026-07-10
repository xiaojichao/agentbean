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
- `BAD_REQUEST`
- `FORBIDDEN`
- `NOT_FOUND`
- `VALIDATION_ERROR`
- `CONFLICT`
- `DEVICE_OFFLINE`
- `AGENT_OFFLINE`
- `DISPATCH_TIMEOUT`
- `INVITE_INVALID`
- `INVITE_EXPIRED`
- `INVITE_ALREADY_USED`
- `INTERNAL_ERROR`

## `/web` Namespace

Browser clients 连接到 `/web`。

Auth modes：

- Anonymous：用于 login、signup、invite validation 与 device login screens。
- User session token：用于 normal app operations。Socket.IO client 可以通过 `auth.token` 传入 session token；server 会用 `auth:whoami` 同一套 token 校验逻辑派生 `userId`。当前实现仍临时接受 payload 中显式 `userId` 作为兼容路径，但带 token 的 socket 会以 session user 覆盖 payload user。

### Auth

#### `auth:login`

客户端：

```ts
{ username: string; password: string; joinCode?: string }
```

Ack：

```ts
Ack<{ token: string; user: UserDto; currentTeam: TeamDto; joinedTeam?: TeamDto }>
```

#### `auth:register`

客户端：

```ts
{ username: string; password: string; teamName: string; joinCode?: string }
```

Ack：

```ts
Ack<{ token: string; user: UserDto; currentTeam: TeamDto; defaultChannel: ChannelDto; joinedTeam?: TeamDto }>
```

带 `joinCode` 时的行为：

- 该 code 只表示 user join link，不表示 device invite。
- `joinCode` 可用于注册后加入受邀 team，也可用于已存在用户登录时加入受邀 team。
- 消费成功后，server 将用户加入目标 team，并把 `users.current_team_id` 切换到该 team。
- 注册仍会创建用户自己的 private team 与默认 `all` channel；受邀 team 会作为 `joinedTeam` 返回。
- 无效、过期、已耗尽的 code 分别返回 `INVITE_INVALID`、`INVITE_EXPIRED`、`INVITE_ALREADY_USED`。

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

#### Join invite management（协议已落地，UI 待补）

- `join:list`：invite management 用途。已进入 Next shared event constants（`packages/contracts/src/socket.ts`），并由 server-next handler / usecase / repository 实现列表能力；仅 web-next 客户端绑定与 preview 邀请管理 UI 仍待补。
- `join:revoke`：invite management 用途。已进入 Next shared event constants，并由 server-next handler / usecase / repository 实现撤销能力；仅 web-next 客户端绑定与 preview 邀请管理 UI 仍待补。

### Teams

#### `team:list`

Ack：

```ts
Ack<{ teams: TeamDto[]; currentTeamId?: string }>
```

#### `team:create`

客户端：

```ts
{ userId?: string; name: string }
```

Ack：

```ts
Ack<{ team: TeamDto; defaultChannel: ChannelDto }>
```

行为：

- 只创建 `private` team。
- 创建者自动成为 `owner`。
- 同时创建默认 public `all` channel。
- 创建成功后持久化切换 `users.current_team_id` 到新 team。

#### `team:switch`

客户端：

```ts
{ userId?: string; teamId: string }
```

Ack：

```ts
Ack<{ currentTeam: TeamDto }>
```

行为：

- 只允许切换到当前用户已经加入的 team。
- 非成员切换返回 `FORBIDDEN`。
- 成功后更新 `users.current_team_id`。

服务器事件：

- `teams:snapshot`：`TeamDto[]`

延后的 team commands：

- `team:update`：保留给 settings。
- `team:delete`：如果 product UX 需要 owner delete，则保留。

### Admin Dashboard

这些事件服务 Web Next dashboard 的已迁移 admin 页面，权限为全局 `UserDto.role === 'admin'`，不同于 team owner/admin 权限。

#### `admin:list-teams`

Ack：

```ts
Ack<{ teams: Array<TeamDto & { members: HumanMemberDto[] }> }>
```

#### `admin:delete-team`

客户端：

```ts
{ teamId: string }
```

Ack：

```ts
Ack<{}>
```

#### `admin:list-users`

Ack：

```ts
Ack<{ users: Array<UserDto & { createdAt: UnixMs }> }>
```

#### `admin:list-devices`

Ack：

```ts
Ack<{ devices: Array<DeviceDto & {
  userId: string;
  userName: string;
  teamName: string;
  agentCount: number;
  agents: AdminAgentDto[];
}> }>
```

#### `admin:list-agents`

Ack：

```ts
Ack<{ agents: AdminAgentDto[] }>
```

`AdminAgentDto` 是 dashboard projection：保留 `AgentDto` 的 `primaryTeamId` 与 `visibleTeamIds`，并补充 `primaryTeamName`、`ownerName`、`userName`、`deviceName`、`deviceUserId` 与 `deviceUserName`。

#### `admin:transfer-device-owner`

客户端：

```ts
{ deviceId: string; userId: string }
```

Ack：

```ts
Ack<{ device: AdminDeviceDto }>
```

行为：

- Authenticated socket 的 session user 是当前管理员；payload 的 `userId` 是目标 owner，不能被 auth 注入覆盖。
- 目标 user 必须仍是该 device 所属 team 的成员。
- 成功后更新 device owner，并同步更新该 device 下 Agent 的 `ownerId`。

### Join Links

#### `join:create`

客户端：

```ts
{ userId?: string; teamId: string; expiresAt?: UnixMs; maxUses?: number }
```

Ack：

```ts
Ack<{ link: JoinLinkDto; team: TeamDto }>
```

行为：

- 只创建 user join link，不创建 device invite。
- Authenticated socket session 下允许省略 `userId`。
- 只有目标 team 的 member 可以创建 join link；非成员返回 `FORBIDDEN`。
- 默认 `maxUses` 为 1。

#### `join:validate`

客户端：

```ts
{ code: string }
```

Ack：

```ts
Ack<{ link: JoinLinkDto; team: TeamDto }>
```

行为：

- Anonymous socket session 可调用。
- 返回 link 目标 team 的展示信息，便于注册/登录前预览。
- 无效、过期、已耗尽的 code 分别返回 `INVITE_INVALID`、`INVITE_EXPIRED`、`INVITE_ALREADY_USED`。

### Device Invites

#### `device-invite:create`

客户端：

```ts
{ userId?: string; teamId: string; profileId?: string; expiresAt?: UnixMs }
```

Ack：

```ts
Ack<{ invite: DeviceInviteDto; team: TeamDto }>
```

行为：

- 显式替换旧 `invite:create` 中 `purpose: "device"` 的分支。
- Authenticated socket session 下允许省略 `userId`。
- 只有目标 team member 可以创建设备邀请；非成员返回 `FORBIDDEN`。

#### `device-invite:complete`

客户端：

```ts
{ userId?: string; code: string; serverUrl?: string }
```

Ack：

```ts
Ack<{ invite: DeviceInviteDto; team: TeamDto; credentials: DeviceInviteCredentialsDto }>
```

行为：

- 显式替换旧 browser `auth:device-login` token delivery。
- 只有邀请目标 team member 可以完成邀请。
- 完成成功后，server 会把 `credentials` 通过 `/agent` 的 `device-invite:credentials` 发送给正在等待同一 code 的 daemon socket。
- 已完成、过期或无效 code 分别返回稳定 invite error code。

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
{ userId?: string; teamId: string }
```

Ack：

```ts
Ack<{ devices: DeviceDto[] }>
```

服务器行为：

- `device:list` 同时作为 web client 的 device snapshot subscription 入口。
- Subscribe 成功前，server 会确认 session 派生或 payload 兼容字段中的 `userId` 是该 team 的 member。
- Subscribe 成功后立即向该 socket 发送 `devices:snapshot`。
- Daemon `device:hello` 改变 device projection 后，server 会刷新同 team active subscribers 的 `devices:snapshot`。
- Daemon `device:runtimes` 成功后，server 会向同 team active subscribers 发送 `device:runtimes`。

#### `device:get`

客户端：

```ts
{ userId?: string; deviceId: string }
```

Ack：

```ts
Ack<{ device: DeviceDetailDto }>
```

服务器行为：

- `device:get` 成功前，server 会根据 device 所属 team 确认 session 派生或 payload 兼容字段中的 `userId` 是 team member。
- `DeviceDetailDto` 包含 device projection、该 device 的 runtimes，以及对该 team 可见且绑定到该 device 的 agents。

#### `device:agents:list`

客户端：

```ts
{ teamId: string; deviceId: string }
```

Ack：

```ts
Ack<{ agents: DeviceAgentListDto[]; runtimes: RuntimeDto[] }>
```

这是 Team-scoped 查询；Server 同时校验 `teamId` membership 与 Device 的真实 Team 归属。

#### `device:scan`

客户端：

```ts
{ userId?: string; deviceId: string }
```

Ack：

```ts
Ack<{ request: { requestId: string; deviceId: string } }>
```

服务器行为：

- `device:scan` 成功前，Server 根据 Device record 解析归属 Team，并确认调用者是 Device owner 或系统 admin。
- 目标 device 必须处于 `online` 状态，否则返回 `DEVICE_OFFLINE`。
- 成功后，server 只向该 device 当前绑定的 daemon socket 发送 `device:scan-requested`。

#### `device:select-directory`

客户端：`{ deviceId: string }`。Server 先按 `deviceId` 读取 Device、解析归属 Team 并校验访问权限，再把请求转发给 owning Device 的 daemon。

#### `device:rename`

客户端：`{ deviceId: string; name: string }`。

#### `device:delete`

客户端：`{ deviceId: string }`。

这些都是 device-bound 操作，客户端不发送 `teamId`。Server 从 Device record 解析 Team：get/select-directory 要求 Team 访问权，scan/rename/delete 要求 Device owner 或系统 admin 权限。

服务器事件：

- `devices:snapshot`：`DeviceDto[]`
- `device:status`：`DeviceDto`
- `device:runtimes`：`{ deviceId: string; runtimes: RuntimeDto[] }`

### Agents

#### `agents:subscribe`

客户端：

```ts
{ userId?: string; teamId: string }
```

Ack：

```ts
Ack<{ agents: AgentDto[] }>
```

服务器行为：

- Subscribe 成功前，server 会确认 session 派生或 payload 兼容字段中的 `userId` 是该 team 的 member。
- Subscribe 成功后立即向该 socket 发送 `agents:snapshot`。
- Daemon agent batch 或 dispatch result/error 改变 agent projection 后，server 会刷新同 team active subscribers 的 `agents:snapshot`。

#### `agent:create`

客户端：

```ts
{
  userId?: string;
  teamId: string;
  deviceId: string;
  runtimeId?: string;
  name: string;
  description?: string;
  adapterKind?: AdapterKind;
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

服务器行为：

- `agent:create` 成功前，server 会根据 `teamId` 与 `deviceId` 确认 session 派生或 payload 兼容字段中的 `userId` 是 team member。
- 如果提供 `runtimeId`，该 runtime 必须属于同一 device/team 且 `installed: true`。
- 创建出的 visible product agent 必须是 `source: "custom"`，scanner 不得自动创建 visible agent。
- Ack 与后续 `agents:snapshot` 只暴露 `envKeys`，不得返回 raw `env` values。

#### `agent:publish`

客户端：

```ts
{
  userId?: string;
  teamId: string;
  agentId: string;
  targetTeamId: string;
}
```

Ack：

```ts
Ack<{ agent: AgentDto }>
```

服务器行为：

- `teamId` 必须是 agent 的 `primaryTeamId`；操作者必须能管理该 agent。
- 操作者还必须是 `targetTeamId` 的 member，避免把 agent 投影到自己不可见的 team。
- 成功后，server 刷新 source team 与 target team active subscribers 的 `agents:snapshot`。

#### `agent:unpublish`

客户端：

```ts
{
  userId?: string;
  teamId: string;
  agentId: string;
  targetTeamId: string;
}
```

Ack：

```ts
Ack<{ agent: AgentDto }>
```

服务器行为：

- `targetTeamId` 不得是 agent 的 primary team。
- 成功后，server 从 target team projection 移除该 agent，并清理 target team channels 中的该 agent membership。
- Source team 与 target team subscribers 都会收到新的 `agents:snapshot`。

#### `agent:update-config`

客户端：

```ts
{
  userId?: string;
  teamId: string;
  agentId: string;
  runtimeId?: string;
  name?: string;
  description?: string;
  adapterKind?: AdapterKind;
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

服务器行为：

- 只允许 `source: "custom"` 的 agent。
- 操作者必须是 agent owner，或 agent primary team 的 owner/admin。
- 如果提供 `runtimeId`，server 会重新绑定该 runtime 的 device/adapter/command/cwd；runtime 必须属于 agent primary team 且 `installed: true`。
- 如果提供 `env`，server 替换 execution config 中的 raw env；ack 与 `agents:snapshot` 仍只暴露 `envKeys`。

#### `agent:delete`

客户端：

```ts
{
  userId?: string;
  teamId: string;
  agentId: string;
}
```

Ack：

```ts
Ack<{ agent: AgentDto }>
```

服务器行为：

- 第一版只允许删除 custom agent。
- 操作者必须是 agent owner，或 agent primary team 的 owner/admin。
- 删除是 server-side tombstone：agent 不再出现在 visible list，channel agent membership 被清理，但既有 messages/dispatches 的 agent id 历史不被重写。

服务器事件：

- `agents:snapshot`：`AgentDto[]`
- `agent:status`：`AgentDto`
- `agents:discovered`：`{ deviceId: string; runtimes: RuntimeDto[]; agents: DiscoveredAgentDto[] }`

延后的 agent commands：

- `agent:metrics`：保留给 metrics slice。

有意不保留的 commands：

- `agent:update`：过于宽泛；替换为 `agent:publish`、`agent:unpublish` 与 `agent:update-config`。
- `agent:custom:list`：合并进 filtered agent list 或 device detail。

### Channels 与 Messages

#### `channel:create`

客户端：

```ts
{
  userId?: string;
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
  userId?: string;
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
  userId?: string;
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
  userId?: string;
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
  userId?: string;
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
  userId?: string;
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
  userId?: string;
  teamId: string;
  channelId: string;
}
```

Ack：

```ts
Ack<{
  humanMemberIds: string[];
  agentMemberIds: string[];
  humans: HumanMemberDto[];
  agents: AgentDto[];
}>
```

#### `channels:subscribe`

客户端：

```ts
{ userId?: string; teamId: string }
```

Ack：

```ts
Ack<{ channels: ChannelDto[] }>
```

服务器行为：

- Subscribe 成功后立即向该 socket 发送 `channels:snapshot`。
- Channel membership 变更后，server 会按每个 active subscription 的 `{ userId, teamId }` 重新计算可见 channel list，并分别发送 `channels:snapshot`。不得向整个 team 广播同一份 private-channel snapshot。

#### `channel:join`

客户端：

```ts
{ channelId: string; limit?: number }
```

Ack：

```ts
Ack<{ channel: ChannelDto; messages: MessageDto[] }>
```

#### `dm:start`

客户端：

```ts
{ userId?: string; teamId: string; agentId: string }
```

Ack：

```ts
Ack<{ dm: DmChannelDto }>
```

服务器行为：

- `userId` 必须是 `teamId` 的 member。
- `agentId` 必须对该 team 可见。
- 如果该 user 与 agent 已有 direct channel，则复用既有 channel。
- 新建 DM 使用 `kind: "direct"`、`visibility: "private"`、`dmTargetAgentId = agentId`。

#### `dm:list`

客户端：

```ts
{ userId?: string; teamId: string }
```

Ack：

```ts
Ack<{ dms: DmChannelDto[] }>
```

#### `dm:snapshot`

客户端：

```ts
{ userId?: string; teamId: string; channelId: string; limit?: number }
```

Ack：

```ts
Ack<{ dm: DmChannelDto; messages: MessageDto[] }>
```

服务器行为：

- 只允许该 direct channel 的 human member snapshot。
- 返回同 channel 的 message history；thread filtering 由 message/dispatch flow 使用 `threadId` 表达。

#### `message:send`

客户端：

```ts
{
  userId?: string;
  teamId: string;
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

说明：

- 带 `auth.token` 的 web socket 会从 authenticated socket session 派生 `userId`；payload 中的 `userId` 只作为临时兼容路径保留。
- `teamId` 仍由 payload 提供，用于 team/channel gate 与路由；后续 team switch 完成后可再评估是否从 current team 派生。
- `senderKind` 与 `senderId` 仍由 server 派生，client 不应发送 sender identity。
- direct channel 中的 message 固定 dispatch 给 `dmTargetAgentId`；普通 channel 中无 mention message 仍 fallback 到第一个 online agent。
- `threadId` 为空时 server 将当前 message 作为 thread root；有值时 server 将 message 作为该 thread reply。
- 成功后 server 会向可见该 channel 或 direct channel 的 web subscribers 广播已持久化的 human `channel:message`；agent reply 后续仍由 dispatch result 路径广播。

#### `message:search`

客户端：

```ts
{ userId?: string; teamId: string; query: string; limit?: number }
```

Ack：

```ts
Ack<{ messages: MessageDto[] }>
```

说明：

- 带 `auth.token` 的 web socket 会从 authenticated socket session 派生 `userId`；payload 中的 `userId` 只作为临时兼容路径保留。
- 搜索当前用户在该 team 内可见的普通 channels 与 direct messages（遵守 agent 可见性规则）。第一版（#188）只覆盖普通 channels；后续（#272）补齐 DM 搜索，确保删除或隐藏的 agent DM 不会泄漏历史消息。
- `query` 至少 2 个字符。
- Server 使用 simple DB search；不引入 full-text indexing、ranking 或 saved filters。

#### `dispatch:cancel`

客户端：

```ts
{ userId: string; dispatchId: string }
```

Ack：

```ts
Ack<{ dispatch: DispatchDto }>
```

服务器行为：

- `dispatch:cancel` 成功前，server 会确认 `userId` 是该 dispatch 所属 team 的 member。
- 只有 `queued`、`sent`、`accepted`、`running` 状态会被转为 `cancelled`；已经 terminal 的 dispatch 不会被回退。
- 成功后 server 会向 web clients 广播 `message:dispatch-status`。
- 如果 dispatch 对应的 agent 绑定了当前连接的 device socket，server 会向该 daemon 发送 `dispatch:cancel`；否则向 `/agent` namespace 广播。
- `server-next` runtime 会定期调用 dispatch timeout 调度，把超时 pending dispatch 标记为 `timed_out` 并广播 `message:dispatch-status`。

服务器事件：

- `channels:snapshot`：`ChannelDto[]`
- `channel:message`：`MessageDto`
- `message:dispatch-status`：`DispatchDto`

延后的 channel 与 message commands：

- `channel:leave`：仅当 hidden/left channel UX 保留时保留。
- `channel:archive`：延后；需要产品决策。
- `channel:delete`：延后；需要产品决策。
- `channel:stop-agents`：替换为 dispatch cancellation commands。

### Tasks（第一版）

Task commands 第一版已落地到 server-next usecase/repository/socket binding，并在 web-next preview 提供轻量创建与状态更新入口。

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

服务器行为：

- 带 `auth.token` 的 web socket 会从 authenticated socket session 派生 `userId`；payload 中的 `userId` 只作为临时兼容路径保留。
- `task:list` 默认只返回 global tasks 与当前用户可见 channels/DMs 关联 tasks；指定 `channelId` 时必须先通过 channel visibility 授权。
- `task:create` 需要 non-empty title；`channelId` 必须是当前用户可见 channel/DM。
- `assigneeId` 第一版可以是 team human member，或当前 team 可见 agent。
- `task:update` 可以更新 title/description/status/assignee/channel/tags/sortOrder；更新已有 private channel task 前，当前用户也必须能看见该 task 所属 channel。
- `task:delete` 删除当前用户可见 task，并对非成员、不可见 channel task、已删除 task 返回稳定 failure ack。
- `task:reorder` 作为独立 command 保留，更新 `sortOrder` 并校验有限数值输入。

## `/agent` Namespace

Daemon clients 连接到 `/agent`。

Auth modes：

- Device token。
- Transitional user token 仅在 invite completion 或 local development 明确允许时使用。

### Device Invite Onboarding

#### `device-invite:wait`

Daemon：

```ts
{ code: string; machineId?: string; profileId?: string; hostname?: string }
```

Ack：

```ts
Ack<{ invite: DeviceInviteDto; team: TeamDto }>
```

服务器事件：

- `device-invite:credentials`：`DeviceInviteCredentialsDto`

行为：

- Daemon 在没有手工 `teamId`/`ownerId` 配置时，用 invite code 连接 `/agent` 并调用该事件。
- Server 校验 code 后记录等待中的 daemon socket；browser 完成邀请后将凭据投递给同一 socket。
- Daemon 收到凭据后用 `device:hello` 携带 `token` 注册 device。

### Device 注册

#### `device:hello`

Daemon：

```ts
{
  token?: string;
  teamId?: string;
  ownerId?: string;
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

行为：

- invite onboarding 路径使用 `token` 推导 `teamId` 与 `ownerId`。
- 兼容路径仍允许显式 `teamId`/`ownerId`，用于本地开发和迁移期配置。
- `machineId + profileId` 用于同一 daemon profile 的重复 hello 调和。

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

- `device:scan-requested`：`{ requestId: string; deviceId: string }`
- `dispatch:request`：`DispatchRequestDto`
- `dispatch:cancel`：`{ dispatchId: string; reason?: string }`

Daemon 行为：

- 收到匹配当前 device 的 `device:scan-requested` 后，daemon 会重新扫描并发送 `device:runtimes` 与 `agent:register-batch`。
- 收到不匹配当前 device 的 `device:scan-requested` 时，daemon 不应触发扫描或上报。
- custom agent 的 `dispatch:request` 必须由 server 定向发送给 `DispatchRequestDto.deviceId` 对应的 daemon socket；不得向整个 `/agent` namespace 广播 raw `customAgent.env`。
- 收到 `dispatch:cancel` 后，daemon 会记录取消请求；如果对应 dispatch 正在执行，后续 late result/error 不再回传。

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
- `TaskDto`

### 后续切片 DTOs

这些 DTO families 已在后续切片中逐步定义；若继续新增，必须同步 `docs/contracts-dto.md`：

- `ArtifactDto`
- `WorkspaceRunDto`
- `InviteDto`
- `JoinLinkDto`

Protocol 可以提到 later-slice commands 来保留产品方向，但实现不应在对应切片开始前发明这些 DTOs。

## 兼容性说明

当前实现使用了几个较旧的 event names。只有确有需要时，重写版才可以支持临时 adapter；目标协议应使用上面的名称，并避免保留偶然 aliases。
