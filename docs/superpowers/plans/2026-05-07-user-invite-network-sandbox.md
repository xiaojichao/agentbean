# User Registration + Invite + Private/Public Network + Sandbox

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable multi-user AgentBean with invite-based registration, per-user private networks, public agent sharing, and macOS sandbox execution for public agents.

**Architecture:** Extend the existing token-based auth (`userId:networkId:random`) with user registration (scrypt password hashing), invite codes for onboarding, private/public network isolation, and macOS `sandbox-exec` wrapping for public non-AgentOS agents. The daemon gains an `--invite` mode that opens a browser registration page and receives a token back via a sessionId-based rendezvous.

**Tech Stack:** Node.js crypto (scrypt), Socket.IO, SQLite (better-sqlite3), macOS sandbox-exec, Next.js 14, Zustand, TypeScript

---

## File Structure

### Server — Create
- `apps/server/src/password.ts` — scrypt password hashing + verification
- `apps/server/src/invite.ts` — invite code generation + validation + DAO
- `apps/server/tests/password.test.ts` — password hashing tests
- `apps/server/tests/invite.test.ts` — invite DAO tests

### Server — Modify
- `apps/server/src/db.ts` — extend GLOBAL_SCHEMA (users password_hash, invites table), extend GlobalDb interface (users, networkMembers, invites CRUD)
- `apps/server/src/auth.ts` — add `verifyUserToken()` that checks userId exists in users table
- `apps/server/src/namespaces/agent.ts` — add `auth:invite:validate` handler, extend auth middleware for invite mode, add `sandboxed` field to dispatch
- `apps/server/src/index.ts` — add `auth:register`, `auth:login`, `auth:whoami` socket events, network visibility filtering, invite generation event

### Agent — Modify
- `apps/daemon/src/index.ts` — add `--invite` CLI flag, `runInviteMode()` function
- `apps/daemon/src/device-daemon.ts` — add `auth:token:deliver` handler, support token persistence to `~/.agentbean/auth.json`
- `apps/daemon/src/agent-instance.ts` — add sandbox wrapping logic in `handleDispatch()`
- `apps/daemon/src/sandbox.ts` — new file: sandbox profile generator + sandbox-exec spawn wrapper
- `apps/daemon/src/config.ts` — add `sandboxed` field to AgentConfigEntry

### Web — Create
- `apps/web/app/join/[token]/page.tsx` — registration page
- `apps/web/app/dashboard/page.tsx` — private network dashboard

### Web — Modify
- `apps/web/lib/schema.ts` — add UserInfo, InviteInfo, NetworkVisibility types
- `apps/web/lib/store.ts` — add currentUser, auth actions
- `apps/web/lib/socket.ts` — add auth events, invite events
- `apps/web/components/sidebar.tsx` — add Dashboard link, invite button, network switcher enhancement
- `apps/web/app/agents/page.tsx` — filter to public agents only, add invite command section

---

## Phase 1: User Registration + Authentication

### Task 1: Password hashing utility

**Files:**
- Create: `apps/server/src/password.ts`
- Test: `apps/server/tests/password.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/tests/password.test.ts
import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/password.js';

describe('password', () => {
  it('hashes and verifies a password', async () => {
    const hash = await hashPassword('my-secret');
    expect(hash).toBeDefined();
    expect(typeof hash).toBe('string');
    expect(hash).not.toBe('my-secret');
    const ok = await verifyPassword('my-secret', hash);
    expect(ok).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('my-secret');
    const ok = await verifyPassword('wrong', hash);
    expect(ok).toBe(false);
  });

  it('produces different hashes for same password', async () => {
    const h1 = await hashPassword('same');
    const h2 = await hashPassword('same');
    expect(h1).not.toBe(h2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run tests/password.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// apps/server/src/password.ts
import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`${salt.toString('hex')}:${derivedKey.toString('hex')}`);
    });
  });
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const storedHash = Buffer.from(hashHex, 'hex');
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(timingSafeEqual(derivedKey, storedHash));
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/server && npx vitest run tests/password.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
cd apps/server
git add src/password.ts tests/password.test.ts
git commit -m "feat(server): add scrypt password hashing utility"
```

---

### Task 2: Extend GlobalDb — users + network_members CRUD

**Files:**
- Modify: `apps/server/src/db.ts`

- [ ] **Step 1: Extend GLOBAL_SCHEMA — add password_hash column to users**

