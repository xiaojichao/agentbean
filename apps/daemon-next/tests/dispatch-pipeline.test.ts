import { mkdirSync, mkdtempSync, realpathSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient } from '../src/index';
import type { DaemonProtocolSocket } from '../src/index';
import { createLocalMemoryStore } from '../src/memory/local-memory-store';
import { persistWorkspaceRunManifest, persistWorkspaceRunResponse, prepareWorkspaceRun } from '../src/workspace-run';

async function touchFile(path: string, mtimeMs: number): Promise<void> {
  writeFileSync(path, 'image-bytes');
  const seconds = Math.floor(mtimeMs / 1000);
  utimesSync(path, seconds, seconds);
}

interface FakeHarness {
  socket: DaemonProtocolSocket;
  emits: Array<{ event: string; payload: unknown }>;
  deliver: (event: string, payload: unknown) => Promise<void>;
  deliverWithAck: (event: string, payload: unknown) => Promise<unknown>;
  setConnected: (connected: boolean) => void;
  reconnect: () => Promise<void>;
  setEmitError: (event: string, error: Error) => void;
  setEmitAck: (event: string, ack: unknown) => void;
}

function createFakeSocket(): FakeHarness {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(payload: unknown, ack?: (result: unknown) => void) => Promise<void>>>();
  const reconnectHandlers: Array<() => Promise<void>> = [];
  const emitErrors = new Map<string, Error>();
  const emitAcks = new Map<string, unknown>();
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
      if (emitAcks.has(event)) {
        return emitAcks.get(event);
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
    async deliverWithAck(event, payload) {
      let result: unknown;
      for (const h of handlers.get(event) ?? []) {
        await h(payload, (value) => { result = value; });
      }
      return result;
    },
    setConnected: (c) => { state.connected = c; },
    reconnect: async () => {
      for (const h of reconnectHandlers) await h();
    },
    setEmitError: (event, error) => { emitErrors.set(event, error); },
    setEmitAck: (event, ack) => { emitAcks.set(event, ack); },
  };
}

