# 设备别名持久化（canonicalDeviceId）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「更改设备名称后，设备列表与成员列表出现重复」的 bug——通过给设备记录引入持久化的 `canonicalDeviceId` 别名关系，让去重不再依赖可变的设备名。

**Architecture:** 设备身份分两类：有 `machineId/profileId` 的设备已有稳定身份（靠 machineKey 去重，无此 bug）；缺 `machineId` 的设备每次 hello 都新建记录，当前靠 `deviceDisplayKey`（含可变 `device.name`）在读取时临时合并，rename 改名即分裂。本方案在 `deviceHello` 写入时用现有 heuristic 判定别名并**持久化** `canonicalDeviceId` 自引用关系；`dedupeDeviceRecords` 改为优先按 canonical 关系折叠，原 machineKey/displayKey heuristic 降级为兜底。rename 因此无需改动——身份关系持久化后，改名不影响别名合并。

**Tech Stack:** TypeScript（Node 22）、Vitest、Socket.IO、better-sqlite3（纯 SQL migration，runner 不支持 JS backfill）。

## 根因证据链（已用失败测试锁死）

```
renameDevice → updateName: UPDATE devices SET hostname=?   (usecases.ts:1525)
→ mapDevice: name = hostname 列                              (sqlite/repositories.ts mapDevice)
→ device.name 变化
→ deviceDisplayKey(device) 变化                              (usecases.ts:3469, key 含 device.name)
→ deviceRecordsCanAlias() 返回 false                         (usecases.ts:3436)
→ dedupeDeviceRecords() 不再合并别名                         (usecases.ts:3406)
→ listDevices 返回重复 → devices 列表重复
→ resolveCanonicalDeviceRecord() 失效 → toAgentMemberDtos 分裂 → members 分组重复
```

RED 测试：`apps/server-next/tests/device-management.test.ts` 的 `renaming a device keeps alias records merged instead of splitting into duplicates`（改名后 `listDevices` 从 1 条变 2 条）。

## Global Constraints

- **语言**：所有新增代码注释、计划、commit message 关键词用中文可读；代码标识符用英文。
- **Node 22**，包管理器 **npm**（根目录 `package-lock.json`）。
- **双 repo 一致**：`infra/memory/repositories.ts` 与 `infra/sqlite/repositories.ts` 必须同步支持新字段与新方法（in-memory 用于单测，sqlite 用于生产）。
- **migration 仅支持 `.sql`**：runner 是 `db.exec(readFileSync(...))`，回填必须用纯 SQL 表达。`normalizeDeviceKey = value.trim().toLowerCase()`，SQL 用 `LOWER(TRIM(hostname))` 精确复刻。
- **不污染对外契约**：`canonicalDeviceId` 加在 `DeviceRecord`（server 内部），**不加**到 `packages/contracts/src/device.ts` 的 `DeviceDto`。
- **独立分支**：当前在 `fix/daemon-next-pty-test-cleanup`（有未提交的 daemon 测试改动）。本修复必须开独立分支，不混入。
- **TDD**：每个任务先写/运行失败测试，再实现，再转绿，再 commit。

## File Structure

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `apps/server-next/src/application/repositories.ts` | `DeviceRecord` 类型 + `DeviceRepository` 接口 | 加字段 + 加方法签名 |
| `apps/server-next/src/infra/sqlite/repositories.ts` | sqlite 设备持久化 | mapDevice/upsertHello 加字段 + findCanonicalByDisplay |
| `apps/server-next/src/infra/memory/repositories.ts` | in-memory 设备持久化 | upsertHello 透传 + findCanonicalByDisplay |
| `apps/server-next/src/application/usecases.ts` | deviceHello 建立关系 + dedupe 按 canonical 折叠 | 改 deviceHello + 拆 dedupeDeviceRecords |
| `apps/server-next/src/infra/sqlite/migrations/global/0007_device_canonical.sql` | schema + 回填 | 新建 |
| `apps/server-next/tests/device-management.test.ts` | 端到端 RED 测试（已存在） | 转绿 |
| `apps/server-next/tests/sqlite-repositories.test.ts` | 回填 migration 验证 | 加测试 |

---