In `db.ts`, after the existing `users` table definition (around line 183-189), add ALTER TABLE migration. Also add `visibility` column to `networks` table.

Find the `initGlobalDb()` function. After the existing prepared statements (around line 277), add:

```typescript
// User migrations
try { raw.exec(`ALTER TABLE users ADD COLUMN password_hash TEXT`); } catch {}
try { raw.exec(`ALTER TABLE networks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`); } catch {}
```

- [ ] **Step 2: Add UserRow interface and users CRUD to GlobalDb**

After `NetworkRow` interface (around line 246), add:

```typescript
export interface UserRow {
  id: string;
  username: string;
  email: string | null;
  passwordHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface InviteRow {
  id: string;
  code: string;
  createdBy: string;
  networkId: string | null;
  usedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
}
```

- [ ] **Step 3: Extend GlobalDb interface with users, networkMembers, invites namespaces**

Add to the `GlobalDb` interface:

```typescript
users: {
  create(input: { id: string; username: string; email?: string | null; passwordHash?: string | null; createdAt: number }): UserRow;
  get(id: string): UserRow | null;
  getByName(username: string): UserRow | null;
  getByEmail(email: string): UserRow | null;
};
networkMembers: {
  add(networkId: string, userId: string, role: string): void;
  listByUser(userId: string): { networkId: string; role: string }[];
  isMember(networkId: string, userId: string): boolean;
};
invites: {
  create(input: { id: string; code: string; createdBy: string; networkId?: string | null; expiresAt?: number | null }): InviteRow;
  getByCode(code: string): InviteRow | null;
  markUsed(code: string): void;
};
```

- [ ] **Step 4: Implement prepared statements in initGlobalDb()**

After the existing network statements, add all prepared statements for users, networkMembers, invites with their CRUD methods.

- [ ] **Step 5: Add invites table to GLOBAL_SCHEMA**

```sql
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  network_id TEXT REFERENCES networks(id),
  used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
```

- [ ] **Step 6: Run existing tests**

Run: `cd apps/server && npx vitest run`
Expected: All existing tests still pass

- [ ] **Step 7: Commit**

```bash
cd apps/server
git add src/db.ts
git commit -m "feat(server): extend GlobalDb with users, networkMembers, invites CRUD"
```

---

### Task 3: Invite code generation + validation

**Files:**
- Create: `apps/server/src/invite.ts`
- Test: `apps/server/tests/invite.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/server/tests/invite.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'fs';
import { initGlobalDb, type GlobalDb } from '../src/db.js';

const TEST_DB = './data/test-invite.db';
const TEST_DIR = './data';

describe('invite', () => {
  let db: GlobalDb;
  beforeEach(() => {
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
    db = initGlobalDb(TEST_DB);
    db.users.create({ id: 'u1', username: 'alice', createdAt: Date.now() });
  });
  afterEach(() => {
    db.close();
    if (existsSync(TEST_DB)) rmSync(TEST_DB);
  });

  it('creates and retrieves an invite', () => {
    const invite = db.invites.create({ id: 'inv1', code: 'abc12345', createdBy: 'u1' });
    expect(invite.code).toBe('abc12345');
    const found = db.invites.getByCode('abc12345');
    expect(found).not.toBeNull();
    expect(found!.createdBy).toBe('u1');
  });

  it('marks invite as used', () => {
    db.invites.create({ id: 'inv1', code: 'abc12345', createdBy: 'u1' });
    db.invites.markUsed('abc12345');
    const found = db.invites.getByCode('abc12345');
    expect(found!.usedAt).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run tests/invite.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement initGlobalDb users/invites/networkMembers CRUD**

Add all the prepared statements and methods in `initGlobalDb()` to satisfy the test. This was partially done in Task 2 Step 4; ensure all methods are wired.

- [ ] **Step 4: Create invite.ts helper**

```typescript
// apps/server/src/invite.ts
import { randomBytes } from 'node:crypto';

