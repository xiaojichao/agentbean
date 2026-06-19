# 设备详情富字段实施计划（S2a：systemInfo 富字段 + daemonVersion）

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 让 apps/web 设备详情页的「设备信息卡」显示完整系统信息（OS/CPU/核心/内存/Node/daemon 版本/主机名）。daemon 上报富 systemInfo + daemonVersion，server 暴露已就绪的存储，apps/web UI 零改动自动显示。

**Architecture:** 跨 4 层但每层改动小。关键洞察：**存储链路已就绪**（`devices` 表有 `daemon_version`/`system_info` 列，`mapDevice` 已读，`deviceHello` usecase 已接收存储 `daemonVersion`/`systemInfo`，`DeviceHelloInput` 契约已有这两字段）。缺口只有三处：(1) daemon 不收集上报富字段（只发 hostname）；(2) contracts `DeviceSystemInfoDto`/`DeviceDto` 字段不全；(3) `toDeviceDto` 不映射 `daemonVersion`。apps/web UI（`devices/page.tsx:519-534`）**已完整渲染**所有 InfoCard，只等数据。

**Tech Stack:** TypeScript、daemon-next（Node `os` 模块 + vitest）、contracts、server-next（SQLite + vitest）、apps/web（Next.js）。

---

## 背景

S2（DeviceDetail 富字段）拆分后的第一个子 slice。S2a = systemInfo 富字段 + daemonVersion current（明确、零不确定性）。S2b（daemonVersionInfo.latest / updateAvailable，需"最新版本"来源决策）和 connectCommand（语义模糊，已接入设备无活跃 invite）待后续。

诊断见对话上下文。根因：apps/web 设备页期望富 systemInfo（`devices/page.tsx:313`）+ daemonVersion，但 daemon 不上报、server `DeviceDetailDto` 不含。

## 范围

**纳入：**
- **contracts**：`DeviceSystemInfoDto` 加富字段（`osVersion`/`cpuModel`/`cpuCores`/`totalMemoryGB`/`freeMemoryGB`/`nodeVersion`/`daemonVersion`）；`DeviceDto` 加 `daemonVersion?`。
- **daemon-next**：新增 `collectSystemInfo()`（`node:os` 收集）+ `readDaemonVersion()`（读 package.json）；`DaemonDeviceConfig` 加字段；`cli.ts` device 对象在 hello payload 带上富 systemInfo + daemonVersion。
- **server-next**：`toDeviceDto` 映射 `daemonVersion`（其余存储链路已就绪）。
- **apps/web**：确认类型对齐（UI 已就绪，预期零代码改动）。
- 测试：daemon collect 单测、server 端到端（hello 富字段 → getDevice 富字段）。

**不纳入：** daemonVersionInfo.latest/updateAvailable（S2b，需版本来源）、connectCommand（语义模糊，单独）。

## 关键约束（实现者必读）

1. **存储已就绪，勿重复造**：`devices` 表 `daemon_version`/`system_info` 列已有（migration `0001:56-57`）；`mapDevice`（`sqlite/repositories.ts:1617-1631`）已读这两列到 `DeviceRecord.daemonVersion`/`systemInfo`；`deviceHello` usecase（`usecases.ts:1073-1086`）已 `upsertHello({ daemonVersion: deviceInput.daemonVersion, systemInfo: deviceInput.systemInfo })`；`DeviceHelloInput`（`usecases.ts:231-239`）已有 `daemonVersion?`/`systemInfo?`。**不要改这些**——它们已工作。
2. **systemInfo 透传**：`system_info` 是 JSON 列，`mapDevice` `JSON.parse` 透传整个对象。所以 daemon 在 systemInfo 里放富字段，server 自动透传到 `DeviceDetailDto.systemInfo`，**无需 server 改 systemInfo 映射**。
3. **daemonVersion 双处**：apps/web 既读 `systemInfo.daemonVersion`（`devices/page.tsx:527,680`）又读顶层 `daemonVersion`（fallback）。daemon 上报时两处都带（值相同），确保 apps/web 零改动。
4. **apps/web UI 已就绪**：`devices/page.tsx:519-534` 用 `{device.systemInfo.osVersion && <InfoCard .../>}` 守卫渲染。数据到位即显示。**不要改 apps/web UI**，除非类型对齐需要。
5. **行号是现状锚点**，以符号名定位为准。

