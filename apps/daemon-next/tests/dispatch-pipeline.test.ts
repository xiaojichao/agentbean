import { mkdtempSync, realpathSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient } from '../src/index';
import type { DaemonProtocolSocket } from '../src/index';

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

describe('dispatch pipeline (attachments + product artifacts)', () => {
  test('downloads attachments, runs command, scans outputs, uploads, and reports artifact ids', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const harness = createFakeSocket();

    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/download')) {
        return new Response('attachment-body', { status: 200 });
      }
      if (url.includes('/artifacts/upload')) {
        return new Response(JSON.stringify({ ok: true, artifact: { id: 'srv-art-1' } }), {
          status: 201, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      fetch: fakeFetch,
      executor: async () => ({
        body: 'done',
        artifacts: [{ id: 'workspace-log-x', filename: 'workspace-run.log', mimeType: 'text/plain', contentBase64: 'bG9n' }],
        workspaceRun: { status: 'succeeded', cwd, exitCode: 0, startedAt: 1000, completedAt: 2000 },
      }),
    });
    await client.start();

    writeFileSync(join(cwd, 'result.png'), 'png-bytes');

    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'disp-1', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-1',
      agentId: 'agent-1', requestId: 'disp-1', prompt: 'do work',
      attachments: [{ id: 'att-1', name: 'in.txt' }],
      customAgent: { adapterKind: 'codex', command: 'echo', cwd },
    });

    const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
    expect(resultEmit).toBeTruthy();
    const payload = resultEmit!.payload as { artifactIds: string[]; artifacts: Array<{ id: string; filename?: string }> };
    const ids = payload.artifacts.map((a) => a.id);
    expect(ids).toEqual(['workspace-log-x']);
    expect(payload.artifactIds).toEqual(['srv-art-1']);

    const inputsDir = join(cwd, '.agentbean', 'runs', 'disp-1', 'inputs');
    expect(readdirSync(inputsDir)).toEqual(['att-1-in.txt']);
    const manifest = JSON.parse(readFileSync(join(cwd, '.agentbean', 'runs', 'disp-1', 'manifest.json'), 'utf8'));
    expect(manifest.files.some((f: { filename: string }) => f.filename === 'result.png')).toBe(true);
  });

  test('still reports dispatch result when no customAgent.cwd (no workspace, no scan)', async () => {
    const harness = createFakeSocket();
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [], agents: [],
      serverUrl: 'http://server.test',
      executor: async () => ({ body: 'stub' }),
    });
    await client.start();
    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'disp-2', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-2',
      agentId: 'agent-1', requestId: 'disp-2', prompt: 'hi',
    });
    const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
    expect(resultEmit).toBeTruthy();
    expect((resultEmit!.payload as { body: string }).body).toBe('stub');
  });

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
});
