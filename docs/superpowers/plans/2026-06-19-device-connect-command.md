# 设备 connectCommand 实施计划（方案 D：deviceHello 反查 invite）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 让 apps/web 设备详情页显示 device 的「连接命令」（首次接入时的 invite command，历史参考）。device 加 `connect_command` 列；`deviceHello` 首次创建 device 时反查 completed invite（machineId+profileId）拿 code → `buildDeviceInviteCommand` → 存；`toDeviceDto` 返回。apps/web UI（`:546-551`）早预留，零改动。

**Architecture:** 方案 D。connectCommand = 首次接入 invite 命令（一次性 code 已 used，作历史参考）。时序难点:command 需 invite code,但 device 在 `deviceHello` 创建（用 token,无 code）。解法:`deviceHello` 首次创建时反查 completed invite（同 machineId+profileId）拿 code,重新 `buildDeviceInviteCommand`(确定性,与 createDeviceInvite 时一致)存 device。

**Tech Stack:** TypeScript、server-next（SQLite migration + vitest）、contracts、apps/web。

---

## 背景

设备详情对等性最后一个子项（S1 改名删除 / S2a systemInfo 富 / S2b daemonVersionInfo 已合并）。apps/web `devices/page.tsx:546-551` 早渲染 `device.connectCommand` + 复制按钮,但 server-next 不提供。

**语义**:已接入设备的 invite code 已 used,connectCommand 是首次接入的历史命令(用户复制不能重新接入,仅参考)。apps/web 用 `{device.connectCommand ? <显示+复制> : ...}` 守卫。

## 范围

**纳入：**
- **migration**：global `0005_device_connect_command.sql`（device 加 `connect_command` 列）。
- **contracts**：`DeviceDto` 加 `connectCommand?`。
- **repository**：`DeviceRecord` 加 `connectCommand?`；`devices.upsertHello` 写 `connect_command`、`mapDevice` 读；`deviceInvites.findCompletedByMachineProfile`（接口+sqlite+memory）；`toDeviceDto` 返回 `connectCommand`。
- **usecase**：`deviceHello` 首次创建时反查 completed invite → `buildDeviceInviteCommand` → 存 `connectCommand`。
- **apps/web**：确认零改动（`:546-551` 早预留）。
- 测试：deviceInvites 反查单测、deviceHello 反查单测、端到端（接入 → getDevice connectCommand）。

**不纳入**：实时重新生成 invite（用户要重新接入应走 createDeviceInvite）；S3 select-directory。

## 关键约束（实现者必读）

1. **首次创建才反查**：`deviceHello` 里 `existing = findByMachineProfile(...)`。仅 `!existing`（首次创建）且无已存 connectCommand 时反查 invite。重连（existing）保留 `existing.connectCommand`,不重新查。
2. **command 确定性**：`buildDeviceInviteCommand(code, profile)` 纯函数,同 code+profile 同输出。反查 invite 拿 code 重新 build = createDeviceInvite 时生成的一致。
3. **关联键**：反查 completed invite by `teamId + machineId + profileId`(deviceHello 的 token credentials 来自 completed invite,键匹配)。`machineId`/`profileId` 可选,任一 undefined 时反查可能无结果 → connectCommand undefined(可接受,UI 守卫不显示)。
4. **profile fallback**：`buildDeviceInviteCommand(code, invite.profileId ?? team.path)`(与 createDeviceInvite `:964` 一致)。deviceHello 反查时用 `teams.getById(teamId)` 拿 team.path。
5. **apps/web 早预留**：`:546-551` + `:313` 类型早有 connectCommand,零改动。

## File Structure

