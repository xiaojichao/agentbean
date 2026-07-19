import type { DeviceControlRequest, DeviceControlResponse } from './device-control-protocol.js';
import { createDeviceControlServer, type DeviceControlServer } from './device-control-server.js';
import { acquireDeviceServiceLock, type DeviceServiceLock } from './device-service-lock.js';
import { deviceServicePaths } from './device-service-paths.js';
import {
  createDeviceServiceStateStore,
  type DeviceServicePhase,
  type DeviceServiceProfileCounts,
  type DeviceServiceReasonCode,
  type DeviceServiceState,
  type DeviceServiceStateStore,
} from './device-service-state.js';

export type ProfileRuntimePhase = 'starting' | 'healthy' | 'degraded' | 'draining' | 'stopped' | 'failed';

export interface ProfileRuntimeStatus {
  readonly phase: ProfileRuntimePhase;
  readonly activeWorkCount: number;
  readonly outboxPendingCount: number;
}

export interface ProfileDrainResult {
  readonly ok: boolean;
  readonly reasonCode?: 'PROFILE_DRAIN_FAILED';
}

export interface DeviceServiceProfileRunner {
  readonly profileId: string;
  start(): Promise<void>;
  beginDrain(deadlineMs: number): Promise<ProfileDrainResult>;
  stop(): Promise<void>;
  snapshot(): ProfileRuntimeStatus;
}

export interface DeviceServiceHost {
  readonly state: DeviceServiceState;
  start(): Promise<void>;
  beginDrain(deadlineMs: number): Promise<DeviceServiceDrainResult>;
  stop(deadlineMs?: number): Promise<DeviceServiceDrainResult>;
}

export interface DeviceServiceDrainResult {
  readonly ok: boolean;
  readonly reasonCode: 'SERVICE_READY' | 'SERVICE_DRAIN_TIMEOUT' | 'PROFILE_DRAIN_FAILED';
}

export interface CreateDeviceServiceHostInput {
  readonly runners: readonly DeviceServiceProfileRunner[];
  readonly version: string;
  readonly baseDir?: string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly acquireLock?: () => Promise<DeviceServiceLock>;
  readonly stateStore?: DeviceServiceStateStore;
  readonly controlServer?: DeviceControlServer;
}

