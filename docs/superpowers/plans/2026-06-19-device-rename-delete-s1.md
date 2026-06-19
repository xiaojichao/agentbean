# 设备改名 + 删除实施计划（S1，纯 server 端）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 在 server-next 实现 `device:rename` 与 `device:delete` 两个事件（apps/web 设备页已在发但 server 无 handler），使 apps/web 的设备改名、删除功能端到端可用。

**Architecture:** 纯 server-next 改动（contracts + repository + usecase + socket handler）+ apps/web 的 payload 适配（rename/delete 现发 `{id}`，对齐 server 的 `{deviceId}`，即 D2 类 gap）。`device:rename`/`device:delete` 是纯 server 操作（不像 `device:scan`/`select-directory` 需转发 daemon）。删除按 `device_id` 级联清理 `device_runtimes` + `agents`。

**Tech Stack:** TypeScript、server-next（Express + Socket.IO + SQLite/better-sqlite3 + 内存 repo 双实现）、vitest。contracts 共享包 `@agentbean/contracts`。

---

## 背景

这是「补齐 apps/web 设备详情页对接 server-next 缺口」3 个独立 slice 中的 **S1**（诊断见对话上下文，根因：apps/web 触发 `device:rename`/`delete` 但 server-next 无 handler、contracts 无定义）。

- **S1（本计划）**：设备改名 + 删除。纯 server + apps/web payload 适配。零不确定性。
- S2（后续）：DeviceDetail 富字段（daemon 版本 / systemInfo），跨 daemon/server。
- S3（后续）：目录选择器 `device:select-directory`，需先定 daemon 端目录交互方案。

## 范围

**纳入：**
- `contracts`：新增 `WEB_EVENTS.device.rename` / `delete` 常量。
- `server-next`：repository `devices.updateName` / `delete`（接口 + sqlite + memory）、usecase `renameDevice` / `deleteDevice`、socket handler bind。
- `apps/web`：`deviceEvents.rename` / `delete` 的 payload 从 `{id}` 改为 `{deviceId: id}`（并从硬编码字符串迁到 `WEB_EVENTS.device.*` 常量）。
- 测试：memory repo 单元、socket handler wiring（mock）、端到端（真实 socket）、apps/web payload。

**不纳入（S2/S3）：** daemon 版本/系统信息字段、目录选择器、connectCommand、设备维度 workspace。

## 关键约束（实现者必读）

1. **D2 payload 适配**：server usecase 入参用 `deviceId`（与 `getDevice` 一致，`usecases.ts:1170`）。apps/web 当前 `rename`/`delete` 发 `{id}`（`apps/web/lib/socket.ts:444-447`），必须改成 `{deviceId: id}`，否则 server 收到 `deviceId: undefined` → `NOT_FOUND`。
2. **权限**：沿用 `getDevice` 的校验——调用方必须是 device 所在 team 的成员（`repositories.teams.isMember`）。本计划用 team 成员即可（与 getDevice 一致）；如需收紧到 owner/admin，后续单独迭代。
3. **delete 级联**：删 device 必须同步清 `device_runtimes`（`device_id`）和 `agents`（`device_id`），否则残留孤儿数据。
4. **`socket-handlers.test.ts:76-95` 的 `eventNames()` 精确断言**：加 bind 后必须同步更新这个数组，否则测试红。这是最易漏点。
5. **双 repo 实现**：每个 repository 方法都要同时加到 sqlite 和 memory 实现，并改 `ServerNextRepositories` 接口（`application/repositories.ts`）。

## File Structure

