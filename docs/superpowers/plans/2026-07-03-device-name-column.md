# 设备名独立列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拆 `devices` 表的 `hostname` 列语义过载——新增独立 `name`（用户显示名）+ `name_source` 列，让 daemon 重连不再覆盖用户改的设备名。

**Architecture:** server-only 修复。`hostname` 列回归纯机器名语义；新增 `name` 列承载用户显示名 + `name_source`（`'user'`|`'hostname'`）标记来源。sqlite 靠 `upsertHello` 的 `ON CONFLICT DO UPDATE` 不含 `name`/`name_source` 实现重连不覆盖；memory 靠 `deviceHello` usecase 对 existing 设备传 `existing.name`。两条路径各自有回归测试。

**Tech Stack:** TypeScript、Node 22、vitest、better-sqlite3、socket.io、Next.js (web-next)。

## Global Constraints

- 测试框架 vitest，命令 `pnpm --filter @agentbean/server-next test`（或 `pnpm test`，沿用仓库现有脚本）。
- 新 migration 文件**必须**在 `applyGlobalMigrations`（`apps/server-next/src/infra/sqlite/repositories.ts:42-52`）静态枚举里加 `applyMigration(...)` 行，否则不生效（记忆坑）。
- 不碰 daemon 侧（daemon 无法自救，见 spec 根因）。
- `nameSource` 不进 `DeviceDto` 契约（内部字段）。
- D1：rename 链路全重命名（usecase 参数 + web 网络 key `hostname`→`name`）。
- D2：顺手清理 web-next 的 `device.hostname` 死代码。
- 所有改动限定在本 worktree 分支 `worktree-device-name-column`。

---

## File Structure

| 文件 | 职责 | 操作 |
|---|---|---|
| `apps/server-next/src/infra/sqlite/migrations/global/0012_device_name_columns.sql` | 加 name + name_source 列 | 新建 |
| `apps/server-next/src/infra/sqlite/migrations/global/0013_device_name_backfill.sql` | 回填现有数据 | 新建 |
| `apps/server-next/src/infra/sqlite/repositories.ts` | migration 注册 + mapDevice + upsertHello + updateName + findCanonicalByDisplay | 改 |
| `apps/server-next/src/application/repositories.ts` | `DeviceRecord.nameSource` + `DeviceRepository.updateName` 签名 | 改 |
| `apps/server-next/src/application/usecases.ts` | deviceHello(name 计算) + renameDevice + token claim | 改 |
| `apps/server-next/src/infra/memory/repositories.ts` | updateName 对齐 | 改 |
| `apps/server-next/tests/device-repository.test.ts` | memory repo 回归 | 改 |
| `apps/server-next/tests/device-management.test.ts` | 端到端重连保留 | 改 |
| `apps/server-next/tests/sqlite-repositories.test.ts` | migration + sqlite 重连保留 | 改 |
| `apps/web-next/lib/socket.ts` | rename 网络 key | 改 |
| `apps/web-next/lib/schema.ts`、`app/[networkPath]/devices/page.tsx`、`lib/agent-device.ts`、`components/member-detail.tsx` | 死代码清理 | 改 |

---

## Task 1: SQLite schema migration（加列 + 回填 + 注册）

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0012_device_name_columns.sql`
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0013_device_name_backfill.sql`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（`applyGlobalMigrations`，约 42-52 行）
- Test: `apps/server-next/tests/sqlite-repositories.test.ts`

**Interfaces:**
- Produces: `devices` 表新增 `name TEXT`、`name_source TEXT` 列；现有行回填 `name=hostname, name_source='hostname'`。后续 Task 4 依赖此 schema。

- [ ] **Step 1: 写 0012 加列 migration**