export function createDeviceServiceHost(input: CreateDeviceServiceHostInput): DeviceServiceHost {
  const now = input.now ?? (() => new Date());
  const pid = input.pid ?? process.pid;
  const paths = deviceServicePaths(input.baseDir);
  const stateStore = input.stateStore ?? createDeviceServiceStateStore(paths.stateFile);
  let lock: DeviceServiceLock | undefined;
  let controlServer: DeviceControlServer | undefined = input.controlServer;
  let startPromise: Promise<void> | undefined;
  let drainPromise: Promise<DeviceServiceDrainResult> | undefined;
  let stopPromise: Promise<DeviceServiceDrainResult> | undefined;
  const failedProfileIndexes = new Set<number>();
  const startedAt = now().toISOString();
  let state = buildState('stopped', 'SERVICE_NOT_RUNNING');

  function buildState(phase: DeviceServicePhase, reasonCode: DeviceServiceReasonCode): DeviceServiceState {
    const snapshots = input.runners.map((runner, index) => failedProfileIndexes.has(index)
      ? { ...runner.snapshot(), phase: 'failed' as const }
      : runner.snapshot());
    return {
      schemaVersion: 1,
      phase,
      pid,
      startedAt,
      updatedAt: now().toISOString(),
      version: input.version,
      profiles: countProfiles(snapshots),
      activeWorkCount: snapshots.reduce((sum, item) => sum + item.activeWorkCount, 0),
      outboxPendingCount: snapshots.reduce((sum, item) => sum + item.outboxPendingCount, 0),
      reasonCode,
    };
  }

  async function persist(phase: DeviceServicePhase, reasonCode: DeviceServiceReasonCode): Promise<void> {
    state = buildState(phase, reasonCode);
    await stateStore.write(state);
  }

  async function persistForShutdown(phase: DeviceServicePhase, reasonCode: DeviceServiceReasonCode): Promise<void> {
    try {
      await persist(phase, reasonCode);
    } catch {
      state = buildState(phase, 'SERVICE_STATE_WRITE_FAILED');
    }
  }

  const host: DeviceServiceHost = {
    get state() {
      return state;
    },
    async start() {
      startPromise ??= startHost();
      await startPromise;
    },
    async beginDrain(deadlineMs) {
      drainPromise ??= drainRunners(deadlineMs);
      return drainPromise;
    },
    async stop(deadlineMs = 30_000) {
      stopPromise ??= (async () => {
        const drainResult = await host.beginDrain(deadlineMs);
        await stopRunners(drainResult.reasonCode);
        return drainResult;
      })();
      return stopPromise;
    },
  };

  async function startHost(): Promise<void> {
    lock = await (input.acquireLock?.() ?? acquireDeviceServiceLock(paths.lockDirectory, { pid }));
    try {
      await persist('starting', 'SERVICE_READY');
      controlServer ??= createDeviceControlServer(paths.controlSocket, { handle: handleControlRequest });
      await controlServer.start();
      const results = await Promise.allSettled(input.runners.map((runner) => runner.start()));
      results.forEach((result, index) => {
        if (result.status === 'rejected') failedProfileIndexes.add(index);
      });
      const failed = results.filter((result) => result.status === 'rejected').length;
      if (failed === input.runners.length && input.runners.length > 0) {
        await persist('failed', 'PROFILE_START_FAILED');
        throw new Error('PROFILE_START_FAILED');
      }
      await persist(failed > 0 ? 'degraded' : 'running', failed > 0 ? 'PROFILE_START_FAILED' : 'SERVICE_READY');
    } catch (error) {
      if (state.phase !== 'failed') {
        await persist('failed', 'SERVICE_CONTROL_UNAVAILABLE').catch(() => undefined);
      }
      await controlServer?.stop().catch(() => undefined);
      await lock.release().catch(() => undefined);
      lock = undefined;
      throw error;
    }
  }

  async function drainRunners(deadlineMs: number): Promise<DeviceServiceDrainResult> {
    if (state.phase === 'stopped') return { ok: true, reasonCode: 'SERVICE_READY' };
    await persistForShutdown('draining', 'SERVICE_READY');
    const deadlineAt = Date.now() + deadlineMs;
    const drainResults = await Promise.all(input.runners.map(async (runner, index) => {
      if (failedProfileIndexes.has(index)) {
        return { result: { ok: true } as const, timedOut: false };
      }
      const remaining = Math.max(1, deadlineAt - Date.now());
      try {
        return { result: await withTimeout(runner.beginDrain(remaining), remaining), timedOut: false };
      } catch (error) {
        return {
          result: { ok: false, reasonCode: 'PROFILE_DRAIN_FAILED' } as const,
          timedOut: error instanceof ServiceDrainTimeoutError,
        };
      }
    }));
    const timedOut = drainResults.some((item) => item.timedOut);
    const failed = drainResults.some((item) => !item.result.ok);
    const reasonCode: DeviceServiceDrainResult['reasonCode'] = timedOut
      ? 'SERVICE_DRAIN_TIMEOUT'
      : failed ? 'PROFILE_DRAIN_FAILED' : 'SERVICE_READY';
    await persistForShutdown('draining', reasonCode);
    return { ok: reasonCode === 'SERVICE_READY', reasonCode };
  }

  async function stopRunners(reasonCode: DeviceServiceDrainResult['reasonCode']): Promise<void> {
    if (state.phase === 'stopped') return;
    await persistForShutdown('stopping', reasonCode);
    for (const runner of [...input.runners].reverse()) {
      await runner.stop().catch(() => undefined);
    }
    await controlServer?.stop().catch(() => undefined);
    await persistForShutdown('stopped', reasonCode);
    await lock?.release().catch(() => undefined);
    lock = undefined;
  }

  async function handleControlRequest(request: DeviceControlRequest): Promise<DeviceControlResponse> {
    if (request.command === 'status') {
      state = buildState(state.phase, state.reasonCode);
      return { schemaVersion: 1, requestId: request.requestId, ok: true, state };
    }
    const result = request.command === 'begin-drain'
      ? await host.beginDrain(request.deadlineMs ?? 30_000)
      : await host.stop(request.deadlineMs ?? 30_000);
    return result.ok
      ? { schemaVersion: 1, requestId: request.requestId, ok: true, state }
      : { schemaVersion: 1, requestId: request.requestId, ok: false, reasonCode: result.reasonCode };
  }

  return host;
}

export function bindDeviceServiceSignals(
  host: Pick<DeviceServiceHost, 'stop'>,
  signalSource: Pick<NodeJS.Process, 'once' | 'off'> = process,
  deadlineMs = 30_000,
): () => void {
  const handle = () => { void host.stop(deadlineMs); };
  signalSource.once('SIGTERM', handle);
  signalSource.once('SIGINT', handle);
  return () => {
    signalSource.off('SIGTERM', handle);
    signalSource.off('SIGINT', handle);
  };
}

function countProfiles(snapshots: readonly ProfileRuntimeStatus[]): DeviceServiceProfileCounts {
  return {
    total: snapshots.length,
    healthy: snapshots.filter((item) => item.phase === 'healthy').length,
    failed: snapshots.filter((item) => item.phase === 'failed').length,
    draining: snapshots.filter((item) => item.phase === 'draining').length,
    stopped: snapshots.filter((item) => item.phase === 'stopped').length,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new ServiceDrainTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class ServiceDrainTimeoutError extends Error {}