### Task 1: DeviceRecord 加 `canonicalDeviceId` 字段 + 双 repo 透传

**Files:**
- Modify: `apps/server-next/src/application/repositories.ts`（DeviceRecord 定义 + DeviceRepository 接口）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（mapDevice + upsertHello）
- Modify: `apps/server-next/src/infra/memory/repositories.ts`（upsertHello 已透传整个 input，确认无需改；但 DeviceRecord 类型变更会自动覆盖）
- Test: `apps/server-next/tests/sqlite-repositories.test.ts`

**Interfaces:**
- Produces: `DeviceRecord.canonicalDeviceId?: string | null`（NULL/undefined = 自身为 canonical）

- [ ] **Step 1: 写失败测试——字段 round-trip**

在 `tests/sqlite-repositories.test.ts` 末尾的合适 describe 内加：

```typescript
test('device canonicalDeviceId round-trips through sqlite upsertHello', async () => {
  const { repositories, cleanup } = await createSqliteRepositories();
  try {
    const now = 1700_000_000_000;
    await repositories.devices.upsertHello({
      id: 'dev-canonical',
      teamId: 'team-1',
      ownerId: 'user-1',
      status: 'online',
      name: 'Mac',
      machineId: null,
      profileId: null,
      canonicalDeviceId: null,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);
    await repositories.devices.upsertHello({
      id: 'dev-alias',
      teamId: 'team-1',
      ownerId: 'user-1',
      status: 'online',
      name: 'Mac',
      machineId: null,
      profileId: null,
      canonicalDeviceId: 'dev-canonical',
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    } as any);

    const alias = await repositories.devices.getById('dev-alias');
    expect(alias?.canonicalDeviceId).toBe('dev-canonical');
    const canonical = await repositories.devices.getById('dev-canonical');
    expect(canonical?.canonicalDeviceId).toBeNull();
  } finally {
    await cleanup();
  }
});
```

> 注：测试里的 `createSqliteRepositories()` helper 名字以现有文件中的实际 helper 为准（执行时先 grep 确认；若该文件用别的 fixture 构造 sqlite repo，沿用其模式）。`as any` 用于回避 DeviceRecord 在本任务尚未加字段时的类型报错——Task 1 完成后可移除。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories.test.ts -t "canonicalDeviceId round-trips"`
Expected: FAIL（`canonicalDeviceId` 字段不存在 / sqlite 写读不保留）

- [ ] **Step 3: DeviceRecord 加字段**

`application/repositories.ts`，在 `DeviceRecord` 接口内（`profileId?: string;` 之后）加：

```typescript
  canonicalDeviceId?: string | null;
```

- [ ] **Step 4: sqlite mapDevice 读字段**

`infra/sqlite/repositories.ts` 的 `mapDevice` 函数，在 `profileId: sqliteNullableText(row, 'profile_id'),` 之后加：

```typescript
    canonicalDeviceId: sqliteNullableText(row, 'canonical_device_id'),
```

- [ ] **Step 5: sqlite upsertHello 写字段**

`infra/sqlite/repositories.ts` 的 `upsertHello`，SQL 改为加入 `canonical_device_id` 列与值：

```typescript
      async upsertHello(device) {
        globalDb
          .prepare(
            `INSERT INTO devices (
              id, team_id, owner_id, machine_id, profile_id, hostname, status, daemon_version,
              system_info, connect_command, canonical_device_id, last_seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              team_id = excluded.team_id,
              owner_id = excluded.owner_id,
              machine_id = excluded.machine_id,
              profile_id = excluded.profile_id,
              hostname = excluded.hostname,
              status = excluded.status,
              daemon_version = excluded.daemon_version,
              system_info = excluded.system_info,
              connect_command = excluded.connect_command,
              canonical_device_id = excluded.canonical_device_id,
              last_seen_at = excluded.last_seen_at,
              updated_at = excluded.updated_at`,
          )
          .run(
            device.id,
            device.teamId,
            device.ownerId,
            device.machineId ?? null,
            device.profileId ?? null,
            device.name ?? null,
            device.status,
            device.daemonVersion ?? null,
            device.systemInfo ? JSON.stringify(device.systemInfo) : null,
            device.connectCommand ?? null,
            device.canonicalDeviceId ?? null,
            device.lastSeenAt ?? device.updatedAt,
            device.createdAt,
            device.updatedAt,
          );
        return device;
      },
