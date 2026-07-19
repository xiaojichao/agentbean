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

function npmRunner(latest = '0.3.13') {
  let installedVersion = '0.3.12';
  return vi.fn(async (argv: readonly string[]) => {
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
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runAgentBean).not.toHaveBeenCalled();
  });

  test('does not downgrade a local version newer than stable', async () => {
    const runNpm = npmRunner('0.3.12');
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.4.0' }, runNpm,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm).toHaveBeenCalledTimes(1);
  });

  test('installs the exact stable version without restarting an uninstalled service', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, isDeviceServiceInstalled: async () => false,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runNpm.mock.calls[1]?.[0]).toEqual([
      'install', '--global', '--no-audit', '--no-fund', '@agentbean/daemon@0.3.13',
    ]);
    expect(runAgentBean).not.toHaveBeenCalled();
  });

  test('restarts an installed Device Service through the updated CLI', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn(async () => success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, isDeviceServiceInstalled: async () => true,
    })).resolves.toBe(UPDATE_CLI_EXIT.success);
    expect(runAgentBean).toHaveBeenCalledWith(['device', 'restart', '--deadline-ms', '30000']);
  });

  test('rolls back the package and restores the service when the new version cannot start', async () => {
    const runNpm = npmRunner();
    const runAgentBean = vi.fn()
      .mockResolvedValueOnce({ exitCode: 6, stdout: '', stderr: 'not ready' })
      .mockResolvedValueOnce(success());
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm, runAgentBean, isDeviceServiceInstalled: async () => true,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm.mock.calls[3]?.[0]).toEqual([
      'install', '--global', '--no-audit', '--no-fund', '@agentbean/daemon@0.3.12',
    ]);
    expect(runAgentBean).toHaveBeenCalledTimes(2);
  });

  test('reports recovery-required when reinstalling the previous package fails', async () => {
    const runNpm = npmRunner();
    runNpm.mockImplementationOnce(async () => success('"0.3.13"'))
      .mockImplementationOnce(async () => success())
      .mockImplementationOnce(async () => success(JSON.stringify({ dependencies: { '@agentbean/daemon': { version: '0.3.13' } } })))
      .mockImplementationOnce(async () => ({ exitCode: 1, stdout: '', stderr: 'registry unavailable' }));
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm,
      runAgentBean: async () => ({ exitCode: 6, stdout: '', stderr: 'not ready' }),
      isDeviceServiceInstalled: async () => true,
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    expect(runNpm).toHaveBeenCalledTimes(4);
  });

  test('fails closed for unsupported sources, platforms, invalid registry output, and arguments', async () => {
    await expect(runUpdateCli([], { platform: 'linux' })).resolves.toBe(UPDATE_CLI_EXIT.platform);
    await expect(runUpdateCli(['--force'], { platform: 'darwin' })).resolves.toBe(UPDATE_CLI_EXIT.usage);
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon-next', version: '0.3.12' },
    })).resolves.toBe(UPDATE_CLI_EXIT.rejected);
    await expect(runUpdateCli([], {
      platform: 'darwin', currentPackage: { name: '@agentbean/daemon', version: '0.3.12' },
      runNpm: async () => success('not-a-version'),
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
