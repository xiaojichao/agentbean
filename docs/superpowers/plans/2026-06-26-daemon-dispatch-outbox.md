# Daemon Dispatch Outbox 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 daemon-next 在 socket 断开/重连期间绝不因上报失败崩溃，且 dispatch 结果（result/error）断线不丢失、重连后补发。

**Architecture:** 新增独立 `DispatchOutbox` 组件（内存 Map 队列，`sendOrEnqueue` 永不抛，`flush` 在重连后顺序补发）。dispatch handler 改用它上报 result/error；其余运行期裸 `emitWithAck`（snapshot 上报）改为容错 wrapper；daemon 入口加全局 `process.on` 兜底，三层防御。

**Tech Stack:** TypeScript、vitest、socket.io-client

## Global Constraints

- 范围仅 `apps/daemon-next`（spec：`docs/superpowers/specs/2026-06-26-daemon-dispatch-outbox-design.md`）。
- 注释用中文。
- 单测命令：`cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/<file>` ；全量：`npm --prefix apps/daemon-next run test`。
- 类型检查：`npm --prefix apps/daemon-next run build`（tsc，必须 0 error）。
- 不改 server 端协议；outbox 仅内存（不持久化）。

## File Structure

| 文件 | 责任 | 改动 |
|---|---|---|
| `apps/daemon-next/src/outbox.ts` | DispatchOutbox 组件 | 新增 |
| `apps/daemon-next/src/index.ts` | daemon 协议客户端；dispatch handler；snapshot 上报 | 改 |
| `apps/daemon-next/src/cli.ts` | socket.io 适配层 + daemon 入口 | 改 |
| `apps/daemon-next/tests/outbox.test.ts` | outbox 单元测试 | 新增 |
| `apps/daemon-next/tests/dispatch-pipeline.test.ts` | 断线补发 + 容错集成测试 | 改 |

---

## Task 1: DispatchOutbox 组件 + 单元测试

**Files:**
- Create: `apps/daemon-next/src/outbox.ts`
- Test: `apps/daemon-next/tests/outbox.test.ts`

**Interfaces:**
- Produces: `OutboxSocket { readonly connected: boolean; emitWithAck(event: string, payload: unknown): Promise<unknown> }`；`DispatchOutbox { sendOrEnqueue(event: string, payload: unknown): void; flush(): Promise<void>; size(): number }`；`createDispatchOutbox(socket: OutboxSocket, options?: { onWarn?: (m: string) => void }): DispatchOutbox`

- [ ] **Step 1: 写失败测试 `outbox.test.ts`**

创建 `apps/daemon-next/tests/outbox.test.ts`：

```ts
import { describe, expect, test, vi } from 'vitest';
import { createDispatchOutbox, type OutboxSocket } from '../src/outbox';

function createMockSocket(initial: { connected?: boolean; emitWithAck?: OutboxSocket['emitWithAck'] } = {}) {
  const state = { connected: initial.connected ?? true };
  const emitWithAck = initial.emitWithAck ?? vi.fn().mockResolvedValue({ ok: true });
  const socket: OutboxSocket = {
    get connected() { return state.connected; },
    emitWithAck,
  };
  return { socket, emitWithAck, setConnected: (c: boolean) => { state.connected = c; } };
}

describe('DispatchOutbox', () => {
  test('sendOrEnqueue 立即发送且不入队（已连接）', async () => {
    const { socket, emitWithAck } = createMockSocket({ connected: true });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1', agentId: 'a1' });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledWith('dispatch.result', { dispatchId: 'd1', agentId: 'a1' }));
    expect(outbox.size()).toBe(0);
  });

  test('sendOrEnqueue 断开时入队、不抛、不发送', () => {
    const { socket, emitWithAck } = createMockSocket({ connected: false });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    expect(emitWithAck).not.toHaveBeenCalled();
    expect(outbox.size()).toBe(1);
  });

  test('sendOrEnqueue 已连接但 emit reject 时入队、不抛、回调 onWarn', async () => {
    const emitWithAck = vi.fn().mockRejectedValue(new Error('socket has been disconnected'));
    const { socket } = createMockSocket({ connected: true, emitWithAck });
    const onWarn = vi.fn();
    const outbox = createDispatchOutbox(socket, { onWarn });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    await vi.waitFor(() => expect(outbox.size()).toBe(1));
    expect(onWarn).toHaveBeenCalled();
  });

  test('flush 顺序补发全部待发项，成功后清空', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd2' });
    expect(outbox.size()).toBe(2);
    setConnected(true);
    await outbox.flush();
    expect(emitWithAck).toHaveBeenCalledTimes(2);
    expect(emitWithAck).toHaveBeenNthCalledWith(1, 'dispatch.result', { dispatchId: 'd1' });
    expect(emitWithAck).toHaveBeenNthCalledWith(2, 'dispatch.result', { dispatchId: 'd2' });
    expect(outbox.size()).toBe(0);
  });

  test('flush 单项失败时该项留队、其余继续、不抛', async () => {
    const emitWithAck = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1' });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd2' });
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd3' });
    setConnected(true);
    await outbox.flush();
    expect(outbox.size()).toBe(1);
  });

  test('按 dispatchId 去重，保留最新', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket, setConnected } = createMockSocket({ connected: false, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('dispatch.result', { dispatchId: 'd1', body: 'first' });
    outbox.sendOrEnqueue('dispatch.error', { dispatchId: 'd1', error: 'second' });
    expect(outbox.size()).toBe(1);
    setConnected(true);
    await outbox.flush();
    expect(emitWithAck).toHaveBeenCalledTimes(1);
    expect(emitWithAck).toHaveBeenCalledWith('dispatch.error', { dispatchId: 'd1', error: 'second' });
  });

  test('payload 缺 dispatchId 时直接发送、永不入队', async () => {
    const emitWithAck = vi.fn().mockResolvedValue({ ok: true });
    const { socket } = createMockSocket({ connected: true, emitWithAck });
    const outbox = createDispatchOutbox(socket);
    outbox.sendOrEnqueue('some.event', { noDispatchId: true });
    await vi.waitFor(() => expect(emitWithAck).toHaveBeenCalledWith('some.event', { noDispatchId: true }));
    expect(outbox.size()).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/outbox.test.ts`