- **修改** `packages/contracts/src/socket.ts`（`WEB_EVENTS.device`，`:28-35`）：加 `rename`/`delete` 常量。
- **修改** `apps/server-next/src/application/repositories.ts`（`ServerNextRepositories.devices`）：加 `updateName`/`delete` 方法签名。
- **修改** `apps/server-next/src/infra/sqlite/repositories.ts`（`devices`，`:574-654`）：加 `updateName`/`delete` 实现。
- **修改** `apps/server-next/src/infra/memory/repositories.ts`（`devices`，`:327-358`）：加 `updateName`/`delete` 实现。
- **修改** `apps/server-next/src/application/usecases.ts`：`ServerNextUseCases` 接口（device 区，约 `:55`）加 `renameDevice`/`deleteDevice` 签名；实现（device 区，`deviceHello` 约 `:1107` 之后）加两个方法。
- **修改** `apps/server-next/src/transport/socket-handlers.ts`（device bind 区，`:80-88`）：加 2 个 `bind`。
- **修改** `apps/server-next/tests/socket-handlers.test.ts`：mock app 加 2 个方法、`eventNames` 数组加 2 项、加 trigger/断言。
- **新增/修改** `apps/server-next/tests/device-management.test.ts`（端到端，仿 `socket-integration.test.ts:39-90` setup）。
- **修改** `apps/web/lib/socket.ts`（`:444-447`）：rename/delete 发 `{deviceId: id}` 并用常量。
- **修改** `apps/web/tests/socket.test.ts`：加 rename/delete payload 用例（仿 `:137-142` 的 device:get 用例）。

行号是「现状」锚点，以函数/符号名定位为准。

---

## Task 1：contracts 加 device:rename / device:delete 常量

**Files:**
- Modify: `packages/contracts/src/socket.ts`（`WEB_EVENTS.device`，当前 `:28-35`）

- [ ] **Step 1：加常量**

在 `WEB_EVENTS.device` 对象里（`socket.ts:28-35`，`agentsList: 'device:agents:list',` 那一行之后）加：

```ts
    rename: 'device:rename',
    delete: 'device:delete',
```

改完后该对象应为：

```ts
  device: {
    list: 'device:list',
    get: 'device:get',
    scan: 'device:scan',
    snapshot: 'devices:snapshot',
    status: 'device:status',
    runtimes: 'device:runtimes',
    agentsList: 'device:agents:list',
    rename: 'device:rename',
    delete: 'device:delete',
  },
```

- [ ] **Step 2：类型检查（验证常量可用）**

Run: `npm --workspace @agentbean/contracts run build` （若无 build 脚本，用 `npx tsc -p packages/contracts/tsconfig.json --noEmit`）
Expected: 编译通过，无错误。

- [ ] **Step 3：提交**

