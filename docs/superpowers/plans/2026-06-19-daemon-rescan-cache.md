# daemon-next 定时重扫 + scan 缓存 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** daemon-next 每 5min 自动重扫本机 runtime/agent(变化才上报)+ scan 缓存(首次连接快),补全运维健壮性。

**Architecture:** 纯 daemon 侧,server-next/contracts 零改动。新增 `rescan.ts`(`hasChanged` 纯函数 + `createRescanController` 定时器)、`scan-cache.ts`(load/save `scanned-agents.json`);`index.ts` start() 启动 rescan controller(report 闭包含 saveScanCache);`cli.ts` 首次 load 缓存→快速 announce→controller 后台刷新对比。不加心跳(socket.io ping/pong 已覆盖)。

**Tech Stack:** TypeScript(Node 22)、vitest、node:fs/node:os/node:path。无新依赖。

**对应 spec:** `docs/superpowers/specs/2026-06-19-daemon-rescan-cache-design.md`

**已验证假设:** `scan?: DaemonScanProvider` 已注入(index.ts:116);`reportDeviceSnapshot` 已存在(index.ts:287);`DaemonScanSnapshot = { runtimes, agents }`;cli `config.profileId` 可用。

---

## 文件结构

| 文件 | 责任 | 状态 |
|------|------|------|
| `apps/daemon-next/src/rescan.ts` | `hasChanged`(纯,对比 `(adapterKind,name,command)`) + `createRescanController`(定时器 + rescan loop) | 🆕 创建 |
| `apps/daemon-next/src/scan-cache.ts` | `loadScanCache`/`saveScanCache`/`scanCachePath`(`~/.agentbean/{profileId}/scanned-agents.json`) | 🆕 创建 |
| `apps/daemon-next/src/index.ts` | start() 启动 rescan controller;report 闭包含 saveScanCache;re-export 新模块 | ✏️ 修改 |
| `apps/daemon-next/src/cli.ts` | runDaemonNextCli 首次 loadScanCache→initial→saveScanCache | ✏️ 修改 |
| `apps/daemon-next/tests/*.test.ts` | hasChanged / rescan controller / scan-cache / cli 缓存测试 | 🆕 创建 |
| `packages/contracts` / `apps/server-next` | **零改动** |

---

## Task 1: rescan.ts — hasChanged + createRescanController

**Files:** Create `apps/daemon-next/src/rescan.ts`;Test `apps/daemon-next/tests/rescan.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/rescan.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import type { DaemonScanSnapshot } from '../src/index';
import { hasChanged, createRescanController } from '../src/rescan';

function snap(runtimes: Array<{ adapterKind: string; name: string; command?: string }> = [], agents: Array<{ name: string; adapterKind: string }> = []): DaemonScanSnapshot {
  return { runtimes, agents };
}

describe('hasChanged', () => {
  it('returns false for identical signatures', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex CLI', command: '/usr/bin/codex' }]);
    expect(hasChanged(a, a)).toBe(false);
  });

  it('returns false when entries differ only by order', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'claude-code', name: 'Claude', command: '/y' }]);
    const b = snap([{ adapterKind: 'claude-code', name: 'Claude', command: '/y' }, { adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    expect(hasChanged(a, b)).toBe(false);
  });

  it('returns true when a command path changes', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/old/codex' }]);
    const b = snap([{ adapterKind: 'codex', name: 'Codex', command: '/new/codex' }]);
    expect(hasChanged(a, b)).toBe(true);
  });

  it('returns true when a runtime is added or removed', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    const b = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'gemini', name: 'Gemini', command: '/g' }]);
    expect(hasChanged(a, b)).toBe(true);
  });

  it('ignores version field (only adapterKind/name/command matter)', () => {
    const a = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    const b = { runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x', version: '1.2.3', installed: true }], agents: [] };
    expect(hasChanged(a, b)).toBe(false);
  });
});

describe('createRescanController', () => {
  it('reports on change and skips when unchanged', async () => {
    const scan = vi.fn();
    const initial = snap([{ adapterKind: 'codex', name: 'Codex', command: '/x' }]);
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }], agents: [] }); // same -> no report
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'gemini', name: 'Gemini', command: '/g' }], agents: [] }); // changed -> report
    const reported: DaemonScanSnapshot[] = [];
    const controller = createRescanController({
      scan: scan as any,
      report: async (s) => { reported.push(s); },
      initial,
    });
    controller.start(); // immediate first tick (compare to initial)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect(reported).toHaveLength(0); // fresh == initial, no report
    await controller.tickNow(); // force next tick
    expect(reported).toHaveLength(1); // changed -> reported
    controller.stop();
  });

  it('swallows scan errors without throwing', async () => {
    const scan = vi.fn().mockRejectedValue(new Error('boom'));
    const controller = createRescanController({ scan: scan as any, report: async () => {}, initial: snap() });
    controller.start();
    await vi.waitFor(() => expect(scan).toHaveBeenCalled());
    controller.stop(); // no throw
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/rescan.test.ts`
Expected: FAIL —— `Cannot find module '../src/rescan'`