Expected: FAIL — `Failed to resolve import '../src/outbox'`（模块不存在）。

- [ ] **Step 3: 写实现 `outbox.ts`**

创建 `apps/daemon-next/src/outbox.ts`：

```ts
/**
 * DispatchOutbox：把 dispatch.result / dispatch.error 的上报与传输解耦。
 *
 * daemon 运行期间若 socket 断开，socket.io-client 会对所有 pending ack 同步
 * reject（"socket has been disconnected"）。直接 await emitWithAck 会让未捕获的
 * reject 变成 unhandledRejection，在 Node 上直接 crash 进程。
 *
 * outbox 保证 sendOrEnqueue 永不抛：已连接时即时发送（失败则入队），断开时直接
 * 入队；socket 重连后由 flush() 顺序补发，成功清队、失败留队。按 dispatchId 去重
 * ——一个 dispatch 只有一个终态（result 或 error），后到覆盖先到。
 */

export interface OutboxSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
}

export interface DispatchOutbox {
  sendOrEnqueue(event: string, payload: unknown): void;
  flush(): Promise<void>;
  size(): number;
}

export interface CreateDispatchOutboxOptions {
  onWarn?: (message: string) => void;
}

type OutboxItem = { event: string; payload: unknown };

export function createDispatchOutbox(
  socket: OutboxSocket,
  options: CreateDispatchOutboxOptions = {},
): DispatchOutbox {
  const onWarn = options.onWarn ?? (() => {});
  const queue = new Map<string, OutboxItem>();
  let flushing = false;

  function readDispatchId(payload: unknown): string | undefined {
    if (payload && typeof payload === 'object' && 'dispatchId' in payload) {
      const value = (payload as { dispatchId?: unknown }).dispatchId;
      return typeof value === 'string' ? value : undefined;
    }
    return undefined;
  }

  function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function trySend(item: OutboxItem): Promise<boolean> {
    try {
      await socket.emitWithAck(item.event, item.payload);
      return true;
    } catch (error) {
      onWarn(`dispatch outbox emit failed for ${item.event}: ${describeError(error)}`);
      return false;
    }
  }

  return {
    sendOrEnqueue(event, payload) {
      const item: OutboxItem = { event, payload };
      const dispatchId = readDispatchId(payload);
      if (!dispatchId) {
        // 无 dispatchId 无法去重，直接尝试发送；失败即放弃（不阻塞 dispatch 流程）。
        void trySend(item);
        return;
      }
      if (!socket.connected) {
        queue.set(dispatchId, item);
        return;
      }
      void (async () => {
        const ok = await trySend(item);
        if (!ok) {
          queue.set(dispatchId, item);
        }
      })();
    },
    async flush() {
      if (flushing) return;
      flushing = true;
      try {
        for (const [dispatchId, item] of Array.from(queue.entries())) {
          const ok = await trySend(item);
          if (ok) {
            queue.delete(dispatchId);
          }
        }
      } finally {
        flushing = false;
      }
    },
    size() {
      return queue.size;
    },
  };
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/outbox.test.ts`
Expected: PASS — 7 tests passed。

