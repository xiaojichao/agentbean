# 设备吊销（Device Revocation）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐 task 执行。步骤用 checkbox（`- [ ]`）跟踪。

**Goal:** 离线设备删除后，daemon 重连不再经 deviceHello upsert 复活——用吊销表让 deviceHello 拒绝已删 machineId。

**Architecture:** 新增 `device_revocations` 表（吊销键 `teamId+machineId+profileId`）。`deleteDevice` 删整组前写吊销；`deviceHello`（重连）查吊销拒绝返回 `DEVICE_REVOKED`；`deviceHelloFromCredentials`（invite 接入）调 deviceHello 前清吊销放行；daemon 收 `DEVICE_REVOKED` 复用 `onDeviceRemoved` 退出。在线删除双保险（层1 device:removed + 层2 吊销）。

**Tech Stack:** TypeScript、SQLite（better-sqlite3）、socket.io、vitest、Node 24。

## Global Constraints

- Node v24（`.nvmrc` = v24.15.0）
- migration 必须在 `applyGlobalMigrations`（`apps/server-next/src/infra/sqlite/repositories.ts`）**静态枚举注册**，否则不生效（memory `server-next-migration-static-registration`）
- 每步 `git commit`；commit message 中文
- 三端测试全绿 + `tsc -p tsconfig.json --noEmit`（strict）通过才算完成
- 测试用 in-memory repositories（不依赖 better-sqlite3 原生模块）；sqlite 实现单独测

---

### Task 1: 契约 DEVICE_REVOKED 错误码

**Files:**
- Modify: `packages/contracts/src/common.ts`（`ERROR_CODES` 数组）
- Test: `packages/contracts/tests/device-revoked.test.ts`（新建）

**Interfaces:**
- Produces: `ErrorCode` 联合类型新增 `'DEVICE_REVOKED'`

- [ ] **Step 1: 写失败测试**

```ts
// packages/contracts/tests/device-revoked.test.ts
import { describe, test, expect } from 'vitest';
import { ERROR_CODES } from '../src/common';

describe('DEVICE_REVOKED error code', () => {
  test('is registered in ERROR_CODES', () => {
    expect(ERROR_CODES).toContain('DEVICE_REVOKED');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/contracts && ../../node_modules/.bin/vitest run tests/device-revoked.test.ts`
Expected: FAIL（`ERROR_CODES` 不含 `DEVICE_REVOKED`）

- [ ] **Step 3: 最小实现**

在 `packages/contracts/src/common.ts` 的 `ERROR_CODES` 数组里 `'DEVICE_OFFLINE'` 后加一行：

```ts
  'DEVICE_OFFLINE',
  'DEVICE_REVOKED',
  'AGENT_OFFLINE',
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/contracts && ../../node_modules/.bin/vitest run tests/device-revoked.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add packages/contracts/src/common.ts packages/contracts/tests/device-revoked.test.ts
git commit -m "contracts: 新增 DEVICE_REVOKED 错误码"
```

---

### Task 2: migration 0010 + revocations repository（接口 + memory 实现 + 注册）

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0010_device_revocations.sql`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts:50`（`applyGlobalMigrations` 注册）
- Modify: `apps/server-next/src/application/repositories.ts`（加 `DeviceRevocationRecord` + `DeviceRevocationRepository` 接口 + `ServerNextRepositories` 字段）
- Modify: `apps/server-next/src/infra/memory/repositories.ts`（`revocations` 实现）
- Test: `apps/server-next/tests/device-revocations-repository.test.ts`（新建，memory）

**Interfaces:**
- Produces:
  - `DeviceRevocationRecord { teamId: ID; machineId: string; profileId?: string | null; deviceId?: ID; deletedAt: UnixMs }`
  - `repositories.revocations.find({ teamId, machineId, profileId? }) => Promise<DeviceRevocationRecord | null>`
  - `repositories.revocations.upsertAll({ revocations: DeviceRevocationRecord[] }) => Promise<void>`
  - `repositories.revocations.clear({ teamId, machineId }) => Promise<void>`

- [ ] **Step 1: 写失败测试（memory）**