`apps/server-next/src/infra/sqlite/migrations/global/0012_device_name_columns.sql`：
```sql
-- 拆 hostname 列语义过载：新增 name（用户显示名）+ name_source（'user'|'hostname'）。
-- hostname 列回归纯机器名语义。仿 0007 加列模式。
ALTER TABLE devices ADD COLUMN name TEXT;
ALTER TABLE devices ADD COLUMN name_source TEXT;
```

- [ ] **Step 2: 写 0013 回填 migration**

`apps/server-next/src/infra/sqlite/migrations/global/0013_device_name_backfill.sql`：
```sql
-- 回填：现有 hostname 值成为用户可见的 name，显示零变化。此后 daemon 重连不再覆盖。
-- 幂等：WHERE name IS NULL 跳过已回填/已改名行。仿 0008 backfill 模式。
UPDATE devices SET name = hostname, name_source = 'hostname'
WHERE name IS NULL AND hostname IS NOT NULL;
```

- [ ] **Step 3: 在 applyGlobalMigrations 注册两行**

`apps/server-next/src/infra/sqlite/repositories.ts`，在 `applyMigration(db, 'global/0011_device_revocations.sql');`（约 :52）之后加：
```ts
  applyMigration(db, 'global/0012_device_name_columns.sql');
  applyMigration(db, 'global/0013_device_name_backfill.sql');
```

- [ ] **Step 4: 写失败测试（迁移后 schema 含新列）**

在 `apps/server-next/tests/sqlite-repositories.test.ts` 的 `describe('server-next SQLite repositories', ...)` 内加：
```ts
test('device migrations add name and name_source columns', () => {
  const { globalDb, close } = openMigratedDatabases();
  try {
    const cols = globalDb.prepare('PRAGMA table_info(devices)').all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('name');
    expect(names).toContain('name_source');
  } finally {
    close();
  }
});

test('device name backfill copies hostname into name with source=hostname', () => {
  // 回填在迁移时对已有数据生效；此处验证回填 SQL 语义：先建旧式行再跑回填语句
  const { globalDb, close } = openMigratedDatabases();
  try {
    globalDb.prepare(
      "INSERT INTO devices (id, team_id, owner_id, hostname, status, last_seen_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run('d-backfill', 't', 'u', 'host-orig', 'offline', 1, 1, 1);
    // 手动清空 name 模拟回填前状态，再重跑回填语句验证幂等语义
    globalDb.prepare("UPDATE devices SET name = NULL WHERE id = 'd-backfill'").run();
    globalDb.prepare(readFileSync(join(MIGRATIONS_DIR, 'global/0013_device_name_backfill.sql'), 'utf8')).run();
    const row = globalDb.prepare('SELECT name, name_source FROM devices WHERE id = ?').get('d-backfill') as { name: string; name_source: string };
    expect(row.name).toBe('host-orig');
    expect(row.name_source).toBe('hostname');
  } finally {
    close();
  }
});
```
> 注：`openMigratedDatabases`、`MIGRATIONS_DIR`、`readFileSync` 已在该测试文件顶部导入/定义，沿用现有用法。

- [ ] **Step 5: 跑测试验证**

Run: `pnpm --filter @agentbean/server-next test sqlite-repositories`
Expected: 两个新测试 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/infra/sqlite/migrations/global/0012_device_name_columns.sql apps/server-next/src/infra/sqlite/migrations/global/0013_device_name_backfill.sql apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/tests/sqlite-repositories.test.ts
git commit -m "feat(server-next): 加 devices.name/name_source 列 + 回填 migration"
```

---

## Task 2: DeviceRecord 类型 + updateName 接口签名 + memory repo + 现有测试参数名

**Files:**
- Modify: `apps/server-next/src/application/repositories.ts`（DeviceRecord 约 :86-94，DeviceRepository.updateName 约 :200）
- Modify: `apps/server-next/src/infra/memory/repositories.ts`（updateName 约 :477-489）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（updateName 参数名 约 :872-880，**仅参数名**，SQL 留给 Task 4）
- Test: `apps/server-next/tests/device-repository.test.ts`

**Interfaces:**
- Produces: `DeviceRecord.nameSource?: 'user'|'hostname'`；`DeviceRepository.updateName(input: { deviceId; name; updatedAt })`（`hostname`→`name`）。Task 3/4 依赖此签名。

- [ ] **Step 1: DeviceRecord 加 nameSource**

`apps/server-next/src/application/repositories.ts`，`DeviceRecord` interface 内（与 `daemonVersion`/`connectCommand` 同组）加：
```ts
  nameSource?: 'user' | 'hostname';
