# First-Slice Schema And Repositories

This document defines the fresh SQLite schema and repository interfaces for the first AgentBean Next slice.

It is not a migration of the old schema. Old SQLite files do not need compatibility.

## Storage Scope

Use two database scopes:

- Global DB: accounts, networks, memberships, devices, runtimes, agents, publications.
- Network DB: channels, channel memberships, messages, dispatches.

Suggested files:

```text
apps/server-next/src/infra/sqlite/migrations/global/0001_first_slice.sql
apps/server-next/src/infra/sqlite/migrations/network/0001_first_slice.sql
```

## Global Schema

```sql
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  username           TEXT NOT NULL UNIQUE,
  email              TEXT UNIQUE,
  display_name       TEXT,
  password_hash      TEXT NOT NULL,
  role               TEXT NOT NULL DEFAULT 'user',
  current_network_id TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE networks (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  description TEXT,
  visibility  TEXT NOT NULL DEFAULT 'private',
  created_at  INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE network_members (
  network_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (network_id, user_id),
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE devices (
  id             TEXT PRIMARY KEY,
  network_id     TEXT NOT NULL,
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
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE device_runtimes (
  id                     TEXT PRIMARY KEY,
  device_id              TEXT NOT NULL,
  network_id             TEXT NOT NULL,
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
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE TABLE agents (
  id                 TEXT PRIMARY KEY,
  primary_network_id TEXT NOT NULL,
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
  FOREIGN KEY (primary_network_id) REFERENCES networks(id) ON DELETE CASCADE,
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
  network_id   TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, network_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE CASCADE
);
```

### Global Indexes

```sql
CREATE INDEX idx_users_current_network ON users(current_network_id);
CREATE INDEX idx_network_members_user ON network_members(user_id);
CREATE INDEX idx_devices_network ON devices(network_id);
CREATE INDEX idx_devices_machine_profile ON devices(machine_id, profile_id);
CREATE INDEX idx_device_runtimes_device ON device_runtimes(device_id);
CREATE INDEX idx_device_runtimes_identity ON device_runtimes(network_id, device_id, adapter_kind, normalized_command_key, normalized_cwd_key);
CREATE INDEX idx_agents_primary_network ON agents(primary_network_id);
CREATE INDEX idx_agents_device ON agents(device_id);
CREATE INDEX idx_agents_identity_lookup ON agents(primary_network_id, device_id, adapter_kind, normalized_name);
CREATE INDEX idx_agent_publications_network ON agent_publications(network_id);
```

## Network Schema

Each network DB is scoped to a single network. `network_id` is still stored on key rows because DTOs and tests should not rely on implicit file location.

```sql
CREATE TABLE channels (
  id          TEXT PRIMARY KEY,
  network_id  TEXT NOT NULL,
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
  network_id        TEXT NOT NULL,
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
  network_id    TEXT NOT NULL,
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

### Network Indexes

```sql
CREATE INDEX idx_channels_network_created ON channels(network_id, created_at);
CREATE INDEX idx_channels_network_kind ON channels(network_id, kind);
CREATE INDEX idx_channel_human_members_user ON channel_human_members(user_id);
CREATE INDEX idx_channel_agent_members_agent ON channel_agent_members(agent_id);
CREATE INDEX idx_messages_channel_created ON messages(channel_id, created_at);
CREATE INDEX idx_messages_thread_created ON messages(thread_id, created_at);
CREATE INDEX idx_messages_client_id ON messages(channel_id, client_message_id);
CREATE INDEX idx_dispatches_message ON dispatches(message_id);
CREATE INDEX idx_dispatches_agent_status ON dispatches(agent_id, status);
CREATE INDEX idx_dispatches_request_id ON dispatches(request_id);
```

## Repository Interfaces

These interfaces are use-case oriented. They do not expose raw rows as the public application boundary.

```ts
export interface UserRepository {
  create(input: CreateUserInput): Promise<UserRecord>;
  getById(id: ID): Promise<UserRecord | null>;
  getByUsername(username: string): Promise<UserRecord | null>;
  setCurrentNetwork(userId: ID, networkId: ID): Promise<void>;
}

export interface NetworkRepository {
  create(input: CreateNetworkInput): Promise<NetworkRecord>;
  getById(id: ID): Promise<NetworkRecord | null>;
  getByPath(path: string): Promise<NetworkRecord | null>;
  listForUser(userId: ID): Promise<NetworkRecord[]>;
  addMember(input: AddNetworkMemberInput): Promise<void>;
  isMember(networkId: ID, userId: ID): Promise<boolean>;
  listMembers(networkId: ID): Promise<HumanMemberRecord[]>;
}

export interface DeviceRepository {
  upsertHello(input: DeviceHelloRecord): Promise<DeviceRecord>;
  getById(id: ID): Promise<DeviceRecord | null>;
  findByMachineProfile(machineId: string, profileId: string): Promise<DeviceRecord | null>;
  setStatus(input: SetDeviceStatusInput): Promise<void>;
  listByNetwork(networkId: ID): Promise<DeviceRecord[]>;
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
  listVisibleInNetwork(networkId: ID): Promise<AgentRecord[]>;
  listByDevice(deviceId: ID): Promise<AgentRecord[]>;
}

export interface ChannelRepository {
  create(input: CreateChannelInput): Promise<ChannelRecord>;
  getById(channelId: ID): Promise<ChannelRecord | null>;
  listForUser(networkId: ID, userId: ID): Promise<ChannelRecord[]>;
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

## Transaction Boundaries

Use explicit unit-of-work helpers for these operations:

- Register user: create user, create private network, add owner membership, set current network, create default channel.
- Device report: upsert device, replace runtimes, upsert/link agents, mark missing scanned agents offline.
- Send message: append human message, create dispatch records, publish message event.
- Receive dispatch result: update dispatch, append agent message, update agent status, publish message/status events.
- Receive dispatch error/timeout: update dispatch and agent status.

## First-Slice Seed Data

On user registration:

- Create a private network.
- Create owner membership.
- Create a default public channel named `all`.
- Set current network to the private network.

Default channel decision:

- Current behavior uses `all` as the default channel name.
- The first slice keeps `all` to avoid an unnecessary behavior change.
- If product UX later prefers `general`, handle that as an explicit rename decision in a later slice.

## Explicitly Deferred Tables

Do not add these until their feature slice begins:

- `invites`
- `tasks`
- `artifacts`
- `workspace_runs`
- `saved_messages`
- `message_reactions`
- `agent_metrics`
- `audit_events`

## Schema Verification Checklist

- All first-slice DTOs can be built without reading old tables.
- Agent identity links can represent every key from `docs/agent-identity-rules.md`.
- Dispatch lifecycle is persisted, not only stored in memory.
- Message sender identity is server-derived.
- Network-scoped reads can be authorized without relying on client-provided network state.
