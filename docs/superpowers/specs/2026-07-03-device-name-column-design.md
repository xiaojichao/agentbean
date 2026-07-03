# 设备名独立列设计

> 日期：2026-07-03
> 分支：worktree-device-name-column
> 关联记忆：[[agentbean-device-name-rollback]] / [[agentbean-device-identity]] / [[server-next-migration-static-registration]]

## 一、问题

用户在 web 修改设备名后，几秒到几分钟后名字被自动恢复成 OS hostname（如 `shaw-MacBook`）。

### 根因

`devices` 表只有一列 `hostname`，同时承担「机器 OS hostname」和「用户可编辑的设备显示名」两个语义（读出映射为 `DeviceRecord.name`）。每次 daemon 重连，`deviceHello` → `upsertHello` 用 daemon 上报的 OS hostname **无条件覆盖**这一列，把 `renameDevice` 写入的同一列冲掉。

### 代码证据

| 位置 | 行为 |
|---|---|
| `apps/daemon-next/src/cli.ts:519` | hello payload `hostname: config.hostname`（默认 `os.hostname()`） |
| `apps/server-next/src/application/usecases.ts:1419` | `deviceHello` 把 `name: deviceInput.hostname` 喂入 upsert |
| `apps/server-next/src/infra/sqlite/repositories.ts:761` | `upsertHello` 的 `ON CONFLICT DO UPDATE SET hostname = excluded.hostname` 无条件覆盖 |
| `apps/server-next/src/infra/sqlite/repositories.ts:1929` | `mapDevice` 把 hostname 列读成 `name` —— 双语义根源 |
| `apps/server-next/src/application/usecases.ts:1461,1468` | token 的 hostname claim 固化为 `device.name`，形成闭环 |

daemon 侧无法自救：只发 `os.hostname()`，不缓存 server 名，收不到 `device:rename`（仅 web/admin namespace）。**修复只能在 server 侧。**

覆盖频率：socket.io 自动重连（`reconnectionDelay` 1s 起 5s 封顶），无应用层节流，网络抖动/睡眠唤醒即触发。

## 二、目标 / 核心不变式

> daemon 重连后 `device.name` 必须保留用户上次 `renameDevice` 的值；机器 hostname 只活在 `hostname` 列和 `systemInfo.hostname`；`upsertHello` 的 `ON CONFLICT DO UPDATE` 绝不更新 `name` / `name_source`。

## 三、方案：独立 name 列 + name_source

拆列：`hostname` 列回归纯机器名语义；新增 `name` 列承载用户显示名，新增 `name_source` 标记来源（`'user'` | `'hostname'`）。

### 决策记录

- **D1（用户拍板）**：renameDevice 参数 `hostname` → `name`，网络键同步改。消除误导命名（rename 是 web→server 单向，不涉及 daemon 版本兼容）。
- **D2（用户拍板）**：顺手清理 web-next 的 `device.hostname` 死代码。
- **回填**：升级时 `name = hostname, name_source = 'hostname'`，显示零变化，此后重连不再覆盖。
- **nameSource 不进 DeviceDto 契约**：内部字段，YAGNI。

### 3.1 Schema 变更

新两个 migration（仿 0007 加列 / 0008 backfill 惯例）：

```sql
-- apps/server-next/src/infra/sqlite/migrations/global/0012_device_name_columns.sql
ALTER TABLE devices ADD COLUMN name TEXT;
ALTER TABLE devices ADD COLUMN name_source TEXT;   -- 'user' | 'hostname'
```

```sql
-- apps/server-next/src/infra/sqlite/migrations/global/0013_device_name_backfill.sql
-- 幂等：WHERE name IS NULL 跳过已回填行
UPDATE devices SET name = hostname, name_source = 'hostname'
WHERE name IS NULL AND hostname IS NOT NULL;
```

**注册（记忆坑）**：在 `apps/server-next/src/infra/sqlite/repositories.ts:52` 后（0011 之后）加两行：

```ts
applyMigration(db, 'global/0012_device_name_columns.sql');
applyMigration(db, 'global/0013_device_name_backfill.sql');
```

### 3.2 server-next 代码改动