describe('dispatch pipeline (attachments + product artifacts)', () => {
  test('reads profile Memory from AGENTBEAN_HOME instead of the scanner homeDir', async () => {
    const agentBeanHome = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-agentbean-home-')));
    const scannerHome = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-scanner-home-')));
    const previousAgentBeanHome = process.env.AGENTBEAN_HOME;
    process.env.AGENTBEAN_HOME = agentBeanHome;
    try {
      const store = await createLocalMemoryStore({ profileId: 'profile-a', baseDir: agentBeanHome });
      await store.upsert({
        teamId: 'team-1', kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
        content: 'Use the profile-local runtime preference.',
      });
      const harness = createFakeSocket();
      let executedMemory: unknown;
      const client = createDaemonProtocolClient({
        socket: harness.socket,
        device: { teamId: 'team-1', ownerId: 'owner-1', profileId: 'profile-a' },
        runtimes: [], agents: [], serverUrl: 'http://server.test', homeDir: scannerHome,
        executor: async (request) => {
          executedMemory = request.memoryContext;
          return { body: 'done' };
        },
      });
      await client.start();
      await harness.deliver(AGENT_EVENTS.dispatch.request, {
        id: 'disp-profile-memory', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-1',
        agentId: 'agent-1', requestId: 'disp-profile-memory', prompt: 'do work',
      });
      expect(executedMemory).toMatchObject([{ content: 'Use the profile-local runtime preference.' }]);
    } finally {
      if (previousAgentBeanHome === undefined) delete process.env.AGENTBEAN_HOME;
      else process.env.AGENTBEAN_HOME = previousAgentBeanHome;
    }
  });

  test('downloads attachments, runs command, scans outputs, uploads, and reports artifact ids', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-home-')));
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
      homeDir,
      executor: async () => ({
        body: 'done',
        artifacts: [{ id: 'workspace-log-x', filename: 'workspace-run.log', mimeType: 'text/plain', contentBase64: 'bG9n' }],
        workspaceRun: { status: 'succeeded', cwd, exitCode: 0, startedAt: 1000, completedAt: 2000 },
        collaborationProposals: [{
          schemaVersion: 1, sourceInvocationId: 'invocation-live', sourceAgentId: 'agent-1',
          toAgentId: 'agent-2', kind: 'consult', objective: '请复核结果', reason: '需要第二视角',
          contextRefs: [], dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
          returnMode: 'return_to_manager',
        }],
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
    const manifestPath = join(cwd, '.agentbean', 'runs', 'disp-1', 'manifest.json');
    await vi.waitFor(() => {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      expect(typeof manifest.reportedAt).toBe('number');
    });
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.files.some((f: { filename: string }) => f.filename === 'result.png')).toBe(true);
    expect(manifest.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual(['workspace-log-x']);
    expect(manifest.collaborationProposals).toMatchObject([
      { sourceInvocationId: 'invocation-live', toAgentId: 'agent-2', kind: 'consult' },
    ]);
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

  test('does not scan Codex generated_images for non-Codex custom agents', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-home-')));
    const generatedImagesDir = join(homeDir, '.codex', 'generated_images');
    mkdirSync(generatedImagesDir, { recursive: true });
    await touchFile(join(generatedImagesDir, 'ig_non_codex.png'), 5000);
    const harness = createFakeSocket();
    const uploadFetch = vi.fn<typeof fetch>(async (input) => {
      if (String(input).includes('/artifacts/upload')) {
        return new Response(JSON.stringify({ ok: true, artifact: { id: 'srv-art-1' } }), {
          status: 201, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [], agents: [],
      serverUrl: 'http://server.test',
      fetch: uploadFetch,
      homeDir,
      executor: async () => ({
        body: 'done',
        workspaceRun: { status: 'succeeded', cwd, exitCode: 0, startedAt: 1000, completedAt: 2000 },
      }),
    });
    await client.start();

    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'disp-non-codex', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-1',
      agentId: 'agent-1', requestId: 'disp-non-codex', prompt: 'do work',
      customAgent: { adapterKind: 'claude', command: 'echo', cwd },
    });

    const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
    expect(resultEmit).toBeTruthy();
    expect((resultEmit!.payload as { artifactIds?: string[] }).artifactIds).toBeUndefined();
    expect(uploadFetch).not.toHaveBeenCalledWith(expect.stringContaining('/artifacts/upload'), expect.anything());
  });

  test('uploads Codex generated_images even when the request has no customAgent.cwd', async () => {
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-home-')));
    const generatedImagesDir = join(homeDir, '.codex', 'generated_images');
    mkdirSync(generatedImagesDir, { recursive: true });
    await touchFile(join(generatedImagesDir, 'ig_codex_native.png'), 5000);
    const harness = createFakeSocket();

    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [], agents: [],
      serverUrl: 'http://server.test',
      fetch: async (input) => {
        if (String(input).includes('/artifacts/upload')) {
          return new Response(JSON.stringify({ ok: true, artifact: { id: 'srv-codex-image' } }), {
            status: 201, headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
      homeDir,
      executor: async () => ({
        body: 'done',
        workspaceRun: { status: 'succeeded', exitCode: 0, startedAt: 1000, completedAt: 2000 },
      }),
    });
    await client.start();

    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'disp-codex-no-cwd', teamId: 'team-1', channelId: 'chan-1', messageId: 'msg-1',
      agentId: 'agent-1', requestId: 'disp-codex-no-cwd', prompt: 'draw',
      customAgent: { adapterKind: 'codex', command: 'codex' },
    });

    const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
    expect(resultEmit).toBeTruthy();
    expect((resultEmit!.payload as { artifactIds?: string[] }).artifactIds).toEqual(['srv-codex-image']);
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

  test('start recovers a completed persisted workspace run that was not reported before daemon restart', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const harness = createFakeSocket();
    const workspace = prepareWorkspaceRun(cwd, 'disp-recover');
    persistWorkspaceRunResponse(workspace, 'recovered reply');
    persistWorkspaceRunManifest(workspace, {
      runId: 'disp-recover',
      agentId: 'agent-1',
      channelId: 'chan-1',
      status: 'succeeded',
      cwd,
      exitCode: 0,
      startedAt: 1000,
      completedAt: 2000,
      artifactIds: ['srv-art-1'],
      artifacts: [{ id: 'workspace-log-x', filename: 'workspace-run.log', mimeType: 'text/plain', contentBase64: 'bG9n' }],
      collaborationProposals: [{
        schemaVersion: 1,
        sourceInvocationId: 'invocation-1',
        sourceAgentId: 'agent-1',
        toAgentId: 'agent-2',
        kind: 'consult',
        objective: '请复核结果',
        reason: '需要第二视角',
        contextRefs: [],
        dependencyResults: [],
        acceptanceCriteria: [],
        attachmentIds: [],
        returnMode: 'return_to_manager',
      }],
      files: [],
    });

    const executor = vi.fn(async () => ({ body: 'should not run' }));
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [],
      agents: [{
        name: 'Codex',
        adapterKind: 'codex',
        category: 'agentos-hosted',
        command: 'codex',
        cwd,
      }],
      serverUrl: 'http://server.test',
      fetch: async () => new Response('{}', { status: 200 }),
      executor,
    });

    await client.start();

    expect(executor).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(
        harness.emits.some(
          (e) => e.event === AGENT_EVENTS.dispatch.result
            && (e.payload as { dispatchId?: string }).dispatchId === 'disp-recover',
        ),
      ).toBe(true);
    });
    const resultEmit = harness.emits.find(
      (e) => e.event === AGENT_EVENTS.dispatch.result
        && (e.payload as { dispatchId?: string }).dispatchId === 'disp-recover',
    );
    expect(resultEmit).toBeTruthy();
    expect(resultEmit!.payload).toMatchObject({
      dispatchId: 'disp-recover',
      agentId: 'agent-1',
      body: 'recovered reply',
      artifactIds: ['srv-art-1'],
      artifacts: [{ id: 'workspace-log-x', filename: 'workspace-run.log', mimeType: 'text/plain', contentBase64: 'bG9n' }],
      collaborationProposals: [{
        sourceInvocationId: 'invocation-1',
        toAgentId: 'agent-2',
        kind: 'consult',
      }],
      workspaceRun: {
        status: 'succeeded',
        cwd,
        exitCode: 0,
        startedAt: 1000,
        completedAt: 2000,
      },
    });
    const reportedManifest = JSON.parse(readFileSync(workspace.manifestPath, 'utf8'));
    expect(typeof reportedManifest.reportedAt).toBe('number');
  });

  test('recovery keeps unaccepted ACK runs unreported and retries them on reconnect', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const harness = createFakeSocket();
    harness.setEmitAck(AGENT_EVENTS.dispatch.result, { ok: false, error: 'NOT_FOUND' });
    const workspace = prepareWorkspaceRun(cwd, 'disp-retry');
    persistWorkspaceRunResponse(workspace, 'retry reply');
    persistWorkspaceRunManifest(workspace, {
      runId: 'disp-retry',
      agentId: 'agent-1',
      channelId: 'chan-1',
      status: 'succeeded',
      cwd,
      startedAt: 1000,
      completedAt: 2000,
      files: [],
    });

    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [],
      agents: [{
        name: 'Codex',
        adapterKind: 'codex',
        category: 'agentos-hosted',
        command: 'codex',
        cwd,
      }],
      serverUrl: 'http://server.test',
      fetch: async () => new Response('{}', { status: 200 }),
      executor: async () => ({ body: 'should not run' }),
    });

    await client.start();
    await vi.waitFor(() => {
      expect(
        harness.emits.some(
          (e) => e.event === AGENT_EVENTS.dispatch.result
            && (e.payload as { dispatchId?: string }).dispatchId === 'disp-retry',
        ),
      ).toBe(true);
    });
    expect(JSON.parse(readFileSync(workspace.manifestPath, 'utf8')).reportedAt).toBeUndefined();

    harness.setEmitAck(AGENT_EVENTS.dispatch.result, { ok: true });
    await harness.reconnect();
    await vi.waitFor(() => {
      const reportedManifest = JSON.parse(readFileSync(workspace.manifestPath, 'utf8'));
      expect(typeof reportedManifest.reportedAt).toBe('number');
    });
  });

  test('scanRequested custom agent cwd makes persisted workspace runs recoverable', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-')));
    const harness = createFakeSocket();
    const workspace = prepareWorkspaceRun(cwd, 'disp-custom-cwd');
    persistWorkspaceRunResponse(workspace, 'custom cwd reply');
    persistWorkspaceRunManifest(workspace, {
      runId: 'disp-custom-cwd',
      agentId: 'custom-agent-1',
      channelId: 'chan-1',
      cwd,
      startedAt: 1000,
      completedAt: 2000,
      files: [],
    });

    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      fetch: async () => new Response('{}', { status: 200 }),
      executor: async () => ({ body: 'should not run' }),
    });

    await client.start();
    expect(
      harness.emits.some(
        (e) => e.event === AGENT_EVENTS.dispatch.result
          && (e.payload as { dispatchId?: string }).dispatchId === 'disp-custom-cwd',
      ),
    ).toBe(false);

    await harness.deliver(AGENT_EVENTS.device.scanRequested, {
      requestId: 'scan-1',
      deviceId: 'dev-1',
      customAgents: [{ id: 'custom-agent-1', adapterKind: 'codex', cwd }],
    });

    await vi.waitFor(() => {
      expect(
        harness.emits.some(
          (e) => e.event === AGENT_EVENTS.dispatch.result
            && (e.payload as { dispatchId?: string }).dispatchId === 'disp-custom-cwd'
            && (e.payload as { workspaceRun?: { status?: string } }).workspaceRun?.status === 'succeeded',
        ),
      ).toBe(true);
    });
  });

  test('scanRequested custom agent cwd is included in local Memory governance summaries', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-custom-memory-')));
    const agentBeanHome = realpathSync(mkdtempSync(join(tmpdir(), 'pipe-custom-memory-home-')));
    const previousAgentBeanHome = process.env.AGENTBEAN_HOME;
    process.env.AGENTBEAN_HOME = agentBeanHome;
    try {
      const store = await createLocalMemoryStore({ profileId: 'profile-a', cwd, baseDir: agentBeanHome });
      await store.upsert({
        teamId: 'team-1', cwd, kind: 'procedural', scopeType: 'local-workspace', sourceKind: 'manual',
        content: 'custom workspace body', summary: 'Custom workspace summary',
      });
      const harness = createFakeSocket();
      const client = createDaemonProtocolClient({
        socket: harness.socket,
        device: { teamId: 'team-1', ownerId: 'owner-1', profileId: 'profile-a' },
        runtimes: [], agents: [], serverUrl: 'http://server.test',
        fetch: async () => new Response('{}', { status: 200 }),
        executor: async () => ({ body: 'should not run' }),
      });
      await client.start();
      await harness.deliver(AGENT_EVENTS.device.scanRequested, {
        requestId: 'scan-memory', deviceId: 'dev-1',
        customAgents: [{ id: 'custom-agent-1', adapterKind: 'codex', cwd }],
      });

      const ack = await harness.deliverWithAck(AGENT_EVENTS.memory.governanceSummaryRequested, { teamId: 'team-1' });
      expect(ack).toMatchObject({
        ok: true,
        summaries: [expect.objectContaining({ summary: 'Custom workspace summary' })],
      });
    } finally {
      if (previousAgentBeanHome === undefined) delete process.env.AGENTBEAN_HOME;
      else process.env.AGENTBEAN_HOME = previousAgentBeanHome;
    }
  });

  test('scanRequested 在 snapshot 上报 emit 失败时不抛', async () => {
    const harness = createFakeSocket();
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
    harness.setEmitError(AGENT_EVENTS.device.runtimes, new Error('socket has been disconnected'));
    // deliver 会 await handler；若 reportDeviceSnapshot 未容错，runtimes reject 会让 deliver 抛
    await harness.deliver(AGENT_EVENTS.device.scanRequested, { requestId: 'r1', deviceId: 'dev-1' });
    expect(harness.emits.some((e) => e.event === AGENT_EVENTS.device.runtimes)).toBe(true);
  });

  test('初始 snapshot 上报 emit 失败时 start 不伪装成功', async () => {
    const harness = createFakeSocket();
    harness.setEmitError(AGENT_EVENTS.agent.registerBatch, new Error('socket has been disconnected'));
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      fetch: async () => new Response('{}', { status: 200 }),
      executor: async () => ({ body: 'x' }),
    });

    await expect(client.start()).rejects.toThrow('socket has been disconnected');
  });
});