- [ ] **Step 3: 实现 rescan.ts**

```typescript
import type { DaemonScanProvider, DaemonScanSnapshot } from './index.js';

const DEFAULT_RESCAN_INTERVAL_MS = 5 * 60 * 1000;

/** Signature compares only (adapterKind, name, command) — order-independent, ignores version/installed. */
function signature(snap: DaemonScanSnapshot): string {
  const rt = [...snap.runtimes]
    .map((r) => `${r.adapterKind}|${r.name}|${r.command ?? ''}`)
    .sort()
    .join('\n');
  const ag = [...snap.agents]
    .map((a) => `${a.adapterKind}|${a.name}|${a.gatewayInstanceKey ?? ''}`)
    .sort()
    .join('\n');
  return `rt:\n${rt}\nag:\n${ag}`;
}

export function hasChanged(prev: DaemonScanSnapshot, next: DaemonScanSnapshot): boolean {
  return signature(prev) !== signature(next);
}

export interface RescanControllerOptions {
  scan: DaemonScanProvider;
  report: (snapshot: DaemonScanSnapshot) => Promise<void>;
  initial: DaemonScanSnapshot;
  intervalMs?: number;
  setIntervalFn?: typeof setInterval;
  clearTimeoutFn?: typeof clearTimeout;
}

export interface RescanController {
  start(): void;
  stop(): void;
  /** Force one rescan tick now (for tests / explicit refresh). */
  tickNow(): Promise<void>;
}

export function createRescanController(options: RescanControllerOptions): RescanController {
  const intervalMs = options.intervalMs ?? DEFAULT_RESCAN_INTERVAL_MS;
  const setIntervalFn = options.setIntervalFn ?? setInterval;
  let last: DaemonScanSnapshot = options.initial;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    try {
      const fresh = await options.scan();
      if (hasChanged(last, fresh)) {
        await options.report(fresh);
        last = fresh;
      }
    } catch {
      // scan/report failure is best-effort; next tick retries
    }
  }

  return {
    start() {
      void tick(); // immediate background refresh against `initial`
      timer = setIntervalFn(() => { void tick(); }, intervalMs);
      if (typeof timer?.unref === 'function') {
        timer.unref();
      }
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    tickNow: tick,
  };
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/rescan.test.ts` → PASS(7 tests)。全量 `cd apps/daemon-next && npx vitest run` 无回归(62 + 7 = 69)。

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/rescan.ts apps/daemon-next/tests/rescan.test.ts
git commit -m "feat(daemon-next): add rescan hasChanged and controller for periodic rescans"
```

---

## Task 2: scan-cache.ts — load/save scan 缓存

**Files:** Create `apps/daemon-next/src/scan-cache.ts`;Test `apps/daemon-next/tests/scan-cache.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/scan-cache.test.ts`:

```typescript
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DaemonScanSnapshot } from '../src/index';
import { loadScanCache, saveScanCache } from '../src/scan-cache';

const baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'scan-cache-')));

describe('scan-cache', () => {
  it('returns null when cache file does not exist', () => {
    expect(loadScanCache('nope', baseDir)).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    const dir = join(baseDir, 'corrupt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'scanned-agents.json'), '{ not json');
    expect(loadScanCache('corrupt', baseDir)).toBeNull();
  });

  it('round-trips a snapshot through save then load', () => {
    const snap: DaemonScanSnapshot = {
      runtimes: [{ adapterKind: 'codex', name: 'Codex CLI', command: '/usr/bin/codex' }],
      agents: [],
    };
    saveScanCache(snap, 'roundtrip', baseDir);
    const loaded = loadScanCache('roundtrip', baseDir);
    expect(loaded).toEqual(snap);
  });

  it('isolates caches per profileId', () => {
    const a: DaemonScanSnapshot = { runtimes: [{ adapterKind: 'codex', name: 'A', command: '/a' }], agents: [] };
    const b: DaemonScanSnapshot = { runtimes: [{ adapterKind: 'gemini', name: 'B', command: '/b' }], agents: [] };
    saveScanCache(a, 'prof-a', baseDir);
    saveScanCache(b, 'prof-b', baseDir);
    expect(loadScanCache('prof-a', baseDir)?.runtimes[0].name).toBe('A');
    expect(loadScanCache('prof-b', baseDir)?.runtimes[0].name).toBe('B');
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/scan-cache.test.ts`
Expected: FAIL —— `Cannot find module '../src/scan-cache'`

- [ ] **Step 3: 实现 scan-cache.ts**

```typescript
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonScanSnapshot } from './index.js';

function sanitizeProfile(profileId?: string): string {
  const raw = (profileId ?? 'default').trim() || 'default';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

/** Resolve cache file path. baseDir overrides ~/.agentbean for tests. */
export function scanCachePath(profileId?: string, baseDir?: string): string {
  const root = baseDir ?? join(homedir(), '.agentbean');
  return join(root, 'teams', sanitizeProfile(profileId), 'scanned-agents.json');
}

export function loadScanCache(profileId?: string, baseDir?: string): DaemonScanSnapshot | null {
  const file = scanCachePath(profileId, baseDir);
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.runtimes) || !Array.isArray(parsed.agents)) {
      return null;
    }
    return parsed as DaemonScanSnapshot;
  } catch {
    return null;
  }
}

export function saveScanCache(snapshot: DaemonScanSnapshot, profileId?: string, baseDir?: string): void {
  try {
    const file = scanCachePath(profileId, baseDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    // cache is an optimization; never throw on write failure
  }
}
```

- [ ] **Step 4: 运行验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/scan-cache.test.ts` → PASS(4)。全量无回归。

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/scan-cache.ts apps/daemon-next/tests/scan-cache.test.ts
git commit -m "feat(daemon-next): add scan result cache (load/save scanned-agents.json)"
```

---

## Task 3: index.ts 接入 rescan controller

**Files:** Modify `apps/daemon-next/src/index.ts`;Test `apps/daemon-next/tests/rescan-integration.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/daemon-next/tests/rescan-integration.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient } from '../src/index';
import type { DaemonProtocolSocket } from '../src/index';

function fakeSocket(): DaemonProtocolSocket {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const socket: DaemonProtocolSocket = {
    async emitWithAck(event, payload) {
      emits.push({ event, payload });
      if (event === AGENT_EVENTS.device.hello) return { device: { id: 'dev-1' } };
      return { ok: true };
    },
    on() {}, off() {},
  };
  return Object.assign(socket, { emits });
}

describe('createDaemonProtocolClient periodic rescan', () => {
  it('starts a rescan controller and reports when scan changes', async () => {
    const socket = fakeSocket() as DaemonProtocolSocket & { emits: any[] };
    const initial = { runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }], agents: [] };
    const scan = vi.fn();
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }], agents: [] }); // unchanged on first tick
    scan.mockResolvedValueOnce({ runtimes: [{ adapterKind: 'codex', name: 'Codex', command: '/x' }, { adapterKind: 'gemini', name: 'Gemini', command: '/g' }], agents: [] }); // changed on forced tick

    const client = createDaemonProtocolClient({
      socket, device: { teamId: 't1', ownerId: 'o1' },
      runtimes: initial.runtimes, agents: initial.agents,
      scan: scan as any,
      rescanIntervalMs: 60000,
    });
    await client.start();
    // immediate background tick ran (unchanged -> no extra runtimes emit)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));

    const runtimesEmitsBefore = socket.emits.filter((e) => e.event === AGENT_EVENTS.device.runtimes).length;
    await client.rescanNow?.();
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(2));
    const runtimesEmitsAfter = socket.emits.filter((e) => e.event === AGENT_EVENTS.device.runtimes).length;
    expect(runtimesEmitsAfter).toBeGreaterThan(runtimesEmitsBefore); // changed -> reported
    client.stop?.();
  });
});
```

- [ ] **Step 2: 运行验证失败**

Run: `cd apps/daemon-next && npx vitest run tests/rescan-integration.test.ts`
Expected: FAIL —— `rescanNow`/`stop` 不在 DaemonProtocolClient 接口(还没接入)

- [ ] **Step 3: 修改 index.ts**

顶部 import 加:
```typescript
import { createRescanController, type RescanController } from './rescan.js';
```

`CreateDaemonProtocolClientInput` 加可选 rescan interval:
```typescript
  rescanIntervalMs?: number;
