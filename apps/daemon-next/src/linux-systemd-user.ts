import { execFile, spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { deviceServicePaths } from './device-service-paths.js';
import type { PlatformCommandResult, PlatformServiceAdapter } from './device-platform-service.js';

export const DEVICE_SERVICE_SYSTEMD_UNIT = 'agentbean-device-service.service';

export type SystemctlRunner = (executable: string, argv: readonly string[]) => Promise<PlatformCommandResult>;
export type JournalctlRunner = SystemctlRunner;

export interface LinuxSystemdUserPaths {
  readonly unitFile: string;
  readonly logFile: string;
  readonly errorLogFile: string;
}

export interface LinuxSystemdUserAdapter extends PlatformServiceAdapter {
  readonly unit: typeof DEVICE_SERVICE_SYSTEMD_UNIT;
  readonly paths: LinuxSystemdUserPaths;
}

export interface LinuxSystemdUserInput {
  readonly home?: string;
  readonly baseDir?: string;
  readonly xdgConfigHome?: string;
  readonly systemctlPath?: string;
  readonly run?: SystemctlRunner;
}

export function linuxSystemdUserPaths(input: Omit<LinuxSystemdUserInput, 'run' | 'systemctlPath'> = {}): LinuxSystemdUserPaths {
  const home = input.home ?? homedir();
  const configuredHome = input.xdgConfigHome ?? process.env.XDG_CONFIG_HOME;
  const configHome = configuredHome && isAbsolute(configuredHome) ? configuredHome : join(home, '.config');
  const servicePaths = deviceServicePaths(input.baseDir);
  return {
    unitFile: join(configHome, 'systemd', 'user', DEVICE_SERVICE_SYSTEMD_UNIT),
    logFile: servicePaths.logFile,
    errorLogFile: join(servicePaths.logDirectory, 'device-service.error.log'),
  };
}

export function createLinuxSystemdUserAdapter(input: LinuxSystemdUserInput = {}): LinuxSystemdUserAdapter {
  const paths = linuxSystemdUserPaths(input);
  const executable = input.systemctlPath ?? '/usr/bin/systemctl';
  const run = input.run ?? runSystemctl;
  const invoke = (argv: readonly string[]) => run(executable, ['--user', ...argv]);
  return {
    unit: DEVICE_SERVICE_SYSTEMD_UNIT,
    paths,
    async bootstrap() {
      const reloaded = await invoke(['daemon-reload']);
      if (reloaded.exitCode !== 0) return reloaded;
      return invoke(['enable', '--now', DEVICE_SERVICE_SYSTEMD_UNIT]);
    },
    start: () => invoke(['start', DEVICE_SERVICE_SYSTEMD_UNIT]),
    kill: () => invoke(['kill', '--signal=SIGTERM', DEVICE_SERVICE_SYSTEMD_UNIT]),
    async bootout() {
      const disabled = await invoke(['disable', '--now', DEVICE_SERVICE_SYSTEMD_UNIT]);
      if (disabled.exitCode !== 0) return disabled;
      return invoke(['daemon-reload']);
    },
    async status() {
      const installed = await fileExists(paths.unitFile);
      const result = await invoke(['show', DEVICE_SERVICE_SYSTEMD_UNIT, '--property=LoadState,ActiveState,SubState,MainPID']);
      if (result.exitCode !== 0) {
        return { installed, loaded: false, running: false, queryFailed: true };
      }
      const values = parseSystemdProperties(result.stdout);
      const loaded = values.LoadState === 'loaded';
      const mainPid = Number(values.MainPID ?? '0');
      return {
        installed,
        loaded,
        running: loaded && values.ActiveState === 'active' && values.SubState === 'running'
          && Number.isSafeInteger(mainPid) && mainPid > 0,
        queryFailed: false,
      };
    },
  };
}

export function generateLinuxSystemdUserUnit(input: {
  readonly executablePath: string;
  readonly home?: string;
  readonly baseDir?: string;
  readonly xdgConfigHome?: string;
}): string {
  if (!isAbsolute(input.executablePath)) throw new Error('SYSTEMD_USER_INSTALL_FAILED');
  const paths = linuxSystemdUserPaths(input);
  return `[Unit]\nDescription=AgentBean Device Service\n\n[Service]\nType=simple\nExecStart=${escapeSystemdArgument(input.executablePath)} service run\nRestart=on-failure\nRestartSec=1s\nKillMode=control-group\nStandardOutput=${escapeSystemdArgument(`append:${paths.logFile}`)}\nStandardError=${escapeSystemdArgument(`append:${paths.errorLogFile}`)}\n\n[Install]\nWantedBy=default.target\n`;
}

export async function writeLinuxSystemdUserUnit(input: {
  readonly executablePath: string;
  readonly home?: string;
  readonly baseDir?: string;
  readonly xdgConfigHome?: string;
}): Promise<string> {
  const paths = linuxSystemdUserPaths(input);
  const content = generateLinuxSystemdUserUnit(input);
  await mkdir(dirname(paths.unitFile), { recursive: true, mode: 0o700 });
  await writeAtomicFile(paths.unitFile, content, 0o600);
  return paths.unitFile;
}

export async function removeLinuxSystemdUserInstallation(input: {
  readonly home?: string;
  readonly baseDir?: string;
  readonly xdgConfigHome?: string;
} = {}): Promise<void> {
  const paths = linuxSystemdUserPaths(input);
  const servicePaths = deviceServicePaths(input.baseDir);
  await rm(paths.unitFile, { force: true });
  await rm(servicePaths.payloadDirectory, { recursive: true, force: true });
}

export async function readLinuxSystemdUserLogs(input: {
  readonly journalctlPath?: string;
  readonly run?: JournalctlRunner;
} = {}): Promise<PlatformCommandResult> {
  return (input.run ?? runSystemctl)(input.journalctlPath ?? '/usr/bin/journalctl', [
    '--user', '--unit', DEVICE_SERVICE_SYSTEMD_UNIT, '--lines', '100', '--no-pager',
  ]);
}

export async function followLinuxSystemdUserLogs(input: {
  readonly journalctlPath?: string;
} = {}): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(input.journalctlPath ?? '/usr/bin/journalctl', [
      '--user', '--unit', DEVICE_SERVICE_SYSTEMD_UNIT, '--lines', '100', '--follow',
    ], { stdio: 'inherit' });
    child.once('exit', (code) => resolve(code === 0 ? 0 : 5));
    child.once('error', () => resolve(5));
  });
}

function escapeSystemdArgument(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) throw new Error('SYSTEMD_USER_INSTALL_FAILED');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function parseSystemdProperties(stdout: string): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) properties[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return properties;
}

async function writeAtomicFile(path: string, content: string, mode: number): Promise<void> {
  try {
    if (await readFile(path, 'utf8') === content) {
      await chmod(path, mode);
      return;
    }
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
  const temporaryFile = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporaryFile, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryFile, path);
    await chmod(path, mode);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }
}

async function runSystemctl(executable: string, argv: readonly string[]): Promise<PlatformCommandResult> {
  return new Promise((resolveResult) => {
    execFile(executable, [...argv], { encoding: 'utf8' }, (error, stdout, stderr) => {
      const exitCode = error && 'code' in error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
      resolveResult({ exitCode, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await import('node:fs/promises').then(({ access }) => access(path));
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
