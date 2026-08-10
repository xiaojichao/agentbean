import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #1084 离线 workspace revision reconcile 调度器。
 *
 * 生产事故：本机 workspaces 积压数百 team 时，每次 socket reconnect 都 `void`
 * 全量扫一遍；并发叠加 + 对 404 team 反复 GET 打满 Railway 单副本
 * connection accept → dial timeout → WebSocket 集体断开（死亡螺旋）。
 *
 * 不变量：
 * - single-flight：任意时刻最多一条 reconcile 在跑；重叠 schedule 最多再补 **一轮**
 * - 负缓存：404 / FORBIDDEN 等硬失败在 TTL 内不再请求（**不**缓存 401，凭据可能刚刷新）
 * - 熔断：连续传输类失败（含 apply/download）达到阈值后本轮提前结束
 * - 请求间隔：channel 之间插入短 delay，削尖峰
 */

export interface WorkspaceChannelRef {
  teamId: string;
  channelId: string;
}

export type ReconcileReason = 'startup' | 'reconnect';

export type ReconcileFetchResult =
  | { ok: true; revisionId: string }
  | { ok: false; error: string; hardFailure?: boolean };

export type ReconcileApplyResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ReconcileRunStats {
  reason: ReconcileReason;
  listed: number;
  attempted: number;
  skippedNegativeCache: number;
  applied: number;
  fetchFailed: number;
  applyFailed: number;
  circuitBroken: boolean;
  coalesced: boolean;
  skippedInFlight: boolean;
}

export interface WorkspaceRevisionReconciler {
  /** fire-and-forget；重叠调用合并为 in-flight + 最多一轮 follow-up。 */
  schedule(reason: ReconcileReason): void;
  /** 可 await 的单次 reconcile（测试/手动）。 */
  run(reason: ReconcileReason): Promise<ReconcileRunStats>;
}

export interface CreateWorkspaceRevisionReconcilerInput {
  workspacesRoot: string;
  fetchCurrent(ref: WorkspaceChannelRef): Promise<ReconcileFetchResult>;
  hasLocalRevision(ref: WorkspaceChannelRef, revisionId: string): boolean;
  applyRevision(ref: WorkspaceChannelRef & { revisionId: string }): Promise<ReconcileApplyResult>;
  /** 负缓存 TTL；默认 30min。 */
  negativeCacheTtlMs?: number;
  /** channel 请求间隔；默认 50ms。 */
  interRequestDelayMs?: number;
  /** 连续传输失败熔断阈值；默认 15。 */
  circuitBreakerFailures?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logWarn?: (message: string) => void;
}