```

`DaemonProtocolClient` 接口扩展(便于测试/显式刷新):
```typescript
export interface DaemonProtocolClient {
  start(): Promise<void>;
  rescanNow?(): Promise<void>;
  stop?(): void;
}
```

`createDaemonProtocolClient` 的 `start()` 末尾(`socket.on(AGENT_EVENTS.dispatch.request, ...)` 之后、return 之前)接入 controller:
```typescript
      let rescan: RescanController | undefined;
      if (scan) {
        rescan = createRescanController({
          scan,
          initial: { runtimes, agents },
          intervalMs: input.rescanIntervalMs,
          report: async (snap) => {
            await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snap.runtimes, snap.agents);
          },
        });
        rescan.start();
      }
```

并在返回的 client 对象加 `rescanNow`/`stop`:
```typescript
  return {
    async start() { /* ...existing... */ },
    rescanNow: rescan?.tickNow,
    stop: rescan?.stop,
  };
```

**注意**:`rescan` 在 `start()` 内创建(因为依赖 currentDeviceId 闭包),而 `rescanNow`/`stop` 需在返回对象暴露——用闭包变量提升到 `createDaemonProtocolClient` 作用域:`let rescan: RescanController | undefined;` 在 return 之前声明,`start()` 内赋值,`rescanNow`/`stop` 引用。

- [ ] **Step 4: 运行验证通过**

Run: `cd apps/daemon-next && npx vitest run tests/rescan-integration.test.ts` → PASS。全量无回归。`cd apps/daemon-next && npx tsc --noEmit` 无新错误。

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/tests/rescan-integration.test.ts
git commit -m "feat(daemon-next): start periodic rescan controller in protocol client"
```

---

## Task 4: cli.ts 首次 scan 缓存 + controller report 写缓存

**Files:** Modify `apps/daemon-next/src/cli.ts`(可能含 index.ts report 闭包加 saveScanCache);Test `apps/daemon-next/tests/cli.test.ts`(扩充)

- [ ] **Step 1: 扩充 cli.test.ts**

在 `apps/daemon-next/tests/cli.test.ts` 末尾加一个 test(确认 config 带 profileId 即可,缓存读写由 scan-cache.test 覆盖):
```typescript
  test('parseDaemonNextCliConfig exposes profileId for scan cache', () => {
    const config = parseDaemonNextCliConfig({
      argv: ['--team-id', 't1', '--owner-id', 'o1', '--profile-id', 'laptop'],
      env: {},
    });
    expect(config.profileId).toBe('laptop');
  });
```
(确认 `parseDaemonNextCliConfig` 已 import;若无,加 import。)