export function generateInviteCode(length = 8): string {
  return randomBytes(length).toString('base64url').slice(0, length);
}
```

- [ ] **Step 5: Run test**

Run: `cd apps/server && npx vitest run tests/invite.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd apps/server
git add src/invite.ts tests/invite.test.ts
git commit -m "feat(server): invite code generation and DAO"
```

---

### Task 4: Auth socket events — register, login, whoami

**Files:**
- Modify: `apps/server/src/auth.ts` — add `verifyUserToken()`
- Modify: `apps/server/src/index.ts` — add auth socket events

- [ ] **Step 1: Add verifyUserToken to auth.ts**

```typescript
// Add to apps/server/src/auth.ts
export function verifyUserToken(
  token: string,
  globalDb: { users: { get(id: string): { id: string } | null } },
): ParsedToken | null {
  const parsed = parseToken(token);
  if (!parsed.userId) return null;
  const user = globalDb.users.get(parsed.userId);
  if (!user) return null;
  return parsed;
}
```

- [ ] **Step 2: Add auth socket events in index.ts**

Inside the `/web` namespace `.on('connection', ...)` handler, after the existing events, add:

```typescript
socket.on('auth:register', async (
  payload: { username: string; password: string; email?: string; inviteToken?: string },
  ack?: (r: any) => void,
) => {
  try {
    const username = payload.username.trim();
    if (!username || username.length < 2) return ack?.({ ok: false, error: 'USERNAME_TOO_SHORT' });
    if (!payload.password || payload.password.length < 6) return ack?.({ ok: false, error: 'PASSWORD_TOO_SHORT' });

    if (globalDb.users.getByName(username)) return ack?.({ ok: false, error: 'USERNAME_TAKEN' });
    if (payload.email && globalDb.users.getByEmail(payload.email)) return ack?.({ ok: false, error: 'EMAIL_TAKEN' });

    const userId = newId();
    const passwordHash = await hashPassword(payload.password);
    const now = Date.now();

    globalDb.users.create({
      id: userId, username, email: payload.email ?? null,
      passwordHash, createdAt: now,
    });

    const privateNetworkId = newId();
    globalDb.networks.create({
      id: privateNetworkId, ownerId: userId,
      name: `${username}-private`, createdAt: now,
    });
    globalDb.networkMembers.add(privateNetworkId, userId, 'owner');

    const token = generateToken(userId, privateNetworkId);
    ack?.({ ok: true, userId, token, networkId: privateNetworkId });
  } catch (e: any) {
    ack?.({ ok: false, error: e.message ?? 'unknown' });
  }
});

socket.on('auth:login', async (
  payload: { username: string; password: string },
  ack?: (r: any) => void,
) => {
  try {
    const user = globalDb.users.getByName(payload.username);
    if (!user || !user.passwordHash) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });
    const ok = await verifyPassword(payload.password, user.passwordHash);
    if (!ok) return ack?.({ ok: false, error: 'INVALID_CREDENTIALS' });

    const members = globalDb.networkMembers.listByUser(user.id);
    const primaryNetwork = members.length > 0 ? members[0]!.networkId : 'default';
    const token = generateToken(user.id, primaryNetwork);
    ack?.({ ok: true, userId: user.id, token, networkId: primaryNetwork, username: user.username });
  } catch (e: any) {
    ack?.({ ok: false, error: e.message ?? 'unknown' });
  }
});

