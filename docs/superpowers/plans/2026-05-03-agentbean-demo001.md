# AgentBean demo001 (Agent-Only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the AgentBean demo001 minimum viable loop — user opens `/agents`, sees real CLI-backed agents, creates a channel with selected agents, agents self-introduce, and the user chats with at least one agent in that channel.

**Architecture:** Three long-lived processes — `apps/web` (Next.js 14 + Tailwind + shadcn-style components), `apps/server` (Node + Express + Socket.IO + better-sqlite3), and N × `apps/agent` daemons (Node + socket.io-client + js-yaml). Server is the single state authority; daemons spawn real CLIs (Codex, Claude Code, OpenClaw, Hermes) per request via `child_process.spawn`. Two Socket.IO namespaces: `/web` (anonymous) and `/agent` (token auth).

**Tech Stack:** TypeScript (strict), Node 20+, Next.js 14 App Router, Tailwind CSS 3.4, Zustand, Socket.IO 4.7, better-sqlite3 11, pino, ulid, vitest, supertest, tsx, js-yaml.

**Source spec:** `docs/superpowers/specs/2026-05-03-agentbean-demo001-design.md` (must be re-read by every implementer before starting their task).

---

## File Structure

Outer repo `/Users/shaw/AgentBean/` keeps `docs/` and a `.gitignore` that excludes nested `.git/`, `node_modules`, `.next`, `dist`, `coverage`, `apps/server/data/`. Each app under `apps/` is its own independent git repo.

```
/Users/shaw/AgentBean/
├── .git/
├── .gitignore                              [M0-1]
├── README.md
├── docs/
│   ├── demo001/
│   └── superpowers/
│       ├── specs/2026-05-03-agentbean-demo001-design.md
│       └── plans/2026-05-03-agentbean-demo001.md   (this file)
└── apps/
    ├── .gitkeep                            [M0-1]
    ├── web/                                (independent .git, [M0-6])
    │   ├── package.json
    │   ├── next.config.mjs
    │   ├── tsconfig.json
    │   ├── tailwind.config.ts
    │   ├── postcss.config.mjs
    │   ├── .gitignore
    │   ├── .env.example
    │   ├── app/
    │   │   ├── layout.tsx
    │   │   ├── globals.css
    │   │   ├── page.tsx                    (redirect → /agents)
    │   │   ├── agents/
    │   │   │   ├── page.tsx                [M1-7]
    │   │   │   └── [agentId]/page.tsx      [M3-4]
    │   │   ├── channels/
    │   │   │   ├── page.tsx                [M2-7]
    │   │   │   └── [channelId]/page.tsx    [M2-7]
    │   │   └── api/
    │   ├── components/
    │   │   ├── sidebar.tsx                 [M0-6]
    │   │   ├── agent-card.tsx              [M1-7]
    │   │   ├── agent-status-badge.tsx      [M1-7]
    │   │   ├── new-channel-dialog.tsx      [M2-6]
    │   │   ├── channel-message.tsx         [M2-7, polish M3-5]
    │   │   ├── channel-input.tsx           [M2-7]
    │   │   └── connection-banner.tsx       [M0-6, wired M3-5]
    │   ├── lib/
    │   │   ├── socket.ts                   [M1-6]
    │   │   ├── store.ts                    [M1-6, M2-6, selector M3-4]
    │   │   ├── format-time.ts              [M1-7]
    │   │   └── schema.ts                   (shared event types, [M1-6, M2-6])
    │   └── tests/
    │       └── format-time.test.ts         [M1-7]
    │
    ├── server/                             (independent .git, [M0-2])
    │   ├── package.json
    │   ├── tsconfig.json
    │   ├── vitest.config.ts
    │   ├── .env.example
    │   ├── .gitignore
    │   ├── data/                           (gitignored, runtime)
    │   ├── src/
    │   │   ├── index.ts                    [M0-2, expanded M1-1]
    │   │   ├── log.ts                      [M0-2]
    │   │   ├── db.ts                       [M0-3]
    │   │   ├── registry.ts                 [M1-2]
    │   │   ├── heartbeat-scanner.ts        [M1-4]
    │   │   ├── connect-command.ts          [M1-3]
    │   │   ├── namespaces/
    │   │   │   └── agent.ts                [M1-3, M2-2, M2-3]
    │   │   ├── channels.ts                 [M2-1]
    │   │   ├── routing.ts                  [M3-1]
    │   │   ├── intro.ts                    [M2-2]
    │   │   ├── prompt.ts                   (shared template helpers, M2-2)
    │   │   └── ids.ts                      (ulid wrapper, [M0-3])
    │   └── tests/
    │       ├── healthz.test.ts             [M0-2]
    │       ├── db.test.ts                  [M0-3]
    │       ├── registry.test.ts            [M1-2]
    │       ├── heartbeat-scanner.test.ts   [M1-4]
    │       ├── connect-command.test.ts     [M1-3]
    │       ├── agent-namespace.test.ts     [M1-3, M2-3]
    │       ├── web-namespace.test.ts       [M1-5, M2-4]
    │       ├── channels.test.ts            [M2-1]
    │       ├── routing.test.ts             [M3-1]
    │       └── intro.test.ts               [M2-2]
    │
    └── agent/                              (independent .git, [M0-4])
        ├── package.json
        ├── tsconfig.json
        ├── vitest.config.ts
        ├── .env.example
        ├── .gitignore
        ├── examples/
        │   ├── agent.config.yaml.example   [M0-4]
        │   ├── codex-shaw.yaml.example     [M1-8]
        │   └── claude-code-shaw.yaml.example  [M3-3]
        ├── src/
        │   ├── index.ts                    [M0-5, M2-5, M3-3, M4-1, M4-2]
        │   ├── config.ts                   [M0-4]
        │   ├── connection.ts               [M0-5, M2-5]
        │   ├── log.ts                      [M0-4]
        │   └── adapters/
        │       ├── adapter.ts              [M0-5]
        │       ├── codex.ts                [M2-5]
        │       ├── claude-code.ts          [M3-3]
        │       ├── openclaw.ts             [M4-1] (optional)
        │       └── hermes.ts               [M4-1] (optional)
        └── tests/
            ├── config.test.ts              [M0-4]
            ├── adapter.test.ts             [M2-5]
            └── codex-stub.test.ts          [M2-5]
```

Bracketed labels (e.g. `[M0-2]`) point to the task that creates or first edits the file.

---

## M0 — Project Scaffold

Verifies all three processes can start, that the server health endpoint is green, and that the web app renders the empty `agents` page. No real Agent logic yet.

### Task M0-1: Outer-repo `.gitignore` and `apps/` placeholder

**Files:**
- Create: `/Users/shaw/AgentBean/.gitignore`
- Create: `/Users/shaw/AgentBean/apps/.gitkeep`

- [ ] **Step 1: Confirm we are in the right repo**

Run: `git -C /Users/shaw/AgentBean rev-parse --show-toplevel`
Expected: `/Users/shaw/AgentBean`

- [ ] **Step 2: Create the outer `.gitignore`**

Write `/Users/shaw/AgentBean/.gitignore`:

```gitignore
# Inner repos own their own history — don't double-track them
apps/*/.git/
apps/*/.git
apps/*/node_modules/
apps/*/.next/
apps/*/dist/
apps/*/coverage/
apps/*/.turbo/
apps/server/data/

# OS / editor
.DS_Store
.vscode/
.idea/
*.log
```

- [ ] **Step 3: Create the placeholder so an empty `apps/` is tracked**

Write `/Users/shaw/AgentBean/apps/.gitkeep` with an empty body.

- [ ] **Step 4: Stage and commit**

```bash
cd /Users/shaw/AgentBean
git add .gitignore apps/.gitkeep
git commit -m "chore: add gitignore for nested app repos"
```

Expected: one new commit on `docs/demo001`.

---

### Task M0-2: `apps/server` scaffold (Express + Socket.IO + tests)

**Files:**
- Init: `apps/server/.git/`
- Create: `apps/server/package.json`, `apps/server/tsconfig.json`, `apps/server/vitest.config.ts`, `apps/server/.env.example`, `apps/server/.gitignore`
- Create: `apps/server/src/log.ts`
- Create: `apps/server/src/index.ts`
- Test: `apps/server/tests/healthz.test.ts`

- [ ] **Step 1: Initialise the inner repo**

```bash
cd /Users/shaw/AgentBean/apps
mkdir server
cd server
git init -q -b main
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "agentbean-server",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "better-sqlite3": "^11.3.0",
    "express": "^4.21.0",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "socket.io": "^4.7.5",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.16.5",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.2",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 5: Write `.env.example` and `.gitignore`**

`.env.example`:

```
PORT=4000
AGENT_BEAN_AGENT_TOKEN=dev-token-change-me
DATABASE_PATH=./data/agentbean.db
LOG_LEVEL=info
```

`.gitignore`:

```
node_modules/
dist/
coverage/
data/
.env
.env.local
```

- [ ] **Step 6: Install deps**

```bash
cd /Users/shaw/AgentBean/apps/server
npm install
```

Expected: `node_modules/` populated, `package-lock.json` created.

- [ ] **Step 7: Write the failing healthz test**

`apps/server/tests/healthz.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/index.js';

const app = buildApp();

afterAll(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  it('returns 200 with status:ok', async () => {
    const res = await request(app.http).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});
```

- [ ] **Step 8: Run the test (must fail because src is missing)**

Run: `npm test`
Expected: FAIL with "Cannot find module ../src/index.js" (or build error). Confirms the test runs before we implement.

- [ ] **Step 9: Implement `src/log.ts`**

```ts
import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});

export type Logger = typeof logger;
```

- [ ] **Step 10: Implement `src/index.ts` (minimal happy path)**

```ts
import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { logger } from './log.js';

export interface AppHandle {
  http: http.Server;
  io: IOServer;
  close: () => Promise<void>;
}

export function buildApp(opts: { port?: number } = {}): AppHandle {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  const server = http.createServer(app);
  const io = new IOServer(server, {
    cors: { origin: '*' },
  });

  io.of('/web').on('connection', (socket) => {
    logger.info({ id: socket.id }, '/web client connected');
  });
  io.of('/agent').on('connection', (socket) => {
    logger.info({ id: socket.id }, '/agent client connected');
  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => logger.info({ port: opts.port }, 'server listening'));
  }

  return {
    http: server,
    io,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  buildApp({ port });
}
```

- [ ] **Step 11: Re-run the test**

Run: `npm test`
Expected: PASS — 1 passed.

- [ ] **Step 12: Smoke `npm run dev`**

```bash
cd /Users/shaw/AgentBean/apps/server
npm run dev &
DEV_PID=$!
sleep 2
curl -sf http://localhost:4000/healthz
kill $DEV_PID
```

Expected: `{"status":"ok"}` printed, dev server exits cleanly.

- [ ] **Step 13: Commit**

```bash
cd /Users/shaw/AgentBean/apps/server
git add .
git commit -m "feat(server): scaffold express + socket.io with healthz"
```

---

### Task M0-3: SQLite schema and DAO (`db.ts`)

**Files:**
- Create: `apps/server/src/db.ts`
- Create: `apps/server/src/ids.ts`
- Test: `apps/server/tests/db.test.ts`

- [ ] **Step 1: Write the failing schema/DAO test**

`apps/server/tests/db.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type Db } from '../src/db.js';

let dbPath: string;
let db: Db;

beforeEach(() => {
  dbPath = join(tmpdir(), `agentbean-test-${Date.now()}-${Math.random()}.db`);
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  try { unlinkSync(dbPath); } catch {}
});

describe('openDb', () => {
  it('creates the four core tables', () => {
    const names = db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all()
      .map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['agents', 'channel_members', 'channels', 'messages']));
  });

  it('agents.upsert / getAll round-trips fields', () => {
    db.agents.upsert({
      id: 'a1', name: 'Shaw-A1', role: 'social', adapterKind: 'codex',
      firstSeenAt: 100, lastSeenAt: 200, lastError: null,
    });
    db.agents.upsert({
      id: 'a1', name: 'Shaw-A1', role: 'social', adapterKind: 'codex',
      firstSeenAt: 100, lastSeenAt: 300, lastError: 'oops',
    });
    const all = db.agents.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: 'a1', lastSeenAt: 300, lastError: 'oops' });
  });

  it('channels.create + channelMembers.add wires foreign keys', () => {
    const c = db.channels.create({ name: 'channel-1', createdAt: 10 });
    expect(c.id).toBeTruthy();
    db.agents.upsert({
      id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex',
      firstSeenAt: 1, lastSeenAt: 1, lastError: null,
    });
    db.channelMembers.add({ channelId: c.id, agentId: 'a1', joinedAt: 11 });
    const members = db.channelMembers.list(c.id);
    expect(members).toEqual([{ channelId: c.id, agentId: 'a1', joinedAt: 11 }]);
  });

  it('messages.append + listByChannel orders by created_at', () => {
    const c = db.channels.create({ name: 'c', createdAt: 0 });
    db.messages.append({ id: 'm2', channelId: c.id, senderKind: 'human', senderId: null, body: 'two', createdAt: 200, metaJson: null });
    db.messages.append({ id: 'm1', channelId: c.id, senderKind: 'system', senderId: null, body: 'one', createdAt: 100, metaJson: null });
    const list = db.messages.listByChannel(c.id, 10);
    expect(list.map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

Run: `npm test -- tests/db.test.ts`
Expected: FAIL — module `../src/db.js` not found.

- [ ] **Step 3: Implement `src/ids.ts`**

```ts
import { ulid } from 'ulid';
export const newId = () => ulid();
```

- [ ] **Step 4: Implement `src/db.ts`**

```ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { newId } from './ids.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT,
  adapter_kind  TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  last_error    TEXT
);
CREATE TABLE IF NOT EXISTS channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
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
`;

export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes';
export type SenderKind = 'human' | 'agent' | 'system';

export interface AgentRow {
  id: string;
  name: string;
  role: string | null;
  adapterKind: AdapterKind;
  firstSeenAt: number;
  lastSeenAt: number;
  lastError: string | null;
}

export interface ChannelRow { id: string; name: string; createdAt: number; }
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

export interface Db {
  raw: Database.Database;
  close: () => void;
  agents: {
    upsert(row: AgentRow): void;
    getAll(): AgentRow[];
    get(id: string): AgentRow | null;
  };
  channels: {
    create(input: { name: string; createdAt: number; id?: string }): ChannelRow;
    list(): ChannelRow[];
    get(id: string): ChannelRow | null;
  };
  channelMembers: {
    add(m: ChannelMember): void;
    list(channelId: string): ChannelMember[];
    forAgent(agentId: string): ChannelMember[];
  };
  messages: {
    append(m: MessageRow): void;
    listByChannel(channelId: string, limit: number): MessageRow[];
  };
}

function rowToAgent(r: any): AgentRow {
  return {
    id: r.id, name: r.name, role: r.role, adapterKind: r.adapter_kind,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, lastError: r.last_error,
  };
}
function rowToMessage(r: any): MessageRow {
  return {
    id: r.id, channelId: r.channel_id, senderKind: r.sender_kind,
    senderId: r.sender_id, body: r.body, createdAt: r.created_at, metaJson: r.meta_json,
  };
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.exec(SCHEMA);

  const agentUpsert = raw.prepare(`
    INSERT INTO agents (id, name, role, adapter_kind, first_seen_at, last_seen_at, last_error)
    VALUES (@id, @name, @role, @adapterKind, @firstSeenAt, @lastSeenAt, @lastError)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      role = excluded.role,
      adapter_kind = excluded.adapter_kind,
      last_seen_at = excluded.last_seen_at,
      last_error   = excluded.last_error
  `);
  const agentGetAll = raw.prepare(`SELECT * FROM agents ORDER BY first_seen_at`);
  const agentGet = raw.prepare(`SELECT * FROM agents WHERE id = ?`);

  const channelCreate = raw.prepare(`
    INSERT INTO channels (id, name, created_at) VALUES (@id, @name, @createdAt)
  `);
  const channelList = raw.prepare(`SELECT id, name, created_at AS createdAt FROM channels ORDER BY created_at`);
  const channelGet = raw.prepare(`SELECT id, name, created_at AS createdAt FROM channels WHERE id = ?`);

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

  const messageAppend = raw.prepare(`
    INSERT INTO messages (id, channel_id, sender_kind, sender_id, body, created_at, meta_json)
    VALUES (@id, @channelId, @senderKind, @senderId, @body, @createdAt, @metaJson)
  `);
  const messageList = raw.prepare(`
    SELECT * FROM messages WHERE channel_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `);

  return {
    raw,
    close: () => raw.close(),
    agents: {
      upsert: (row) => { agentUpsert.run(row); },
      getAll: () => agentGetAll.all().map(rowToAgent),
      get: (id) => {
        const r = agentGet.get(id) as any;
        return r ? rowToAgent(r) : null;
      },
    },
    channels: {
      create: ({ name, createdAt, id }) => {
        const cid = id ?? newId();
        channelCreate.run({ id: cid, name, createdAt });
        return { id: cid, name, createdAt };
      },
      list: () => channelList.all() as ChannelRow[],
      get: (id) => (channelGet.get(id) as ChannelRow | undefined) ?? null,
    },
    channelMembers: {
      add: (m) => { memberAdd.run(m); },
      list: (channelId) => memberListByChannel.all(channelId) as ChannelMember[],
      forAgent: (agentId) => memberListByAgent.all(agentId) as ChannelMember[],
    },
    messages: {
      append: (m) => { messageAppend.run(m); },
      listByChannel: (channelId, limit) =>
        messageList.all(channelId, limit).map(rowToMessage),
    },
  };
}
```

- [ ] **Step 5: Re-run the test**

Run: `npm test -- tests/db.test.ts`
Expected: PASS — 4 passed.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts src/ids.ts tests/db.test.ts package.json package-lock.json
git commit -m "feat(server): SQLite schema, DAOs, and ULID helper"
```

---

### Task M0-4: `apps/agent` scaffold + config loader

**Files:**
- Init: `apps/agent/.git/`
- Create: `apps/agent/package.json`, `apps/agent/tsconfig.json`, `apps/agent/vitest.config.ts`, `apps/agent/.env.example`, `apps/agent/.gitignore`
- Create: `apps/agent/src/log.ts`, `apps/agent/src/config.ts`
- Create: `apps/agent/examples/agent.config.yaml.example`
- Test: `apps/agent/tests/config.test.ts`

- [ ] **Step 1: Init the inner repo and seed configs**

```bash
cd /Users/shaw/AgentBean/apps
mkdir agent
cd agent
git init -q -b main
mkdir -p src/adapters tests examples
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "agentbean-agent",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "js-yaml": "^4.1.0",
    "pino": "^9.4.0",
    "pino-pretty": "^11.2.2",
    "socket.io-client": "^4.7.5",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.16.5",
    "tsx": "^4.19.0",
    "typescript": "^5.6.2",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`**

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 10_000 },
});
```

`.env.example`:

```
AGENT_BEAN_SERVER_URL=http://localhost:4000/agent
AGENT_BEAN_AGENT_TOKEN=dev-token-change-me
AGENT_CONFIG=./examples/agent.config.yaml.example
LOG_LEVEL=info
```

`.gitignore`:

```
node_modules/
dist/
coverage/
.env
.env.local
```

- [ ] **Step 4: Install deps**

```bash
cd /Users/shaw/AgentBean/apps/agent
npm install
```

- [ ] **Step 5: Write `examples/agent.config.yaml.example`**

```yaml
id: shaw-a1-social
name: 肖-a1-社媒
role: 社交媒体运营
adapter:
  kind: codex
  command: codex
  args: ['--no-banner']
  cwd: ~/projects/social
  systemPrompt: |
    你是肖团队的社媒运营助手。简洁地用中文回答。
