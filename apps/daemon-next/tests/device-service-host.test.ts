import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { createDeviceControlServer } from '../src/device-control-server';
import { parseDeviceControlRequest } from '../src/device-control-protocol';
import { acquireDeviceServiceLock, DeviceServiceAlreadyRunningError } from '../src/device-service-lock';
import { bindDeviceServiceSignals, createDeviceServiceHost, type DeviceServiceProfileRunner, type ProfileRuntimeStatus } from '../src/device-service-host';
import { deviceServicePaths } from '../src/device-service-paths';
import { createDeviceServiceProfileRunner } from '../src/device-service-profile-runner';
import { createDeviceServiceStateStore, type DeviceServiceState } from '../src/device-service-state';

function temporaryRoot(): string {
  return mkdtempSync(join(tmpdir(), 'agentbean-service-host-'));
}

function fakeRunner(profileId: string, overrides: Partial<DeviceServiceProfileRunner> = {}) {
  let status: ProfileRuntimeStatus = { phase: 'starting', activeWorkCount: 0, outboxPendingCount: 0 };
  const runner: DeviceServiceProfileRunner = {
    profileId,
    start: vi.fn(async () => { status = { ...status, phase: 'healthy' }; }),
    beginDrain: vi.fn(async () => {
      status = { ...status, phase: 'draining' };
      return { ok: true };
    }),
    stop: vi.fn(async () => { status = { ...status, phase: 'stopped' }; }),
    snapshot: vi.fn(() => status),
    ...overrides,
  };
  return runner;
}

function memoryStateStore() {
  const states: DeviceServiceState[] = [];
  return {
    states,
    store: {
      write: vi.fn(async (state: DeviceServiceState) => { states.push(state); }),
      read: vi.fn(async () => states.at(-1) ?? null),
    },
  };
}

describe('Device Service paths and state', () => {
  test('keeps control, state, lock and logs under the AgentBean service root', () => {
    expect(deviceServicePaths('/tmp/agentbean-home')).toEqual({
      root: '/tmp/agentbean-home/service',
      controlSocket: '/tmp/agentbean-home/service/control.sock',
      stateFile: '/tmp/agentbean-home/service/state.json',
      lockDirectory: '/tmp/agentbean-home/service/service.lock',
      runtimeOwnerFile: '/tmp/agentbean-home/service/runtime-owner.json',
      payloadDirectory: '/tmp/agentbean-home/service/payload',
      payloadFile: '/tmp/agentbean-home/service/payload/agentbean-service.mjs',
      logDirectory: '/tmp/agentbean-home/service/logs',
      logFile: '/tmp/agentbean-home/service/logs/device-service.log',
    });
  });

  test('writes state atomically with current-user-only permissions', async () => {
    const root = temporaryRoot();
    const path = join(root, 'service', 'state.json');
    const store = createDeviceServiceStateStore(path);
    const state: DeviceServiceState = {
      schemaVersion: 1,
      phase: 'running',
      pid: 42,
      startedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:01.000Z',
      version: '0.2.5',
      profiles: { total: 1, healthy: 1, failed: 0, draining: 0, stopped: 0 },
      activeWorkCount: 0,
      outboxPendingCount: 0,
      reasonCode: 'SERVICE_READY',
    };
    await store.write(state);

    expect(await store.read()).toEqual(state);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).not.toContain('/Users/');
  });

  test('rejects a symlinked service directory', async () => {
    const root = temporaryRoot();
    const target = join(root, 'target');
    mkdirSync(target);
    symlinkSync(target, join(root, 'service'));
    const store = createDeviceServiceStateStore(join(root, 'service', 'state.json'));
    await expect(store.write({} as DeviceServiceState)).rejects.toThrow('SERVICE_DIRECTORY_UNSAFE');
  });
});