```ts
// apps/server-next/tests/device-revocations-repository.test.ts
import { describe, test, expect } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('device revocations repository (memory)', () => {
  test('find returns null when no revocation', async () => {
    const repos = createInMemoryRepositories();
    const found = await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' });
    expect(found).toBeNull();
  });

  test('upsertAll then find hits (teamId, machineId, profileId)', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [
        { teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 },
      ],
    });
    const found = await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' });
    expect(found?.deviceId).toBe('d1');
  });

  test('find is scoped by teamId (cross-team isolation)', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [{ teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 }],
    });
    const other = await repos.revocations.find({ teamId: 't2', machineId: 'm1', profileId: 'p1' });
    expect(other).toBeNull();
  });

  test('clear removes all profileIds for (teamId, machineId)', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [
        { teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 },
        { teamId: 't1', machineId: 'm1', profileId: 'p2', deviceId: 'd2', deletedAt: 1000 },
      ],
    });
    await repos.revocations.clear({ teamId: 't1', machineId: 'm1' });
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' })).toBeNull();
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p2' })).toBeNull();
  });

  test('profileId null matches revocations with null profileId', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [{ teamId: 't1', machineId: 'm1', profileId: null, deviceId: 'd1', deletedAt: 1000 }],
    });
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null })).not.toBeNull();
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' })).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocations-repository.test.ts`
Expected: FAIL（`repos.revocations` undefined）

- [ ] **Step 3: 写 migration 文件**

```sql
-- apps/server-next/src/infra/sqlite/migrations/global/0010_device_revocations.sql
CREATE TABLE device_revocations (
  teamId      TEXT NOT NULL,
  machineId   TEXT NOT NULL,
  profileId   TEXT,
  deviceId    TEXT,
  deletedAt   INTEGER NOT NULL,
  PRIMARY KEY (teamId, machineId, profileId)
);
CREATE INDEX idx_revocations_machine ON device_revocations(teamId, machineId);
```

- [ ] **Step 4: 注册 migration**

在 `apps/server-next/src/infra/sqlite/repositories.ts` 的 `applyGlobalMigrations`，紧跟 `applyMigration(db, 'global/0009_agent_visibility.sql');`（约 :50）后加：

```ts
  applyMigration(db, 'global/0009_agent_visibility.sql');
  applyMigration(db, 'global/0010_device_revocations.sql');
```

- [ ] **Step 5: 加接口与 Record 类型**

在 `apps/server-next/src/application/repositories.ts`，`DeviceRepository`（:173）前加：

```ts
export interface DeviceRevocationRecord {
  teamId: ID;
  machineId: string;
  profileId?: string | null;
  deviceId?: ID;
  deletedAt: UnixMs;
}

export interface DeviceRevocationRepository {
  find(input: { teamId: ID; machineId: string; profileId?: string | null }): Promise<DeviceRevocationRecord | null>;
  upsertAll(input: { revocations: DeviceRevocationRecord[] }): Promise<void>;
  clear(input: { teamId: ID; machineId: string }): Promise<void>;
}
```

并把 `revocations: DeviceRevocationRepository;` 加进 `ServerNextRepositories`（找到该接口聚合处，与 `devices: DeviceRepository;` 并列）。

- [ ] **Step 6: memory 实现**

在 `apps/server-next/src/infra/memory/repositories.ts` 的 `createInMemoryRepositories` 闭包顶部（与现有 `const devices = new Map(...)` 并列）加：

```ts
  const deviceRevocations = new Map<string, DeviceRevocationRecord>();
  const revocationKey = (teamId: string, machineId: string, profileId?: string | null) =>
    `${teamId}|${machineId}|${profileId ?? ''}`;
```

在返回的 repositories 对象里（`devices: { ... }` 块之后）加：

```ts
    revocations: {
      async find({ teamId, machineId, profileId }) {
        return deviceRevocations.get(revocationKey(teamId, machineId, profileId)) ?? null;
      },
      async upsertAll({ revocations }) {
        for (const r of revocations) {
          deviceRevocations.set(revocationKey(r.teamId, r.machineId, r.profileId ?? null), r);
        }
      },
      async clear({ teamId, machineId }) {
        for (const key of Array.from(deviceRevocations.keys())) {
          const r = deviceRevocations.get(key)!;
          if (r.teamId === teamId && r.machineId === machineId) {
            deviceRevocations.delete(key);
          }
        }
      },
    },
```

（顶部 `import` 补 `DeviceRevocationRecord`。）

