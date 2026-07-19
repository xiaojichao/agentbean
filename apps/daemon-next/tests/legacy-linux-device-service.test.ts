import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, test, vi } from 'vitest';
import { deviceServicePaths } from '../src/device-service-paths';
import { cleanupLegacyLinuxDeviceService } from '../src/legacy-linux-device-service';

describe('legacy Linux Device Service cleanup', () => {
  test('disables the old user unit before deleting only its unit and payload', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-linux-cleanup-'));
    const baseDir = join(home, '.agentbean');
    const unitFile = join(home, '.config', 'systemd', 'user', 'agentbean-device-service.service');
    const paths = deviceServicePaths(baseDir);
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    await mkdir(paths.payloadDirectory, { recursive: true });
    await mkdir(join(baseDir, 'profiles'), { recursive: true });
    await writeFile(unitFile, '[Service]\n');
    await writeFile(paths.payloadFile, 'payload');
    await writeFile(join(baseDir, 'profiles', 'keep.json'), 'user-data');
    const run = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await expect(cleanupLegacyLinuxDeviceService({ home, baseDir, run })).resolves.toBe('removed');

    expect(run.mock.calls).toEqual([
      ['/usr/bin/systemctl', ['--user', 'disable', '--now', 'agentbean-device-service.service']],
      ['/usr/bin/systemctl', ['--user', 'daemon-reload']],
    ]);
    await expect(access(unitFile)).rejects.toThrow();
    await expect(access(paths.payloadDirectory)).rejects.toThrow();
    await expect(access(join(baseDir, 'profiles', 'keep.json'))).resolves.toBeUndefined();
  });

  test('fails closed and preserves files when systemd cannot stop the old unit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentbean-linux-cleanup-fail-'));
    const baseDir = join(home, '.agentbean');
    const unitFile = join(home, '.config', 'systemd', 'user', 'agentbean-device-service.service');
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(unitFile, '[Service]\n');

    await expect(cleanupLegacyLinuxDeviceService({
      home,
      baseDir,
      run: async () => ({ exitCode: 1, stdout: '', stderr: 'failed' }),
    })).rejects.toThrow('LEGACY_LINUX_SERVICE_STOP_FAILED');
    await expect(access(unitFile)).resolves.toBeUndefined();
  });
});
