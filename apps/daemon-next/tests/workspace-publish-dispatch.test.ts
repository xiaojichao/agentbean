/**
 * #1044 dispatch 端到端：run output 经 outputs/<publishIdentity> 原子发布。
 * - AC1：projection run 只收集 outputs/;inputs/logs/intermediates 与 manifest/response 不进入发布
 * - AC2：publish manifest 记录 baseline/hash/长度/进度/Server 返回身份,不含外部绝对路径
 * - AC5：结果回报送达后写 reportedAt 稳定标记
 * - AC8：Device-local Memory 正文注入 prompt,但不得进入 publish manifest、staged 文件或执行回报
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient, type DaemonProtocolSocket } from '../src/index';
import { readWorkspacePublishOutputManifest } from '../src/workspace-publish-output';
import { createLocalMemoryStore } from '../src/memory/local-memory-store';

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function fakeSocket(): {
  socket: DaemonProtocolSocket;
  emits: Array<{ event: string; payload: unknown }>;
  deliver(event: string, payload: unknown): Promise<void>;
} {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => Promise<void>>>();
  const socket: DaemonProtocolSocket = {
    connected: true,
    async emitWithAck(event, payload) {
      emits.push({ event, payload });
      if (event === AGENT_EVENTS.device.hello) return { device: { id: 'device-1' } };
      return { ok: true };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return {
    socket,
    emits,
    async deliver(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload);
    },
  };
}

/** 最小 staging Server:begin/put/get/commit,记录收到的 plan 与字节。 */
function fakeStagingFetch(state: {
  plans: Array<{ publishId: string; baselineRevisionId: string; files: Array<{ path: string }> }>;
  puts: Array<{ path: string; offset: number; length: number }>;
  commits: string[];
}): typeof fetch {
  const files = new Map<string, { receivedBytes: number; complete: boolean; expected: number }>();
  return (async (input: unknown, init?: { method?: string; headers?: Record<string, string>; body?: unknown }) => {
    const url = String(input);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (url.includes('/workspace-publish-staging/begin')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        publishId: string; baselineRevisionId: string;
        files: Array<{ path: string; expectedSizeBytes: number }>;
      };
      state.plans.push({ publishId: body.publishId, baselineRevisionId: body.baselineRevisionId, files: body.files });
      for (const file of body.files) {
        files.set(file.path, { receivedBytes: 0, complete: false, expected: file.expectedSizeBytes });
      }
      return json({
        ok: true,
        staging: {
          status: 'open',
          files: body.files.map((f) => ({ path: f.path, receivedBytes: 0, complete: false })),
        },
      });
    }
    if (url.includes('/workspace-publish-staging/put')) {
      const parsed = new URL(url);
      const path = parsed.searchParams.get('path')!;
      const offset = Number(parsed.searchParams.get('offset') ?? '0');
      const length = (init?.body as Uint8Array)?.byteLength ?? 0;
      state.puts.push({ path, offset, length });
      const current = files.get(path)!;
      current.receivedBytes = offset + length;
      current.complete = current.receivedBytes === current.expected;
      return json({
        ok: true,
        staging: {
          files: [...files.entries()].map(([p, f]) => ({ path: p, receivedBytes: f.receivedBytes, complete: f.complete })),
        },
      });
    }
    if (url.includes('/workspace-publish-staging/commit')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { publishId: string };
      state.commits.push(body.publishId);
      return json({
        ok: true,
        staging: { status: 'committed', committedRevisionId: 'rev-2' },
        workspace: {
          currentRevisionId: 'rev-2',
          currentRevision: {
            id: 'rev-2',
            files: [...files.keys()].map((p) => ({ path: p, artifactId: `art-${p}` })),
          },
        },
      });
    }
    if (url.includes('/workspace-publish-staging')) {
      return json({
        ok: true,
        staging: {
          status: 'open',
          files: [...files.entries()].map(([p, f]) => ({ path: p, receivedBytes: f.receivedBytes, complete: f.complete })),
        },
      });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('workspace publish dispatch (#1044)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('projection run 只把 outputs/ 确认文件经 publish identity 原子发布', async () => {
    const home = tempDir('publish-dispatch-home-');
    const previousAgentBeanHome = process.env.AGENTBEAN_HOME;
    process.env.AGENTBEAN_HOME = join(home, '.agentbean');
    const customCwd = tempDir('publish-dispatch-cwd-');
    const configuredOutputRoot = tempDir('publish-dispatch-configured-');
    const staging = { plans: [] as never[], puts: [] as never[], commits: [] as string[] };
    try {
      const harness = fakeSocket();
      const client = createDaemonProtocolClient({
        socket: harness.socket,
        device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok' },
        runtimes: [],
        agents: [],
        serverUrl: 'http://server.test',
        fetch: fakeStagingFetch(staging),
        homeDir: home,
        executor: async (request) => {
          const env = request.customAgent?.env ?? {};
          // 交付物 + 三个"绝不能被收集"的邻居:输入副本、日志、中间产物。
          writeFileSync(join(env.AGENTBEAN_OUTPUT_DIR ?? '', 'answer.md'), 'final answer');
          writeFileSync(join(env.AGENTBEAN_INPUT_DIR ?? '', 'seed.md'), 'frozen input');
          writeFileSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'logs', 'run.md'), 'log line');
          writeFileSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'intermediates', 'draft.md'), 'draft');
          mkdirSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'cache'), { recursive: true });
          writeFileSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'cache', 'cached.md'), 'cache');
          mkdirSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'snapshots', 'snapshot-1'), { recursive: true });
          writeFileSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'snapshots', 'snapshot-1', 'frozen.md'), 'snapshot');
          writeFileSync(join(env.AGENTBEAN_WORKSPACE ?? '', 'response.md'), 'response');
          writeFileSync(join(configuredOutputRoot, 'other-process.md'), 'not a projection output');
          return {
            body: 'done',
            workspaceRun: { status: 'succeeded', cwd: customCwd, startedAt: 1000, completedAt: 2000 },
          };
        },
      });
      await client.start();
      await harness.deliver(AGENT_EVENTS.dispatch.request, {
        id: 'disp-pub-1', requestId: 'req-pub-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'msg-1',
        agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1, workspaceRunId: 'run-1',
        workspaceRevisionId: 'rev-1', prompt: 'run',
        customAgent: {
          adapterKind: 'codex', command: 'codex', cwd: customCwd,
          env: { EXTRA_OUTPUT_DIR: configuredOutputRoot },
          artifactSourceRoots: [{
            id: 'configured-root', label: '额外输出', envVarName: 'EXTRA_OUTPUT_DIR', defaultRole: 'run_output', recursive: true,
          }],
        },
      });

      // 只发布 outputs/answer.md;inputs/logs/intermediates/cache/snapshots/response
      // 以及配置根的文件均不进入 Workspace revision。
      expect(staging.plans).toHaveLength(1);
      expect(staging.plans[0]).toMatchObject({ baselineRevisionId: 'rev-1' });
      expect((staging.plans[0] as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual(['answer.md']);
      expect(staging.commits).toHaveLength(1);

      const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
      const payload = resultEmit!.payload as { artifactIds?: string[] };
      expect(payload.artifactIds).toEqual(['art-answer.md']);

      // 批次落盘:outputs/<publishIdentity> 只有确认输出;manifest 记录进度与 Server 返回身份。
      const outputsRoot = join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'outputs');
      const batches = readdirSync(outputsRoot);
      expect(batches).toHaveLength(1);
      const batchDir = join(outputsRoot, batches[0]!);
      expect(readdirSync(batchDir).sort()).toEqual(['.agentbean-publish', 'answer.md']);
      const manifest = readWorkspacePublishOutputManifest(batchDir);
      expect(manifest).toMatchObject({
        publishIdentity: batches[0],
        baselineRevisionId: 'rev-1',
        status: 'committed',
        committedRevisionId: 'rev-2',
        agentId: 'agent-1',
        taskId: 'task-1',
        workspaceRunId: 'run-1',
      });
      expect(manifest?.files).toEqual([
        expect.objectContaining({ relativePath: 'answer.md', complete: true }),
      ]);
      expect(JSON.stringify(manifest)).not.toContain(home);
      expect(JSON.stringify(manifest)).not.toContain(customCwd);

      // run 回报送达后写 reportedAt 稳定标记(防重复回报)。
      await vi.waitFor(() => {
        const updated = readWorkspacePublishOutputManifest(batchDir);
        expect(typeof updated?.reportedAt).toBe('number');
      });
    } finally {
      if (previousAgentBeanHome === undefined) delete process.env.AGENTBEAN_HOME;
      else process.env.AGENTBEAN_HOME = previousAgentBeanHome;
    }
  });

  test('Device-local Memory 正文注入 prompt,但不进入 publish manifest/staged 文件/执行回报', async () => {
    const home = tempDir('publish-memory-home-');
    const agentBeanHome = join(home, '.agentbean');
    const previousAgentBeanHome = process.env.AGENTBEAN_HOME;
    process.env.AGENTBEAN_HOME = agentBeanHome;
    const customCwd = tempDir('publish-memory-cwd-');
    const canary = `DEVICE-LOCAL-MEMORY-CANARY-${Date.now()}`;
    const staging = { plans: [] as never[], puts: [] as never[], commits: [] as string[] };
    try {
      const store = await createLocalMemoryStore({ profileId: 'profile-a', baseDir: agentBeanHome });
      await store.upsert({
        teamId: 'team-1', kind: 'preference', scopeType: 'local-profile', sourceKind: 'manual',
        content: canary,
      });

      const harness = fakeSocket();
      let executedMemory: unknown;
      const client = createDaemonProtocolClient({
        socket: harness.socket,
        device: { teamId: 'team-1', ownerId: 'owner-1', token: 'tok', profileId: 'profile-a' },
        runtimes: [],
        agents: [],
        serverUrl: 'http://server.test',
        fetch: fakeStagingFetch(staging),
        homeDir: home,
        executor: async (request) => {
          executedMemory = request.memoryContext;
          writeFileSync(join(request.customAgent?.env?.AGENTBEAN_OUTPUT_DIR ?? '', 'answer.md'), 'final answer');
          return {
            body: 'done',
            workspaceRun: { status: 'succeeded', cwd: customCwd, startedAt: 1000, completedAt: 2000 },
          };
        },
      });
      await client.start();
      await harness.deliver(AGENT_EVENTS.dispatch.request, {
        id: 'disp-mem-1', requestId: 'req-mem-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'msg-1',
        agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1, workspaceRunId: 'run-1',
        workspaceRevisionId: 'rev-1', prompt: 'do work',
        customAgent: { adapterKind: 'codex', command: 'codex', cwd: customCwd },
      });

      // 注入确实发生(canary 到达执行上下文)……
      expect(JSON.stringify(executedMemory)).toContain(canary);

      // ……但 egress 全路径干净:staged 批次、publish manifest、执行回报、run 簿记。
      const outputsRoot = join(agentBeanHome, 'workspaces', 'team-1', 'channels', 'channel-1', 'outputs');
      const batches = readdirSync(outputsRoot);
      expect(batches).toHaveLength(1);
      const batchDir = join(outputsRoot, batches[0]!);
      expect(readFileSync(join(batchDir, 'answer.md'), 'utf8')).not.toContain(canary);
      expect(readFileSync(join(batchDir, '.agentbean-publish', 'manifest.json'), 'utf8')).not.toContain(canary);

      const resultEmit = harness.emits.find((e) => e.event === AGENT_EVENTS.dispatch.result);
      expect(JSON.stringify(resultEmit?.payload)).not.toContain(canary);

      const runDir = join(agentBeanHome, 'workspaces', 'team-1', 'channels', 'channel-1', 'runs', 'agent-1', 'task-1', '1', 'run-1');
      expect(readFileSync(join(runDir, 'manifest.json'), 'utf8')).not.toContain(canary);
    } finally {
      if (previousAgentBeanHome === undefined) delete process.env.AGENTBEAN_HOME;
      else process.env.AGENTBEAN_HOME = previousAgentBeanHome;
    }
  });
});