```bash
git add packages/contracts/src/socket.ts
git commit -m "feat(contracts): 新增 device:rename / device:delete 事件常量

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2：repository devices.updateName（sqlite + memory + 接口）

**Files:**
- Modify: `apps/server-next/src/application/repositories.ts`（`ServerNextRepositories.devices` 接口）
- Modify: `apps/server-next/src/infra/sqlite/repositories.ts`（devices，`:632` `markOffline` 之后）
- Modify: `apps/server-next/src/infra/memory/repositories.ts`（devices，`:345` `markOffline` 之后）
- Test: `apps/server-next/tests/sqlite-repositories.test.ts` + memory 单元测试

- [ ] **Step 1：写失败测试（memory repo 单元）**

新建 `apps/server-next/tests/device-repository.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('devices repository', () => {
  test('updateName renames device and returns updated record', async () => {
    const repos = createInMemoryRepositories({ now: () => 1000, ids: createIds() });
    const created = await repos.devices.upsertHello({
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      status: 'online',
      name: 'old-name',
      machineId: 'm-1',
      profileId: 'default',
      daemonVersion: null,
      systemInfo: undefined,
      lastSeenAt: 1000,
      createdAt: 1000,
      updatedAt: 1000,
    });

    const updated = await repos.devices.updateName({ deviceId: 'device-1', hostname: 'new-name', updatedAt: 2000 });

    expect(updated?.name).toBe('new-name');
    expect(updated?.updatedAt).toBe(2000);
    expect((await repos.devices.getById('device-1'))?.name).toBe('new-name');
  });

  test('updateName returns null when device missing', async () => {
    const repos = createInMemoryRepositories({ now: () => 1000, ids: createIds() });
    const updated = await repos.devices.updateName({ deviceId: 'missing', hostname: 'x', updatedAt: 1000 });
    expect(updated).toBeNull();
  });
});
```

> `createIds` 辅助：若 `createInMemoryRepositories` 的 `ids` 参数有现成工厂/测试 helper（查 `socket-integration.test.ts` 里的 `createIds` 用法），沿用之；否则用递增计数器：`const createIds = (prefix = 'id') => { let n = 0; return { nextId: () => `${prefix}-${++n}` }; }`。实现前先 grep 确认 `createInMemoryRepositories` 的入参签名（`now`/`ids` 是否必需、`createIds` 是否已存在）。

- [ ] **Step 2：运行测试，确认失败**

Run: `npm --workspace @agentbean/server-next test -- device-repository`
Expected: FAIL，`repos.devices.updateName is not a function`。

- [ ] **Step 3：加接口签名**

在 `application/repositories.ts` 的 `ServerNextRepositories.devices` 接口里（与 `markOffline` 同区，先 grep `markOffline(input` 定位接口位置）加：

```ts
    updateName(input: { deviceId: string; hostname: string; updatedAt: number }): Promise<DeviceRecord | null>;
```

- [ ] **Step 4：sqlite 实现**

在 `infra/sqlite/repositories.ts` 的 `devices.markOffline` 方法之后（`:653` 闭括号后）加：

```ts
      async updateName(input) {
        const result = globalDb
          .prepare('UPDATE devices SET hostname = ?, updated_at = ? WHERE id = ?')
          .run(input.hostname, input.updatedAt, input.deviceId);
        if (sqliteChanges(result) === 0) return null;
        return mapDevice(globalDb.prepare('SELECT * FROM devices WHERE id = ?').get(input.deviceId));
      },
```

> `sqliteChanges` 与 `mapDevice` 是文件内已有 helper（`markOffline`/`getById` 已用）。若 `sqliteChanges` 不存在，用 `result.changes`（better-sqlite3 RunResult API）；先 grep 确认文件内获取 changes 的现有写法并保持一致。

- [ ] **Step 5：memory 实现**

在 `infra/memory/repositories.ts` 的 `devices.markOffline` 方法之后（`:358` 闭括号后）加：

```ts
      async updateName(input) {
        const device = devices.get(input.deviceId);
        if (!device) return null;
        const updated: DeviceRecord = { ...device, name: input.hostname, updatedAt: input.updatedAt };
        devices.set(device.id, updated);
        return updated;
      },
```

- [ ] **Step 6：运行测试，确认通过**

Run: `npm --workspace @agentbean/server-next test -- device-repository`
Expected: PASS。

- [ ] **Step 7：提交**

```bash
git add apps/server-next/src/application/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/tests/device-repository.test.ts
git commit -m "feat(server-next): devices repository 新增 updateName

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3：repository devices.delete（含级联）

**Files:**
- Modify: `application/repositories.ts`（接口加 `delete`）
- Modify: `infra/sqlite/repositories.ts`（加 `delete`，级联 `device_runtimes` + `agents`）
- Modify: `infra/memory/repositories.ts`（加 `delete`，级联）
- Test: `apps/server-next/tests/device-repository.test.ts`

- [ ] **Step 1：写失败测试（追加到 device-repository.test.ts）**

```ts
  test('delete removes device and cascades runtimes and agents', async () => {
    const repos = createInMemoryRepositories({ now: () => 1000, ids: createIds() });
    await repos.devices.upsertHello({
      id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online', name: 'mac',
      machineId: 'm-1', profileId: 'default', daemonVersion: null, systemInfo: undefined,
      lastSeenAt: 1000, createdAt: 1000, updatedAt: 1000,
    });
    await repos.runtimes.replaceForDevice({
      deviceId: 'device-1',
      runtimes: [{ id: 'rt-1', deviceId: 'device-1', teamId: 'team-1', adapterKind: 'codex', name: 'Codex', installed: true }],
    });

    await repos.devices.delete({ deviceId: 'device-1' });

    expect(await repos.devices.getById('device-1')).toBeNull();
    expect((await repos.runtimes.listByDevice('device-1')).length).toBe(0);
  });
```

- [ ] **Step 2：运行测试，确认失败**

Run: `npm --workspace @agentbean/server-next test -- device-repository`
Expected: FAIL，`repos.devices.delete is not a function`。

- [ ] **Step 3：加接口签名**

`application/repositories.ts` 的 `devices` 接口加：

```ts
    delete(input: { deviceId: string }): Promise<void>;
```

- [ ] **Step 4：sqlite 实现（级联）**

`infra/sqlite/repositories.ts` 的 `devices.updateName`（Task 2 加的）之后加：

```ts
      async delete(input) {
        globalDb.prepare('DELETE FROM device_runtimes WHERE device_id = ?').run(input.deviceId);
        globalDb.prepare('DELETE FROM agents WHERE device_id = ?').run(input.deviceId);
        globalDb.prepare('DELETE FROM devices WHERE id = ?').run(input.deviceId);
      },
```

> `agents` 表有 `device_id` 列（见 `infra/sqlite/repositories.ts:732` 写入 `agent.deviceId`）。表名/列名以 migration 为准；若 agents 表名不同（如 `device_agents`），先 grep migration 的 `CREATE TABLE` 校正。

- [ ] **Step 5：memory 实现（级联）**

`infra/memory/repositories.ts` 的 `devices.updateName` 之后加：

```ts
      async delete(input) {
        for (const runtime of Array.from(runtimes.values())) {
          if (runtime.deviceId === input.deviceId) runtimes.delete(runtime.id);
        }
        for (const agent of Array.from(agents.values())) {
          if (agent.deviceId === input.deviceId) agents.delete(agent.id);
        }
        devices.delete(input.deviceId);
      },
```

> `runtimes`/`agents` 是 memory repo 文件内已有的 Map（`replaceForDevice`/`listByDevice` 已用）。先确认这两个 Map 变量名（grep 文件顶部 `const runtimes =`/`const agents =`）。

- [ ] **Step 6：运行测试，确认通过**

Run: `npm --workspace @agentbean/server-next test -- device-repository`
Expected: PASS。

- [ ] **Step 7：提交**

```bash
git add apps/server-next/src/application/repositories.ts apps/server-next/src/infra/sqlite/repositories.ts apps/server-next/src/infra/memory/repositories.ts apps/server-next/tests/device-repository.test.ts
git commit -m "feat(server-next): devices repository 新增 delete（级联 runtimes/agents）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4：usecase renameDevice + deleteDevice

**Files:**
- Modify: `apps/server-next/src/application/usecases.ts`（接口 `:55` 区 + 实现 `:1107` 之后）
- Test: 端到端在 Task 6 覆盖（usecase 是薄编排层，靠端到端验证）

- [ ] **Step 1：加接口签名**

`usecases.ts` 的 `ServerNextUseCases` 接口里（`listDevices`/`getDevice` 同区，约 `:55`）加：

```ts
  renameDevice(input: { userId: string; deviceId: string; hostname: string }): Promise<Ack<{ device: DeviceDto }>>;
  deleteDevice(input: { userId: string; deviceId: string }): Promise<Ack<{ device: DeviceDto }>>;
```

- [ ] **Step 2：加实现**

在 `usecases.ts` 的 `getDevice` 实现（约 `:1170-1186`）之后，加两个方法（仿 `getDevice` 的权限校验 + `markOffline` 的返回风格）：

```ts
    async renameDevice(renameInput) {
      const device = await repositories.devices.getById(renameInput.deviceId);
      if (!device) return makeFailure('NOT_FOUND', 'Device not found');
      if (!(await repositories.teams.isMember(device.teamId, renameInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      const updated = await repositories.devices.updateName({
        deviceId: device.id,
        hostname: renameInput.hostname,
        updatedAt: clock.now(),
      });
      if (!updated) return makeFailure('NOT_FOUND', 'Device not found');
      return makeSuccess({ device: toDeviceDto(updated) });
    },

    async deleteDevice(deleteInput) {
      const device = await repositories.devices.getById(deleteInput.deviceId);
      if (!device) return makeFailure('NOT_FOUND', 'Device not found');
      if (!(await repositories.teams.isMember(device.teamId, deleteInput.userId))) {
        return makeFailure('FORBIDDEN', 'User is not a team member');
      }
      await repositories.devices.delete({ deviceId: device.id });
      return makeSuccess({ device: toDeviceDto(device) });
    },
```

> `repositories`/`clock`/`makeFailure`/`makeSuccess`/`toDeviceDto` 都是文件内已有符号（`getDevice`/`deviceHello` 已用）。`Ack`/`DeviceDto` 已 import。

- [ ] **Step 3：类型检查**

Run: `npm --workspace @agentbean/server-next run build` （或 `npx tsc -p apps/server-next/tsconfig.json --noEmit`）
Expected: 编译通过。

- [ ] **Step 4：提交（端到端测试在 Task 6 补）**

```bash
git add apps/server-next/src/application/usecases.ts
git commit -m "feat(server-next): 新增 renameDevice / deleteDevice usecase

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5：socket handler bind + wiring 测试

**Files:**
- Modify: `apps/server-next/src/transport/socket-handlers.ts`（device bind 区，`:83-88`）
- Test: `apps/server-next/tests/socket-handlers.test.ts`

- [ ] **Step 1：加 bind**

在 `socket-handlers.ts` 的 `WEB_EVENTS.device.scan` bind（`:83-88`）之后加：

```ts
  bind(socket, WEB_EVENTS.device.rename, app, 'renameDevice', undefined, { authenticatedUser: options.authenticatedUser });
  bind(socket, WEB_EVENTS.device.delete, app, 'deleteDevice', undefined, { authenticatedUser: options.authenticatedUser });
```

- [ ] **Step 2：更新 socket-handlers.test.ts 的 mock app**

在 `socket-handlers.test.ts` 的 mock app 对象里（`getDevice`/`requestDeviceScan` 附近，约 `:24-27`）加：

```ts
      renameDevice: vi.fn(async (payload) => makeSuccess({ payload })),
      deleteDevice: vi.fn(async (payload) => makeSuccess({ payload })),
```

- [ ] **Step 3：更新 eventNames 断言**

在 `socket-handlers.test.ts:76-95` 的 `expect(socket.eventNames()).toEqual([...])` 数组里，于 `WEB_EVENTS.device.scan,`（约 `:94`）之后加：

```ts
      WEB_EVENTS.device.rename,
      WEB_EVENTS.device.delete,
```

- [ ] **Step 4：加 trigger/断言测试**

在 `socket-handlers.test.ts` 的 device trigger 区（`socket.trigger(WEB_EVENTS.device.get...)` / `device.scan` 附近，约 `:169-176`）加：

```ts
    await socket.trigger(WEB_EVENTS.device.rename, { userId: 'user-1', deviceId: 'device-1', hostname: 'new-name' });
    await socket.trigger(WEB_EVENTS.device.delete, { userId: 'user-1', deviceId: 'device-1' });
```

并在对应断言区（`expect(app.getDevice).toHaveBeenCalledWith(...)` 附近，约 `:362-366`）加：

```ts
    expect(app.renameDevice).toHaveBeenCalledWith({ userId: 'user-1', deviceId: 'device-1', hostname: 'new-name' });
    expect(app.deleteDevice).toHaveBeenCalledWith({ userId: 'user-1', deviceId: 'device-1' });
```

> 具体行号以文件内 `device.scan` 的 trigger/断言为锚点对照插入。`userId` 注入由 `bind` 的 `withAuthenticatedUserId` 完成；trigger 时传的 `userId` 用于断言匹配，实际由 authenticatedUser 注入——若该测试的 authenticatedUser 配置不同，以 `device.get`/`device.scan` 用例的实际 userId 写法为准保持一致。

- [ ] **Step 5：运行测试，确认通过**

Run: `npm --workspace @agentbean/server-next test -- socket-handlers`
Expected: PASS（含更新后的 eventNames 与新 trigger/断言）。

- [ ] **Step 6：提交**

```bash
git add apps/server-next/src/transport/socket-handlers.ts apps/server-next/tests/socket-handlers.test.ts
git commit -m "feat(server-next): 注册 device:rename / device:delete handler

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6：端到端测试（rename / delete / 权限 / 级联）

**Files:**
- Create: `apps/server-next/tests/device-management.test.ts`（仿 `socket-integration.test.ts` setup）

- [ ] **Step 1：写端到端测试**

新建 `apps/server-next/tests/device-management.test.ts`，仿 `socket-integration.test.ts:1-90` 的 setup（`createInMemoryServerNext` + `startSocketServer` + `connectClient`）。提取或复用其 helper（若 `startSocketServer`/`connectClient`/`createIds` 未导出，照搬其实现到本文件）：

```ts
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { AddressInfo } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index';
import { createInMemoryServerNext } from '../src/index';
import { attachServerNextNamespaces } from '../src/transport/socket-server';

// startSocketServer / connectClient / createIds：照搬 socket-integration.test.ts 的实现（见该文件 :30-90 区）
// ...（与 socket-integration.test.ts 相同的 helper 与 cleanups 机制）

describe('device rename and delete (end-to-end)', () => {
  test('team member can rename and delete a device', async () => {
    const app = createInMemoryServerNext({ now: () => 1000, ids: createIds(['user-1','team-1','channel-1','device-1']) });
    const { baseUrl } = await startSocketServer(app);
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agent.disconnect(); });

    // 注册用户 + 设备上线
    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'T' });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'm-1', profileId: 'default', hostname: 'mac' });

    // 改名
    const renamed = await web.emitWithAck(WEB_EVENTS.device.rename, { deviceId: 'device-1', hostname: 'new-mac' });
    expect(renamed).toMatchObject({ ok: true, device: { id: 'device-1', name: 'new-mac' } });

    // 改名后 getDevice 反映新名
    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({ ok: true, device: { name: 'new-mac' } });

    // 删除
    const deleted = await web.emitWithAck(WEB_EVENTS.device.delete, { deviceId: 'device-1' });
    expect(deleted).toMatchObject({ ok: true });

    // 删除后 getDevice → NOT_FOUND
    const after = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(after).toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });
});
```

> `startSocketServer`/`connectClient`/`createIds`/`cleanups` 必须与 `socket-integration.test.ts` 完全一致——直接复制该文件的 helper 段（`:11-66`）。`deviceId: 'device-1'` 对应 `createIds` 数组里的第 4 个 id（与 `socket-integration.test.ts:42-53` 的 id 顺序约定一致）。

- [ ] **Step 2：运行测试，确认通过**

Run: `npm --workspace @agentbean/server-next test -- device-management`
Expected: PASS。若失败，根据报错排查（常见：`createIds` 顺序、`auth.register` 返回结构、authenticatedUser 注入的 userId 与 `isMember` 校验）。

- [ ] **Step 3：跑 server-next 全套测试，确认无回归**

Run: `npm --workspace @agentbean/server-next test`
Expected: 全绿。

- [ ] **Step 4：提交**

```bash
git add apps/server-next/tests/device-management.test.ts
git commit -m "test(server-next): 设备改名/删除端到端测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7：apps/web 适配（rename/delete 发 deviceId + 用常量）

