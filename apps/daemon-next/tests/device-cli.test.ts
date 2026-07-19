import { describe, expect, test, vi } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEVICE_CLI_EXIT, runDeviceCli } from '../src/device-cli';
import type { DeviceControlClient } from '../src/device-control-client';
import type { DeviceServiceState } from '../src/device-service-state';
import { bindLegacyRuntimeFence, runDeviceService } from '../src/device-service-runtime';
import { assertDeviceRuntimeOwner, readDeviceRuntimeOwner } from '../src/device-runtime-owner';
import { deviceServicePaths } from '../src/device-service-paths';
import type { CreateDeviceServiceHostInput } from '../src/device-service-host';
import { saveAuth } from '../src/auth-store';
import {
  createMacOSLaunchAgentAdapter,
  DEVICE_SERVICE_LAUNCH_AGENT_LABEL,
  generateMacOSLaunchAgentPlist,
  removeMacOSLaunchAgentInstallation,
  writeMacOSServicePayload,
  writeMacOSLaunchAgentPlist,
  type LaunchctlResult,
  type MacOSLaunchAgentAdapter,
} from '../src/macos-launch-agent';

function success(): LaunchctlResult {
  return { exitCode: 0, stdout: '', stderr: '' };
}

function runningState(phase: DeviceServiceState['phase'] = 'running'): DeviceServiceState {
  return {
    schemaVersion: 1,
    phase,
    pid: 42,
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:01.000Z',
    version: '0.3.11',
    profiles: { total: 2, healthy: 2, failed: 0, draining: 0, stopped: 0 },
    activeWorkCount: 0,
    outboxPendingCount: 0,
    reasonCode: 'SERVICE_READY',
  };
}

function fakeAdapter(overrides: Partial<MacOSLaunchAgentAdapter> = {}): MacOSLaunchAgentAdapter {
  return {
    label: DEVICE_SERVICE_LAUNCH_AGENT_LABEL,
    domain: 'gui/501',
    target: 'gui/501/com.agentbean.device-service',
    paths: {
      plistFile: '/Users/test/Library/LaunchAgents/com.agentbean.device-service.plist',
      logFile: '/Users/test/.agentbean/service/logs/device-service.log',
      errorLogFile: '/Users/test/.agentbean/service/logs/device-service.error.log',
    },
    bootstrap: vi.fn(async () => success()),
    start: vi.fn(async () => success()),
    kill: vi.fn(async () => success()),
    bootout: vi.fn(async () => success()),
    status: vi.fn(async () => ({ installed: true, loaded: true, running: true })),
    ...overrides,
  };
}

