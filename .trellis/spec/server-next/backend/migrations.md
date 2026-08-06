# 迁移：静态注册 + 表守卫 + 函数序权威

## 何时适用

新增或修改任何 SQLite schema 时。`server-next` 的迁移不是按文件名自动扫描，而是**显式静态注册**，且历史表需要守卫、重复号以注册顺序为准。

## 本地模式

### 双轨迁移目录

- Global DB 迁移：`src/infra/sqlite/migrations/global/`（23 个 `.sql` 文件）。
- Team DB 迁移：`src/infra/sqlite/migrations/team/`（84 个 `.sql` 文件）。

### 静态注册（核心）

迁移文件**不会**被自动发现。每个迁移必须在注册函数里显式列一行 `applyMigration(db, 'track/NNNN_name.sql')`：

- `applyGlobalMigrations`：`src/infra/sqlite/repositories.ts:137`
- `applyTeamMigrations`：`src/infra/sqlite/repositories.ts:163`
- `applyMigration` 实现：`src/infra/sqlite/repositories.ts:4261`（签名带 `options: { disableForeignKeys?: boolean }`，:4262）

**新增迁移 = 加 SQL 文件 + 在对应 apply* 函数里追加一行。** 两步缺一不可。

### 重复号：函数序才是权威

存在同号迁移文件：

- `global/`：`0019_active_pi_model.sql` 与 `0019_agent_input_set_capabilities.sql` 同号。
- `team/`：`0080_artifact_version_revision.sql` 与 `0080_task_offer_frozen_inputs.sql` 同号。

**文件名排序不是执行顺序，apply* 函数里的列出顺序才是权威。** 改动这些区域时，以 `repositories.ts` 中 `applyMigration(...)` 的先后为准，不要靠文件名猜。

### 表守卫：sqliteTableExists

碰历史表（可能不存在于旧库）必须先用 `sqliteTableExists` 守卫，否则迁移会对不存在的表查询而炸：

- 定义：`src/infra/sqlite/repositories.ts:317`（`function sqliteTableExists(db, tableName): boolean`）
- 用法示例：`:185`（`manager_leases`）、`:202`（`artifacts`）、`:236`（`channels`）、`:253`（`project_artifact_collections`）、`:312`（`dispatches`）等。

模式：

```ts
if (sqliteTableExists(db, 'historical_table')) {
  applyMigration(db, 'team/NNNN_xxx.sql');
}
```

### disableForeignKeys：重建 FK 的迁移

SQLite 不能 ALTER 改 PK / 去 NOT NULL / 改 FK，需要 `create-new + copy + drop + rename` 重建。这类迁移注册时传 `{ disableForeignKeys: true }`。当前集合（以 `applyTeamMigrations` 注册为准）：

- `team/0021_management_phase_3_rollout.sql`（`src/infra/sqlite/repositories.ts:184`）
- `team/0022_management_phase_4_worker_host.sql`（`:186`）
- `team/0028_channel_coordination_decisions_gate.sql`（`:193`）
- `team/0033_task_immutable_revisions.sql`（`:198`，SQL 内注释 :6 标注复用 0021/0028 惯例）
- `team/0076_project_artifact_versions_nullable_stage.sql`（`:298`）
- `team/0078_package_review.sql`（`:301`）
- `team/0079_project_reference_package_selections.sql`（`:303`）

`disableForeignKeys` 选项在 `applyMigration` 内部处理（`src/infra/sqlite/repositories.ts:4261` 的签名 :4262），重建期间关 FK，重建完恢复。

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/infra/sqlite/repositories.ts`（:137 applyGlobalMigrations、:163 applyTeamMigrations、:317 sqliteTableExists、:4261 applyMigration）
- `/Users/shaw/AgentBean/apps/server-next/src/infra/sqlite/migrations/team/0033_task_immutable_revisions.sql`（:6 重建惯例注释）
- 重复号文件：`migrations/global/0019_*.sql`（×2）、`migrations/team/0080_*.sql`（×2）

## 反模式

- **只丢 SQL 文件不注册**：迁移不会执行；CI 有 `test:migration-registration` 守门（根 `package.json:21` `test:retained-boundaries` 内）。
- **靠文件名排序推断顺序**：同号文件会得到错误顺序。
- **不守卫直接查历史表**：旧库没该表，迁移失败。
- **需要重建 FK 却忘传 `disableForeignKeys: true`**：重建中途 FK 约束报错。

## 验证命令

```bash
cd /Users/shaw/AgentBean/apps/server-next
# 新迁移是否注册（把 NNNN_name 换成你的）
grep -n "NNNN_name" src/infra/sqlite/repositories.ts
# 检查重复号
ls src/infra/sqlite/migrations/global/ | cut -d_ -f1 | sort | uniq -d
ls src/infra/sqlite/migrations/team/ | cut -d_ -f1 | sort | uniq -d
# 跑注册守门
cd /Users/shaw/AgentBean && npm run test:migration-registration
```
