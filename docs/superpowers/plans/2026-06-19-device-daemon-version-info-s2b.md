# 设备 daemon 版本信息实施计划（S2b：daemonVersionInfo.latest / updateAvailable）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 让 apps/web 设备详情页显示 daemon「有更新版本」提示。移植旧 `apps/server/src/daemon-version.ts` 的完整 latest 机制（env / npm registry / packaged 三层 + 缓存 + 后台刷新）到 server-next，`toDeviceDto` 算 `daemonVersionInfo`，apps/web UI 早预留的 danger tone 自动生效。

**Architecture:** 纯移植 + 接线。旧 server 的 `daemon-version.ts` 是验证过的健壮模块（env `AGENT_BEAN_DAEMON_LATEST_VERSION` > npm registry `@agentbean/daemon` dist-tag 5min 缓存 + 后台 `startDaemonVersionRefresh` > packaged fallback，测试环境跳过 npm）。S2b 整体搬到 server-next，`buildDaemonVersionInfo(systemInfo)` 同步算 `{current, latest, updateAvailable, status}`，`toDeviceDto` 调它。apps/web（`devices/page.tsx:527-533` + `daemon-version.ts`）早预留 `daemonVersionInfo` 结构 + danger tone，零改动。

**Tech Stack:** TypeScript、server-next（Node fetch + vitest）、contracts、apps/web（Next.js）。

---

## 背景

S2（DeviceDetail 富字段）拆分：S2a（systemInfo 富 + daemonVersion current，PR #295 已合并）→ **S2b（本计划，daemonVersionInfo.latest/updateAvailable）** → connectCommand（单独，涉 invite 时序）。S2a 让设备页显示 daemon「当前版本」，S2b 补「有更新版本」提示。

旧 `apps/server/src/daemon-version.ts`（167 行）是该机制的权威实现，S2b 直接移植。

## 范围

**纳入：**
- **移植** `apps/server/src/daemon-version.ts` → `apps/server-next/src/daemon-version.ts`（调整 packaged 路径指向 daemon-next + dist 运行处理）。
- **contracts**：`DeviceDto` 加 `daemonVersionInfo?` + `latestDaemonVersion?` + `daemonUpdateAvailable?` + `DaemonVersionInfo` 类型。
- **server-next**：`toDeviceDto` 调 `buildDaemonVersionInfo(device.systemInfo)`；`startServerNextDevServer` 启动时调 `startDaemonVersionRefresh`。
- **apps/web**：确认零改动（UI 早预留）。
- 测试：daemon-version 单测、端到端（设 env latest 验证 updateAvailable）。

**不纳入：** connectCommand（涉 invite→device 时序，单独 slice）。

## 关键约束（实现者必读）

1. **buildDaemonVersionInfo 是同步的**：用 cached latest（`getLatestDaemonVersion()`），不阻塞。npm fetch 是异步后台刷新（`startDaemonVersionRefresh` + `refreshLatestDaemonVersionFromNpm`），不进 `toDeviceDto` 的同步路径。首次 cached 可能为 null（status='unknown'），后台刷新后才有值——这是设计，测试用 env 控制。
2. **测试环境跳过 npm**：`refreshLatestDaemonVersionFromNpm` 在 `NODE_ENV=test && !AGENT_BEAN_DAEMON_NPM_REGISTRY_URL` 时只用 packaged/env（旧文件 `:111-113`）。测试用 `AGENT_BEAN_DAEMON_LATEST_VERSION` env 控制 latest，不依赖网络。
3. **packaged 路径调整**：旧文件 candidates 是 `apps/daemon/package.json`（legacy daemon）。server-next 应指向 **`apps/daemon-next/package.json`**。server-next 运行在 `dist/`（`package.json` main = `./dist/apps/server-next/src/index.js`），相对路径要处理（参考 S2a 的 `1bbedce` packaging 修复思路）。
4. **daemonVersion 双处一致**：S2a 已让 `systemInfo.daemonVersion` + 顶层 `daemonVersion` 同值。`buildDaemonVersionInfo` 读 `systemInfo.daemonVersion`（旧文件 `:154`），与 S2a 一致。
5. **apps/web 早预留**：`devices/page.tsx:527-533` 已读 `daemonVersionInfo`/`daemonVersion.updateAvailable` 渲染 danger tone；`lib/daemon-version.ts` 早消费它。零改动。