- [ ] **Step 2: 运行验证(应 PASS,config 已有 profileId)**

Run: `cd apps/daemon-next && npx vitest run tests/cli.test.ts`

- [ ] **Step 3: 修改 cli.ts runDaemonNextCli**

把首次扫描改为「load 缓存 → 用缓存或 fresh → 写缓存」:

import 加:
```typescript
import { loadScanCache, saveScanCache } from './scan-cache.js';
```

把 `const snapshot = await createBuiltinScanProvider()();`(runDaemonNextCli 内)替换为:
```typescript
  const cached = loadScanCache(config.profileId);
  const snapshot = cached ?? await createBuiltinScanProvider()();
  if (!cached) {
    saveScanCache(snapshot, config.profileId);
  }
```

- [ ] **Step 3b(可选,与 Task 3 report 闭包统一写缓存):** 在 index.ts 的 rescan `report` 闭包里,report 成功后也更新缓存(report 后 server 已知最新,缓存供下次启动):
```typescript
          report: async (snap) => {
            await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, snap.runtimes, snap.agents);
            saveScanCache(snap, device.profileId);
          },
```
(index.ts 顶部 `import { saveScanCache } from './scan-cache.js';`)。这样定时重扫发现变化时同步更新缓存,下次启动首次 announce 用最新缓存。

- [ ] **Step 4: 验证**

Run: `cd apps/daemon-next && npx vitest run` → 全量 PASS。`cd apps/daemon-next && npx tsc --noEmit` 无新错误。

- [ ] **Step 5: Commit**

```bash
git add apps/daemon-next/src/cli.ts apps/daemon-next/src/index.ts apps/daemon-next/tests/cli.test.ts
git commit -m "feat(daemon-next): use scan cache for fast first announce and persist on rescan"
```

---

## Task 5: 全量验证与 build

**Files:** 无新文件;全量 test + build + 文档。

- [ ] **Step 1: daemon-next 全量测试**
Run: `cd apps/daemon-next && npx vitest run` → 全 PASS(62 baseline + rescan 7 + scan-cache 4 + rescan-integration + cli)。

- [ ] **Step 2: 类型 + 构建**
Run: `cd apps/daemon-next && npx tsc --noEmit` → 0 errors。
Run(仓库根): `npm run build:daemon-next` → 通过。

- [ ] **Step 3: known-gaps 文档更新**
在 `agentbean-next/docs/known-gaps.md` 的 Daemon 缺口/Reconnect Guarantees 段补:定时重扫(5min)+ scan 缓存已落地(`apps/daemon-next/src/{rescan,scan-cache}.ts`);heartbeat 仍延后(socket.io ping/pong 覆盖连接活性)。

```bash
git add agentbean-next/docs/known-gaps.md
git commit -m "docs(agentbean-next): mark daemon periodic rescan + scan cache as landed"
```

- [ ] **Step 4: 手动烟测(可选,需本地 server + daemon)**
1. 起 server-next + daemon-next(profileId=test)。
2. 确认 `~/.agentbean/teams/test/scanned-agents.json` 写入。
3. 重启 daemon-next,确认首次 announce 更快(用缓存)。
4. 装一个新 runtime(如 gemini),等 5min(或调短 interval),确认 server 自动收到新 snapshot。

---

## 验证矩阵(self-review 对照 spec)

| spec 要求 | 对应 Task |
|-----------|-----------|
| 定时重扫 5min,变化才 report | Task 1(hasChanged + controller) + Task 3(接入) |
| scan 缓存 load/save | Task 2 |
| 首次 load 缓存快速 announce + 后台刷新对比 | Task 1(立即 tick) + Task 4(cli load) |
| 变化时更新缓存 | Task 4(report 闭包 saveScanCache) |
| server/contracts 零改动 | 全程不碰 |
| 不加心跳(socket.io ping/pong 覆盖) | 非目标 |
| 定时器 unref + 错误不崩 | Task 1(catch + unref) |