- **新增** `apps/server-next/src/infra/sqlite/migrations/global/0005_device_connect_command.sql`。
- **修改** `apps/server-next/src/infra/sqlite/repositories.ts`：注册 migration(`:44` 后)、`mapDevice` 读 connect_command、`upsertHello` 写、deviceInvites `findCompletedByMachineProfile`。
- **修改** `apps/server-next/src/infra/memory/repositories.ts`：deviceInvites `findCompletedByMachineProfile`、devices upsertHello/mapDevice 透传 connectCommand。
- **修改** `apps/server-next/src/application/repositories.ts`：`DeviceRecord` 加 `connectCommand?`、`DeviceInviteRepository` 加 `findCompletedByMachineProfile`。
- **修改** `packages/contracts/src/device.ts`：`DeviceDto` 加 `connectCommand?`。
- **修改** `apps/server-next/src/application/usecases.ts`：`toDeviceDto` 返回 connectCommand、`deviceHello` 反查逻辑。
- **修改** `apps/server-next/tests/device-repository.test.ts` 或新建：反查单测。
- **修改** `apps/server-next/tests/device-management.test.ts`：端到端。
- **可能** `apps/web/`：仅确认。

---

## Task 1：migration + DeviceRecord + contracts connectCommand

**Files:**
- Create: `apps/server-next/src/infra/sqlite/migrations/global/0005_device_connect_command.sql`
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（注册 + mapDevice）
- Modify: `apps/server-next/src/application/repositories.ts`（DeviceRecord）
- Modify: `packages/contracts/src/device.ts`（DeviceDto）

- [ ] **Step 1：migration 文件**

新建 `migrations/global/0005_device_connect_command.sql`：

```sql
ALTER TABLE devices ADD COLUMN connect_command TEXT;
```

- [ ] **Step 2：注册 migration**

`infra/sqlite/repositories.ts:44`（`applyMigration(db, 'global/0004_join_links.sql');`）后加：

```ts
  applyMigration(db, 'global/0005_device_connect_command.sql');
```

- [ ] **Step 3：mapDevice 读 connect_command**

`mapDevice`（约 `:1617-1636`）加 `connectCommand: sqliteNullableText(row, 'connect_command')`（与 daemonVersion/systemInfo 同区）。

- [ ] **Step 4：DeviceRecord 加字段**

`application/repositories.ts:85` 的 `DeviceRecord` 加 `connectCommand?: string;`。

- [ ] **Step 5：contracts DeviceDto 加字段**

`packages/contracts/src/device.ts` 的 `DeviceDto` 加 `connectCommand?: string;`（`daemonUpdateAvailable?` 后、`lastSeenAt?` 前）。

- [ ] **Step 6：类型检查**
Run: `npm --workspace @agentbean/contracts run build && npx tsc -p apps/server-next/tsconfig.json --noEmit`
Expected: 通过。

- [ ] **Step 7：提交**
```bash
git add apps/server-next/src/infra/sqlite/migrations/global/0005_device_connect_command.sql apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/application/repositories.ts packages/contracts/src/device.ts
git commit -m "feat(server-next): devices 表加 connect_command 列 + DeviceRecord/DeviceDto connectCommand

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2：deviceInvites.findCompletedByMachineProfile + 测试

**Files:**
- Modify: `application/repositories.ts`（DeviceInviteRepository 接口）
- Modify: `infra/sqlite/repositories.ts`（deviceInvites 实现）
- Modify: `infra/memory/repositories.ts`（deviceInvites 实现）
- Test: `apps/server-next/tests/device-repository.test.ts`（或新建 invite-repo 测试）

- [ ] **Step 1：写失败测试**

在 `device-repository.test.ts`（或新建 `device-invite-repository.test.ts`）加：

```ts
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('deviceInvites repository', () => {
  test('findCompletedByMachineProfile returns the completed invite', async () => {
    const repos = createInMemoryRepositories();
    const created = await repos.deviceInvites.create({
      id: 'inv-1', code: 'CODE1', teamId: 'team-1', createdBy: 'user-1',
      createdAt: 1000, machineId: 'mac-1', profileId: 'default',
    });
    await repos.deviceInvites.updateWaiter({ code: 'CODE1', machineId: 'mac-1', profileId: 'default', hostname: 'mac' });
    await repos.deviceInvites.complete({ code: 'CODE1', completedAt: 2000 });

    const found = await repos.deviceInvites.findCompletedByMachineProfile({
      teamId: 'team-1', machineId: 'mac-1', profileId: 'default',
    });
    expect(found?.code).toBe('CODE1');
    expect(found?.completedAt).toBe(2000);
  });

  test('findCompletedByMachineProfile returns null when no completed match', async () => {
    const repos = createInMemoryRepositories();
    const found = await repos.deviceInvites.findCompletedByMachineProfile({
      teamId: 'team-1', machineId: 'mac-x', profileId: 'default',
    });
    expect(found).toBeNull();
  });
});
```

- [ ] **Step 2：跑测试确认失败**
Run: `npm --workspace @agentbean/server-next test -- device-repository`（或 device-invite-repository）
Expected: FAIL（方法不存在）。

- [ ] **Step 3：加接口签名**

`application/repositories.ts` 的 `DeviceInviteRepository`（`:134-144`）加：

```ts
  findCompletedByMachineProfile(input: { teamId: ID; machineId?: string; profileId?: string }): Promise<DeviceInviteRecord | null>;