- [ ] **Step 7: 跑测试确认通过**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocations-repository.test.ts`
Expected: PASS（5/5）

- [ ] **Step 8: commit**

```bash
git add apps/server-next/src/infra/sqlite/migrations/global/0010_device_revocations.sql \
        apps/server-next/src/infra/sqlite/repositories.ts \
        apps/server-next/src/application/repositories.ts \
        apps/server-next/src/infra/memory/repositories.ts \
        apps/server-next/tests/device-revocations-repository.test.ts
git commit -m "server: device_revocations 表 + repository（memory 实现 + 注册）"
```

---

### Task 3: sqlite revocations 实现

**Files:**
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（`createSqliteRepositories` 返回对象加 `revocations`）
- Test: 复用 `apps/server-next/tests/device-revocations-repository.test.ts`，加 sqlite 套件

**Interfaces:**
- Consumes: Task 2 的 `DeviceRevocationRepository` 接口

- [ ] **Step 1: 加 sqlite 测试套件**

在 `apps/server-next/tests/device-revocations-repository.test.ts` 末尾加：

```ts
import { createSqliteRepositories } from '../src/infra/sqlite/repositories';
import { createServerNextMigrations } from '../src/infra/sqlite/repositories';

function createRepos() {
  const db = new (require('better-sqlite3'))(':memory:');
  return { db, repos: createSqliteRepositories(db) };
}

describe('device revocations repository (sqlite)', () => {
  test('upsertAll/find/clear round-trip with null profileId', async () => {
    const { repos } = createRepos();
    await repos.revocations.upsertAll({
      revocations: [{ teamId: 't1', machineId: 'm1', profileId: null, deviceId: 'd1', deletedAt: 1000 }],
    });
    expect((await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null }))?.deviceId).toBe('d1');
    await repos.revocations.clear({ teamId: 't1', machineId: 'm1' });
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null })).toBeNull();
  });
});
```

> 注：执行者需对照 `createSqliteRepositories` 现有 repo 块（如 `devices:`）确认 import 与 fixture 写法，使 sqlite 测试与现有 sqlite-repositories.test.ts 模式一致。`NULL` profileId 查询须用 `IS NULL`（不是 `= NULL`）。

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocations-repository.test.ts`
Expected: sqlite 套件 FAIL（`revocations` 未实现）

- [ ] **Step 3: sqlite 实现**

在 `createSqliteRepositories` 返回对象（`devices: { ... }` 之后）加：

```ts
    revocations: {
      async find({ teamId, machineId, profileId }) {
        const row = db.prepare(
          `SELECT teamId, machineId, profileId, deviceId, deletedAt FROM device_revocations
           WHERE teamId = ? AND machineId = ? AND profileId IS ?`,
        ).get(teamId, machineId, profileId ?? null) as any;
        return row ? { ...row, profileId: row.profileId ?? null } : null;
      },
      async upsertAll({ revocations }) {
        const stmt = db.prepare(
          `INSERT OR REPLACE INTO device_revocations (teamId, machineId, profileId, deviceId, deletedAt)
           VALUES (@teamId, @machineId, @profileId, @deviceId, @deletedAt)`,
        );
        const tx = db.transaction((rows: any[]) => rows.forEach((r) => stmt.run({ ...r, profileId: r.profileId ?? null })));
        tx(revocations);
      },
      async clear({ teamId, machineId }) {
        db.prepare(`DELETE FROM device_revocations WHERE teamId = ? AND machineId = ?`).run(teamId, machineId);
      },
    },
```

- [ ] **Step 4: 跑确认通过**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocations-repository.test.ts`
Expected: memory + sqlite 套件全 PASS

- [ ] **Step 5: commit**

```bash
git add apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/tests/device-revocations-repository.test.ts
git commit -m "server: device_revocations sqlite 实现（含 NULL profileId 处理）"
```

---

### Task 4: deleteDevice 写吊销（整组）

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:1577-1597`（`deleteDevice`）
- Test: `apps/server-next/tests/device-revocation.test.ts`（新建）

**Interfaces:**
- Consumes: `repositories.revocations.upsertAll`（Task 2）

- [ ] **Step 1: 写失败测试**

```ts
// apps/server-next/tests/device-revocation.test.ts
import { describe, test, expect } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

async function boot() {
  const repos = createInMemoryRepositories();
  const app = createServerNextUseCases({ repositories: repos, now: () => 1000 });
  // 用户/团队/设备 fixture（参照现有 device-management.test.ts 的 boot 模式）
  // ...注册 user-1/team-1，device.hello 上报 device-1 (machineId=machine-1, profileId=default)
  return { app, repos };
}

describe('deleteDevice writes revocations', () => {
  test('deleting a device revokes its (teamId, machineId, profileId)', async () => {
    const { app, repos } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    const revoked = await repos.revocations.find({ teamId: 'team-1', machineId: 'machine-1', profileId: 'default' });
    expect(revoked).not.toBeNull();
  });
});
```

