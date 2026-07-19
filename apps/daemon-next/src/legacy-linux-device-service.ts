import { execFile } from 'node:child_process';
import { access, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { deviceServicePaths } from './device-service-paths.js';
import type { PlatformCommandResult } from './device-platform-service.js';

const LEGACY_SYSTEMD_UNIT = 'agentbean-device-service.service';

export type LegacyLinuxCleanupResult = 'not-installed' | 'removed';

export interface LegacyLinuxCleanupInput {
  readonly home?: string;
  readonly baseDir?: string;
  readonly xdgConfigHome?: string;
  readonly systemctlPath?: string;
  readonly run?: (executable: string, argv: readonly string[]) => Promise<PlatformCommandResult>;
}

export async function cleanupLegacyLinuxDeviceService(
  input: LegacyLinuxCleanupInput = {},
): Promise<LegacyLinuxCleanupResult> {
  const home = input.home ?? homedir();
  const configuredHome = input.xdgConfigHome ?? (input.home === undefined ? process.env.XDG_CONFIG_HOME : undefined);
  const configHome = configuredHome && isAbsolute(configuredHome) ? configuredHome : join(home, '.config');
  const unitFile = join(configHome, 'systemd', 'user', LEGACY_SYSTEMD_UNIT);
  if (!(await fileExists(unitFile))) return 'not-installed';

  const executable = input.systemctlPath ?? '/usr/bin/systemctl';
  const run = input.run ?? runSystemctl;
  const disabled = await run(executable, ['--user', 'disable', '--now', LEGACY_SYSTEMD_UNIT]);
  if (disabled.exitCode !== 0) throw new Error('LEGACY_LINUX_SERVICE_STOP_FAILED');

  await rm(unitFile, { force: true });
  await rm(deviceServicePaths(input.baseDir).payloadDirectory, { recursive: true, force: true });
  const reloaded = await run(executable, ['--user', 'daemon-reload']);
  if (reloaded.exitCode !== 0) throw new Error('LEGACY_LINUX_SERVICE_RELOAD_FAILED');
  return 'removed';
}

async function runSystemctl(executable: string, argv: readonly string[]): Promise<PlatformCommandResult> {
  return new Promise((resolve) => {
    execFile(executable, [...argv], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolve({ exitCode, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