```

- [ ] **Step 2: 改 DeviceRepository.updateName 签名**

`apps/server-next/src/application/repositories.ts` 约 :200：
```ts
  updateName(input: { deviceId: ID; name: string; updatedAt: UnixMs }): Promise<DeviceRecord | null>;
```
（把字段 `hostname` 改成 `name`。）

- [ ] **Step 3: 改 memory updateName 实现**

`apps/server-next/src/infra/memory/repositories.ts` 约 :477-489，把 `name: input.hostname` 改为 `name: input.name` 并置 `nameSource`：
```ts
      async updateName(input) {
        const device = devices.get(input.deviceId);
        if (!device) return null;
        const updated: DeviceRecord = { ...device, name: input.name, nameSource: 'user', updatedAt: input.updatedAt };
        devices.set(device.id, updated);
        return updated;
      }
```

- [ ] **Step 4: 改 sqlite updateName 参数名（SQL 暂不动）**

`apps/server-next/src/infra/sqlite/repositories.ts` 约 :872-880，把绑定参数从 `input.hostname` 改为 `input.name`（SQL 仍是 `SET hostname = ?`，Task 4 再改 SQL）：
```ts
      async updateName(input) {
        return mapDevice(
          globalDb
            .prepare('UPDATE devices SET hostname = ?, updated_at = ? WHERE id = ?')
            .run(input.name, input.updatedAt, input.deviceId),
        );
      },
```
> 注：`mapDevice(null)` 会返回 null；若现有实现用 `getById` 重新读取返回，保持原返回方式不变，仅改绑定参数名。实现时核对现有返回逻辑，保持行为一致。

- [ ] **Step 5: 更新现有 device-repository.test.ts 的 hostname→name 参数**

`apps/server-next/tests/device-repository.test.ts`，现有 `updateName` 调用的字段名 `hostname:` → `name:`（约 :21、:34 两处）：
```ts
    const updated = await repos.devices.updateName({
      deviceId: 'device-1',
      name: 'new-name',
      updatedAt: 2000,
    });
```
```ts
    const updated = await repos.devices.updateName({
      deviceId: 'missing',
      name: 'x',
      updatedAt: 1000,
    });
```

- [ ] **Step 6: 加 memory repo 契约测试（updateName 置 nameSource）**

在 `device-repository.test.ts` 加：
```ts
  test('updateName sets nameSource=user', async () => {
    const repos = createInMemoryRepositories();
    await repos.devices.upsertHello({
      id: 'd1', teamId: 't1', ownerId: 'u1', status: 'online',
      name: 'host1', nameSource: 'hostname',
      lastSeenAt: 1000, createdAt: 1000, updatedAt: 1000,
    });
    const updated = await repos.devices.updateName({ deviceId: 'd1', name: '我的设备', updatedAt: 2000 });
    expect(updated?.name).toBe('我的设备');
    expect(updated?.nameSource).toBe('user');
  });