> 执行者：补全 `boot()` 的 fixture（参照 `tests/device-management.test.ts` 现有设备 fixture，确保 device-1 有 `machineId='machine-1'`、`profileId='default'`）。

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: FAIL（删后 `revocations.find` 返回 null）

- [ ] **Step 3: 实现**

在 `usecases.ts` `deleteDevice`（:1578 `devicesToDelete = resolveDeviceAliasGroup(...)` 之后、:1595 物理删循环之前）插入：

```ts
      const devicesToDelete = resolveDeviceAliasGroup(device, teamDevices);
      // 写吊销：整组所有真实设备（有 machineId）的凭证，防 deviceHello 重连复活
      await repositories.revocations.upsertAll({
        revocations: devicesToDelete
          .filter((target) => target.machineId)
          .map((target) => ({
            teamId: target.teamId,
            machineId: target.machineId!,
            profileId: target.profileId ?? null,
            deviceId: target.id,
            deletedAt: now,
          })),
      });
      const hostedAgents = ( ... )  // 现有代码照旧
```

- [ ] **Step 4: 跑确认通过**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/device-revocation.test.ts
git commit -m "server: deleteDevice 删整组前写 device_revocations 吊销"
```

---

### Task 5: deviceHello（重连）查拒 DEVICE_REVOKED

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:1347-1389`（`deviceHello`，upsertHello 前）
- Test: 追加到 `apps/server-next/tests/device-revocation.test.ts`

**Interfaces:**
- Consumes: `repositories.revocations.find`（Task 2）、`DEVICE_REVOKED`（Task 1）

- [ ] **Step 1: 写失败测试**

追加到 `device-revocation.test.ts`：

```ts
describe('deviceHello rejects revoked devices', () => {
  test('deviceHello after delete returns DEVICE_REVOKED and does not re-create record', async () => {
    const { app, repos } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    const res = await app.deviceHello({
      teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default', hostname: 'h',
    });
    expect(res).toMatchObject({ ok: false, error: 'DEVICE_REVOKED' });
    // 关键：不复活——DB 不应再出现该 machineId 的设备记录
    const found = await repos.devices.findByMachineProfile({ teamId: 'team-1', machineId: 'machine-1', profileId: 'default' });
    expect(found).toBeNull();
  });

  test('cross-team: revoking teamA does not reject teamB deviceHello', async () => {
    const { app } = await boot();  // boot 内另建 team-2 + 同 machineId 设备（参照 fixture）
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' }); // 删 team-1
    const res = await app.deviceHello({
      teamId: 'team-2', ownerId: 'user-2', machineId: 'machine-1', profileId: 'default', hostname: 'h',
    });
    expect(res.ok).toBe(true);  // team-2 不受影响
  });
});
```

> 执行者：`boot()` 扩展支持 team-2 + user-2 + 同 machineId 设备。

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: 新增 FAIL（`deviceHello` 返回 `ok:true`，复活了）

- [ ] **Step 3: 实现**

在 `usecases.ts` `deviceHello`（:1356 `existing` 计算之后、:1389 `upsertHello` 之前）插入吊销检查：

```ts
      const existing = deviceInput.machineId && deviceInput.profileId
        ? await repositories.devices.findByMachineProfile({ ... })
        : null;

      // 吊销检查：离线删除后重连复活防护（层2）
      if (deviceInput.machineId) {
        const revoked = await repositories.revocations.find({
          teamId: deviceInput.teamId,
          machineId: deviceInput.machineId,
          profileId: deviceInput.profileId ?? null,
        });
        if (revoked) {
          return makeFailure('DEVICE_REVOKED', 'Device was removed from team');
        }
      }
```

- [ ] **Step 4: 跑确认通过**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: PASS（含跨团队用例）

- [ ] **Step 5: commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/device-revocation.test.ts
git commit -m "server: deviceHello 查吊销表拒绝已删设备（DEVICE_REVOKED）"
```

---

### Task 6: deviceHelloFromCredentials（invite）清吊销

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts:1306-1320`（`deviceHelloFromCredentials`）
- Test: 追加到 `apps/server-next/tests/device-revocation.test.ts`

