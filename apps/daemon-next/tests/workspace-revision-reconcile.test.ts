import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createWorkspaceRevisionReconciler,
  isHardReconcileFailure,
  isTransportReconcileFailure,
  listLocalWorkspaceChannels,
  type ReconcileFetchResult,
} from '../src/workspace-revision-reconcile.js';

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('workspace-revision-reconcile', () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('listLocalWorkspaceChannels 枚举 team/channel 目录', () => {
    root = tempDir('ws-list-');
    mkdirSync(join(root, 'team-a', 'channels', 'ch-1'), { recursive: true });
    mkdirSync(join(root, 'team-a', 'channels', 'ch-2'), { recursive: true });
    mkdirSync(join(root, 'team-b', 'channels', 'ch-9'), { recursive: true });
    mkdirSync(join(root, 'team-empty'), { recursive: true });
    const listed = listLocalWorkspaceChannels(root)
      .map((ref) => `${ref.teamId}/${ref.channelId}`)
      .sort();
    expect(listed).toEqual(['team-a/ch-1', 'team-a/ch-2', 'team-b/ch-9']);
  });

  test('isHardReconcileFailure / isTransportReconcileFailure 分类', () => {
    expect(isHardReconcileFailure('FORBIDDEN')).toBe(true);
    expect(isHardReconcileFailure('HTTP_404')).toBe(true);
    // 401 不可负缓存：token 可能刚被 reconnect 刷新
    expect(isHardReconcileFailure('UNAUTHORIZED')).toBe(false);
    expect(isHardReconcileFailure('HTTP_401')).toBe(false);
    expect(isHardReconcileFailure('fetch failed')).toBe(false);
    expect(isTransportReconcileFailure('fetch failed')).toBe(true);
    expect(isTransportReconcileFailure('DOWNLOAD_FAILED')).toBe(true);
    expect(isTransportReconcileFailure('HTTP_502')).toBe(true);
    expect(isTransportReconcileFailure('FORBIDDEN')).toBe(false);
  });

  test('single-flight：并发 run 不并行扫，最多一轮 follow-up', async () => {
    root = tempDir('ws-sf-');
    for (const id of ['t1', 't2', 't3']) {
      mkdirSync(join(root, id, 'channels', 'c1'), { recursive: true });
    }

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchCalls: string[] = [];
    const gate = { release: undefined as (() => void) | undefined };
    const firstFetchStarted = new Promise<void>((resolve) => {
      gate.release = resolve;
    });

    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      async fetchCurrent(ref) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        fetchCalls.push(`${ref.teamId}/${ref.channelId}`);
        if (fetchCalls.length === 1) {
          gate.release?.();
          await new Promise((r) => setTimeout(r, 40));
        }
        inFlight -= 1;
        return { ok: true, revisionId: 'rev-local' };
      },
      hasLocalRevision: () => true,
      applyRevision: async () => ({ ok: true }),
    });

    const first = reconciler.run('startup');
    await firstFetchStarted;
    const second = await reconciler.run('reconnect');
    expect(second.skippedInFlight).toBe(true);
    const firstStats = await first;
    expect(firstStats.skippedInFlight).toBe(false);
    // 首轮 3 + follow-up 3，不会因 follow-up 期间再 schedule 而无限滚
    expect(fetchCalls).toHaveLength(6);
    expect(maxInFlight).toBe(1);
  });

  test('follow-up 期间再 schedule 不会连锁成第三轮', async () => {
    root = tempDir('ws-chain-');
    mkdirSync(join(root, 't1', 'channels', 'c1'), { recursive: true });

    let round = 0;
    const fetch = vi.fn(async () => {
      round += 1;
      // 每一轮执行期间都再 schedule 一次
      if (round <= 2) {
        setTimeout(() => {
          void reconciler.run('reconnect');
        }, 0);
      }
      await new Promise((r) => setTimeout(r, 20));
      return { ok: true, revisionId: 'rev' } as const;
    });

    const warns: string[] = [];
    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      fetchCurrent: fetch,
      hasLocalRevision: () => true,
      applyRevision: async () => ({ ok: true }),
      logWarn: (m) => warns.push(m),
    });

    await reconciler.run('startup');
    // 等待可能的链式微任务
    await new Promise((r) => setTimeout(r, 80));
    // 首轮 + 一轮 follow-up = 2 次 fetch（每轮 1 channel）
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(warns.some((m) => m.includes('dropped chained schedule'))).toBe(true);
  });

  test('负缓存：硬失败 channel 在 TTL 内不再请求；401 不缓存', async () => {
    root = tempDir('ws-neg-');
    mkdirSync(join(root, 'team-1', 'channels', 'good'), { recursive: true });
    mkdirSync(join(root, 'team-1', 'channels', 'gone'), { recursive: true });
    mkdirSync(join(root, 'team-1', 'channels', 'auth'), { recursive: true });

    let now = 1_000;
    const fetch = vi.fn(async (ref: { teamId: string; channelId: string }): Promise<ReconcileFetchResult> => {
      if (ref.channelId === 'gone') return { ok: false, error: 'FORBIDDEN', hardFailure: true };
      if (ref.channelId === 'auth') return { ok: false, error: 'UNAUTHORIZED' };
      return { ok: true, revisionId: 'rev-1' };
    });

    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      negativeCacheTtlMs: 60_000,
      now: () => now,
      fetchCurrent: fetch,
      hasLocalRevision: () => true,
      applyRevision: async () => ({ ok: true }),
    });

    const first = await reconciler.run('startup');
    expect(first.fetchFailed).toBe(2);
    expect(first.attempted).toBe(3);

    const second = await reconciler.run('reconnect');
    // gone 被负缓存跳过；auth 与 good 仍会请求
    expect(second.skippedNegativeCache).toBe(1);
    expect(second.attempted).toBe(2);
    expect(fetch.mock.calls.filter((c) => c[0].channelId === 'auth').length).toBe(2);
  });

  test('熔断：fetch 连续传输失败达到阈值后提前结束', async () => {
    root = tempDir('ws-cb-');
    for (let i = 0; i < 10; i += 1) {
      mkdirSync(join(root, `team-${i}`, 'channels', 'c1'), { recursive: true });
    }

    const fetch = vi.fn(async (): Promise<ReconcileFetchResult> => ({
      ok: false,
      error: 'fetch failed',
    }));

    const warns: string[] = [];
    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      circuitBreakerFailures: 3,
      fetchCurrent: fetch,
      hasLocalRevision: () => false,
      applyRevision: async () => ({ ok: true }),
      logWarn: (m) => warns.push(m),
    });

    const stats = await reconciler.run('startup');
    expect(stats.circuitBroken).toBe(true);
    expect(stats.attempted).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warns.some((m) => m.includes('circuit open'))).toBe(true);
  });

  test('熔断：apply 阶段 DOWNLOAD_FAILED 也计入连续传输失败', async () => {
    root = tempDir('ws-apply-cb-');
    for (let i = 0; i < 6; i += 1) {
      mkdirSync(join(root, `team-${i}`, 'channels', 'c1'), { recursive: true });
    }

    const apply = vi.fn(async () => ({ ok: false as const, error: 'DOWNLOAD_FAILED' }));
    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      circuitBreakerFailures: 3,
      fetchCurrent: async () => ({ ok: true, revisionId: 'rev-new' }),
      hasLocalRevision: () => false,
      applyRevision: apply,
    });

    const stats = await reconciler.run('startup');
    expect(stats.circuitBroken).toBe(true);
    expect(stats.applyFailed).toBe(3);
    expect(apply).toHaveBeenCalledTimes(3);
  });

  test('落后 revision 会 apply；已有 local 则跳过', async () => {
    root = tempDir('ws-apply-');
    mkdirSync(join(root, 'team-1', 'channels', 'c1', 'snapshots', 'rev-1'), { recursive: true });
    writeFileSync(join(root, 'team-1', 'channels', 'c1', 'snapshots', 'rev-1', '.keep'), '');

    const applied: string[] = [];
    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      async fetchCurrent() {
        return { ok: true, revisionId: 'rev-2' };
      },
      hasLocalRevision(_ref, revisionId) {
        return revisionId === 'rev-1';
      },
      async applyRevision(ref) {
        applied.push(ref.revisionId);
        return { ok: true };
      },
    });

    const stats = await reconciler.run('startup');
    expect(stats.applied).toBe(1);
    expect(applied).toEqual(['rev-2']);
  });
});
