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
 * - single-flight：任意时刻最多一条 reconcile 在跑；重叠 schedule 只再补跑一轮
 * - 负缓存：404 / FORBIDDEN 等硬失败在 TTL 内不再请求
 * - 熔断：连续传输类失败达到阈值后本轮提前结束，避免空转打爆上游
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

export interface ReconcileRunStats {
  reason: ReconcileReason;
  listed: number;
  attempted: number;
  skippedNegativeCache: number;
  applied: number;
  fetchFailed: number;
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
  applyRevision(ref: WorkspaceChannelRef & { revisionId: string }): Promise<void>;
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

/** 硬失败：再请求也无意义，进入负缓存。 */
export function isHardReconcileFailure(error: string): boolean {
  const code = error.toUpperCase();
  return (
    code === 'FORBIDDEN'
    || code === 'NOT_FOUND'
    || code === 'UNAUTHORIZED'
    || code === 'UNAUTHENTICATED'
    || code === 'HTTP_403'
    || code === 'HTTP_404'
    || code === 'HTTP_401'
    || code.includes('FORBIDDEN')
    || code.includes('NOT_FOUND')
  );
}

/** 传输/可用性失败：计入熔断。 */
export function isTransportReconcileFailure(error: string): boolean {
  const code = error.toUpperCase();
  return (
    code.includes('FETCH FAILED')
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

  async function runOnce(reason: ReconcileReason, coalesced: boolean): Promise<ReconcileRunStats> {
    const refs = listLocalWorkspaceChannels(input.workspacesRoot);
    const stats: ReconcileRunStats = {
      reason,
      listed: refs.length,
      attempted: 0,
      skippedNegativeCache: 0,
      applied: 0,
      fetchFailed: 0,
      circuitBroken: false,
      coalesced,
      skippedInFlight: false,
    };

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
          consecutiveTransportFailures += 1;
          if (consecutiveTransportFailures >= circuitBreakerFailures) {
            stats.circuitBroken = true;
            logWarn(
              `daemon workspace-revision reconcile circuit open after ${consecutiveTransportFailures} transport failures (reason=${reason})`,
            );
            break;
          }
        } else {
          consecutiveTransportFailures = 0;
        }
        continue;
      }

      consecutiveTransportFailures = 0;
      if (input.hasLocalRevision(ref, fetchResult.revisionId)) {
        continue;
      }
      try {
        await input.applyRevision({ ...ref, revisionId: fetchResult.revisionId });
        stats.applied += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarn(`daemon workspace-revision reconcile apply ${key}/${fetchResult.revisionId} threw (non-blocking): ${message}`);
      }
    }

    return stats;
  }

  async function run(reason: ReconcileReason): Promise<ReconcileRunStats> {
    if (running) {
      pendingReason = reason;
      return {
        reason,
        listed: 0,
        attempted: 0,
        skippedNegativeCache: 0,
        applied: 0,
        fetchFailed: 0,
        circuitBroken: false,
        coalesced: false,
        skippedInFlight: true,
      };
    }

    running = true;
    let coalesced = false;
    let lastStats: ReconcileRunStats | undefined;
    try {
      // 至少跑一轮；若期间又有 schedule，结束后再补一轮（吸收 reconnect 风暴）。
      do {
        const nextReason = pendingReason ?? reason;
        pendingReason = undefined;
        lastStats = await runOnce(nextReason, coalesced);
        coalesced = true;
      } while (pendingReason !== undefined);
      return lastStats!;
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