```

> in-memory `upsertHello` 是 `devices.set(input.id, input)`，整对象透传，无需改动。

- [ ] **Step 6: 运行测试确认通过**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories.test.ts -t "canonicalDeviceId round-trips"`
Expected: PASS

- [ ] **Step 7: 类型检查**

Run: `cd apps/server-next && npm run build`
Expected: 无类型错误（如 upsertHello 调用处缺 canonicalDeviceId，后续 Task 3 会补；本步只确认字段定义不破坏编译）

- [ ] **Step 8: Commit**

```bash
git add apps/server-next/src/application/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/tests/sqlite-repositories.test.ts
git commit -m "feat(device): DeviceRecord 增加 canonicalDeviceId 字段并双 repo 透传"
```

---

### Task 2: 新增 `findCanonicalByDisplay` repo 方法

**Files:**
- Modify: `apps/server-next/src/application/repositories.ts`（DeviceRepository 接口加方法签名）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（实现）
- Modify: `apps/server-next/src/infra/memory/repositories.ts`（实现）
- Test: `apps/server-next/tests/sqlite-repositories.test.ts`

**Interfaces:**
- Produces: `DeviceRepository.findCanonicalByDisplay(input: { teamId: string; ownerId: string; name: string }): Promise<DeviceRecord | null>` —— 返回同 team/owner、hostname 归一化相同、且自身为 canonical（`canonicalDeviceId IS NULL`）的代表记录（最近更新优先）。

- [ ] **Step 1: 写失败测试**

`tests/sqlite-repositories.test.ts` 加：

```typescript
test('findCanonicalByDisplay matches same-name canonical record ignoring case/whitespace', async () => {
  const { repositories, cleanup } = await createSqliteRepositories();
  try {
    const now = 1700_000_000_000;
    const base = { teamId: 'team-1', ownerId: 'user-1', status: 'online' as const, machineId: null, profileId: null, canonicalDeviceId: null, lastSeenAt: now, createdAt: now, updatedAt: now };
    await repositories.devices.upsertHello({ ...base, id: 'dev-1', name: '  MyMac  ' } as any);

    const found = await repositories.devices.findCanonicalByDisplay({ teamId: 'team-1', ownerId: 'user-1', name: 'mymac' });
    expect(found?.id).toBe('dev-1');

    // 别名记录（canonicalDeviceId 非空）不应被匹配为 canonical
    await repositories.devices.upsertHello({ ...base, id: 'dev-2', name: 'mymac', canonicalDeviceId: 'dev-1' } as any);
    const found2 = await repositories.devices.findCanonicalByDisplay({ teamId: 'team-1', ownerId: 'user-1', name: 'mymac' });
    expect(found2?.id).toBe('dev-1');
  } finally {
    await cleanup();
  }
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories.test.ts -t "findCanonicalByDisplay"`
Expected: FAIL（方法不存在）

- [ ] **Step 3: 接口加签名**

`application/repositories.ts` 的 `DeviceRepository` 接口（`findByMachineProfile` 之后）加：

```typescript
  findCanonicalByDisplay(input: { teamId: ID; ownerId: ID; name: string }): Promise<DeviceRecord | null>;
```

- [ ] **Step 4: sqlite 实现**

`infra/sqlite/repositories.ts`，在 `findByMachineProfile` 方法之后加：

```typescript
      async findCanonicalByDisplay(input) {
        return mapDevice(
          globalDb
            .prepare(
              `SELECT * FROM devices
               WHERE team_id = ? AND owner_id = ?
                 AND LOWER(TRIM(hostname)) = LOWER(TRIM(?))
                 AND canonical_device_id IS NULL
               ORDER BY updated_at DESC, id DESC LIMIT 1`,
            )
            .get(input.teamId, input.ownerId, input.name),
        );
      },
```

- [ ] **Step 5: in-memory 实现**

`infra/memory/repositories.ts`，在 `findByMachineProfile` 方法之后加：

