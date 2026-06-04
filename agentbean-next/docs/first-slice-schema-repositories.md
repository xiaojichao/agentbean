# 第一切片 Schema 与 Repositories

本文档定义 AgentBean Next 第一切片的新 SQLite schema 与 repository interfaces。

它不是旧 schema 的 migration。旧 SQLite files 不需要 compatibility。

## 存储范围

使用两个 database scopes：

- Global DB：accounts、teams、memberships、devices、runtimes、agents、publications。
- Team DB：channels、channel memberships、messages、dispatches。

建议文件：

```text
apps/server-next/src/infra/sqlite/migrations/global/0001_first_slice.sql
apps/server-next/src/infra/sqlite/migrations/team/0001_first_slice.sql
```

## 全局 Schema

```sql
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  username           TEXT NOT NULL UNIQUE,
  email              TEXT UNIQUE,
  display_name       TEXT,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'user',
  current_team_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE teams (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  description TEXT,
  visibility  TEXT NOT NULL DEFAULT 'private',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id),
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL,
  owner_id       TEXT NOT NULL,
  machine_id     TEXT,
  profile_id     TEXT,
  hostname       TEXT,
  status         TEXT NOT NULL DEFAULT 'offline',
  daemon_version TEXT,
  system_info    TEXT,
  last_seen_at   INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE device_runtimes (
  id                     TEXT PRIMARY KEY,
  device_id              TEXT NOT NULL,
  team_id             TEXT NOT NULL,
  adapter_kind           TEXT NOT NULL,
  name                   TEXT NOT NULL,
  installed              INTEGER NOT NULL DEFAULT 0,
  command                TEXT,
  normalized_command_key TEXT,
  cwd                    TEXT,
  normalized_cwd_key     TEXT,
  version                TEXT,
  last_seen_at           INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
);

CREATE TABLE agents (
  id                 TEXT PRIMARY KEY,
  primary_team_id TEXT NOT NULL,
  name               TEXT NOT NULL,
  normalized_name    TEXT NOT NULL,
  role               TEXT,
  description        TEXT,
  adapter_kind       TEXT NOT NULL,
  category           TEXT NOT NULL,
  source             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'offline',
  owner_id           TEXT,
  device_id          TEXT,
  command            TEXT,
  args_json          TEXT,
  cwd                TEXT,
  env_json           TEXT,
  last_seen_at       INTEGER NOT NULL,
  last_error         TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  FOREIGN KEY (primary_team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL
);

CREATE TABLE agent_identity_links (
  identity_key TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

CREATE TABLE agent_publications (
  agent_id     TEXT NOT NULL,
  team_id   TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, team_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE CASCADE
);
```

### 全局索引

```sql
CREATE INDEX idx_users_current_team ON users(current_team_id);
CREATE INDEX idx_team_members_user ON team_members(user_id);
CREATE INDEX idx_devices_team ON devices(team_id);
CREATE INDEX idx_devices_machine_profile ON devices(machine_id, profile_id);
CREATE INDEX idx_device_runtimes_device ON device_runtimes(device_id);
CREATE INDEX idx_device_runtimes_identity ON device_runtimes(team_id, device_id, adapter_kind, normalized_command_key, normalized_cwd_key);
CREATE INDEX idx_agents_primary_team ON agents(primary_team_id);
CREATE INDEX idx_agents_device ON agents(device_id);
CREATE INDEX idx_agents_identity_lookup ON agents(primary_team_id, device_id, adapter_kind, normalized_name);
CREATE INDEX idx_agent_publications_team ON agent_publications(team_id);
```

## Team Schema

每个 team DB 都只服务于一个 team。关键 rows 仍存储 `team_id`，因为 DTOs 与 tests 不应依赖隐式 file location。

```sql
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  team_id  TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'channel',
  name        TEXT NOT NULL,
  description TEXT,
  visibility  TEXT NOT NULL DEFAULT 'public',
  created_by  TEXT,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER,
  dm_target_agent_id TEXT
);

CREATE TABLE channel_human_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE channel_agent_members (
  channel_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  team_id        TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  thread_id         TEXT,
  sender_kind       TEXT NOT NULL,
  sender_id         TEXT,
  sender_name       TEXT,
  body              TEXT NOT NULL,
  client_message_id TEXT,
  meta_json         TEXT,
  created_at        INTEGER NOT NULL
);

CREATE TABLE dispatches (
  id            TEXT PRIMARY KEY,
  team_id    TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  device_id     TEXT,
  status        TEXT NOT NULL,
  request_id    TEXT NOT NULL UNIQUE,
  prompt        TEXT NOT NULL,
  history_json  TEXT NOT NULL DEFAULT '[]',
  error_code    TEXT,
  error_message TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  accepted_at   INTEGER,
  completed_at  INTEGER
);
```

### Team 索引

```sql
CREATE INDEX idx_channels_team_created ON channels(team_id, created_at);
CREATE INDEX idx_channels_team_kind ON channels(team_id, kind);
CREATE INDEX idx_channel_human_members_user ON channel_human_members(user_id);
CREATE INDEX idx_channel_agent_members_agent ON channel_agent_members(agent_id);
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX idx_messages_client_id ON messages(channel_id, client_message_id);
CREATE INDEX idx_dispatches_message ON dispatches(message_id);
CREATE INDEX idx_dispatches_agent_status ON dispatches(agent_id, status);
CREATE INDEX idx_dispatches_request_id ON dispatches(request_id);
```