## File Structure

- **修改** `packages/contracts/src/device.ts`：`DeviceSystemInfoDto` + `DeviceDto`。
- **新增** `apps/daemon-next/src/system-info.ts`：`collectSystemInfo()` + `readDaemonVersion()`。
- **新增** `apps/daemon-next/tests/system-info.test.ts`：collect 单测。
- **修改** `apps/daemon-next/src/index.ts`：`DaemonDeviceConfig` 加 `daemonVersion?`/`systemInfo?`（需 import `DeviceDto`）。
- **修改** `apps/daemon-next/src/cli.ts`：device 对象（`:111-118`）加 `systemInfo` + `daemonVersion`。
- **修改** `apps/server-next/src/application/usecases.ts`：`toDeviceDto`（`:2932`）映射 `daemonVersion`。
- **修改** `apps/server-next/tests/device-management.test.ts`：加端到端用例（hello 富字段 → getDevice 富字段）。
- **可能修改** `apps/web/...`：仅类型对齐（预期零 UI 改动）。

---

## Task 1：contracts 加富字段

**Files:** `packages/contracts/src/device.ts`

- [ ] **Step 1：扩 DeviceSystemInfoDto + DeviceDto**

`DeviceSystemInfoDto`（`:7-12`）加富字段 + daemonVersion：

```ts
export interface DeviceSystemInfoDto {
  hostname?: string;
  platform?: string;
  arch?: string;
  release?: string;
  osVersion?: string;
  cpuModel?: string;
  cpuCores?: number;
  totalMemoryGB?: number;
  freeMemoryGB?: number;
  nodeVersion?: string;
  daemonVersion?: string;
}
```

`DeviceDto`（`:19-28`）加 `daemonVersion?`（在 `lastSeenAt` 前）：

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
  lastSeenAt?: UnixMs;
}
```

- [ ] **Step 2：类型检查**
Run: `npm --workspace @agentbean/contracts run build`
Expected: 编译通过。

- [ ] **Step 3：提交**
```bash
git add packages/contracts/src/device.ts
git commit -m "feat(contracts): DeviceSystemInfoDto 加富字段 + DeviceDto 加 daemonVersion

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2：daemon collect 函数 + 单测

**Files:**
- Create: `apps/daemon-next/src/system-info.ts`
- Create: `apps/daemon-next/tests/system-info.test.ts`

- [ ] **Step 1：写测试（先红）**

新建 `apps/daemon-next/tests/system-info.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { collectSystemInfo, readDaemonVersion } from '../src/system-info';

describe('system-info', () => {
  test('collectSystemInfo returns os-derived fields with expected shapes', () => {
    const info = collectSystemInfo();
    expect(typeof info.hostname).toBe('string');
    expect(typeof info.platform).toBe('string');
    expect(typeof info.arch).toBe('string');
    expect(typeof info.osVersion).toBe('string');
    expect(typeof info.cpuModel).toBe('string');
    expect(typeof info.cpuCores).toBe('number');
    expect(info.cpuCores).toBeGreaterThan(0);
    expect(typeof info.totalMemoryGB).toBe('number');
    expect(info.totalMemoryGB).toBeGreaterThan(0);
    expect(typeof info.freeMemoryGB).toBe('number');
    expect(info.nodeVersion).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test('readDaemonVersion returns the package version', () => {
    const version = readDaemonVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
```

- [ ] **Step 2：跑测试确认失败**
Run: `npm --workspace @agentbean/daemon-next test -- system-info`
Expected: FAIL（模块不存在）。

- [ ] **Step 3：实现 system-info.ts**

新建 `apps/daemon-next/src/system-info.ts`：