```typescript
      async findCanonicalByDisplay(input) {
        const norm = (value?: string | null) => (value ?? '').trim().toLowerCase();
        return (
          Array.from(devices.values())
            .filter(
              (device) =>
                device.teamId === input.teamId &&
                device.ownerId === input.ownerId &&
                device.canonicalDeviceId == null &&
                norm(device.name) === norm(input.name) &&
                norm(device.name) !== '',
            )
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null
        );
      },
```

- [ ] **Step 6: 运行确认通过**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories.test.ts -t "findCanonicalByDisplay"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server-next/src/application/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/tests/sqlite-repositories.test.ts
git commit -m "feat(device): 新增 findCanonicalByDisplay 查询同名 canonical 别名记录"
```

---

### Task 3: deviceHello 写入时建立持久化别名关系

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`（deviceHello，约 1337-1379）
- Test: `apps/server-next/tests/device-management.test.ts`

**Interfaces:**
- Consumes: `findCanonicalByDisplay`（Task 2）
- Produces: 缺 machineId 的新设备记录在写入时获得 `canonicalDeviceId`，指向同名 canonical 记录。

- [ ] **Step 1: 写失败测试**

`tests/device-management.test.ts` 在别名分裂测试之后加：

```typescript
  test('deviceHello with no machineId but same hostname links to existing canonical alias', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'device-2', 'runtime-1', 'agent-1', 'message-1', 'dispatch-1', 'request-1', 'reply-1']),
    });
    const { baseUrl, ioServer, httpServer } = await startSocketServer(app);
    cleanups.push(async () => {
      await new Promise<void>((resolve) => ioServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });
    const bootstrap = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { bootstrap.disconnect(); agent.disconnect(); });
    const registerAck = await bootstrap.emitWithAck(WEB_EVENTS.auth.register, {
      username: 'shaw', password: 'secret', teamName: 'AgentBean',
    });
    const web = await connectClient(`${baseUrl}/web`, { auth: { token: (registerAck as { token: string }).token } });
    cleanups.push(async () => { web.disconnect(); });

    const helloA = await agent.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', hostname: 'MyMac' });
    const helloB = await agent.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', hostname: 'MyMac' });
    const idA = (helloA as { device: { id: string } }).device.id;
    const idB = (helloB as { device: { id: string } }).device.id;
    expect(idB).not.toBe(idA);

    // 第二台缺 machineId 的同名设备应持久化指向第一台（canonical）
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: idB });
    // 注意：getDevice 经 resolveCanonicalDeviceRecord 返回 canonical，故校验通过内部 listDevices 间接验证关系
    const list = await web.emitWithAck(WEB_EVENTS.device.list, { teamId: 'team-1' });
    expect((list as { devices: unknown[] }).devices).toHaveLength(1);
  });
```

> 此测试在 Task 3 后 + Task 4 前可能仍 FAIL（listDevices 还没按 canonical 折叠）。Task 3 的最小验证改为直接断言 repo 层关系：通过 `app` 调 `listDevices` 不够——改为在 Task 3 单独验证 `findCanonicalByDisplay` 已被 deviceHello 触发（可临时在测试里用 sqlite repo 断言，或合并进 Task 4 的转绿）。**推荐：Task 3 与 Task 4 合并验证，本测试作为 Task 4 转绿的一部分。** Task 3 实现先落地，转绿留到 Task 4。

- [ ] **Step 2: 实现 deviceHello 建立关系**

`application/usecases.ts` 的 `deviceHello`，在 `const ownerId = existing?.ownerId ?? deviceInput.ownerId;`（约 1347）之后、`upsertHello` 调用（约 1365）之前，插入 canonical 解析逻辑，并把 `canonicalDeviceId` 加入 upsertHello 入参：

```typescript
      // 解析持久化别名关系：缺 machineId/profileId 的新记录，若与现有同名 canonical 设备互为别名，
      // 则 canonicalDeviceId 指向其 id；有 machineId 的设备走 findByMachineProfile（existing），关系保持 null。
      let canonicalDeviceId: string | null = null;
      if (existing) {
        canonicalDeviceId = existing.canonicalDeviceId ?? null;
      } else if ((!deviceInput.machineId || !deviceInput.profileId) && deviceInput.hostname) {
        const alias = await repositories.devices.findCanonicalByDisplay({
          teamId: deviceInput.teamId,
          ownerId,
          name: deviceInput.hostname,
        });
        if (alias) canonicalDeviceId = alias.id;
      }
```