- [ ] **Step 5: 提交**

```bash
git add apps/daemon-next/src/outbox.ts apps/daemon-next/tests/outbox.test.ts
git commit -m "feat(daemon): 新增 DispatchOutbox 组件 + 单元测试

sendOrEnqueue 永不抛，断线入队、重连 flush 补发，按 dispatchId 去重。"
```

---

## Task 2: daemon 接入 outbox（connected 透传 + dispatch 改造 + 重连补发）

**Files:**
- Modify: `apps/daemon-next/src/index.ts`（接口 24-29；`start()` 144-160；dispatch handler 274/286）
- Modify: `apps/daemon-next/src/cli.ts`（`createSocketIoDaemonSocket` 165-197）
- Modify: `apps/daemon-next/tests/dispatch-pipeline.test.ts`（`createFakeSocket` 15-47 扩展；新增断线补发测试）
- Modify: `apps/daemon-next/tests/rescan-integration.test.ts`（`fakeSocket` 加 `connected` 满足新接口）

**Interfaces:**
- Consumes: Task 1 的 `createDispatchOutbox`、`DispatchOutbox`
- Produces: `DaemonProtocolSocket` 新增 `readonly connected: boolean`（结构上满足 `OutboxSocket`，故 `createDispatchOutbox(socket)` 可直接接收 daemon 内部 socket）

- [ ] **Step 1: 扩展 `dispatch-pipeline.test.ts` 的 `createFakeSocket` 并写失败测试**

把 `apps/daemon-next/tests/dispatch-pipeline.test.ts` 顶部 `FakeHarness` 接口与 `createFakeSocket`（9-47 行）整体替换为：

```ts
interface FakeHarness {
  socket: DaemonProtocolSocket;
  emits: Array<{ event: string; payload: unknown }>;
  deliver: (event: string, payload: unknown) => Promise<void>;
  setConnected: (connected: boolean) => void;
  reconnect: () => Promise<void>;
  setEmitError: (event: string, error: Error) => void;
}

function createFakeSocket(): FakeHarness {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => Promise<void>>>();
  const reconnectHandlers: Array<() => Promise<void>> = [];
  const emitErrors = new Map<string, Error>();
  const state = { connected: true };
  const socket: DaemonProtocolSocket = {
    get connected() { return state.connected; },
    async emitWithAck(event, payload) {
      emits.push({ event, payload });
      const error = emitErrors.get(event);
      if (error) throw error;
      if (event === AGENT_EVENTS.device.hello) {
        return { device: { id: 'dev-1' } };
      }
      return { ok: true };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    off(event, handler) {
      const list = handlers.get(event);
      if (list) {
        handlers.set(event, list.filter((h) => h !== handler));
      }
    },
    onReconnect(handler) {
      reconnectHandlers.push(handler);
    },
  };
  return {
    socket,
    emits,
    async deliver(event, payload) {
      for (const h of handlers.get(event) ?? []) {
        await h(payload);
      }
    },
    setConnected: (c) => { state.connected = c; },
    reconnect: async () => {
      for (const h of reconnectHandlers) await h();
    },
    setEmitError: (event, error) => { emitErrors.set(event, error); },
  };
}
```

在 `describe(...)` 块末尾追加新测试：

```ts
  test('dispatch 结果在 socket 断开时入队，重连后补发，且不抛', async () => {
    const harness = createFakeSocket();
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      fetch: async () => new Response('{}', { status: 200 }),
      executor: async () => ({ body: 'done' }),
    });
    await client.start();

    // 断开 socket 后投递 dispatch 请求
    harness.setConnected(false);
    const resultBefore = harness.emits.filter((e) => e.event === AGENT_EVENTS.dispatch.result).length;
    await harness.deliver(AGENT_EVENTS.dispatch.request, { id: 'disp-1', agentId: 'a1', prompt: 'hi' });
    await vi.waitFor(() => {
      expect(harness.emits.filter((e) => e.event === AGENT_EVENTS.dispatch.result).length).toBe(resultBefore);
    });

    // 重连，flush 补发 result
    harness.setConnected(true);
    await harness.reconnect();
    await vi.waitFor(() => {
      expect(
        harness.emits.some(
          (e) => e.event === AGENT_EVENTS.dispatch.result && (e.payload as { dispatchId?: string }).dispatchId === 'disp-1',
        ),
      ).toBe(true);
    });
  });
```