server:
  url: ${AGENT_BEAN_SERVER_URL}
  token: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000
```

- [ ] **Step 6: Write the failing config test**

`tests/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';

let cfgPath: string;
beforeEach(() => { cfgPath = join(tmpdir(), `cfg-${Date.now()}-${Math.random()}.yaml`); });
afterEach(() => { try { unlinkSync(cfgPath); } catch {} });

const baseYaml = `id: a1
name: Shaw-A1
role: social
adapter:
  kind: codex
  command: codex
server:
  url: \${TEST_SERVER_URL}
  token: \${TEST_TOKEN}
`;

describe('loadConfig', () => {
  it('parses YAML and applies env interpolation', () => {
    process.env.TEST_SERVER_URL = 'http://x:4000/agent';
    process.env.TEST_TOKEN = 'tok';
    writeFileSync(cfgPath, baseYaml);
    const cfg = loadConfig(cfgPath);
    expect(cfg.id).toBe('a1');
    expect(cfg.adapter.kind).toBe('codex');
    expect(cfg.server.url).toBe('http://x:4000/agent');
    expect(cfg.server.token).toBe('tok');
    expect(cfg.heartbeatIntervalMs).toBe(10_000);
    expect(cfg.adapter.args).toEqual([]);
  });

  it('rejects unknown adapter.kind', () => {
    writeFileSync(cfgPath, `id: a
name: A
role: r
adapter: { kind: bogus, command: x }
server: { url: u, token: t }
`);
    expect(() => loadConfig(cfgPath)).toThrow(/adapter.kind/);
  });

  it('requires id, name, role', () => {
    writeFileSync(cfgPath, `id: ''
name: ''
role: ''
adapter: { kind: codex, command: x }
server: { url: u, token: t }
`);
    expect(() => loadConfig(cfgPath)).toThrow(/required/);
  });
});
```

- [ ] **Step 7: Run the test (must fail)**

Run: `npm test`
Expected: FAIL — module `../src/config.js` not found.

- [ ] **Step 8: Implement `src/log.ts`**

```ts
import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: process.env.NODE_ENV === 'production'
    ? undefined
    : { target: 'pino-pretty', options: { colorize: true } },
});
```

- [ ] **Step 9: Implement `src/config.ts`**

```ts
import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes';
const KINDS: AdapterKind[] = ['codex', 'claude-code', 'openclaw', 'hermes'];

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  adapter: {
    kind: AdapterKind;
    command: string;
    args: string[];
    cwd?: string;
    systemPrompt?: string;
  };
  server: { url: string; token: string };
  heartbeatIntervalMs: number;
}

const ENV_PATTERN = /\$\{([A-Z0-9_]+)\}/g;