describe('MacOSLaunchAgentAdapter', () => {
  test('uses fixed trusted launchctl argv without a shell', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const adapter = createMacOSLaunchAgentAdapter({
      uid: 501,
      home: '/Users/test',
      baseDir: '/Users/test/.agentbean',
      run: vi.fn(async (executable, argv) => {
        calls.push([executable, argv]);
        return success();
      }),
    });

    await adapter.bootstrap();
    await adapter.start();
    await adapter.kill();
    await adapter.bootout();

    expect(calls).toEqual([
      ['/bin/launchctl', ['bootstrap', 'gui/501', '/Users/test/Library/LaunchAgents/com.agentbean.device-service.plist']],
      ['/bin/launchctl', ['kickstart', '-k', 'gui/501/com.agentbean.device-service']],
      ['/bin/launchctl', ['kill', 'SIGTERM', 'gui/501/com.agentbean.device-service']],
      ['/bin/launchctl', ['bootout', 'gui/501', '/Users/test/Library/LaunchAgents/com.agentbean.device-service.plist']],
    ]);
  });

  test('generates a deterministic secret-free plist for the internal service entrypoint', () => {
    const first = generateMacOSLaunchAgentPlist({
      executablePath: '/opt/AgentBean/bin/agentbean',
      home: '/Users/test',
      baseDir: '/Users/test/.agentbean',
    });
    const second = generateMacOSLaunchAgentPlist({
      executablePath: '/opt/AgentBean/bin/agentbean',
      home: '/Users/test',
      baseDir: '/Users/test/.agentbean',
    });

    expect(first).toBe(second);
    expect(first).toContain('<string>com.agentbean.device-service</string>');
    expect(first).toContain('<string>/opt/AgentBean/bin/agentbean</string>');
    expect(first).toMatch(/<string>service<\/string>\s*<string>run<\/string>/);
    expect(first).toContain('<key>SuccessfulExit</key>');
    expect(first).toContain('<false/>');
    expect(first).not.toContain('EnvironmentVariables');
    expect(first).not.toMatch(/token|profile|credential/i);
  });

  test('writes the plist atomically with mode 0600 and is idempotent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-launch-agent-'));
    const input = {
      executablePath: '/opt/AgentBean/bin/agentbean',
      home,
      baseDir: join(home, '.agentbean'),
    };
    const plistFile = await writeMacOSLaunchAgentPlist(input);
    const first = await stat(plistFile);
    await writeMacOSLaunchAgentPlist(input);
    const second = await stat(plistFile);

    expect(first.mode & 0o777).toBe(0o600);
    expect(second.ino).toBe(first.ino);
    expect(await readdir(join(home, 'Library', 'LaunchAgents'))).toEqual([
      'com.agentbean.device-service.plist',
    ]);
  });

  test('writes an atomic owner-only executable service payload and preserves its inode when unchanged', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-service-payload-'));
    const input = {
      sourceExecutablePath: '/opt/AgentBean/dist/bin.js',
      nodeExecutablePath: '/opt/homebrew/bin/node',
      baseDir,
    };
    const payloadFile = await writeMacOSServicePayload(input);
    const first = await stat(payloadFile);
    await writeMacOSServicePayload(input);
    const second = await stat(payloadFile);

    expect(first.mode & 0o777).toBe(0o700);
    expect(second.ino).toBe(first.ino);
    expect(await readFile(payloadFile, 'utf8')).toBe(
      `#!/opt/homebrew/bin/node\nprocess.env.AGENTBEAN_HOME = ${JSON.stringify(baseDir)};\n`
        + 'await import("file:///opt/AgentBean/dist/bin.js");\n',
    );
    expect((await stat(deviceServicePaths(baseDir).logDirectory)).mode & 0o777).toBe(0o700);
  });

  test('treats a loaded LaunchAgent without a live pid as stopped', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-launch-status-'));
    const baseDir = join(home, '.agentbean');
    await writeMacOSLaunchAgentPlist({ executablePath: '/opt/AgentBean/bin/agentbean', home, baseDir });
    let stdout = 'state = exited\n';
    const adapter = createMacOSLaunchAgentAdapter({
      uid: 501,
      home,
      baseDir,
      run: vi.fn(async () => ({ exitCode: 0, stdout, stderr: '' })),
    });
    await expect(adapter.status()).resolves.toEqual({ installed: true, loaded: true, running: false });
    stdout = 'state = running\n\tpid = 123\n';
    await expect(adapter.status()).resolves.toEqual({ installed: true, loaded: true, running: true });
  });
});