注意：新测试用到 `vi`，把文件顶部的 `import { describe, expect, test } from 'vitest';` 改为 `import { describe, expect, test, vi } from 'vitest';`。

- [ ] **Step 2: 给 `rescan-integration.test.ts` 的 fakeSocket 加 `connected`**

把 `apps/daemon-next/tests/rescan-integration.test.ts` 的 `fakeSocket`（6-17 行）里的 socket 对象加一个 getter：

```ts
function fakeSocket(): DaemonProtocolSocket & { emits: Array<{ event: string; payload: unknown }> } {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const socket: DaemonProtocolSocket = {
    get connected() { return true; },
    async emitWithAck(event, payload) {
      emits.push({ event, payload });
      if (event === AGENT_EVENTS.device.hello) return { device: { id: 'dev-1' } };
      return { ok: true };
    },
    on() {}, off() {},
  };
  return Object.assign(socket, { emits });
}
```

- [ ] **Step 3: 跑测试验证失败**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/dispatch-pipeline.test.ts`
Expected: FAIL — 新测试：dispatch.result 在断开时被直接 emit（因 dispatch handler 仍是裸 `await emitWithAck`，不关心 connected）→ `resultBefore` 断言失败；或若实现已让 emit 抛错则 `deliver` reject。

- [ ] **Step 4: `index.ts` 接口加 `connected`**

`apps/daemon-next/src/index.ts` 的 `DaemonProtocolSocket` 接口（24-29 行）加一行：

```ts
export interface DaemonProtocolSocket {
  readonly connected: boolean;
  emitWithAck(event: string, payload: unknown): Promise<unknown>;
  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  off?(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void;
  onReconnect?(handler: () => Promise<void>): void;
}
```

文件顶部 import 区加：`import { createDispatchOutbox, type DispatchOutbox } from './outbox.js';`

- [ ] **Step 5: `cli.ts` 适配层透传 `connected`**

`apps/daemon-next/src/cli.ts` 的 `createSocketIoDaemonSocket`（165-197 行）返回的对象加一个 getter（放在 `emitWithAck` 之前）：

```ts
  return {
    get connected() { return socket.connected; },
    emitWithAck(event, payload) {
      return socket.emitWithAck(event, payload);
    },
    on(event, handler) { /* 不变 */ },
    off(event, handler) { /* 不变 */ },
    onReconnect(handler) { /* 不变 */ },
  };
```

- [ ] **Step 6: `index.ts` 在 `start()` 创建 outbox + 重连 flush**

`createDaemonProtocolClient` 的 `start()`（151-160 行）改为：

```ts
    async start() {
      const initialAnnouncement = await announceDeviceSnapshot(socket, device, latestSnapshot.runtimes, latestSnapshot.agents);
      currentDeviceId = initialAnnouncement.deviceId;
      await applyCredentialsUpdate(initialAnnouncement.credentials);
      const cancelledDispatchIds = new Set<string>();
      const outbox: DispatchOutbox = createDispatchOutbox(socket, {
        onWarn: (message) => console.warn(message),
      });
      socket.onReconnect?.(async () => {
        const announcement = await announceDeviceSnapshot(socket, device, latestSnapshot.runtimes, latestSnapshot.agents);
        currentDeviceId = announcement.deviceId;
        await applyCredentialsUpdate(announcement.credentials);
        await outbox.flush();
      });
      // ... 之后的 socket.on(...) 注册保持不变
```

- [ ] **Step 7: `index.ts` dispatch handler 改用 outbox**

dispatch handler 末尾的 result 上报（274-281 行）与 catch 块 error 上报（286-290 行）改为 outbox：

```ts
          const artifacts = result.artifacts ?? [];
          const artifactIds = [...(result.artifactIds ?? []), ...productArtifactIds];
          outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.result, {
            dispatchId: request.id,
            agentId: request.agentId,
            body: result.body,
            ...(artifactIds.length > 0 ? { artifactIds } : {}),
            ...(artifacts.length > 0 ? { artifacts } : {}),
            ...(result.workspaceRun ? { workspaceRun: result.workspaceRun } : {}),
          });
        } catch (error) {
          if (cancelledDispatchIds.delete(request.id)) {
            return;
          }
          outbox.sendOrEnqueue(AGENT_EVENTS.dispatch.error, {
            dispatchId: request.id,
            agentId: request.agentId,
            error: readErrorMessage(error),
          });
        }