然后把 `upsertHello({ ... })` 调用里（约 1365-1379）加入字段 `canonicalDeviceId,`（与 `profileId:` 同级）。

- [ ] **Step 3: 类型检查**

Run: `cd apps/server-next && npm run build`
Expected: 无类型错误

- [ ] **Step 4: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/device-management.test.ts
git commit -m "feat(device): deviceHello 为缺 machineId 的同名设备建立 canonicalDeviceId 别名关系"
```

---

### Task 4: dedupeDeviceRecords 优先按 canonical 折叠（RED→GREEN）

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`（dedupeDeviceRecords 拆分，约 3406-3430）

**Interfaces:**
- Produces: `dedupeDeviceRecords(devices)` = `dedupeByHeuristic(collapseByCanonical(devices))`。collapseByCanonical 按 `canonicalDeviceId ?? id` 分组取代表；dedupeByHeuristic 为原逻辑（machineKey/displayKey 兜底）。

- [ ] **Step 1: 确认 RED 测试仍在失败**

Run: `cd apps/server-next && npx vitest run tests/device-management.test.ts -t "keeps alias records merged"`
Expected: FAIL（`expected ... to have a length of 1 but got 2`）

- [ ] **Step 2: 新增 collapseByCanonical，拆分 dedupeDeviceRecords**

`application/usecases.ts`，在 `dedupeDeviceRecords` 函数（约 3406）**之前**插入新函数，并把原 `dedupeDeviceRecords` 函数体重命名为 `dedupeByHeuristic`，再让 `dedupeDeviceRecords` 委托：

```typescript
function collapseByCanonical(devices: DeviceRecord[]): DeviceRecord[] {
  // 按 effectiveCanonical（canonicalDeviceId ?? id）折叠别名集群；同组取 canonical 自身为代表。
  const groups = new Map<string, DeviceRecord[]>();
  for (const device of devices) {
    const key = device.canonicalDeviceId ?? device.id;
    const group = groups.get(key);
    if (group) {
      group.push(device);
    } else {
      groups.set(key, [device]);
    }
  }
  const result: DeviceRecord[] = [];
  for (const group of groups.values()) {
    const selfCanonical = group.find((d) => d.canonicalDeviceId == null);
    result.push(selfCanonical ?? group[0]!);
  }
  return result;
}

function dedupeDeviceRecords(devices: DeviceRecord[]): DeviceRecord[] {
  // 先按持久化 canonical 关系折叠，再用原 heuristic（machineKey/displayKey）兜底处理未建立关系的记录。
  return dedupeByHeuristic(collapseByCanonical(devices));
}

function dedupeByHeuristic(devices: DeviceRecord[]): DeviceRecord[] {
```

> 即：把原 `function dedupeDeviceRecords(devices: DeviceRecord[]): DeviceRecord[] {` 这一行改为 `function dedupeByHeuristic(devices: DeviceRecord[]): DeviceRecord[] {`，函数体（`const result...` 到 `return result; }`）原样保留。然后在它前面插入 `collapseByCanonical` 和新的 `dedupeDeviceRecords` 委托函数。

- [ ] **Step 3: 运行 RED 测试确认转绿**

Run: `cd apps/server-next && npx vitest run tests/device-management.test.ts -t "keeps alias records merged"`
Expected: PASS

- [ ] **Step 4: 运行 Task 3 的关系测试确认转绿**

Run: `cd apps/server-next && npx vitest run tests/device-management.test.ts -t "links to existing canonical alias"`
Expected: PASS

- [ ] **Step 5: 全量 device-management 测试**

