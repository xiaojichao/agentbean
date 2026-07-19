import { access, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { DEVICE_CLI_EXIT, runDeviceCli } from '../src/device-cli';
import type { DeviceControlClient } from '../src/device-control-client';
import { deviceServicePaths } from '../src/device-service-paths';
import type { DeviceServiceState } from '../src/device-service-state';
import {
  createLinuxSystemdUserAdapter,
  DEVICE_SERVICE_SYSTEMD_UNIT,
  generateLinuxSystemdUserUnit,
  linuxSystemdUserPaths,
  readLinuxSystemdUserLogs,
  writeLinuxSystemdUserUnit,
} from '../src/linux-systemd-user';
import { writeMacOSServicePayload } from '../src/macos-launch-agent';

const success = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });

function runningState(): DeviceServiceState {
  return {
    schemaVersion: 1,
    phase: 'running',
    pid: 42,
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:01.000Z',
    version: '0.3.11',
    profiles: { total: 1, healthy: 1, failed: 0, draining: 0, stopped: 0 },
    activeWorkCount: 0,
    outboxPendingCount: 0,
    reasonCode: 'SERVICE_READY',
  };
}

describe('LinuxSystemdUserAdapter', () => {
  test('uses only fixed systemctl --user argv and sequences reload/enable/disable', async () => {
    const calls: Array<[string, readonly string[]]> = [];
    const adapter = createLinuxSystemdUserAdapter({
      home: '/home/test',
      baseDir: '/home/test/.agentbean',
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
      ['/usr/bin/systemctl', ['--user', 'daemon-reload']],
      ['/usr/bin/systemctl', ['--user', 'enable', '--now', DEVICE_SERVICE_SYSTEMD_UNIT]],
      ['/usr/bin/systemctl', ['--user', 'start', DEVICE_SERVICE_SYSTEMD_UNIT]],
      ['/usr/bin/systemctl', ['--user', 'kill', '--signal=SIGTERM', DEVICE_SERVICE_SYSTEMD_UNIT]],
      ['/usr/bin/systemctl', ['--user', 'disable', '--now', DEVICE_SERVICE_SYSTEMD_UNIT]],
      ['/usr/bin/systemctl', ['--user', 'daemon-reload']],
    ]);
  });

  test('reads logs with fixed journalctl --user argv without a shell', async () => {
    const run = vi.fn(async () => success('line one\n'));
    await expect(readLinuxSystemdUserLogs({ run })).resolves.toEqual(success('line one\n'));
    expect(run).toHaveBeenCalledWith('/usr/bin/journalctl', [
      '--user', '--unit', DEVICE_SERVICE_SYSTEMD_UNIT, '--lines', '100', '--no-pager',
    ]);
  });

  test('generates a deterministic secret-free current-user unit', () => {
    const input = { executablePath: '/home/test/Agent Bean/device-service.cjs', home: '/home/test', baseDir: '/home/test/.agentbean' };
    const unit = generateLinuxSystemdUserUnit(input);
    expect(generateLinuxSystemdUserUnit(input)).toBe(unit);
    expect(unit).toContain('ExecStart="/home/test/Agent Bean/device-service.cjs" service run');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toMatch(/token|profile|credential/i);
    expect(unit).not.toContain('User=');
  });

  test('writes an idempotent owner-only unit under XDG_CONFIG_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-systemd-unit-'));
    const xdgConfigHome = join(home, 'xdg-config');
    const input = { executablePath: '/opt/AgentBean/device-service.cjs', home, xdgConfigHome, baseDir: join(home, '.agentbean') };
    const unitFile = await writeLinuxSystemdUserUnit(input);
    const first = await stat(unitFile);
    await writeLinuxSystemdUserUnit(input);
    const second = await stat(unitFile);
    expect(unitFile).toBe(join(xdgConfigHome, 'systemd', 'user', DEVICE_SERVICE_SYSTEMD_UNIT));
    expect(first.mode & 0o777).toBe(0o600);
    expect(second.ino).toBe(first.ino);
  });

  test('distinguishes active, inactive, absent, and failed status queries', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-systemd-status-'));
    const baseDir = join(home, '.agentbean');
    await writeLinuxSystemdUserUnit({ executablePath: '/opt/AgentBean/device-service.cjs', home, baseDir });
    let result = success('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n');
    const adapter = createLinuxSystemdUserAdapter({ home, baseDir, run: vi.fn(async () => result) });
    await expect(adapter.status()).resolves.toEqual({ installed: true, loaded: true, running: true, queryFailed: false });
    result = success('LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n');
    await expect(adapter.status()).resolves.toEqual({ installed: true, loaded: true, running: false, queryFailed: false });
    result = { exitCode: 1, stdout: '', stderr: 'bus unavailable' };
    await expect(adapter.status()).resolves.toEqual({ installed: true, loaded: false, running: false, queryFailed: true });

    const absentHome = await mkdtemp(join(tmpdir(), 'agentbean-systemd-absent-'));
    const absent = createLinuxSystemdUserAdapter({ home: absentHome, run: vi.fn(async () => result) });
    await expect(absent.status()).resolves.toEqual({ installed: false, loaded: false, running: false, queryFailed: true });
  });
});