```

- [ ] **Step 8: 跑测试验证通过**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/dispatch-pipeline.test.ts`
Expected: PASS — 含新断线补发测试。

- [ ] **Step 9: 跑全量 + tsc**

Run: `npm --prefix apps/daemon-next run test && npm --prefix apps/daemon-next run build`
Expected: 全部测试通过，tsc 0 error。

- [ ] **Step 10: 提交**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/src/cli.ts apps/daemon-next/tests/dispatch-pipeline.test.ts apps/daemon-next/tests/rescan-integration.test.ts
git commit -m "fix(daemon): dispatch 结果走 outbox，断线入队重连补发

DaemonProtocolSocket 暴露 connected；dispatch handler 改用 outbox.sendOrEnqueue
上报 result/error（永不抛）；onReconnect 触发 outbox.flush 补发。修复 socket 断开
时 emit reject 导致 unhandledRecreation crash 的问题。"
```

---

## Task 3: 其余裸 emit 容错（snapshot 上报）

**Files:**
- Modify: `apps/daemon-next/src/index.ts`（`reportDeviceSnapshot` 342-359；`onReconnect` handler；新增 `safeEmit` helper）
- Modify: `apps/daemon-next/tests/dispatch-pipeline.test.ts`（新增 scanRequested 容错测试）

**Interfaces:** 无新对外接口。`safeEmit` 为 index.ts 内部 helper。

**背景：** rescan 周期路径已被 `rescan.ts` 的 tick try/catch 兜住，不会 crash。剩下两处未兜住的 async 路径：① scanRequested handler（socket.on 回调）里的 `reportDeviceSnapshot`；② `onReconnect` 里的 `announceDeviceSnapshot`（`createSocketIoDaemonSocket` 用 `void handler()` 吞 promise，reject 会变 unhandled）。本任务给 `reportDeviceSnapshot` 内部加容错，并给 onReconnect 加 try/catch 双保险。

- [ ] **Step 1: 写失败测试（scanRequested emit 失败不 crash）**

在 `dispatch-pipeline.test.ts` 的 describe 块末尾追加：

```ts
  test('scanRequested 在 snapshot 上报 emit 失败时不抛', async () => {
    const harness = createFakeSocket();
    harness.setEmitError(AGENT_EVENTS.device.runtimes, new Error('socket has been disconnected'));
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      fetch: async () => new Response('{}', { status: 200 }),
      executor: async () => ({ body: 'x' }),
      scan: async () => ({ runtimes: [{ adapterKind: 'codex', name: 'C', command: '/x' }], agents: [] }),
    });
    await client.start();
    // deliver 会 await handler；若 reportDeviceSnapshot 未容错，runtimes reject 会让 deliver 抛
    await harness.deliver(AGENT_EVENTS.device.scanRequested, { requestId: 'r1', deviceId: 'dev-1' });
    expect(harness.emits.some((e) => e.event === AGENT_EVENTS.device.runtimes)).toBe(true);
  });
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/dispatch-pipeline.test.ts -t "scanRequested"`
Expected: FAIL — `deliver` 因 `reportDeviceSnapshot` 的 runtimes reject 而抛错。

- [ ] **Step 3: `index.ts` 加 `safeEmit` helper 并改造 `reportDeviceSnapshot`**

在 `reportDeviceSnapshot`（342-359 行）上方新增 helper，并把函数体改为用它：

```ts
async function safeEmit(socket: DaemonProtocolSocket, event: string, payload: unknown): Promise<void> {
  try {
    await socket.emitWithAck(event, payload);
  } catch (error) {
    console.warn(`daemon emit ${event} failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function reportDeviceSnapshot(
  socket: DaemonProtocolSocket,
  teamId: string,
  deviceId: string,
  runtimes: DaemonRuntimeReport[],
  agents: DaemonAgentReport[],
): Promise<void> {
  await safeEmit(socket, AGENT_EVENTS.device.runtimes, { teamId, deviceId, runtimes });
  await safeEmit(socket, AGENT_EVENTS.agent.registerBatch, { teamId, deviceId, agents });
}
```

- [ ] **Step 4: `index.ts` 给 onReconnect handler 加 try/catch**

把 Task 2 写入的 onReconnect handler（Step 6）再加一层兜底：

```ts
      socket.onReconnect?.(async () => {
        try {
          const announcement = await announceDeviceSnapshot(socket, device, latestSnapshot.runtimes, latestSnapshot.agents);
          currentDeviceId = announcement.deviceId;
          await applyCredentialsUpdate(announcement.credentials);
        } catch (error) {
          console.warn(`daemon reconnect announce failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`);
        }
        await outbox.flush();
      });
```

- [ ] **Step 5: 跑测试验证通过**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/dispatch-pipeline.test.ts`
Expected: PASS — 含 scanRequested 容错测试。

- [ ] **Step 6: 跑全量 + tsc**

Run: `npm --prefix apps/daemon-next run test && npm --prefix apps/daemon-next run build`
Expected: 全绿，tsc 0 error。

- [ ] **Step 7: 提交**

```bash
git add apps/daemon-next/src/index.ts apps/daemon-next/tests/dispatch-pipeline.test.ts
git commit -m "fix(daemon): snapshot 上报与重连 announce 容错，断线不 crash

reportDeviceSnapshot 改用 safeEmit（runtimes/registerBatch 失败仅 warn）；
onReconnect handler 加 try/catch，避免 void handler 吞掉 reject 致 unhandled。"
```

---

## Task 4: 全局 process.on 兜底

**Files:**
- Modify: `apps/daemon-next/src/cli.ts`（`runDaemonNextCli` 317 起的函数体开头）

**Interfaces:** 无。

**目的：** 防御未来任何漏网的未捕获 reject/exception 不再杀进程（spec 第 3 层配套）。

- [ ] **Step 1: 写失败测试**

新建 `apps/daemon-next/tests/global-error-guard.test.ts`：

```ts
import { afterEach, describe, expect, test, vi } from 'vitest';

describe('daemon 全局错误兜底', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('注册 unhandledRejection 与 uncaughtException 处理器', async () => {
    const addSpy = vi.spyOn(process, 'on');
    vi.resetModules();
    await import('../src/cli');
    const events = addSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('unhandledRejection');
    expect(events).toContain('uncaughtException');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/global-error-guard.test.ts`
Expected: FAIL — `process.on` 未被调用注册这两个事件。

- [ ] **Step 3: `cli.ts` 模块顶层注册兜底**

在 `apps/daemon-next/src/cli.ts` 中（`runDaemonNextCli` 之前）新增 helper，并在**模块顶层**调用一次（幂等：import 即注册，确保生产入口 `bin.js` 加载本模块时最早生效，也让测试能通过 `import` 观察到注册行为）：

```ts
let globalErrorGuardsInstalled = false;
function installGlobalErrorGuards(): void {
  if (globalErrorGuardsInstalled) return;
  globalErrorGuardsInstalled = true;
  process.on('unhandledRejection', (reason) => {
    console.warn(`daemon unhandledRejection (suppressed): ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on('uncaughtException', (error) => {
    console.warn(`daemon uncaughtException (suppressed): ${error instanceof Error ? error.message : String(error)}`);
  });
}
installGlobalErrorGuards();
```

注意：必须放在模块顶层而非 `runDaemonNextCli` 函数体内——测试通过 `import '../src/cli'` 验证，import 不会执行函数体；放顶层才能让测试触发并观察到 `process.on` 调用。

- [ ] **Step 4: 跑测试验证通过**

Run: `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/global-error-guard.test.ts`
Expected: PASS。

- [ ] **Step 5: 跑全量 + tsc（最终回归）**

Run: `npm --prefix apps/daemon-next run test && npm --prefix apps/daemon-next run build`
Expected: daemon-next 全部测试通过，tsc 0 error。

- [ ] **Step 6: 提交**

```bash
git add apps/daemon-next/src/cli.ts apps/daemon-next/tests/global-error-guard.test.ts
git commit -m "feat(daemon): 全局 unhandledRejection/uncaughtException 兜底

入口注册 process.on 处理器，未捕获异常仅 warn 不退出进程，防御未来漏网 reject。"
```

---

## 收尾

- [ ] **最终回归**：`npm --prefix apps/daemon-next run test && npm --prefix apps/daemon-next run build`，确认全绿。
- [ ] **推送 + 开 PR**：base `main`，PR 描述引用 spec `docs/superpowers/specs/2026-06-26-daemon-dispatch-outbox-design.md` 与本计划，附崩溃栈与三层修复说明。