**Files:**
- Modify: `apps/web/lib/socket.ts`（`:444-447`）
- Test: `apps/web/tests/socket.test.ts`（加 rename/delete payload 用例）

- [ ] **Step 1：写失败测试（追加到 apps/web/tests/socket.test.ts）**

仿该文件 `:137-142` 的 device:get payload 测试，加：

```ts
  it('sends deviceId for device rename and delete', async () => {
    await deviceEvents(socket).rename('device-1', 'new-name');
    expect(captured[captured.length - 1]).toEqual({ event: 'device:rename', payload: { deviceId: 'device-1', hostname: 'new-name' } });

    await deviceEvents(socket).delete('device-1');
    expect(captured[captured.length - 1]).toEqual({ event: 'device:delete', payload: { deviceId: 'device-1' } });
  });
```

> `captured`/`socket` 是该测试文件已有的 fake socket + 捕获数组（参考 `:137-142` 的 device:get 用例如何捕获 emit）。变量名以文件内实际为准。

- [ ] **Step 2：运行测试，确认失败**

Run: `npm --workspace agentbean-web test -- socket` （确认 web 的 workspace 名：先 `cat apps/web/package.json | grep name`；可能是 `@agentbean/web` 或 `agentbean-web`）
Expected: FAIL，payload 是 `{id}` 而非 `{deviceId}`。