**Interfaces:**
- Consumes: `repositories.revocations.clear`（Task 2）

- [ ] **Step 1: 写失败测试**

追加：

```ts
describe('deviceHelloFromCredentials clears revocation (re-invite)', () => {
  test('after delete, invite-path hello clears revocation and succeeds', async () => {
    const { app, repos } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    // 重新 invite 接入：deviceHelloFromCredentials（带合法 token）
    const token = signDeviceToken({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default', hostname: 'h' }, sessionSecret);
    const res = await app.deviceHelloFromCredentials({ token, machineId: 'machine-1', profileId: 'default', hostname: 'h' });
    expect(res.ok).toBe(true);
    // 吊销应被清除
    expect(await repos.revocations.find({ teamId: 'team-1', machineId: 'machine-1', profileId: 'default' })).toBeNull();
  });
});
```

> 执行者：`signDeviceToken`/`sessionSecret` 参照 `tests/device-invite*.test.ts` 现有 token 签名模式。

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: FAIL（invite hello 被 deviceHello 的吊销检查拒，`ok:false DEVICE_REVOKED`）

- [ ] **Step 3: 实现**

在 `usecases.ts` `deviceHelloFromCredentials`（:1311 `return this.deviceHello(...)` **之前**）插入清除：

```ts
      const credentials = verifyDeviceToken(deviceInput.token, sessionSecret);
      if (!credentials) {
        return makeFailure('UNAUTHENTICATED', 'Invalid device credentials');
      }
      // invite 合法接入路径：清除该机器在本团队的吊销，允许重新接入
      const machineId = deviceInput.machineId ?? credentials.machineId;
      if (machineId) {
        await repositories.revocations.clear({ teamId: credentials.teamId, machineId });
      }
      return this.deviceHello({ ... });  // 现有代码照旧
```

- [ ] **Step 4: 跑确认通过**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: PASS（invite 清吊销后成功）

- [ ] **Step 5: commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/device-revocation.test.ts
git commit -m "server: deviceHelloFromCredentials invite 路径清除吊销，允许重新接入"
```

---

### Task 7: daemon 收 DEVICE_REVOKED 复用 onDeviceRemoved 退出

**Files:**
- Modify: `apps/daemon-next/src/index.ts:364-376`（`announceDeviceSnapshot`）
- Modify: `apps/daemon-next/src/index.ts`（`announceDeviceSnapshot` 调用点，传 `onDeviceRemoved`）
- Test: `apps/daemon-next/tests/device-revoked-reconnect.test.ts`（新建）

**Interfaces:**
- Consumes: `input.onDeviceRemoved`（层1 已有，cli.ts:549 disconnect+exit）

> 说明：spec 写的是新回调 `onDeviceRevoked`；实现时**复用现有 `onDeviceRemoved`**（语义一致——"服务端删了我"，反应都是 disconnect+exit），更 DRY，不新增回调。

- [ ] **Step 1: 写失败测试**

```ts
// apps/daemon-next/tests/device-revoked-reconnect.test.ts
import { describe, test, expect, vi } from 'vitest';
// 参照 tests/protocol-client.test.ts 的 createDaemonProtocolClient 测试 fixture

describe('daemon handles DEVICE_REVOKED on hello', () => {
  test('on DEVICE_REVOKED ack, invokes onDeviceRemoved and aborts announce', async () => {
    const onDeviceRemoved = vi.fn();
    const socket = makeMockSocket({ helloAck: { ok: false, error: 'DEVICE_REVOKED' } });
    const client = createDaemonProtocolClient({
      socket, /* device, runtimes, agents, ... */
      onDeviceRemoved,
    } as any);
    // 触发一次 announce（hello 握手）
    await expect(client.announce()).rejects.toThrow();
    expect(onDeviceRemoved).toHaveBeenCalled();
  });
});
```

> 执行者：对照 `tests/protocol-client.test.ts` 现有 mock socket + announce 触发方式补全 fixture。

- [ ] **Step 2: 跑确认失败**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/device-revoked-reconnect.test.ts`
Expected: FAIL（`onDeviceRemoved` 未被调）

- [ ] **Step 3: 实现**

`announceDeviceSnapshot`（index.ts:364）加 `onDeviceRemoved` 参数，在 `readAckDeviceId` 前检查：