## File Structure

- **新增** `apps/server-next/src/daemon-version.ts`（移植自 `apps/server/src/daemon-version.ts`）。
- **新增** `apps/server-next/tests/daemon-version.test.ts`：单测。
- **修改** `packages/contracts/src/device.ts`：`DeviceDto` 加 3 字段 + `DaemonVersionInfo` 类型。
- **修改** `apps/server-next/src/application/usecases.ts`：`toDeviceDto`（`:2984`）调 `buildDaemonVersionInfo`。
- **修改** `apps/server-next/src/dev-server.ts`：`startServerNextDevServer`（`:103`）启动 `startDaemonVersionRefresh`。
- **修改** `apps/server-next/tests/device-management.test.ts`：加端到端用例（env latest → updateAvailable）。
- **可能** `apps/web/`：仅确认（预期零改动）。

---

## Task 1：移植 daemon-version.ts + 单测

**Files:**
- Create: `apps/server-next/src/daemon-version.ts`（移植自 `apps/server/src/daemon-version.ts`）
- Create: `apps/server-next/tests/daemon-version.test.ts`

- [ ] **Step 1：移植 daemon-version.ts**

复制 `apps/server/src/daemon-version.ts`（167 行）到 `apps/server-next/src/daemon-version.ts`。**调整点**：

1. **packaged 路径**：`getPackagedLatestDaemonVersion()` 的 candidates（旧 `:52-56`）改为指向 daemon-next，并处理 dist 运行。参考 S2a `1bbedce` 的 packaging 修复（`apps/daemon-next/src/system-info.ts` 的 `readDaemonVersion` 怎么处理 dist 路径）。建议 candidates：
   ```ts
   const candidates = [
     resolve(process.cwd(), 'apps/daemon-next/package.json'),
     resolve(process.cwd(), '../daemon-next/package.json'),
     resolve(process.cwd(), '../../apps/daemon-next/package.json'),
   ];
   ```
   （先 `cat apps/daemon-next/package.json | grep version` 确认 daemon-next 版本，作为 packaged fallback 值。）

2. **import 扩展名**：server-next 用 ESM `.js` 扩展名（见现有文件）。daemon-version.ts 只用 `node:fs`/`node:path`（无内部 import），无需改。

3. **npm registry url 默认**：保持 `https://registry.npmjs.org/%40agentbean%2Fdaemon`（旧 `:69`，`@agentbean/daemon` 包）。先确认 npm 上 `@agentbean/daemon` 的 dist-tag latest（生产 daemon 包名）—— `grep name apps/daemon-next/package.json` 确认发布包名（应为 `@agentbean/daemon`，记忆：canonical `@agentbean/daemon` @latest 推到 0.2.0+）。

> 其余逻辑（`buildDaemonVersionInfo`/`compareVersions`/`cleanVersion`/`getLatestDaemonVersion`/`refreshLatestDaemonVersionFromNpm`/`startDaemonVersionRefresh`/`resetDaemonVersionCacheForTests`）原样移植。

- [ ] **Step 2：写单测**

新建 `apps/server-next/tests/daemon-version.test.ts`。**测试环境自动跳过 npm**（旧文件 `:111`），用 `AGENT_BEAN_DAEMON_LATEST_VERSION` env 控制 latest。每个 test 前 `resetDaemonVersionCacheForTests()` 清缓存：