socket.on('auth:whoami', (_payload: {}, ack?: (r: any) => void) => {
  try {
    const clientToken = socket.handshake.auth.token;
    const parsed = parseToken(clientToken);
    if (!parsed.userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
    const user = globalDb.users.get(parsed.userId);
    if (!user) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
    ack?.({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
  } catch (e: any) {
    ack?.({ ok: false, error: e.message ?? 'unknown' });
  }
});
```

- [ ] **Step 3: Run all server tests**

Run: `cd apps/server && npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
cd apps/server
git add src/auth.ts src/index.ts
git commit -m "feat(server): auth register/login/whoami socket events"
```

---

### Task 5: Update /web auth middleware for per-user tokens

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Replace shared webToken check with per-user token validation**

Replace the `/web` namespace auth middleware (around lines 120-124):

```typescript
io.of('/web').use((socket, next) => {
  const clientToken = socket.handshake.auth.token ?? socket.handshake.query.token;
  if (!clientToken || typeof clientToken !== 'string') return next(new Error('unauthorized'));
  // Accept the legacy shared token for backwards compat
  if (clientToken === webToken) {
    socket.data.legacyAuth = true;
    return next();
  }
  // Per-user token: verify userId exists
  const parsed = verifyUserToken(clientToken, globalDb);
  if (!parsed) return next(new Error('unauthorized'));
  socket.data.userId = parsed.userId;
  socket.data.networkId = parsed.networkId;
  next();
}).on('connection', (socket) => {
```

- [ ] **Step 2: Update network:list to filter by user membership**

In the `network:list` handler, filter results:

```typescript
socket.on('network:list', (_payload: {}, ack?: (r: any) => void) => {
  try {
    let networks = globalDb.networks.list();
    const userId = socket.data.userId;
    if (userId) {
      // Per-user: show private networks where user is member + all public networks
      const memberOf = new Set(globalDb.networkMembers.listByUser(userId).map(m => m.networkId));
      networks = networks.filter(n => n.visibility === 'public' || memberOf.has(n.id));
    }
    ack?.({ ok: true, networks });
  } catch (e: any) {
    ack?.({ ok: false, error: e.message ?? 'unknown' });
  }
});
```

- [ ] **Step 3: Mark default network as public**

In the startup code where default network is created, ensure it has `visibility: 'public'`. Update the create call to include visibility, or add an ALTER + UPDATE for existing data.

- [ ] **Step 4: Run all server tests**

Run: `cd apps/server && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
cd apps/server
git add src/index.ts
git commit -m "feat(server): per-user web auth and network visibility filtering"
```

---

## Phase 2: Invite System — Daemon Side

### Task 6: Agent daemon —invite mode

**Files:**
- Modify: `apps/daemon/src/index.ts` — add `--invite` flag and `runInviteMode()`
- Create: `apps/daemon/src/auth-store.ts` — token persistence to `~/.agentbean/auth.json`

- [ ] **Step 1: Create auth-store.ts**

```typescript
// apps/daemon/src/auth-store.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const AUTH_DIR = join(homedir(), '.agentbean');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

export interface AuthData {
  token: string;
  serverUrl: string;
  userId?: string;
  networkId?: string;
}

export function loadAuth(): AuthData | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData): void {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

export function clearAuth(): void {
  if (existsSync(AUTH_FILE)) {
    const { unlinkSync } = require('node:fs');
    unlinkSync(AUTH_FILE);
  }
}
```

- [ ] **Step 2: Add --invite flag to parseArgs options in index.ts**

In `runCliMode()`, add `'invite'` option:
```typescript
'invite': { type: 'string' },
```

- [ ] **Step 3: Add runInviteMode() function**

```typescript
async function runInviteMode(serverUrl: string, inviteCode: string) {
  const { io } = await import('socket.io-client');
  const { execSync } = await import('node:child_process');

  logger.info({ serverUrl, inviteCode }, 'invite mode: connecting to server');

  // Temporary connection without auth token
  const socket = io(serverUrl, { transports: ['websocket'], reconnection: false });

  return new Promise<void>((resolve, reject) => {
    socket.on('connect_error', (err) => {
      logger.error({ err: err.message }, 'invite mode: connection failed');
      reject(new Error(`connection failed: ${err.message}`));
    });

    socket.on('connect', () => {
      logger.info('invite mode: connected, validating invite code');
      socket.emit('auth:invite:validate', { code: inviteCode }, (res: any) => {
        if (!res?.ok) {
          reject(new Error(res?.error ?? 'invalid invite code'));
          return;
        }

        const registerUrl = res.registerUrl;
        logger.info({ registerUrl }, 'invite mode: opening browser');
        try {
          execSync(`open "${registerUrl}"`, { stdio: 'ignore' });
        } catch {
          logger.info({ registerUrl }, 'invite mode: could not open browser, please visit URL manually');
          console.log(`\nPlease open this URL in your browser:\n${registerUrl}\n`);
        }

        console.log('Waiting for registration to complete...');
        socket.on('auth:token:deliver', (payload: any) => {
          if (payload.token) {
            const { saveAuth } = require('./auth-store.js');
            saveAuth({ token: payload.token, serverUrl });
            logger.info('invite mode: token received, saved');
            console.log('Registration complete! Starting daemon...');
            socket.disconnect();
            resolve();
          }
        });
      });
    });
  });
}
```

- [ ] **Step 4: Wire invite mode into main()**

In `main()`, check for `--invite` flag before other modes:

```typescript
const inviteCode = process.argv[process.argv.indexOf('--invite') + 1];
if (inviteCode) {
  const serverUrl = process.argv[process.argv.indexOf('--server-url') + 1] ?? process.env.AGENT_BEAN_SERVER_URL;
  if (!serverUrl) throw new Error('--server-url is required with --invite');
  await runInviteMode(serverUrl, inviteCode);
  // After invite, fall through to normal daemon start with saved token
}
```

- [ ] **Step 5: Build and verify**

Run: `cd apps/daemon && npx tsc && npm test`
Expected: Build succeeds, 10/10 tests pass

- [ ] **Step 6: Commit**

```bash
cd apps/daemon
git add src/auth-store.ts src/index.ts
git commit -m "feat(agent): --invite mode with browser registration flow"
```

---

### Task 7: Server-side invite validation and token delivery

**Files:**
- Modify: `apps/server/src/namespaces/agent.ts` — add `auth:invite:validate` and `auth:token:deliver`

- [ ] **Step 1: Add invite validation endpoint**

Inside the `/agent` namespace, add a new connection handler after the auth middleware. This requires a separate connection path for unauthenticated invite validation.

In `index.ts`, add a new socket event handler inside the `/web` namespace for invite validation (since `/agent` requires auth):

```typescript
socket.on('auth:invite:validate', (payload: { code: string }, ack?: (r: any) => void) => {
  try {
    const invite = globalDb.invites.getByCode(payload.code);
    if (!invite) return ack?.({ ok: false, error: 'INVALID_CODE' });
    if (invite.usedAt) return ack?.({ ok: false, error: 'ALREADY_USED' });
    if (invite.expiresAt && invite.expiresAt < Date.now()) return ack?.({ ok: false, error: 'EXPIRED' });

    const sessionId = newId();
    const registerUrl = `${process.env.WEB_URL ?? 'http://localhost:3100'}/join/${sessionId}`;
    // Store sessionId → socket mapping for token delivery
    inviteSessions.set(sessionId, socket);
    ack?.({ ok: true, sessionId, registerUrl });
  } catch (e: any) {
    ack?.({ ok: false, error: e.message ?? 'unknown' });
  }
});
```

Add `const inviteSessions = new Map<string, any>();` near the top of `buildApp()`.

- [ ] **Step 2: Wire token delivery into register handler**

After the `auth:register` handler creates the token, check if there's a waiting invite session:

```typescript
// At the end of auth:register handler, after ack:
const invite = payload.inviteToken ? globalDb.invites.getByCode(payload.inviteToken) : null;
if (invite) {
  globalDb.invites.markUsed(invite.code);
}
// If there's a waiting daemon session, deliver the token
for (const [sessionId, daemonSocket] of inviteSessions.entries()) {
  daemonSocket.emit('auth:token:deliver', { sessionId, token });
  inviteSessions.delete(sessionId);
}
```

- [ ] **Step 3: Add invite generation event**

```typescript
socket.on('invite:create', (payload: { networkId?: string }, ack?: (r: any) => void) => {
  try {
    const userId = socket.data.userId;
    if (!userId) return ack?.({ ok: false, error: 'NOT_AUTHENTICATED' });
    const code = generateInviteCode();
    const id = newId();
    const invite = globalDb.invites.create({
      id, code, createdBy: userId,
      networkId: payload.networkId ?? null,
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 days
    });
    ack?.({ ok: true, invite: { code, expiresAt: invite.expiresAt } });
  } catch (e: any) {
    ack?.({ ok: false, error: e.message ?? 'unknown' });
  }
});
```

- [ ] **Step 4: Run all server tests**

Run: `cd apps/server && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
cd apps/server
git add src/index.ts src/namespaces/agent.ts
git commit -m "feat(server): invite validation, token delivery, invite generation"
```

---

## Phase 3: Private/Public Network + Agent Visibility

### Task 8: Network visibility + agent cross-network publishing

**Files:**
- Modify: `apps/server/src/index.ts` — filter agents by network, support visibility toggle
- Modify: `apps/server/src/db.ts` — extend NetworkRow with visibility

- [ ] **Step 1: Add visibility to NetworkRow**

In `db.ts`, add `visibility: string` to `NetworkRow` interface and update the row mapping.

- [ ] **Step 2: Update agents:snapshot to filter by current network**

In the `agents:subscribe` handler, filter agents:

```typescript
socket.on('agents:subscribe', () => {
  const networkId = socketNetworkMap.get(socket.id) ?? defaultNetworkId;
  const all = registry.all();
  const filtered = all.filter(a => {
    // Show agents in current network OR public agents from other networks
    return a.networkId === networkId || a.visibility === 'public';
  });
  socket.emit('agents:snapshot', filtered.map(snapshotToDto));
});
```

- [ ] **Step 3: Update agent:update to support visibility toggle**

Ensure the `agent:update` handler can toggle `visibility` between `private` and `public`.

- [ ] **Step 4: Run all server tests**

Run: `cd apps/server && npx vitest run`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
cd apps/server
git add src/index.ts src/db.ts
git commit -m "feat(server): network visibility and agent cross-network publishing"
```

---

### Task 9: Dispatch with sandboxed flag

**Files:**
- Modify: `apps/server/src/namespaces/agent.ts` — add `sandboxed` to dispatch payload

- [ ] **Step 1: Add sandboxed field to dispatch**

In the `dispatch` function (around line 220), when emitting the `dispatch` event, compute and include:

```typescript
const agentRuntime = deps.registry.snapshot(req.agentId);
const sandboxed = agentRuntime?.visibility === 'public' && agentRuntime.category !== 'agentos-hosted';
socket.emit('dispatch', { ...req, sandboxed });
```

- [ ] **Step 2: Run all server tests**

Run: `cd apps/server && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
cd apps/server
git add src/namespaces/agent.ts
git commit -m "feat(server): add sandboxed flag to dispatch payload"
```

---

## Phase 4: Web UI

### Task 10: Web schema + store + socket extensions

**Files:**
- Modify: `apps/web/lib/schema.ts`
- Modify: `apps/web/lib/store.ts`
- Modify: `apps/web/lib/socket.ts`

- [ ] **Step 1: Add new types to schema.ts**

```typescript
export interface UserInfo {
  id: string;
  username: string;
  email: string | null;
}

export interface InviteInfo {
  code: string;
  expiresAt: number;
}
```

- [ ] **Step 2: Extend store.ts with currentUser state**

Add `currentUser: UserInfo | null` to State, add `setCurrentUser(user)` action, add `authToken: string | null` and `setAuthToken(token)` action.

- [ ] **Step 3: Add auth events to socket.ts**

Add `AuthEvents` interface with `register`, `login`, `whoami`, `inviteCreate` methods. Add `authEvents()` factory function.

- [ ] **Step 4: Run web build**

Run: `cd apps/web && npx next build`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
cd apps/web
git add lib/schema.ts lib/store.ts lib/socket.ts
git commit -m "feat(web): auth types, store, and socket events"
```

---

### Task 11: Registration page /join/[token]

**Files:**
- Create: `apps/web/app/join/[token]/page.tsx`

- [ ] **Step 1: Create join page**

A `'use client'` page component with:
- Form fields: username, password, email
- Submit handler: calls `authEvents().register({ username, password, email, inviteToken })`
- On success: stores token in localStorage + zustand, redirects to `/dashboard`
- Login link for existing users

- [ ] **Step 2: Build and verify**

Run: `cd apps/web && npx next build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd apps/web
git add app/join/
git commit -m "feat(web): registration page /join/[token]"
```

---

### Task 12: Private network dashboard /dashboard

**Files:**
- Create: `apps/web/app/dashboard/page.tsx`

- [ ] **Step 1: Create dashboard page**

Combines the existing scan functionality from `/agents` into a private network dashboard:
- Runtime scan section (display only)
- AgentOS scan section (with add/publish actions)
- Add Agent button + modal
- Agent list with visibility toggle (private ↔ public)
- Invite command generation section

- [ ] **Step 2: Build and verify**

Run: `cd apps/web && npx next build`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
cd apps/web
git add app/dashboard/
git commit -m "feat(web): private network dashboard page"
```

---

### Task 13: Sidebar + agents page updates

**Files:**
- Modify: `apps/web/components/sidebar.tsx`
- Modify: `apps/web/app/agents/page.tsx`

- [ ] **Step 1: Update sidebar**

Add Dashboard link, filter navigation by network context, add invite button.

- [ ] **Step 2: Update agents page to show only public agents**

Filter agent list to only show `visibility === 'public'` agents. Remove scan/add functionality (moved to dashboard). Keep invite command section.

- [ ] **Step 3: Build and verify**

Run: `cd apps/web && npx next build`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
cd apps/web
git add components/sidebar.tsx app/agents/page.tsx
git commit -m "feat(web): sidebar with dashboard, agents page public-only"
```

---

## Phase 5: Sandbox Execution

### Task 14: Sandbox profile generator

**Files:**
- Create: `apps/daemon/src/sandbox.ts`

- [ ] **Step 1: Create sandbox.ts**

```typescript
// apps/daemon/src/sandbox.ts
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function getWorkspaceDir(agentId: string): string {
  const dir = join(homedir(), '.agentbean', 'workspaces', agentId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function generateSandboxProfile(agentId: string, runtimePath: string): string {
  const workspaceDir = getWorkspaceDir(agentId);
  // Derive runtime parent directory for read access
  const runtimeDir = runtimePath.substring(0, runtimePath.lastIndexOf('/'));

  const profile = `(version 1)
(allow file-read* file-write*
  (subpath "${workspaceDir}"))
(allow file-read* file-write*
  (subpath "/tmp"))
(allow file-read*
  (subpath "${runtimeDir}"))
(allow network-outbound
  (remote tcp "api.anthropic.com" 443))
(allow network-outbound
  (remote tcp "api.openai.com" 443))
(deny default)
`;
  const profilePath = `/tmp/agentbean-sandbox-${agentId}.sb`;
  writeFileSync(profilePath, profile);
  return profilePath;
}

export function isSandboxAvailable(): boolean {
  return process.platform === 'darwin';
}
```

- [ ] **Step 2: Commit**

```bash
cd apps/daemon
git add src/sandbox.ts
git commit -m "feat(agent): macOS sandbox profile generator"
```

---

### Task 15: Sandbox-wrapped dispatch in agent-instance

**Files:**
- Modify: `apps/daemon/src/agent-instance.ts`
- Modify: `apps/daemon/src/config.ts`

- [ ] **Step 1: Add sandboxed field to AgentConfigEntry**

In `config.ts`, add `sandboxed?: boolean` to the `AgentConfigEntry` interface.

- [ ] **Step 2: Modify handleDispatch to wrap adapter spawn with sandbox-exec**

In `agent-instance.ts`, modify the `handleDispatch` method. The adapter's `ask()` method spawns a child process — we need to intercept the spawn args when sandboxed:

Add a `sandboxed` field to the class, set it from config. Before calling `this.adapter.ask()`, if sandboxed and macOS, generate a sandbox profile and pass a modified command to the adapter.

The cleanest approach: add an optional `preSpawn` hook to the adapter interface, or wrap the adapter's command at construction time.

In `pickAdapter()` (index.ts), when creating the adapter for a sandboxed agent, wrap the command:

```typescript
if (entry.sandboxed && isSandboxAvailable()) {
  const profilePath = generateSandboxProfile(entry.id, entry.adapter.command);
  adapter = new ClaudeCodeAdapter({
    ...opts,
    command: 'sandbox-exec',
    args: ['-f', profilePath, '--', entry.adapter.command, ...(opts.args ?? [])],
  });
}
```

- [ ] **Step 3: Wire sandboxed flag from dispatch to agent instance**

In `device-daemon.ts`, when receiving a `dispatch` event, set `sandboxed` on the agent config before calling `handleDispatch()`. Alternatively, pass `sandboxed` as a parameter to `handleDispatch()`.

- [ ] **Step 4: Build and test**

Run: `cd apps/daemon && npx tsc && npm test`
Expected: Build succeeds, tests pass

- [ ] **Step 5: Commit**

```bash
cd apps/daemon
git add src/agent-instance.ts src/config.ts src/device-daemon.ts src/index.ts
git commit -m "feat(agent): sandbox-exec wrapping for public agents"
```

---

### Task 16: Integration test — full flow

**Files:**
- Create: `apps/server/tests/user-auth-flow.test.ts`

- [ ] **Step 1: Write integration test**

Test the full flow:
1. Create invite
2. Register user with invite
3. Login with credentials
4. Verify private network created
5. Verify token works for socket auth

- [ ] **Step 2: Run all tests**

Run: `cd apps/server && npx vitest run && cd ../agent && npm test`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
cd apps/server
git add tests/user-auth-flow.test.ts
git commit -m "test(server): integration test for user auth flow"
```

---

## Verification Checklist

- [ ] `cd apps/server && npx vitest run` — all tests pass
- [ ] `cd apps/daemon && npm test` — all tests pass
- [ ] `cd apps/web && npx next build` — build succeeds
- [ ] `npx @agentbean/daemon@latest --invite <code> --server-url <url>` — opens browser
- [ ] Registration form creates user + private network
- [ ] Dashboard shows scan results
- [ ] Agent visibility toggle works (private ↔ public)
- [ ] Public agents receive `sandboxed: true` in dispatch