describe('agentbean device on Linux x64', () => {
  test('installs through the unified CLI and creates only current-user assets', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-linux-install-'));
    const baseDir = join(home, '.agentbean');
    const xdgConfigHome = join(home, '.config');
    let running = false;
    const adapter = createLinuxSystemdUserAdapter({
      home,
      baseDir,
      xdgConfigHome,
      run: vi.fn(async (_executable, argv) => {
        if (argv.includes('show')) {
          return running
            ? success('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n')
            : { exitCode: 1, stdout: '', stderr: 'not found' };
        }
        if (argv.includes('enable')) running = true;
        return success();
      }),
    });

    await expect(runDeviceCli(['install'], {
      platform: 'linux',
      arch: 'x64',
      home,
      baseDir,
      xdgConfigHome,
      executablePath: '/opt/AgentBean/dist/bin.js',
      nodeExecutablePath: '/usr/bin/node',
      createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
      waitForReady: vi.fn(async () => runningState()),
      assertRuntimeOwner: vi.fn(async () => undefined),
    })).resolves.toBe(DEVICE_CLI_EXIT.success);

    const paths = linuxSystemdUserPaths({ home, baseDir, xdgConfigHome });
    expect(await readFile(paths.unitFile, 'utf8')).toContain(deviceServicePaths(baseDir).payloadFile);
    expect((await stat(deviceServicePaths(baseDir).payloadFile)).mode & 0o777).toBe(0o700);
  });

  test('uninstall removes unit and payload while preserving all user data', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-linux-uninstall-'));
    const baseDir = join(home, '.agentbean');
    const payload = await writeMacOSServicePayload({ sourceExecutablePath: '/opt/AgentBean/dist/bin.js', nodeExecutablePath: '/usr/bin/node', baseDir });
    const unitFile = await writeLinuxSystemdUserUnit({ executablePath: payload, home, baseDir });
    const canary = join(baseDir, 'teams', 'profile-a', 'auth.json');
    await mkdir(dirname(canary), { recursive: true });
    await writeFile(canary, 'private-canary');
    const adapter = createLinuxSystemdUserAdapter({
      home,
      baseDir,
      run: vi.fn(async (_executable, argv) => argv.includes('show')
        ? success('LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n')
        : success()),
    });

    await expect(runDeviceCli(['uninstall'], {
      platform: 'linux', arch: 'x64', home, baseDir,
      createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.success);

    await expect(access(unitFile)).rejects.toBeDefined();
    await expect(access(payload)).rejects.toBeDefined();
    expect(await readFile(canary, 'utf8')).toBe('private-canary');
  });

  test('runs start/status/restart/stop/logs through the unified Linux CLI contract', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-linux-lifecycle-'));
    const baseDir = join(home, '.agentbean');
    await writeLinuxSystemdUserUnit({ executablePath: '/opt/AgentBean/device-service.cjs', home, baseDir });
    let running = false;
    const systemctlCalls: string[][] = [];
    const adapter = createLinuxSystemdUserAdapter({
      home,
      baseDir,
      run: vi.fn(async (_executable, argv) => {
        systemctlCalls.push([...argv]);
        if (argv.includes('show')) return success(running
          ? 'LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\n'
          : 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n');
        if (argv.includes('start')) running = true;
        return success();
      }),
    });
    const controlClient: DeviceControlClient = {
      request: vi.fn(async (request) => {
        if (request.command === 'shutdown') running = false;
        return { schemaVersion: 1, requestId: request.requestId, ok: true, state: runningState() };
      }),
    };
    const common = {
      platform: 'linux' as const,
      arch: 'x64' as const,
      home,
      baseDir,
      createAdapter: () => adapter,
      controlClient,
      waitForReady: vi.fn(async () => runningState()),
    };

    await expect(runDeviceCli(['start'], common)).resolves.toBe(DEVICE_CLI_EXIT.success);
    await expect(runDeviceCli(['status', '--json'], { ...common, stdout: vi.fn() })).resolves.toBe(DEVICE_CLI_EXIT.success);
    await expect(runDeviceCli(['restart', '--deadline-ms', '1000'], common)).resolves.toBe(DEVICE_CLI_EXIT.success);
    await expect(runDeviceCli(['stop'], common)).resolves.toBe(DEVICE_CLI_EXIT.success);
    const logOutput = vi.fn();
    await expect(runDeviceCli(['logs'], {
      ...common,
      stdout: logOutput,
      readLinuxLogs: vi.fn(async () => success('journal line\n')),
    })).resolves.toBe(DEVICE_CLI_EXIT.success);

    expect(logOutput).toHaveBeenCalledWith('journal line');
    expect(systemctlCalls.filter((argv) => argv.includes('start'))).toHaveLength(2);
  });

  test('fails closed on systemd query failure before uninstalling', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-linux-query-failure-'));
    const baseDir = join(home, '.agentbean');
    const unitFile = await writeLinuxSystemdUserUnit({ executablePath: '/opt/AgentBean/device-service.cjs', home, baseDir });
    const adapter = createLinuxSystemdUserAdapter({
      home,
      baseDir,
      run: vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'bus unavailable' })),
    });
    await expect(runDeviceCli(['uninstall'], {
      platform: 'linux', arch: 'x64', home, baseDir,
      createAdapter: () => adapter,
      controlClient: { request: vi.fn() } as unknown as DeviceControlClient,
    })).resolves.toBe(DEVICE_CLI_EXIT.platform);
    await expect(access(unitFile)).resolves.toBeUndefined();
  });
});
