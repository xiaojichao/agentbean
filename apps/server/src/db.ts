import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from './ids.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT,
  adapter_kind  TEXT NOT NULL,
  device_id     TEXT,
  network_id    TEXT NOT NULL DEFAULT 'default',
  visibility    TEXT NOT NULL DEFAULT 'public',
  category      TEXT NOT NULL DEFAULT 'executor-hosted',
  source        TEXT NOT NULL DEFAULT 'self-register',
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  last_error    TEXT,
  owner_id      TEXT,
  command       TEXT,
  args          TEXT,
  cwd           TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_id)   REFERENCES agents(id)   ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_members_agent ON channel_members(agent_id);
CREATE TABLE IF NOT EXISTS channel_user_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_members_user ON channel_user_members(user_id);
CREATE TABLE IF NOT EXISTS channel_user_leaves (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  left_at    INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_leaves_user ON channel_user_leaves(user_id);
CREATE TABLE IF NOT EXISTS messages (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_id   TEXT,
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  meta_json   TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);
CREATE TABLE IF NOT EXISTS artifacts (
  id           TEXT PRIMARY KEY,
  channel_id   TEXT NOT NULL,
  message_id   TEXT,
  uploader_id  TEXT NOT NULL,
  filename     TEXT NOT NULL,
  mime_type    TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  meta_json    TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE,
  FOREIGN KEY (uploader_id) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_channel ON artifacts(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id);
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'todo',
  creator_id  TEXT NOT NULL,
  assignee_id TEXT,
  channel_id  TEXT,
  tags        TEXT DEFAULT '[]',
  sort_order  REAL NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_channel ON tasks(channel_id);
`;

export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'standalone';
export type AgentCategory = 'executor-hosted' | 'agentos-hosted';
export type SenderKind = 'human' | 'agent' | 'system';

export interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  adapterKind: AdapterKind;
  deviceId: string | null;
  networkId: string;
  visibility: 'public' | 'private';
  category: AgentCategory;
  source?: 'self-register' | 'scanned' | 'custom';
  firstSeenAt: number;
  lastSeenAt: number;
  lastError: string | null;
  ownerId: string | null;
  command: string | null;
  args: string | null;
  cwd: string | null;
  description: string | null;
}

export interface ChannelRow { id: string; name: string; description: string | null; visibility: 'public' | 'private'; createdBy: string | null; createdAt: number; archivedAt?: number | null; }
export interface ChannelUserMember { channelId: string; userId: string; joinedAt: number; }
export interface ChannelMember { channelId: string; agentId: string; joinedAt: number; }
export interface MessageRow {
  id: string;
  channelId: string;
  senderKind: SenderKind;
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson: string | null;
}

export interface ArtifactRow {
  id: string;
  channelId: string;
  messageId: string | null;
  uploaderId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  createdAt: number;
  metaJson: string | null;
}

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  creatorId: string;
  assigneeId: string | null;
  channelId: string | null;
  tags: string[];
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface Db {
  raw: Database.Database;
  close: () => void;
  agents: {
    upsert(row: AgentRow): void;
    create(row: AgentRow): void;
    updateVisibility(id: string, visibility: 'public' | 'private'): void;
    updateNetworkId(id: string, networkId: string): void;
    getAll(): AgentRow[];
    get(id: string): AgentRow | null;
    listByDevice(deviceId: string): AgentRow[];
  };
  channels: {
    create(input: { name: string; description?: string | null; visibility?: 'public' | 'private'; createdBy?: string; createdAt: number; id?: string }): ChannelRow;
    list(): ChannelRow[];
    listForUser(userId: string): ChannelRow[];
    get(id: string): ChannelRow | null;
  };
  channelMembers: {
    add(m: ChannelMember): void;
    list(channelId: string): ChannelMember[];
    forAgent(agentId: string): ChannelMember[];
  };
  channelUserMembers: {
    add(m: ChannelUserMember): void;
    remove(channelId: string, userId: string): void;
    list(channelId: string): ChannelUserMember[];
    isMember(channelId: string, userId: string): boolean;
  };
  messages: {
    append(m: MessageRow): void;
    listByChannel(channelId: string, limit: number): MessageRow[];
  };
  artifacts: {
    create(input: {
      id: string; channelId: string; messageId: string | null;
      uploaderId: string; filename: string; mimeType: string;
      sizeBytes: number; storagePath: string; createdAt: number;
      metaJson?: string | null;
    }): void;
    get(id: string): ArtifactRow | null;
    listByChannel(channelId: string, limit: number): ArtifactRow[];
    listByMessage(messageId: string): ArtifactRow[];
    bindMessageId(artifactIds: string[], messageId: string): void;
  };
  tasks: {
    create(input: { id?: string; title: string; description?: string; status?: TaskStatus; creatorId: string; assigneeId?: string; channelId?: string; tags?: string[]; sortOrder?: number; createdAt: number }): TaskRow;
    get(id: string): TaskRow | null;
    list(channelId?: string): TaskRow[];
    update(id: string, input: { title?: string; description?: string; status?: TaskStatus; assigneeId?: string | null; channelId?: string | null; tags?: string[]; sortOrder?: number }): void;
    delete(id: string): void;
    updateStatus(id: string, status: TaskStatus): void;
    updateSort(id: string, sortOrder: number): void;
  };
}

function rowToAgent(r: any): AgentRow {
  return {
    id: r.id, name: r.name, role: r.role, adapterKind: r.adapter_kind,
    deviceId: r.device_id ?? null,
    networkId: r.network_id ?? 'default',
    visibility: r.visibility ?? 'public',
    category: r.category ?? 'executor-hosted',
    source: r.source ?? 'self-register',
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, lastError: r.last_error,
    ownerId: r.owner_id ?? null,
    command: r.command ?? null,
    args: r.args ?? null,
    cwd: r.cwd ?? null,
    description: r.description ?? null,
  };
}
function rowToMessage(r: any): MessageRow {
  return {
    id: r.id, channelId: r.channel_id, senderKind: r.sender_kind,
    senderId: r.sender_id, body: r.body, createdAt: r.created_at, metaJson: r.meta_json,
  };
}
function rowToArtifact(r: any): ArtifactRow {
  return {
    id: r.id, channelId: r.channel_id, messageId: r.message_id,
    uploaderId: r.uploader_id, filename: r.filename, mimeType: r.mime_type,
    sizeBytes: r.size_bytes, storagePath: r.storage_path,
    createdAt: r.created_at, metaJson: r.meta_json,
  };
}

const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  description TEXT,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT UNIQUE,
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  type TEXT NOT NULL DEFAULT 'local',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS network_members (
  network_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, user_id),
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  hostname TEXT,
  last_seen_at INTEGER NOT NULL,
  connect_command TEXT,
  system_info TEXT,
  runtimes TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  adapter_kind TEXT NOT NULL,
  device_id TEXT NOT NULL,
  network_id TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public',
  category TEXT NOT NULL DEFAULT 'executor-hosted',
  source TEXT NOT NULL DEFAULT 'self-register',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_error TEXT,
  command TEXT,
  args TEXT,
  cwd TEXT,
  owner_id TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agents_network ON agents(network_id, visibility);
CREATE INDEX IF NOT EXISTS idx_devices_network ON devices(network_id);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  network_id TEXT REFERENCES networks(id),
  purpose TEXT NOT NULL DEFAULT 'user',
  used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);

CREATE TABLE IF NOT EXISTS agent_network_publish (
  agent_id     TEXT NOT NULL,
  network_id   TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, network_id),
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_publish_network ON agent_network_publish(network_id);
CREATE INDEX IF NOT EXISTS idx_agent_publish_agent ON agent_network_publish(agent_id);
`;

export interface NetworkRow {
  id: string;
  ownerId: string;
  name: string;
  path: string | null;
  description: string | null;
  visibility: 'public' | 'private';
  type: 'public' | 'local' | 'private';
  createdAt: number;
}

export interface DeviceRow {
  id: string;
  userId: string;
  networkId: string;
  hostname: string | null;
  lastSeenAt: number;
  connectCommand: string | null;
  systemInfo: Record<string, unknown> | null;
  runtimes: { name: string; adapterKind: string; command: string; installed: boolean }[];
}

export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  description: string | null;
  passwordHash: string | null;
  role: 'admin' | 'user';
  currentNetworkId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InviteRow {
  id: string;
  code: string;
  createdBy: string;
  networkId: string | null;
  purpose: 'user' | 'device';
  usedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  maxUses: number | null;
  usesCount: number;
}

export interface GlobalDb {
  raw: Database.Database;
  close: () => void;
  users: {
    create(input: { id: string; username: string; email?: string | null; description?: string | null; passwordHash?: string | null; role?: 'admin' | 'user'; createdAt: number }): UserRow;
    get(id: string): UserRow | null;
    getByName(username: string): UserRow | null;
    getByEmail(email: string): UserRow | null;
    listAll(): UserRow[];
    delete(id: string): void;
    setCurrentNetwork(userId: string, networkId: string | null): void;
    updateDescription(userId: string, description: string | null, updatedAt: number): void;
  };
  networks: {
    create(input: { id?: string; ownerId: string; name: string; path?: string | null; description?: string | null; visibility?: 'public' | 'private'; type?: 'public' | 'local' | 'private'; createdAt: number }): NetworkRow;
    list(): NetworkRow[];
    get(id: string): NetworkRow | null;
    getByPath(path: string): NetworkRow | null;
    updateName(id: string, name: string): void;
  };
  networkMembers: {
    add(networkId: string, userId: string, role: string): void;
    listByUser(userId: string): { networkId: string; role: string }[];
    listByNetwork(networkId: string): { userId: string; role: string; username: string; email: string | null; description: string | null; joinedAt: number; createdAt: number }[];
    isMember(networkId: string, userId: string): boolean;
  };
  invites: {
    create(input: { id: string; code: string; createdBy: string; networkId?: string | null; purpose?: 'user' | 'device'; expiresAt?: number | null; maxUses?: number | null }): InviteRow;
    getByCode(code: string): InviteRow | null;
    markUsed(code: string): void;
    incrementUses(code: string): void;
    listByNetwork(networkId: string): InviteRow[];
    revoke(code: string): void;
  };
  agentPublishes: {
    publish(agentId: string, networkId: string, publishedBy: string): void;
    unpublish(agentId: string, networkId: string): void;
    listByAgent(agentId: string): { networkId: string; publishedBy: string; publishedAt: number }[];
    listByNetwork(networkId: string): { agentId: string; publishedBy: string; publishedAt: number }[];
    isPublished(agentId: string, networkId: string): boolean;
  };
  agents: {
    upsert(row: { id: string; name: string; role?: string; adapterKind: string; deviceId: string; networkId: string; visibility?: string; category?: string; source?: string; firstSeenAt: number; lastSeenAt: number; lastError?: string | null; command?: string; args?: string; cwd?: string; ownerId?: string; description?: string | null }): void;
    listAll(): { id: string; name: string; role: string | null; adapterKind: string; category: string; source: string; command: string | null; args: string | null; cwd: string | null; deviceId: string | null; networkId: string; visibility: string; ownerId: string | null; description: string | null; firstSeenAt: number; lastSeenAt: number; lastError: string | null }[];
    listByDevice(deviceId: string): { id: string; name: string; role: string | null; adapterKind: string; category: string; source: string; command: string | null; args: string | null; cwd: string | null; deviceId: string | null; networkId: string; visibility: string; ownerId: string | null; description: string | null; firstSeenAt: number; lastSeenAt: number; lastError: string | null }[];
    listCustomByOwner(ownerId: string): { id: string; name: string; role: string | null; adapterKind: string; category: string; source: string; command: string | null; args: string | null; cwd: string | null; deviceId: string | null; networkId: string; visibility: string; ownerId: string | null; description: string | null; firstSeenAt: number; lastSeenAt: number; lastError: string | null }[];
    listVisibleInNetwork(networkId: string): { id: string; name: string; role: string | null; adapterKind: string; category: string; source: string; command: string | null; args: string | null; cwd: string | null; deviceId: string | null; networkId: string; visibility: string; ownerId: string | null; description: string | null; firstSeenAt: number; lastSeenAt: number; lastError: string | null }[];
    getFull(id: string): { id: string; name: string; role: string | null; adapterKind: string; category: string; source: string; command: string | null; args: string | null; cwd: string | null; deviceId: string | null; networkId: string; visibility: string; ownerId: string | null; description: string | null; firstSeenAt: number; lastSeenAt: number; lastError: string | null } | null;
    updateConfig(id: string, input: { name: string; adapterKind?: string | null; command?: string | null; cwd?: string | null; description?: string | null; updatedAt: number }): void;
    get(id: string): { id: string } | null;
  };
  devices: {
    upsert(row: { id: string; userId: string; networkId: string; hostname?: string; lastSeenAt: number; systemInfo?: Record<string, unknown> | null }): void;
    get(id: string): DeviceRow | null;
    listAll(): DeviceRow[];
    listByNetwork(networkId: string): DeviceRow[];
    listByUser(userId: string): DeviceRow[];
    delete(id: string): void;
    setConnectCommand(id: string, command: string): void;
    setRuntimes(id: string, runtimes: { name: string; adapterKind: string; command: string; installed: boolean }[]): void;
    touch(id: string, lastSeenAt: number): void;
    rename(id: string, hostname: string): void;
  };
}

function rowToUser(r: any): UserRow {
  return {
    id: r.id,
    username: r.username,
    email: r.email ?? null,
    description: r.description ?? null,
    passwordHash: r.password_hash ?? null,
    role: r.role ?? 'user',
    currentNetworkId: r.current_network_id ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToNetwork(r: any): NetworkRow {
  return {
    id: r.id,
    ownerId: r.ownerId,
    name: r.name,
    path: r.path ?? null,
    description: r.description ?? null,
    visibility: r.visibility ?? 'private',
    type: r.type ?? (r.visibility === 'public' ? 'public' : 'local'),
    createdAt: r.createdAt,
  };
}

function rowToInvite(r: any): InviteRow {
  return {
    id: r.id,
    code: r.code,
    createdBy: r.created_by,
    networkId: r.network_id ?? null,
    purpose: r.purpose ?? 'user',
    usedAt: r.used_at ?? null,
    expiresAt: r.expires_at ?? null,
    maxUses: r.max_uses ?? null,
    usesCount: r.uses_count ?? 0,
    createdAt: r.created_at,
  };
}

function rowToDevice(r: any): DeviceRow {
  return {
    id: r.id,
    userId: r.user_id,
    networkId: r.network_id,
    hostname: r.hostname ?? null,
    lastSeenAt: r.last_seen_at,
    connectCommand: r.connect_command ?? null,
    systemInfo: r.system_info ? JSON.parse(r.system_info) : null,
    runtimes: r.runtimes ? JSON.parse(r.runtimes) : [],
  };
}

export function initGlobalDb(dbPath: string = './data/global.db'): GlobalDb {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const raw = new Database(dbPath);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(GLOBAL_SCHEMA);

  try { raw.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE users ADD COLUMN description TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE networks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`); } catch {}
  try { raw.exec(`ALTER TABLE invites ADD COLUMN purpose TEXT NOT NULL DEFAULT 'user'`); } catch {}
  try { raw.exec(`ALTER TABLE invites ADD COLUMN max_uses INTEGER`); } catch {}
  try { raw.exec(`ALTER TABLE invites ADD COLUMN uses_count INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { raw.exec(`UPDATE networks SET visibility = 'public' WHERE id = 'default'`); } catch {}
  try { raw.exec(`ALTER TABLE networks ADD COLUMN path TEXT`); } catch {}
  try { raw.exec(`UPDATE networks SET path = 'default' WHERE id = 'default' AND path IS NULL`); } catch {}
  try { raw.exec(`UPDATE networks SET path = (SELECT username FROM users WHERE id = networks.owner_id) || '-private' WHERE path IS NULL AND visibility = 'private'`); } catch {}
  try { raw.exec(`UPDATE networks SET path = id WHERE path IS NULL`); } catch {}
  try { raw.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`); } catch {}
  try { raw.exec(`ALTER TABLE networks ADD COLUMN type TEXT NOT NULL DEFAULT 'local'`); } catch {}
  try { raw.exec(`UPDATE networks SET type = 'public' WHERE id = 'default'`); } catch {}
  try { raw.exec(`UPDATE networks SET type = 'public' WHERE visibility = 'public' AND type = 'local'`); } catch {}

  const userCreate = raw.prepare(`
    INSERT INTO users (id, username, email, description, password_hash, role, created_at, updated_at)
    VALUES (@id, @username, @email, @description, @passwordHash, @role, @createdAt, @updatedAt)
  `);
  const userGet = raw.prepare(`
    SELECT * FROM users WHERE id = ?
  `);
  const userGetByName = raw.prepare(`
    SELECT * FROM users WHERE username = ?
  `);
  const userGetByEmail = raw.prepare(`
    SELECT * FROM users WHERE email = ?
  `);
  const userListAll = raw.prepare(`
    SELECT * FROM users ORDER BY created_at
  `);
  const userDelete = raw.prepare(`
    DELETE FROM users WHERE id = ?
  `);
  const userUpdateDescription = raw.prepare(`
    UPDATE users SET description = ?, updated_at = ? WHERE id = ?
  `);

  const networkCreate = raw.prepare(`
    INSERT INTO networks (id, owner_id, name, path, description, visibility, type, created_at)
    VALUES (@id, @ownerId, @name, @path, @description, @visibility, @type, @createdAt)
  `);
  const networkList = raw.prepare(`
    SELECT id, owner_id AS ownerId, name, path, description, visibility, type, created_at AS createdAt
    FROM networks ORDER BY created_at
  `);
  const networkGet = raw.prepare(`
    SELECT id, owner_id AS ownerId, name, path, description, visibility, type, created_at AS createdAt
    FROM networks WHERE id = ?
  `);
  const networkGetByPath = raw.prepare(`
    SELECT id, owner_id AS ownerId, name, path, description, visibility, type, created_at AS createdAt
    FROM networks WHERE path = ?
  `);
  const networkUpdateName = raw.prepare(`
    UPDATE networks SET name = ? WHERE id = ?
  `);
  const networkMemberAdd = raw.prepare(`
    INSERT OR REPLACE INTO network_members (network_id, user_id, role, joined_at)
    VALUES (?, ?, ?, ?)
  `);
  const networkMembersByUser = raw.prepare(`
    SELECT network_id AS networkId, role FROM network_members WHERE user_id = ? ORDER BY joined_at
  `);
  const networkMemberGet = raw.prepare(`
    SELECT 1 FROM network_members WHERE network_id = ? AND user_id = ?
  `);
  const networkMembersByNetwork = raw.prepare(`
    SELECT
      nm.user_id AS userId,
      nm.role,
      nm.joined_at AS joinedAt,
      u.username,
      u.email,
      u.description,
      u.created_at AS createdAt
    FROM network_members nm
    JOIN users u ON u.id = nm.user_id
    WHERE nm.network_id = ?
    ORDER BY nm.joined_at
  `);

  const inviteCreate = raw.prepare(`
    INSERT INTO invites (id, code, created_by, network_id, purpose, used_at, expires_at, created_at, max_uses, uses_count)
    VALUES (@id, @code, @createdBy, @networkId, @purpose, null, @expiresAt, @createdAt, @maxUses, 0)
  `);
  const inviteGetByCode = raw.prepare(`SELECT * FROM invites WHERE code = ?`);
  const inviteMarkUsed = raw.prepare(`UPDATE invites SET used_at = ? WHERE code = ?`);
  const inviteIncrementUses = raw.prepare(`UPDATE invites SET uses_count = uses_count + 1 WHERE code = ?`);
  const inviteListByNetwork = raw.prepare(`SELECT * FROM invites WHERE network_id = ? ORDER BY created_at DESC`);
  const inviteRevoke = raw.prepare(`UPDATE invites SET used_at = ? WHERE code = ? AND used_at IS NULL`);

  const agentPublishInsert = raw.prepare(`
    INSERT OR IGNORE INTO agent_network_publish (agent_id, network_id, published_by, published_at)
    VALUES (?, ?, ?, ?)
  `);
  const agentPublishDelete = raw.prepare(`
    DELETE FROM agent_network_publish WHERE agent_id = ? AND network_id = ?
  `);
  const agentPublishByAgent = raw.prepare(`
    SELECT network_id AS networkId, published_by AS publishedBy, published_at AS publishedAt
    FROM agent_network_publish WHERE agent_id = ?
  `);
  const agentPublishByNetwork = raw.prepare(`
    SELECT agent_id AS agentId, published_by AS publishedBy, published_at AS publishedAt
    FROM agent_network_publish WHERE network_id = ?
  `);
  const agentPublishGet = raw.prepare(`
    SELECT 1 FROM agent_network_publish WHERE agent_id = ? AND network_id = ?
  `);

  // Migration: add columns to global agents table if missing
  try { raw.exec(`ALTER TABLE agents ADD COLUMN category TEXT NOT NULL DEFAULT 'executor-hosted'`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'self-register'`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN command TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN args TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN cwd TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN owner_id TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN description TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE users ADD COLUMN current_network_id TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE devices ADD COLUMN connect_command TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE devices ADD COLUMN system_info TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE devices ADD COLUMN runtimes TEXT`); } catch {}

  const userSetCurrentNetwork = raw.prepare(`UPDATE users SET current_network_id = ?, updated_at = ? WHERE id = ?`);

  const deviceUpsert = raw.prepare(`
    INSERT INTO devices (id, user_id, network_id, hostname, last_seen_at, system_info)
    VALUES (@id, @userId, @networkId, @hostname, @lastSeenAt, @systemInfo)
    ON CONFLICT(id) DO UPDATE SET
      hostname = excluded.hostname,
      last_seen_at = excluded.last_seen_at,
      system_info = COALESCE(excluded.system_info, system_info)
  `);
  const deviceGet = raw.prepare(`SELECT * FROM devices WHERE id = ?`);
  const deviceListByNetwork = raw.prepare(`SELECT * FROM devices WHERE network_id = ? ORDER BY last_seen_at DESC`);
  const deviceListByUser = raw.prepare(`SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC`);
  const deviceDelete = raw.prepare(`DELETE FROM devices WHERE id = ?`);
  const deviceSetConnectCommand = raw.prepare(`UPDATE devices SET connect_command = ? WHERE id = ?`);
  const deviceSetRuntimes = raw.prepare(`UPDATE devices SET runtimes = ?, last_seen_at = ? WHERE id = ?`);
  const deviceTouch = raw.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`);
  const deviceRename = raw.prepare(`UPDATE devices SET hostname = ? WHERE id = ?`);

  const globalAgentUpsert = raw.prepare(`
    INSERT INTO agents (id, name, role, adapter_kind, device_id, network_id, visibility, category, source, first_seen_at, last_seen_at, last_error, command, args, cwd, owner_id, description)
    VALUES (@id, @name, @role, @adapterKind, @deviceId, @networkId, @visibility, @category, @source, @firstSeenAt, @lastSeenAt, @lastError, @command, @args, @cwd, @ownerId, @description)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      adapter_kind = excluded.adapter_kind,
      command = excluded.command,
      args = excluded.args,
      last_seen_at = excluded.last_seen_at,
      description = excluded.description
  `);
  const globalAgentListByDevice = raw.prepare(`
    SELECT id, name, role, adapter_kind AS adapterKind, category, source, command, args, cwd, device_id AS deviceId,
           network_id AS networkId, visibility, owner_id AS ownerId, description,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, last_error AS lastError
    FROM agents
    WHERE device_id = ?
    ORDER BY first_seen_at
  `);
  const globalAgentListAll = raw.prepare(`
    SELECT id, name, role, adapter_kind AS adapterKind, category, source, command, args, cwd, device_id AS deviceId,
           network_id AS networkId, visibility, owner_id AS ownerId, description,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, last_error AS lastError
    FROM agents
    ORDER BY first_seen_at DESC
  `);
  const globalAgentListCustomByOwner = raw.prepare(`
    SELECT id, name, role, adapter_kind AS adapterKind, category, source, command, args, cwd, device_id AS deviceId,
           network_id AS networkId, visibility, owner_id AS ownerId, description,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, last_error AS lastError
    FROM agents
    WHERE source = 'custom' AND owner_id = ?
    ORDER BY first_seen_at DESC
  `);
  const globalAgentListVisibleInNetwork = raw.prepare(`
    SELECT DISTINCT a.id, a.name, a.role, a.adapter_kind AS adapterKind, a.category, a.source,
           a.command, a.args, a.cwd, a.device_id AS deviceId,
           a.network_id AS networkId, a.visibility, a.owner_id AS ownerId, a.description,
           a.first_seen_at AS firstSeenAt, a.last_seen_at AS lastSeenAt, a.last_error AS lastError
    FROM agents a
    LEFT JOIN agent_network_publish p ON p.agent_id = a.id
    WHERE (a.category = 'agentos-hosted' OR a.source = 'custom')
      AND (a.network_id = ? OR p.network_id = ?)
    ORDER BY a.first_seen_at DESC
  `);
  const globalAgentGetFull = raw.prepare(`
    SELECT id, name, role, adapter_kind AS adapterKind, category, source, command, args, cwd, device_id AS deviceId,
           network_id AS networkId, visibility, owner_id AS ownerId, description,
           first_seen_at AS firstSeenAt, last_seen_at AS lastSeenAt, last_error AS lastError
    FROM agents WHERE id = ?
  `);
  const globalAgentUpdateConfig = raw.prepare(`
    UPDATE agents
    SET name = @name,
        adapter_kind = COALESCE(@adapterKind, adapter_kind),
        command = COALESCE(@command, command),
        cwd = @cwd, description = @description, last_seen_at = @updatedAt
    WHERE id = @id AND (source = 'custom' OR category = 'agentos-hosted')
  `);
  const globalAgentGet = raw.prepare(`SELECT id FROM agents WHERE id = ?`);

  return {
    raw,
    close: () => raw.close(),
    users: {
      create: ({ id, username, email, description, passwordHash, role, createdAt }) => {
        const row = {
          id,
          username,
          email: email ?? null,
          description: description ?? null,
          passwordHash: passwordHash ?? null,
          role: role ?? 'user' as const,
          currentNetworkId: null,
          createdAt,
          updatedAt: createdAt,
        };
        userCreate.run(row);
        return row;
      },
      setCurrentNetwork: (userId: string, networkId: string | null) => {
        userSetCurrentNetwork.run(networkId, Date.now(), userId);
      },
      get: (id) => {
        const r = userGet.get(id) as any;
        return r ? rowToUser(r) : null;
      },
      getByName: (username) => {
        const r = userGetByName.get(username) as any;
        return r ? rowToUser(r) : null;
      },
      getByEmail: (email) => {
        const r = userGetByEmail.get(email) as any;
        return r ? rowToUser(r) : null;
      },
      listAll: () => (userListAll.all() as any[]).map(rowToUser),
      delete: (id) => { userDelete.run(id); },
      updateDescription: (userId, description, updatedAt) => {
        userUpdateDescription.run(description, updatedAt, userId);
      },
    },
    networks: {
      create: ({ id, ownerId, name, path, description, visibility, type, createdAt }) => {
        const nid = id ?? newId();
        const v = visibility ?? 'private' as const;
        const row = {
          id: nid,
          ownerId,
          name,
          path: path ?? null,
          description: description ?? null,
          visibility: v,
          type: type ?? (v === 'public' ? 'public' as const : 'local' as const),
          createdAt,
        };
        networkCreate.run(row);
        return row;
      },
      list: () => networkList.all().map(rowToNetwork),
      get: (id) => {
        const r = networkGet.get(id) as any;
        return r ? rowToNetwork(r) : null;
      },
      getByPath: (path) => {
        const r = networkGetByPath.get(path) as any;
        return r ? rowToNetwork(r) : null;
      },
      updateName: (id, name) => { networkUpdateName.run(name, id); },
    },
    networkMembers: {
      add: (networkId, userId, role) => { networkMemberAdd.run(networkId, userId, role, Date.now()); },
      listByUser: (userId) => networkMembersByUser.all(userId) as { networkId: string; role: string }[],
      listByNetwork: (networkId) => networkMembersByNetwork.all(networkId) as { userId: string; role: string; username: string; email: string | null; description: string | null; joinedAt: number; createdAt: number }[],
      isMember: (networkId, userId) => Boolean(networkMemberGet.get(networkId, userId)),
    },
    invites: {
      create: ({ id, code, createdBy, networkId, purpose, expiresAt, maxUses }) => {
        const row = {
          id,
          code,
          createdBy,
          networkId: networkId ?? null,
          purpose: purpose ?? 'user' as const,
          usedAt: null,
          expiresAt: expiresAt ?? null,
          maxUses: maxUses ?? null,
          usesCount: 0,
          createdAt: Date.now(),
        };
        inviteCreate.run(row);
        return row;
      },
      getByCode: (code) => {
        const r = inviteGetByCode.get(code) as any;
        return r ? rowToInvite(r) : null;
      },
      markUsed: (code) => { inviteMarkUsed.run(Date.now(), code); },
      incrementUses: (code) => { inviteIncrementUses.run(code); },
      listByNetwork: (networkId) => (inviteListByNetwork.all(networkId) as any[]).map(rowToInvite),
      revoke: (code) => { inviteRevoke.run(Date.now(), code); },
    },
    agentPublishes: {
      publish: (agentId, networkId, publishedBy) => { agentPublishInsert.run(agentId, networkId, publishedBy, Date.now()); },
      unpublish: (agentId, networkId) => { agentPublishDelete.run(agentId, networkId); },
      listByAgent: (agentId) => agentPublishByAgent.all(agentId) as { networkId: string; publishedBy: string; publishedAt: number }[],
      listByNetwork: (networkId) => agentPublishByNetwork.all(networkId) as { agentId: string; publishedBy: string; publishedAt: number }[],
      isPublished: (agentId, networkId) => Boolean(agentPublishGet.get(agentId, networkId)),
    },
    agents: {
      upsert: (row) => {
        globalAgentUpsert.run({
          id: row.id,
          name: row.name,
          role: row.role ?? null,
          adapterKind: row.adapterKind,
          deviceId: row.deviceId,
          networkId: row.networkId,
          visibility: row.visibility ?? 'public',
          category: row.category ?? 'executor-hosted',
          source: row.source ?? 'self-register',
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
          lastError: row.lastError ?? null,
          command: row.command ?? null,
          args: row.args ?? null,
          cwd: row.cwd ?? null,
          ownerId: row.ownerId ?? null,
          description: row.description ?? null,
        });
      },
      listAll: () => globalAgentListAll.all() as any[],
      listByDevice: (deviceId) => globalAgentListByDevice.all(deviceId) as any[],
      listCustomByOwner: (ownerId) => globalAgentListCustomByOwner.all(ownerId) as any[],
      listVisibleInNetwork: (networkId) => globalAgentListVisibleInNetwork.all(networkId, networkId) as any[],
      getFull: (id) => (globalAgentGetFull.get(id) as any) ?? null,
      updateConfig: (id, input) => { globalAgentUpdateConfig.run({ id, ...input }); },
      get: (id) => (globalAgentGet.get(id) as any) ?? null,
    },
    devices: {
      upsert: (row) => {
        deviceUpsert.run({
          id: row.id,
          userId: row.userId,
          networkId: row.networkId,
          hostname: row.hostname ?? null,
          lastSeenAt: row.lastSeenAt,
          systemInfo: row.systemInfo ? JSON.stringify(row.systemInfo) : null,
        });
      },
      get: (id) => {
        const r = deviceGet.get(id) as any;
        return r ? rowToDevice(r) : null;
      },
      listAll: () =>
        (raw.prepare(`SELECT * FROM devices ORDER BY last_seen_at DESC`).all() as any[]).map(rowToDevice),
      listByNetwork: (networkId) =>
        (deviceListByNetwork.all(networkId) as any[]).map(rowToDevice),
      listByUser: (userId) =>
        (deviceListByUser.all(userId) as any[]).map(rowToDevice),
      delete: (id) => { deviceDelete.run(id); },
      setConnectCommand: (id, command) => { deviceSetConnectCommand.run(command, id); },
      setRuntimes: (id, runtimes) => { deviceSetRuntimes.run(JSON.stringify(runtimes), Date.now(), id); },
      touch: (id, lastSeenAt) => { deviceTouch.run(lastSeenAt, id); },
      rename: (id, hostname) => { deviceRename.run(hostname, id); },
    },
  };
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);

  // Migrations: add columns if missing (safe for existing DBs)
  try { raw.exec(`ALTER TABLE agents ADD COLUMN device_id TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN network_id TEXT NOT NULL DEFAULT 'default'`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN category TEXT NOT NULL DEFAULT 'executor-hosted'`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN source TEXT NOT NULL DEFAULT 'self-register'`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN owner_id TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN command TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN args TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN cwd TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE agents ADD COLUMN description TEXT`); } catch {}

  // Channel visibility + user members migrations
  try { raw.exec(`ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`); } catch {}
  try { raw.exec(`ALTER TABLE channels ADD COLUMN description TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE channels ADD COLUMN created_by TEXT`); } catch {}
  try { raw.exec(`ALTER TABLE channels ADD COLUMN archived_at INTEGER`); } catch {}

  const agentUpsert = raw.prepare(`
    INSERT INTO agents (id, name, role, adapter_kind, device_id, network_id, visibility, category, source, first_seen_at, last_seen_at, last_error, owner_id, command, args, cwd)
    VALUES (@id, @name, @role, @adapterKind, @deviceId, @networkId, @visibility, @category, @source, @firstSeenAt, @lastSeenAt, @lastError, @ownerId, @command, @args, @cwd)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      adapter_kind = excluded.adapter_kind,
      device_id = excluded.device_id,
      network_id = excluded.network_id,
      visibility = excluded.visibility,
      category = excluded.category,
      source = excluded.source,
      last_seen_at = excluded.last_seen_at,
      last_error   = excluded.last_error,
      owner_id     = excluded.owner_id,
      command      = excluded.command,
      args         = excluded.args,
      cwd          = excluded.cwd
  `);
  const agentCreate = raw.prepare(`
    INSERT INTO agents (id, name, role, adapter_kind, device_id, network_id, visibility, category, source, first_seen_at, last_seen_at, last_error, owner_id, command, args, cwd, description)
    VALUES (@id, @name, @role, @adapterKind, @deviceId, @networkId, @visibility, @category, @source, @firstSeenAt, @lastSeenAt, @lastError, @ownerId, @command, @args, @cwd, @description)
  `);
  const agentUpdateVisibility = raw.prepare(`
    UPDATE agents SET visibility = ? WHERE id = ?
  `);
  const agentUpdateNetworkId = raw.prepare(`
    UPDATE agents SET network_id = ? WHERE id = ?
  `);
  const agentGetAll = raw.prepare(`SELECT * FROM agents ORDER BY first_seen_at`);
  const agentGet = raw.prepare(`SELECT * FROM agents WHERE id = ?`);
  const agentListByDevice = raw.prepare(`SELECT * FROM agents WHERE device_id = ? ORDER BY first_seen_at`);

  const channelCreate = raw.prepare(`
    INSERT INTO channels (id, name, description, visibility, created_by, created_at) VALUES (@id, @name, @description, @visibility, @createdBy, @createdAt)
  `);
  const channelList = raw.prepare(`SELECT id, name, description, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM channels WHERE archived_at IS NULL ORDER BY created_at`);
  const channelGet = raw.prepare(`SELECT id, name, description, visibility, created_by AS createdBy, created_at AS createdAt, archived_at AS archivedAt FROM channels WHERE id = ?`);
  const channelListForUser = raw.prepare(`
    SELECT c.id, c.name, c.description, c.visibility, c.created_by AS createdBy, c.created_at AS createdAt, c.archived_at AS archivedAt
    FROM channels c
    LEFT JOIN channel_user_members cum ON c.id = cum.channel_id AND cum.user_id = ?
    WHERE c.archived_at IS NULL AND (c.visibility = 'public' OR cum.user_id IS NOT NULL)
    ORDER BY c.created_at
  `);

  const memberAdd = raw.prepare(`
    INSERT OR IGNORE INTO channel_members (channel_id, agent_id, joined_at)
    VALUES (@channelId, @agentId, @joinedAt)
  `);
  const memberListByChannel = raw.prepare(`
    SELECT channel_id AS channelId, agent_id AS agentId, joined_at AS joinedAt
    FROM channel_members WHERE channel_id = ? ORDER BY joined_at
  `);
  const memberListByAgent = raw.prepare(`
    SELECT channel_id AS channelId, agent_id AS agentId, joined_at AS joinedAt
    FROM channel_members WHERE agent_id = ?
  `);

  const userMemberAdd = raw.prepare(`
    INSERT OR IGNORE INTO channel_user_members (channel_id, user_id, joined_at)
    VALUES (@channelId, @userId, @joinedAt)
  `);
  const userMemberRemove = raw.prepare(`
    DELETE FROM channel_user_members WHERE channel_id = ? AND user_id = ?
  `);
  const userMemberListByChannel = raw.prepare(`
    SELECT channel_id AS channelId, user_id AS userId, joined_at AS joinedAt
    FROM channel_user_members WHERE channel_id = ? ORDER BY joined_at
  `);
  const userMemberIsMember = raw.prepare(`
    SELECT 1 FROM channel_user_members WHERE channel_id = ? AND user_id = ?
  `);

  const messageAppend = raw.prepare(`
    INSERT INTO messages (id, channel_id, sender_kind, sender_id, body, created_at, meta_json)
    VALUES (@id, @channelId, @senderKind, @senderId, @body, @createdAt, @metaJson)
  `);
  const messageList = raw.prepare(`
    SELECT * FROM messages WHERE channel_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  const artifactCreate = raw.prepare(`
    INSERT INTO artifacts (id, channel_id, message_id, uploader_id, filename, mime_type, size_bytes, storage_path, created_at, meta_json)
    VALUES (@id, @channelId, @messageId, @uploaderId, @filename, @mimeType, @sizeBytes, @storagePath, @createdAt, @metaJson)
  `);
  const artifactGet = raw.prepare(`SELECT * FROM artifacts WHERE id = ?`);
  const artifactListByChannel = raw.prepare(`
    SELECT * FROM artifacts WHERE channel_id = ?
    ORDER BY created_at ASC LIMIT ?
  `);
  const artifactListByMessage = raw.prepare(`
    SELECT * FROM artifacts WHERE message_id = ?
    ORDER BY created_at ASC
  `);
  const artifactBindMessage = raw.prepare(`
    UPDATE artifacts SET message_id = ? WHERE id = ?
  `);

  // Task statements
  const taskCreate = raw.prepare(`
    INSERT INTO tasks (id, title, description, status, creator_id, assignee_id, channel_id, tags, sort_order, created_at, updated_at)
    VALUES (@id, @title, @description, @status, @creatorId, @assigneeId, @channelId, @tags, @sortOrder, @createdAt, @updatedAt)
  `);
  const taskGet = raw.prepare(`SELECT * FROM tasks WHERE id = ?`);
  const taskListAll = raw.prepare(`SELECT * FROM tasks ORDER BY sort_order ASC, created_at DESC`);
  const taskListByChannel = raw.prepare(`SELECT * FROM tasks WHERE channel_id = ? ORDER BY sort_order ASC, created_at DESC`);
  const taskUpdate = raw.prepare(`
    UPDATE tasks SET title = @title, description = @description, status = @status,
      assignee_id = @assigneeId, channel_id = @channelId, tags = @tags, sort_order = @sortOrder, updated_at = @updatedAt
    WHERE id = @id
  `);
  const taskDelete = raw.prepare(`DELETE FROM tasks WHERE id = ?`);
  const taskUpdateStatus = raw.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`);
  const taskUpdateSort = raw.prepare(`UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?`);

  function rowToTask(r: any): TaskRow {
    return {
      id: r.id,
      title: r.title,
      description: r.description ?? null,
      status: r.status as TaskStatus,
      creatorId: r.creator_id,
      assigneeId: r.assignee_id ?? null,
      channelId: r.channel_id ?? null,
      tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  return {
    raw,
    close: () => raw.close(),
    agents: {
      upsert: (row) => { agentUpsert.run({ ...row, source: row.source ?? 'self-register' }); },
      create: (row) => { agentCreate.run({ ...row, source: row.source ?? 'self-register' }); },
      updateVisibility: (id, visibility) => { agentUpdateVisibility.run(visibility, id); },
      updateNetworkId: (id, networkId) => { agentUpdateNetworkId.run(networkId, id); },
      getAll: () => agentGetAll.all().map(rowToAgent),
      get: (id) => {
        const r = agentGet.get(id) as any;
        return r ? rowToAgent(r) : null;
      },
      listByDevice: (deviceId) => agentListByDevice.all(deviceId).map(rowToAgent),
    },
    channels: {
      create: ({ name, description = null, visibility = 'public', createdBy = null, createdAt, id }) => {
        const cid = id ?? newId();
        channelCreate.run({ id: cid, name, description, visibility, createdBy, createdAt });
        return { id: cid, name, description, visibility, createdBy, createdAt, archivedAt: null };
      },
      list: () => channelList.all() as ChannelRow[],
      listForUser: (userId) => channelListForUser.all(userId) as ChannelRow[],
      get: (id) => (channelGet.get(id) as ChannelRow | undefined) ?? null,
    },
    channelMembers: {
      add: (m) => { memberAdd.run(m); },
      list: (channelId) => memberListByChannel.all(channelId) as ChannelMember[],
      forAgent: (agentId) => memberListByAgent.all(agentId) as ChannelMember[],
    },
    channelUserMembers: {
      add: (m) => { userMemberAdd.run(m); },
      remove: (channelId, userId) => { userMemberRemove.run(channelId, userId); },
      list: (channelId) => userMemberListByChannel.all(channelId) as ChannelUserMember[],
      isMember: (channelId, userId) => !!userMemberIsMember.get(channelId, userId),
    },
    messages: {
      append: (m) => { messageAppend.run(m); },
      listByChannel: (channelId, limit) =>
        messageList.all(channelId, limit).map(rowToMessage).reverse(),
    },
    artifacts: {
      create: (input) => {
        artifactCreate.run({
          ...input,
          messageId: input.messageId ?? null,
          metaJson: input.metaJson ?? null,
        });
      },
      get: (id) => {
        const r = artifactGet.get(id) as any;
        return r ? rowToArtifact(r) : null;
      },
      listByChannel: (channelId, limit) =>
        artifactListByChannel.all(channelId, limit).map(rowToArtifact),
      listByMessage: (messageId) =>
        artifactListByMessage.all(messageId).map(rowToArtifact),
      bindMessageId: (artifactIds, messageId) => {
        for (const id of artifactIds) artifactBindMessage.run(messageId, id);
      },
    },
    tasks: {
      create: (input) => {
        const id = input.id ?? newId();
        const now = input.createdAt;
        taskCreate.run({
          id,
          title: input.title,
          description: input.description ?? null,
          status: input.status ?? 'todo',
          creatorId: input.creatorId,
          assigneeId: input.assigneeId ?? null,
          channelId: input.channelId ?? null,
          tags: JSON.stringify(input.tags ?? []),
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        });
        return rowToTask(taskGet.get(id) as any);
      },
      get: (id) => {
        const r = taskGet.get(id) as any;
        return r ? rowToTask(r) : null;
      },
      list: (channelId) => {
        const rows = channelId ? taskListByChannel.all(channelId) as any[] : taskListAll.all() as any[];
        return rows.map(rowToTask);
      },
      update: (id, input) => {
        const existing = taskGet.get(id) as any;
        if (!existing) return;
        taskUpdate.run({
          id,
          title: input.title ?? existing.title,
          description: input.description !== undefined ? input.description : existing.description,
          status: input.status ?? existing.status,
          assigneeId: input.assigneeId !== undefined ? input.assigneeId : existing.assignee_id,
          channelId: input.channelId !== undefined ? input.channelId : existing.channel_id,
          tags: input.tags ? JSON.stringify(input.tags) : existing.tags,
          sortOrder: input.sortOrder ?? existing.sort_order,
          updatedAt: Date.now(),
        });
      },
      delete: (id) => { taskDelete.run(id); },
      updateStatus: (id, status) => { taskUpdateStatus.run(status, Date.now(), id); },
      updateSort: (id, sortOrder) => { taskUpdateSort.run(sortOrder, Date.now(), id); },
    },
  };
}