- [ ] **Step 3：改 socket.ts 实现**

`apps/web/lib/socket.ts:444-447` 把：

```ts
    selectDirectory(deviceId) {
      return emitWithTimeout(socket, 'device:select-directory', { deviceId }, 35000);
    },
    delete(id) {
      return emitWithTimeout(socket, 'device:delete', { id });
    },
    rename(id, hostname) {
      return emitWithTimeout(socket, 'device:rename', { id, hostname });
    },
```

中的 `delete` 和 `rename` 改为（`selectDirectory` 暂不动，留给 S3）：

```ts
    delete(id) {
      return emitWithTimeout(socket, WEB_EVENTS.device.delete, { deviceId: id });
    },
    rename(id, hostname) {
      return emitWithTimeout(socket, WEB_EVENTS.device.rename, { deviceId: id, hostname });
    },
```

> 确认 `WEB_EVENTS` 已在该文件 import（device.get/list 等已用 `WEB_EVENTS.device.*`，见 `:430-439`）。从硬编码字符串迁到常量，与文件其余 device 事件一致。

- [ ] **Step 4：运行测试，确认通过**

Run: `npm --workspace <web-workspace-name> test -- socket`
Expected: PASS。

- [ ] **Step 5：跑 apps/web 全套测试**

Run: `npm --workspace <web-workspace-name> test`
Expected: 全绿。

