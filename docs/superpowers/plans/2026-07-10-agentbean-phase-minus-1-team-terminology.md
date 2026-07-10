# AgentBean Phase -1 Team 术语切换实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入 PI runtime 的前提下，让 AgentBean 的产品文档、共享 contracts、Server、Web、Device、路由、持久化键、测试和 SQLite schema 只使用 Team 作为协作空间模型，并建立阻止旧空间术语回流的 CI 门禁。

**Architecture:** 先从共享 contracts 删除兼容事件和旧 DTO 投影，再以同一发布单元原子切换 Server 与 Web；SQLite 只追加迁移，不修改已经执行过的 migration。浏览器旧键采用一次读取、写入新键、删除旧键的迁移方式，并在 7 天观察窗口后移除读取代码。已经退出生产主线的 `apps/server`、`apps/web`、`apps/daemon` 不再继续维护第二套空间模型，而是从 `main` 移除，回滚改用 Git 历史、Railway deployment rollback 和 npm `legacy` dist-tag。

**Tech Stack:** TypeScript、Node.js 24.15、Socket.IO、Next.js App Router、React、Zustand、SQLite / better-sqlite3、Vitest、Node test runner、Chrome browser smoke、GitHub Actions。

**Source spec:** `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md` §21 Phase -1 与 `docs/superpowers/specs/2026-05-09-agentbean-prd.md` §2.2、§16。

**Acceptance matrix:** `agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`。

## Global Constraints

- 本计划只实施 Phase -1；不得引入 PI SDK、`PiManagerWorkerHost`、`ManagementRun`、Task DAG 或跨 Agent Memory。
- 协作空间的 canonical identifiers 只能是 `teamId`、`teamPath`、`primaryTeamId`、`visibleTeamIds`、`currentTeamId`。
- HTTP 业务资源只能使用 `/api/teams/:teamId/...`；不得保留第二套 artifact HTTP route。
- SQLite 使用 `teams`、`team_members`、`team_id`、`current_team_id`、`primary_team_id` 和 snake_case 列。
- 通用“网络请求失败”“网络超时”等传输语义不属于产品空间模型；静态门禁只匹配产品字段、事件、路由、表名和已废弃产品名，不禁止正常的 networking 描述。
- `agent_publications` 与 `visibleTeamIds` 表达 Agent 在额外 Team 中的可见性，不属于本次术语清理；不得在 Phase -1 顺手改变可见性产品语义。
- 不修改已应用的 `0011_device_revocations.sql`；必须追加 `0014_device_revocations_team_columns.sql`，保证现有生产库可升级。
- Server、contracts 与 Web 的字段删除必须作为同一发布单元交付，不允许先发布只返回新字段的 Server、再等待 Web 适配。
- 浏览器迁移发布后只写 `agentbean.teamPath`；旧键只允许在隔离的迁移 helper 中读取一次并立即删除。
- 迁移 helper 保留 7 天观察窗口；Phase -1 完成发布必须移除旧键读取代码及其 allowlist。
- 不新增依赖；优先复用现有 Vitest、Node、Next.js、Socket.IO 和 smoke 工具。
- TypeScript 改动必须按仓库合同运行相应 `build:*`，不能用 Vitest 代替类型检查。
- 生产 schema 变更前备份 global SQLite；如需回滚到旧 binary，必须恢复备份，不能让旧 binary 读取已经重建的列。
- 每个任务独立走 red → green → build → commit；任何 task 失败都不得开始依赖它的下游任务。

---

## File Structure

### Create

- `apps/server-next/src/infra/sqlite/migrations/global/0014_device_revocations_team_columns.sql`：把 `device_revocations` 重建为 snake_case 列并保留数据。
- `apps/web-next/lib/team-path.ts`：Team path 新键读写和 7 天一次性旧键迁移。
- `apps/web-next/tests/team-path.test.ts`：浏览器 path key 迁移回归测试。
- `scripts/check-team-terminology.mjs`：扫描产品源码、schema、活动文档和测试的静态门禁。
- `scripts/check-team-terminology.test.mjs`：验证门禁命中字段、事件、路由和 schema 变体。
- `agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`：Phase -1 独立验收矩阵。

### Rename

- `apps/web-next/app/[networkPath]` → `apps/web-next/app/[teamPath]`。
- `apps/web-next/app/[teamPath]/networks` → `apps/web-next/app/[teamPath]/teams`。

### Delete after replacement is green

- `apps/web-next/app/api/networks/[networkId]/artifacts/upload/route.ts`：删除重复 artifact proxy，保留 `/api/teams/[teamId]/...`。
- `apps/server/`、`apps/web/`、`apps/daemon/`：从 `main` 退役 legacy / rollback 源码；历史回滚通过 Git、Railway 与 npm 已发布包完成。
- `scripts/smoke-agentbean-old-entry.mjs`：移除已经退出主线的旧入口 smoke。
- 已被当前 PRD 与 PI 设计取代的旧空间模型 specs：
  - `docs/superpowers/specs/2026-05-05-agentbean-network-isolation-design.md`
  - `docs/superpowers/specs/2026-05-07-user-invite-network-sandbox-design.md`
  - `docs/superpowers/specs/2026-05-09-multi-network-visibility-design.md`

### Modify: contracts and Server

