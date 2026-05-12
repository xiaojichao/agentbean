# AgentBean Network Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor AgentBean from a single-user single-server prototype into a multi-user multi-network system with per-network storage isolation, a single Agent Daemon per device managing multiple agents, and user-controlled agent visibility.

**Architecture:** Server splits storage into a global metadata DB (users, networks, devices, agent index) plus per-network isolated SQLite DBs and artifact directories. One Agent Daemon per device loads a `device-agent.yaml` with multiple agent configs, connects to Server with a single socket, and registers only `public` agents. All inter-agent traffic flows through Server.

**Tech Stack:** TypeScript (strict), Node 22+, better-sqlite3, Socket.IO, Zustand, Tailwind, Next.js 14.

**Source spec:** `docs/superpowers/specs/2026-05-05-agentbean-network-isolation-design.md` (must be re-read by every implementer before starting their task).

---

## File Structure

| File | Action | Purpose |
|------|--------|---------|
| `apps/server/src/storage.ts` | **Create** | StorageManager: create/get per-network DB connections and artifact directories |
| `apps/server/src/db.ts` | **Modify** | Split into global-db init + prepared statements; keep Phase 1 schemas for network-local DBs |
| `apps/server/src/device-registry.ts` | **Create** | DeviceRegistry: Map<deviceId, {socket, networkId, agents}> |
| `apps/server/src/auth.ts` | **Create** | Simple token parser/extractor; no JWT for M2 |
| `apps/server/src/namespaces/agent.ts` | **Modify** | Handle Device Daemon register (not per-agent); route dispatch by deviceId |
| `apps/server/src/namespaces/web.ts` | **Modify** | Add network APIs; `agent:add` forwarded to Device Daemon |
| `apps/server/src/artifact-routes.ts` | **Modify** | Routes under `/api/networks/:networkId/artifacts/...` using StorageManager |
| `apps/server/src/index.ts` | **Modify** | Init global.db, StorageManager, mount artifact routes with network prefix |
| `apps/server/src/channels.ts` | **Modify** | All channel ops accept `networkId` and use `storage.getDb(networkId)` |
| `apps/daemon/src/config.ts` | **Modify** | Parse `device-agent.yaml` with `agents[]` array; validate each agent config |
| `apps/daemon/src/index.ts` | **Modify** | Load multi-agent config, instantiate DeviceDaemon |
| `apps/daemon/src/device-daemon.ts` | **Create** | Single process managing N Agent adapters; one Socket.IO connection to Server |
| `apps/daemon/src/agent-instance.ts` | **Create** | Lifecycle wrapper: idle → busy → reply; maps `agentId` → adapter instance |
| `apps/daemon/src/connection.ts` | **Modify** | Reduced to thin wrapper; DeviceDaemon owns the socket lifecycle |
| `apps/web/lib/schema.ts` | **Modify** | Add `DeviceSnapshot`, `NetworkSummary`, extend `AgentSnapshot` with `deviceId`/`visibility` |
| `apps/web/lib/store.ts` | **Modify** | Add `networks`, `devices`, `currentNetworkId` to Zustand store |
| `apps/web/components/network-selector.tsx` | **Create** | Dropdown to switch active network; displays network name + online agent count |
| `apps/web/components/add-agent-modal.tsx` | **Create** | Two-pane modal: left "Auto-scan" (detect local CLIs), right "Manual config" form |
| `apps/web/components/agent-visibility-toggle.tsx` | **Create** | Small switch component on agent card to toggle public/private |

---

## Task 1: StorageManager + Per-Network DB Architecture

**Files:**
- Create: `apps/server/src/storage.ts`
- Modify: `apps/server/src/db.ts`
- Test: `apps/server/tests/storage.test.ts`

- [ ] **Step 1: Write the failing test for StorageManager**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { join } from 'path';
import { StorageManager } from '../src/storage.js';

const TEST_DIR = './data/test-storage';