function interpolate(value: string): string {
  return value.replace(ENV_PATTERN, (_match, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config references missing env var: ${name}`);
    return v;
  });
}

function deepInterpolate(node: unknown): unknown {
  if (typeof node === 'string') return interpolate(node);
  if (Array.isArray(node)) return node.map(deepInterpolate);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = deepInterpolate(v);
    return out;
  }
  return node;
}

export function loadConfig(path: string): AgentConfig {
  const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('config: top-level must be a mapping');
  const interp = deepInterpolate(raw) as Record<string, any>;

  const need = ['id', 'name', 'role'] as const;
  for (const k of need) {
    if (typeof interp[k] !== 'string' || interp[k].length === 0) {
      throw new Error(`config: ${k} is required (non-empty string)`);
    }
  }
  const a = interp.adapter ?? {};
  if (!KINDS.includes(a.kind)) {
    throw new Error(`config: adapter.kind must be one of ${KINDS.join(', ')}`);
  }
  if (typeof a.command !== 'string') {
    throw new Error('config: adapter.command is required');
  }
  const s = interp.server ?? {};
  if (typeof s.url !== 'string' || typeof s.token !== 'string') {
    throw new Error('config: server.url and server.token are required');
  }

  return {
    id: interp.id,
    name: interp.name,
    role: interp.role,
    adapter: {
      kind: a.kind,
      command: a.command,
      args: Array.isArray(a.args) ? a.args.map(String) : [],
      cwd: typeof a.cwd === 'string' ? a.cwd : undefined,
      systemPrompt: typeof a.systemPrompt === 'string' ? a.systemPrompt : undefined,
    },
    server: { url: s.url, token: s.token },
    heartbeatIntervalMs: typeof interp.heartbeatIntervalMs === 'number' ? interp.heartbeatIntervalMs : 10_000,
  };
}
```

- [ ] **Step 10: Re-run the test**

Run: `npm test`
Expected: PASS — 3 passed.

- [ ] **Step 11: Commit**

```bash
git add .
git commit -m "feat(agent): scaffold daemon with config loader and YAML example"
```

---

### Task M0-5: Adapter interface + connection skeleton

**Files:**
- Create: `apps/agent/src/adapters/adapter.ts`
- Create: `apps/agent/src/connection.ts`
- Create: `apps/agent/src/index.ts`

- [ ] **Step 1: Implement `src/adapters/adapter.ts`**

```ts
export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  speaker: string;
  body: string;
  at: number;
}

export interface AskInput {
  prompt: string;
  history: ChatTurn[];
  systemPrompt?: string;
}

export interface CliAdapter {
  readonly kind: 'codex' | 'claude-code' | 'openclaw' | 'hermes';
  ask(input: AskInput, signal: AbortSignal): Promise<string>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

export class StubAdapter implements CliAdapter {
  readonly kind = 'codex' as const;
  async ask(): Promise<string> {
    throw new Error('stub adapter: real adapter wiring lands in M2');
  }
  async health() {
    return { ok: false, detail: 'stub adapter — connect a real CLI in M2' };
  }
}
```

- [ ] **Step 2: Implement `src/connection.ts` (skeleton: connect + log only)**

```ts
import { io, type Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { AgentConfig } from './config.js';
import type { CliAdapter } from './adapters/adapter.js';

export interface ConnectionHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createConnection(cfg: AgentConfig, _adapter: CliAdapter): ConnectionHandle {
  let socket: Socket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;

  return {
    async start() {
      socket = io(cfg.server.url, {
        auth: {
          token: cfg.server.token,
          agentId: cfg.id,
          name: cfg.name,
          role: cfg.role,
          adapterKind: cfg.adapter.kind,
        },
        reconnection: true,
        reconnectionDelay: 1_000,
      });
      socket.on('connect', () => {
        logger.info({ id: cfg.id }, 'connected to server');
        socket!.emit('register', {
          id: cfg.id, name: cfg.name, role: cfg.role,
          adapterKind: cfg.adapter.kind,
        });
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          socket?.emit('heartbeat', { at: Date.now() });
        }, cfg.heartbeatIntervalMs);
      });
      socket.on('connect_error', (err) => {
        logger.error({ err: err.message }, 'connect_error');
      });
      socket.on('disconnect', (reason) => {
        logger.warn({ reason }, 'disconnected');
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      });
    },
    async stop() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      socket?.close();
      socket = null;
    },
  };
}
```

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { createConnection } from './connection.js';
import { StubAdapter } from './adapters/adapter.js';
import { logger } from './log.js';

async function main() {
  const cfgPath = process.env.AGENT_CONFIG ?? './agent.config.yaml';
  const cfg = loadConfig(cfgPath);
  logger.info({ id: cfg.id, kind: cfg.adapter.kind }, 'agent daemon starting');
  const conn = createConnection(cfg, new StubAdapter());
  await conn.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 4: Smoke-run against the M0-2 server**

In one shell:

```bash
cd /Users/shaw/AgentBean/apps/server && npm run dev
```

In another:

```bash
cd /Users/shaw/AgentBean/apps/agent
cp examples/agent.config.yaml.example /tmp/cfg.yaml
AGENT_BEAN_SERVER_URL=http://localhost:4000/agent \
AGENT_BEAN_AGENT_TOKEN=dev-token-change-me \
AGENT_CONFIG=/tmp/cfg.yaml \
npx tsx src/index.ts &
sleep 3
kill %1
```

Expected: server log shows `/agent client connected`; agent log shows `connected to server`. Heartbeats appear every 10s if you keep it running, but we just verify connect+disconnect here.

- [ ] **Step 5: Commit**

```bash
cd /Users/shaw/AgentBean/apps/agent
git add src/ index.ts || git add src/
git commit -m "feat(agent): add CliAdapter interface, stub adapter, connection skeleton"
```

---

### Task M0-6: `apps/web` scaffold (Next.js 14 + sidebar)

**Files:**
- Init: `apps/web/.git/`
- Create: `apps/web/package.json`, `apps/web/tsconfig.json`, `apps/web/next.config.mjs`, `apps/web/tailwind.config.ts`, `apps/web/postcss.config.mjs`, `apps/web/.env.example`, `apps/web/.gitignore`
- Create: `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`
- Create: `apps/web/components/sidebar.tsx`, `apps/web/components/connection-banner.tsx`

- [ ] **Step 1: Init repo**

```bash
cd /Users/shaw/AgentBean/apps
mkdir web
cd web
git init -q -b main
mkdir -p app/agents app/channels components lib tests
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "agentbean-web",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3100",
    "build": "next build",
    "start": "next start -p 3100",
    "lint": "next lint",
    "test": "vitest run"
  },
  "dependencies": {
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.1",
    "lucide-react": "^0.445.0",
    "next": "^14.2.13",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "socket.io-client": "^4.7.5",
    "tailwind-merge": "^2.5.2",
    "zustand": "^4.5.5"
  },
  "devDependencies": {
    "@types/node": "^20.16.5",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "autoprefixer": "^10.4.20",
    "eslint": "^8.57.1",
    "eslint-config-next": "^14.2.13",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.10",
    "typescript": "^5.6.2",
    "vitest": "^2.0.5"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "noEmit": true,
    "incremental": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "allowJs": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Write `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `.env.example`, `.gitignore`**

`next.config.mjs`:

```js
/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };
export default nextConfig;
```

`tailwind.config.ts`:

```ts
import type { Config } from 'tailwindcss';
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
export default config;
```

`postcss.config.mjs`:

```js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

`.env.example`:

```
NEXT_PUBLIC_AGENT_BEAN_SERVER_URL=http://localhost:4000
```

`.gitignore`:

```
node_modules/
.next/
out/
coverage/
.env
.env.local
```

- [ ] **Step 5: Install deps**

```bash
cd /Users/shaw/AgentBean/apps/web
npm install
```

- [ ] **Step 6: Implement `app/globals.css`, `app/layout.tsx`, `app/page.tsx`**

`app/globals.css`:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root { color-scheme: light; }
html, body { height: 100%; }
body {
  @apply bg-neutral-50 text-neutral-900 antialiased;
  font-family: ui-sans-serif, system-ui, -apple-system, "Helvetica Neue", "PingFang SC", sans-serif;
}
```

`app/layout.tsx`:

```tsx
import './globals.css';
import type { Metadata } from 'next';
import { Sidebar } from '@/components/sidebar';
import { ConnectionBanner } from '@/components/connection-banner';

export const metadata: Metadata = { title: 'AgentBean' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="flex-1 flex flex-col">
            <ConnectionBanner />
            <div className="flex-1 p-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
```

`app/page.tsx`:

```tsx
import { redirect } from 'next/navigation';
export default function Page() {
  redirect('/agents');
}
```

- [ ] **Step 7: Implement `components/sidebar.tsx` and `components/connection-banner.tsx`**

`components/sidebar.tsx`:

```tsx
import Link from 'next/link';
import { Bot, MessagesSquare } from 'lucide-react';

export function Sidebar() {
  return (
    <aside className="w-56 shrink-0 border-r border-neutral-200 bg-white p-4">
      <div className="text-xl font-semibold mb-6">AgentBean</div>
      <nav className="space-y-1">
        <Link href="/agents"
          className="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-neutral-100">
          <Bot size={18} /> agents
        </Link>
        <Link href="/channels"
          className="flex items-center gap-2 rounded px-3 py-2 text-sm hover:bg-neutral-100">
          <MessagesSquare size={18} /> 频道
        </Link>
      </nav>
    </aside>
  );
}
```

`components/connection-banner.tsx`:

```tsx
'use client';
export function ConnectionBanner() {
  // M1 will wire this to the Zustand store; M0 just renders nothing.
  return null;
}
```

- [ ] **Step 8: Add empty placeholder pages so Next can route**

Create `app/agents/page.tsx`:

```tsx
export default function AgentsPage() {
  return <div className="text-neutral-500">M1 will render the agent pool here.</div>;
}
```

Create `app/channels/page.tsx`:

```tsx
export default function ChannelsPage() {
  return <div className="text-neutral-500">M2 will render the channel list here.</div>;
}
```

- [ ] **Step 9: Smoke `npm run dev`**

```bash
cd /Users/shaw/AgentBean/apps/web
npm run dev &
DEV_PID=$!
sleep 6
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:3100/
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:3100/agents
kill $DEV_PID
```

Expected: both endpoints return `200`.

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat(web): scaffold next.js with sidebar and placeholder pages"
```

---

### Task M0-7: M0 verification + outer-repo sync

**Files:**
- (No new files; tagging + outer commit)

- [ ] **Step 1: Run all three apps in parallel and verify endpoints**

In three separate shells:

```bash
# server
cd /Users/shaw/AgentBean/apps/server && npm run dev
# agent (with example config)
cd /Users/shaw/AgentBean/apps/agent
AGENT_CONFIG=examples/agent.config.yaml.example \
AGENT_BEAN_SERVER_URL=http://localhost:4000/agent \
AGENT_BEAN_AGENT_TOKEN=dev-token-change-me npm run dev
# web
cd /Users/shaw/AgentBean/apps/web && npm run dev
```

Verification (in a fourth shell):

```bash
curl -sf http://localhost:4000/healthz       # → {"status":"ok"}
curl -sf -o /dev/null -w '%{http_code}\n' http://localhost:3100/agents  # → 200
```

Server log should print one `/agent client connected` from the daemon. Stop all three.

- [ ] **Step 2: Tag each inner repo**

```bash
for app in server agent web; do
  cd /Users/shaw/AgentBean/apps/$app
  git tag m0
done
```

- [ ] **Step 3: Outer-repo synchronizing commit**

```bash
cd /Users/shaw/AgentBean
git add docs/superpowers/plans/2026-05-03-agentbean-demo001.md
git commit -m "chore(docs): add demo001 implementation plan"
git commit --allow-empty -m "chore: M0 scaffold complete (server/agent/web up)"
```

Expected: two new commits on `docs/demo001` (plan + scaffold marker).

---

## M1 — First Real Agent Visible

By the end of M1: a real `apps/agent` daemon connects, registers, and heartbeats; the web `/agents` page renders one card; killing the daemon flips the card to offline within 30 seconds.

### Task M1-1: Wire SQLite into server bootstrap

**Files:**
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/tests/healthz.test.ts` (extend to assert `db` is exposed)

- [ ] **Step 1: Extend the health test to assert `app.db`**

Replace `apps/server/tests/healthz.test.ts` with:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/index.js';

const app = buildApp({ dbPath: ':memory:' });

afterAll(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  it('returns 200 with status:ok', async () => {
    const res = await request(app.http).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('exposes a Db handle', () => {
    expect(app.db).toBeTruthy();
    const tables = app.db.raw
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all().map((r: any) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['agents', 'channels']));
  });
});
```

- [ ] **Step 2: Run the test (must fail)**

Run: `npm test -- tests/healthz.test.ts`
Expected: FAIL — `dbPath` option unknown / `app.db` undefined.

- [ ] **Step 3: Update `apps/server/src/index.ts`**

Replace the file with:

```ts
import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { logger } from './log.js';
import { openDb, type Db } from './db.js';

export interface AppOptions { port?: number; dbPath?: string }
export interface AppHandle {
  http: http.Server;
  io: IOServer;
  db: Db;
  close: () => Promise<void>;
}

export function buildApp(opts: AppOptions = {}): AppHandle {
  const dbPath = opts.dbPath ?? process.env.DATABASE_PATH ?? './data/agentbean.db';
  const db = openDb(dbPath);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const server = http.createServer(app);
  const io = new IOServer(server, { cors: { origin: '*' } });

  io.of('/web').on('connection', (socket) => {
    logger.info({ id: socket.id }, '/web client connected');
  });
  io.of('/agent').on('connection', (socket) => {
    logger.info({ id: socket.id }, '/agent client connected');
  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => logger.info({ port: opts.port }, 'server listening'));
  }

  return {
    http: server,
    io,
    db,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  buildApp({ port });
}
```

- [ ] **Step 4: Re-run tests**

Run: `npm test`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/healthz.test.ts
git commit -m "feat(server): open SQLite at startup and expose db handle"
```

---

### Task M1-2: AgentRegistry (in-memory state authority)

**Files:**
- Create: `apps/server/src/registry.ts`
- Test: `apps/server/tests/registry.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/tests/registry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRegistry } from '../src/registry.js';

describe('AgentRegistry', () => {
  const baseInfo = { name: 'A1', role: 'social', adapterKind: 'codex' as const };
  let now: number;
  beforeEach(() => { now = 1_000_000; vi.useFakeTimers(); vi.setSystemTime(now); });

  it('register transitions connecting → online', () => {
    const r = new AgentRegistry();
    const before = r.snapshot('a1');
    expect(before).toBeNull();
    r.register('socket-1', { id: 'a1', ...baseInfo });
    const snap = r.snapshot('a1');
    expect(snap?.status).toBe('online');
    expect(snap?.socketId).toBe('socket-1');
    expect(snap?.lastHeartbeatAt).toBe(now);
  });

  it('register on existing id with new socket kicks the old one', () => {
    const r = new AgentRegistry();
    r.register('socket-1', { id: 'a1', ...baseInfo });
    const kicked: string[] = [];
    r.onKick((sid) => kicked.push(sid));
    r.register('socket-2', { id: 'a1', ...baseInfo });
    expect(kicked).toEqual(['socket-1']);
    expect(r.snapshot('a1')?.socketId).toBe('socket-2');
  });

  it('heartbeat updates lastHeartbeatAt and clears error', () => {
    const r = new AgentRegistry();
    r.register('s', { id: 'a1', ...baseInfo });
    r.markError('a1', 'boom');
    expect(r.snapshot('a1')?.status).toBe('error');
    vi.setSystemTime(now + 5_000);
    r.heartbeat('a1');
    expect(r.snapshot('a1')?.lastHeartbeatAt).toBe(now + 5_000);
    expect(r.snapshot('a1')?.status).toBe('online');
    expect(r.snapshot('a1')?.lastError).toBeUndefined();
  });

  it('markOffline keeps the runtime entry but flips status', () => {
    const r = new AgentRegistry();
    r.register('s', { id: 'a1', ...baseInfo });
    r.markOffline('a1', 'heartbeat-timeout');
    const snap = r.snapshot('a1');
    expect(snap?.status).toBe('offline');
    expect(snap?.socketId).toBeNull();
  });

  it('all() returns sorted snapshots', () => {
    const r = new AgentRegistry();
    r.register('s1', { id: 'b1', name: 'B', role: 'r', adapterKind: 'codex' });
    r.register('s2', { id: 'a1', name: 'A', role: 'r', adapterKind: 'codex' });
    expect(r.all().map((a) => a.id)).toEqual(['a1', 'b1']);
  });
});
```

- [ ] **Step 2: Run test (must fail)**

Run: `npm test -- tests/registry.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/registry.ts`**

```ts
import type { AdapterKind } from './db.js';

export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';

export interface AgentRegisterInfo {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
}

export interface AgentRuntime extends AgentRegisterInfo {
  status: AgentStatus;
  socketId: string | null;
  lastHeartbeatAt: number;
  firstSeenAt: number;
  lastError?: { at: number; message: string };
}

type KickListener = (oldSocketId: string) => void;

export class AgentRegistry {
  private byId = new Map<string, AgentRuntime>();
  private kickListeners: KickListener[] = [];

  onKick(fn: KickListener) { this.kickListeners.push(fn); }

  register(socketId: string, info: AgentRegisterInfo): AgentRuntime {
    const now = Date.now();
    const existing = this.byId.get(info.id);
    if (existing && existing.socketId && existing.socketId !== socketId) {
      const oldSocket = existing.socketId;
      for (const fn of this.kickListeners) fn(oldSocket);
    }
    const next: AgentRuntime = {
      ...info,
      status: 'online',
      socketId,
      lastHeartbeatAt: now,
      firstSeenAt: existing?.firstSeenAt ?? now,
    };
    this.byId.set(info.id, next);
    return next;
  }

  heartbeat(agentId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.lastHeartbeatAt = Date.now();
    if (a.status === 'offline' || a.status === 'error') a.status = 'online';
    a.lastError = undefined;
    return a;
  }

  markBusy(agentId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    if (a.status === 'online') a.status = 'busy';
    return a;
  }

  markOnline(agentId: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    if (a.status === 'busy' || a.status === 'error') a.status = 'online';
    return a;
  }

  markOffline(agentId: string, _reason: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.status = 'offline';
    a.socketId = null;
    return a;
  }

  markError(agentId: string, message: string): AgentRuntime | null {
    const a = this.byId.get(agentId);
    if (!a) return null;
    a.status = 'error';
    a.lastError = { at: Date.now(), message };
    return a;
  }

  snapshot(agentId: string): AgentRuntime | null {
    return this.byId.get(agentId) ?? null;
  }

  all(): AgentRuntime[] {
    return [...this.byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  bySocket(socketId: string): AgentRuntime | null {
    for (const v of this.byId.values()) if (v.socketId === socketId) return v;
    return null;
  }
}
```

- [ ] **Step 4: Re-run tests**

Run: `npm test -- tests/registry.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat(server): in-memory AgentRegistry with status state machine"
```

---

### Task M1-3: `/agent` namespace (register + heartbeat) + connect-command renderer

**Files:**
- Create: `apps/server/src/connect-command.ts`
- Create: `apps/server/src/namespaces/agent.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/tests/connect-command.test.ts`
- Test: `apps/server/tests/agent-namespace.test.ts`

- [ ] **Step 1: Write the failing connect-command test**

`apps/server/tests/connect-command.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { renderConnectCommand } from '../src/connect-command.js';

describe('renderConnectCommand', () => {
  it('uses adapterKind to pick a config example', () => {
    const out = renderConnectCommand({ adapterKind: 'codex' });
    expect(out).toContain('AGENT_CONFIG=examples/codex-shaw.yaml.example');
    expect(out).toContain('cd apps/agent');
  });

  it('falls back to the generic example for unknown kinds', () => {
    const out = renderConnectCommand({ adapterKind: 'hermes' });
    expect(out).toContain('AGENT_CONFIG=examples/agent.config.yaml.example');
  });
});
```

- [ ] **Step 2: Run (fail)**

Run: `npm test -- tests/connect-command.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/connect-command.ts`**

```ts
import type { AdapterKind } from './db.js';

const KNOWN: Partial<Record<AdapterKind, string>> = {
  codex: 'examples/codex-shaw.yaml.example',
  'claude-code': 'examples/claude-code-shaw.yaml.example',
};

export function renderConnectCommand(input: { adapterKind: AdapterKind }): string {
  const cfg = KNOWN[input.adapterKind] ?? 'examples/agent.config.yaml.example';
  return [
    '# 启动一个真实 Agent daemon (确保已 cp .env.example .env 并填好 token)',
    'cd apps/agent',
    `AGENT_CONFIG=${cfg} npm run dev`,
  ].join('\n');
}
```

- [ ] **Step 4: Re-run**

Run: `npm test -- tests/connect-command.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Write failing agent-namespace test**

`apps/server/tests/agent-namespace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppHandle } from '../src/index.js';
import { io as ioClient, type Socket } from 'socket.io-client';
import { AddressInfo } from 'node:net';

let app: AppHandle;
let url: string;

beforeEach(async () => {
  process.env.AGENT_BEAN_AGENT_TOKEN = 'tok';
  app = buildApp({ dbPath: ':memory:' });
  await new Promise<void>((resolve) => app.http.listen(0, resolve));
  const port = (app.http.address() as AddressInfo).port;
  url = `http://localhost:${port}/agent`;
});

afterEach(async () => { await app.close(); });

function connect(token: string, payload: Record<string, unknown>): Socket {
  return ioClient(url, {
    auth: { token, ...payload },
    reconnection: false,
    transports: ['websocket'],
  });
}

describe('/agent namespace', () => {
  it('rejects connections with bad token', async () => {
    const s = connect('wrong', { agentId: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    await new Promise<void>((resolve, reject) => {
      s.on('connect', () => reject(new Error('should not connect')));
      s.on('connect_error', (err) => {
        expect(err.message).toMatch(/auth/i);
        resolve();
      });
      setTimeout(() => reject(new Error('no error event')), 2_000);
    });
    s.close();
  });

  it('register puts the agent online and broadcasts to /web', async () => {
    const web = ioClient(url.replace('/agent', '/web'), { reconnection: false, transports: ['websocket'] });
    await new Promise<void>((resolve) => web.on('connect', () => resolve()));
    web.emit('agents:subscribe', {});
    const snapshotPromise = new Promise<any[]>((resolve) => web.on('agents:snapshot', resolve));
    const statusPromise = new Promise<any>((resolve) => web.on('agent:status', resolve));

    const ag = connect('tok', { agentId: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    await new Promise<void>((resolve) => ag.on('connect', () => resolve()));
    ag.emit('register', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });

    const status = await statusPromise;
    expect(status.id).toBe('a1');
    expect(status.status).toBe('online');
    expect(status.connectCommand).toContain('codex');
    const snap = await snapshotPromise;
    expect(snap.find((s) => s.id === 'a1')).toBeDefined();

    ag.close(); web.close();
  });

  it('heartbeat updates lastSeenAt', async () => {
    const ag = connect('tok', { agentId: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    await new Promise<void>((resolve) => ag.on('connect', () => resolve()));
    ag.emit('register', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    await new Promise((r) => setTimeout(r, 50));
    const before = app.registry!.snapshot('a1')!.lastHeartbeatAt;
    await new Promise((r) => setTimeout(r, 30));
    ag.emit('heartbeat', { at: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    expect(app.registry!.snapshot('a1')!.lastHeartbeatAt).toBeGreaterThan(before);
    ag.close();
  });
});
```

- [ ] **Step 6: Run (must fail)**

Run: `npm test -- tests/agent-namespace.test.ts`
Expected: FAIL — `app.registry` undefined and namespace not auth-gated.

- [ ] **Step 7: Implement `src/namespaces/agent.ts`**

```ts
import type { Namespace, Server as IOServer } from 'socket.io';
import type { Db, AdapterKind } from '../db.js';
import { AgentRegistry, type AgentRuntime } from '../registry.js';
import { renderConnectCommand } from '../connect-command.js';
import { logger } from '../log.js';

const ADAPTER_KINDS: AdapterKind[] = ['codex', 'claude-code', 'openclaw', 'hermes'];

export interface AgentNamespaceDeps {
  io: IOServer;
  db: Db;
  registry: AgentRegistry;
  token: string;
}

export interface AgentSnapshotDto {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  status: AgentRuntime['status'];
  lastSeenAt: number;
  lastError?: string;
  connectCommand: string;
}

export function snapshotToDto(rt: AgentRuntime): AgentSnapshotDto {
  return {
    id: rt.id,
    name: rt.name,
    role: rt.role,
    adapterKind: rt.adapterKind,
    status: rt.status,
    lastSeenAt: rt.lastHeartbeatAt,
    lastError: rt.lastError?.message,
    connectCommand: renderConnectCommand({ adapterKind: rt.adapterKind }),
  };
}

export function attachAgentNamespace(deps: AgentNamespaceDeps): Namespace {
  const ns = deps.io.of('/agent');

  ns.use((socket, next) => {
    const auth = socket.handshake.auth ?? {};
    if (auth.token !== deps.token) return next(new Error('auth: bad token'));
    if (typeof auth.agentId !== 'string') return next(new Error('auth: agentId required'));
    if (!ADAPTER_KINDS.includes(auth.adapterKind)) return next(new Error('auth: bad adapterKind'));
    next();
  });

  deps.registry.onKick((oldSocketId) => {
    ns.sockets.get(oldSocketId)?.disconnect(true);
  });

  ns.on('connection', (socket) => {
    const a = socket.handshake.auth as {
      agentId: string; name: string; role: string; adapterKind: AdapterKind;
    };
    logger.info({ id: a.agentId, sid: socket.id }, '/agent connected');

    socket.on('register', () => {
      const rt = deps.registry.register(socket.id, {
        id: a.agentId, name: a.name, role: a.role, adapterKind: a.adapterKind,
      });
      const now = Date.now();
      deps.db.agents.upsert({
        id: rt.id, name: rt.name, role: rt.role, adapterKind: rt.adapterKind,
        firstSeenAt: rt.firstSeenAt, lastSeenAt: now, lastError: null,
      });
      deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('heartbeat', () => {
      const rt = deps.registry.heartbeat(a.agentId);
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('error_event', (payload: { at: number; message: string; scope: string }) => {
      const rt = deps.registry.markError(a.agentId, payload?.message ?? 'unknown error');
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('disconnect', () => {
      const rt = deps.registry.markOffline(a.agentId, 'socket-disconnect');
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });
  });

  return ns;
}
```

- [ ] **Step 8: Update `src/index.ts` to attach namespace and expose registry**

Replace the file with:

```ts
import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { logger } from './log.js';
import { openDb, type Db } from './db.js';
import { AgentRegistry } from './registry.js';
import { attachAgentNamespace, snapshotToDto } from './namespaces/agent.js';

export interface AppOptions { port?: number; dbPath?: string; agentToken?: string }
export interface AppHandle {
  http: http.Server;
  io: IOServer;
  db: Db;
  registry: AgentRegistry;
  close: () => Promise<void>;
}

export function buildApp(opts: AppOptions = {}): AppHandle {
  const dbPath = opts.dbPath ?? process.env.DATABASE_PATH ?? './data/agentbean.db';
  const token = opts.agentToken ?? process.env.AGENT_BEAN_AGENT_TOKEN ?? 'dev-token-change-me';

  const db = openDb(dbPath);
  const registry = new AgentRegistry();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const server = http.createServer(app);
  const io = new IOServer(server, { cors: { origin: '*' } });

  attachAgentNamespace({ io, db, registry, token });

  io.of('/web').on('connection', (socket) => {
    logger.info({ sid: socket.id }, '/web client connected');
    socket.on('agents:subscribe', () => {
      socket.emit('agents:snapshot', registry.all().map(snapshotToDto));
    });
  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => logger.info({ port: opts.port }, 'server listening'));
  }

  return {
    http: server, io, db, registry,
    async close() {
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  buildApp({ port });
}
```

- [ ] **Step 9: Re-run tests**

Run: `npm test`
Expected: PASS — all suites green (healthz + db + registry + connect-command + agent-namespace).

- [ ] **Step 10: Commit**

```bash
git add src/connect-command.ts src/namespaces/agent.ts src/index.ts \
  tests/connect-command.test.ts tests/agent-namespace.test.ts
git commit -m "feat(server): /agent namespace with register, heartbeat, connect command"
```

---

### Task M1-4: Heartbeat scanner (30 s offline detection)

**Files:**
- Create: `apps/server/src/heartbeat-scanner.ts`
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/tests/heartbeat-scanner.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/tests/heartbeat-scanner.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '../src/registry.js';
import { startHeartbeatScanner } from '../src/heartbeat-scanner.js';

describe('startHeartbeatScanner', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); });
  afterEach(() => { vi.useRealTimers(); });

  it('marks agents offline after 30s without heartbeat', () => {
    const r = new AgentRegistry();
    r.register('s1', { id: 'a1', name: 'A', role: 'r', adapterKind: 'codex' });
    const events: string[] = [];
    const stop = startHeartbeatScanner({
      registry: r,
      timeoutMs: 30_000,
      intervalMs: 5_000,
      onTimeout: (id) => events.push(id),
    });
    vi.setSystemTime(20_000);
    vi.advanceTimersByTime(5_000);
    expect(r.snapshot('a1')?.status).toBe('online');
    vi.setSystemTime(31_000);
    vi.advanceTimersByTime(5_000);
    expect(r.snapshot('a1')?.status).toBe('offline');
    expect(events).toEqual(['a1']);
    stop();
  });

  it('does not double-fire after the agent is already offline', () => {
    const r = new AgentRegistry();
    r.register('s', { id: 'a1', name: 'A', role: 'r', adapterKind: 'codex' });
    const events: string[] = [];
    const stop = startHeartbeatScanner({
      registry: r, timeoutMs: 30_000, intervalMs: 5_000,
      onTimeout: (id) => events.push(id),
    });
    vi.setSystemTime(60_000);
    vi.advanceTimersByTime(5_000);
    vi.advanceTimersByTime(5_000);
    expect(events).toEqual(['a1']);
    stop();
  });
});
```

- [ ] **Step 2: Run (fail)**

Run: `npm test -- tests/heartbeat-scanner.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/heartbeat-scanner.ts`**

```ts
import type { AgentRegistry } from './registry.js';

export interface HeartbeatScannerOptions {
  registry: AgentRegistry;
  timeoutMs: number;
  intervalMs: number;
  onTimeout: (agentId: string) => void;
}

export function startHeartbeatScanner(opts: HeartbeatScannerOptions): () => void {
  const handle = setInterval(() => {
    const now = Date.now();
    for (const a of opts.registry.all()) {
      if (a.status === 'offline') continue;
      if (now - a.lastHeartbeatAt > opts.timeoutMs) {
        opts.registry.markOffline(a.id, 'heartbeat-timeout');
        opts.onTimeout(a.id);
      }
    }
  }, opts.intervalMs);
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
```

- [ ] **Step 4: Re-run**

Run: `npm test -- tests/heartbeat-scanner.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Wire scanner into `src/index.ts`**

Inside `buildApp`, after `attachAgentNamespace(...)`, add:

```ts
import { startHeartbeatScanner } from './heartbeat-scanner.js';

// ... inside buildApp, replace the "return { ... close() }" block:
const stopScanner = startHeartbeatScanner({
  registry,
  timeoutMs: 30_000,
  intervalMs: 5_000,
  onTimeout: (id) => {
    const rt = registry.snapshot(id);
    if (rt) io.of('/web').emit('agent:status', snapshotToDto(rt));
  },
});

return {
  http: server, io, db, registry,
  async close() {
    stopScanner();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  },
};
```

- [ ] **Step 6: Re-run all tests**

Run: `npm test`
Expected: PASS — all suites.

- [ ] **Step 7: Commit**

```bash
git add src/heartbeat-scanner.ts src/index.ts tests/heartbeat-scanner.test.ts
git commit -m "feat(server): heartbeat scanner flips agents offline after 30s"
```

---

### Task M1-5: `/web` namespace agent subscription

**Files:**
- Test: `apps/server/tests/web-namespace.test.ts`
- Modify (already in M1-3): `apps/server/src/index.ts` (formalize the snapshot handler)

- [ ] **Step 1: Write the failing test**

`apps/server/tests/web-namespace.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildApp, type AppHandle } from '../src/index.js';
import { io as ioClient } from 'socket.io-client';
import { AddressInfo } from 'node:net';

let app: AppHandle;
let baseUrl: string;

beforeEach(async () => {
  process.env.AGENT_BEAN_AGENT_TOKEN = 'tok';
  app = buildApp({ dbPath: ':memory:' });
  await new Promise<void>((r) => app.http.listen(0, r));
  const port = (app.http.address() as AddressInfo).port;
  baseUrl = `http://localhost:${port}`;
});

afterEach(async () => { await app.close(); });

describe('/web namespace', () => {
  it('emits empty snapshot when no agents are registered', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'] });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const snap = await new Promise<any[]>((resolve) => {
      web.emit('agents:subscribe', {});
      web.on('agents:snapshot', resolve);
    });
    expect(snap).toEqual([]);
    web.close();
  });

  it('emits agent:status when a daemon registers', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'] });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const got = new Promise<any>((resolve) => web.on('agent:status', resolve));

    const ag = ioClient(`${baseUrl}/agent`, {
      auth: { token: 'tok', agentId: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });

    const status = await got;
    expect(status.id).toBe('a1');
    expect(status.status).toBe('online');

    ag.close(); web.close();
  });
});
```

- [ ] **Step 2: Run**

Run: `npm test -- tests/web-namespace.test.ts`
Expected: PASS (since the handler was added in M1-3). If it fails, adjust the inline `agents:subscribe` handler in `src/index.ts` to ensure it emits even when registry is empty.

- [ ] **Step 3: Commit**

```bash
git add tests/web-namespace.test.ts
git commit -m "test(server): web namespace emits snapshots and agent status"
```

---

### Task M1-6: Web socket client + Zustand store

**Files:**
- Create: `apps/web/lib/schema.ts`
- Create: `apps/web/lib/socket.ts`
- Create: `apps/web/lib/store.ts`

- [ ] **Step 1: Implement `lib/schema.ts`**

```ts
export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes';
export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';

export interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  status: AgentStatus;
  lastSeenAt: number;
  lastError?: string;
  connectCommand: string;
}

export type ConnState = 'connecting' | 'open' | 'lost';
```

- [ ] **Step 2: Implement `lib/socket.ts`**

```ts
'use client';
import { io, type Socket } from 'socket.io-client';
import type { AgentSnapshot } from './schema.js';

const url = process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL ?? 'http://localhost:4000';

let webSocket: Socket | null = null;

export function getWebSocket(): Socket {
  if (webSocket) return webSocket;
  webSocket = io(`${url}/web`, { transports: ['websocket'], autoConnect: true });
  return webSocket;
}

export interface AgentEvents {
  onSnapshot(handler: (snap: AgentSnapshot[]) => void): () => void;
  onStatus(handler: (snap: AgentSnapshot) => void): () => void;
  subscribe(): void;
}

export function agentEvents(socket: Socket = getWebSocket()): AgentEvents {
  return {
    onSnapshot(handler) {
      socket.on('agents:snapshot', handler);
      return () => { socket.off('agents:snapshot', handler); };
    },
    onStatus(handler) {
      socket.on('agent:status', handler);
      return () => { socket.off('agent:status', handler); };
    },
    subscribe() { socket.emit('agents:subscribe', {}); },
  };
}
```

- [ ] **Step 3: Implement `lib/store.ts`**

```ts
'use client';
import { create } from 'zustand';
import type { AgentSnapshot, ConnState } from './schema.js';

interface State {
  conn: ConnState;
  agents: Record<string, AgentSnapshot>;
  setConn(c: ConnState): void;
  applySnapshot(list: AgentSnapshot[]): void;
  applyStatus(snap: AgentSnapshot): void;
}

export const useAgentBeanStore = create<State>((set) => ({
  conn: 'connecting',
  agents: {},
  setConn(conn) { set({ conn }); },
  applySnapshot(list) {
    const map: Record<string, AgentSnapshot> = {};
    for (const a of list) map[a.id] = a;
    set({ agents: map });
  },
  applyStatus(snap) {
    set((s) => ({ agents: { ...s.agents, [snap.id]: snap } }));
  },
}));
```

- [ ] **Step 4: Smoke build (no test yet — render-side coverage in M1-7)**

Run: `npm run build`
Expected: build succeeds (App Router pages compile).

- [ ] **Step 5: Commit**

```bash
git add lib/
git commit -m "feat(web): socket client and Zustand store for agent state"
```

---

### Task M1-7: Render `/agents` page

**Files:**
- Create: `apps/web/components/agent-card.tsx`, `apps/web/components/agent-status-badge.tsx`
- Create: `apps/web/lib/format-time.ts`
- Modify: `apps/web/app/agents/page.tsx`
- Modify: `apps/web/components/connection-banner.tsx`
- Test: `apps/web/tests/format-time.test.ts`

- [ ] **Step 1: Write the failing format-time test**

`apps/web/tests/format-time.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelative } from '../lib/format-time.js';

afterEach(() => vi.useRealTimers());

describe('formatRelative', () => {
  it('returns 刚刚 for less than a minute', () => {
    vi.useFakeTimers().setSystemTime(60_000);
    expect(formatRelative(45_000)).toBe('刚刚');
  });
  it('returns N 分钟前', () => {
    vi.useFakeTimers().setSystemTime(10 * 60_000);
    expect(formatRelative(7 * 60_000)).toBe('3 分钟前');
  });
  it('returns N 小时前', () => {
    vi.useFakeTimers().setSystemTime(3 * 3600_000);
    expect(formatRelative(60_000)).toBe('2 小时前');
  });
});
```

- [ ] **Step 2: Run (fail)**

Run: `npm test`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `lib/format-time.ts`**

```ts
export function formatRelative(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时前`;
}
```

- [ ] **Step 4: Re-run**

Run: `npm test`
Expected: PASS — 3 passed.

- [ ] **Step 5: Implement `components/agent-status-badge.tsx`**

```tsx
import type { AgentStatus } from '@/lib/schema';

const LABEL: Record<AgentStatus, string> = {
  connecting: '连接中',
  online: '在线',
  busy: '处理中',
  offline: '离线',
  error: '异常',
};

const STYLE: Record<AgentStatus, string> = {
  connecting: 'bg-amber-100 text-amber-800',
  online: 'bg-emerald-100 text-emerald-800',
  busy: 'bg-sky-100 text-sky-800',
  offline: 'bg-neutral-200 text-neutral-700',
  error: 'bg-rose-100 text-rose-800',
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[status]}`}>
      {LABEL[status]}
    </span>
  );
}
```

- [ ] **Step 6: Implement `components/agent-card.tsx`**

```tsx
import Link from 'next/link';
import type { AgentSnapshot } from '@/lib/schema';
import { AgentStatusBadge } from './agent-status-badge';
import { formatRelative } from '@/lib/format-time';

export function AgentCard({ agent }: { agent: AgentSnapshot }) {
  return (
    <Link
      href={`/agents/${agent.id}`}
      className="block rounded-lg border border-neutral-200 bg-white p-4 hover:border-neutral-400 transition"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{agent.name}</div>
          <div className="text-sm text-neutral-500">{agent.role}</div>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>
      <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500">
        <span className="rounded bg-neutral-100 px-1.5 py-0.5">{agent.adapterKind}</span>
        <span>最近活跃 {formatRelative(agent.lastSeenAt)}</span>
      </div>
      {agent.lastError ? (
        <div className="mt-2 text-xs text-rose-600 line-clamp-2">{agent.lastError}</div>
      ) : null}
    </Link>
  );
}
```

- [ ] **Step 7: Replace `components/connection-banner.tsx` with the live version**

```tsx
'use client';
import { useAgentBeanStore } from '@/lib/store';

export function ConnectionBanner() {
  const conn = useAgentBeanStore((s) => s.conn);
  if (conn === 'open') return null;
  return (
    <div className="px-6 py-2 bg-amber-100 text-amber-900 text-sm border-b border-amber-200">
      {conn === 'connecting' ? '连接中…' : '与服务端的连接已断开,正在重试…'}
    </div>
  );
}
```

- [ ] **Step 8: Replace `app/agents/page.tsx` with the live page**

```tsx
'use client';
import { useEffect, useMemo } from 'react';
import { agentEvents, getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { AgentCard } from '@/components/agent-card';

export default function AgentsPage() {
  const agents = useAgentBeanStore((s) => s.agents);
  const setConn = useAgentBeanStore((s) => s.setConn);
  const applySnapshot = useAgentBeanStore((s) => s.applySnapshot);
  const applyStatus = useAgentBeanStore((s) => s.applyStatus);

  useEffect(() => {
    const socket = getWebSocket();
    const handlers = agentEvents(socket);
    setConn(socket.connected ? 'open' : 'connecting');
    const onConnect = () => setConn('open');
    const onDisconnect = () => setConn('lost');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    const offSnap = handlers.onSnapshot(applySnapshot);
    const offStatus = handlers.onStatus(applyStatus);
    handlers.subscribe();
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      offSnap(); offStatus();
    };
  }, [setConn, applySnapshot, applyStatus]);

  const list = useMemo(() => Object.values(agents), [agents]);

  if (list.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-neutral-500">
        <div className="text-base font-medium mb-1">还没有 Agent 接入</div>
        <p>启动一个 Agent daemon 即可看到它出现在这里。</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Agent 池</h1>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {list.map((a) => <AgentCard key={a.id} agent={a} />)}
      </div>
    </div>
  );
}
```

- [ ] **Step 9: Smoke build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 10: Commit**

```bash
git add .
git commit -m "feat(web): /agents page with live agent cards and offline detection"
```

---

### Task M1-8: First real `codex` daemon config + manual offline verification

**Files:**
- Create: `apps/agent/examples/codex-shaw.yaml.example`

- [ ] **Step 1: Write `examples/codex-shaw.yaml.example`**

```yaml
id: codex-shaw
name: Codex-肖
role: Codex 代理 — 通用编码助手
adapter:
  kind: codex
  command: codex
  args: ['--no-banner']
  systemPrompt: |
    你是一个被 AgentBean 框架托管的 Codex CLI Agent。请用简洁的中文回答,聚焦工程上下文。
server:
  url: ${AGENT_BEAN_SERVER_URL}
  token: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000
```

- [ ] **Step 2: Manual end-to-end smoke**

In three shells:

```bash
# Shell 1
cd /Users/shaw/AgentBean/apps/server && npm run dev

# Shell 2
cd /Users/shaw/AgentBean/apps/agent
AGENT_CONFIG=examples/codex-shaw.yaml.example \
AGENT_BEAN_SERVER_URL=http://localhost:4000/agent \
AGENT_BEAN_AGENT_TOKEN=dev-token-change-me \
npm run dev

# Shell 3
cd /Users/shaw/AgentBean/apps/web && npm run dev
```

In the browser, open `http://localhost:3100/agents`. Verify: one card titled `Codex-肖` shows status `在线`. Now stop the daemon (Ctrl-C in Shell 2). Within 30 seconds the card should flip to `离线`.

- [ ] **Step 3: Tag M1 in each inner repo**

```bash
for app in server agent web; do
  cd /Users/shaw/AgentBean/apps/$app
  git add . && (git diff --cached --quiet || git commit -m "chore: M1 milestone")
  git tag m1
done
```

- [ ] **Step 4: Outer-repo marker commit**

```bash
cd /Users/shaw/AgentBean
git commit --allow-empty -m "chore: M1 — first agent visible end-to-end"
```

---

## M2 — Channel Lifecycle and Single-Agent Demo Loop

By the end of M2 the user can: create a channel with one online codex Agent, see the Agent's self-introduction in the channel, send a text message, and receive a reply. This closes G-1 through G-7 with one Agent.

### Task M2-1: Channels module + DAO wrapper

**Files:**
- Create: `apps/server/src/channels.ts`
- Test: `apps/server/tests/channels.test.ts`

- [ ] **Step 1: Write the failing test**

`apps/server/tests/channels.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { ChannelService } from '../src/channels.js';
import { AgentRegistry } from '../src/registry.js';

let db: Db;
let svc: ChannelService;
let registry: AgentRegistry;

beforeEach(() => {
  db = openDb(':memory:');
  registry = new AgentRegistry();
  svc = new ChannelService({ db, registry });
  registry.register('s1', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
  registry.register('s2', { id: 'a2', name: 'A2', role: 'r', adapterKind: 'codex' });
  db.agents.upsert({ id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex', firstSeenAt: 0, lastSeenAt: 0, lastError: null });
  db.agents.upsert({ id: 'a2', name: 'A2', role: 'r', adapterKind: 'codex', firstSeenAt: 0, lastSeenAt: 0, lastError: null });
});

afterEach(() => db.close());

describe('ChannelService', () => {
  it('create requires at least one agentId', () => {
    expect(() => svc.create({ name: '频道 1', agentIds: [] })).toThrow(/NO_AGENT/);
  });

  it('create persists channel and members', () => {
    const ch = svc.create({ name: '', agentIds: ['a1', 'a2'] });
    expect(ch.name).toBe('频道 1');
    const members = db.channelMembers.list(ch.id);
    expect(members.map((m) => m.agentId).sort()).toEqual(['a1', 'a2']);
  });

  it('create autonumbers default channel name', () => {
    const c1 = svc.create({ name: '', agentIds: ['a1'] });
    const c2 = svc.create({ name: '', agentIds: ['a2'] });
    expect(c1.name).toBe('频道 1');
    expect(c2.name).toBe('频道 2');
  });

  it('list returns channels in created order', () => {
    const a = svc.create({ name: 'foo', agentIds: ['a1'] });
    const b = svc.create({ name: 'bar', agentIds: ['a1'] });
    expect(svc.list().map((c) => c.id)).toEqual([a.id, b.id]);
  });

  it('membersOf returns runtimes for online + last-known for offline', () => {
    const ch = svc.create({ name: 'x', agentIds: ['a1', 'a2'] });
    registry.markOffline('a2', 'test');
    const members = svc.membersOf(ch.id);
    const sorted = members.sort((m1, m2) => m1.id.localeCompare(m2.id));
    expect(sorted.map((m) => m.id)).toEqual(['a1', 'a2']);
    expect(sorted[0]!.status).toBe('online');
    expect(sorted[1]!.status).toBe('offline');
  });
});
```

- [ ] **Step 2: Run (fail)**

Run: `npm test -- tests/channels.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/channels.ts`**

```ts
import type { Db, ChannelRow } from './db.js';
import { AgentRegistry, type AgentRuntime } from './registry.js';
import { newId } from './ids.js';

export interface ChannelServiceDeps { db: Db; registry: AgentRegistry; }

export interface CreateChannelInput { name: string; agentIds: string[]; }

export class ChannelService {
  constructor(private readonly deps: ChannelServiceDeps) {}

  create(input: CreateChannelInput): ChannelRow {
    const agentIds = [...new Set(input.agentIds)].filter(Boolean);
    if (agentIds.length === 0) {
      throw new Error('NO_AGENT');
    }
    const now = Date.now();
    const name = input.name.trim() || this.nextDefaultName();
    const id = newId();
    const ch = this.deps.db.channels.create({ id, name, createdAt: now });
    for (const agentId of agentIds) {
      this.deps.db.channelMembers.add({ channelId: ch.id, agentId, joinedAt: now });
    }
    return ch;
  }

  list(): ChannelRow[] {
    return this.deps.db.channels.list();
  }

  get(id: string): ChannelRow | null {
    return this.deps.db.channels.get(id);
  }

  memberIds(channelId: string): string[] {
    return this.deps.db.channelMembers.list(channelId).map((m) => m.agentId);
  }

  membersOf(channelId: string): AgentRuntime[] {
    return this.deps.db.channelMembers.list(channelId)
      .map((m) => this.deps.registry.snapshot(m.agentId))
      .filter((rt): rt is AgentRuntime => rt !== null);
  }

  channelsContaining(agentId: string): string[] {
    return this.deps.db.channelMembers.forAgent(agentId).map((m) => m.channelId);
  }

  private nextDefaultName(): string {
    return `频道 ${this.deps.db.channels.list().length + 1}`;
  }
}
```

- [ ] **Step 4: Re-run**

Run: `npm test -- tests/channels.test.ts`
Expected: PASS — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add src/channels.ts tests/channels.test.ts
git commit -m "feat(server): channel service with members and default naming"
```

---

### Task M2-2: Intro flow + dispatch glue (server side)

**Files:**
- Create: `apps/server/src/prompt.ts`
- Create: `apps/server/src/intro.ts`
- Modify: `apps/server/src/namespaces/agent.ts` (add `reply`, dispatch tracking)
- Test: `apps/server/tests/intro.test.ts`

- [ ] **Step 1: Implement `src/prompt.ts`**

```ts
export function introPrompt(input: { channelName: string; role: string }): string {
  return [
    `你刚被加入频道「${input.channelName}」。`,
    `请用 1-2 句中文自我介绍,说清你的角色「${input.role}」与你最擅长的事。`,
    '不要讨好,不要表情。',
  ].join('\n');
}
```

- [ ] **Step 2: Write the failing test**

`apps/server/tests/intro.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { runIntros, type DispatchFn } from '../src/intro.js';
import { AgentRegistry } from '../src/registry.js';

describe('runIntros', () => {
  it('dispatches one self-introduction per online member', async () => {
    const registry = new AgentRegistry();
    registry.register('s1', { id: 'a1', name: 'A1', role: 'social', adapterKind: 'codex' });
    registry.register('s2', { id: 'a2', name: 'A2', role: 'eng', adapterKind: 'codex' });

    const dispatched: any[] = [];
    const dispatch: DispatchFn = vi.fn(async (req) => {
      dispatched.push(req);
      return { ok: true, body: `intro from ${req.agentId}` };
    });
    const messages: any[] = [];

    await runIntros({
      channel: { id: 'c1', name: '频道 1' },
      members: [registry.snapshot('a1')!, registry.snapshot('a2')!],
      dispatch,
      onMessage: (m) => messages.push(m),
    });

    expect(dispatched.map((d) => d.agentId).sort()).toEqual(['a1', 'a2']);
    expect(dispatched[0].prompt).toContain('频道 1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ channelId: 'c1', senderKind: 'agent', body: expect.stringContaining('intro') });
  });

  it('emits a system failure message when dispatch returns ok=false', async () => {
    const registry = new AgentRegistry();
    registry.register('s', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    const dispatch: DispatchFn = async () => ({ ok: false, error: 'CLI exited 1' });
    const messages: any[] = [];
    await runIntros({
      channel: { id: 'c1', name: 'cn' },
      members: [registry.snapshot('a1')!],
      dispatch,
      onMessage: (m) => messages.push(m),
    });
    expect(messages[0]).toMatchObject({
      senderKind: 'system',
      body: expect.stringContaining('A1'),
    });
  });

  it('skips members who are offline', async () => {
    const registry = new AgentRegistry();
    registry.register('s', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    registry.markOffline('a1', 'test');
    const dispatch: DispatchFn = vi.fn();
    const messages: any[] = [];
    await runIntros({
      channel: { id: 'c1', name: 'cn' },
      members: [registry.snapshot('a1')!],
      dispatch,
      onMessage: (m) => messages.push(m),
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(messages[0]).toMatchObject({
      senderKind: 'system',
      body: expect.stringContaining('离线'),
    });
  });
});
```

- [ ] **Step 3: Run (fail)**

Run: `npm test -- tests/intro.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement `src/intro.ts`**

```ts
import { introPrompt } from './prompt.js';
import type { AgentRuntime } from './registry.js';
import { newId } from './ids.js';

export interface IntroChannel { id: string; name: string }

export interface DispatchResult { ok: boolean; body?: string; error?: string; }

export type DispatchFn = (req: {
  agentId: string;
  channelId: string;
  prompt: string;
  requestId: string;
}) => Promise<DispatchResult>;

export interface IntroMessage {
  id: string;
  channelId: string;
  senderKind: 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson: string | null;
}

export interface RunIntrosInput {
  channel: IntroChannel;
  members: AgentRuntime[];
  dispatch: DispatchFn;
  onMessage: (m: IntroMessage) => void;
}

export async function runIntros(input: RunIntrosInput): Promise<void> {
  for (const m of input.members) {
    if (m.status !== 'online') {
      input.onMessage({
        id: newId(),
        channelId: input.channel.id,
        senderKind: 'system',
        senderId: null,
        body: `${m.name} 当前离线,未发送自我介绍。`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'intro-skip', agentId: m.id }),
      });
      continue;
    }
    const requestId = newId();
    const result = await input.dispatch({
      agentId: m.id,
      channelId: input.channel.id,
      prompt: introPrompt({ channelName: input.channel.name, role: m.role }),
      requestId,
    });
    if (result.ok && result.body) {
      input.onMessage({
        id: newId(),
        channelId: input.channel.id,
        senderKind: 'agent',
        senderId: m.id,
        body: result.body,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'intro' }),
      });
    } else {
      input.onMessage({
        id: newId(),
        channelId: input.channel.id,
        senderKind: 'system',
        senderId: null,
        body: `${m.name} 自我介绍失败: ${result.error ?? 'unknown'}`,
        createdAt: Date.now(),
        metaJson: JSON.stringify({ kind: 'intro-fail', agentId: m.id }),
      });
    }
  }
}
```

- [ ] **Step 5: Re-run**

Run: `npm test -- tests/intro.test.ts`
Expected: PASS — 3 passed.

- [ ] **Step 6: Commit**

```bash
git add src/prompt.ts src/intro.ts tests/intro.test.ts
git commit -m "feat(server): intro prompt template and runIntros orchestrator"
```

---

### Task M2-3: Wire dispatch over `/agent` socket and `channel:create` over `/web`

**Files:**
- Modify: `apps/server/src/namespaces/agent.ts` (add dispatch + reply flow)
- Modify: `apps/server/src/index.ts` (channel namespace handler + dispatch broker)
- Modify: `apps/server/tests/agent-namespace.test.ts` (add dispatch round-trip case)

- [ ] **Step 1: Extend `agent-namespace.test.ts`**

Append to the existing `tests/agent-namespace.test.ts`:

```ts
import { newId } from '../src/ids.js';

describe('/agent dispatch round-trip', () => {
  it('routes server dispatch to daemon and resolves on reply', async () => {
    process.env.AGENT_BEAN_AGENT_TOKEN = 'tok';
    const local = buildApp({ dbPath: ':memory:' });
    await new Promise<void>((r) => local.http.listen(0, r));
    const port = (local.http.address() as AddressInfo).port;
    const lurl = `http://localhost:${port}/agent`;

    const ag = ioClient(lurl, {
      auth: { token: 'tok', agentId: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    ag.on('dispatch', (req: any) => {
      ag.emit('reply', { channelId: req.channelId, body: 'hello-reply', requestId: req.requestId });
    });

    const requestId = newId();
    const reply = await local.dispatch!({ agentId: 'a1', channelId: 'c1', prompt: 'hi', requestId });
    expect(reply).toEqual({ ok: true, body: 'hello-reply' });

    ag.close();
    await local.close();
  });
});
```

- [ ] **Step 2: Replace `src/namespaces/agent.ts` with the dispatch-aware version**

```ts
import type { Namespace, Server as IOServer } from 'socket.io';
import type { Db, AdapterKind } from '../db.js';
import { AgentRegistry, type AgentRuntime } from '../registry.js';
import { renderConnectCommand } from '../connect-command.js';
import { logger } from '../log.js';

const ADAPTER_KINDS: AdapterKind[] = ['codex', 'claude-code', 'openclaw', 'hermes'];

export interface AgentNamespaceDeps {
  io: IOServer;
  db: Db;
  registry: AgentRegistry;
  token: string;
  dispatchTimeoutMs?: number;
}

export interface DispatchRequest {
  agentId: string;
  channelId: string;
  prompt: string;
  requestId: string;
  history?: Array<{ role: 'user' | 'assistant' | 'system'; speaker: string; body: string; at: number }>;
}

export interface DispatchResolution { ok: boolean; body?: string; error?: string; }

export type DispatchFn = (req: DispatchRequest) => Promise<DispatchResolution>;

export interface AgentSnapshotDto {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  status: AgentRuntime['status'];
  lastSeenAt: number;
  lastError?: string;
  connectCommand: string;
}

export function snapshotToDto(rt: AgentRuntime): AgentSnapshotDto {
  return {
    id: rt.id,
    name: rt.name,
    role: rt.role,
    adapterKind: rt.adapterKind,
    status: rt.status,
    lastSeenAt: rt.lastHeartbeatAt,
    lastError: rt.lastError?.message,
    connectCommand: renderConnectCommand({ adapterKind: rt.adapterKind }),
  };
}

interface PendingDispatch {
  resolve: (result: DispatchResolution) => void;
  timer: NodeJS.Timeout;
}

export interface AgentNamespaceHandle {
  ns: Namespace;
  dispatch: DispatchFn;
}

export function attachAgentNamespace(deps: AgentNamespaceDeps): AgentNamespaceHandle {
  const ns = deps.io.of('/agent');
  const pending = new Map<string, PendingDispatch>();
  const timeoutMs = deps.dispatchTimeoutMs ?? 30_000;

  ns.use((socket, next) => {
    const auth = socket.handshake.auth ?? {};
    if (auth.token !== deps.token) return next(new Error('auth: bad token'));
    if (typeof auth.agentId !== 'string') return next(new Error('auth: agentId required'));
    if (!ADAPTER_KINDS.includes(auth.adapterKind)) return next(new Error('auth: bad adapterKind'));
    next();
  });

  deps.registry.onKick((oldSocketId) => {
    ns.sockets.get(oldSocketId)?.disconnect(true);
  });

  ns.on('connection', (socket) => {
    const a = socket.handshake.auth as {
      agentId: string; name: string; role: string; adapterKind: AdapterKind;
    };
    logger.info({ id: a.agentId, sid: socket.id }, '/agent connected');

    socket.on('register', () => {
      const rt = deps.registry.register(socket.id, {
        id: a.agentId, name: a.name, role: a.role, adapterKind: a.adapterKind,
      });
      const now = Date.now();
      deps.db.agents.upsert({
        id: rt.id, name: rt.name, role: rt.role, adapterKind: rt.adapterKind,
        firstSeenAt: rt.firstSeenAt, lastSeenAt: now, lastError: null,
      });
      deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('heartbeat', () => {
      const rt = deps.registry.heartbeat(a.agentId);
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('reply', (payload: { channelId: string; body: string; requestId: string }) => {
      const p = pending.get(payload.requestId);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(payload.requestId);
      p.resolve({ ok: true, body: payload.body });
      const rt = deps.registry.markOnline(a.agentId);
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('error_event', (payload: { at?: number; message?: string; scope?: string; requestId?: string }) => {
      if (payload?.requestId && pending.has(payload.requestId)) {
        const p = pending.get(payload.requestId)!;
        clearTimeout(p.timer);
        pending.delete(payload.requestId);
        p.resolve({ ok: false, error: payload.message ?? 'unknown' });
      }
      const rt = deps.registry.markError(a.agentId, payload?.message ?? 'unknown error');
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
    });

    socket.on('disconnect', () => {
      const rt = deps.registry.markOffline(a.agentId, 'socket-disconnect');
      if (rt) deps.io.of('/web').emit('agent:status', snapshotToDto(rt));
      for (const [reqId, p] of pending.entries()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: 'agent disconnected' });
        pending.delete(reqId);
      }
    });
  });

  const dispatch: DispatchFn = (req) => new Promise<DispatchResolution>((resolve) => {
    const rt = deps.registry.snapshot(req.agentId);
    if (!rt || rt.status === 'offline' || !rt.socketId) {
      resolve({ ok: false, error: `${req.agentId} 不在线` });
      return;
    }
    const sock = ns.sockets.get(rt.socketId);
    if (!sock) {
      resolve({ ok: false, error: `${req.agentId} socket 不可达` });
      return;
    }
    deps.registry.markBusy(req.agentId);
    deps.io.of('/web').emit('agent:status', snapshotToDto(deps.registry.snapshot(req.agentId)!));

    const timer = setTimeout(() => {
      pending.delete(req.requestId);
      resolve({ ok: false, error: '超时 (30s)' });
      deps.registry.markOnline(req.agentId);
      deps.io.of('/web').emit('agent:status', snapshotToDto(deps.registry.snapshot(req.agentId)!));
    }, timeoutMs);
    pending.set(req.requestId, { resolve, timer });

    sock.emit('dispatch', req);
  });

  return { ns, dispatch };
}
```

- [ ] **Step 3: Update `src/index.ts` to expose dispatch + channel:create**

Replace the file with:

```ts
import express from 'express';
import http from 'node:http';
import { Server as IOServer } from 'socket.io';
import { logger } from './log.js';
import { openDb, type Db } from './db.js';
import { AgentRegistry } from './registry.js';
import { attachAgentNamespace, snapshotToDto, type DispatchFn } from './namespaces/agent.js';
import { startHeartbeatScanner } from './heartbeat-scanner.js';
import { ChannelService } from './channels.js';
import { runIntros } from './intro.js';
import { newId } from './ids.js';

export interface AppOptions { port?: number; dbPath?: string; agentToken?: string }
export interface AppHandle {
  http: http.Server;
  io: IOServer;
  db: Db;
  registry: AgentRegistry;
  channels: ChannelService;
  dispatch: DispatchFn;
  close: () => Promise<void>;
}

export function buildApp(opts: AppOptions = {}): AppHandle {
  const dbPath = opts.dbPath ?? process.env.DATABASE_PATH ?? './data/agentbean.db';
  const token = opts.agentToken ?? process.env.AGENT_BEAN_AGENT_TOKEN ?? 'dev-token-change-me';

  const db = openDb(dbPath);
  const registry = new AgentRegistry();
  const channels = new ChannelService({ db, registry });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  const server = http.createServer(app);
  const io = new IOServer(server, { cors: { origin: '*' } });

  const { dispatch } = attachAgentNamespace({ io, db, registry, token });

  const stopScanner = startHeartbeatScanner({
    registry, timeoutMs: 30_000, intervalMs: 5_000,
    onTimeout: (id) => {
      const rt = registry.snapshot(id);
      if (rt) io.of('/web').emit('agent:status', snapshotToDto(rt));
    },
  });

  const persistMessage = (m: {
    id: string; channelId: string; senderKind: 'human' | 'agent' | 'system';
    senderId: string | null; body: string; createdAt: number; metaJson: string | null;
  }) => {
    db.messages.append(m);
    io.of('/web').to(`channel:${m.channelId}`).emit('channel:message', m);
  };

  io.of('/web').on('connection', (socket) => {
    logger.info({ sid: socket.id }, '/web client connected');

    socket.on('agents:subscribe', () => {
      socket.emit('agents:snapshot', registry.all().map(snapshotToDto));
    });

    socket.on('channels:subscribe', () => {
      socket.emit('channels:snapshot', channels.list());
    });

    socket.on('channel:join', (payload: { channelId: string }) => {
      socket.join(`channel:${payload.channelId}`);
      const history = db.messages.listByChannel(payload.channelId, 200);
      socket.emit('channel:history', { channelId: payload.channelId, messages: history });
    });

    socket.on('channel:create', async (payload: { name?: string; agentIds: string[] }, ack?: (r: any) => void) => {
      try {
        const ch = channels.create({ name: payload.name ?? '', agentIds: payload.agentIds });
        ack?.({ ok: true, channel: ch });
        io.of('/web').emit('channels:snapshot', channels.list());
        const members = channels.membersOf(ch.id);
        await runIntros({
          channel: ch,
          members,
          dispatch: (req) => dispatch({ agentId: req.agentId, channelId: req.channelId, prompt: req.prompt, requestId: req.requestId }),
          onMessage: persistMessage,
        });
      } catch (e: any) {
        ack?.({ ok: false, error: e.message ?? 'unknown' });
      }
    });
  });

  if (opts.port !== undefined) {
    server.listen(opts.port, () => logger.info({ port: opts.port }, 'server listening'));
  }

  return {
    http: server, io, db, registry, channels, dispatch,
    async close() {
      stopScanner();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const port = Number(process.env.PORT ?? 4000);
  buildApp({ port });
}
```

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS — including the new dispatch round-trip case.

- [ ] **Step 5: Commit**

```bash
git add src/namespaces/agent.ts src/index.ts tests/agent-namespace.test.ts
git commit -m "feat(server): channel:create with intro dispatch and reply broker"
```

---

### Task M2-4: `message:send` flow (server) with first-online routing

**Files:**
- Modify: `apps/server/src/index.ts`
- Test: `apps/server/tests/web-namespace.test.ts` (add message round-trip)

- [ ] **Step 1: Extend the test**

Append to `tests/web-namespace.test.ts`:

```ts
describe('message:send', () => {
  it('rejects empty bodies', async () => {
    const web = ioClient(`${baseUrl}/web`, { reconnection: false, transports: ['websocket'] });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const res = await new Promise<any>((resolve) => {
      web.emit('message:send', { channelId: 'c', body: '   ', clientMsgId: 'x' }, resolve);
    });
    expect(res).toEqual({ ok: false, error: 'EMPTY' });
    web.close();
  });

  it('persists the human message and dispatches to the first online member', async () => {
    process.env.AGENT_BEAN_AGENT_TOKEN = 'tok';
    const local = buildApp({ dbPath: ':memory:' });
    await new Promise<void>((r) => local.http.listen(0, r));
    const port = (local.http.address() as AddressInfo).port;
    const lbase = `http://localhost:${port}`;

    const ag = ioClient(`${lbase}/agent`, {
      auth: { token: 'tok', agentId: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' },
      reconnection: false, transports: ['websocket'],
    });
    await new Promise<void>((r) => ag.on('connect', () => r()));
    ag.emit('register', { id: 'a1', name: 'A1', role: 'r', adapterKind: 'codex' });
    ag.on('dispatch', (req: any) => {
      if (req.prompt.includes('自我介绍')) {
        ag.emit('reply', { channelId: req.channelId, body: 'hi I am A1', requestId: req.requestId });
        return;
      }
      ag.emit('reply', { channelId: req.channelId, body: 'echo: ' + req.prompt, requestId: req.requestId });
    });

    const web = ioClient(`${lbase}/web`, { reconnection: false, transports: ['websocket'] });
    await new Promise<void>((r) => web.on('connect', () => r()));
    const ch = await new Promise<any>((resolve) => {
      web.emit('channel:create', { name: 'demo', agentIds: ['a1'] }, resolve);
    });
    expect(ch.ok).toBe(true);

    const messages: any[] = [];
    web.emit('channel:join', { channelId: ch.channel.id });
    web.on('channel:message', (m: any) => messages.push(m));
    await new Promise((r) => setTimeout(r, 200));

    const ack = await new Promise<any>((resolve) => {
      web.emit('message:send', {
        channelId: ch.channel.id, body: 'hello', clientMsgId: 'cli-1',
      }, resolve);
    });
    expect(ack.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const human = messages.find((m) => m.senderKind === 'human');
    const reply = messages.find((m) => m.senderKind === 'agent' && m.body.startsWith('echo'));
    expect(human?.body).toBe('hello');
    expect(reply).toBeTruthy();

    ag.close(); web.close();
    await local.close();
  });
});
```

- [ ] **Step 2: Run (fail)**

Run: `npm test -- tests/web-namespace.test.ts`
Expected: FAIL — `message:send` not handled.

- [ ] **Step 3: Add the handler in `src/index.ts`**

Inside the `/web` connection block, add after `channel:create`:

```ts
socket.on('message:send', async (
  payload: { channelId: string; body: string; clientMsgId: string },
  ack?: (r: any) => void,
) => {
  const body = (payload?.body ?? '').trim();
  if (!body) return ack?.({ ok: false, error: 'EMPTY' });
  const ch = channels.get(payload.channelId);
  if (!ch) return ack?.({ ok: false, error: 'NO_CHANNEL' });

  const humanMsg = {
    id: newId(), channelId: ch.id, senderKind: 'human' as const, senderId: null,
    body, createdAt: Date.now(),
    metaJson: JSON.stringify({ clientMsgId: payload.clientMsgId }),
  };
  persistMessage(humanMsg);
  ack?.({ ok: true, id: humanMsg.id });

  const members = channels.membersOf(ch.id);
  const onlineMembers = members.filter((m) => m.status === 'online');
  if (onlineMembers.length === 0) {
    persistMessage({
      id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
      body: '当前没有在线 Agent 可响应,消息已保存。',
      createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'no-online-agent' }),
    });
    return;
  }

  const recipient = onlineMembers[0]!;
  const reqId = newId();
  const reply = await dispatch({
    agentId: recipient.id,
    channelId: ch.id,
    prompt: body,
    requestId: reqId,
  });
  if (reply.ok && reply.body) {
    persistMessage({
      id: newId(), channelId: ch.id, senderKind: 'agent', senderId: recipient.id,
      body: reply.body, createdAt: Date.now(),
      metaJson: JSON.stringify({ inReplyTo: humanMsg.id, requestId: reqId }),
    });
  } else {
    persistMessage({
      id: newId(), channelId: ch.id, senderKind: 'system', senderId: null,
      body: `${recipient.name} 处理失败: ${reply.error ?? 'unknown'}`,
      createdAt: Date.now(), metaJson: JSON.stringify({ kind: 'reply-fail', agentId: recipient.id }),
    });
  }
});
```

- [ ] **Step 4: Re-run**

Run: `npm test -- tests/web-namespace.test.ts`
Expected: PASS — all suites green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/web-namespace.test.ts
git commit -m "feat(server): message:send routes to first online channel member"
```

---

### Task M2-5: Real codex CLI adapter

**Files:**
- Create: `apps/agent/src/adapters/codex.ts`
- Modify: `apps/agent/src/connection.ts` (handle dispatch via adapter)
- Modify: `apps/agent/src/index.ts` (select adapter by kind)
- Test: `apps/agent/tests/adapter.test.ts`
- Test: `apps/agent/tests/codex-stub.test.ts`

- [ ] **Step 1: Write failing adapter contract test**

`apps/agent/tests/adapter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../src/adapters/codex.js';

describe('CodexAdapter', () => {
  it('uses systemPrompt + history + prompt as stdin', async () => {
    const adapter = new CodexAdapter({
      command: 'node',
      args: ['-e', 'process.stdin.on("data", d => process.stdout.write("OK:"+d.toString().length))'],
      systemPrompt: 'sys',
    });
    const out = await adapter.ask({
      prompt: 'hello',
      history: [{ role: 'user', speaker: 'shaw', body: 'prev', at: 0 }],
    }, new AbortController().signal);
    expect(out.startsWith('OK:')).toBe(true);
  });

  it('aborts the child process on signal', async () => {
    const adapter = new CodexAdapter({
      command: 'node',
      args: ['-e', 'setTimeout(() => process.stdout.write("late"), 5000)'],
    });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 50);
    await expect(adapter.ask({ prompt: '', history: [] }, ctl.signal)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run (fail)**

Run: `npm test -- tests/adapter.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement `src/adapters/codex.ts`**

```ts
import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput } from './adapter.js';

export interface CodexAdapterOpts {
  command: string;
  args?: string[];
  cwd?: string;
  systemPrompt?: string;
}

function renderPayload(input: AskInput, systemPrompt?: string): string {
  const parts: string[] = [];
  if (systemPrompt) parts.push(`# system\n${systemPrompt}`);
  for (const turn of input.history) {
    parts.push(`# ${turn.role}: ${turn.speaker}\n${turn.body}`);
  }
  parts.push(`# user\n${input.prompt}`);
  return parts.join('\n\n');
}

export class CodexAdapter implements CliAdapter {
  readonly kind = 'codex' as const;
  constructor(private readonly opts: CodexAdapterOpts) {}

  async ask(input: AskInput, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.opts.command, this.opts.args ?? [], {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      const onAbort = () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
      };
      signal.addEventListener('abort', onAbort);

      child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
      child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));
      child.on('error', (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
      child.on('exit', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) return reject(new Error('aborted'));
        const out = Buffer.concat(stdoutChunks).toString('utf8');
        const err = Buffer.concat(stderrChunks).toString('utf8');
        if (code !== 0 && out.length === 0) {
          return reject(new Error(`codex exit ${code}: ${err.slice(0, 200)}`));
        }
        resolve(out);
      });
      child.stdin.write(renderPayload(input, this.opts.systemPrompt ?? input.systemPrompt));
      child.stdin.end();
    });
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return new Promise((resolve) => {
      const child = spawn(this.opts.command, ['--version'], { stdio: 'ignore' });
      child.on('error', (err) => resolve({ ok: false, detail: err.message }));
      child.on('exit', (code) => resolve({ ok: code === 0, detail: code === 0 ? undefined : `exit ${code}` }));
    });
  }
}
```

- [ ] **Step 4: Re-run**

Run: `npm test -- tests/adapter.test.ts`
Expected: PASS — 2 passed.

- [ ] **Step 5: Update `src/connection.ts` to handle dispatch**

```ts
import { io, type Socket } from 'socket.io-client';
import { logger } from './log.js';
import type { AgentConfig } from './config.js';
import type { CliAdapter, ChatTurn } from './adapters/adapter.js';

export interface ConnectionHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createConnection(cfg: AgentConfig, adapter: CliAdapter): ConnectionHandle {
  let socket: Socket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  return {
    async start() {
      socket = io(cfg.server.url, {
        auth: {
          token: cfg.server.token,
          agentId: cfg.id, name: cfg.name, role: cfg.role,
          adapterKind: cfg.adapter.kind,
        },
        reconnection: true,
        reconnectionDelay: 1_000,
      });

      socket.on('connect', () => {
        logger.info({ id: cfg.id }, 'connected');
        socket!.emit('register', {
          id: cfg.id, name: cfg.name, role: cfg.role, adapterKind: cfg.adapter.kind,
        });
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = setInterval(() => {
          socket?.emit('heartbeat', { at: Date.now() });
        }, cfg.heartbeatIntervalMs);
      });

      socket.on('connect_error', (err) => {
        logger.error({ err: err.message }, 'connect_error');
      });

      socket.on('dispatch', (req: {
        requestId: string;
        channelId: string;
        prompt: string;
        history?: ChatTurn[];
      }) => {
        // Serialise dispatches: a CLI process can only handle one prompt at a time.
        queue = queue.then(async () => {
          const ctl = new AbortController();
          try {
            const body = await adapter.ask({
              prompt: req.prompt,
              history: req.history ?? [],
              systemPrompt: cfg.adapter.systemPrompt,
            }, ctl.signal);
            socket?.emit('reply', { channelId: req.channelId, body, requestId: req.requestId });
          } catch (err: any) {
            logger.error({ err: err.message, requestId: req.requestId }, 'dispatch failed');
            socket?.emit('error_event', {
              at: Date.now(),
              message: err.message ?? 'unknown',
              scope: 'reply',
              requestId: req.requestId,
            });
          }
        });
      });

      socket.on('disconnect', (reason) => {
        logger.warn({ reason }, 'disconnected');
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      });
    },
    async stop() {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      socket?.close();
      socket = null;
    },
  };
}
```

- [ ] **Step 6: Update `src/index.ts` to pick adapter by kind**

```ts
import { loadConfig } from './config.js';
import { createConnection } from './connection.js';
import { CodexAdapter } from './adapters/codex.js';
import type { CliAdapter } from './adapters/adapter.js';
import { logger } from './log.js';

function pickAdapter(cfg: ReturnType<typeof loadConfig>): CliAdapter {
  switch (cfg.adapter.kind) {
    case 'codex':
      return new CodexAdapter({
        command: cfg.adapter.command,
        args: cfg.adapter.args,
        cwd: cfg.adapter.cwd,
        systemPrompt: cfg.adapter.systemPrompt,
      });
    default:
      throw new Error(`adapter '${cfg.adapter.kind}' not yet implemented (M3)`);
  }
}

async function main() {
  const cfgPath = process.env.AGENT_CONFIG ?? './agent.config.yaml';
  const cfg = loadConfig(cfgPath);
  const adapter = pickAdapter(cfg);
  logger.info({ id: cfg.id, kind: cfg.adapter.kind }, 'agent daemon starting');
  const conn = createConnection(cfg, adapter);
  await conn.start();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await conn.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal');
  process.exit(1);
});
```

- [ ] **Step 7: Add a stub-CLI integration test for the connection layer**

`apps/agent/tests/codex-stub.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAdapter } from '../src/adapters/codex.js';

let scriptPath: string | null = null;
afterEach(() => { if (scriptPath) { try { unlinkSync(scriptPath); } catch {} scriptPath = null; } });

describe('CodexAdapter against a node stub', () => {
  it('returns stdout when child writes to it then exits', async () => {
    scriptPath = join(tmpdir(), `stub-${Date.now()}.cjs`);
    writeFileSync(scriptPath, `
      let buf=''; process.stdin.on('data', d => buf += d);
      process.stdin.on('end', () => process.stdout.write('ECHO:' + buf.length + '\\n'));
    `);
    const adapter = new CodexAdapter({ command: 'node', args: [scriptPath] });
    const out = await adapter.ask({ prompt: 'hi', history: [] }, new AbortController().signal);
    expect(out.startsWith('ECHO:')).toBe(true);
  });

  it('reports a useful error when CLI does not exist', async () => {
    const adapter = new CodexAdapter({ command: '/path/does/not/exist/xyz' });
    await expect(
      adapter.ask({ prompt: 'p', history: [] }, new AbortController().signal),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 8: Run all agent tests**

Run: `cd /Users/shaw/AgentBean/apps/agent && npm test`
Expected: PASS — config + adapter + codex-stub.

- [ ] **Step 9: Commit**

```bash
cd /Users/shaw/AgentBean/apps/agent
git add .
git commit -m "feat(agent): codex adapter + dispatch handling in connection"
```

---

### Task M2-6: Web — new channel dialog + channel list

**Files:**
- Modify: `apps/web/lib/store.ts` (channels + messages slices)
- Create: `apps/web/components/new-channel-dialog.tsx`
- Modify: `apps/web/app/channels/page.tsx`

- [ ] **Step 1: Extend `lib/schema.ts`**

Append:

```ts
export interface ChannelSummary { id: string; name: string; createdAt: number; }

export interface ChatMessage {
  id: string;
  channelId: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson?: string | null;
}

export interface OutboundMessage {
  id: string;
  channelId: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
}
```

- [ ] **Step 2: Replace `lib/store.ts` with the expanded version**

```ts
'use client';
import { create } from 'zustand';
import type { AgentSnapshot, ChannelSummary, ChatMessage, ConnState, OutboundMessage } from './schema.js';

interface State {
  conn: ConnState;
  agents: Record<string, AgentSnapshot>;
  channels: ChannelSummary[];
  messagesByChannel: Record<string, ChatMessage[]>;
  outbox: Record<string, OutboundMessage>;
  setConn(c: ConnState): void;
  applyAgentsSnapshot(list: AgentSnapshot[]): void;
  applyAgentStatus(snap: AgentSnapshot): void;
  applyChannelsSnapshot(list: ChannelSummary[]): void;
  applyChannelHistory(channelId: string, msgs: ChatMessage[]): void;
  appendMessage(msg: ChatMessage): void;
  addOutbound(msg: OutboundMessage): void;
  resolveOutbound(id: string, status: 'sent' | 'failed'): void;
}

export const useAgentBeanStore = create<State>((set) => ({
  conn: 'connecting',
  agents: {},
  channels: [],
  messagesByChannel: {},
  outbox: {},
  setConn(conn) { set({ conn }); },
  applyAgentsSnapshot(list) {
    const map: Record<string, AgentSnapshot> = {};
    for (const a of list) map[a.id] = a;
    set({ agents: map });
  },
  applyAgentStatus(snap) {
    set((s) => ({ agents: { ...s.agents, [snap.id]: snap } }));
  },
  applyChannelsSnapshot(list) { set({ channels: list }); },
  applyChannelHistory(channelId, msgs) {
    set((s) => ({ messagesByChannel: { ...s.messagesByChannel, [channelId]: msgs } }));
  },
  appendMessage(msg) {
    set((s) => {
      const list = s.messagesByChannel[msg.channelId] ?? [];
      return { messagesByChannel: { ...s.messagesByChannel, [msg.channelId]: [...list, msg] } };
    });
  },
  addOutbound(msg) { set((s) => ({ outbox: { ...s.outbox, [msg.id]: msg } })); },
  resolveOutbound(id, status) {
    set((s) => {
      const cur = s.outbox[id];
      if (!cur) return s;
      return { outbox: { ...s.outbox, [id]: { ...cur, status } } };
    });
  },
}));
```

- [ ] **Step 3: Implement `components/new-channel-dialog.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { useAgentBeanStore } from '@/lib/store';
import { getWebSocket } from '@/lib/socket';
import { useRouter } from 'next/navigation';

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const agents = useAgentBeanStore((s) => Object.values(s.agents));
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  const toggle = (id: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const submit = () => {
    if (selected.size === 0) { setError('请选择至少 1 个 Agent'); return; }
    setPending(true);
    getWebSocket().emit('channel:create', {
      name: name.trim(),
      agentIds: [...selected],
    }, (res: any) => {
      setPending(false);
      if (res?.ok) {
        onClose();
        router.push(`/channels/${res.channel.id}`);
      } else {
        setError(res?.error ?? '创建失败');
      }
    });
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center">
      <div className="bg-white rounded-lg shadow-xl w-[480px] p-5 space-y-4">
        <div className="text-lg font-semibold">新建频道</div>
        <input
          className="w-full border border-neutral-300 rounded px-3 py-2 text-sm"
          placeholder="频道名 (留空则自动命名)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="space-y-2 max-h-72 overflow-auto">
          {agents.length === 0 ? (
            <div className="text-sm text-neutral-500">还没有 Agent。请先启动一个 daemon。</div>
          ) : (
            agents.map((a) => (
              <label key={a.id} className="flex items-center gap-2 px-2 py-1 rounded hover:bg-neutral-100">
                <input
                  type="checkbox"
                  checked={selected.has(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span className="font-medium">{a.name}</span>
                <span className="text-xs text-neutral-500">{a.role}</span>
                {a.status !== 'online' && (
                  <span className="ml-auto text-xs text-amber-700">{a.status}</span>
                )}
              </label>
            ))
          )}
        </div>
        {error && <div className="text-sm text-rose-600">{error}</div>}
        <div className="flex justify-end gap-2">
          <button className="px-3 py-1.5 text-sm rounded border" onClick={onClose}>取消</button>
          <button
            className="px-3 py-1.5 text-sm rounded bg-neutral-900 text-white disabled:opacity-50"
            onClick={submit}
            disabled={pending}
          >
            {pending ? '创建中…' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Replace `app/channels/page.tsx`**

```tsx
'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getWebSocket, agentEvents } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { NewChannelDialog } from '@/components/new-channel-dialog';

export default function ChannelsPage() {
  const channels = useAgentBeanStore((s) => s.channels);
  const applyAgentsSnapshot = useAgentBeanStore((s) => s.applyAgentsSnapshot);
  const applyAgentStatus = useAgentBeanStore((s) => s.applyAgentStatus);
  const applyChannelsSnapshot = useAgentBeanStore((s) => s.applyChannelsSnapshot);
  const setConn = useAgentBeanStore((s) => s.setConn);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const socket = getWebSocket();
    setConn(socket.connected ? 'open' : 'connecting');
    const onConnect = () => setConn('open');
    const onDisconnect = () => setConn('lost');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    const ag = agentEvents(socket);
    const offSnap = ag.onSnapshot(applyAgentsSnapshot);
    const offStatus = ag.onStatus(applyAgentStatus);
    ag.subscribe();

    socket.on('channels:snapshot', applyChannelsSnapshot);
    socket.emit('channels:subscribe', {});

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      offSnap(); offStatus();
      socket.off('channels:snapshot', applyChannelsSnapshot);
    };
  }, [setConn, applyAgentsSnapshot, applyAgentStatus, applyChannelsSnapshot]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">频道</h1>
        <button
          onClick={() => setOpen(true)}
          className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5"
        >新建频道</button>
      </div>
      {channels.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-300 p-10 text-center text-neutral-500">
          还没有频道。点击「新建频道」开始。
        </div>
      ) : (
        <ul className="space-y-1">
          {channels.map((c) => (
            <li key={c.id}>
              <Link
                href={`/channels/${c.id}`}
                className="block px-3 py-2 rounded border border-neutral-200 hover:bg-neutral-50"
              >{c.name}</Link>
            </li>
          ))}
        </ul>
      )}
      {open && <NewChannelDialog onClose={() => setOpen(false)} />}
    </div>
  );
}
```

- [ ] **Step 5: Smoke build**

Run: `cd /Users/shaw/AgentBean/apps/web && npm run build`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(web): channels list + new channel dialog wired to channel:create"
```

---

### Task M2-7: Channel page (history + input + live messages)

**Files:**
- Create: `apps/web/components/channel-message.tsx`, `apps/web/components/channel-input.tsx`
- Create: `apps/web/app/channels/[channelId]/page.tsx`

- [ ] **Step 1: Implement `components/channel-message.tsx`**

```tsx
import type { ChatMessage } from '@/lib/schema';
import { useAgentBeanStore } from '@/lib/store';

const KIND_LABEL: Record<ChatMessage['senderKind'], string> = {
  human: '你',
  agent: 'Agent',
  system: '系统',
};

export function ChannelMessage({ msg }: { msg: ChatMessage }) {
  const agent = useAgentBeanStore((s) => msg.senderId ? s.agents[msg.senderId] : undefined);
  const speaker = msg.senderKind === 'agent'
    ? (agent?.name ?? msg.senderId ?? 'Agent')
    : KIND_LABEL[msg.senderKind];
  const time = new Date(msg.createdAt).toLocaleTimeString('zh-CN');
  const tone = msg.senderKind === 'system'
    ? 'bg-amber-50 text-amber-900 border-amber-200'
    : msg.senderKind === 'human'
      ? 'bg-sky-50 text-sky-900 border-sky-100'
      : 'bg-white border-neutral-200';
  return (
    <div className={`rounded border ${tone} px-3 py-2`}>
      <div className="flex items-center justify-between text-xs text-neutral-500 mb-1">
        <span className="font-medium">{speaker}</span>
        <span>{time}</span>
      </div>
      <div className="whitespace-pre-wrap text-sm">{msg.body}</div>
    </div>
  );
}
```

- [ ] **Step 2: Implement `components/channel-input.tsx`**

```tsx
'use client';
import { useState } from 'react';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import type { OutboundMessage } from '@/lib/schema';

export function ChannelInput({ channelId }: { channelId: string }) {
  const [body, setBody] = useState('');
  const addOutbound = useAgentBeanStore((s) => s.addOutbound);
  const resolveOutbound = useAgentBeanStore((s) => s.resolveOutbound);

  const send = () => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const id = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const out: OutboundMessage = { id, channelId, body: trimmed, status: 'pending' };
    addOutbound(out);
    getWebSocket().emit('message:send',
      { channelId, body: trimmed, clientMsgId: id },
      (res: any) => resolveOutbound(id, res?.ok ? 'sent' : 'failed'),
    );
    setBody('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="border-t border-neutral-200 p-3 bg-white">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKey}
        rows={3}
        placeholder="输入消息,⌘/Ctrl + Enter 发送"
        className="w-full rounded border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-neutral-900"
      />
      <div className="flex justify-end mt-2">
        <button
          onClick={send}
          disabled={body.trim().length === 0}
          className="rounded bg-neutral-900 text-white text-sm px-3 py-1.5 disabled:opacity-50"
        >发送</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Implement `app/channels/[channelId]/page.tsx`**

```tsx
'use client';
import { useEffect, useMemo } from 'react';
import { useParams } from 'next/navigation';
import { getWebSocket } from '@/lib/socket';
import { useAgentBeanStore } from '@/lib/store';
import { ChannelMessage } from '@/components/channel-message';
import { ChannelInput } from '@/components/channel-input';

export default function ChannelPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const messages = useAgentBeanStore((s) => s.messagesByChannel[channelId] ?? []);
  const channel = useAgentBeanStore((s) => s.channels.find((c) => c.id === channelId));
  const applyChannelHistory = useAgentBeanStore((s) => s.applyChannelHistory);
  const appendMessage = useAgentBeanStore((s) => s.appendMessage);

  useEffect(() => {
    const socket = getWebSocket();
    socket.emit('channel:join', { channelId });

    const onHistory = (payload: { channelId: string; messages: any[] }) => {
      if (payload.channelId === channelId) applyChannelHistory(channelId, payload.messages);
    };
    const onMessage = (msg: any) => {
      if (msg.channelId === channelId) appendMessage(msg);
    };
    socket.on('channel:history', onHistory);
    socket.on('channel:message', onMessage);

    return () => {
      socket.off('channel:history', onHistory);
      socket.off('channel:message', onMessage);
    };
  }, [channelId, applyChannelHistory, appendMessage]);

  const sorted = useMemo(
    () => [...messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    [messages],
  );

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)]">
      <div className="px-1 py-2 text-base font-semibold">
        {channel?.name ?? '频道'}
      </div>
      <div className="flex-1 overflow-auto space-y-2 pr-1">
        {sorted.length === 0 ? (
          <div className="text-sm text-neutral-500">等待 Agent 自我介绍…</div>
        ) : (
          sorted.map((m) => <ChannelMessage key={m.id} msg={m} />)
        )}
      </div>
      <ChannelInput channelId={channelId} />
    </div>
  );
}
```

- [ ] **Step 4: Smoke build**

Run: `npm run build`
Expected: success.

- [ ] **Step 5: End-to-end manual smoke (G-1..G-7)**

Run all three apps, open the browser to `http://localhost:3100/agents`. Click `频道` → `新建频道` → tick `Codex-肖` → 创建。Verify:
- Channel page opens with a self-introduction message from the agent.
- Type "你能做什么?" and Cmd/Ctrl + Enter. The agent reply appears within ~30s.
- Stop the daemon. Send another message. Within 30s a system message reports "当前没有在线 Agent 可响应".

- [ ] **Step 6: Commit**

```bash
git add .
git commit -m "feat(web): channel page with history, live messages, and send box"
```

- [ ] **Step 7: Tag M2 in each inner repo + outer-repo marker**

```bash
for app in server agent web; do
  cd /Users/shaw/AgentBean/apps/$app
  git diff --quiet || git commit -am "chore: M2 wrap"
  git tag m2
done
cd /Users/shaw/AgentBean
git commit --allow-empty -m "chore: M2 — channel demo loop closed (G-1..G-7)"
```

---

## M3 — Multi-Agent, @-Mention Routing, Detail Page, System Messages

> **Milestone Goal:** With more than one Agent in a channel, allow the user to direct a message to a specific Agent via `@AgentName`. Add the Agent detail page so the user can see the connect command and last error. Polish system messages for offline / failure / no-online cases.

### Task M3-1: `routeHumanMessage` skeleton with TDD

**Files:**
- Create: `apps/server/src/routing.ts`
- Create: `apps/server/src/routing.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/server/src/routing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { routeHumanMessage } from './routing.js';
import type { AgentRuntime } from './registry.js';

const make = (id: string, name: string, status: AgentRuntime['status'] = 'online'): AgentRuntime => ({
  id,
  name,
  role: 'tester',
  adapterKind: 'codex',
  status,
  socketId: 's-' + id,
  firstSeenAt: 0,
  lastHeartbeatAt: 0,
  lastError: null,
});

describe('routeHumanMessage', () => {
  it('returns empty when no online members', () => {
    const result = routeHumanMessage({ body: 'hi', members: [make('a', 'A', 'offline')] });
    expect(result.targets).toEqual([]);
    expect(result.reason).toBe('NO_ONLINE');
  });

  it('routes to mentioned agent by exact name', () => {
    const a = make('a', '肖');
    const b = make('b', 'Codex');
    const result = routeHumanMessage({ body: '@Codex 你好', members: [a, b] });
    expect(result.targets.map((m) => m.id)).toEqual(['b']);
    expect(result.reason).toBe('MENTION');
  });

  it('falls back to first online member when no mention', () => {
    const a = make('a', '肖');
    const b = make('b', 'Codex');
    const result = routeHumanMessage({ body: '你好啊', members: [a, b] });
    expect(result.targets.map((m) => m.id)).toEqual(['a']);
    expect(result.reason).toBe('FALLBACK');
  });

  it('reports unknown mention but still picks fallback', () => {
    const a = make('a', '肖');
    const result = routeHumanMessage({ body: '@Nobody 看', members: [a] });
    expect(result.targets.map((m) => m.id)).toEqual(['a']);
    expect(result.reason).toBe('UNKNOWN_MENTION');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd /Users/shaw/AgentBean/apps/server && npx vitest run src/routing.test.ts`
Expected: FAIL with "Cannot find module './routing.js'".

- [ ] **Step 3: Create routing skeleton + USER CONTRIBUTION marker**

Create `apps/server/src/routing.ts`. The structure is provided; the matching policy is a small but meaningful design choice — leave the body for the user.

```ts
import type { AgentRuntime } from './registry.js';

export type RouteReason = 'MENTION' | 'FALLBACK' | 'UNKNOWN_MENTION' | 'NO_ONLINE';

export interface RouteInput {
  body: string;
  members: AgentRuntime[];
}

export interface RouteResult {
  targets: AgentRuntime[];
  reason: RouteReason;
}

/**
 * Decide which Agent(s) should receive a human message.
 *
 * Specification (per design §8.2):
 *  - If the message starts with "@<name>" and <name> matches an online member's name
 *    (case-sensitive, trimmed), route only to that member; reason = 'MENTION'.
 *  - If "@<name>" is present but no online member matches, fall back to the first online
 *    member; reason = 'UNKNOWN_MENTION'.
 *  - If no mention is present, route to the first online member; reason = 'FALLBACK'.
 *  - If there are no online members at all, return empty targets; reason = 'NO_ONLINE'.
 *
 * TODO(用户实现 5-10 行):
 *   Read the body, extract a mention if any, and pick targets according to the rules above.
 *   Keep the implementation small. The unit test in routing.test.ts will guide you.
 */
export function routeHumanMessage(input: RouteInput): RouteResult {
  const online = input.members.filter((m) => m.status === 'online' || m.status === 'busy');
  if (online.length === 0) {
    return { targets: [], reason: 'NO_ONLINE' };
  }

  // ---- BEGIN USER CONTRIBUTION ----
  // Replace the placeholder below with the matching logic described above.
  // Hint: a simple regex like /^\s*@(\S+)/ on input.body extracts the mention.
  throw new Error('routeHumanMessage: implement me (see TODO above)');
  // ---- END USER CONTRIBUTION ----
}
```

- [ ] **Step 4: Pause for user contribution**

Stop here. Surface this to the user:

> "routing.ts has a 5-10 line TODO for you. The four passing test cases in routing.test.ts describe the exact behavior. The trade-off worth thinking about: should an unknown mention silently fall back, or surface a system warning? The current spec chooses silent fallback (with `UNKNOWN_MENTION` reason for telemetry); revise the test only if you want different behavior."

- [ ] **Step 5: Re-run tests after the user implements**

Run: `npx vitest run src/routing.test.ts`
Expected: all four cases PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routing.ts src/routing.test.ts
git commit -m "feat(server): @-mention router with fallback for unknown names"
```

---

### Task M3-2: Wire routing into `message:send`

**Files:**
- Modify: `apps/server/src/index.ts` (the `message:send` handler defined in M2-4)
- Modify: `apps/server/test/web-message.test.ts`

- [ ] **Step 1: Update the failing test for multi-agent + mention**

Replace `apps/server/test/web-message.test.ts` with the multi-agent variant:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io as ioc, Socket as ClientSocket } from 'socket.io-client';
import { buildApp } from '../src/index.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let webA: ClientSocket;
let agentA: ClientSocket;
let agentB: ClientSocket;
const TOKEN = 'test-token';
const PORT = 4131;

beforeAll(async () => {
  process.env.AGENT_BEAN_AGENT_TOKEN = TOKEN;
  app = await buildApp({ port: PORT, dbPath: ':memory:' });
});

afterAll(async () => {
  webA?.close();
  agentA?.close();
  agentB?.close();
  await app.close();
});

const url = (p: string) => `http://localhost:${PORT}${p}`;

const connectAgent = (id: string, name: string) =>
  new Promise<ClientSocket>((resolve) => {
    const s = ioc(url('/agent'), {
      auth: { token: TOKEN, agentId: id, agentName: name, role: 'tester', adapterKind: 'codex' },
    });
    s.on('connect', () => resolve(s));
  });

const connectWeb = () =>
  new Promise<ClientSocket>((resolve) => {
    const s = ioc(url('/web'));
    s.on('connect', () => resolve(s));
  });

describe('message:send routes by @-mention', () => {
  it('mentioned agent receives the dispatch and replies', async () => {
    [webA, agentA, agentB] = await Promise.all([
      connectWeb(),
      connectAgent('a', 'Codex-A'),
      connectAgent('b', 'Codex-B'),
    ]);

    agentA.on('dispatch', (p: any) => {
      agentA.emit('reply', { requestId: p.requestId, channelId: p.channelId, body: 'A says: ' + p.body });
    });
    agentB.on('dispatch', (p: any) => {
      agentB.emit('reply', { requestId: p.requestId, channelId: p.channelId, body: 'B says: ' + p.body });
    });

    await new Promise((r) => setTimeout(r, 50));

    const channelId: string = await new Promise((resolve, reject) => {
      webA.emit('channel:create', { name: 't', agentIds: ['a', 'b'] }, (resp: any) => {
        resp.ok ? resolve(resp.channelId) : reject(new Error(resp.error));
      });
    });
    webA.emit('channel:join', { channelId });

    const messages: any[] = [];
    webA.on('channel:message', (m) => messages.push(m));

    // Wait for self-intros to complete
    await new Promise((r) => setTimeout(r, 200));
    messages.length = 0;

    await new Promise<void>((resolve, reject) => {
      webA.emit('message:send', { channelId, body: '@Codex-B 测试' }, (resp: any) => {
        resp.ok ? resolve() : reject(new Error(resp.error));
      });
    });

    await new Promise((r) => setTimeout(r, 200));
    const agentReply = messages.find((m) => m.senderKind === 'agent');
    expect(agentReply.senderId).toBe('b');
    expect(agentReply.body).toContain('B says');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/web-message.test.ts`
Expected: FAIL — current handler still picks the first online member regardless of mention.

- [ ] **Step 3: Replace the routing logic in `message:send`**

In `apps/server/src/index.ts`, locate the `message:send` handler (added in M2-4). Replace the block that picks the first online member with this:

```ts
import { routeHumanMessage } from './routing.js';

// ... inside webNs.on('connection', (socket) => { ... })
socket.on('message:send', (
  payload: { channelId: string; body: string },
  ack?: (resp: { ok: boolean; error?: string }) => void,
) => {
  const body = (payload?.body ?? '').trim();
  if (!body) {
    ack?.({ ok: false, error: 'EMPTY' });
    return;
  }
  const channel = channels.get(payload.channelId);
  if (!channel) {
    ack?.({ ok: false, error: 'NO_CHANNEL' });
    return;
  }

  persistMessage({
    channelId: channel.id,
    senderKind: 'human',
    senderId: 'web',
    body,
  });

  const members = channels.membersOf(channel.id);
  const { targets, reason } = routeHumanMessage({ body, members });

  if (targets.length === 0) {
    persistMessage({
      channelId: channel.id,
      senderKind: 'system',
      senderId: 'system',
      body: '当前没有在线 Agent 可响应。',
      meta: { kind: 'no-online' },
    });
    ack?.({ ok: true });
    return;
  }

  if (reason === 'UNKNOWN_MENTION') {
    persistMessage({
      channelId: channel.id,
      senderKind: 'system',
      senderId: 'system',
      body: '未找到被 @ 的 Agent,已交给第一个在线 Agent。',
      meta: { kind: 'unknown-mention' },
    });
  }

  for (const target of targets) {
    dispatch({ agentId: target.id, channelId: channel.id, speaker: 'web', body, timeoutMs: 30_000 })
      .then((reply) => {
        if (reply.ok) {
          persistMessage({
            channelId: channel.id,
            senderKind: 'agent',
            senderId: target.id,
            body: reply.body,
            meta: reply.meta,
          });
        } else {
          persistMessage({
            channelId: channel.id,
            senderKind: 'system',
            senderId: 'system',
            body: `Agent ${target.name} 处理失败: ${reply.error}`,
            meta: { kind: 'reply-failed', agentId: target.id },
          });
        }
      })
      .catch((err) => {
        persistMessage({
          channelId: channel.id,
          senderKind: 'system',
          senderId: 'system',
          body: `Agent ${target.name} 调度异常: ${String(err?.message ?? err)}`,
          meta: { kind: 'dispatch-error', agentId: target.id },
        });
      });
  }

  ack?.({ ok: true });
});
```

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run test/web-message.test.ts`
Expected: PASS — `B says: @Codex-B 测试`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/web-message.test.ts
git commit -m "feat(server): wire @-mention routing into message:send with system fallbacks"
```

---

### Task M3-3: Add `claude-code` adapter

**Files:**
- Create: `apps/agent/src/adapters/claude-code.ts`
- Create: `apps/agent/examples/claude-code-shaw.yaml.example`
- Modify: `apps/agent/src/adapters/adapter.contract.test.ts`
- Modify: `apps/agent/src/index.ts`

- [ ] **Step 1: Append the failing adapter contract test**

Append to `apps/agent/src/adapters/adapter.contract.test.ts` (created in M2-5):

```ts
import { ClaudeCodeAdapter } from './claude-code.js';

describe('ClaudeCodeAdapter', () => {
  it('passes prompt to a fake Claude binary and captures stdout', async () => {
    const adapter = new ClaudeCodeAdapter({
      kind: 'claude-code',
      command: 'node',
      args: ['-e', "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write('CC: '+s))"],
      cwd: process.cwd(),
      env: {},
      systemPrompt: 'sp',
    });
    const reply = await adapter.ask({
      requestId: 'rq2',
      channelId: 'c',
      speaker: 'web',
      body: 'hi-cc',
      history: [],
    });
    expect(reply.ok).toBe(true);
    expect((reply as any).body).toContain('hi-cc');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd /Users/shaw/AgentBean/apps/agent && npx vitest run src/adapters/adapter.contract.test.ts`
Expected: FAIL with "Cannot find module './claude-code.js'".

- [ ] **Step 3: Implement `ClaudeCodeAdapter`**

Create `apps/agent/src/adapters/claude-code.ts`. Most logic mirrors `CodexAdapter`; only the payload format differs (XML-style turn tags).

```ts
import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput, AskOutput, AdapterConfig } from './adapter.js';

export class ClaudeCodeAdapter implements CliAdapter {
  readonly kind = 'claude-code' as const;
  constructor(private cfg: AdapterConfig) {}

  async ask(input: AskInput): Promise<AskOutput> {
    const payload = this.buildPayload(input);
    const child = spawn(this.cfg.command, this.cfg.args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.stdin.end(payload);

    const code: number = await new Promise((resolve) => {
      child.once('exit', (c) => resolve(c ?? 0));
      input.signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      });
    });

    if (code !== 0) {
      return { ok: false, error: `claude-code exited ${code}: ${stderr.slice(0, 400)}` };
    }
    return { ok: true, body: stdout.trim(), meta: { exitCode: code } };
  }

  async health(): Promise<boolean> {
    return new Promise((resolve) => {
      const c = spawn(this.cfg.command, ['--version'], { stdio: 'ignore' });
      c.once('exit', (code) => resolve(code === 0));
      c.once('error', () => resolve(false));
    });
  }

  private buildPayload(input: AskInput): string {
    const lines: string[] = [];
    lines.push(`<system>\n${this.cfg.systemPrompt}\n</system>`);
    for (const h of input.history.slice(-10)) {
      lines.push(`<turn role="${h.role}" speaker="${h.speaker}">\n${h.body}\n</turn>`);
    }
    lines.push(`<turn role="user" speaker="${input.speaker}">\n${input.body}\n</turn>`);
    return lines.join('\n\n');
  }
}
```

- [ ] **Step 4: Register in `pickAdapter`**

In `apps/agent/src/index.ts`, extend the switch:

```ts
import { ClaudeCodeAdapter } from './adapters/claude-code.js';
// ...
function pickAdapter(cfg: AppConfig): CliAdapter {
  switch (cfg.adapter.kind) {
    case 'codex': return new CodexAdapter(cfg.adapter);
    case 'claude-code': return new ClaudeCodeAdapter(cfg.adapter);
    case 'openclaw':
    case 'hermes':
      throw new Error(`adapter ${cfg.adapter.kind} not implemented yet`);
  }
}
```

- [ ] **Step 5: Add example config**

Create `apps/agent/examples/claude-code-shaw.yaml.example`:

```yaml
id: claude-code-shaw
name: Claude-肖
role: 全能助手
serverUrl: http://localhost:4000
agentToken: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000
adapter:
  kind: claude-code
  command: claude
  args: ['--print']
  cwd: ${HOME}
  env: {}
  systemPrompt: |
    你是 AgentBean demo001 中的一个真实 Agent。当被 @ 时主动回答;
    回复需要简短、用中文,避免命令行操作。
```

- [ ] **Step 6: Re-run adapter tests**

Run: `npx vitest run src/adapters/adapter.contract.test.ts`
Expected: both `CodexAdapter` and `ClaudeCodeAdapter` cases PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/claude-code.ts src/adapters/adapter.contract.test.ts src/index.ts examples/claude-code-shaw.yaml.example
git commit -m "feat(agent): claude-code CLI adapter and example config"
```

---

### Task M3-4: Agent detail page

**Files:**
- Create: `apps/web/app/agents/[agentId]/page.tsx`
- Modify: `apps/web/lib/store.ts` (selector helper)

- [ ] **Step 1: Add a selector to the store**

Append to `apps/web/lib/store.ts` (do not duplicate the slice):

```ts
export const useAgent = (id: string) =>
  useStore((s) => s.agents.find((a) => a.id === id) ?? null);
```

- [ ] **Step 2: Create the detail page**

Create `apps/web/app/agents/[agentId]/page.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, AlertTriangle } from 'lucide-react';
import { agentEvents, getWebSocket } from '@/lib/socket';
import { useAgent, useStore } from '@/lib/store';
import { AgentStatusBadge } from '@/components/agent-status-badge';
import { formatRelative } from '@/lib/format-time';

export default function AgentDetailPage() {
  const params = useParams<{ agentId: string }>();
  const agent = useAgent(params.agentId);
  const setAgents = useStore((s) => s.applyAgentsSnapshot);
  const upsert = useStore((s) => s.upsertAgent);

  useEffect(() => {
    const socket = getWebSocket();
    const ev = agentEvents(socket);
    const unsubSnapshot = ev.onSnapshot(setAgents);
    const unsubStatus = ev.onStatus(upsert);
    ev.subscribe();
    return () => {
      unsubSnapshot();
      unsubStatus();
    };
  }, [setAgents, upsert]);

  if (!agent) {
    return (
      <div className="p-6 text-sm text-neutral-400">
        正在加载 Agent 信息或该 Agent 还未上线。
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <Link href="/agents" className="inline-flex items-center text-sm text-neutral-400 hover:text-neutral-200">
        <ArrowLeft className="mr-1 h-4 w-4" />返回 Agent 列表
      </Link>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-xl font-semibold">{agent.name}</div>
          <div className="text-sm text-neutral-400">{agent.role || '未填写角色'}</div>
        </div>
        <AgentStatusBadge status={agent.status} />
      </div>

      <dl className="grid grid-cols-1 gap-y-2 sm:grid-cols-2 sm:gap-x-6 text-sm">
        <div>
          <dt className="text-neutral-500">最近活跃</dt>
          <dd>{formatRelative(agent.lastSeenAt)}</dd>
        </div>
        <div>
          <dt className="text-neutral-500">Adapter</dt>
          <dd className="font-mono text-xs">{agent.adapterKind}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-neutral-500">Agent ID</dt>
          <dd className="font-mono text-xs break-all">{agent.id}</dd>
        </div>
      </dl>

      {agent.lastError && (
        <div className="rounded border border-red-500/40 bg-red-500/10 p-3 text-sm">
          <div className="mb-1 inline-flex items-center text-red-300">
            <AlertTriangle className="mr-1 h-4 w-4" />连接错误
          </div>
          <div className="font-mono text-xs whitespace-pre-wrap break-all">{agent.lastError}</div>
        </div>
      )}

      <section>
        <div className="mb-1 text-sm text-neutral-300">接入命令</div>
        <pre className="rounded bg-neutral-950 p-3 font-mono text-xs whitespace-pre-wrap">
{agent.connectCommand}
        </pre>
        <div className="mt-1 text-xs text-neutral-500">
          复制该命令到本机终端,即可启动这个 Agent 的本地客户端。
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Smoke build**

Run: `cd /Users/shaw/AgentBean/apps/web && npm run build`
Expected: success.

Manual smoke (with all 3 processes running): visit `/agents`, click any card, verify the detail page renders name / role / status badge / lastSeenAt / Agent ID / connect command. Stop the daemon — within 30s the badge flips to "离线" without leaving the page.

- [ ] **Step 4: Commit**

```bash
git add app/agents/[agentId]/page.tsx lib/store.ts
git commit -m "feat(web): agent detail page with connect command and last-error panel"
```

---

### Task M3-5: Connection banner + system message styling

**Files:**
- Modify: `apps/web/components/connection-banner.tsx`
- Modify: `apps/web/components/channel-message.tsx`

- [ ] **Step 1: Implement the banner**

`ConnectionBanner` was a stub from M0-6. Replace its file body with:

```tsx
'use client';

import { useEffect } from 'react';
import { getWebSocket } from '@/lib/socket';
import { useStore } from '@/lib/store';

export function ConnectionBanner() {
  const conn = useStore((s) => s.conn);
  const setConn = useStore((s) => s.setConn);

  useEffect(() => {
    const socket = getWebSocket();
    const onConnect = () => setConn('online');
    const onDisconnect = () => setConn('offline');
    const onError = () => setConn('error');
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onError);
    if (socket.connected) setConn('online');
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onError);
    };
  }, [setConn]);

  if (conn === 'online') return null;

  const label = conn === 'offline' ? '与服务器连接已断开,正在重连…' : '连接异常,请检查后端是否在运行。';
  const tone = conn === 'offline' ? 'bg-amber-600/20 text-amber-200' : 'bg-red-600/20 text-red-200';
  return <div className={`px-3 py-2 text-xs ${tone}`}>{label}</div>;
}
```

- [ ] **Step 2: Polish system messages**

Replace the system branch of `apps/web/components/channel-message.tsx` with:

```tsx
if (msg.senderKind === 'system') {
  const tone = msg.meta?.kind === 'reply-failed' || msg.meta?.kind === 'no-online'
    ? 'border-red-500/40 text-red-200'
    : 'border-amber-500/40 text-amber-200';
  return (
    <div className={`mx-auto my-1 max-w-prose rounded border px-2 py-1 text-center text-xs ${tone}`}>
      {msg.body}
    </div>
  );
}
```

- [ ] **Step 3: Smoke test**

Run `cd /Users/shaw/AgentBean/apps/web && npm run dev`. Stop the server while the web app is open — banner appears within ~5s. Restart the server — banner disappears.

- [ ] **Step 4: Commit**

```bash
git add components/connection-banner.tsx components/channel-message.tsx
git commit -m "feat(web): live connection banner and system-message tones"
```

---

### Task M3-6: Multi-agent end-to-end smoke + tag M3

- [ ] **Step 1: Run all four processes**

Terminal A — server:
```bash
cd /Users/shaw/AgentBean/apps/server && npm run dev
```

Terminal B — Codex daemon:
```bash
cd /Users/shaw/AgentBean/apps/agent && AGENT_CONFIG=examples/codex-shaw.yaml.example npm run dev
```

Terminal C — Claude daemon:
```bash
cd /Users/shaw/AgentBean/apps/agent && AGENT_CONFIG=examples/claude-code-shaw.yaml.example npm run dev
```

Terminal D — web:
```bash
cd /Users/shaw/AgentBean/apps/web && npm run dev
```

- [ ] **Step 2: Run the demo script**

Open `http://localhost:3100/agents`. Both `Codex-肖` and `Claude-肖` cards must appear with `online` badges within ~10s.

Open the detail page for `Codex-肖`; verify the connect command matches `examples/codex-shaw.yaml.example`. Return.

Click `频道` → `新建频道`. Tick both agents. Submit. The new channel page must show two intro messages (one per agent), each correctly attributed.

Send `@Claude-肖 你能做什么?` — only Claude replies.
Send `你好啊` — Codex (the first online member) replies (assuming the user wired the FALLBACK rule per M3-1).
Send `@Hermes 在么?` — a system message says "未找到被 @ 的 Agent…", then Codex replies.

Stop both daemons. Within 30s both cards flip to `离线`. Send a message — system says "当前没有在线 Agent 可响应。"

- [ ] **Step 3: Tag M3 + outer-repo marker**

```bash
for app in server agent web; do
  cd /Users/shaw/AgentBean/apps/$app
  git diff --quiet || git commit -am "chore: M3 wrap"
  git tag m3
done
cd /Users/shaw/AgentBean
git commit --allow-empty -m "chore: M3 — multi-agent + @-mention + detail page"
```

---

## M4 — Optional Adapters (OpenClaw / Hermes)

> **Milestone Goal:** Add the remaining two adapters mentioned in the requirements (D-2). This milestone is optional for the demo. Skip if there is no working binary on the demo box, but keep the wiring so the codebase stays honest about which adapters are stubbed vs implemented.

### Task M4-1: `OpenClawAdapter`

**Files:**
- Create: `apps/agent/src/adapters/openclaw.ts`
- Create: `apps/agent/examples/openclaw-shaw.yaml.example`
- Modify: `apps/agent/src/adapters/adapter.contract.test.ts`
- Modify: `apps/agent/src/index.ts`

- [ ] **Step 1: Append the failing contract test**

Append to `apps/agent/src/adapters/adapter.contract.test.ts`:

```ts
import { OpenClawAdapter } from './openclaw.js';

describe('OpenClawAdapter', () => {
  it('forwards prompt as JSON via stdin', async () => {
    const adapter = new OpenClawAdapter({
      kind: 'openclaw',
      command: 'node',
      args: [
        '-e',
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.stringify({reply:'OC:'+JSON.parse(s).user})))",
      ],
      cwd: process.cwd(),
      env: {},
      systemPrompt: 'sp',
    });
    const reply = await adapter.ask({
      requestId: 'rq3',
      channelId: 'c',
      speaker: 'web',
      body: 'hi-oc',
      history: [],
    });
    expect(reply.ok).toBe(true);
    expect((reply as any).body).toContain('hi-oc');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `cd /Users/shaw/AgentBean/apps/agent && npx vitest run src/adapters/adapter.contract.test.ts`
Expected: FAIL — "Cannot find module './openclaw.js'".

- [ ] **Step 3: Implement `OpenClawAdapter`**

Create `apps/agent/src/adapters/openclaw.ts`:

```ts
import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput, AskOutput, AdapterConfig } from './adapter.js';

interface OpenClawReply {
  reply?: string;
  error?: string;
}

export class OpenClawAdapter implements CliAdapter {
  readonly kind = 'openclaw' as const;
  constructor(private cfg: AdapterConfig) {}

  async ask(input: AskInput): Promise<AskOutput> {
    const payload = JSON.stringify({
      system: this.cfg.systemPrompt,
      history: input.history.slice(-10),
      user: input.body,
      speaker: input.speaker,
    });

    const child = spawn(this.cfg.command, this.cfg.args, {
      cwd: this.cfg.cwd,
      env: { ...process.env, ...this.cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.stdin.end(payload);

    const code: number = await new Promise((resolve) => {
      child.once('exit', (c) => resolve(c ?? 0));
      input.signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      });
    });

    if (code !== 0) {
      return { ok: false, error: `openclaw exited ${code}: ${stderr.slice(0, 400)}` };
    }
    let parsed: OpenClawReply;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return { ok: false, error: `openclaw produced non-JSON output: ${stdout.slice(0, 200)}` };
    }
    if (parsed.error) return { ok: false, error: parsed.error };
    return { ok: true, body: (parsed.reply ?? '').trim(), meta: { exitCode: code } };
  }

  async health(): Promise<boolean> {
    return new Promise((resolve) => {
      const c = spawn(this.cfg.command, ['--version'], { stdio: 'ignore' });
      c.once('exit', (code) => resolve(code === 0));
      c.once('error', () => resolve(false));
    });
  }
}
```

- [ ] **Step 4: Register in `pickAdapter`**

In `apps/agent/src/index.ts`:

```ts
import { OpenClawAdapter } from './adapters/openclaw.js';
// ...
function pickAdapter(cfg: AppConfig): CliAdapter {
  switch (cfg.adapter.kind) {
    case 'codex': return new CodexAdapter(cfg.adapter);
    case 'claude-code': return new ClaudeCodeAdapter(cfg.adapter);
    case 'openclaw': return new OpenClawAdapter(cfg.adapter);
    case 'hermes':
      throw new Error(`adapter ${cfg.adapter.kind} not implemented yet`);
  }
}
```

- [ ] **Step 5: Add example config**

Create `apps/agent/examples/openclaw-shaw.yaml.example`:

```yaml
id: openclaw-shaw
name: OpenClaw-肖
role: 实验性 Agent
serverUrl: http://localhost:4000
agentToken: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000
adapter:
  kind: openclaw
  command: openclaw
  args: ['--json', '--stdin']
  cwd: ${HOME}
  env: {}
  systemPrompt: |
    你是 AgentBean demo001 中的 OpenClaw Agent。请用中文简短作答。
```

- [ ] **Step 6: Re-run tests**

Run: `npx vitest run src/adapters/adapter.contract.test.ts`
Expected: all three adapter cases PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/openclaw.ts src/adapters/adapter.contract.test.ts src/index.ts examples/openclaw-shaw.yaml.example
git commit -m "feat(agent): openclaw CLI adapter (JSON stdin/stdout)"
```

---

### Task M4-2: `HermesAdapter`

**Files:**
- Create: `apps/agent/src/adapters/hermes.ts`
- Create: `apps/agent/examples/hermes-shaw.yaml.example`
- Modify: `apps/agent/src/adapters/adapter.contract.test.ts`
- Modify: `apps/agent/src/index.ts`

- [ ] **Step 1: Append the failing contract test**

Append to `apps/agent/src/adapters/adapter.contract.test.ts`:

```ts
import { HermesAdapter } from './hermes.js';

describe('HermesAdapter', () => {
  it('passes prompt as command-line argument and captures stdout', async () => {
    const adapter = new HermesAdapter({
      kind: 'hermes',
      command: 'node',
      args: ['-e', "process.stdout.write('H:' + process.argv[1])"],
      cwd: process.cwd(),
      env: {},
      systemPrompt: 'sp',
    });
    const reply = await adapter.ask({
      requestId: 'rq4',
      channelId: 'c',
      speaker: 'web',
      body: 'hi-h',
      history: [],
    });
    expect(reply.ok).toBe(true);
    expect((reply as any).body).toContain('hi-h');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run src/adapters/adapter.contract.test.ts`
Expected: FAIL — "Cannot find module './hermes.js'".

- [ ] **Step 3: Implement `HermesAdapter`**

Create `apps/agent/src/adapters/hermes.ts`:

```ts
import { spawn } from 'node:child_process';
import type { CliAdapter, AskInput, AskOutput, AdapterConfig } from './adapter.js';

export class HermesAdapter implements CliAdapter {
  readonly kind = 'hermes' as const;
  constructor(private cfg: AdapterConfig) {}

  async ask(input: AskInput): Promise<AskOutput> {
    const args = [...this.cfg.args, input.body];
    const child = spawn(this.cfg.command, args, {
      cwd: this.cfg.cwd,
      env: {
        ...process.env,
        ...this.cfg.env,
        HERMES_SYSTEM_PROMPT: this.cfg.systemPrompt,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));

    const code: number = await new Promise((resolve) => {
      child.once('exit', (c) => resolve(c ?? 0));
      input.signal?.addEventListener('abort', () => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      });
    });

    if (code !== 0) {
      return { ok: false, error: `hermes exited ${code}: ${stderr.slice(0, 400)}` };
    }
    return { ok: true, body: stdout.trim(), meta: { exitCode: code } };
  }

  async health(): Promise<boolean> {
    return new Promise((resolve) => {
      const c = spawn(this.cfg.command, ['--version'], { stdio: 'ignore' });
      c.once('exit', (code) => resolve(code === 0));
      c.once('error', () => resolve(false));
    });
  }
}
```

- [ ] **Step 4: Register in `pickAdapter`**

In `apps/agent/src/index.ts`:

```ts
import { HermesAdapter } from './adapters/hermes.js';
// ...
function pickAdapter(cfg: AppConfig): CliAdapter {
  switch (cfg.adapter.kind) {
    case 'codex': return new CodexAdapter(cfg.adapter);
    case 'claude-code': return new ClaudeCodeAdapter(cfg.adapter);
    case 'openclaw': return new OpenClawAdapter(cfg.adapter);
    case 'hermes': return new HermesAdapter(cfg.adapter);
  }
}
```

- [ ] **Step 5: Add example config**

Create `apps/agent/examples/hermes-shaw.yaml.example`:

```yaml
id: hermes-shaw
name: Hermes-肖
role: 命令行 Agent
serverUrl: http://localhost:4000
agentToken: ${AGENT_BEAN_AGENT_TOKEN}
heartbeatIntervalMs: 10000
adapter:
  kind: hermes
  command: hermes
  args: ['ask']
  cwd: ${HOME}
  env: {}
  systemPrompt: |
    你是 Hermes Agent。请用中文简短回答。
```

- [ ] **Step 6: Re-run tests**

Run: `npx vitest run src/adapters/adapter.contract.test.ts`
Expected: all four adapter cases PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/hermes.ts src/adapters/adapter.contract.test.ts src/index.ts examples/hermes-shaw.yaml.example
git commit -m "feat(agent): hermes CLI adapter (argv + env-prompt protocol)"
```

---

### Task M4-3: Tag M4

- [ ] **Step 1: Final smoke (optional)**

If you have any of the four binaries (`codex`, `claude`, `openclaw`, `hermes`) installed, start one daemon per available binary and confirm each appears in `/agents`. The point is to prove the adapter switch works, not to test the binaries themselves.

- [ ] **Step 2: Tag M4 + outer-repo marker**

```bash
for app in server agent web; do
  cd /Users/shaw/AgentBean/apps/$app
  git diff --quiet || git commit -am "chore: M4 wrap"
  git tag m4
done
cd /Users/shaw/AgentBean
git commit --allow-empty -m "chore: M4 — openclaw + hermes adapters wired"
```

---

## Self-Review

Performed against `docs/superpowers/specs/2026-05-03-agentbean-demo001-design.md`.

### 1. Spec coverage

| Spec section | Where it lands in the plan |
|---|---|
| §1 Overview / 3-process topology | Header + M0-2 (server) + M0-4 (agent) + M0-6 (web) |
| §2 Topology diagram | Reflected in File Structure tree + M0-7 manual smoke |
| §3 Repo structure (multi-repo, outer + apps/{web,server,agent}) | M0-1 (outer .gitignore) + M0-2/M0-4/M0-6 (each inner repo's `git init`) |
| §4 Components: Web / Server / Agent daemon | All of M0; specific responsibilities filled in M1, M2, M3 |
| §5 SQL schema (4 tables, INTEGER epoch ms, ULID PK) | M0-3 (`db.ts` SCHEMA + sub-DAOs); ULID via `ulid` package in M0-2/M0-3 |
| §6 Socket.IO events on `/web` and `/agent` | `/agent` register/heartbeat/disconnect: M1-3; `/agent` dispatch/reply/error_event: M2-3; `/web` agents:subscribe + agent:status: M1-3/M1-6; `/web` channels:subscribe + channel:join + channel:create: M2-3; `/web` channel:history + channel:message: M2-3/M2-7; `/web` message:send: M2-4 then M3-2 |
| §7 `CliAdapter` interface | M0-5 (interface + StubAdapter); concrete adapters in M2-5 (codex), M3-3 (claude-code), M4-1 (openclaw), M4-2 (hermes) |
| §8.1 Intro flow | M2-2 (`runIntros`) + invocation in M2-3 |
| §8.2 `routeHumanMessage` | M3-1 (skeleton + tests, with explicit `TODO(用户实现 5-10 行)`) + M3-2 (wired into `message:send`) |
| §9 Error handling (no online / dispatch failure / unknown mention) | M2-4 (NO_CHANNEL + dispatch failure) + M3-2 (NO_ONLINE + UNKNOWN_MENTION system messages) + M3-5 (UI tones) |
| §10 AC mapping (G-1..G-7) | G-1: M0-6 default route → /agents; G-2: M1-7; G-3: M3-4; G-4: M2-6; G-5: M2-2/M2-3; G-6: M2-4 then M3-2; G-7: M3-5 (banner + tones) |
| §11 Milestones | M0/M1/M2/M3/M4 sections of this plan |
| §12 TBDs | None now block the demo; the only remaining "user contribution" is the `routeHumanMessage` body in M3-1 |
| D-1 only Agent dimension | No "machine" model anywhere; channels reference `agentId` only |
| D-2 real Agents only | Adapters spawn real CLIs; no rule-based fakes |
| D-3 30s heartbeat | M1-4 (timeoutMs:30_000, intervalMs:5_000) |
| D-4 explicit Agent selection on channel create | M2-1 (throws NO_AGENT) + M2-6 (`new-channel-dialog` validates ≥1) |
| D-5 self-introduction on join | M2-2/M2-3 |
| D-6 connect command in UI | M1-3 (`renderConnectCommand`) + M3-4 (rendered) |
| D-7 no login | `/web` namespace is anonymous; `/agent` namespace requires token (M1-3) |

No spec gaps found.

### 2. Placeholder scan

Scanned for: "TBD", "TODO" (outside the deliberately marked user-contribution block), "implement later", "fill in details", "add appropriate error handling", "similar to Task N", "write tests for the above" (without code), un-shown commands.

- The single `TODO(用户实现 5-10 行)` is a **deliberate user-contribution marker** in M3-1, with full failing tests and clear specification — this is by design per the learning-mode philosophy and is documented as a pause-for-user step.
- All other steps include actual code or actual commands.
- Every "Run:" line names a specific command.
- Every test step shows the assertion code in full.

No placeholder violations.

### 3. Type consistency

Cross-checked against the spec and across tasks:

- `AgentRow` / `ChannelRow` / `MessageRow` defined in M0-3 — used in M2-3 (persist helpers), M2-4 (message:send), M3-2 (rewrite). All field names match (`id`, `name`, `role`, `adapterKind`, `firstSeenAt`, `lastSeenAt`, `lastError`).
- `AgentRuntime` defined in M1-2 — used in M3-1 (router input). `status` enum: `connecting` | `online` | `busy` | `offline` | `error` — matches spec §4.2 and `AgentStatusBadge` map in M1-7.
- `AgentSnapshotDto.lastSeenAt` mapped from `rt.lastHeartbeatAt` in M1-3 `snapshotToDto` — consistent everywhere on the web side.
- `AskInput` / `AskOutput` defined alongside `CliAdapter` in M0-5 — used identically in M2-5 (codex), M3-3 (claude-code), M4-1 (openclaw), M4-2 (hermes), and the contract tests reference `requestId`, `channelId`, `speaker`, `body`, `history`, optional `signal` — consistent.
- `routeHumanMessage` signature: `RouteInput { body, members } → RouteResult { targets, reason }` — defined in M3-1, consumed identically in M3-2.
- `dispatch` shape: `{ agentId, channelId, speaker, body, timeoutMs } → Promise<{ ok: true, body, meta? } | { ok: false, error }>` — defined in M2-3, consumed in M2-4 and M3-2 with the same shape.
- `ChannelService` methods: `create / list / get / memberIds / membersOf / channelsContaining` — defined in M2-1, consumed in M2-3 (handlers) and M3-2 (`channels.membersOf`).
- `connectCommand` produced by `renderConnectCommand({adapterKind})` in M1-3 and rendered in M3-4 (`agent.connectCommand`) — consistent. **Verify on implementation** that `AgentSnapshotDto` actually carries `connectCommand`; M1-3 `snapshotToDto` should include it. Note for executor: ensure that field is populated on the DTO returned to web.

No naming drifts found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-03-agentbean-demo001.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Best for this plan because tasks are bite-sized and each milestone has an explicit smoke gate.

2. **Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints for review.

**Which approach?**
