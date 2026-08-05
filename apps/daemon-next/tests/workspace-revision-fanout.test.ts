/**
 * #1084 切片2 daemon 侧：workspace revision commit fan-out 落地。
 *
 * 覆盖：
 * 1. fetchProjectChannelWorkspaceRevision 拉 revision 完整文件清单。
 * 2. prepareChannelWorkspaceRevisionSnapshot 计算 snapshots/<revisionId>/ 路径。
 * 3. 收到 revisionCommitted → applyIncomingWorkspaceRevision → snapshots/<revisionId>/ 出现文件。
 * 4. 重复事件幂等（materialize 冲突预检兜底）。
 * 5. 离线 reconnect reconcile 拉到新 revision。
 */
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createDaemonProtocolClient,
  fetchProjectChannelWorkspaceRevision,
  prepareChannelWorkspaceRevisionSnapshot,
  type DaemonDeviceConfig,
  type DaemonProtocolSocket,
  type StubExecutor,
} from '../src/index';

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

class FakeAgentSocket implements DaemonProtocolSocket {
  readonly emitted: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void>>();
  private reconnectHandler: (() => Promise<void>) | undefined;

  get connected(): boolean { return true; }

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    if (event === AGENT_EVENTS.device.hello) {
      return { ok: true, device: { id: 'device-1' } };
    }
    return { ok: true };
  }

  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  onReconnect(handler: () => Promise<void>): void {
    this.reconnectHandler = handler;
  }

  async trigger(event: string, payload: unknown): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler for ${event}`);
    await handler(payload);
  }

  async triggerReconnect(): Promise<void> {
    if (!this.reconnectHandler) throw new Error('No reconnect handler');
    await this.reconnectHandler();
  }
}

/** Mock fetch：处理 project-channel-workspace GET + artifact download GET。 */
function createFanoutFetch(options: {
  revisions: Map<string, { path: string; artifactId: string; filename: string; content: Buffer }[]>;
  currentRevisionId: () => string;
}): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.includes('/project-channel-workspace')) {
      const parsed = new URL(url);
      const revisionIdParam = parsed.searchParams.get('revisionId') ?? undefined;
      const revisionId = revisionIdParam ?? options.currentRevisionId();
      const files = options.revisions.get(revisionId) ?? [];
      return new Response(JSON.stringify({
        ok: true,
        workspace: {
          currentRevisionId: revisionId,
          currentRevision: {
            id: revisionId,
            files: files.map((f) => ({
              path: f.path,
              artifactId: f.artifactId,
              filename: f.filename,
              sizeBytes: f.content.length,
              sha256: undefined,
            })),
          },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/artifacts/') && url.includes('/download')) {
      const match = url.match(/\/artifacts\/([^/]+)\/download/);
      const artifactId = match?.[1] ?? '';
      for (const files of options.revisions.values()) {
        const found = files.find((f) => f.artifactId === artifactId);
        if (found) {
          return new Response(found.content, { status: 200 });
        }
      }
      return new Response('NOT_FOUND', { status: 404 });
    }
    return new Response('NOT_FOUND', { status: 404 });
  }) as typeof fetch;
}

describe('daemon workspace revision fan-out (#1084)', () => {
  describe('fetchProjectChannelWorkspaceRevision', () => {
    test('返回完整文件清单（含 path/artifactId/filename/sizeBytes/sha256）', async () => {
      const fetchFn = (async (input: unknown) => {
        const url = String(input);
        if (url.includes('/project-channel-workspace')) {
          return new Response(JSON.stringify({
            ok: true,
            workspace: {
              currentRevisionId: 'rev-1',
              currentRevision: {
                id: 'rev-1',
                files: [
                  { path: 'a.txt', artifactId: 'art-a', filename: 'a.txt', sizeBytes: 4, sha256: 'deadbeef' },
                  { path: 'b/c.txt', artifactId: 'art-b', filename: 'c.txt', sizeBytes: 8 },
                ],
              },
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('NOT_FOUND', { status: 404 });
      }) as typeof fetch;

      const result = await fetchProjectChannelWorkspaceRevision({
        serverUrl: 'http://server.test', token: 'tok',
        teamId: 'team-1', channelId: 'channel-1', revisionId: 'rev-1', fetch: fetchFn,
      });
      expect(result).toMatchObject({
        ok: true,
        revisionId: 'rev-1',
        files: [
          { path: 'a.txt', artifactId: 'art-a', filename: 'a.txt', sizeBytes: 4, sha256: 'deadbeef' },
          { path: 'b/c.txt', artifactId: 'art-b', filename: 'c.txt', sizeBytes: 8 },
        ],
      });
    });

    test('SERVER_URL_MISSING / 服务端错误返回 ok:false', async () => {
      const ok1 = await fetchProjectChannelWorkspaceRevision({
        serverUrl: '', token: 'tok', teamId: 't', channelId: 'c', fetch: (async () => new Response()) as typeof fetch,
      });
      expect(ok1).toMatchObject({ ok: false, error: 'SERVER_URL_MISSING' });

      const ok2 = await fetchProjectChannelWorkspaceRevision({
        serverUrl: 'http://server.test', token: 'tok',
        teamId: 't', channelId: 'c', revisionId: 'r',
        fetch: (async () => new Response(JSON.stringify({ ok: false, error: 'FORBIDDEN' }), { status: 403 })) as typeof fetch,
      });
      expect(ok2).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });
  });

  describe('prepareChannelWorkspaceRevisionSnapshot', () => {
    test('返回 channelProjectionRoot/snapshots/<revisionId>/ 路径', () => {
      const agentBeanHome = tempDir('snapshot-path-');
      const dir = prepareChannelWorkspaceRevisionSnapshot({
        agentBeanHome,
        teamId: 'team-1',
        channelId: 'channel-1',
        revisionId: 'rev-1',
      });
      expect(dir).toBe(join(agentBeanHome, 'workspaces', 'team-1', 'channels', 'channel-1', 'snapshots', 'rev-1'));
      expect(existsSync(dir)).toBe(true);
      rmSync(agentBeanHome, { recursive: true, force: true });
    });

    test('非法 revisionId 抛错（路径逃逸防御）', () => {
      const agentBeanHome = tempDir('snapshot-invalid-');
      expect(() => prepareChannelWorkspaceRevisionSnapshot({
        agentBeanHome,
        teamId: 'team-1',
        channelId: 'channel-1',
        revisionId: '../escape',
      })).toThrow();
      rmSync(agentBeanHome, { recursive: true, force: true });
    });
  });

  describe('socket revisionCommitted handler', () => {
    let previousAgentBeanHome: string | undefined;
    let home: string;

    beforeEach(() => {
      home = tempDir('daemon-fanout-');
      previousAgentBeanHome = process.env.AGENTBEAN_HOME;
      process.env.AGENTBEAN_HOME = join(home, '.agentbean');
    });
    afterEach(() => {
      if (previousAgentBeanHome === undefined) delete process.env.AGENTBEAN_HOME;
      else process.env.AGENTBEAN_HOME = previousAgentBeanHome;
      rmSync(home, { recursive: true, force: true });
    });

    test('收到 revisionCommitted → snapshots/<revisionId>/ 出现文件；重复事件幂等', async () => {
      const contentA = Buffer.from('file-a-content');
      const contentB = Buffer.from('file-b-content');
      const revisions = new Map<string, { path: string; artifactId: string; filename: string; content: Buffer }[]>();
      revisions.set('rev-1', [
        { path: 'a.txt', artifactId: 'art-a', filename: 'a.txt', content: contentA },
        { path: 'dir/b.txt', artifactId: 'art-b', filename: 'b.txt', content: contentB },
      ]);
      const fetchFn = createFanoutFetch({ revisions, currentRevisionId: () => 'rev-1' });

      const socket = new FakeAgentSocket();
      const executor: StubExecutor = async () => 'stub';
      const device: DaemonDeviceConfig = {
        teamId: 'team-1', ownerId: 'user-1', token: 'device-token',
      };
      const client = createDaemonProtocolClient({
        socket, executor, device,
        runtimes: [], agents: [],
        serverUrl: 'http://server.test',
        fetch: fetchFn,
        homeDir: home,
      });
      await client.start();

      // 触发 revisionCommitted。
      await socket.trigger(AGENT_EVENTS.workspace.revisionCommitted, {
        teamId: 'team-1', channelId: 'channel-1', workspaceId: 'ws-1', revisionId: 'rev-1',
      });
      // fire-and-forget：等 applyIncomingWorkspaceRevision 完成。
      const snapshotDir = join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'snapshots', 'rev-1');
      await vi.waitFor(() => {
        expect(existsSync(join(snapshotDir, 'a.txt'))).toBe(true);
        expect(existsSync(join(snapshotDir, 'dir', 'b.txt'))).toBe(true);
      });

      // 重复事件幂等：materialize 冲突预检兜底（CONFLICT 警告 non-blocking）。
      await socket.trigger(AGENT_EVENTS.workspace.revisionCommitted, {
        teamId: 'team-1', channelId: 'channel-1', workspaceId: 'ws-1', revisionId: 'rev-1',
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      // 文件仍在，无崩溃，无 duplication（同路径不覆盖）。
      expect(existsSync(join(snapshotDir, 'a.txt'))).toBe(true);
      expect(existsSync(join(snapshotDir, 'dir', 'b.txt'))).toBe(true);
    });

    test('deviceId 过滤：非本机 deviceId 时忽略', async () => {
      const revisions = new Map<string, { path: string; artifactId: string; filename: string; content: Buffer }[]>();
      revisions.set('rev-x', [
        { path: 'x.txt', artifactId: 'art-x', filename: 'x.txt', content: Buffer.from('x') },
      ]);
      const fetchFn = createFanoutFetch({ revisions, currentRevisionId: () => 'rev-x' });

      const socket = new FakeAgentSocket();
      const client = createDaemonProtocolClient({
        socket, executor: async () => 'stub',
        device: { teamId: 'team-1', ownerId: 'user-1', token: 'tok' },
        runtimes: [], agents: [],
        serverUrl: 'http://server.test', fetch: fetchFn, homeDir: home,
      });
      await client.start();

      // deviceId 是别的设备 → 早退，不 materialize。
      await socket.trigger(AGENT_EVENTS.workspace.revisionCommitted, {
        teamId: 'team-1', channelId: 'channel-1', workspaceId: 'ws', revisionId: 'rev-x',
        deviceId: 'other-device',
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(existsSync(join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'snapshots', 'rev-x'))).toBe(false);
    });

    test('离线 reconnect reconcile 拉到新 revision', async () => {
      const contentV1 = Buffer.from('v1');
      const contentV2 = Buffer.from('v2-content');
      const revisions = new Map<string, { path: string; artifactId: string; filename: string; content: Buffer }[]>();
      revisions.set('rev-1', [
        { path: 'doc.txt', artifactId: 'art-v1', filename: 'doc.txt', content: contentV1 },
      ]);
      revisions.set('rev-2', [
        { path: 'doc.txt', artifactId: 'art-v2', filename: 'doc.txt', content: contentV2 },
      ]);
      let currentRev = 'rev-1';
      const fetchFn = createFanoutFetch({ revisions, currentRevisionId: () => currentRev });

      const socket = new FakeAgentSocket();
      const client = createDaemonProtocolClient({
        socket, executor: async () => 'stub',
        device: { teamId: 'team-1', ownerId: 'user-1', token: 'tok' },
        runtimes: [], agents: [],
        serverUrl: 'http://server.test', fetch: fetchFn, homeDir: home,
      });
      await client.start();

      // 第一次：rev-1 落地。
      await socket.trigger(AGENT_EVENTS.workspace.revisionCommitted, {
        teamId: 'team-1', channelId: 'channel-1', workspaceId: 'ws', revisionId: 'rev-1',
      });
      const snapshotsDir = join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'snapshots');
      await vi.waitFor(() => {
        expect(existsSync(join(snapshotsDir, 'rev-1', 'doc.txt'))).toBe(true);
      });

      // 离线期间服务端推进到 rev-2。
      currentRev = 'rev-2';

      // 重连：reconcile 发现本地只有 rev-1，server current 是 rev-2，拉取并 apply。
      await socket.triggerReconnect();
      await vi.waitFor(() => {
        expect(existsSync(join(snapshotsDir, 'rev-2', 'doc.txt'))).toBe(true);
      });

      // rev-1 快照仍保留（snapshots 是只读镜像，不清理）。
      expect(existsSync(join(snapshotsDir, 'rev-1', 'doc.txt'))).toBe(true);
    });
  });
});
