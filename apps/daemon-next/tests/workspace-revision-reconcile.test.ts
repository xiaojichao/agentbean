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
    expect(isHardReconcileFailure('fetch failed')).toBe(false);
    expect(isTransportReconcileFailure('fetch failed')).toBe(true);
    expect(isTransportReconcileFailure('HTTP_502')).toBe(true);
    expect(isTransportReconcileFailure('FORBIDDEN')).toBe(false);
  });

  test('single-flight：并发 schedule/run 不并行扫，结束后最多补一轮', async () => {
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
          // 卡住第一轮，等第二个 run 进来被 skippedInFlight
          await new Promise((r) => setTimeout(r, 40));
        }
        inFlight -= 1;
        return { ok: true, revisionId: 'rev-local' };
      },
      hasLocalRevision: () => true,
      applyRevision: async () => undefined,
    });

    const first = reconciler.run('startup');
    await firstFetchStarted;
    const second = await reconciler.run('reconnect');
    expect(second.skippedInFlight).toBe(true);
    const firstStats = await first;
    expect(firstStats.skippedInFlight).toBe(false);
    // 第一轮 3 次 + 合并 follow-up 再 3 次
    expect(fetchCalls).toHaveLength(6);
    expect(maxInFlight).toBe(1);
  });

  test('负缓存：硬失败 channel 在 TTL 内不再请求', async () => {
    root = tempDir('ws-neg-');
    mkdirSync(join(root, 'team-1', 'channels', 'good'), { recursive: true });
    mkdirSync(join(root, 'team-1', 'channels', 'gone'), { recursive: true });

    let now = 1_000;
    const fetch = vi.fn(async (ref: { teamId: string; channelId: string }): Promise<ReconcileFetchResult> => {
      if (ref.channelId === 'gone') return { ok: false, error: 'FORBIDDEN', hardFailure: true };
      return { ok: true, revisionId: 'rev-1' };
    });

    const reconciler = createWorkspaceRevisionReconciler({
      workspacesRoot: root,
      interRequestDelayMs: 0,
      negativeCacheTtlMs: 60_000,
      now: () => now,
      fetchCurrent: fetch,
      hasLocalRevision: () => true,
      applyRevision: async () => undefined,
    });

    const first = await reconciler.run('startup');
    expect(first.fetchFailed).toBe(1);
    expect(first.attempted).toBe(2);

    const second = await reconciler.run('reconnect');
    expect(second.skippedNegativeCache).toBe(1);
    expect(second.attempted).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3); // gone+good, then only good

    now += 60_001;
    const third = await reconciler.run('reconnect');
    expect(third.skippedNegativeCache).toBe(0);
    expect(third.attempted).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  test('熔断：连续传输失败达到阈值后提前结束本轮', async () => {
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
      applyRevision: async () => undefined,
      logWarn: (m) => warns.push(m),
    });

    const stats = await reconciler.run('startup');
    expect(stats.circuitBroken).toBe(true);
    expect(stats.attempted).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(warns.some((m) => m.includes('circuit open'))).toBe(true);
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
      },
    });

    const stats = await reconciler.run('startup');
    expect(stats.applied).toBe(1);
    expect(applied).toEqual(['rev-2']);
  });
});