| 文件 | 改动 |
|---|---|
| `application/repositories.ts:86-94` | `DeviceRecord` 加 `nameSource?: 'user' \| 'hostname'` |
| `application/repositories.ts:200` | `DeviceRepository.updateName` 签名 `hostname` → `name` |
| `application/usecases.ts:70` | `renameDevice` 接口参数 `hostname: string` → `name: string` |
| `application/usecases.ts:1569-1589` | `renameDevice` 实现用 `renameInput.name`；调 `updateName({ deviceId, name, updatedAt })` |
| `infra/sqlite/repositories.ts:1919-1940` | `mapDevice`：`name` 改读 `name` 列；加 `nameSource: sqliteNullableText(row,'name_source')` |
| `infra/sqlite/repositories.ts:749-787` | `upsertHello`：INSERT 列表加 `name`/`name_source`，VALUES 用 `device.name`/`device.nameSource`；**`ON CONFLICT DO UPDATE` 移除 `name`/`name_source` 两行** ← 核心修复 |
| `infra/sqlite/repositories.ts:872-880` | `updateName`：`UPDATE devices SET name = ?, name_source = 'user', updated_at = ? WHERE id = ?` |
| `infra/sqlite/repositories.ts:798-813` | `findCanonicalByDisplay`：匹配键 hostname 列 → name 列（回退 `json_extract(system_info,'$.hostname')`） |
| `application/usecases.ts:1419` | `deviceHello`：`name` 仅在新建时（`!existing`）初始化为 `deviceInput.hostname`，`nameSource:'hostname'`；existing 设备传 `existing.name`/`existing.nameSource` 保留 |
| `application/usecases.ts:1461,1468` | token `hostname` claim 改用 `deviceInput.hostname`（机器名），不再用 `device.name`（显示名）—— 防二次污染 |
| `infra/memory/repositories.ts:411-414` | memory `upsertHello`：保持 `set(input)` 语义不变。**name 的正确值由 `deviceHello` 统一计算传入**（existing→`existing.name`、新建→`deviceInput.hostname`），repo 层（sqlite/memory）都不做特殊 existing 判断 —— sqlite 靠 ON CONFLICT 不写 name，memory 靠 `set(input)` |
| `infra/memory/repositories.ts:477-489` | memory `updateName`：`hostname` 参数 → `name`；置 `nameSource:'user'` |
| `infra/memory/repositories.ts:428-453` | memory `findCanonicalByDisplay`：已用 `name ?? systemInfo.hostname`，核对保持 |

### 3.3 web-next 清理（D1 网络键 + D2 死代码）

| 文件 | 改动 |
|---|---|
| `apps/web-next/lib/socket.ts:518` | rename emit 网络键 `hostname` → `name` |
| `apps/web-next/lib/schema.ts:195` | 移除死的 `hostname?` 字段 |
| `apps/web-next/app/[networkPath]/devices/page.tsx:43-45` | `deviceDisplayName` 简化为 `(device.name ?? device.systemInfo?.hostname ?? '').trim() \|\| device.id` |
| `apps/web-next/lib/agent-device.ts:7` | `device.hostname` → `device.name` |
| `apps/web-next/components/member-detail.tsx:467` | `device.hostname` → `device.name` |
| `apps/web`（legacy） | 不动（rollback 备份） |

## 四、测试策略（vitest，TDD 红→绿）

### 单元（repo 层）— `apps/server-next/tests/device-repository.test.ts`

- 新建设备：`upsertHello` 后 `name === deviceInput.hostname`，`nameSource === 'hostname'`。
- 改名：`updateName({ name: '我的设备' })` 后 `name === '我的设备'`，`nameSource === 'user'`。
- **回归（红→绿）**：再次 `upsertHello`（模拟重连，带不同 hostname）→ `name` 仍是 `'我的设备'`，不被覆盖；`nameSource` 仍 `'user'`。
- memory repo 镜像同样断言。

### 端到端（socket）— `apps/server-next/tests/device-management.test.ts`

- 通过 web socket `device.rename` 改名 → 通过 agent socket 发 `device.hello`（hostname 不同）→ `device.list` 断言返回 `device.name` 仍是用户改的名。**核心回归测试。**

### 持久化（sqlite）— `apps/server-next/tests/sqlite-repositories.test.ts`（或新增）

- migration 后，用户改的名经一次断开/重连周期保留。

## 五、范围边界（不做）

- `nameSource` 不进 `DeviceDto` 契约（内部字段）。
- `apps/web` legacy 不清理（rollback 备份）。
- 不改 daemon 侧（daemon 无法自救，见根因）。
- 不引入 daemon 自更新（独立大项，见 [[agentbean-daemon-no-auto-update]]）。

## 六、验收标准

1. 重连后 `device.name` 保留用户 rename 值（端到端测试通过）。
2. 升级后所有设备显示名零变化（回填 `name=hostname`）。
3. `upsertHello` 的 ON CONFLICT 不含 `name`/`name_source`。
4. 新 migration 已在 `applyGlobalMigrations` 注册。
5. 全量测试绿（单元 + 端到端 + memory 镜像）。
6. web-next 显示路径无 `device.hostname` 死引用。

## 七、风险

- **token claim 错绑**：若 token `hostname` claim 仍用 `device.name`（显示名），`deviceHelloFromCredentials`（`usecases.ts:1328`）会把显示名当机器名写回 hostname 列，造成二次污染。已在 3.2 修正。
- **memory repo 漏改**：memory `upsertHello` 若仍整体覆盖，单元测试在 memory repo 上会失败（镜像测试能抓住）。
- **migration 未注册**：忘在 `applyGlobalMigrations` 加行 → migration 不生效（记忆坑，已列入 checklist）。