Run: `cd apps/server-next && npx vitest run tests/device-management.test.ts`
Expected: 全部 PASS（无回归）

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/application/usecases.ts
git commit -m "fix(device): dedupeDeviceRecords 优先按 canonicalDeviceId 折叠别名集群，rename 不再导致重复"
```

---

### Task 5: sqlite migration 0007——加列 + 回填现有重复数据

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0007_device_canonical.sql`
- Test: `apps/server-next/tests/sqlite-repositories.test.ts`

**Interfaces:**
- Produces: 生产 DB 启动时自动应用——加 `canonical_device_id` 列，并把现有「缺 machineId、同 team/owner/hostname」的别名记录统一指向组内代表（`MIN(id)`）。

- [ ] **Step 1: 写失败测试——回填正确性**

`tests/sqlite-repositories.test.ts` 加（在 `:memory:` 上复刻升级前旧 schema + 脏数据，再 exec 0007 SQL 直接验证回填）：

```typescript
test('migration 0007 backfills canonical_device_id for existing duplicate alias records', () => {
  const globalDb = new Database(':memory:');
  globalDb.exec(`CREATE TABLE devices (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, owner_id TEXT NOT NULL, machine_id TEXT, profile_id TEXT, hostname TEXT, status TEXT NOT NULL DEFAULT 'offline', daemon_version TEXT, system_info TEXT, connect_command TEXT, last_seen_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  const now = Date.now();
  const insert = globalDb.prepare('INSERT INTO devices (id, team_id, owner_id, machine_id, profile_id, hostname, status, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('dev-older', 'team-1', 'user-1', null, null, 'MyMac', 'offline', now, now - 2000, now - 2000);
  insert.run('dev-newer', 'team-1', 'user-1', null, null, '  mymac  ', 'online', now, now, now);
  insert.run('dev-machine', 'team-1', 'user-1', 'm1', 'p1', 'MyMac', 'online', now, now, now);

  globalDb.exec(readFileSync(join(MIGRATIONS_DIR, 'global/0007_device_canonical.sql'), 'utf8'));

  const canonicalOf = (id: string) => (globalDb.prepare('SELECT canonical_device_id FROM devices WHERE id = ?').get(id) as { canonical_device_id: string | null }).canonical_device_id;
  // 'MyMac' 与 '  mymac  ' 归一化后相同 → 别名，统一指向 MIN(id)；字典序 'dev-newer' < 'dev-older'
  expect(canonicalOf('dev-older')).toBe('dev-newer');
  expect(canonicalOf('dev-newer')).toBeNull();
  // 有 machineId 的正常设备不受回填影响
  expect(canonicalOf('dev-machine')).toBeNull();
});
```

> 测试文件顶部需（沿用现有 import 风格）：`import Database from 'better-sqlite3';`、`import { readFileSync } from 'node:fs';`、`import { join } from 'node:path';`。`MIGRATIONS_DIR` 用与 `resolveMigrationPath` 等价的解析（执行时参考 `src/infra/sqlite/repositories.ts` 的 `resolveMigrationPath`，或直接绝对路径 `apps/server-next/src/infra/sqlite/migrations`）。`MIN(id)` 字典序 `'dev-newer'` < `'dev-older'`，故 canonical 为 `dev-newer`——断言以此为准。

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories.test.ts -t "backfills canonical_device_id"`
Expected: FAIL（migration 不存在 / 列不存在）

- [ ] **Step 3: 创建 migration 文件**

`apps/server-next/src/infra/sqlite/migrations/global/0007_device_canonical.sql`：

```sql
-- 设备别名持久化：canonical_device_id 自引用，NULL 表示自身为 canonical。
ALTER TABLE devices ADD COLUMN canonical_device_id TEXT;

-- 回填现有重复别名记录：缺 machineId/profileId、且同 (team_id, owner_id, 归一化 hostname) 的记录，
-- 统一指向组内代表（MIN(id)）。归一化 = LOWER(TRIM(hostname))，复刻 normalizeDeviceKey。
UPDATE devices
SET canonical_device_id = grouped.canonical_id
FROM (
  SELECT
    id,
    MIN(id) OVER (
      PARTITION BY team_id, owner_id, LOWER(TRIM(hostname))
    ) AS canonical_id
  FROM devices
  WHERE hostname IS NOT NULL
    AND hostname <> ''
    AND (machine_id IS NULL OR profile_id IS NULL)
) AS grouped
WHERE devices.id = grouped.id
  AND devices.id <> grouped.canonical_id;
```