```ts
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildDaemonVersionInfo,
  compareVersions,
  getLatestDaemonVersion,
  resetDaemonVersionCacheForTests,
} from '../src/daemon-version';

afterEach(() => {
  resetDaemonVersionCacheForTests();
  delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
});

describe('daemon-version', () => {
  test('compareVersions orders semver correctly', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBeLessThan(0);
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
  });

  test('getLatestDaemonVersion prefers env over packaged', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '9.9.9';
    expect(getLatestDaemonVersion()).toBe('9.9.9');
  });

  test('buildDaemonVersionInfo reports update-available when current < latest', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    const info = buildDaemonVersionInfo({ daemonVersion: '0.2.1' });
    expect(info).toEqual({
      current: '0.2.1',
      latest: '0.3.0',
      updateAvailable: true,
      status: 'update-available',
    });
  });

  test('buildDaemonVersionInfo reports current when up-to-date', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.2.1';
    const info = buildDaemonVersionInfo({ daemonVersion: '0.2.1' });
    expect(info.status).toBe('current');
    expect(info.updateAvailable).toBe(false);
  });

  test('buildDaemonVersionInfo is unknown when current missing', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    const info = buildDaemonVersionInfo({});
    expect(info.status).toBe('unknown');
    expect(info.current).toBeNull();
  });
});
```

- [ ] **Step 3：跑测试确认通过**
Run: `npm --workspace @agentbean/server-next test -- daemon-version`
Expected: PASS（5 用例）。若 packaged fallback 干扰（env 未设时 getLatestDaemonVersion 返回 packaged 值），用 env 显式控制或 `vi.stubEnv`。

- [ ] **Step 4：提交**
```bash
git add apps/server-next/src/daemon-version.ts apps/server-next/tests/daemon-version.test.ts
git commit -m "feat(server-next): 移植 daemon-version（env/npm/packaged latest + 缓存）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2：contracts DeviceDto 加 daemonVersionInfo 等

**Files:** `packages/contracts/src/device.ts`

- [ ] **Step 1：加类型 + 字段**

在 `device.ts` 加 `DaemonVersionInfo` 类型（在 `DeviceStatus` 附近），`DeviceDto` 加 3 字段（`daemonVersion?` 后）：

```ts
export type DaemonVersionStatus = 'current' | 'update-available' | 'unknown';

export interface DaemonVersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  status: DaemonVersionStatus;
}
```

```ts
export interface DeviceDto {
  id: ID;
  teamId: ID;
  ownerId: ID;
  status: DeviceStatus;
  name?: string;
  systemInfo?: DeviceSystemInfoDto;
  capabilities?: DeviceCapabilitiesDto;
  daemonVersion?: string;
  daemonVersionInfo?: DaemonVersionInfo;
  latestDaemonVersion?: string | null;
  daemonUpdateAvailable?: boolean;
  lastSeenAt?: UnixMs;
}
```

> 与 apps/web `devices/page.tsx:313` 的 `daemonVersionInfo: { current, latest, updateAvailable, status }` 形状一致。

- [ ] **Step 2：类型检查**
Run: `npm --workspace @agentbean/contracts run build`
Expected: 通过。

- [ ] **Step 3：提交**
```bash
git add packages/contracts/src/device.ts
git commit -m "feat(contracts): DeviceDto 加 daemonVersionInfo / latestDaemonVersion / daemonUpdateAvailable

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3：toDeviceDto 调 buildDaemonVersionInfo

**Files:** `apps/server-next/src/application/usecases.ts`（`toDeviceDto` `:2984`）

- [ ] **Step 1：toDeviceDto 算 daemonVersionInfo**

import `buildDaemonVersionInfo`（文件顶部，与其它 `./xxx.js` import 同区）：

```ts
import { buildDaemonVersionInfo } from './daemon-version.js';
```

`toDeviceDto`（`:2984`）在 `daemonVersion: device.daemonVersion,` 后加 3 字段：

