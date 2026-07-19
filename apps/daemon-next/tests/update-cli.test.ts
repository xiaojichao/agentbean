import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import {
  readInstalledAgentBeanPackage,
  runUpdateCli,
  UPDATE_CLI_EXIT,
} from '../src/update-cli';
import type { PlatformCommandResult } from '../src/device-platform-service';

const success = (stdout = ''): PlatformCommandResult => ({ exitCode: 0, stdout, stderr: '' });
const serviceStatus = (installed: boolean, loaded = installed) => ({
  installed, loaded, running: loaded, queryFailed: false,
});

function npmRunner(latest = '0.3.13') {
  let installedVersion = '0.3.12';
  return vi.fn(async (argv: readonly string[]) => {
    if (argv[0] === 'prefix') return success('/opt/agentbean\n');
    if (argv[0] === 'view') return success(`${JSON.stringify(latest)}\n`);
    if (argv[0] === 'install') {
      installedVersion = argv.at(-1)?.split('@').at(-1) ?? installedVersion;
      return success();
    }
    if (argv[0] === 'list') {
      return success(JSON.stringify({ dependencies: { '@agentbean/daemon': { version: installedVersion } } }));
    }
    return { exitCode: 1, stdout: '', stderr: 'unexpected npm command' };
  });
}

describe('agentbean update', () => {
  test('does nothing when the canonical package is already current', async () => {
    const runNpm = npmRunner('0.3.12');
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm).toHaveBeenCalledTimes(2);
    expect(runAgentBean).not.toHaveBeenCalled();
  });

  test('does not downgrade a local version newer than stable', async () => {
    const runNpm = npmRunner('0.3.12');
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.4.0' }, runNpm,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm).toHaveBeenCalledTimes(2);
  });

  test('installs the exact stable version without restarting an uninstalled service', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(false),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm.mock.calls[1]?.[0]).toEqual([
      'view', '@agentbean/daemon@latest', 'version', '--json',
      '--registry=https://registry.npmjs.org/',
    ]);
    expect(runNpm.mock.calls[2]?.[0]).toEqual([
      'install', '--global', '--no-audit', '--no-fund', '--ignore-scripts',
      '--registry=https://registry.npmjs.org/', '@agentbean/daemon@0.3.13',
    ]);
    expect(runAgentBean).not.toHaveBeenCalled();
  });

  test('restarts an installed Device Service through the updated CLI', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runAgentBean).toHaveBeenNthCalledWith(1, '/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', '30000',
    ]);
    expect(runAgentBean).toHaveBeenNthCalledWith(2, '/opt/agentbean/bin/agentbean', [
      'device', 'restart', '--deadline-ms', '30000',
    ]);
  });

  test('bootstraps an installed but unloaded Device Service instead of trying to restart it', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true, false),
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runAgentBean).toHaveBeenCalledOnce();
    expect(runAgentBean).toHaveBeenCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', '30000',
    ]);
  });

  test('rolls back the package and restores the service when the new version cannot start', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce({ exitCode: 6, stdout: '', stderr: 'not ready' })
      .mockResolvedValueOnce(success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      quiesceDeviceService: async () => true,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm.mock.calls[4]?.[0]).toEqual([
      'install', '--global', '--no-audit', '--no-fund', '--ignore-scripts',
      '--registry=https://registry.npmjs.org/', '@agentbean/daemon@0.3.12',
    ]);
    expect(runAgentBean).toHaveBeenCalledTimes(3);
    expect(runAgentBean).toHaveBeenLastCalledWith('/opt/agentbean/bin/agentbean', [
      'device', 'install', '--deadline-ms', '30000',
    ]);
  });

  test('reports recovery-required when reinstalling the previous package fails', async () => {
    const runNpm = npmRunner();
    runNpm.mockImplementationOnce(async () => success('/opt/agentbean'))
      .mockImplementationOnce(async () => success('"0.3.13"'))
      .mockImplementationOnce(async () => success())
      .mockImplementationOnce(async () => success(JSON.stringify({ dependencies: { '@agentbean/daemon': { version: '0.3.13' } } })))
      .mockImplementationOnce(async () => ({ exitCode: 1, stdout: '', stderr: 'registry unavailable' }));
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm,
      runAgentBean: async (_executable, argv) => argv[1] === 'install'
        ? success()
        : { exitCode: 6, stdout: '', stderr: 'not ready' },
      getDeviceServiceStatus: async () => serviceStatus(true),
      quiesceDeviceService: async () => true,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm).toHaveBeenCalledTimes(5);
  });

  test('still restores the previous package when the LaunchAgent cannot be quiesced', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn()
      .mockResolvedValueOnce(success())
      .mockResolvedValueOnce({ exitCode: 6, stdout: '', stderr: 'not ready' });
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, getDeviceServiceStatus: async () => serviceStatus(true),
      quiesceDeviceService: async () => false,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm.mock.calls[4]?.[0]?.at(-1)).toBe('@agentbean/daemon@0.3.12');
  });

  test('rolls back when npm install succeeds but the installed version cannot be verified', async () => {
    const runNpm = npmRunner();
    runNpm.mockImplementationOnce(async () => success('/opt/agentbean'))
      .mockImplementationOnce(async () => success('"0.3.13"'))
      .mockImplementationOnce(async () => success())
      .mockImplementationOnce(async () => success('{invalid json'))
      .mockImplementationOnce(async () => success())
      .mockImplementationOnce(async () => success(JSON.stringify({
        dependencies: { '@agentbean/daemon': { version: '0.3.12' } },
      })));
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, getDeviceServiceStatus: async () => serviceStatus(false),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm.mock.calls[4]?.[0]?.at(-1)).toBe('@agentbean/daemon@0.3.12');
  });

  test('fails closed when npm global prefix is not absolute', async () => {
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm: async () => success('relative-prefix'),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
  });

  test('fails closed for unsupported sources, platforms, invalid registry output, and arguments', async () => {
    await expect(runUpdateCli([], { platform: 'linux' })).resolves.toBe(UPDATE_CLI_EXIT.platform);
    await expect(runUpdateCli(['--force'], { platform: 'darwin' })).resolves.toBe(UPDATE_CLI_EXIT.usage);
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon-next', version: '0.3.12' },
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm: async (argv) => argv[0] === 'prefix' ? success('/opt/agentbean') : success('not-a-version'),
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
  });

  test('discovers canonical package metadata by walking parent directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-update-package-'));
    const nested = join(root, 'dist', 'apps', 'daemon-next', 'src');
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: '@agentbean/daemon', version: '1.2.3' }));
    await expect(readInstalledAgentBeanPackage(nested)).resolves.toEqual({
      name: '@agentbean/daemon', version: '1.2.3',
    });
  });
});