- [ ] **Step 4: 运行确认通过**

Run: `cd apps/server-next && npx vitest run tests/sqlite-repositories.test.ts -t "backfills canonical_device_id"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/server-next/src/infra/sqlite/migrations/global/0007_device_canonical.sql apps/server-next/tests/sqlite-repositories.test.ts
git commit -m "feat(device): migration 0007 加 canonical_device_id 列并回填现有重复别名记录"
```

---

### Task 6: 全量回归 + 验证

**Files:** 无代码改动，仅验证。

- [ ] **Step 1: server-next 全量测试**

Run: `cd apps/server-next && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 2: 类型检查 + 构建**

Run: `cd apps/server-next && npm run build`
Expected: 无错误

- [ ] **Step 3: 跨 repo 一致性核对**

确认 `findCanonicalByDisplay` 与 `canonicalDeviceId` 在 memory 与 sqlite 两个 repo 行为一致（Task 1/2 的测试已分别覆盖，此处确认两个 test suite 都绿）。

- [ ] **Step 4: contracts 对外契约未污染确认**

Run: `cd /Users/shaw/AgentBean && grep -rn "canonicalDeviceId" packages/contracts/`
Expected: 无输出（canonicalDeviceId 仅在 server-next 内部）

- [ ] **Step 5: 手动验证（可选）**

启动 server-next，构造缺 machineId 的同名设备别名 → 改名 → 确认列表无重复。若不便本地复现，依赖 Task 4 的端到端测试。

---

## Self-Review

**1. Spec coverage（覆盖根因证据链每一步）：**
- `renameDevice` 不再分裂：Task 4 让 dedupe 按 canonical 折叠，rename 改 name 不触碰 canonicalDeviceId → 别名仍合并。✅
- `deviceHello` 建立持久化关系：Task 3。✅
- 现有脏数据回填：Task 5 migration。✅
- members 列表重复（下游 `resolveCanonicalDeviceRecord` / `toAgentMemberDtos`）：它们都调 `dedupeDeviceRecords`，Task 4 自动修复，无需单独改动。✅
- 双 repo 一致：Task 1/2 同步 memory + sqlite。✅

**2. Placeholder scan：**
- Task 1 Step 1 与 Task 5 Step 1 提到「`createSqliteRepositories` 以现有 helper 为准，执行时 grep 确认」——这是**执行时验证项**，不是计划占位符；执行者需先 `grep -n "createSqliteRepositories\|sqlite" tests/sqlite-repositories.test.ts` 确认实际 fixture 名与 dbPath 选项。已明确指令。
- 所有代码块完整，无 TBD/TODO。

**3. Type consistency：**
- `canonicalDeviceId?: string | null` 全程一致（DeviceRecord、mapDevice、upsertHello、findCanonicalByDisplay、collapseByCanonical）。✅
- `findCanonicalByDisplay(input: { teamId, ownerId, name })` 接口与 sqlite/memory 实现签名一致。✅
- `collapseByCanonical` / `dedupeByHeuristic` / `dedupeDeviceRecords` 命名在 Task 4 内自洽。✅

## 风险与回滚

- **migration 风险**：`UPDATE ... FROM (window function)` 需 sqlite ≥ 3.25（better-sqlite3 内置版本远高于此，安全）。回填幂等（重跑只更新已是该值的行）。
- **回滚**：若上线后异常，`canonical_device_id` 列保留不影响旧逻辑（dedupeByHeuristic 兜底仍在），可回退 Task 4 的 `dedupeDeviceRecords` 委托为直接调 `dedupeByHeuristic`。
- **daemon 协议不变**：本方案纯 server 端，daemon 无需升级。

## 执行前必做

1. 开独立分支：`git checkout main && git pull && git checkout -b fix/device-canonical-alias`（先确认 `fix/daemon-next-pty-test-cleanup` 的未提交改动不丢失——它们与本次无关，可 stash 或留在原分支）。
2. RED 测试已存在于 `device-management.test.ts`（调查阶段加入），Task 4 将其转绿。