```ts
function toDeviceDto(device: DeviceDto): DeviceDto {
  const daemonVersionInfo = buildDaemonVersionInfo(device.systemInfo);
  return {
    id: device.id,
    teamId: device.teamId,
    ownerId: device.ownerId,
    status: device.status,
    name: device.name,
    systemInfo: device.systemInfo,
    capabilities: device.capabilities,
    daemonVersion: device.daemonVersion,
    daemonVersionInfo,
    latestDaemonVersion: daemonVersionInfo.latest,
    daemonUpdateAvailable: daemonVersionInfo.updateAvailable,
    lastSeenAt: device.lastSeenAt,
  };
}
```

> `buildDaemonVersionInfo(device.systemInfo)` 同步用 cached latest。`device.systemInfo` 是 `DeviceSystemInfoDto`（含 `daemonVersion`，S2a），兼容 `Record<string, unknown> | null` 入参。

- [ ] **Step 2：类型检查**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit`
Expected: 通过。

- [ ] **Step 3：提交**
```bash
git add apps/server-next/src/application/usecases.ts
git commit -m "feat(server-next): toDeviceDto 算 daemonVersionInfo（latest/updateAvailable）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4：server 启动 startDaemonVersionRefresh

**Files:** `apps/server-next/src/dev-server.ts`（`startServerNextDevServer` `:103`）

- [ ] **Step 1：启动时调 refresh**

import `startDaemonVersionRefresh`（dev-server.ts 顶部）：

```ts
import { startDaemonVersionRefresh } from './daemon-version.js';
```

在 `startServerNextDevServer`（`:103`）里，`httpServer.listen`（`:151`）成功后（或 server 启动收尾处）启动后台刷新，并把 stop 函数加入 cleanup：

```ts
    const stopVersionRefresh = startDaemonVersionRefresh();
```

> 在 handle/close 路径里调 `stopVersionRefresh()`（与 httpServer.close 同生命周期）。先读 `startServerNextDevServer` 的返回 handle 结构（`ServerNextDevServerHandle`）确认 cleanup 模式。**测试环境**（NODE_ENV=test）`startDaemonVersionRefresh` 自动返回 no-op（旧文件 `:134-136`），不影响测试。
> `createInMemoryServerNext`（index.ts，测试用）**不调** refresh（测试用 env 控制 latest，不需后台 npm）。

- [ ] **Step 2：类型检查 + server 全套测试**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit && npm --workspace @agentbean/server-next test`
Expected: tsc 通过，测试绿（测试环境 refresh 是 no-op，不破坏现有测试）。

- [ ] **Step 3：提交**
```bash
git add apps/server-next/src/dev-server.ts
git commit -m "feat(server-next): dev server 启动后台刷新 daemon latest 版本

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5：端到端测试（env latest → updateAvailable）

**Files:** `apps/server-next/tests/device-management.test.ts`

- [ ] **Step 1：加端到端用例**

在 describe 块加用例。设 `AGENT_BEAN_DAEMON_LATEST_VERSION` env 让 `buildDaemonVersionInfo` 算出 updateAvailable（测试环境跳过 npm，用 env）。**每个 test 前/后管理 env + cache**：

```ts
import { resetDaemonVersionCacheForTests } from '../src/daemon-version';

// 在现有 describe 内（或新建 describe）：
  test('device getDevice surfaces daemonVersionInfo with update-available', async () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    resetDaemonVersionCacheForTests();

    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1']),
    });
    const { baseUrl } = await startSocketServer(app);
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => {
      web.disconnect();
      agent.disconnect();
      delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
      resetDaemonVersionCacheForTests();
    });

    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'T' });
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1', ownerId: 'user-1', machineId: 'm-1', profileId: 'default', hostname: 'mac',
      daemonVersion: '0.2.1',
      systemInfo: { hostname: 'mac', platform: 'darwin', arch: 'arm64', daemonVersion: '0.2.1' },
    });

    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({
      ok: true,
      device: {
        daemonVersionInfo: { current: '0.2.1', latest: '0.3.0', updateAvailable: true, status: 'update-available' },
        latestDaemonVersion: '0.3.0',
        daemonUpdateAvailable: true,
      },
    });
  });
```