describe('agentbean device CLI', () => {
  test('install writes payload and plist, bootstraps once, waits ready, and is idempotent', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-device-install-home-'));
    const baseDir = join(home, '.agentbean');
    let loaded = false;
    let running = false;
    const adapter = fakeAdapter({
      status: vi.fn(async () => ({ installed: loaded, loaded, running })),
      bootstrap: vi.fn(async () => {
        loaded = true;
        running = true;
        return success();
      }),
    });
    const deps = {
      platform: 'darwin' as const,
      home,
      baseDir,
      executablePath: '/opt/AgentBean/dist/bin.js',
      nodeExecutablePath: '/opt/homebrew/bin/node',
      createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
      waitForReady: vi.fn(async () => runningState()),
      assertRuntimeOwner: vi.fn(async () => undefined),
    };

    await expect(runDeviceCli(['install'], deps)).resolves.toBe(DEVICE_CLI_EXIT.success);
    const paths = deviceServicePaths(baseDir);
    const plistFile = join(home, 'Library', 'LaunchAgents', 'com.agentbean.device-service.plist');
    const firstPayload = await stat(paths.payloadFile);
    const firstPlist = await stat(plistFile);
    await expect(runDeviceCli(['install'], deps)).resolves.toBe(DEVICE_CLI_EXIT.success);

    expect(adapter.bootstrap).toHaveBeenCalledTimes(1);
    expect(adapter.start).not.toHaveBeenCalled();
    expect((await stat(paths.payloadFile)).ino).toBe(firstPayload.ino);
    expect((await stat(plistFile)).ino).toBe(firstPlist.ino);
    expect(await readFile(plistFile, 'utf8')).toContain(`<string>${paths.payloadFile}</string>`);
  });

  test('install is fail-closed before migration and does not write installation files', async () => {
    const writePayload = vi.fn();
    await expect(runDeviceCli(['install'], {
      platform: 'darwin', createAdapter: () => fakeAdapter(),
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
      assertRuntimeOwner: vi.fn(async () => { throw new Error('SERVICE_MIGRATION_REQUIRED'); }),
      writePayload,
    })).resolves.toBe(DEVICE_CLI_EXIT.rejected);
    expect(writePayload).not.toHaveBeenCalled();
  });

  test('migrate start boots a zero-Runner host, commits owner, then activates saved profiles', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-device-migrate-cli-'));
    saveAuth({ token: 'private', serverUrl: 'https://agentbean.test', teamId: 'team-a', ownerId: 'owner-a' }, {
      profileId: 'profile-a',
      baseDir,
    });
    const paths = deviceServicePaths(baseDir);
    let stage: 'idle' | 'migration' | 'stopped' | 'active' = 'idle';
    const lifecycle: string[] = [];
    const adapter = fakeAdapter({
      status: vi.fn(async () => ({ installed: stage !== 'idle', loaded: stage !== 'idle', running: stage === 'migration' || stage === 'active' })),
      bootstrap: vi.fn(async () => {
        lifecycle.push('bootstrap-migration');
        stage = 'migration';
        await mkdir(paths.lockDirectory, { recursive: true });
        await writeFile(join(paths.lockDirectory, 'owner.json'), '{"schemaVersion":1,"pid":42,"nonce":"migration"}\n');
        return success();
      }),
      start: vi.fn(async () => {
        lifecycle.push('start-runners');
        stage = 'active';
        return success();
      }),
    });
    const controlClient: DeviceControlClient = {
      request: vi.fn(async (request) => {
        if (request.command === 'shutdown') {
          lifecycle.push('shutdown-migration');
          stage = 'stopped';
          return { schemaVersion: 1, requestId: request.requestId, ok: true, state: runningState('stopped') };
        }
        if (stage === 'idle' || stage === 'stopped') throw new Error('SERVICE_CONTROL_UNAVAILABLE');
        const state = {
          ...runningState(),
          profiles: stage === 'migration'
            ? { total: 0, healthy: 0, failed: 0, draining: 0, stopped: 0 }
            : { total: 1, healthy: 1, failed: 0, draining: 0, stopped: 0 },
        };
        return { schemaVersion: 1, requestId: request.requestId, ok: true, state };
      }),
    };

    await expect(runDeviceCli(['migrate', 'start', '--json'], {
      platform: 'darwin',
      baseDir,
      executablePath: '/opt/AgentBean/dist/bin.js',
      nodeExecutablePath: '/opt/homebrew/bin/node',
      createAdapter: () => adapter,
      controlClient,
      writePayload: vi.fn(async () => paths.payloadFile),
      writePlist: vi.fn(async () => '/Users/test/Library/LaunchAgents/com.agentbean.device-service.plist'),
      migrationDeps: {
        listLegacy: async () => [],
        listUnregisteredLegacyPids: async () => [],
        isProcessAlive: (pid) => pid === 42,
      },
    })).resolves.toBe(DEVICE_CLI_EXIT.success);

    expect(lifecycle).toEqual(['bootstrap-migration', 'shutdown-migration', 'start-runners']);
    expect(await readDeviceRuntimeOwner(baseDir)).toBe('device-service');
  });

  test('uninstall drains, boots out, removes only plist and payload, and preserves data byte-for-byte', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-device-uninstall-home-'));
    const baseDir = join(home, '.agentbean');
    const servicePaths = deviceServicePaths(baseDir);
    await writeMacOSServicePayload({
      sourceExecutablePath: '/opt/AgentBean/dist/bin.js',
      nodeExecutablePath: '/opt/homebrew/bin/node',
      baseDir,
    });
    await writeMacOSLaunchAgentPlist({ executablePath: servicePaths.payloadFile, home, baseDir });
    const canaries = new Map<string, Buffer>([
      [join(baseDir, 'teams', 'private-profile', 'auth.json'), Buffer.from([0, 1, 2, 255])],
      [join(baseDir, 'teams', 'private-profile', 'management', 'outbox.json'), Buffer.from('outbox-canary')],
      [join(baseDir, 'teams', 'private-profile', 'memory', 'capsule.bin'), Buffer.from([9, 8, 7, 6])],
      [join(baseDir, 'machine-id'), Buffer.from('machine-canary')],
      [servicePaths.runtimeOwnerFile, Buffer.from('{"owner":"device-service"}\n')],
      [join(home, 'Workspace', '.agentbean-canary'), Buffer.from('workspace-canary')],
    ]);
    for (const [path, bytes] of canaries) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    }
    const lifecycle: string[] = [];
    const controlClient: DeviceControlClient = {
      request: vi.fn(async (request) => {
        lifecycle.push(request.command);
        return { schemaVersion: 1, requestId: request.requestId, ok: true, state: runningState('stopped') };
      }),
    };
    const adapter = fakeAdapter({ bootout: vi.fn(async () => { lifecycle.push('bootout'); return success(); }) });

    await expect(runDeviceCli(['uninstall'], {
      platform: 'darwin', home, baseDir, createAdapter: () => adapter, controlClient,
      removeInstallation: async (input) => {
        lifecycle.push('remove');
        await removeMacOSLaunchAgentInstallation(input);
      },
    })).resolves.toBe(DEVICE_CLI_EXIT.success);

    expect(lifecycle).toEqual(['begin-drain', 'shutdown', 'bootout', 'remove']);
    expect(adapter.bootout).toHaveBeenCalledTimes(1);
    await expect(access(servicePaths.payloadFile)).rejects.toBeDefined();
    await expect(access(join(home, 'Library', 'LaunchAgents', 'com.agentbean.device-service.plist'))).rejects.toBeDefined();
    for (const [path, bytes] of canaries) expect(await readFile(path)).toEqual(bytes);
  });

  test('uninstall keeps plist and payload when bootout fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-device-uninstall-failure-'));
    const baseDir = join(home, '.agentbean');
    const servicePaths = deviceServicePaths(baseDir);
    await writeMacOSServicePayload({ sourceExecutablePath: '/opt/AgentBean/dist/bin.js',
      nodeExecutablePath: '/opt/homebrew/bin/node', baseDir });
    const plistFile = await writeMacOSLaunchAgentPlist({ executablePath: servicePaths.payloadFile, home, baseDir });
    const adapter = fakeAdapter({
      status: vi.fn(async () => ({ installed: true, loaded: true, running: false })),
      bootout: vi.fn(async () => ({ exitCode: 5, stdout: '', stderr: 'private failure' })),
    });

    await expect(runDeviceCli(['uninstall'], {
      platform: 'darwin', home, baseDir, createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.platform);
    await expect(access(servicePaths.payloadFile)).resolves.toBeUndefined();
    await expect(access(plistFile)).resolves.toBeUndefined();
  });

  test('uninstall is idempotent when no service files or launchd job exist', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-device-uninstall-empty-'));
    const adapter = fakeAdapter({ status: vi.fn(async () => ({ installed: false, loaded: false, running: false })) });
    await expect(runDeviceCli(['uninstall'], {
      platform: 'darwin', home, baseDir: join(home, '.agentbean'), createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.success);
    expect(adapter.bootout).not.toHaveBeenCalled();
  });

  test('status --json returns the stable public state and exit 0', async () => {
    const output: string[] = [];
    const state = runningState();
    const controlClient: DeviceControlClient = {
      request: vi.fn(async () => ({ schemaVersion: 1, requestId: 'status', ok: true, state })),
    };
    await expect(runDeviceCli(['status', '--json'], {
      platform: 'darwin',
      createAdapter: () => fakeAdapter(),
      controlClient,
      stdout: (line) => output.push(line),
    })).resolves.toBe(DEVICE_CLI_EXIT.success);
    expect(JSON.parse(output[0] ?? '{}')).toMatchObject({ schemaVersion: 1, installed: true, running: true, state });
  });

  test('start uses kickstart and waits for a ready control state', async () => {
    const adapter = fakeAdapter({ status: vi.fn(async () => ({ installed: true, loaded: true, running: false })) });
    const controlClient = { request: vi.fn() } as unknown as DeviceControlClient;
    await expect(runDeviceCli(['start', '--deadline-ms', '1000'], {
      platform: 'darwin',
      createAdapter: () => adapter,
      controlClient,
      waitForReady: vi.fn(async () => runningState()),
    })).resolves.toBe(DEVICE_CLI_EXIT.success);
    expect(adapter.start).toHaveBeenCalledTimes(1);
    expect(adapter.kill).not.toHaveBeenCalled();
  });

  test('start is idempotent when launchd already reports the service running', async () => {
    const adapter = fakeAdapter();
    await expect(runDeviceCli(['start'], {
      platform: 'darwin',
      createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.success);
    expect(adapter.start).not.toHaveBeenCalled();
  });

  test('stop drains then shuts down without launchctl when both control calls succeed', async () => {
    const adapter = fakeAdapter();
    const commands: string[] = [];
    const controlClient: DeviceControlClient = {
      request: vi.fn(async (request) => {
        commands.push(request.command);
        return { schemaVersion: 1, requestId: request.requestId, ok: true, state: runningState('stopped') };
      }),
    };
    await expect(runDeviceCli(['stop'], {
      platform: 'darwin', createAdapter: () => adapter, controlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.success);
    expect(commands).toEqual(['begin-drain', 'shutdown']);
    expect(adapter.kill).not.toHaveBeenCalled();
    expect(adapter.bootout).not.toHaveBeenCalled();
  });

  test('stop falls back to launchctl kill and returns exit 6 on drain timeout', async () => {
    const adapter = fakeAdapter();
    const controlClient: DeviceControlClient = {
      request: vi.fn(async (request) => ({
        schemaVersion: 1,
        requestId: request.requestId,
        ok: false,
        reasonCode: 'SERVICE_DRAIN_TIMEOUT',
      })),
    };
    await expect(runDeviceCli(['stop', '--deadline-ms', '5'], {
      platform: 'darwin', createAdapter: () => adapter, controlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.drain);
    expect(adapter.kill).toHaveBeenCalledTimes(1);
  });

  test('stop does not force kill for a non-timeout lifecycle rejection', async () => {
    const adapter = fakeAdapter();
    const controlClient: DeviceControlClient = {
      request: vi.fn(async (request) => ({
        schemaVersion: 1,
        requestId: request.requestId,
        ok: false,
        reasonCode: 'PROFILE_DRAIN_FAILED',
      })),
    };
    await expect(runDeviceCli(['stop'], {
      platform: 'darwin', createAdapter: () => adapter, controlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.rejected);
    expect(adapter.kill).not.toHaveBeenCalled();
  });

  test('rejects unsupported platforms and malformed arguments with stable exits', async () => {
    await expect(runDeviceCli(['start'], { platform: 'linux' })).resolves.toBe(DEVICE_CLI_EXIT.platform);
    await expect(runDeviceCli(['stop', '--deadline-ms', '0'])).resolves.toBe(DEVICE_CLI_EXIT.usage);
    await expect(runDeviceCli(['unknown'])).resolves.toBe(DEVICE_CLI_EXIT.usage);
  });

  test('run delegates to the internal service host entrypoint', async () => {
    const runService = vi.fn(async () => undefined);
    await expect(runDeviceCli(['run'], { runService })).resolves.toBe(DEVICE_CLI_EXIT.success);
    expect(runService).toHaveBeenCalledTimes(1);
  });
});

describe('Device Service production wiring', () => {
  test('starts a zero-Runner migration-only host before ownership commit', async () => {
    const hostStart = vi.fn(async () => undefined);
    const assertRuntimeOwner = vi.fn(async () => undefined);
    let hostInput: CreateDeviceServiceHostInput | undefined;
    await runDeviceService({
      readRuntimeOwner: async () => 'legacy-daemon',
      readMigrationJournal: async () => ({
        schemaVersion: 1,
        migrationId: 'migration-1',
        phase: 'checking-health',
        checkpoint: 'checking-health',
        dataPolicy: 'in-place',
        startedAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:01.000Z',
      }),
      listProfiles: () => { throw new Error('migration-only must not load profiles'); },
      assertRuntimeOwner,
      createHost: (input) => {
        hostInput = input;
        return {
          state: runningState('stopped'),
          start: hostStart,
          beginDrain: vi.fn(async () => ({ ok: true, reasonCode: 'SERVICE_READY' })),
          stop: vi.fn(async () => ({ ok: true, reasonCode: 'SERVICE_READY' })),
          refreshStatus: vi.fn(async () => undefined),
        };
      },
      bindSignals: vi.fn(() => () => undefined),
      readVersion: () => '0.3.11',
    });

    expect(hostInput?.runners).toEqual([]);
    expect(hostStart).toHaveBeenCalledTimes(1);
    expect(assertRuntimeOwner).not.toHaveBeenCalled();
  });

  test('refuses startup when a historical npm Daemon bypasses the owner file', async () => {
    await expect(runDeviceService({
      readRuntimeOwner: async () => 'device-service',
      readMigrationJournal: async () => null,
      assertRuntimeOwner: async () => undefined,
      discoverLegacyRuntimePids: async () => [4242],
      listProfiles: () => { throw new Error('must fence before loading profiles'); },
    })).rejects.toThrow('LEGACY_RUNTIME_FENCE_ACTIVE');
  });

  test('drains the Device Service if a historical npm Daemon appears after startup', async () => {
    vi.useFakeTimers();
    try {
      const exitCodeTarget: { exitCode?: number } = {};
      const stop = vi.fn(async () => ({ ok: true, reasonCode: 'SERVICE_READY' as const }));
      const cancel = bindLegacyRuntimeFence({ stop }, async () => [4242], {
        intervalMs: 10,
        exitCodeTarget,
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(stop).toHaveBeenCalledWith(30_000);
      expect(exitCodeTarget.exitCode).toBe(1);
      cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  test('runtime owner fence defaults to legacy and blocks the opposite runtime', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-runtime-owner-'));
    await expect(readDeviceRuntimeOwner(baseDir)).resolves.toBe('legacy-daemon');
    await expect(assertDeviceRuntimeOwner('device-service', baseDir)).rejects.toThrow('SERVICE_MIGRATION_REQUIRED');

    const ownerFile = deviceServicePaths(baseDir).runtimeOwnerFile;
    await mkdir(join(baseDir, 'service'), { recursive: true });
    await writeFile(ownerFile, '{"owner":"device-service"}\n', { mode: 0o600 });
    await expect(assertDeviceRuntimeOwner('device-service', baseDir)).resolves.toBeUndefined();
    await expect(assertDeviceRuntimeOwner('legacy-daemon', baseDir)).rejects.toThrow('DEVICE_SERVICE_OWNS_RUNTIME');
  });

  test('wraps each saved profile core in the Service Host runner boundary', async () => {
    const core = {
      started: false,
      start: vi.fn(async () => undefined),
      beginDrain: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      activeWorkCount: vi.fn(() => 2),
      outboxPendingCount: vi.fn(() => 3),
    };
    let hostInput: CreateDeviceServiceHostInput | undefined;
    let profileExit: ((code: number) => void) | undefined;
    const hostStart = vi.fn(async () => undefined);
    const refreshStatus = vi.fn(async () => undefined);
    const assertRuntimeOwner = vi.fn(async () => undefined);
    const bindSignals = vi.fn(() => () => undefined);

    await runDeviceService({
      listProfiles: () => [{
        profileId: 'profile-a',
        token: 'private-token',
        serverUrl: 'https://agentbean.test',
        teamId: 'team-a',
        ownerId: 'owner-a',
      }],
      runDaemon: vi.fn(async (_config, deps) => {
        profileExit = deps.exit;
        await deps.startDeviceServiceCore?.({ core, profileId: 'profile-a' });
      }),
      createHost: (input) => {
        hostInput = input;
        return {
          state: runningState('stopped'),
          start: hostStart,
          beginDrain: vi.fn(async () => ({ ok: true, reasonCode: 'SERVICE_READY' })),
          stop: vi.fn(async () => ({ ok: true, reasonCode: 'SERVICE_READY' })),
          refreshStatus,
        };
      },
      bindSignals,
      readVersion: () => '0.3.11',
      assertRuntimeOwner,
    });

    expect(hostStart).toHaveBeenCalledTimes(1);
    expect(assertRuntimeOwner).toHaveBeenCalledWith('device-service');
    expect(bindSignals).toHaveBeenCalledTimes(1);
    expect(hostInput?.runners).toHaveLength(1);
    const runner = hostInput?.runners[0];
    await runner?.start();
    await runner?.beginDrain(1000);
    expect(core.start).toHaveBeenCalledTimes(1);
    expect(core.beginDrain).toHaveBeenCalledWith(1000);
    expect(core.stop).not.toHaveBeenCalled();
    expect(runner?.snapshot()).toMatchObject({ activeWorkCount: 2, outboxPendingCount: 3 });
    profileExit?.(0);
    await vi.waitFor(() => expect(core.stop).toHaveBeenCalledTimes(1));
    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(runner?.snapshot().phase).toBe('failed');
  });
});