```ts
import { hostname, platform, arch, release, version, cpus, totalmem, freemem } from 'node:os';
import { createRequire } from 'node:module';
import type { DeviceSystemInfoDto } from '../../../packages/contracts/src/index.js';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function collectSystemInfo(): DeviceSystemInfoDto {
  const cpuList = cpus();
  return {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    release: release(),
    osVersion: version(),
    cpuModel: cpuList[0]?.model,
    cpuCores: cpuList.length,
    totalMemoryGB: round2(totalmem() / 1024 ** 3),
    freeMemoryGB: round2(freemem() / 1024 ** 3),
    nodeVersion: process.version,
  };
}

export function readDaemonVersion(): string {
  const requireFromHere = createRequire(import.meta.url);
  const pkg = requireFromHere('../package.json') as { version?: string };
  return pkg.version ?? 'unknown';
}
```

> `../package.json`：从 `src/system-info.ts` 上一级即 `apps/daemon-next/package.json`。先 `cat apps/daemon-next/package.json | grep version` 确认路径与版本（应为 `0.2.1`）。`DeviceSystemInfoDto` 从 contracts import（daemon-next 已依赖 contracts，见 `index.ts:1`）。

- [ ] **Step 4：跑测试确认通过**
Run: `npm --workspace @agentbean/daemon-next test -- system-info`
Expected: PASS（2 用例）。

- [ ] **Step 5：提交**
```bash
git add apps/daemon-next/src/system-info.ts apps/daemon-next/tests/system-info.test.ts
git commit -m "feat(daemon-next): 新增 collectSystemInfo / readDaemonVersion

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3：daemon 接入 hello payload

**Files:**
- Modify: `apps/daemon-next/src/index.ts`（`DaemonDeviceConfig`，`:43-50`）
- Modify: `apps/daemon-next/src/cli.ts`（device 对象，`:111-118`）

- [ ] **Step 1：DaemonDeviceConfig 加字段**

`apps/daemon-next/src/index.ts` 的 `DaemonDeviceConfig`（`:43-50`）加 `daemonVersion?` + `systemInfo?`。先确认 `index.ts:1` 是否已 import `DeviceDto`（grep），若否则加 import：

```ts
export interface DaemonDeviceConfig {
  teamId: string;
  ownerId: string;
  token?: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  daemonVersion?: string;
  systemInfo?: import('../../../packages/contracts/src/index.js').DeviceDto['systemInfo'];
}
```

> 若 `index.ts` 顶部已 import `DeviceDto`，用 `DeviceDto['systemInfo']`；否则用上面的 inline import 形式（与 `DeviceHelloInput` 的 `systemInfo?: DeviceDto['systemInfo']` 一致）。先读 `index.ts:1` 确认 import 风格。

- [ ] **Step 2：cli.ts device 对象带上富字段**

`apps/daemon-next/src/cli.ts` 顶部加 import（与现有 `import { hostname as readHostname } from 'node:os';` 同区）：

```ts
import { collectSystemInfo, readDaemonVersion } from './system-info.js';
```

`runDaemonNextCli` 里构造 device 对象（`:111-118`），在 `hostname: config.hostname,` 之后加：

```ts
  const device: DaemonDeviceConfig & { token?: string } = {
    teamId,
    ownerId,
    ...(credentials?.token ? { token: credentials.token } : {}),
    machineId: config.machineId,
    profileId: config.profileId,
    hostname: config.hostname,
    daemonVersion: readDaemonVersion(),
    systemInfo: { ...collectSystemInfo(), daemonVersion: readDaemonVersion() },
  };
```

> systemInfo 同时带 os 富字段 + daemonVersion（apps/web 读 `systemInfo.daemonVersion`）；顶层 daemonVersion 给 server 存 `daemon_version` 列。两处值相同（都 `readDaemonVersion()`）。

- [ ] **Step 3：类型检查 + daemon 全套测试**
Run: `npx tsc -p apps/daemon-next/tsconfig.json --noEmit && npm --workspace @agentbean/daemon-next test`
Expected: tsc 通过，daemon 全套测试绿（含 cli.test.ts——若 cli.test.ts 断言 device 对象形状，可能需同步，按失败信息处理）。

- [ ] **Step 4：提交**
```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/src/cli.ts
git commit -m "feat(daemon-next): device hello 上报富 systemInfo + daemonVersion

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4：server toDeviceDto 映射 daemonVersion