> register/hello payload 以 device-management.test.ts 现有用例为准。env + cache 清理放 cleanups（避免污染其它用例）。

- [ ] **Step 2：跑测试**
Run: `npm --workspace @agentbean/server-next test -- device-management`
Expected: PASS。若 daemonVersionInfo.latest 不是 0.3.0（env 没生效），查 cache 清理 + env 设置时机（buildDeviceDto 调时 env 必须已设）。

- [ ] **Step 3：server 全套**
Run: `npm --workspace @agentbean/server-next test`
Expected: 全绿。

- [ ] **Step 4：提交**
```bash
git add apps/server-next/tests/device-management.test.ts
git commit -m "test(server-next): device getDevice daemonVersionInfo 端到端

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6：apps/web 确认（预期零改动）

**Files:** 可能 `apps/web/app/[networkPath]/devices/page.tsx`（仅确认）

- [ ] **Step 1：核查**

读 `devices/page.tsx:527-533`（daemonVersion InfoCard + danger tone）+ `lib/daemon-version.ts`（`daemonVersionDisplay` 读 `daemonVersionInfo`）。确认：
- `:527-533` 已读 `daemonVersion.updateAvailable` 渲染 danger tone + `（有更新版本）`——**应已存在**。
- `daemon-version.ts:28-30` 已读 `daemonVersionInfo?.current/latest/updateAvailable`——**应已存在**。

server 返回 `daemonVersionInfo`/`latestDaemonVersion`/`daemonUpdateAvailable` 后，apps/web 自动显示「有更新版本」提示。**预期零改动**。

- [ ] **Step 2：apps/web 类型检查 + 测试**
Run: `npx tsc -p apps/web/tsconfig.json --noEmit && npm --workspace agentbean-web test`
Expected: tsc 通过（注意 S2a 发现的预先存在 socket.test.ts:240 error，非本 slice 引入），测试绿。

- [ ] **Step 3：若有改动提交，否则跳过**
```bash
git status --short apps/web
# 有改动则提交，无则零改动确认
```

---

## 明确不在本计划范围

- **connectCommand**：涉 invite→device 时序（device 表新列 + 接入时存命令），单独 slice。
- **npm registry 可达性**：生产 server 需能访问 `registry.npmjs.org`（或设 `AGENT_BEAN_DAEMON_LATEST_VERSION` env）。离线/受限网络用 env。这是运维配置，不在代码 slice。

## Self-Review

1. **Spec 覆盖**：S2b = daemonVersionInfo.latest/updateAvailable。移植 daemon-version（Task 1）→ contracts（Task 2）→ toDeviceDto（Task 3）→ server refresh（Task 4）→ 端到端（Task 5）→ apps/web（Task 6）。✅
2. **占位符**：Task 1 移植引用源文件 + 调整点（packaged 路径/npm 包名/import）—— 移植任务的合理写法（不重贴 167 行）。其余 task 完整代码。✅
3. **一致性**：
   - daemonVersionInfo：buildDaemonVersionInfo（systemInfo.daemonVersion current + cached latest）→ toDeviceDto → DeviceDetailDto → apps/web。形状与 apps/web `:313` 一致。✅
   - latest 来源：env > npm（cached + 后台 refresh）> packaged。测试用 env（跳过 npm）。✅
   - 同步性：toDeviceDto 同步（cached latest），npm 异步后台刷新。✅
4. **顺序**：Task 1（移植）→ 2（contracts）→ 3（toDeviceDto）→ 4（refresh）→ 5（端到端）→ 6（apps/web）。✅
5. **apps/web 零改动**：`:527-533` + `lib/daemon-version.ts` 早预留，Task 6 预期无代码改动。✅