```

- [ ] **Step 7: 跑测试 + 类型检查**

Run: `pnpm --filter @agentbean/server-next test device-repository`
Expected: PASS（含新测试）。

- [ ] **Step 8: Commit**

```bash
git add apps/server-next/src/application/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/tests/device-repository.test.ts
git commit -m "refactor(server-next): updateName 参数 hostname→name + DeviceRecord.nameSource"
```

---

## Task 3: deviceHello + renameDevice usecase + token claim + web rename 网络 key（核心 bug 修复）

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`（renameDevice 接口 :70、deviceHello :1414-1429、token :1454-1469、renameDevice 实现 :1569-1589）
- Modify: `apps/web-next/lib/socket.ts`（:491、:517、:518）
- Test: `apps/server-next/tests/device-management.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `DeviceRecord.nameSource`、`updateName({name})` 签名。
- Produces: `deviceHello` 对 existing 设备保留 `existing.name`；rename 链路用 `name` 字段。这是 bug 修复的 usecase 层。

- [ ] **Step 1: 写失败端到端测试（重连后 name 保留）**

在 `apps/server-next/tests/device-management.test.ts`，参照现有 rename/device.hello 流程（约 :38-110）加回归测试。核心：web rename → agent 发 hello（hostname 不同）→ web list 断言 name 仍是用户改的：
```ts
test('用户改的设备名在 daemon 重连后保留', async () => {
  // 复用现有测试的 server/client 启动模式（createInMemoryServerNext + startSocketServer + web/agent socket 连接）
  // 1. agent socket 首次 device.hello，hostname='mac-orig'
  // 2. web socket device.rename，name='我的Mac'
  // 3. agent socket 再次 device.hello，hostname='mac-orig'（模拟重连，daemon 仍发 os.hostname）
  // 4. web socket device.list → 断言 device.name === '我的Mac'（而非 'mac-orig'）
  expect(device.name).toBe('我的Mac');
});
```
> 实现时严格照搬该文件现有 rename/hello 测试的 server 启动、socket 连接、事件 emit/ack 模式（固定 now/ids 用 `createInMemoryServerNext({ now, ids: createIds([...]) })`）。先写测试看它 FAIL（重连后 name 变回 mac-orig）。

- [ ] **Step 2: 跑测试验证它失败**

Run: `pnpm --filter @agentbean/server-next test device-management`
Expected: 新测试 FAIL（重连后 name === 'mac-orig'，而非 '我的Mac'）。

- [ ] **Step 3: 改 deviceHello — name 仅新建时初始化**

`apps/server-next/src/application/usecases.ts` 约 :1414-1429 的 `upsertHello({...})` 调用，把 `name: deviceInput.hostname,` 改为按 existing 决定，并加 nameSource：
```ts
      const device = await repositories.devices.upsertHello({
        id: existing?.id ?? ids.nextId(),
        teamId: deviceInput.teamId,
        ownerId,
        status: 'online',
        name: existing ? existing.name : deviceInput.hostname,
        nameSource: existing ? existing.nameSource : 'hostname',
        machineId: deviceInput.machineId,
        profileId: deviceInput.profileId,
        canonicalDeviceId,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
        connectCommand,
        lastSeenAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
```

- [ ] **Step 4: 改 token hostname claim 用机器名**

`apps/server-next/src/application/usecases.ts` 约 :1454-1469 的 `credentials`，两处 `hostname: device.name` 改为机器名来源：
```ts
        credentials: {
          token: issueDeviceToken({
            teamId: device.teamId,
            ownerId: device.ownerId,
            deviceId: device.id,
            machineId: device.machineId,
            profileId: device.profileId,
            hostname: deviceInput.hostname ?? device.systemInfo?.hostname,
          }, sessionSecret),
          teamId: device.teamId,
          ownerId: device.ownerId,
          deviceId: device.id,
          machineId: device.machineId,
          profileId: device.profileId,
          hostname: deviceInput.hostname ?? device.systemInfo?.hostname,
        },
```

- [ ] **Step 5: 改 renameDevice 接口 + 实现**

`apps/server-next/src/application/usecases.ts` 约 :70 接口：`hostname: string` → `name: string`：
```ts
  renameDevice(input: { userId: string; deviceId: string; name: string; currentDeviceId?: string | null }): Promise<Ack<{ device: DeviceDto }>>;
```
约 :1569-1589 实现里调用 updateName 处，`hostname: renameInput.hostname` → `name: renameInput.name`：
```ts
    const updated = await repositories.devices.updateName({
      deviceId: device.id,
      name: renameInput.name,
      updatedAt: clock.now(),
    });
```

- [ ] **Step 6: 改 web rename 网络 key（D1）**

`apps/web-next/lib/socket.ts`：
- :491 `rename(id: string, hostname: string)` → `rename(id: string, name: string)`
- :517 `rename(id, hostname) {` → `rename(id, name) {`
- :518 `emitWithTimeout(socket, WEB_EVENTS.device.rename, { id, deviceId: id, hostname });` → `{ id, deviceId: id, name }`

然后 grep 调用 `rename(` 的地方更新传参变量名：
```bash
grep -rn "\.rename(" apps/web-next
```
对每个调用点，把传给 rename 的第二个参数语义保持（变量名可保留，只要值是用户输入的显示名即可；payload key 已统一为 name）。

- [ ] **Step 7: 跑端到端测试验证通过**

Run: `pnpm --filter @agentbean/server-next test device-management`
Expected: 新回归测试 PASS（重连后 name === '我的Mac'）。

- [ ] **Step 8: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/tests/device-management.test.ts apps/web-next/lib/socket.ts
git commit -m "fix(server-next): deviceHello 重连不再覆盖用户改名 + rename 链路 name 化"
```

---

## Task 4: SQLite repo 读写拆分（mapDevice + upsertHello + updateName SQL + findCanonicalByDisplay）

**Files:**
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（mapDevice :1919-1940、upsertHello :749-787、updateName :872-880、findCanonicalByDisplay :798-813）
- Test: `apps/server-next/tests/sqlite-repositories.test.ts`

**Interfaces:**
- Consumes: Task 1 的 name/name_source 列；Task 2 的 updateName({name}) 签名。
- Produces: sqlite 持久层读写分离，重连不覆盖（ON CONFLICT 不含 name）。

- [ ] **Step 1: 写失败 sqlite 回归测试（重连不覆盖）**

在 `sqlite-repositories.test.ts` 加（用 `createSqliteRepositories` 创建持久 repo）：
```ts
test('sqlite upsertHello 不覆盖用户改名（ON CONFLICT 不写 name）', async () => {
  const { globalDb, teamDb, close } = openMigratedDatabases();
  const repos = createSqliteRepositories({ globalDb, teamDb });
  try {
    // 首次 hello：name 初始化为机器名
    await repos.devices.upsertHello({
      id: 'd1', teamId: 't1', ownerId: 'u1', status: 'online',
      name: 'host1', nameSource: 'hostname',
      systemInfo: { hostname: 'host1' },
      lastSeenAt: 1000, createdAt: 1000, updatedAt: 1000,
    });
    // 用户改名
    await repos.devices.updateName({ deviceId: 'd1', name: '我的设备', updatedAt: 2000 });
    // 模拟重连：即使上层传了不同的 name（host2），ON CONFLICT 也不写入 name 列
    await repos.devices.upsertHello({
      id: 'd1', teamId: 't1', ownerId: 'u1', status: 'online',
      name: 'host2', nameSource: 'hostname',
      systemInfo: { hostname: 'host2' },
      lastSeenAt: 3000, createdAt: 1000, updatedAt: 3000,
    });
    const got = await repos.devices.getById('d1');
    expect(got?.name).toBe('我的设备');      // name 列未被 host2 覆盖
    expect(got?.nameSource).toBe('user');    // name_source 未被覆盖
  } finally {
    close();
  }
});
```
> `openMigratedDatabases()` + `createSqliteRepositories({ globalDb, teamDb })` 是该文件现有用例的标准模式（见 :26、:109）。先 FAIL（name 被覆盖成 host2，或 name_source undefined）。

- [ ] **Step 2: 跑测试验证失败**

Run: `pnpm --filter @agentbean/server-next test sqlite-repositories`
Expected: 新测试 FAIL。

- [ ] **Step 3: 改 mapDevice 读 name/name_source 列**

`apps/server-next/src/infra/sqlite/repositories.ts` 约 :1919-1940 `mapDevice`，把 `name: sqliteNullableText(row, 'hostname'),` 改为读 name 列，并加 nameSource：
```ts
    name: sqliteNullableText(row, 'name'),
    nameSource: sqliteNullableText(row, 'name_source') as DeviceRecord['nameSource'],
```

- [ ] **Step 4: 改 upsertHello — hostname 列绑机器名，加 name/name_source 列，ON CONFLICT 不动**

`apps/server-next/src/infra/sqlite/repositories.ts` 约 :749-787，INSERT 列表在 `hostname` 后加 `name, name_source`，VALUES 加两个 `?`，binding 把 hostname 列改为机器名来源、新增 name/name_source 绑定。**ON CONFLICT 子句保持原样（本来就不含 name/name_source）**：
```ts
      async upsertHello(device) {
        globalDb
          .prepare(
            `INSERT INTO devices (
              id, team_id, owner_id, machine_id, profile_id, hostname, name, name_source, status, daemon_version,
              system_info, connect_command, canonical_device_id, last_seen_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            device.systemInfo?.hostname ?? null,
            device.name ?? null,
            device.nameSource ?? null,
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

- [ ] **Step 5: 改 updateName SQL（写 name 列 + name_source='user'）**

`apps/server-next/src/infra/sqlite/repositories.ts` 约 :872-880：
```ts
      async updateName(input) {
        globalDb
          .prepare("UPDATE devices SET name = ?, name_source = 'user', updated_at = ? WHERE id = ?")
          .run(input.name, input.updatedAt, input.deviceId);
        return mapDevice(globalDb.prepare('SELECT * FROM devices WHERE id = ?').get(input.deviceId));
      },
```

- [ ] **Step 6: 改 findCanonicalByDisplay 用 name 列**

`apps/server-next/src/infra/sqlite/repositories.ts` 约 :798-813，SQL 里两处 `matched.hostname`（在 COALESCE 的 NULLIF 第一参）改为 `matched.name`：
```sql
LOWER(TRIM(COALESCE(NULLIF(matched.name, ''), json_extract(matched.system_info, '$.hostname')))) = LOWER(TRIM(?))
```
（回退链：name 列为空 → system_info.hostname，保持识别能力。）

- [ ] **Step 7: 跑 sqlite 测试验证通过**

Run: `pnpm --filter @agentbean/server-next test sqlite-repositories`
Expected: 所有 sqlite 测试 PASS（含 Task 1 migration 测试 + 本 Task 回归测试）。

- [ ] **Step 8: Commit**

```bash
git add apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/tests/sqlite-repositories.test.ts
git commit -m "fix(server-next): sqlite 设备名读写拆列，upsertHello ON CONFLICT 不写 name"
```

---

## Task 5: web-next 死代码清理（D2）

**Files:**
- Modify: `apps/web-next/lib/schema.ts`（:195 移除 hostname?）
- Modify: `apps/web-next/app/[networkPath]/devices/page.tsx`（:43-45 deviceDisplayName）
- Modify: `apps/web-next/lib/agent-device.ts`（:7）
- Modify: `apps/web-next/components/member-detail.tsx`（:467）

**Interfaces:**
- Consumes: Task 3 的 `device.name` 已是显示名（server 不发顶层 hostname）。
- Produces: web 显示路径无死的 `device.hostname` 引用。

- [ ] **Step 1: 移除 DeviceInfo 死字段**

`apps/web-next/lib/schema.ts` 约 :195，删除 `hostname?: string;` 行（server 从不发送顶层 hostname，该字段恒为 undefined）。

- [ ] **Step 2: 简化 devices/page.tsx deviceDisplayName**

`apps/web-next/app/[networkPath]/devices/page.tsx` 约 :43-45，去掉死的 hostname 分支：
```ts
const deviceDisplayName = (device: DeviceInfo) =>
  (device.name ?? device.systemInfo?.hostname ?? '').trim() || device.id;
```

- [ ] **Step 3: 改 agent-device.ts**

`apps/web-next/lib/agent-device.ts` 约 :7，`device?.hostname?.trim()` → `device?.name?.trim()`（沿用该函数现有回退链结构，仅把 hostname 换成 name）。

- [ ] **Step 4: 改 member-detail.tsx**

`apps/web-next/components/member-detail.tsx` 约 :467，`device.hostname` → `device.name`。

- [ ] **Step 5: grep 确认无残留 + 类型检查**

Run:
```bash
grep -rn "device\.hostname\|\.hostname??" apps/web-next/app apps/web-next/lib apps/web-next/components || echo "无残留"
pnpm --filter @agentbean/web-next build
```
Expected: "无残留"；build 通过（TS 编译无错）。

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/lib/schema.ts "apps/web-next/app/[networkPath]/devices/page.tsx" apps/web-next/lib/agent-device.ts apps/web-next/components/member-detail.tsx
git commit -m "chore(web-next): 清理 device.hostname 死代码，显示统一用 device.name"
```

---

## Task 6: 全量验证 + 收尾

**Files:** 无新增，仅验证。

- [ ] **Step 1: 跑 server-next 全量测试**

Run: `pnpm --filter @agentbean/server-next test`
Expected: 全绿（含 device-repository / device-management / sqlite-repositories / device-permissions / device-revocation 等）。

- [ ] **Step 2: 跑 web-next 构建/类型检查**

Run: `pnpm --filter @agentbean/web-next build`
Expected: 通过。

- [ ] **Step 3: 验收标准核对**

逐条核对 spec 第六节验收标准：
1. 重连后 device.name 保留（Task 3 端到端测试）✓
2. 升级后显示名零变化（Task 1 回填）✓
3. upsertHello ON CONFLICT 不含 name/name_source（Task 4）✓
4. 新 migration 已注册（Task 1 Step 3）✓
5. 全量测试绿（Step 1）✓
6. web-next 显示路径无 device.hostname 死引用（Task 5 Step 5）✓

- [ ] **Step 4: 更新记忆（实现完成后）**

更新 `agentbean-device-name-rollback.md`：标记 bug 已修，记录 PR 分支/commit。

- [ ] **Step 5: 推送 + 开 PR**

```bash
git push -u origin worktree-device-name-column
gh pr create --title "fix: 设备名独立列，修 daemon 重连覆盖用户改名" --body "..."
```
> PR body 末尾加 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

---

## Self-Review 记录

- **Spec 覆盖**：spec 3.1 schema → Task 1；3.2 server 代码 → Task 2/3/4；3.3 web 清理 → Task 3（网络 key）/ Task 5（死代码）；4 测试 → 各 Task 内 TDD；六验收 → Task 6。全覆盖。
- **占位符**：无 TBD/TODO；测试代码均给完整断言；SQL/TS 改动给完整 before/after。
- **类型一致**：`nameSource` 在 DeviceRecord（Task 2）→ deviceHello（Task 3）→ mapDevice（Task 4）命名一致；`updateName({name})` 签名（Task 2）在 memory（Task 2）/sqlite（Task 2 参数名 + Task 4 SQL）/usecase（Task 3）调用一致。
- **中间态**：Task 2 后 sqlite updateName SQL 仍写 hostname 列（Task 4 才改 name 列），Task 2/3 之间 sqlite rename 暂写旧列——可接受，Task 4 统一，Task 6 全量验证。