- `packages/contracts/src/socket.ts`
- `packages/contracts/tests/contracts.test.ts`
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/src/transport/socket-handlers.ts`
- `apps/server-next/src/infra/sqlite/repositories.ts`
- `apps/server-next/tests/socket-handlers.test.ts`
- `apps/server-next/tests/socket-integration.test.ts`
- `apps/server-next/tests/device-revocations-repository.test.ts`
- `apps/server-next/tests/sqlite-repositories.test.ts`

### Modify: Web and smoke

- `apps/web-next/lib/schema.ts`
- `apps/web-next/lib/socket.ts`
- `apps/web-next/lib/store.ts`
- `apps/web-next/lib/agent-scope.ts`
- `apps/web-next/lib/chat-read-state.ts`
- `apps/web-next/lib/artifact-upload.ts`
- `apps/web-next/components/app-shell.tsx`
- `apps/web-next/components/sidebar.tsx`
- `apps/web-next/components/add-agent-modal.tsx`
- `apps/web-next/components/register-agent-modal.tsx`
- `apps/web-next/components/new-channel-dialog.tsx`
- `apps/web-next/app/login/page.tsx`
- `apps/web-next/app/signup/page.tsx`
- `apps/web-next/app/device-login/[code]/page.tsx`
- `apps/web-next/app/join/[token]/page.tsx`
- `apps/web-next/app/[teamPath]/**`
- `apps/web-next/next.config.mjs`
- `apps/web-next/tests/socket-client.test.ts`
- `apps/web-next/tests/chat-task-surface.test.ts`
- `apps/web-next/tests/chat-context-menu.test.ts`
- `scripts/smoke-agentbean-next-browser.mjs`
- `scripts/check-agentbean-next-readiness.mjs`
- `apps/server-next/tests/browser-smoke-script.test.ts`

### Modify: project and documentation gates

- `package.json`
- `package-lock.json`
- `.github/workflows/ci-cd.yml`
- `README.md`
- `agentbean-next/docs/socket-protocol.md`
- `agentbean-next/docs/parity-backfill-audit.md`
- `agentbean-next/docs/post-flip-follow-up-status.md`
- `agentbean-next/docs/seventy-first-slice-status.md`
- `agentbean-next/docs/known-gaps.md`
- `agentbean-next/docs/verification-matrix.md`
- `agentbean-next/docs/production-cutover-runbook.md`
- `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`

---

### Task 1: 删除共享 contracts 中的重复 admin 空间事件

**Files:**
- Modify: `packages/contracts/src/socket.ts`
- Modify: `packages/contracts/tests/contracts.test.ts`

**Interfaces:**
- Consumes: 当前 `WEB_EVENTS.admin.listTeams`、`WEB_EVENTS.admin.deleteTeam`。
- Produces: admin 管理面只暴露 Team 事件；Server 与 Web 后续任务依赖这一事件表。

- [ ] **Step 1: 写失败的完整事件表回归测试**

在 `packages/contracts/tests/contracts.test.ts` 中把只扫描 `WEB_EVENTS.team` 的测试改为扫描完整 `WEB_EVENTS`：

```ts
test('exposes only Team terminology for collaboration-space events', () => {
  const keys = JSON.stringify(WEB_EVENTS);
  const legacyListKey = ['list', 'Networks'].join('');
  const legacyDeleteKey = ['delete', 'Network'].join('');
  const legacyListEvent = ['admin:list-', 'networks'].join('');
  const legacyDeleteEvent = ['admin:delete-', 'network'].join('');

  expect(WEB_EVENTS.team.list).toBe('team:list');
  expect(WEB_EVENTS.team.create).toBe('team:create');
  expect(WEB_EVENTS.team.switch).toBe('team:switch');
  expect(WEB_EVENTS.admin.listTeams).toBe('admin:list-teams');
  expect(WEB_EVENTS.admin.deleteTeam).toBe('admin:delete-team');
  expect(keys).not.toContain(legacyListKey);
  expect(keys).not.toContain(legacyDeleteKey);
  expect(keys).not.toContain(legacyListEvent);
  expect(keys).not.toContain(legacyDeleteEvent);
});
```

- [ ] **Step 2: 运行测试并确认它因旧 admin events 失败**

Run: `npm run test:contracts -- --api.host 127.0.0.1`

Expected: FAIL，失败值包含 `listNetworks` 或 `admin:list-networks`。

- [ ] **Step 3: 删除旧 admin event keys 和 values**

`WEB_EVENTS.admin` 保留以下 Team 管理面：

```ts
admin: {
  listTeams: 'admin:list-teams',
  listUsers: 'admin:list-users',
  listDevices: 'admin:list-devices',
  listAgents: 'admin:list-agents',
  deleteTeam: 'admin:delete-team',
  deleteUser: 'admin:delete-user',
  deleteAgent: 'admin:delete-agent',
  transferDeviceOwner: 'admin:transfer-device-owner',
},
```

- [ ] **Step 4: 运行 contracts 测试和构建**

Run: `npm run test:contracts -- --api.host 127.0.0.1`

Expected: PASS。

Run: `npm run build:contracts`

Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/socket.ts packages/contracts/tests/contracts.test.ts
git commit -m "阻止共享协议继续暴露第二套空间模型" \
  -m "Admin 管理面已经有完整 Team 事件，删除重复兼容事件并用全事件表回归测试锁定。" \
  -m "Constraint: Phase -1 要求共享 contracts 只保留 Team 术语" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: npm run test:contracts; npm run build:contracts"
```

---

### Task 2: 收敛 Server admin handler 与管理 DTO 投影

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`
- Modify: `apps/server-next/src/transport/socket-handlers.ts`
- Modify: `apps/server-next/tests/socket-handlers.test.ts`
- Modify: `apps/server-next/tests/socket-integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 canonical `WEB_EVENTS.admin.listTeams/deleteTeam`。
- Produces: `DeviceAgentListDto`、`AdminAgentDto`、`AdminDeviceDto` 只返回 Team 字段，供 Task 4 的 Web client 使用。

- [ ] **Step 1: 写 handler 和 DTO 的失败测试**

在 `apps/server-next/tests/socket-handlers.test.ts` 增加：

```ts
expect(socket.eventNames()).toContain(WEB_EVENTS.admin.listTeams);
expect(socket.eventNames()).toContain(WEB_EVENTS.admin.deleteTeam);
expect(socket.eventNames()).not.toContain(['admin:list-', 'networks'].join(''));
expect(socket.eventNames()).not.toContain(['admin:delete-', 'network'].join(''));
```

在 `apps/server-next/tests/socket-integration.test.ts` 的 admin/device-agent projection 用例改为：

```ts
expect(deviceAgent).toMatchObject({
  primaryTeamId: team.id,
  visibleTeamIds: [team.id],
});
expect(deviceAgent).not.toHaveProperty('networkId');
expect(deviceAgent).not.toHaveProperty('publishedNetworkIds');
expect(deviceAgent).not.toHaveProperty('unpublishedNetworkIds');

expect(adminDevice).toMatchObject({ teamId: team.id, teamName: team.name });
expect(adminAgent).toMatchObject({
  primaryTeamId: team.id,
  primaryTeamName: team.name,
  visibleTeamIds: [team.id],
});
```

- [ ] **Step 2: 运行 targeted tests 并确认失败**

Run:

```bash
cd apps/server-next
../../node_modules/.bin/vitest run \
  tests/socket-handlers.test.ts \
  tests/socket-integration.test.ts \
  --config vitest.config.ts \
  --api.host 127.0.0.1
```

Expected: FAIL，旧 handler 仍注册或旧 projection 字段仍存在。

- [ ] **Step 3: 删除重复 usecase 与 handler**

从 `ServerNextUseCases`、factory implementation 与 socket bindings 删除 `listAdminNetworks()`；删除旧 admin delete handler 中同时读取两种 payload key 的逻辑。唯一 delete handler 使用：

```ts
const teamId = payloadString(payload, 'teamId');
if (!teamId) {
  ack?.(makeFailure('VALIDATION_ERROR', 'teamId is required'));
  return;
}
ack?.(await options.useCases.deleteTeam({ userId, teamId }));
```

- [ ] **Step 4: 收敛 Server DTO types 和 mapper**

目标类型：

```ts
type DeviceAgentListDto = AgentDto & {
  deviceName?: string;
};

type AdminAgentDto = AgentDto & {
  role?: string;
  primaryTeamName: string;
  ownerName?: string | null;
  userName?: string | null;
  deviceName?: string | null;
  deviceUserId?: string | null;
  deviceUserName?: string | null;
};

type AdminDeviceDto = DeviceDto & {
  userId: string;
  userName: string;
  teamName: string;
  agentCount: number;
  agents: AdminAgentDto[];
};
```

`toDeviceAgentListDto()` 不再复制 `AgentDto.primaryTeamId/visibleTeamIds` 到兼容字段；`toAdminAgentDto()` 只增加 `primaryTeamName`；`toAdminDeviceDto()` 只增加 `teamName`。

- [ ] **Step 5: 运行 targeted tests、完整 Server tests 和构建**

Run: Task 2 Step 2 的 targeted command。

Expected: PASS。

Run: `cd ../.. && npm run test:server-next -- --api.host 127.0.0.1`

Expected: PASS。

Run: `npm run build:server-next`

Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/application/usecases.ts apps/server-next/src/transport/socket-handlers.ts apps/server-next/tests/socket-handlers.test.ts apps/server-next/tests/socket-integration.test.ts
git commit -m "让 Server 只发布 Team 语义的管理数据" \
  -m "删除重复 admin handler 与旧 DTO 投影，使管理面、设备 Agent 列表和错误响应共享同一 Team 合同。" \
  -m "Constraint: Server 与 Web 必须在同一发布单元切换字段" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: server-next targeted tests; npm run test:server-next; npm run build:server-next"
```

---

### Task 3: 迁移 `device_revocations` 为 Team snake_case schema

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0014_device_revocations_team_columns.sql`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`
- Modify: `apps/server-next/tests/device-revocations-repository.test.ts`
- Modify: `apps/server-next/tests/sqlite-repositories.test.ts`

**Interfaces:**
- Consumes: 现有 `applyGlobalMigrations()` 与 revocation repository API。
- Produces: 表列 `team_id/machine_id/profile_id/profile_key/device_id/deleted_at`；TypeScript repository API 仍使用 `teamId` 等语言内字段。

- [ ] **Step 1: 写升级数据保留失败测试**

测试必须先构造 0011 形状，插入普通 profile 与 `NULL profileId` 两行，再运行 `applyGlobalMigrations()`：

```ts
legacyDb.exec(readFileSync(join(MIGRATIONS_DIR, 'global/0011_device_revocations.sql'), 'utf8'));
legacyDb.prepare(
  `INSERT INTO device_revocations
   (teamId, machineId, profileId, profileKey, deviceId, deletedAt)
   VALUES (?, ?, ?, ?, ?, ?)`,
).run('team-1', 'machine-1', 'profile-1', 'profile-1', 'device-1', 100);
legacyDb.prepare(
  `INSERT INTO device_revocations
   (teamId, machineId, profileId, profileKey, deviceId, deletedAt)
   VALUES (?, ?, NULL, ?, ?, ?)`,
).run('team-1', 'machine-2', '__default__', 'device-2', 200);

applyGlobalMigrations(legacyDb);

expect(columnNames(legacyDb, 'device_revocations')).toEqual([
  'team_id',
  'machine_id',
  'profile_id',
  'profile_key',
  'device_id',
  'deleted_at',
]);
expect(legacyDb.prepare(
  `SELECT team_id AS teamId, machine_id AS machineId,
          profile_id AS profileId, profile_key AS profileKey,
          device_id AS deviceId, deleted_at AS deletedAt
   FROM device_revocations ORDER BY machine_id`,
).all()).toEqual([
  { teamId: 'team-1', machineId: 'machine-1', profileId: 'profile-1', profileKey: 'profile-1', deviceId: 'device-1', deletedAt: 100 },
  { teamId: 'team-1', machineId: 'machine-2', profileId: null, profileKey: '__default__', deviceId: 'device-2', deletedAt: 200 },
]);
```

- [ ] **Step 2: 运行 SQLite tests 并确认失败**

Run:

```bash
cd apps/server-next
../../node_modules/.bin/vitest run \
  tests/device-revocations-repository.test.ts \
  tests/sqlite-repositories.test.ts \
  --config vitest.config.ts \
  --api.host 127.0.0.1
```

Expected: FAIL，列仍为 0011 的 camelCase 形状。

- [ ] **Step 3: 添加不可逆 forward migration**

`0014_device_revocations_team_columns.sql` 使用以下完整 SQL：

```sql
BEGIN IMMEDIATE;

ALTER TABLE device_revocations RENAME TO device_revocations_legacy;

CREATE TABLE device_revocations (
  team_id     TEXT NOT NULL,
  machine_id  TEXT NOT NULL,
  profile_id  TEXT,
  profile_key TEXT NOT NULL,
  device_id   TEXT,
  deleted_at  INTEGER NOT NULL,
  PRIMARY KEY (team_id, machine_id, profile_key)
);

INSERT INTO device_revocations (
  team_id,
  machine_id,
  profile_id,
  profile_key,
  device_id,
  deleted_at
)
SELECT
  teamId,
  machineId,
  profileId,
  profileKey,
  deviceId,
  deletedAt
FROM device_revocations_legacy;

DROP TABLE device_revocations_legacy;

CREATE INDEX idx_revocations_machine
  ON device_revocations(team_id, machine_id);

COMMIT;
```

把 migration 加在 `applyGlobalMigrations()` 的 0013 之后。

- [ ] **Step 4: 切换 repository SQL 并保留 TypeScript aliases**

Repository write 使用 snake_case columns；read 使用：

```sql
SELECT
  team_id AS teamId,
  machine_id AS machineId,
  profile_id AS profileId,
  profile_key AS profileKey,
  device_id AS deviceId,
  deleted_at AS deletedAt
FROM device_revocations
```

- [ ] **Step 5: 验证 fresh DB、upgrade DB、主键和索引**

Run: Task 3 Step 2 的 targeted command。

Expected: PASS，升级前后行数一致，`NULL profile_id` 保留，`idx_revocations_machine` 使用 `team_id,machine_id`。

Run: `cd ../.. && npm run build:server-next`

Expected: exit 0。

- [ ] **Step 6: Commit**

```bash
git add apps/server-next/src/infra/sqlite/migrations/global/0014_device_revocations_team_columns.sql apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/tests/device-revocations-repository.test.ts apps/server-next/tests/sqlite-repositories.test.ts
git commit -m "避免 Device 撤销记录成为 schema 术语例外" \
  -m "通过追加迁移重建 revocation 表并保留现有数据，使全局 SQLite 一致使用 Team snake_case 列。" \
  -m "Constraint: 已应用的 0011 migration 不允许修改" \
  -m "Rejected: 直接编辑 0011 | 已部署数据库不会重新执行旧 migration" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Directive: 回滚旧 binary 必须恢复迁移前 global DB 备份" \
  -m "Tested: device revocation and sqlite repository tests; npm run build:server-next"
```

---

### Task 4: 把 Web client model 和 socket adapters 切换为 canonical Team 字段

**Files:**
- Modify: `apps/web-next/lib/schema.ts`
- Modify: `apps/web-next/lib/socket.ts`
- Modify: `apps/web-next/lib/store.ts`
- Modify: `apps/web-next/lib/agent-scope.ts`
- Modify: `apps/web-next/lib/chat-read-state.ts`
- Modify: `apps/web-next/lib/artifact-upload.ts`
- Modify: `apps/web-next/tests/socket-client.test.ts`
- Modify: `apps/web-next/tests/chat-task-surface.test.ts`
- Modify: `apps/web-next/tests/chat-context-menu.test.ts`

**Interfaces:**
- Consumes: Task 2 输出的 `teamId/teamName/primaryTeamId/primaryTeamName/visibleTeamIds`。
- Produces: Web components 只读取 canonical Team fields；Task 5 路由改名不再承担 DTO 兼容。

- [ ] **Step 1: 写 client contract 失败测试**

在 `socket-client.test.ts` 断言 create、invite、device-agent list 和 admin snapshot 的 payload/response：

```ts
await agentEvents(socket).create({
  teamId: 'team-1',
  name: 'Codex',
  adapterKind: 'codex',
  command: 'codex',
});
expect(socket.lastPayload(WEB_EVENTS.agent.create)).toMatchObject({ teamId: 'team-1' });

await authEvents(socket).inviteCreate({ teamId: 'team-1', purpose: 'device' });
expect(socket.lastPayload(WEB_EVENTS.deviceInvite.create)).toEqual({
  teamId: 'team-1',
  purpose: 'device',
});

expect(JSON.stringify(adminAgent)).not.toContain('publishedNetworkIds');
expect(JSON.stringify(adminDevice)).not.toContain('networkName');
```

- [ ] **Step 2: 运行 Web tests 并确认失败**

Run:

```bash
cd apps/web-next
npm run test -- \
  tests/socket-client.test.ts \
  tests/chat-task-surface.test.ts \
  tests/chat-context-menu.test.ts \
  --api.host 127.0.0.1
```

Expected: FAIL，API types 或 adapter 仍要求旧字段。

- [ ] **Step 3: 删除 Web schema 的兼容投影**

`AgentSnapshot` 直接继承或声明 canonical fields：

```ts
export interface AgentSnapshot {
  id: string;
  primaryTeamId: string;
  visibleTeamIds: string[];
  name: string;
  status: AgentStatus;
  deviceId?: string | null;
  deviceName?: string | null;
  primaryTeamName?: string;
}
```

`DeviceInfo` 使用 `teamId` 和 `teamName`；删除 `normalizeAgentSnapshot()` 中把 canonical fields 再复制到旧字段的逻辑。

- [ ] **Step 4: 重命名所有内部 helper 参数和 API signatures**

目标 signatures：

```ts
export function artifactUploadUrl(serverUrl: string, teamId: string, token: string): string;
export function artifactUploadProxyUrl(teamId: string, token: string): string;
export function artifactUploadFallbackUrls(serverUrl: string, teamId: string, token: string): string[];

create(payload: {
  teamId: string;
  name: string;
  adapterKind: string;
  command: string;
  args?: string[];
  category?: string;
  cwd?: string;
  env?: Record<string, string>;
  description?: string;
  deviceId?: string;
}): Promise<{ ok: boolean; agent?: AgentSnapshot; error?: string }>;

delete(teamId: string): Promise<{ ok: boolean; fallbackTeam?: TeamSummary | null; error?: string }>;
inviteCreate(payload?: { teamId?: string; purpose?: 'user' | 'device' }): Promise<{ ok: boolean; invite?: InviteInfo; error?: string }>;
deviceLogin(payload: { inviteCode: string; username: string; password: string }): Promise<{ ok: boolean; token?: string; teamId?: string; teamPath?: string; userId?: string; username?: string; role?: 'admin' | 'user'; deviceId?: string; error?: string }>;
agentsList(deviceId: string, teamId?: string | null): Promise<{ ok: boolean; agents?: DeviceAgent[]; runtimes?: DeviceRuntime[]; error?: string }>;
```

`agentNameLogicalKey()`、`agentRuntimeLogicalKey()`、`agentGatewayLogicalKey()`、`visibleAgentLogicalKeys()`、`dedupeAgents()` 和 `agentListToMap()` 的第二参数统一命名为 `teamId`。

- [ ] **Step 5: 运行 Web targeted tests 和 client type build**

Run: Task 4 Step 2 的 targeted command。

Expected: PASS。

Run: `cd apps/web-next && npm run build:client`

Expected: exit 0；此处只验证 Web socket client package。完整 Next app build 在 Task 6 完成所有 component consumers 后执行。

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/lib apps/web-next/tests/socket-client.test.ts apps/web-next/tests/chat-task-surface.test.ts apps/web-next/tests/chat-context-menu.test.ts
git commit -m "让 Web client 直接消费 Team 合同" \
  -m "移除 DTO 二次投影并统一 helper 与 payload 参数，避免 UI store 成为旧字段的长期兼容层。" \
  -m "Constraint: Server 和 Web 字段删除必须原子发布" \
  -m "Confidence: high" \
  -m "Scope-risk: broad" \
  -m "Tested: web-next targeted tests; npm run build:client"
```

---

### Task 5: 重命名 Web route tree、团队管理入口和浏览器持久化键

**Files:**
- Create: `apps/web-next/lib/team-path.ts`
- Create: `apps/web-next/tests/team-path.test.ts`
- Rename: `apps/web-next/app/[networkPath]` → `apps/web-next/app/[teamPath]`
- Rename: `apps/web-next/app/[teamPath]/networks` → `apps/web-next/app/[teamPath]/teams`
- Modify: `apps/web-next/components/app-shell.tsx`
- Modify: `apps/web-next/components/sidebar.tsx`
- Modify: `apps/web-next/app/login/page.tsx`
- Modify: `apps/web-next/app/signup/page.tsx`
- Modify: `apps/web-next/app/device-login/[code]/page.tsx`
- Modify: `apps/web-next/app/join/[token]/page.tsx`
- Modify: `apps/web-next/next.config.mjs`

**Interfaces:**
- Consumes: Task 4 的 canonical `teamId/teamPath` client fields。
- Produces: App Router params `{ teamPath: string }`、团队管理 URL `/:teamPath/teams`、新 localStorage key `agentbean.teamPath`。

- [ ] **Step 1: 写 Team path key 迁移失败测试**

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readStoredTeamPath, writeStoredTeamPath, type StorageLike } from '../lib/team-path';

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(initial)) this.values.set(key, value);
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test('migrates the legacy path key once and removes it', () => {
  const storage = new MemoryStorage({ 'agentbean.networkPath': 'team-one' });

  expect(readStoredTeamPath(storage)).toBe('team-one');
  expect(storage.getItem('agentbean.teamPath')).toBe('team-one');
  expect(storage.getItem('agentbean.networkPath')).toBeNull();
});

test('writes only the Team path key', () => {
  const storage = new MemoryStorage({ 'agentbean.networkPath': 'stale' });

  writeStoredTeamPath(storage, 'team-two');

  expect(storage.getItem('agentbean.teamPath')).toBe('team-two');
  expect(storage.getItem('agentbean.networkPath')).toBeNull();
});

test('uses only Team route segments', () => {
  const appDir = join(process.cwd(), 'app');
  const oldSegment = `[${['network', 'Path'].join('')}]`;
  const oldPage = ['net', 'works'].join('');

  expect(existsSync(join(appDir, '[teamPath]'))).toBe(true);
  expect(existsSync(join(appDir, '[teamPath]', 'teams', 'page.tsx'))).toBe(true);
  expect(existsSync(join(appDir, oldSegment))).toBe(false);
  expect(existsSync(join(appDir, '[teamPath]', oldPage))).toBe(false);
});
```

- [ ] **Step 2: 运行新测试并确认 module 不存在**

Run: `cd apps/web-next && npm run test -- tests/team-path.test.ts --api.host 127.0.0.1`

Expected: FAIL with module not found。

- [ ] **Step 3: 实现隔离的一次性迁移 helper**

```ts
const TEAM_PATH_KEY = 'agentbean.teamPath';
const LEGACY_PATH_KEY = ['agentbean', 'networkPath'].join('.');

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readStoredTeamPath(storage: StorageLike): string | null {
  const current = storage.getItem(TEAM_PATH_KEY);
  if (current) return current;

  const legacy = storage.getItem(LEGACY_PATH_KEY);
  if (!legacy) return null;

  storage.setItem(TEAM_PATH_KEY, legacy);
  storage.removeItem(LEGACY_PATH_KEY);
  return legacy;
}

export function writeStoredTeamPath(storage: StorageLike, teamPath: string): void {
  storage.setItem(TEAM_PATH_KEY, teamPath);
  storage.removeItem(LEGACY_PATH_KEY);
}
```

只有该 helper 和测试可在 Release A 期间进入静态门禁 allowlist。

- [ ] **Step 4: 用 Git move 重命名 route segments**

Run:

```bash
git mv 'apps/web-next/app/[networkPath]' 'apps/web-next/app/[teamPath]'
git mv 'apps/web-next/app/[teamPath]/networks' 'apps/web-next/app/[teamPath]/teams'
```

所有页面 params 改为：

```ts
export default function Page({ params }: { params: { teamPath: string } }) {
  const routeTeamPath = params.teamPath;
}
```

将 `useCurrentNetworkPath()` 重命名为 `useCurrentTeamPath()`；组件内部 `currentNetwork/showNetworks/CreateNetworkDialog` 分别改为 `currentTeam/showTeams/CreateTeamDialog`。

- [ ] **Step 5: 切换登录、邀请、切换 Team 与 redirect 的存储调用**

所有直接 `localStorage.getItem/setItem` 调用改为 `readStoredTeamPath(window.localStorage)` 和 `writeStoredTeamPath(window.localStorage, team.path)`。团队管理入口使用 `/${teamPath}/teams`。

`next.config.mjs` 的 Device redirect 参数改为：

```js
{
  source: '/:teamPath/computer/:id',
  destination: '/:teamPath/devices/:id',
  permanent: true,
}
```

- [ ] **Step 6: 运行 path tests 和 client build**

Run: `cd apps/web-next && npm run test -- tests/team-path.test.ts tests/socket-client.test.ts --api.host 127.0.0.1`

Expected: PASS。

Run: `cd apps/web-next && npm run build:client`

Expected: exit 0。Task 5 的 route existence tests 必须证明 `[teamPath]` 和 `/teams` 已存在且旧 segments 不存在；完整 Next route build 在 Task 6 执行。

- [ ] **Step 7: Commit**

```bash
git add apps/web-next
git commit -m "让 Web 路由和浏览器状态以 Team 为唯一入口" \
  -m "重命名动态路由与团队管理页面，并以隔离 helper 完成旧浏览器 path key 的一次性读取转换。" \
  -m "Constraint: Release A 后不得继续写旧键" \
  -m "Confidence: high" \
  -m "Scope-risk: broad" \
  -m "Directive: 观察 7 天后必须删除旧键读取 helper 分支" \
  -m "Tested: web-next path and route tests; npm run build:client"
```

---

### Task 6: 删除 artifact、Device 登录和 Agent 创建流程的兼容参数

**Files:**
- Delete: `apps/web-next/app/api/networks/[networkId]/artifacts/upload/route.ts`
- Modify: `apps/web-next/app/api/teams/[teamId]/artifacts/upload/route.ts`
- Modify: `apps/web-next/components/add-agent-modal.tsx`
- Modify: `apps/web-next/components/register-agent-modal.tsx`
- Modify: `apps/web-next/components/new-channel-dialog.tsx`
- Modify: `apps/web-next/app/[teamPath]/devices/page.tsx`
- Modify: `apps/web-next/app/[teamPath]/agents/page.tsx`
- Modify: `apps/web-next/app/[teamPath]/agents/[agentId]/page.tsx`
- Modify: `apps/web-next/app/[teamPath]/dashboard/page.tsx`
- Modify: `apps/web-next/app/[teamPath]/settings/page.tsx`
- Modify: `apps/web-next/tests/socket-client.test.ts`

**Interfaces:**
- Consumes: Task 4 canonical Web APIs 与 Task 5 route params。
- Produces: UI flows 只发送 `teamId`；artifact proxy 只有 `/api/teams/[teamId]/...`。

- [ ] **Step 1: 写旧 artifact route 不存在和 canonical payload 的失败测试**

在 Web tests 增加静态 route 断言：

```ts
expect(existsSync(join(APP_DIR, 'api/teams/[teamId]/artifacts/upload/route.ts'))).toBe(true);
expect(existsSync(join(
  APP_DIR,
  'api',
  ['net', 'works'].join(''),
  `[${['network', 'Id'].join('')}]`,
  'artifacts/upload/route.ts',
))).toBe(false);
```

Agent create 和 Device invite 断言只包含：

```ts
expect(payload).toMatchObject({ teamId: 'team-1' });
expect(payload).not.toHaveProperty('networkId');
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `cd apps/web-next && npm run test -- tests/socket-client.test.ts --api.host 127.0.0.1`

Expected: FAIL，旧 route 仍存在或 payload 仍包含旧 key。

- [ ] **Step 3: 删除 route alias 并统一组件 props/state**

执行：

```bash
git rm 'apps/web-next/app/api/networks/[networkId]/artifacts/upload/route.ts'
```

将 `AddCustomAgentDialog` signature 改为：

```ts
function AddCustomAgentDialog({
  deviceId,
  teamId,
  daemonVersion,
  runtimes,
  isLocal = true,
  onClose,
  onCreated,
}: {
  deviceId: string;
  teamId?: string | null;
  daemonVersion?: string | null;
  runtimes: DeviceRuntime[];
  isLocal?: boolean;
  onClose: () => void;
  onCreated: () => void;
})
```

Admin dashboard 使用 `device.teamName`、`agent.primaryTeamName`、`agent.primaryTeamId`、`agent.visibleTeamIds.length`。Device response 只读取 `res.device.teamId`。Device login 成功只读取 `res.teamId/res.teamPath`。

- [ ] **Step 4: 运行 Web tests 和 build**

Run: `cd apps/web-next && npm run test -- --api.host 127.0.0.1`

Expected: PASS。

Run: `cd ../.. && npm run build:web-next`

Expected: exit 0。

- [ ] **Step 5: Commit**

```bash
git add apps/web-next
git commit -m "移除 Web 业务流程中的空间兼容投影" \
  -m "Artifact、Device、Agent 和 admin 页面现在只发送和展示 Team 字段，重复 HTTP route 已删除。" \
  -m "Constraint: HTTP 资源只能使用 /api/teams/:teamId" \
  -m "Confidence: high" \
  -m "Scope-risk: broad" \
  -m "Tested: full web-next tests; npm run build:web-next"
```

---

### Task 7: 更新 readiness、browser smoke 与入口级验收

**Files:**
- Modify: `scripts/smoke-agentbean-next-browser.mjs`
- Modify: `scripts/check-agentbean-next-readiness.mjs`
- Modify: `apps/server-next/tests/browser-smoke-script.test.ts`
- Modify: `agentbean-next/docs/verification-matrix.md`

**Interfaces:**
- Consumes: Task 5 的 `teamPath` route 和 `/teams` 页面。
- Produces: CI/browser smoke 对 Team 切换、Device 接入和 Artifact 上传的新入口级证据。

- [ ] **Step 1: 把 browser smoke 单元测试改为 Team 输出**

```ts
expect(await seedWebUiAuthStorage({ page, session })).toEqual({ teamPath: 'team-one' });
expect(page.initialScript).toContain('agentbean.teamPath');
expect(page.initialScript).not.toContain(['agentbean', 'networkPath'].join('.'));
```

团队管理 flow 预期 URL 改为 `/${teamPath}/teams`。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```bash
cd apps/server-next
../../node_modules/.bin/vitest run \
  tests/browser-smoke-script.test.ts \
  --config vitest.config.ts \
  --api.host 127.0.0.1
```

Expected: FAIL，smoke helper 仍返回旧 property 或写旧 storage key。

- [ ] **Step 3: 全面重命名 smoke 内部 path 变量并更新 URL**

`seedWebUiAuthStorage()`：

```js
export async function seedWebUiAuthStorage({ page, session }) {
  assertSession(session);
  const teamPath = session.team.path ?? session.team.id;
  const script = `
    localStorage.setItem("agentbean.token", ${JSON.stringify(session.token)});
    localStorage.setItem("agentbean.teamPath", ${JSON.stringify(teamPath)});
  `;
  await page.addScriptOnNewDocument(script);
  return { teamPath };
}
```

所有 helpers 的本地变量与参数统一为 `teamPath`；团队创建/切换/删除 flow 使用 `/teams`。

`check-agentbean-next-readiness.mjs` 读取 `[teamPath]` 新路径，并把 `settings / networks` gate label 改为 `settings / teams`。

- [ ] **Step 4: 运行 readiness、browser smoke tests 和本地真实 smoke**

Run: Task 7 Step 2 的 targeted command。

Expected: PASS。

Run: `cd ../.. && npm run check:agentbean-next-readiness`

Expected: 所有 checks 通过。

Run: `npm run smoke:agentbean-next-browser`

Expected: 真实 Chrome 完成 Team switch/create/delete、Device list/detail/invite/scan、Artifact upload/preview/download，报告无旧 URL。

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-agentbean-next-browser.mjs scripts/check-agentbean-next-readiness.mjs apps/server-next/tests/browser-smoke-script.test.ts agentbean-next/docs/verification-matrix.md
git commit -m "让入口级验证证明 Team 切换已经真实生效" \
  -m "Readiness 与浏览器 smoke 改用 Team path、Team 管理页面和新持久化键，覆盖关键业务链路。" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: browser smoke unit test; readiness; real browser smoke"
```

---

### Task 8: 从 `main` 退役仍承载旧空间模型的 legacy source trees

**Files:**
- Delete: `apps/server/**`
- Delete: `apps/web/**`
- Delete: `apps/daemon/**`
- Delete: `scripts/smoke-agentbean-old-entry.mjs`
- Modify: `.github/workflows/ci-cd.yml`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `railway.json`
- Modify: `scripts/audit-agentbean-next-cutover.mjs`
- Modify: `scripts/check-agentbean-next-railway-preflight.mjs`
- Modify: `scripts/prepare-agentbean-next-daemon-release.mjs`
- Modify: `README.md`
- Modify: `agentbean-next/docs/production-cutover-runbook.md`

**Interfaces:**
- Consumes: AgentBean Next 已是 production/default、canonical `@agentbean/daemon` 已由 daemon-next 生成、npm `legacy` dist-tag 已存在。
- Produces: `main` 只保留 `apps/*-next` 与 `packages/*` 产品源码；rollback 通过已发布 artifact 和 Git/Railway 历史完成。

- [ ] **Step 1: 在删除前验证退役前提**

Run:

```bash
npm run audit:agentbean-next-cutover -- --json
npm run smoke:agentbean-next-entry
npm run smoke:agentbean-next-business
npm view @agentbean/daemon dist-tags --json --registry=https://registry.npmjs.org
```

Expected:

- cutover audit `ok=true`；
- public entry 与 business smoke 通过；
- `latest` 指向 daemon-next/canonical 当前版本；
- `legacy` 指向已发布的旧 daemon 版本。

任一前提失败时停止 Task 8；不得删除 rollback source。

- [ ] **Step 2: 先修改 CI 和发布脚本，使其不再依赖 legacy directories**

`.github/workflows/ci-cd.yml`：

- 删除 `apps/web`、`apps/server`、`apps/daemon` validate matrix entries。
- 删除 old-entry smoke job。
- Deploy production 固定使用 server-next，不再保留 deploy target 分支。
- npm publish 只构建 contracts、daemon-next 和 `.agentbean-next-release/daemon` canonical package。
- 保留读取 registry `legacy` dist-tag 的回滚断言，但不再从 `apps/daemon/package.json` 推导旧版本。

`railway.json` 固定 server-next build/start command。`package.json` 删除 `smoke:agentbean-old-entry` 和只服务 legacy 的 scripts。

执行 `npm install --package-lock-only --ignore-scripts` 更新 root workspace lock，使其不再声明已删除的三个 workspace package；不得改变现有依赖版本。

- [ ] **Step 3: 运行 CI 配置与 release package 的本地回归**

Run:

```bash
npm run audit:agentbean-next-cutover -- --json
node scripts/prepare-agentbean-next-daemon-release.mjs --out /tmp/agentbean-phase-minus-1-daemon
node -e "const p=require('/tmp/agentbean-phase-minus-1-daemon/package.json'); if (p.name !== '@agentbean/daemon') process.exit(1)"
```

Expected: cutover audit 通过，生成的 canonical package name 为 `@agentbean/daemon`。

- [ ] **Step 4: 删除 legacy source 和旧 smoke**

Run:

```bash
git rm -r apps/server apps/web apps/daemon
git rm scripts/smoke-agentbean-old-entry.mjs
```

Run: `rg -n 'apps/(server|web|daemon)(/|\b)|smoke-agentbean-old-entry' package.json railway.json scripts .github README.md agentbean-next/docs`

Expected: 只允许出现在明确记录历史基线的 migration/rollback 文档段落；任何 build、deploy、publish 或 test 引用均为失败。

- [ ] **Step 5: 更新 rollback contract**

`production-cutover-runbook.md` 明确：

1. 应用代码回滚使用 GitHub/Railway 上一个成功 deployment；
2. Device 客户端回滚使用 npm `legacy` dist-tag；
3. schema 回滚恢复 deploy 前 global SQLite backup；
4. 不从 `main` 重新构建已退役源码。

- [ ] **Step 6: 运行 root install/build/test gate**

Run: `npm ci --ignore-scripts`

Expected: workspace graph 不再解析已删除 packages。

Run: `npm run test:phase1 -- --api.host 127.0.0.1`

Expected: PASS。

Run: `npm run build:packages`

Expected: exit 0。

- [ ] **Step 7: Commit**

```bash
git add .github package.json railway.json scripts README.md agentbean-next/docs apps
git commit -m "避免 main 继续维护已退出生产的平行产品模型" \
  -m "退役 legacy source trees，并把回滚固定到 Git、Railway 和 npm 已发布 artifact，消除主线双模型。" \
  -m "Constraint: 只有在 Next cutover、production smoke 和 npm legacy dist-tag 均确认后执行" \
  -m "Rejected: 继续重命名 legacy schema 和协议 | 会延长已退出生产代码的维护寿命" \
  -m "Confidence: medium" \
  -m "Scope-risk: broad" \
  -m "Directive: schema rollback 必须恢复迁移前备份" \
  -m "Tested: cutover audit; entry/business smoke; npm package preparation; test:phase1; build:packages"
```

---

### Task 9: 清理活动文档中的旧空间模型并补齐 Phase -1 证据

**Files:**
- Delete: `docs/superpowers/specs/2026-05-05-agentbean-network-isolation-design.md`
- Delete: `docs/superpowers/specs/2026-05-07-user-invite-network-sandbox-design.md`
- Delete: `docs/superpowers/specs/2026-05-09-multi-network-visibility-design.md`
- Modify: `README.md`
- Modify: `agentbean-next/docs/socket-protocol.md`
- Modify: `agentbean-next/docs/parity-backfill-audit.md`
- Modify: `agentbean-next/docs/post-flip-follow-up-status.md`
- Modify: `agentbean-next/docs/seventy-first-slice-status.md`
- Modify: `agentbean-next/docs/known-gaps.md`
- Modify: `agentbean-next/docs/verification-matrix.md`
- Modify: `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`

**Interfaces:**
- Consumes: Tasks 1-8 的最终 event、DTO、route、schema 和 deployment truth。
- Produces: 活动文档只描述 Team product contract；Phase -1 验收矩阵记录真实证据。

- [ ] **Step 1: 删除已被当前 PRD 取代的三份旧设计**

Run:

```bash
git rm \
  docs/superpowers/specs/2026-05-05-agentbean-network-isolation-design.md \
  docs/superpowers/specs/2026-05-07-user-invite-network-sandbox-design.md \
  docs/superpowers/specs/2026-05-09-multi-network-visibility-design.md
```

这些需求的有效产品规则已经进入主 PRD；Git history 仍保存原始决策记录。

- [ ] **Step 2: 用当前实现事实重写活动文档**

必须完成以下替换，而不是只做文案搜索替换：

- admin protocol 只列 `admin:list-teams` / `admin:delete-team`；
- App Router 只列 `[teamPath]` 与 `/:teamPath/teams`；
- artifact HTTP 只列 `/api/teams/:teamId/...`；
- browser storage 只列 `agentbean.teamPath`；
- schema 只列 Team snake_case columns；
- rollback 文档不再指向 `main` 内的 legacy source。

- [ ] **Step 3: 在 PI 设计的 Phase -1 下链接本计划和验收矩阵**

添加：

```markdown
- 独立实施计划：`docs/superpowers/plans/2026-07-10-agentbean-phase-minus-1-team-terminology.md`。
- 独立验收矩阵：`agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`。
```

- [ ] **Step 4: 执行活动文档扫描**

Run:

```bash
rg -n -i \
  'tailscale|networkId|networkName|networkPath|publishedNetworkIds|unpublishedNetworkIds|admin:list-networks|admin:delete-network|/api/networks|agentbean\.networkPath|\bnetworks\b|\bnetwork_id\b' \
  README.md agentbean-next/docs docs/superpowers/specs
```

Expected: zero matches。实施计划目录不属于产品文档门禁，因为计划需要记录被迁移的 source tokens。

- [ ] **Step 5: Commit**

```bash
git add README.md agentbean-next/docs docs/superpowers/specs
git commit -m "让活动文档只描述当前 Team 产品合同" \
  -m "删除已被主 PRD 取代的旧设计，并把协议、路由、持久化和回滚说明对齐到 Phase -1 实现。" \
  -m "Confidence: high" \
  -m "Scope-risk: moderate" \
  -m "Tested: active documentation terminology scan"
```

---

### Task 10: 建立 source/schema 术语静态门禁并接入 CI

**Files:**
- Create: `scripts/check-team-terminology.mjs`
- Create: `scripts/check-team-terminology.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci-cd.yml`

**Interfaces:**
- Consumes: Tasks 1-9 已清零的产品源码和活动文档。
- Produces: `npm run check:team-terminology`，PR 和 `main` push 都会运行。

- [ ] **Step 1: 写门禁自身的失败测试**

`scripts/check-team-terminology.test.mjs` 使用以下完整测试：

```js
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = new URL('./check-team-terminology.mjs', import.meta.url);
const cases = [
  ['field.ts', 'const payload = { networkId: "x" };'],
  ['event.ts', 'const event = "admin:list-networks";'],
  ['route.ts', 'const path = "/api/networks/x";'],
  ['schema.sql', 'CREATE TABLE networks (network_id TEXT);'],
  ['storage.ts', 'localStorage.setItem("agentbean.networkPath", "x");'],
  ['product.md', 'Tailscale is the collaboration boundary.'],
];

test('rejects every forbidden product-space token family', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbean-team-terminology-'));
  try {
    for (const [name, source] of cases) {
      const file = join(dir, name);
      writeFileSync(file, source);
      const result = spawnSync(process.execPath, [checker.pathname, file], { encoding: 'utf8' });
      assert.equal(result.status, 1, `${name} should fail: ${result.stdout}${result.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accepts canonical Team tokens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentbean-team-terminology-'));
  try {
    const file = join(dir, 'team.ts');
    writeFileSync(file, 'const team = { teamId: "t", teamPath: "ops", currentTeamId: "t" };');
    const result = spawnSync(process.execPath, [checker.pathname, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试并确认 checker 尚不存在**

Run: `node --test scripts/check-team-terminology.test.mjs`

Expected: FAIL with module not found。

- [ ] **Step 3: 实现精确 token checker**

`scripts/check-team-terminology.mjs` 使用以下完整实现：

```js
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const workspaceRoot = resolve(new URL('..', import.meta.url).pathname);
const defaultRoots = [
  'packages/contracts/src',
  'packages/contracts/tests',
  'apps/server-next/src',
  'apps/server-next/tests',
  'apps/web-next',
  'apps/daemon-next/src',
  'apps/daemon-next/tests',
  'scripts/check-agentbean-next-readiness.mjs',
  'scripts/smoke-agentbean-next-browser.mjs',
  'scripts/audit-agentbean-next-cutover.mjs',
  'scripts/check-agentbean-next-railway-preflight.mjs',
  'scripts/prepare-agentbean-next-daemon-release.mjs',
  '.github/workflows/ci-cd.yml',
  'package.json',
  'railway.json',
  'README.md',
  'agentbean-next/docs',
  'docs/superpowers/specs',
];

const rules = [
  ['product identifier', /network(?:Id|Name|Path)\b/gi],
  ['visibility identifier', /(?:published|unpublished)NetworkIds\b/g],
  ['admin identifier', /(?:list|delete)Networks?\b/g],
  ['Pascal/camel identifier', /Network(?:s|Id|Name|Path|Ids|Dialog)?\b/g],
  ['socket event', /\bnetwork:[a-z-]+/g],
  ['admin event', /admin:(?:list|delete)-networks/g],
  ['HTTP route', /\/api\/networks\b/g],
  ['browser key', /agentbean\.networkPath/g],
  ['resource/table', /\bnetworks\b/gi],
  ['schema column', /\bnetwork_id\b/g],
  ['schema column', /\bcurrent_network_id\b/g],
  ['schema column', /\bprimary_network_id\b/g],
  ['schema table', /\bnetwork_members\b/g],
  ['removed product dependency', /\bTailscale\b/gi],
];

const ignoredSegments = new Set(['.git', '.next', 'coverage', 'dist', 'node_modules']);
const releaseAAllowlist = new Set([
  'apps/web-next/lib/team-path.ts',
  'apps/web-next/tests/team-path.test.ts',
]);
const requestedRoots = process.argv.slice(2);
const scanRoots = (requestedRoots.length > 0 ? requestedRoots : defaultRoots)
  .map((entry) => resolve(workspaceRoot, entry));

function walk(entry) {
  if (!existsSync(entry)) throw new Error(`Terminology scan path does not exist: ${entry}`);
  const stat = statSync(entry);
  if (stat.isFile()) return [entry];
  return readdirSync(entry, { withFileTypes: true }).flatMap((dirent) => {
    if (dirent.isDirectory() && ignoredSegments.has(dirent.name)) return [];
    return walk(resolve(entry, dirent.name));
  });
}

const violations = [];
for (const file of scanRoots.flatMap(walk)) {
  const repoPath = relative(workspaceRoot, file).split(sep).join('/');
  if (requestedRoots.length === 0 && releaseAAllowlist.has(repoPath)) continue;
  if (/\.(png|jpe?g|gif|webp|ico|zip|sqlite|db|woff2?)$/i.test(file)) continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const [label, pattern] of rules) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) violations.push(`${repoPath}:${index + 1}:${label}: ${line.trim()}`);
    }
  });
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(`Team terminology check passed (${scanRoots.length} roots).`);
```

Release A 期间只允许以下两个文件，不允许目录级 allowlist：

- `apps/web-next/lib/team-path.ts`
- `apps/web-next/tests/team-path.test.ts`

输出必须包含 `file:line:rule`，发现一处即最终 exit 1。

- [ ] **Step 4: 接入 root scripts 和 CI**

`package.json`：

```json
{
  "scripts": {
    "check:team-terminology": "node scripts/check-team-terminology.mjs",
    "test:team-terminology": "node --test scripts/check-team-terminology.test.mjs"
  }
}
```

`.github/workflows/ci-cd.yml` 的 AgentBean Next validation 在 build 前运行：

```yaml
- name: Enforce Team terminology
  run: |
    npm run test:team-terminology
    npm run check:team-terminology
```

- [ ] **Step 5: 运行 checker tests 和真实 repo scan**

Run:

```bash
npm run test:team-terminology
npm run check:team-terminology
```

Expected: tests PASS，真实 repo scan exit 0。

- [ ] **Step 6: Commit**

```bash
git add scripts/check-team-terminology.mjs scripts/check-team-terminology.test.mjs package.json .github/workflows/ci-cd.yml
git commit -m "防止旧空间模型重新进入 AgentBean 主线" \
  -m "新增精确 token 静态门禁并接入 CI，覆盖 contracts、Server、Web、Device、schema、tests 和活动文档。" \
  -m "Constraint: 通用 networking 描述不属于产品空间术语" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: terminology checker unit tests; full repository terminology scan"
```

---

### Task 11: Release A、迁移观察、Release B 清理与 Phase -1 收口

**Files:**
- Modify: `apps/web-next/lib/team-path.ts`
- Modify: `apps/web-next/tests/team-path.test.ts`
- Modify: `scripts/check-team-terminology.mjs`
- Modify: `agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md`
- Modify: `agentbean-next/docs/production-cutover-runbook.md`

**Interfaces:**
- Consumes: Tasks 1-10 的全部产物。
- Produces: 两阶段生产发布证据；Release B 后零兼容读取和零 allowlist，Phase -1 才算完成。

- [ ] **Step 1: 执行 Release A 前完整本地验证**

Run:

```bash
npm run test:contracts
npm run test:domain
npm run test:server-next -- --api.host 127.0.0.1
npm run test:daemon-next -- --api.host 127.0.0.1
npm run test:web-next -- --api.host 127.0.0.1
npm run test:team-terminology
npm run check:team-terminology
npm run build:contracts
npm run build:domain
npm run build:server-next
npm run build:daemon-next
npm run build:web-next
npm run check:agentbean-next-readiness
npm run smoke:agentbean-next-persistence
npm run smoke:agentbean-next-browser
```

Expected: 全部 exit 0；任何失败都必须在 Release A 前修复。

- [ ] **Step 2: 备份生产 SQLite 并发布 Release A**

发布前记录 global DB backup 路径、size、SHA256 和创建时间。发布后验证：

- Team create/switch/delete/fallback；
- Device invite、连接、scan、rename；
- Artifact multipart upload、preview、download；
- admin teams/devices/agents；
- 重启后的 session/current Team 恢复；
- `device_revocations` 行数和连接拒绝行为未回退。

Expected: post-deploy `main` CI、Deploy production、Publish agent to npm、production smoke 全绿。

- [ ] **Step 3: 保留 Release A 7 天观察窗口**

观察以下信号：

- 旧 Team path 用户是否能首次打开并自动迁移；
- login/device-login redirect 404；
- artifact upload 404/403；
- admin DTO rendering error；
- SQLite migration error；
- 已撤销 Device 重新连接。

任何 revocation 数据异常立即恢复 global DB backup 并回滚 deployment。

- [ ] **Step 4: 写 Release B 的失败测试，要求不再读取旧键**

把 `team-path.test.ts` 改为：

```ts
test('ignores removed legacy storage keys', () => {
  const legacyKey = ['agentbean', 'networkPath'].join('.');
  const storage = new MemoryStorage({ [legacyKey]: 'stale-team' });

  expect(readStoredTeamPath(storage)).toBeNull();
  expect(storage.getItem('agentbean.teamPath')).toBeNull();
});
```

Run: `cd apps/web-next && npm run test -- tests/team-path.test.ts --api.host 127.0.0.1`

Expected: FAIL，Release A helper 仍迁移旧键。

- [ ] **Step 5: 删除旧键读取分支和静态门禁 allowlist**

Release B 的 `readStoredTeamPath()` 只读取新键：

```ts
const TEAM_PATH_KEY = 'agentbean.teamPath';

export function readStoredTeamPath(storage: StorageLike): string | null {
  return storage.getItem(TEAM_PATH_KEY);
}

export function writeStoredTeamPath(storage: StorageLike, teamPath: string): void {
  storage.setItem(TEAM_PATH_KEY, teamPath);
}
```

删除 checker 对 `team-path.ts` 和 `team-path.test.ts` 的 allowlist；重新运行 `npm run check:team-terminology` 必须零结果。

- [ ] **Step 6: 运行 Release B 完整验证并发布**

重复 Task 11 Step 1 的全部命令。

Expected: 全绿；browser smoke 只写新键；活动源码、schema、tests 和活动文档零匹配。

- [ ] **Step 7: 更新验收矩阵为 Green 并记录 production evidence**

对 `P-1-01` 至 `P-1-16` 写入：commit SHA、CI run URL、production deploy、browser smoke、DB backup/upgrade 校验和 npm dist-tag 查询证据。没有证据的行保持未完成，不能把 Phase -1 标记 Green。

- [ ] **Step 8: Commit Release B cleanup**

```bash
git add apps/web-next/lib/team-path.ts apps/web-next/tests/team-path.test.ts scripts/check-team-terminology.mjs agentbean-next/docs/phase-minus-1-team-terminology-verification-matrix.md agentbean-next/docs/production-cutover-runbook.md
git commit -m "结束 Team path 的一次性浏览器迁移窗口" \
  -m "观察窗口完成后删除旧键读取和 checker allowlist，使 Phase -1 最终状态不再保留兼容入口。" \
  -m "Constraint: Release A 已稳定运行 7 天" \
  -m "Confidence: high" \
  -m "Scope-risk: narrow" \
  -m "Tested: full Phase -1 verification matrix and production smoke"
```

---

## Execution Order and Review Gates

1. Tasks 1-3 可以分别 review，但必须先于 Web 字段删除。
2. Tasks 4-7 在同一 release branch 完成；Task 2 Server DTO 与 Task 4 Web consumer 不得拆成两个生产 deploy。
3. Task 8 是 broad-risk gate；只有 Next production、npm canonical/legacy truth 和 rollback runbook 都确认后才能执行。
4. Task 9 必须基于实现后的真实字段和路由更新，不能提前猜测。
5. Task 10 只能在旧术语基本清零后合入，否则 checker 会形成长期 allowlist。
6. Task 11 分 Release A 与 Release B；Phase -1 在 Release B 和 production verification 之前保持 `in_progress`。
7. Phase -1 Green 后才能编写 Phase 0 的独立实施计划。

## Out of Scope

- PI SDK 选型、SEA 打包验证和 wrapper。
- Device Service 后台宿主。
- PI Manager 调用外部 Agent。
- Task 自动分解、认领和 DAG。
- 跨 Agent Memory。
- 修改 `agent_publications` 的可见性语义。
- 通用 Socket/HTTP networking error 文案。

## Self-Review Checklist

- [ ] Spec coverage：Phase -1 的文档、contracts、Server/Web/Device、routes、storage、schema、CI 和 smoke 均有对应 task。
- [ ] Placeholder scan：计划中不存在占位项、空泛“补测试”或未定义接口。
- [ ] Type consistency：所有 downstream tasks 使用 `teamId/teamPath/primaryTeamId/visibleTeamIds/currentTeamId`。
- [ ] Migration safety：没有修改已应用 migration；revocation upgrade 保留 `NULL profile_id` 和所有行。
- [ ] Atomicity：Server DTO 删除与 Web consumer 修改在同一 Release A。
- [ ] Rollback：schema rollback 使用 backup，应用 rollback 使用 Railway/Git，Device rollback 使用 npm `legacy`。
- [ ] Completion truth：Release B 删除一次性旧键读取和 checker allowlist 后才标记 Phase -1 Green。
