import { describe, expect, test, vi } from 'vitest';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEVICE_CLI_EXIT, runDeviceCli } from '../src/device-cli';
import type { DeviceControlClient } from '../src/device-control-client';
import type { DeviceServiceState } from '../src/device-service-state';
import { runDeviceService } from '../src/device-service-runtime';
import type { CreateDeviceServiceHostInput } from '../src/device-service-host';
import {
  createMacOSLaunchAgentAdapter,
  DEVICE_SERVICE_LAUNCH_AGENT_LABEL,
  generateMacOSLaunchAgentPlist,
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
    status: vi.fn(async () => ({ installed: true, running: true })),
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
    await expect(adapter.status()).resolves.toEqual({ installed: true, running: false });
    stdout = 'state = running\n\tpid = 123\n';
    await expect(adapter.status()).resolves.toEqual({ installed: true, running: true });
  });
});

describe('agentbean device CLI', () => {
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
    const adapter = fakeAdapter({ status: vi.fn(async () => ({ installed: true, running: false })) });
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
        };
      },
      bindSignals,
      readVersion: () => '0.3.11',
    });

    expect(hostStart).toHaveBeenCalledTimes(1);
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
    expect(runner?.snapshot().phase).toBe('failed');
  });
});