describe('Device Service single-instance lock', () => {
  test('rejects an owner whose process is still alive', async () => {
    const path = join(temporaryRoot(), 'service.lock');
    const first = await acquireDeviceServiceLock(path, { pid: 101, isProcessAlive: () => true });
    await expect(acquireDeviceServiceLock(path, { pid: 202, isProcessAlive: () => true }))
      .rejects.toBeInstanceOf(DeviceServiceAlreadyRunningError);
    await first.release();
  });

  test('quarantines a stale lock and never lets the old owner release the new lock', async () => {
    const path = join(temporaryRoot(), 'service.lock');
    const old = await acquireDeviceServiceLock(path, { pid: 101, isProcessAlive: () => false });
    const current = await acquireDeviceServiceLock(path, { pid: 202, isProcessAlive: () => false });
    await old.release();
    expect(readFileSync(join(path, 'owner.json'), 'utf8')).toContain('"pid":202');
    await current.release();
  });

  test('concurrent acquisition has exactly one winner', async () => {
    const path = join(temporaryRoot(), 'service.lock');
    const results = await Promise.allSettled([
      acquireDeviceServiceLock(path, { pid: 101, isProcessAlive: () => true }),
      acquireDeviceServiceLock(path, { pid: 202, isProcessAlive: () => true }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const winner = results.find((result) => result.status === 'fulfilled');
    if (winner?.status === 'fulfilled') await winner.value.release();
  });
});

describe('Device control protocol', () => {
  test('accepts only the strict versioned allowlist', () => {
    expect(parseDeviceControlRequest({ schemaVersion: 1, requestId: 'r-1', command: 'status' }))
      .toEqual({ schemaVersion: 1, requestId: 'r-1', command: 'status' });
    expect(parseDeviceControlRequest({ schemaVersion: 1, requestId: 'r-2', command: 'begin-drain', deadlineMs: 1000 }))
      .toEqual({ schemaVersion: 1, requestId: 'r-2', command: 'begin-drain', deadlineMs: 1000 });
    expect(parseDeviceControlRequest({ schemaVersion: 2, requestId: 'r', command: 'status' })).toBeNull();
    expect(parseDeviceControlRequest({ schemaVersion: 1, requestId: 'r', command: 'status', token: 'secret' })).toBeNull();
    expect(parseDeviceControlRequest({ schemaVersion: 1, requestId: 'r', command: 'shutdown' })).toBeNull();
  });

  test('does not reflect an unvalidated request id or secret field', async () => {
    const socketPath = join(temporaryRoot(), 'control.sock');
    const server = createDeviceControlServer(socketPath, { handle: vi.fn() });
    await server.start();
    const response = await requestSocket(socketPath, {
      schemaVersion: 1,
      requestId: 'secret-request-id',
      command: 'status',
      token: 'secret-token',
    });
    expect(response).toEqual({
      schemaVersion: 1,
      requestId: 'invalid',
      ok: false,
      reasonCode: 'CONTROL_INVALID_REQUEST',
    });
    expect(JSON.stringify(response)).not.toContain('secret');
    await server.stop();
  });

  test('serves one request per current-user-only Unix socket connection', async () => {
    const root = temporaryRoot();
    chmodSync(root, 0o700);
    const socketPath = join(root, 'control.sock');
    const server = createDeviceControlServer(socketPath, {
      handle: vi.fn(async (request) => ({
        schemaVersion: 1,
        requestId: request.requestId,
        ok: false,
        reasonCode: 'SERVICE_NOT_RUNNING',
      })),
    });
    await server.start();
    const response = await requestSocket(socketPath, { schemaVersion: 1, requestId: 'status-1', command: 'status' });
    expect(response).toEqual({
      schemaVersion: 1,
      requestId: 'status-1',
      ok: false,
      reasonCode: 'SERVICE_NOT_RUNNING',
    });
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);
    await server.stop();
  });

  test('rejects request smuggling after the first newline', async () => {
    const socketPath = join(temporaryRoot(), 'control.sock');
    const handle = vi.fn();
    const server = createDeviceControlServer(socketPath, { handle });
    await server.start();
    const response = await requestRawSocket(
      socketPath,
      `${JSON.stringify({ schemaVersion: 1, requestId: 'one', command: 'status' })}\n`
        + `${JSON.stringify({ schemaVersion: 1, requestId: 'two', command: 'status' })}\n`,
    );
    expect(response).toEqual({
      schemaVersion: 1,
      requestId: 'invalid',
      ok: false,
      reasonCode: 'CONTROL_INVALID_REQUEST',
    });
    expect(handle).not.toHaveBeenCalled();
    await server.stop();
  });

  test('shutdown destroys clients that never finish a request', async () => {
    const socketPath = join(temporaryRoot(), 'control.sock');
    const server = createDeviceControlServer(socketPath, { handle: vi.fn() });
    await server.start();
    const socket = createConnection(socketPath);
    await once(socket, 'connect');
    const closed = once(socket, 'close');
    await server.stop();
    await closed;
  });

  test('shutdown destroys a non-shutdown request that is still being handled', async () => {
    const socketPath = join(temporaryRoot(), 'control.sock');
    const handle = vi.fn(() => new Promise<never>(() => undefined));
    const server = createDeviceControlServer(socketPath, { handle });
    await server.start();
    const socket = createConnection(socketPath);
    await once(socket, 'connect');
    socket.write(`${JSON.stringify({
      schemaVersion: 1,
      requestId: 'long-drain',
      command: 'begin-drain',
      deadlineMs: 300_000,
    })}\n`);
    await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(1));

    const closed = once(socket, 'close');
    await server.stop();
    await closed;
  });

  test('shutdown request connection remains open long enough to receive its response', async () => {
    const socketPath = join(temporaryRoot(), 'control.sock');
    let server: ReturnType<typeof createDeviceControlServer>;
    server = createDeviceControlServer(socketPath, {
      handle: vi.fn(async (request) => {
        await server.stop();
        return {
          schemaVersion: 1,
          requestId: request.requestId,
          ok: false,
          reasonCode: 'SERVICE_NOT_RUNNING',
        };
      }),
    });
    await server.start();

    await expect(requestSocket(socketPath, {
      schemaVersion: 1,
      requestId: 'shutdown-1',
      command: 'shutdown',
      deadlineMs: 1000,
    })).resolves.toMatchObject({ requestId: 'shutdown-1', reasonCode: 'SERVICE_NOT_RUNNING' });
  });
});

describe('DeviceServiceHost', () => {
  test('persists degraded and failed when healthy runners fail after startup', async () => {
    let firstPhase: ProfileRuntimeStatus['phase'] = 'healthy';
    let secondPhase: ProfileRuntimeStatus['phase'] = 'healthy';
    const first = fakeRunner('first', { snapshot: () => ({ phase: firstPhase, activeWorkCount: 0, outboxPendingCount: 0 }) });
    const second = fakeRunner('second', { snapshot: () => ({ phase: secondPhase, activeWorkCount: 0, outboxPendingCount: 0 }) });
    const { states, store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [first, second], version: '0.2.5', stateStore: store,
      acquireLock: async () => ({ release: vi.fn(async () => undefined) }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await host.start();

    firstPhase = 'failed';
    await host.refreshStatus();
    expect(host.state).toMatchObject({ phase: 'degraded', reasonCode: 'PROFILE_RUNTIME_FAILED' });

    secondPhase = 'failed';
    await host.refreshStatus();
    expect(host.state).toMatchObject({ phase: 'failed', reasonCode: 'PROFILE_RUNTIME_FAILED' });
    expect(states.at(-1)).toMatchObject({ phase: 'failed', profiles: { failed: 2 } });
  });

  test('isolates one failed profile and drains/stops healthy siblings in reverse order', async () => {
    const calls: string[] = [];
    const healthy = fakeRunner('private-profile-name', {
      beginDrain: vi.fn(async () => { calls.push('healthy:drain'); return { ok: true }; }),
      stop: vi.fn(async () => { calls.push('healthy:stop'); }),
    });
    const failed = fakeRunner('secret-profile-name', {
      start: vi.fn(async () => { throw new Error('token=must-not-leak'); }),
      stop: vi.fn(async () => { calls.push('failed:stop'); }),
    });
    const { states, store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [healthy, failed],
      version: '0.2.5',
      stateStore: store,
      acquireLock: async () => ({ release: vi.fn(async () => undefined) }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });

    await host.start();
    expect(host.state.phase).toBe('degraded');
    expect(host.state.reasonCode).toBe('PROFILE_START_FAILED');
    expect(host.state.profiles).toMatchObject({ total: 2, healthy: 1, failed: 1 });
    expect(JSON.stringify(states)).not.toContain('private-profile-name');
    expect(JSON.stringify(states)).not.toContain('secret-profile-name');
    expect(JSON.stringify(states)).not.toContain('must-not-leak');

    await host.beginDrain(1000);
    expect(calls).toEqual(['healthy:drain']);
    expect(failed.beginDrain).toHaveBeenCalledTimes(1);
    expect(host.state.phase).toBe('draining');
    await Promise.all([host.stop(), host.stop()]);
    expect(calls).toEqual(['healthy:drain', 'failed:stop', 'healthy:stop']);
    expect(host.state.phase).toBe('stopped');
  });

  test('returns a stable timeout code and still stops every runner', async () => {
    const runner = fakeRunner('profile', {
      beginDrain: vi.fn(() => new Promise(() => undefined)),
    });
    const { store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [runner],
      version: '0.2.5',
      stateStore: store,
      acquireLock: async () => ({ release: vi.fn(async () => undefined) }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await host.start();

    await expect(host.stop(5)).resolves.toEqual({ ok: false, reasonCode: 'SERVICE_DRAIN_TIMEOUT' });
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(host.state).toMatchObject({ phase: 'stopped', reasonCode: 'SERVICE_DRAIN_TIMEOUT' });
  });

  test('state write failure cannot bypass runner stop or lock release', async () => {
    const runner = fakeRunner('profile');
    const release = vi.fn(async () => undefined);
    let writes = 0;
    const host = createDeviceServiceHost({
      runners: [runner],
      version: '0.2.5',
      stateStore: {
        write: vi.fn(async () => {
          writes += 1;
          if (writes > 2) throw new Error('disk contains private path');
        }),
        read: vi.fn(async () => null),
      },
      acquireLock: async () => ({ release }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await host.start();

    await expect(host.stop()).resolves.toEqual({ ok: false, reasonCode: 'SERVICE_STATE_WRITE_FAILED' });
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(host.state).toMatchObject({ phase: 'stopped', reasonCode: 'SERVICE_STATE_WRITE_FAILED' });
  });

  test('startup state failure releases the single-instance lock', async () => {
    const release = vi.fn(async () => undefined);
    const host = createDeviceServiceHost({
      runners: [],
      version: '0.2.5',
      stateStore: {
        write: vi.fn(async () => { throw new Error('write failed'); }),
        read: vi.fn(async () => null),
      },
      acquireLock: async () => ({ release }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await expect(host.start()).rejects.toThrow('write failed');
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('all-profile startup failure remains failed after cleanup', async () => {
    const runner = fakeRunner('profile', {
      start: vi.fn(async () => { throw new Error('start failed'); }),
    });
    const { states, store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [runner], version: '0.2.5', stateStore: store,
      acquireLock: async () => ({ release: vi.fn(async () => undefined) }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });

    await expect(host.start()).rejects.toThrow('PROFILE_START_FAILED');
    expect(host.state).toMatchObject({ phase: 'failed', reasonCode: 'PROFILE_START_FAILED' });
    expect(states.at(-1)).toMatchObject({ phase: 'failed', reasonCode: 'PROFILE_START_FAILED' });
    expect(runner.stop).toHaveBeenCalledTimes(1);
  });

  test('running-state write failure stops a runner that already started', async () => {
    const runner = fakeRunner('profile');
    const release = vi.fn(async () => undefined);
    let writes = 0;
    const host = createDeviceServiceHost({
      runners: [runner], version: '0.2.5',
      stateStore: {
        write: vi.fn(async () => {
          writes += 1;
          if (writes === 2) throw new Error('state write failed');
        }),
        read: vi.fn(async () => null),
      },
      acquireLock: async () => ({ release }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await expect(host.start()).rejects.toThrow('state write failed');
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(runner.beginDrain).toHaveBeenCalledTimes(1);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  test('runner stop failure is returned as a stable failure', async () => {
    const runner = fakeRunner('profile', { stop: vi.fn(async () => { throw new Error('secret failure'); }) });
    const { store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [runner], version: '0.2.5', stateStore: store,
      acquireLock: async () => ({ release: vi.fn(async () => undefined) }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await host.start();
    await expect(host.stop()).resolves.toEqual({ ok: false, reasonCode: 'PROFILE_DRAIN_FAILED' });
    expect(JSON.stringify(host.state)).not.toContain('secret');
  });

  test('stop deadline bounds a runner that never finishes stopping', async () => {
    const runner = fakeRunner('profile', { stop: vi.fn(() => new Promise(() => undefined)) });
    const release = vi.fn(async () => undefined);
    const { store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [runner], version: '0.2.5', stateStore: store,
      acquireLock: async () => ({ release }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    await host.start();

    await expect(host.stop(5)).resolves.toEqual({ ok: false, reasonCode: 'SERVICE_DRAIN_TIMEOUT' });
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(host.state).toMatchObject({ phase: 'stopped', reasonCode: 'SERVICE_DRAIN_TIMEOUT' });
  });

  test('stop waits for an in-flight start before draining', async () => {
    let finishStart: (() => void) | undefined;
    const runner = fakeRunner('profile', {
      start: vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve; })),
    });
    const { store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [runner], version: '0.2.5', stateStore: store,
      acquireLock: async () => ({ release: vi.fn(async () => undefined) }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    const starting = host.start();
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));
    const stopping = host.stop();
    expect(runner.beginDrain).not.toHaveBeenCalled();
    finishStart?.();
    await Promise.all([starting, stopping]);
    expect(runner.beginDrain).toHaveBeenCalledTimes(1);
    expect(runner.stop).toHaveBeenCalledTimes(1);
    expect(host.state.phase).toBe('stopped');
  });

  test('stop deadline bounds an in-flight start and cleans up a late completion', async () => {
    let finishStart: (() => void) | undefined;
    const runner = fakeRunner('profile', {
      start: vi.fn(() => new Promise<void>((resolve) => { finishStart = resolve; })),
    });
    const release = vi.fn(async () => undefined);
    const { store } = memoryStateStore();
    const host = createDeviceServiceHost({
      runners: [runner], version: '0.2.5', stateStore: store,
      acquireLock: async () => ({ release }),
      controlServer: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    });
    const starting = host.start();
    await vi.waitFor(() => expect(finishStart).toBeTypeOf('function'));

    await expect(host.stop(5)).resolves.toEqual({ ok: false, reasonCode: 'SERVICE_DRAIN_TIMEOUT' });
    expect(release).toHaveBeenCalledTimes(1);
    expect(host.state).toMatchObject({ phase: 'stopped', reasonCode: 'SERVICE_DRAIN_TIMEOUT' });

    finishStart?.();
    await expect(starting).rejects.toBeInstanceOf(Error);
    expect(runner.stop).toHaveBeenCalledTimes(2);
    expect(host.state.phase).toBe('stopped');
  });

  test('signal drain failure sets a non-zero process exit code', async () => {
    const signals = new EventEmitter();
    const exitTarget: { exitCode?: string | number } = {};
    const cleanup = bindDeviceServiceSignals(
      { stop: vi.fn(async () => ({ ok: false, reasonCode: 'SERVICE_DRAIN_TIMEOUT' })) },
      signals as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
      5,
      exitTarget,
    );
    signals.emit('SIGTERM');
    await vi.waitFor(() => expect(exitTarget.exitCode).toBe(1));
    cleanup();
  });
});

describe('DeviceServiceProfileRunner', () => {
  test('wraps the existing DeviceServiceCore with drain state and runtime counts', async () => {
    const core = { started: false, start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) };
    const runner = createDeviceServiceProfileRunner({
      profileId: 'private-profile',
      core,
      beginDrain: vi.fn(async () => ({ ok: true })),
      readCounts: () => ({ activeWorkCount: 2, outboxPendingCount: 3 }),
    });
    await runner.start();
    expect(runner.snapshot()).toEqual({ phase: 'healthy', activeWorkCount: 2, outboxPendingCount: 3 });
    await runner.beginDrain(1000);
    expect(runner.snapshot().phase).toBe('draining');
    await runner.stop();
    expect(core.start).toHaveBeenCalledTimes(1);
    expect(core.stop).toHaveBeenCalledTimes(1);
    expect(runner.snapshot().phase).toBe('stopped');
  });
});

async function requestSocket(socketPath: string, request: unknown): Promise<unknown> {
  return requestRawSocket(socketPath, `${JSON.stringify(request)}\n`);
}

async function requestRawSocket(socketPath: string, request: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(response));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}