**Files:** `apps/server-next/src/application/usecases.ts`（`toDeviceDto`，`:2932-2943`）

- [ ] **Step 1：toDeviceDto 加 daemonVersion 映射**

`toDeviceDto`（`:2932-2943`）在 `lastSeenAt: device.lastSeenAt,` 前加一行：

```ts
function toDeviceDto(device: DeviceDto): DeviceDto {
  return {
    id: device.id,
    teamId: device.teamId,
    ownerId: device.ownerId,
    status: device.status,
    name: device.name,
    systemInfo: device.systemInfo,
    capabilities: device.capabilities,
    daemonVersion: device.daemonVersion,
    lastSeenAt: device.lastSeenAt,
  };
}
```

> `device` 实参是 `DeviceRecord`（含 `daemonVersion`，来自 `mapDevice` 读 `daemon_version` 列）。Task 1 给 `DeviceDto` 加了 `daemonVersion?`，故类型兼容。systemInfo 已透传（JSON），无需改。

- [ ] **Step 2：类型检查**
Run: `npx tsc -p apps/server-next/tsconfig.json --noEmit`
Expected: 通过。

- [ ] **Step 3：提交（端到端验证在 Task 5）**
```bash
git add apps/server-next/src/application/usecases.ts
git commit -m "feat(server-next): toDeviceDto 映射 daemonVersion

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5：端到端测试（hello 富字段 → getDevice 富字段）

**Files:** `apps/server-next/tests/device-management.test.ts`（S1 建的，扩展）

- [ ] **Step 1：加端到端用例**

在 `device-management.test.ts` 的 describe 块里加一个用例（仿现有 happy path 用例的 setup：`createInMemoryServerNext` + `startSocketServer` + `connectClient`）：

```ts
  test('device hello rich fields surface through getDevice', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1']),
    });
    const { baseUrl } = await startSocketServer(app);
    const web = await connectClient(`${baseUrl}/web`);
    const agent = await connectClient(`${baseUrl}/agent`);
    cleanups.push(async () => { web.disconnect(); agent.disconnect(); });

    await web.emitWithAck(WEB_EVENTS.auth.register, { username: 'shaw', password: 'secret', teamName: 'T' });

    // daemon hello 上报富 systemInfo + daemonVersion
    await agent.emitWithAck(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'm-1',
      profileId: 'default',
      hostname: 'mac',
      daemonVersion: '0.2.1',
      systemInfo: {
        hostname: 'mac', platform: 'darwin', arch: 'arm64', release: '24.0',
        osVersion: '24.0', cpuModel: 'M1', cpuCores: 8, totalMemoryGB: 16,
        freeMemoryGB: 8, nodeVersion: 'v22.0.0', daemonVersion: '0.2.1',
      },
    });

    const got = await web.emitWithAck(WEB_EVENTS.device.get, { deviceId: 'device-1' });
    expect(got).toMatchObject({
      ok: true,
      device: {
        daemonVersion: '0.2.1',
        systemInfo: {
          osVersion: '24.0', cpuModel: 'M1', cpuCores: 8,
          totalMemoryGB: 16, nodeVersion: 'v22.0.0', daemonVersion: '0.2.1',
        },
      },
    });
  });
```

> register/hello 的字段以 `device-management.test.ts` 现有 happy path 用例的实际 payload 为准（S1 写的，照它的 register teamName/joinCode、hello 字段风格）。`deviceId: 'device-1'` = createIds 第 4 个。

- [ ] **Step 2：跑测试确认通过**
Run: `npm --workspace @agentbean/server-next test -- device-management`
Expected: PASS（S1 的 3 用例 + 本用例）。若失败：若是 systemInfo 没透传，查 `mapDevice`/`deviceHello`（应已工作）；若是 daemonVersion 没映射，查 Task 4 的 `toDeviceDto`。

- [ ] **Step 3：跑 server 全套（无回归）**
Run: `npm --workspace @agentbean/server-next test`
Expected: 全绿。

- [ ] **Step 4：提交**
```bash
git add apps/server-next/tests/device-management.test.ts
git commit -m "test(server-next): device hello 富字段端到端透传到 getDevice

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6：apps/web 类型对齐确认