## Repository 接口

这些 interfaces 面向 use case。它们不会把 raw rows 暴露为 public application boundary。

```ts
export interface UserRepository {
  create(input: CreateUserInput): Promise<UserRecord>;
  getById(id: ID): Promise<UserRecord | null>;
  getByUsername(username: string): Promise<UserRecord | null>;
  setCurrentTeam(userId: ID, teamId: ID): Promise<void>;
}

export interface TeamRepository {
  create(input: CreateTeamInput): Promise<TeamRecord>;
  getById(id: ID): Promise<TeamRecord | null>;
  getByPath(path: string): Promise<TeamRecord | null>;
  listForUser(userId: ID): Promise<TeamRecord[]>;
  addMember(input: AddTeamMemberInput): Promise<void>;
  isMember(teamId: ID, userId: ID): Promise<boolean>;
  listMembers(teamId: ID): Promise<HumanMemberRecord[]>;
}

export interface DeviceRepository {
  upsertHello(input: DeviceHelloRecord): Promise<DeviceRecord>;
  getById(id: ID): Promise<DeviceRecord | null>;
  findByMachineProfile(machineId: string, profileId: string): Promise<DeviceRecord | null>;
  setStatus(input: SetDeviceStatusInput): Promise<void>;
  listByTeam(teamId: ID): Promise<DeviceRecord[]>;
}

export interface RuntimeRepository {
  replaceForDevice(input: ReplaceDeviceRuntimesInput): Promise<RuntimeRecord[]>;
  listByDevice(deviceId: ID): Promise<RuntimeRecord[]>;
}

export interface AgentRepository {
  getById(id: ID): Promise<AgentRecord | null>;
  getByIdentityKey(identityKey: string): Promise<AgentRecord | null>;
  upsertFromReport(input: UpsertAgentFromReportInput): Promise<AgentRecord>;
  createCustom(input: CreateCustomAgentInput): Promise<AgentRecord>;
  updateStatus(input: UpdateAgentStatusInput): Promise<void>;
  linkIdentity(input: LinkAgentIdentityInput): Promise<void>;
  listVisibleInTeam(teamId: ID): Promise<AgentRecord[]>;
  listByDevice(deviceId: ID): Promise<AgentRecord[]>;
}

export interface ChannelRepository {
  create(input: CreateChannelInput): Promise<ChannelRecord>;
  getById(channelId: ID): Promise<ChannelRecord | null>;
  listForUser(teamId: ID, userId: ID): Promise<ChannelRecord[]>;
  addHumanMember(input: AddChannelHumanMemberInput): Promise<void>;
  addAgentMember(input: AddChannelAgentMemberInput): Promise<void>;
  listAgentMembers(channelId: ID): Promise<ID[]>;
  listHumanMembers(channelId: ID): Promise<ID[]>;
}

export interface MessageRepository {
  append(input: AppendMessageInput): Promise<MessageRecord>;
  getById(messageId: ID): Promise<MessageRecord | null>;
  listByChannel(channelId: ID, limit: number): Promise<MessageRecord[]>;
  listThreadHistory(threadId: ID, limit: number): Promise<MessageRecord[]>;
}

export interface DispatchRepository {
  create(input: CreateDispatchInput): Promise<DispatchRecord>;
  getById(id: ID): Promise<DispatchRecord | null>;
  getByRequestId(requestId: string): Promise<DispatchRecord | null>;
  markAccepted(input: MarkDispatchAcceptedInput): Promise<void>;
  markSucceeded(input: MarkDispatchSucceededInput): Promise<void>;
  markFailed(input: MarkDispatchFailedInput): Promise<void>;
  listPendingOlderThan(timestamp: UnixMs): Promise<DispatchRecord[]>;
}
```

## 事务边界

这些操作使用显式 unit-of-work helpers：

- Register user：create user、create private team、add owner membership、set current team、create default channel。
- Device report：upsert device、replace runtimes、upsert/link agents、mark missing scanned agents offline。
- Send message：append human message、create dispatch records、publish message event。
- Receive dispatch result：update dispatch、append agent message、update agent status、publish message/status events。
- Receive dispatch error/timeout：update dispatch 与 agent status。

## 第一切片种子数据

用户注册时：

- 创建 private team。
- 创建 owner membership。
- 创建名为 `all` 的 default public channel。
- 将 current team 设为 private team。

Default channel 决策：

- 当前行为使用 `all` 作为 default channel name。
- 第一切片保留 `all`，避免不必要的行为变更。
- 如果后续产品 UX 偏好 `general`，在后续切片中作为显式 rename decision 处理。

## 显式延后的 Tables

在对应 feature slice 开始前，不要添加这些 tables：

- `invites`
- `tasks`
- `artifacts`
- `workspace_runs`
- `saved_messages`
- `message_reactions`
- `agent_metrics`
- `audit_events`

## Schema 验证清单

- 所有 first-slice DTOs 都可以在不读取 old tables 的情况下构建。
- Agent identity links 可以表示 `docs/agent-identity-rules.md` 中的每一种 key。
- Dispatch lifecycle 被持久化，而不只存储在内存中。
- Message sender identity 由 server 推导。
- Team-scoped reads 可以被授权，而不依赖 client-provided team state。