- [ ] **Step 6：提交**

```bash
git add apps/web/lib/socket.ts apps/web/tests/socket.test.ts
git commit -m "fix(web): device rename/delete 发 deviceId 对齐 server-next

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 明确不在本计划范围

- **daemon 版本 / systemInfo 富字段 / connectCommand**：S2（跨 daemon/server/contracts）。
- **目录选择器 `device:select-directory`**：S3，需先定 daemon 端目录交互方案。Task 7 保留 `selectDirectory` 的硬编码字符串 `'device:select-directory'` 不动。
- **权限收紧**：本计划用 team 成员可改/删（与 `getDevice` 一致）。收紧到 owner/admin 属后续迭代。
- **删除的实时广播**：delete 后是否广播 `devices:snapshot` 通知其它在线 web 客户端刷新列表？`bind` 的 `afterResult` 钩子可接（仿 `channel.delete` 的 `afterChannelMutation`）。本计划未加（保持最小）；若验收时发现多端列表不刷新，加一个 `afterDeviceMutation` 广播钩子作为补丁。

---

## Self-Review

1. **Spec 覆盖**：S1 = `device:rename` + `device:delete` 端到端。contracts（Task 1）→ repo updateName（Task 2）→ repo delete 级联（Task 3）→ usecase（Task 4）→ handler bind + wiring 测试（Task 5）→ 端到端测试（Task 6）→ apps/web payload 适配 + 测试（Task 7）。每个环节有对应 task + 测试。✅
2. **占位符扫描**：每个代码步骤含可直接粘贴的完整代码 + 精确命令；少量「先 grep 确认 X」是因目标符号（如 `sqliteChanges`/`createIds`/memory Map 变量名）需以文件现状为准，已给出具体核实方法，非空泛 TBD。✅
3. **类型/命名一致性**：
   - 事件名：`device:rename`/`device:delete` 在 contracts、handler bind、socket-handlers.test eventNames、apps/web emit、apps/web 测试断言中一致。✅
   - payload 字段：server usecase 入参统一 `{userId, deviceId, hostname?}`（与 `getDevice` 一致）；apps/web 发 `{deviceId: id}`（适配 D2）；apps/web 接口签名 `(id, hostname?)` 不变，仅实现转 `deviceId`。✅
   - 方法名：`renameDevice`/`deleteDevice`（usecase 接口 + 实现 + handler bind + mock）、`updateName`/`delete`（repository 接口 + sqlite/memory 实现）前后一致。✅
   - delete 级联：sqlite（`device_runtimes` + `agents` + `devices`）与 memory（runtimes Map + agents Map + devices Map）对称。✅
4. **顺序依赖**：Task 1→2→3→4→5→6→7，后一个依赖前一个的符号（contracts → repo → usecase → handler → e2e → web），按号执行不冲突。Task 6 端到端测试需要 Task 1-5 全部完成才绿。✅