```

- [ ] **Step 4：sqlite 实现**

`infra/sqlite/repositories.ts` 的 deviceInvites（grep `deviceInvites: {` 定位，约 `:353`）加：

```ts
      async findCompletedByMachineProfile(input) {
        const rows = globalDb
          .prepare(
            `SELECT * FROM device_invites
             WHERE team_id = ? AND completed_at IS NOT NULL
             AND (? IS NULL OR machine_id IS ?)
             AND (? IS NULL OR profile_id IS ?)
             ORDER BY completed_at DESC LIMIT 1`,
          )
          .all(input.teamId, input.machineId ?? null, input.machineId ?? null, input.profileId ?? null, input.profileId ?? null);
        return rows.length > 0 ? mapDeviceInvite(rows[0]) : null;
      },
```

> `mapDeviceInvite` 是文件内已有 helper（`:1572`）。先读 deviceInvites 现有方法（getByCode/complete）的 SQL 风格 + mapDeviceInvite 用法,照它写。`(? IS NULL OR machine_id IS ?)` 处理 machineId undefined（不强制匹配）。先读确认 device_invites 列名（machine_id/profile_id/completed_at）。

- [ ] **Step 5：memory 实现**

`infra/memory/repositories.ts` 的 deviceInvites 加（先 grep deviceInvites Map 变量名）：

```ts
      async findCompletedByMachineProfile(input) {
        const matches = Array.from(deviceInvites.values())
          .filter((invite) =>
            invite.teamId === input.teamId &&
            invite.completedAt !== undefined &&
            (input.machineId === undefined || invite.machineId === input.machineId) &&
            (input.profileId === undefined || invite.profileId === input.profileId),
          )
          .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
        return matches[0] ?? null;
      },
```

> 先 grep memory 的 deviceInvites Map 变量名（如 `deviceInvites`/`invites`）。

- [ ] **Step 6：跑测试确认通过**
Run: `npm --workspace @agentbean/server-next test -- device-repository`
Expected: PASS。

- [ ] **Step 7：提交**
```bash
git add apps/server-next/src/application/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/tests/device-repository.test.ts
git commit -m "feat(server-next): deviceInvites findCompletedByMachineProfile

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3：upsertHello 写 + toDeviceDto 返回 connectCommand

**Files:**
- Modify: `infra/sqlite/repositories.ts`（upsertHello 写 connect_command）
- Modify: `infra/memory/repositories.ts`（upsertHello 透传）
- Modify: `application/usecases.ts`（toDeviceDto 返回）

- [ ] **Step 1：sqlite upsertHello 写 connect_command**

`infra/sqlite/repositories.ts` 的 `devices.upsertHello`（`:575-608`）。在 INSERT 列 + ON CONFLICT UPDATE 加 connect_command:

INSERT 列加 `connect_command`（与 daemon_version/system_info 同区）,VALUES 加 `?`,ON CONFLICT 加 `connect_command = excluded.connect_command`,`.run(...)` 参数加 `device.connectCommand ?? null`。

> 先读 upsertHello 现有结构（列/VALUES/ON CONFLICT/参数顺序）,照它加 connect_command 一致。

- [ ] **Step 2：memory upsertHello 透传**

`infra/memory/repositories.ts` 的 `devices.upsertHello`（`:328`）：`devices.set(input.id, input)` 已透传整个 input(含 connectCommand)。确认 DeviceRecord 含 connectCommand（Task 1 加了）→ 自动透传。**可能无需改**（memory set 整个对象）。核查确认。

- [ ] **Step 3：toDeviceDto 返回 connectCommand**

`application/usecases.ts` 的 `toDeviceDto`（`:2984`）加 `connectCommand: device.connectCommand,`（与 daemonUpdateAvailable 同区）。

- [ ] **Step 4：类型检查 + server 全套**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit && npm --workspace @agentbean/server-next test`
Expected: tsc 通过,测试绿。

- [ ] **Step 5：提交**
```bash
git add apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/src/application/usecases.ts
git commit -m "feat(server-next): upsertHello 存 connect_command + toDeviceDto 返回

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4：deviceHello 反查 invite build command 存

**Files:** `apps/server-next/src/application/usecases.ts`（deviceHello `:1066`）

- [ ] **Step 1：deviceHello 首次创建反查**

`deviceHello`（`:1066`）。import `buildDeviceInviteCommand`（文件顶部,已 import 见 `:5`）。

在 `const existing = ...findByMachineProfile...`（`:1072-1075`）后、`upsertHello`（`:1076`）前,加反查逻辑：

```ts
      const existing =
        deviceInput.machineId && deviceInput.profileId
          ? await repositories.devices.findByMachineProfile(deviceInput.machineId, deviceInput.profileId)
          : null;

      let connectCommand = existing?.connectCommand;
      if (!existing && connectCommand === undefined && (deviceInput.machineId || deviceInput.profileId)) {
        const invite = await repositories.deviceInvites.findCompletedByMachineProfile({
          teamId: deviceInput.teamId,
          machineId: deviceInput.machineId,
          profileId: deviceInput.profileId,
        });
        if (invite) {
          const team = await repositories.teams.getById(deviceInput.teamId);
          connectCommand = buildDeviceInviteCommand(invite.code, invite.profileId ?? team?.path);
        }
      }

      const device = await repositories.devices.upsertHello({
        id: existing?.id ?? ids.nextId(),
        teamId: deviceInput.teamId,
        ownerId: deviceInput.ownerId,
        status: 'online',
        name: deviceInput.hostname,
        machineId: deviceInput.machineId,
        profileId: deviceInput.profileId,
        daemonVersion: deviceInput.daemonVersion,
        systemInfo: deviceInput.systemInfo,
        connectCommand,
        lastSeenAt: now,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
```

> `buildDeviceInviteCommand` 已 import（`:5`）。`existing?.connectCommand`(重连保留) → 首次 `!existing` 反查 invite → build command。反查无结果 connectCommand 保持 undefined(UI 守卫不显示)。

- [ ] **Step 2：类型检查 + server 全套**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit && npm --workspace @agentbean/server-next test`
Expected: 通过。

- [ ] **Step 3：提交**
```bash
git add apps/server-next/src/application/usecases.ts
git commit -m "feat(server-next): deviceHello 首次创建反查 invite 生成 connectCommand

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5：端到端测试（接入 → getDevice connectCommand）

**Files:** `apps/server-next/tests/device-management.test.ts`

- [ ] **Step 1：加端到端用例**

完整接入流程:createDeviceInvite(web) → waitForDeviceInvite(agent) → completeDeviceInvite(web) → deviceHello(agent, credentials) → getDevice 断言 connectCommand。

```ts
  test('device connectCommand surfaces after invite-based onboarding', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'invite-1', 'device-1']),
    });
    const { baseUrl } = await startSocketServer(app);
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agent.disconnect(); });

    // 注册 + 建 device invite
    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'T' });
    const inviteAck = await web.emitWithAck(WEB_EVENTS.deviceInvite.create, { teamId: 'team-1', profileId: 'default' });
    expect(inviteAck.ok).toBe(true);
    const code = (inviteAck as any).invite.code;

    // daemon wait + complete（拿 credentials）
    const waitAck = await agent.emitWithAck(AGENT_EVENTS.deviceInvite.wait, { code, machineId: 'mac-1', profileId: 'default', hostname: 'mac' });
    const completeAck = await web.emitWithAck(WEB_EVENTS.deviceInvite.complete, { code });
    const token = (completeAck as any).credentials.token;

    // daemon hello（用 credentials token）
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1', ownerId: 'user-1', machineId: 'mac-1', profileId: 'default', hostname: 'mac',
      daemonVersion: '0.2.1', systemInfo: { hostname: 'mac', platform: 'darwin', arch: 'arm64', daemonVersion: '0.2.1' },
    });

    // getDevice 断言 connectCommand
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({ ok: true });
    expect((got as any).device.connectCommand).toEqual(expect.stringContaining('npx @agentbean/daemon'));
    expect((got as any).device.connectCommand).toContain(code);
  });
```

> **先读 device-management.test.ts 现有用例 + WEB_EVENTS/AGENT_EVENTS 常量名 + 接入流程的实际事件名**。上面是骨架——deviceInvite.create/wait/complete 的真实事件名 + payload 字段以 contracts `WEB_EVENTS.deviceInvite.*` / `AGENT_EVENTS.deviceInvite.*` 为准（grep 确认）。`deviceId: 'device-1'` = createIds 顺序。authenticated session 模式照现有用例。

- [ ] **Step 2：跑测试**
Run: `npm --workspace @agentbean/server-next test -- device-management`
Expected: PASS。若 connectCommand undefined:查反查 invite（machineId/profileId 匹配）+ deviceHello 反查逻辑。

- [ ] **Step 3：server 全套**
Run: `npm --workspace @agentbean/server-next test`
Expected: 全绿。

- [ ] **Step 4：提交**
```bash
git add apps/server-next/tests/device-management.test.ts
git commit -m "test(server-next): device connectCommand 接入端到端

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6：apps/web 确认（预期零改动）

**Files:** 可能 `apps/web/app/[networkPath]/devices/page.tsx`（仅确认）

- [ ] **Step 1：核查**

读 `devices/page.tsx:546-551`（connectCommand 显示+复制）+ `:313`（类型）。确认已读 `device.connectCommand`。**应已存在**。server 返回 connectCommand 后自动显示。**预期零改动**。

- [ ] **Step 2：apps/web 类型检查 + 测试**
Run: `npx tsc -p apps/web/tsconfig.json --noEmit && npm --workspace agentbean-web test`
Expected: tsc 通过（预先存在 socket.test:240 error 非 slice 引入）,测试绿。

- [ ] **Step 3：有改动提交,否则跳过**

---

## 明确不在本计划范围

- **实时重新生成 invite**：用户要重新接入应走 createDeviceInvite(新 code)。本 slice 只存首次接入历史命令。
- **S3 select-directory**：device:select-directory（需 daemon 目录交互方案），单独。

## Self-Review

1. **Spec 覆盖**：connectCommand = 首次接入 invite 命令。migration+Record+contracts(Task 1) → deviceInvites 反查(Task 2) → upsertHello+toDeviceDto(Task 3) → deviceHello 反查(Task 4) → 端到端(Task 5) → apps/web(Task 6)。✅
2. **占位符**：每步完整代码 + 命令；少数「先读现有结构/确认事件名」给核实方法。✅
3. **一致性**：
   - connectCommand：deviceHello 反查 invite → buildDeviceInviteCommand → 存 device.connect_command → toDeviceDto → apps/web。与 createDeviceInvite 的 command 生成一致(同 buildDeviceInviteCommand)。✅
   - 反查键：teamId + machineId + profileId(device hello token ↔ completed invite)。✅
   - 重连保留：existing.connectCommand(不重新查)。✅
4. **顺序**：Task 1(migration+类型) → 2(反查方法) → 3(存/返回) → 4(deviceHello 反查) → 5(端到端) → 6(apps/web)。✅
5. **apps/web 零改动**：`:546-551` 早预留。✅
6. **语义边界**：connectCommand 是历史(已 used),不重新生成。✅