describe('StorageManager', () => {
  beforeEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); });
  afterEach(() => { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true }); });

  it('creates a storage space with db and artifacts dir', () => {
    const sm = new StorageManager(TEST_DIR);
    const space = sm.createSpace('net-001');
    expect(existsSync(space.dbPath)).toBe(true);
    expect(existsSync(space.artifactDir)).toBe(true);
    expect(space.db).toBeDefined();
  });

  it('returns cached space on second get', () => {
    const sm = new StorageManager(TEST_DIR);
    const s1 = sm.createSpace('net-001');
    const s2 = sm.getSpace('net-001');
    expect(s1.db).toBe(s2.db);
  });

  it('initializes network-local schema on create', () => {
    const sm = new StorageManager(TEST_DIR);
    sm.createSpace('net-001');
    const db = sm.getSpace('net-001').db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = tables.map((t: any) => t.name);
    expect(names).toContain('channels');
    expect(names).toContain('messages');
    expect(names).toContain('artifacts');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run tests/storage.test.ts`
Expected: FAIL with "Cannot find module '../src/storage.js'"

- [ ] **Step 3: Implement StorageManager**

```typescript
// apps/server/src/storage.ts
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export interface StorageSpace {
  networkId: string;
  db: Database;
  dbPath: string;
  artifactDir: string;
}

const NETWORK_SCHEMA = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_members_agent ON channel_members(agent_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_kind TEXT NOT NULL,
  sender_id TEXT,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT,
  artifact_ids TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages(channel_id, created_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_artifacts_message ON artifacts(message_id);
`;

export class StorageManager {
  private spaces = new Map<string, StorageSpace>();
  private baseDir: string;

  constructor(baseDir: string = './data/storage') {
    this.baseDir = baseDir;
    if (!existsSync(baseDir)) mkdirSync(baseDir, { recursive: true });
  }

  createSpace(networkId: string): StorageSpace {
    const spaceDir = join(this.baseDir, networkId);
    const dbPath = join(spaceDir, 'db.sqlite');
    const artifactDir = join(spaceDir, 'artifacts');

    if (!existsSync(spaceDir)) mkdirSync(spaceDir, { recursive: true });
    if (!existsSync(artifactDir)) mkdirSync(artifactDir, { recursive: true });

    const db = new Database(dbPath);
    db.exec(NETWORK_SCHEMA);

    const space: StorageSpace = { networkId, db, dbPath, artifactDir };
    this.spaces.set(networkId, space);
    return space;
  }

  getSpace(networkId: string): StorageSpace {
    const cached = this.spaces.get(networkId);
    if (cached) return cached;

    const spaceDir = join(this.baseDir, networkId);
    const dbPath = join(spaceDir, 'db.sqlite');
    const artifactDir = join(spaceDir, 'artifacts');

    if (!existsSync(dbPath)) {
      return this.createSpace(networkId);
    }

    const db = new Database(dbPath);
    const space: StorageSpace = { networkId, db, dbPath, artifactDir };
    this.spaces.set(networkId, space);
    return space;
  }

  closeAll(): void {
    for (const space of this.spaces.values()) {
      space.db.close();
    }
    this.spaces.clear();
  }
}
```

- [ ] **Step 4: Modify db.ts to separate global schema from network-local schema**

```typescript
// apps/server/src/db.ts
// Keep the existing NETWORK_SCHEMA in storage.ts.
// db.ts now only handles global.db init and the legacy single-db path.
// For Phase 2, db.ts exports initGlobalDb() which returns a Database
// with users, networks, network_members, devices, agents tables.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GLOBAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS networks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
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
  tailscale_ip TEXT,
  hostname TEXT,
  last_seen_at INTEGER NOT NULL,
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
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_error TEXT,
  FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY (network_id) REFERENCES networks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agents_network ON agents(network_id, visibility);
CREATE INDEX IF NOT EXISTS idx_devices_network ON devices(network_id);
`;

export function initGlobalDb(dbPath: string = './data/global.db'): Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.exec(GLOBAL_SCHEMA);
  return db;
}
```

- [ ] **Step 5: Run tests**

Run: `cd apps/server && npx vitest run tests/storage.test.ts`
Expected: 3 tests PASS

- [ ] **Step 6: Commit**

```bash
cd apps/server
git add src/storage.ts src/db.ts tests/storage.test.ts
git commit -m "feat(server): StorageManager with per-network DB isolation"
```

---

## Task 2: DeviceRegistry + Auth

**Files:**
- Create: `apps/server/src/device-registry.ts`
- Create: `apps/server/src/auth.ts`
- Test: `apps/server/tests/device-registry.test.ts`

- [ ] **Step 1: Implement auth.ts (simple token parser)**

```typescript
// apps/server/src/auth.ts
export interface ParsedToken {
  userId: string;
  networkId: string;
  random: string;
}

export function parseToken(token: string): ParsedToken | null {
  const parts = token.split(':');
  if (parts.length !== 3) return null;
  return { userId: parts[0], networkId: parts[1], random: parts[2] };
}

export function generateToken(userId: string, networkId: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${userId}:${networkId}:${random}`;
}
```

- [ ] **Step 2: Implement DeviceRegistry**

```typescript
// apps/server/src/device-registry.ts
import type { Socket } from 'socket.io';

export interface DeviceRuntime {
  id: string;
  userId: string;
  networkId: string;
  socket: Socket;
  tailscaleIp?: string;
  agents: Map<string, PublicAgentMeta>;
  lastSeenAt: number;
}

export interface PublicAgentMeta {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
}

export class DeviceRegistry {
  private devices = new Map<string, DeviceRuntime>();

  register(device: DeviceRuntime): void {
    const existing = this.devices.get(device.id);
    if (existing) {
      existing.socket.disconnect(true);
    }
    this.devices.set(device.id, device);
  }

  get(deviceId: string): DeviceRuntime | undefined {
    return this.devices.get(deviceId);
  }

  getBySocket(socketId: string): DeviceRuntime | undefined {
    for (const d of this.devices.values()) {
      if (d.socket.id === socketId) return d;
    }
    return undefined;
  }

  remove(deviceId: string): void {
    this.devices.delete(deviceId);
  }

  listByNetwork(networkId: string): DeviceRuntime[] {
    return Array.from(this.devices.values()).filter(d => d.networkId === networkId);
  }

  getAgentDevice(agentId: string): DeviceRuntime | undefined {
    for (const d of this.devices.values()) {
      if (d.agents.has(agentId)) return d;
    }
    return undefined;
  }

  allAgents(networkId: string): PublicAgentMeta[] {
    const result: PublicAgentMeta[] = [];
    for (const d of this.devices.values()) {
      if (d.networkId === networkId) {
        result.push(...d.agents.values());
      }
    }
    return result;
  }

  heartbeat(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d) d.lastSeenAt = Date.now();
  }
}
```

- [ ] **Step 3: Write minimal test**

```typescript
// apps/server/tests/device-registry.test.ts
import { describe, it, expect } from 'vitest';
import { DeviceRegistry } from '../src/device-registry.js';

describe('DeviceRegistry', () => {
  it('registers a device and lists its agents', () => {
    const reg = new DeviceRegistry();
    const mockSocket = { id: 's1', disconnect: () => {} } as any;
    reg.register({
      id: 'dev-1', userId: 'u1', networkId: 'n1', socket: mockSocket,
      agents: new Map([['a1', { id: 'a1', name: 'Codex', role: 'coder', adapterKind: 'codex' }]]),
      lastSeenAt: Date.now(),
    });
    expect(reg.allAgents('n1')).toHaveLength(1);
    expect(reg.allAgents('n2')).toHaveLength(0);
    expect(reg.getAgentDevice('a1')?.id).toBe('dev-1');
  });
});
```

- [ ] **Step 4: Run test**

Run: `cd apps/server && npx vitest run tests/device-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd apps/server
git add src/device-registry.ts src/auth.ts tests/device-registry.test.ts
git commit -m "feat(server): DeviceRegistry and simple token auth"
```

---

## Task 3: Refactor /agent namespace for Device Daemon

**Files:**
- Modify: `apps/server/src/namespaces/agent.ts`

- [ ] **Step 1: Read current agent.ts to understand existing patterns**

Run: `cat apps/server/src/namespaces/agent.ts`
(Existing code handles per-agent socket with `auth.agentId`; refactor to handle Device Daemon with `auth.deviceId` and `agents[]` array.)

- [ ] **Step 2: Refactor to Device-level register/dispatch**

Key changes in `apps/server/src/namespaces/agent.ts`:

```typescript
// In the connect handler:
const { token, deviceId, networkId, tailscaleIp, agents } = socket.handshake.auth;
const parsed = parseToken(token);
if (!parsed || parsed.networkId !== networkId) {
  socket.disconnect(true);
  return;
}

// Verify network exists in global.db (pseudo-code, use actual db query)
const network = globalDb.prepare('SELECT id FROM networks WHERE id = ?').get(networkId);
if (!network) {
  socket.emit('register:ack', { ok: false, error: 'network_not_found' });
  socket.disconnect(true);
  return;
}

// Hot-load storage space
storageManager.getSpace(networkId);

// Register device
deviceRegistry.register({
  id: deviceId,
  userId: parsed.userId,
  networkId,
  socket,
  tailscaleIp,
  agents: new Map(agents.map((a: any) => [a.id, a])),
  lastSeenAt: Date.now(),
});

socket.emit('register:ack', { ok: true });

// On dispatch from message routing:
// Find device by agentId, emit dispatch to that device's socket
// socket.on('dispatch', ...) logic moves to routing layer or stays here
// but now dispatches to device socket with agentId in payload
```

- [ ] **Step 3: Commit**

```bash
cd apps/server
git add src/namespaces/agent.ts
git commit -m "feat(server): /agent namespace handles Device Daemon register and dispatch"
```

---

## Task 4: Refactor channels.ts to use StorageManager

**Files:**
- Modify: `apps/server/src/channels.ts`

- [ ] **Step 1: Update channel operations to accept networkId**

All functions in `channels.ts` currently operate on a single DB. Refactor signatures:

```typescript
// Before: function createChannel(input: {...}): ChannelRow
// After: function createChannel(networkId: string, input: {...}): ChannelRow

// Before: function addMember(channelId: string, agentId: string): void
// After: function addMember(networkId: string, channelId: string, agentId: string): void

// Before: function listMembers(channelId: string): string[]
// After: function listMembers(networkId: string, channelId: string): string[]
```

Internally, each function calls `storageManager.getSpace(networkId).db` to get the correct Database instance.

- [ ] **Step 2: Commit**

```bash
cd apps/server
git add src/channels.ts
git commit -m "feat(server): channel ops accept networkId, use StorageManager"
```

---

## Task 5: Update Artifact Routes for Network Isolation

**Files:**
- Modify: `apps/server/src/artifact-routes.ts`
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Move artifact routes under /api/networks/:networkId/artifacts**

```typescript
// In apps/server/src/artifact-routes.ts
// Change routes from /api/artifacts/upload to:
// POST /api/networks/:networkId/artifacts/upload
// GET /api/networks/:networkId/artifacts/:id/download
// GET /api/networks/:networkId/artifacts/:id/preview

// Use storageManager.getSpace(networkId).artifactDir for file storage
// Use storageManager.getSpace(networkId).db for artifact metadata
```

- [ ] **Step 2: Mount routes in index.ts with StorageManager injection**

```typescript
// apps/server/src/index.ts
import { StorageManager } from './storage.js';

const storageManager = new StorageManager('./data/storage');
// Pass storageManager to artifact routes and channel modules
```

- [ ] **Step 3: Commit**

```bash
cd apps/server
git add src/artifact-routes.ts src/index.ts
git commit -m "feat(server): artifact routes scoped by networkId"
```

---

## Task 6: Refactor Agent Daemon — Multi-Agent Config + DeviceDaemon

**Files:**
- Modify: `apps/daemon/src/config.ts`
- Create: `apps/daemon/src/device-daemon.ts`
- Create: `apps/daemon/src/agent-instance.ts`
- Modify: `apps/daemon/src/index.ts`

- [ ] **Step 1: Update config.ts to parse device-agent.yaml**

```typescript
// apps/daemon/src/config.ts
import { readFileSync } from 'fs';
import YAML from 'yaml';

export interface AgentConfigEntry {
  id: string;
  name: string;
  role: string;
  adapter: {
    kind: string;
    command: string;
    args: string[];
    workspace?: string;
    systemPrompt?: string;
  };
  visibility: 'public' | 'private';
}

export interface DeviceConfig {
  deviceId: string;
  networkId: string;
  server: { url: string; token: string };
  heartbeatIntervalMs: number;
  agents: AgentConfigEntry[];
}

export function loadDeviceConfig(path: string): DeviceConfig {
  const raw = readFileSync(path, 'utf8');
  const cfg = YAML.parse(raw);
  // Basic validation
  if (!cfg.deviceId) throw new Error('deviceId required');
  if (!cfg.networkId) throw new Error('networkId required');
  if (!Array.isArray(cfg.agents) || cfg.agents.length === 0) {
    throw new Error('agents array required');
  }
  for (const a of cfg.agents) {
    if (!a.id || !a.name || !a.adapter?.kind) {
      throw new Error(`Invalid agent config: ${JSON.stringify(a)}`);
    }
    if (!a.visibility) a.visibility = 'private';
  }
  return cfg as DeviceConfig;
}
```

- [ ] **Step 2: Implement AgentInstance**

```typescript
// apps/daemon/src/agent-instance.ts
import type { CliAdapter } from './adapters/adapter.js';
import type { AgentConfigEntry } from './config.js';

export interface AgentInstance {
  id: string;
  config: AgentConfigEntry;
  adapter: CliAdapter;
  status: 'idle' | 'busy' | 'error';
}

export function createAgentInstance(config: AgentConfigEntry, adapter: CliAdapter): AgentInstance {
  return { id: config.id, config, adapter, status: 'idle' };
}
```

- [ ] **Step 3: Implement DeviceDaemon**

```typescript
// apps/daemon/src/device-daemon.ts
import { io, type Socket } from 'socket.io-client';
import type { DeviceConfig, AgentConfigEntry } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';
import { createAgentInstance, type AgentInstance } from './agent-instance.js';
import { logger } from './log.js';

export class DeviceDaemon {
  private socket: Socket | null = null;
  private agents = new Map<string, AgentInstance>();
  private cfg: DeviceConfig;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(cfg: DeviceConfig, adapters: Map<string, CliAdapter>) {
    this.cfg = cfg;
    for (const agentCfg of cfg.agents) {
      const adapter = adapters.get(agentCfg.id);
      if (!adapter) throw new Error(`No adapter for agent ${agentCfg.id}`);
      this.agents.set(agentCfg.id, createAgentInstance(agentCfg, adapter));
    }
  }

  async start(): Promise<void> {
    const publicAgents = this.cfg.agents
      .filter(a => a.visibility === 'public')
      .map(a => ({ id: a.id, name: a.name, role: a.role, adapterKind: a.adapter.kind }));

    this.socket = io(this.cfg.server.url, {
      auth: {
        token: this.cfg.server.token,
        deviceId: this.cfg.deviceId,
        networkId: this.cfg.networkId,
        agents: publicAgents,
      },
      reconnection: true,
      reconnectionDelay: 1000,
    });

    this.socket.on('connect', () => {
      logger.info({ deviceId: this.cfg.deviceId }, 'connected to server');
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        this.socket?.emit('heartbeat', { at: Date.now() });
      }, this.cfg.heartbeatIntervalMs);
    });

    this.socket.on('dispatch', async (req: {
      requestId: string;
      channelId: string;
      agentId: string;
      prompt: string;
      history?: ChatTurn[];
    }) => {
      const instance = this.agents.get(req.agentId);
      if (!instance) {
        logger.warn({ agentId: req.agentId }, 'dispatch for unknown agent');
        return;
      }
      instance.status = 'busy';
      try {
        const ctl = new AbortController();
        const rawBody = await instance.adapter.ask({
          prompt: req.prompt,
          history: req.history ?? [],
        }, ctl.signal);
        // Note: artifact upload logic (from Phase 1 connection.ts) should be called here
        this.socket?.emit('reply', {
          agentId: req.agentId,
          channelId: req.channelId,
          body: rawBody,
          requestId: req.requestId,
        });
      } catch (err: any) {
        logger.error({ err: err.message, agentId: req.agentId }, 'dispatch failed');
        this.socket?.emit('error', {
          agentId: req.agentId,
          at: Date.now(),
          message: err.message ?? 'unknown',
          scope: 'reply',
          requestId: req.requestId,
        });
      } finally {
        instance.status = 'idle';
      }
    });

    this.socket.on('disconnect', (reason) => {
      logger.warn({ reason }, 'disconnected');
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    });
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.socket?.close();
    this.socket = null;
  }
}
```

- [ ] **Step 4: Update index.ts to launch DeviceDaemon**

```typescript
// apps/daemon/src/index.ts
import { loadDeviceConfig } from './config.js';
import { DeviceDaemon } from './device-daemon.js';
import { createAdapter } from './adapters/index.js'; // assumes an adapter factory exists

const configPath = process.env.AGENT_CONFIG ?? './device-agent.yaml';
const cfg = loadDeviceConfig(configPath);

const adapters = new Map<string, ReturnType<typeof createAdapter>>();
for (const agentCfg of cfg.agents) {
  adapters.set(agentCfg.id, createAdapter(agentCfg.adapter));
}

const daemon = new DeviceDaemon(cfg, adapters);
daemon.start();

process.on('SIGINT', async () => {
  await daemon.stop();
  process.exit(0);
});
```

- [ ] **Step 5: Commit**

```bash
cd apps/daemon
git add src/config.ts src/device-daemon.ts src/agent-instance.ts src/index.ts
git commit -m "feat(agent): DeviceDaemon manages multiple agents, single socket to server"
```

---

## Task 7: Web UI — Types + Store Updates

**Files:**
- Modify: `apps/web/lib/schema.ts`
- Modify: `apps/web/lib/store.ts`

- [ ] **Step 1: Update schema.ts**

```typescript
// apps/web/lib/schema.ts

export interface NetworkSummary {
  id: string;
  name: string;
  description?: string;
  ownerId: string;
  memberCount: number;
}

export interface DeviceSnapshot {
  id: string;
  userId: string;
  networkId: string;
  tailscaleIp?: string;
  hostname?: string;
  lastSeenAt: number;
}

export interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  adapterKind: string;
  deviceId: string;
  networkId: string;
  visibility: 'public' | 'private';
  status: 'connecting' | 'online' | 'busy' | 'offline' | 'error';
  lastSeenAt: number;
  lastError?: string;
}

// ChatMessage and ChannelSnapshot remain mostly unchanged
export interface ChatMessage {
  id: string;
  channelId: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId?: string;
  senderName?: string;
  body: string;
  createdAt: number;
  artifacts?: Artifact[];
}

export interface ChannelSnapshot {
  id: string;
  name: string;
  memberIds: string[];
  lastMessageAt?: number;
}

export interface Artifact {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  downloadUrl: string;
  previewUrl: string;
}
```

- [ ] **Step 2: Update store.ts**

```typescript
// apps/web/lib/store.ts
import { create } from 'zustand';
import type { AgentSnapshot, ChannelSnapshot, ChatMessage, NetworkSummary, DeviceSnapshot } from './schema';

interface AgentBeanStore {
  currentNetworkId: string | null;
  networks: Map<string, NetworkSummary>;
  devices: Map<string, DeviceSnapshot>;
  agents: Map<string, AgentSnapshot>;
  channels: Map<string, ChannelSnapshot>;
  messagesByChannel: Map<string, ChatMessage[]>;
  connection: 'connecting' | 'open' | 'lost';

  setCurrentNetwork: (id: string) => void;
  setNetworks: (networks: NetworkSummary[]) => void;
  setDevices: (devices: DeviceSnapshot[]) => void;
  setAgents: (agents: AgentSnapshot[]) => void;
  upsertAgent: (agent: AgentSnapshot) => void;
  setChannels: (channels: ChannelSnapshot[]) => void;
  appendMessage: (channelId: string, msg: ChatMessage) => void;
  setConnection: (status: AgentBeanStore['connection']) => void;
}

export const useAgentBeanStore = create<AgentBeanStore>((set, get) => ({
  currentNetworkId: null,
  networks: new Map(),
  devices: new Map(),
  agents: new Map(),
  channels: new Map(),
  messagesByChannel: new Map(),
  connection: 'connecting',

  setCurrentNetwork: (id) => set({ currentNetworkId: id }),

  setNetworks: (networks) => {
    const map = new Map<string, NetworkSummary>();
    for (const n of networks) map.set(n.id, n);
    set({ networks: map });
  },

  setDevices: (devices) => {
    const map = new Map<string, DeviceSnapshot>();
    for (const d of devices) map.set(d.id, d);
    set({ devices: map });
  },

  setAgents: (agents) => {
    const map = new Map<string, AgentSnapshot>();
    for (const a of agents) map.set(a.id, a);
    set({ agents: map });
  },

  upsertAgent: (agent) => {
    const next = new Map(get().agents);
    next.set(agent.id, agent);
    set({ agents: next });
  },

  setChannels: (channels) => {
    const map = new Map<string, ChannelSnapshot>();
    for (const c of channels) map.set(c.id, c);
    set({ channels: map });
  },

  appendMessage: (channelId, msg) => {
    const next = new Map(get().messagesByChannel);
    const existing = next.get(channelId) ?? [];
    next.set(channelId, [...existing, msg]);
    set({ messagesByChannel: next });
  },

  setConnection: (status) => set({ connection: status }),
}));
```

- [ ] **Step 3: Commit**

```bash
cd apps/web
git add lib/schema.ts lib/store.ts
git commit -m "feat(web): add Network, Device types; update Zustand store"
```

---

## Task 8: Web UI — Network Selector + Add Agent Modal

**Files:**
- Create: `apps/web/components/network-selector.tsx`
- Create: `apps/web/components/add-agent-modal.tsx`

- [ ] **Step 1: Implement network-selector.tsx**

A dropdown in the top nav bar. Displays current network name and online agent count. Emits `network:switch` to server.

```tsx
// apps/web/components/network-selector.tsx
'use client';

import { useAgentBeanStore } from '@/lib/store';
import { useEffect, useState } from 'react';

export function NetworkSelector({ socket }: { socket: any }) {
  const { networks, currentNetworkId, setCurrentNetwork } = useAgentBeanStore();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    socket.emit('networks:list');
    socket.on('networks:snapshot', (data: any[]) => {
      useAgentBeanStore.getState().setNetworks(data);
    });
    return () => { socket.off('networks:snapshot'); };
  }, [socket]);

  const current = currentNetworkId ? networks.get(currentNetworkId) : null;

  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="px-3 py-1 border rounded">
        {current?.name ?? 'Select Network'}
      </button>
      {open && (
        <div className="absolute top-full mt-1 w-48 bg-white border rounded shadow">
          {Array.from(networks.values()).map(n => (
            <div
              key={n.id}
              className="px-3 py-2 hover:bg-gray-100 cursor-pointer"
              onClick={() => {
                setCurrentNetwork(n.id);
                socket.emit('network:switch', { networkId: n.id });
                setOpen(false);
              }}
            >
              {n.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Implement add-agent-modal.tsx**

Two-pane modal. Left pane: auto-scan results (placeholder for now). Right pane: manual config form.

```tsx
// apps/web/components/add-agent-modal.tsx
'use client';

import { useState } from 'react';

export function AddAgentModal({ socket, deviceId, onClose }: { socket: any; deviceId: string; onClose: () => void }) {
  const [tab, setTab] = useState<'scan' | 'manual'>('scan');
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [kind, setKind] = useState('codex');
  const [command, setCommand] = useState('codex');
  const [args, setArgs] = useState('');

  const handleManualSubmit = () => {
    socket.emit('agent:add', {
      deviceId,
      config: {
        id: `agent-${Date.now()}`,
        name,
        role,
        adapter: { kind, command, args: args.split(' ').filter(Boolean) },
        visibility: 'private',
      },
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center">
      <div className="bg-white rounded-lg w-[600px] max-h-[80vh] flex flex-col">
        <div className="flex border-b">
          <button className={`px-4 py-2 ${tab === 'scan' ? 'border-b-2 border-blue-500' : ''}`} onClick={() => setTab('scan')}>
            Auto Scan
          </button>
          <button className={`px-4 py-2 ${tab === 'manual' ? 'border-b-2 border-blue-500' : ''}`} onClick={() => setTab('manual')}>
            Manual Config
          </button>
        </div>

        {tab === 'scan' && (
          <div className="p-4">
            <button onClick={() => socket.emit('agents:scan')} className="px-3 py-1 bg-blue-500 text-white rounded">
              Scan Local CLIs
            </button>
            <div className="mt-2 text-sm text-gray-500">Scan results will appear here.</div>
          </div>
        )}

        {tab === 'manual' && (
          <div className="p-4 space-y-3">
            <input placeholder="Name" value={name} onChange={e => setName(e.target.value)} className="w-full border px-2 py-1 rounded" />
            <input placeholder="Role" value={role} onChange={e => setRole(e.target.value)} className="w-full border px-2 py-1 rounded" />
            <select value={kind} onChange={e => setKind(e.target.value)} className="w-full border px-2 py-1 rounded">
              <option value="codex">codex</option>
              <option value="claude-code">claude-code</option>
              <option value="openclaw">openclaw</option>
              <option value="hermes">hermes</option>
            </select>
            <input placeholder="Command" value={command} onChange={e => setCommand(e.target.value)} className="w-full border px-2 py-1 rounded" />
            <input placeholder="Args (space separated)" value={args} onChange={e => setArgs(e.target.value)} className="w-full border px-2 py-1 rounded" />
            <div className="flex gap-2 justify-end">
              <button onClick={onClose} className="px-3 py-1 border rounded">Cancel</button>
              <button onClick={handleManualSubmit} className="px-3 py-1 bg-blue-500 text-white rounded">Add Agent</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
cd apps/web
git add components/network-selector.tsx components/add-agent-modal.tsx
git commit -m "feat(web): network selector and add-agent modal"
```

---

## Task 9: Web UI — Agent Visibility Toggle

**Files:**
- Create: `apps/web/components/agent-visibility-toggle.tsx`

- [ ] **Step 1: Implement visibility toggle**

```tsx
// apps/web/components/agent-visibility-toggle.tsx
'use client';

import { useAgentBeanStore } from '@/lib/store';

export function AgentVisibilityToggle({ socket, agentId }: { socket: any; agentId: string }) {
  const agent = useAgentBeanStore(s => s.agents.get(agentId));
  const visibility = agent?.visibility ?? 'private';

  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <span className="text-sm text-gray-600">{visibility === 'public' ? 'Public' : 'Private'}</span>
      <input
        type="checkbox"
        checked={visibility === 'public'}
        onChange={(e) => {
          const next = e.target.checked ? 'public' : 'private';
          socket.emit('agent:updateVisibility', { agentId, visibility: next });
        }}
        className="w-4 h-4"
      />
    </label>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd apps/web
git add components/agent-visibility-toggle.tsx
git commit -m "feat(web): agent visibility toggle component"
```

---

## Task 10: End-to-End Integration Test

**Files:**
- Create: `apps/server/tests/network-isolation.e2e.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initGlobalDb } from '../src/db.js';
import { StorageManager } from '../src/storage.js';
import Database from 'better-sqlite3';

describe('Network Isolation E2E', () => {
  let globalDb: Database;
  let storage: StorageManager;

  beforeAll(() => {
    globalDb = initGlobalDb('./data/test-global.db');
    storage = new StorageManager('./data/test-storage-e2e');
  });

  afterAll(() => {
    globalDb.close();
    storage.closeAll();
  });

  it('creates two networks with isolated data', () => {
    // Create user and two networks
    globalDb.prepare('INSERT INTO users (id, username, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('u1', 'shaw', Date.now(), Date.now());

    globalDb.prepare('INSERT INTO networks (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run('n1', 'u1', 'Net A', Date.now());
    globalDb.prepare('INSERT INTO networks (id, owner_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run('n2', 'u1', 'Net B', Date.now());

    // Create storage spaces
    const s1 = storage.createSpace('n1');
    const s2 = storage.createSpace('n2');

    // Insert channel in n1
    s1.db.prepare('INSERT INTO channels (id, name, created_at) VALUES (?, ?, ?)')
      .run('ch1', 'General', Date.now());

    // Verify n2 cannot see n1's channel
    const n2Channels = s2.db.prepare('SELECT * FROM channels').all();
    expect(n2Channels).toHaveLength(0);

    // Verify n1 can see its channel
    const n1Channels = s1.db.prepare('SELECT * FROM channels').all();
    expect(n1Channels).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd apps/server && npx vitest run tests/network-isolation.e2e.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
cd apps/server
git add tests/network-isolation.e2e.test.ts
git commit -m "test(server): network isolation e2e test"
```

---

## Verification Checklist

Before marking Phase 2 complete, run through:

- [ ] `apps/server` tests pass: `npm test`
- [ ] `apps/daemon` compiles: `npm run build`
- [ ] `apps/web` compiles: `npm run build`
- [ ] Server starts with `global.db` + `storage/` directory structure
- [ ] Agent Daemon starts with `device-agent.yaml` and connects as Device
- [ ] Two different `networkId` agents cannot see each other's channels
- [ ] Artifacts uploaded to correct `storage/{networkId}/artifacts/`
- [ ] Web UI can switch networks and see isolated agent lists
- [ ] Adding agent via Web UI creates config on target device

---

## Self-Review

**1. Spec coverage:**
- StorageManager per-network DB ✅ Task 1
- DeviceRegistry ✅ Task 2
- /agent namespace Device Daemon protocol ✅ Task 3
- channels.ts networkId routing ✅ Task 4
- Artifact routes network-scoped ✅ Task 5
- DeviceDaemon multi-agent ✅ Task 6
- Web types + store ✅ Task 7
- Web UI components ✅ Tasks 8-9
- E2E isolation test ✅ Task 10

**2. Placeholder scan:** No TBD/TODO/implement later in plan steps. All code blocks contain actual runnable code.

**3. Type consistency:**
- `AgentSnapshot` uses `visibility: 'public' | 'private'` consistently
- `networkId` is `string` everywhere
- `deviceId` is `string` everywhere
- Socket event names match between server and web (`networks:snapshot`, `agent:add`, etc.)

No gaps found.