/** 列出本地 workspaces/<team>/channels/<channel>。 */
export function listLocalWorkspaceChannels(workspacesRoot: string): WorkspaceChannelRef[] {
  let teamIds: string[];
  try {
    teamIds = readdirSync(workspacesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const refs: WorkspaceChannelRef[] = [];
  for (const teamId of teamIds) {
    const channelsRoot = join(workspacesRoot, teamId, 'channels');
    let channelIds: string[];
    try {
      channelIds = readdirSync(channelsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const channelId of channelIds) {
      refs.push({ teamId, channelId });
    }
  }
  return refs;
}

/**
 * 硬失败：再请求也无意义，进入负缓存。
 * 注意：不把 401/UNAUTHORIZED 算硬失败——reconnect 可能刚刷新 token。
 */
export function isHardReconcileFailure(error: string): boolean {
  const code = error.toUpperCase();
  if (
    code === 'UNAUTHORIZED'
    || code === 'UNAUTHENTICATED'
    || code === 'HTTP_401'
    || code.includes('UNAUTHORIZED')
    || code.includes('UNAUTHENTICATED')
  ) {
    return false;
  }
  return (
    code === 'FORBIDDEN'
    || code === 'NOT_FOUND'
    || code === 'HTTP_403'
    || code === 'HTTP_404'
    || code.includes('FORBIDDEN')
    || code.includes('NOT_FOUND')
  );
}

/** 传输/可用性失败：计入熔断（含 apply 阶段 download）。 */
export function isTransportReconcileFailure(error: string): boolean {
  const code = error.toUpperCase();
  return (
    code.includes('FETCH FAILED')
    || code.includes('DOWNLOAD_FAILED')
    || code.includes('ECONN')
    || code.includes('ETIMEDOUT')
    || code.includes('TIMEOUT')
    || code.includes('NETWORK')
    || code.includes('HTTP_502')
    || code.includes('HTTP_503')
    || code.includes('HTTP_504')
    || code === 'HTTP_502'
    || code === 'HTTP_503'
    || code === 'HTTP_504'
  );
}

function channelKey(ref: WorkspaceChannelRef): string {
  return `${ref.teamId}/${ref.channelId}`;
}

function emptyStats(reason: ReconcileReason, extras: Partial<ReconcileRunStats> = {}): ReconcileRunStats {
  return {
    reason,
    listed: 0,
    attempted: 0,
    skippedNegativeCache: 0,
    applied: 0,
    fetchFailed: 0,
    applyFailed: 0,
    circuitBroken: false,
    coalesced: false,
    skippedInFlight: false,
    ...extras,
  };
}

export function createWorkspaceRevisionReconciler(
  input: CreateWorkspaceRevisionReconcilerInput,
): WorkspaceRevisionReconciler {
  const negativeCacheTtlMs = input.negativeCacheTtlMs ?? 30 * 60 * 1000;
  const interRequestDelayMs = input.interRequestDelayMs ?? 50;
  const circuitBreakerFailures = input.circuitBreakerFailures ?? 15;
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logWarn = input.logWarn ?? ((message: string) => console.warn(message));

  const negativeCache = new Map<string, number>();
  let running = false;
  let pendingReason: ReconcileReason | undefined;

  function noteTransportFailure(
    stats: ReconcileRunStats,
    consecutive: number,
    reason: ReconcileReason,
  ): { consecutive: number; broken: boolean } {
    const next = consecutive + 1;
    if (next >= circuitBreakerFailures) {
      stats.circuitBroken = true;
      logWarn(
        `daemon workspace-revision reconcile circuit open after ${next} transport failures (reason=${reason})`,
      );
      return { consecutive: next, broken: true };
    }
    return { consecutive: next, broken: false };
  }

  async function runOnce(reason: ReconcileReason, coalesced: boolean): Promise<ReconcileRunStats> {
    const refs = listLocalWorkspaceChannels(input.workspacesRoot);
    const stats: ReconcileRunStats = emptyStats(reason, {
      listed: refs.length,
      coalesced,
    });

    let consecutiveTransportFailures = 0;
    let first = true;

    for (const ref of refs) {
      const key = channelKey(ref);
      const cachedUntil = negativeCache.get(key);
      if (cachedUntil !== undefined && cachedUntil > now()) {
        stats.skippedNegativeCache += 1;
        continue;
      }
      if (cachedUntil !== undefined && cachedUntil <= now()) {
        negativeCache.delete(key);
      }

      if (!first && interRequestDelayMs > 0) {
        await sleep(interRequestDelayMs);
      }
      first = false;

      stats.attempted += 1;
      let fetchResult: ReconcileFetchResult;
      try {
        fetchResult = await input.fetchCurrent(ref);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fetchResult = { ok: false, error: message };
        logWarn(`daemon workspace-revision reconcile ${key} threw (non-blocking): ${message}`);
      }

      if (!fetchResult.ok) {
        stats.fetchFailed += 1;
        const hard = fetchResult.hardFailure === true || isHardReconcileFailure(fetchResult.error);
        if (hard) {
          negativeCache.set(key, now() + negativeCacheTtlMs);
          consecutiveTransportFailures = 0;
        } else if (isTransportReconcileFailure(fetchResult.error)) {
          const note = noteTransportFailure(stats, consecutiveTransportFailures, reason);
          consecutiveTransportFailures = note.consecutive;
          if (note.broken) break;
        } else {
          consecutiveTransportFailures = 0;
        }
        continue;
      }

      if (input.hasLocalRevision(ref, fetchResult.revisionId)) {
        consecutiveTransportFailures = 0;
        continue;
      }

      let applyResult: ReconcileApplyResult;
      try {
        applyResult = await input.applyRevision({ ...ref, revisionId: fetchResult.revisionId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        applyResult = { ok: false, error: message };
        logWarn(
          `daemon workspace-revision reconcile apply ${key}/${fetchResult.revisionId} threw (non-blocking): ${message}`,
        );
      }

      if (!applyResult.ok) {
        stats.applyFailed += 1;
        if (isTransportReconcileFailure(applyResult.error)) {
          const note = noteTransportFailure(stats, consecutiveTransportFailures, reason);
          consecutiveTransportFailures = note.consecutive;
          if (note.broken) break;
        } else {
          // CONFLICT / 本地写失败等：不记传输熔断，但也不算成功 applied
          consecutiveTransportFailures = 0;
        }
        continue;
      }

      consecutiveTransportFailures = 0;
      stats.applied += 1;
    }

    return stats;
  }

  async function run(reason: ReconcileReason): Promise<ReconcileRunStats> {
    if (running) {
      pendingReason = reason;
      return emptyStats(reason, { skippedInFlight: true });
    }

    running = true;
    try {
      // 首轮
      const firstReason = pendingReason ?? reason;
      pendingReason = undefined;
      let lastStats = await runOnce(firstReason, false);

      // 最多一轮 follow-up：吸收 in-flight 期间的 schedule，但不在 follow-up 中继续连锁。
      if (pendingReason !== undefined) {
        const followUpReason = pendingReason;
        pendingReason = undefined;
        lastStats = await runOnce(followUpReason, true);
        // follow-up 期间再次 schedule：丢弃连锁，留给下一次外部调度（避免无限 while）。
        if (pendingReason !== undefined) {
          logWarn(
            `daemon workspace-revision reconcile dropped chained schedule during follow-up (reason=${pendingReason})`,
          );
          pendingReason = undefined;
        }
      }

      return lastStats;
    } finally {
      running = false;
    }
  }

  function schedule(reason: ReconcileReason): void {
    void run(reason).catch((error) => {
      logWarn(
        `daemon workspace-revision reconcile schedule failed (non-blocking): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  return { schedule, run };
}