**Files:** 可能 `apps/web/app/[networkPath]/devices/page.tsx`（仅类型，预期零 UI 改动）

- [ ] **Step 1：核查 apps/web 是否需改动**

读 `apps/web/app/[networkPath]/devices/page.tsx:313`（device 内联类型）+ `:519-534`（DeviceDetail InfoCard 渲染）。确认：
- `:313` 的 systemInfo 类型已期望富字段（osVersion/cpuModel/cpuCores/totalMemoryGB/nodeVersion/daemonVersion）——**应已存在**（UI 早就这么写）。
- `:519-534` 的 InfoCard 已用 `{device.systemInfo.X && ...}` 守卫渲染——**应已存在**。
- 因此 server 返回富字段后，apps/web **自动显示，零代码改动**。

若 `:313` 类型缺某个新字段（不应发生，但核查），补上类型。若 UI 缺某卡（不应发生），补。**预期：本 task 无代码改动或仅类型微调**。

- [ ] **Step 2：apps/web 类型检查 + 全套测试**
Run: `npx tsc -p apps/web/tsconfig.json --noEmit && npm --workspace agentbean-web test`
Expected: tsc 通过，测试绿。

- [ ] **Step 3：若有改动则提交，否则跳过**
```bash
git status --short apps/web
# 若有改动：
git add apps/web && git commit -m "chore(web): 对齐 device systemInfo 富字段类型

Co-Authored-By: Claude <noreply@anthropic.com>"
# 若无改动：本 task 无 commit
```

---

## 明确不在本计划范围

- **daemonVersionInfo.latest / updateAvailable**（S2b）：server-next 无"最新 daemon 版本"来源（grep 确认无 npm registry/配置/dist-tag）。需先定来源（配置常量 / 运行时查 npm）。
- **connectCommand**：`DeviceInviteDto.command` 仅 `createDeviceInvite` 返回（`device.ts:45`）；已接入设备无活跃 invite，"它的连接命令"语义模糊。需先定语义。
- **daemon 测试基础设施**：已确认 daemon-next 有 vitest + tests/，本计划直接用。

## Self-Review

1. **Spec 覆盖**：S2a = systemInfo 富字段 + daemonVersion current。contracts（Task 1）→ daemon collect（Task 2）→ daemon 接入 hello（Task 3）→ server toDeviceDto（Task 4）→ 端到端（Task 5）→ apps/web 对齐（Task 6）。apps/web UI 已就绪（`:519-534`），核心工作在 daemon 上报 + contracts + server 映射。✅
2. **占位符扫描**：每步含完整代码 + 命令；少数「先确认 X」（package.json 路径、DeviceDto import 风格、register/hello payload）给了具体核实方法，非空泛 TBD。✅
3. **一致性**：
   - daemonVersion：daemon 上报 systemInfo.daemonVersion + 顶层 daemonVersion（同值）；server 存 daemon_version 列 + system_info JSON；toDeviceDto 映射顶层；apps/web 读 systemInfo.daemonVersion（优先）+ 顶层（fallback）。全链一致。✅
   - systemInfo 富字段：daemon collect → hello payload → server JSON 透传（mapDevice/deviceHello 已就绪）→ DeviceDetailDto.systemInfo → apps/web InfoCard。无需 server 改 systemInfo 映射。✅
   - 存储：不重复造（daemon_version/system_info 列、mapDevice、deviceHello、DeviceHelloInput 全就绪）。✅
4. **顺序依赖**：Task 1（contracts）→ 2/3（daemon）→ 4（server）→ 5（端到端）→ 6（apps/web）。Task 5 端到端需要 1-4 全完成。✅
5. **apps/web 零改动预期**：`:519-534` 已渲染所有富字段 InfoCard，Task 6 预期无代码改动（仅核查）。这是 S2a 的最大简化。✅