```ts
async function announceDeviceSnapshot(
  socket: DaemonProtocolSocket,
  device: DaemonDeviceConfig,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
  options: { onDeviceRemoved?: () => Promise<void> | void } = {},
): Promise<{ deviceId: string; credentials?: DaemonDeviceCredentialsUpdate }> {
  const helloAck = await socket.emitWithAck(AGENT_EVENTS.device.hello, device);
  // 层2：离线删除后重连被拒——复用 onDeviceRemoved 退出，不复活
  if (helloAck && typeof helloAck === 'object' && (helloAck as any).ok === false && (helloAck as any).error === 'DEVICE_REVOKED') {
    await options.onDeviceRemoved?.();
    throw new Error('Device revoked by server; aborting announce');
  }
  const deviceId = readAckDeviceId(helloAck);
  const credentials = readAckDeviceCredentials(helloAck);
  await reportDeviceSnapshot(socket, device.teamId, deviceId, runtimes, agents, { required: true });
  return { deviceId, ...(credentials ? { credentials } : {}) };
}
```

并在所有 `announceDeviceSnapshot(...)` 调用点（`createDaemonProtocolClient` 内 hello/rescan 流程）传 `options: { onDeviceRemoved: input.onDeviceRemoved }`。grep `announceDeviceSnapshot(` 找全部调用点。

- [ ] **Step 4: 跑确认通过**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/device-revoked-reconnect.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/tests/device-revoked-reconnect.test.ts
git commit -m "daemon: deviceHello 收 DEVICE_REVOKED 复用 onDeviceRemoved 退出"
```

---

### Task 8: 双保险验证 + 全量回归

**Files:**
- Test: 追加到 `apps/server-next/tests/device-revocation.test.ts`（在线删除双保险）
- 无新源码（验证 Task 4-7 集成）

- [ ] **Step 1: 写在线删除双保险测试**

追加到 `device-revocation.test.ts`：

```ts
describe('online delete defense-in-depth (layer1 + layer2)', () => {
  test('online delete still writes revocation even though layer1 kicks socket', async () => {
    const { app, repos } = await boot();
    await app.deleteDevice({ userId: 'user-1', deviceId: 'device-1' });
    // 层2 兜底：即便 daemon 没收到 device:removed，吊销也已写入
    expect(await repos.revocations.find({ teamId: 'team-1', machineId: 'machine-1', profileId: 'default' })).not.toBeNull();
  });
});
```

> device:removed 的 emit 由 socket-server 层负责（层1 PR#380 已实现），这里只验证 usecase 层吊销写入。

- [ ] **Step 2: 跑确认通过**

Run: `cd apps/server-next && ../../node_modules/.bin/vitest run tests/device-revocation.test.ts`
Expected: PASS

- [ ] **Step 3: 全量三端测试 + tsc**

```bash
npm run test:contracts
npm run test:server-next
npm run test:daemon-next
npm run test:web-next
npx tsc -p apps/server-next/tsconfig.json --noEmit
npx tsc -p apps/daemon-next/tsconfig.json --noEmit
npx tsc -p apps/web-next/tsconfig.json --noEmit
```
Expected: 全 PASS / exit 0（server-next 的 better-sqlite3 集成测试若本地环境脏报错，以 CI 为准）

- [ ] **Step 4: commit**

```bash
git add apps/server-next/tests/device-revocation.test.ts
git commit -m "test: 在线删除双保险（层1 device:removed + 层2 吊销）回归"
```

- [ ] **Step 5: push 开 PR**

```bash
git push -u origin feat/device-revocation
gh pr create --repo xiaojichao/agentbean --base main --head feat/device-revocation \
  --title "feat: 设备吊销（防离线删除后重连复活，层2）" \
  --body-file docs/superpowers/specs/2026-07-02-device-revocation-design.md
```

---

## Self-Review 校验记录

- **Spec 覆盖**：migration(0010)→T2-3；revocations repo→T2-3；deleteDevice 写吊销→T4；deviceHello 查拒→T5；deviceHelloFromCredentials 清→T6；daemon REVOKED 退出→T7；契约→T1；双保险→T8。✅ 全覆盖。
- **类型一致**：`revocations.find/upsertAll/clear` 签名跨 T2/4/5/6 一致；`DEVICE_REVOKED` 字面量跨 T1/5 一致。✅
- **Spec 偏差（已注明）**：① migration 0009→0010（0009 被占）；② `onDeviceRevoked`→复用 `onDeviceRemoved`（DRY）。
