import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deviceServicePaths } from './device-service-paths.js';

const HEARTBEAT_MS = 2_000;
const FRESH_FOR_MS = 10_000;
const execFileAsync = promisify(execFile);

interface LegacyRuntimeRecord {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly startedAt: string;
}

export interface LegacyRuntimeRegistration {
  readonly pid: number;
  readonly file: string;
  release(): Promise<void>;
}

export interface RegisteredLegacyRuntime extends LegacyRuntimeRecord {
  readonly file: string;
  readonly fresh: boolean;
  readonly alive: boolean;
}

export async function registerLegacyRuntime(
  baseDir?: string,
  options: { pid?: number; now?: () => number } = {},
): Promise<LegacyRuntimeRegistration> {
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const directory = deviceServicePaths(baseDir).legacyRuntimeDirectory;
  const nonce = randomUUID();
  const file = join(directory, `${pid}-${nonce}.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const record: LegacyRuntimeRecord = {
    schemaVersion: 1,
    pid,
    nonce,
    startedAt: new Date(now()).toISOString(),
  };
  await writeFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  const registeredAt = new Date(now());
  await utimes(file, registeredAt, registeredAt);
  const heartbeat = setInterval(() => {
    const timestamp = new Date(now());
    void utimes(file, timestamp, timestamp).catch(() => undefined);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  let released = false;
  return {
    pid,
    file,
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      await rm(file, { force: true });
    },
  };
}

export async function listRegisteredLegacyRuntimes(
  baseDir?: string,
  options: { now?: () => number; isProcessAlive?: (pid: number) => boolean } = {},
): Promise<RegisteredLegacyRuntime[]> {
  const directory = deviceServicePaths(baseDir).legacyRuntimeDirectory;
  const now = options.now ?? Date.now;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return [];
    throw error;
  }
  const runtimes: RegisteredLegacyRuntime[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json')) continue;
    const file = join(directory, name);
    try {
      const [raw, metadata] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      const record = JSON.parse(raw) as Partial<LegacyRuntimeRecord>;
      if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0
        || typeof record.nonce !== 'string' || typeof record.startedAt !== 'string') {
        throw new Error('LEGACY_RUNTIME_REGISTRATION_INVALID');
      }
      runtimes.push({
        schemaVersion: 1,
        pid: record.pid as number,
        nonce: record.nonce,
        startedAt: record.startedAt,
        file,
        fresh: now() - metadata.mtimeMs <= FRESH_FOR_MS,
        alive: isProcessAlive(record.pid as number),
      });
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
  return runtimes;
}

export async function discoverUnregisteredLegacyRuntimePids(
  registeredPids: ReadonlySet<number>,
  options: { pid?: number; runPs?: () => Promise<string> } = {},
): Promise<number[]> {
  const currentPid = options.pid ?? process.pid;
  let output: string;
  try {
    output = await (options.runPs ?? (async () => {
      const result = await execFileAsync('/bin/ps', ['-x', '-o', 'pid=', '-o', 'command='], {
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      });
      return result.stdout;
    }))();
  } catch {
    throw new Error('LEGACY_RUNTIME_DISCOVERY_UNAVAILABLE');
  }
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? '';
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid || registeredPids.has(pid)) continue;
    if (isLegacyDaemonCommand(command)) pids.push(pid);
  }
  return pids.sort((left, right) => left - right);
}

export async function discoverInstalledLegacyExecutables(
  pathValue = process.env.PATH ?? '',
): Promise<string[]> {
  const found = new Set<string>();
  const ownerFenceResults = new Map<string, boolean>();
  for (const directory of pathValue.split(':').filter(Boolean)) {
    for (const name of ['agentbean', 'agentbean-daemon', 'agentbean-next-daemon', 'daemon']) {
      try {
        const resolved = await realpath(join(directory, name));
        if (resolved.includes('/node_modules/@agentbean/daemon/')
          || resolved.includes('/node_modules/@agentbean/daemon-next/')) {
          let safe = ownerFenceResults.get(resolved);
          if (safe === undefined) {
            safe = await executableHonorsOwnerFence(resolved);
            ownerFenceResults.set(resolved, safe);
          }
          if (!safe) found.add(resolved);
        }
      } catch (error) {
        if (!isNodeError(error, 'ENOENT') && !isNodeError(error, 'ENOTDIR')) throw error;
      }
    }
  }
  return [...found].sort();
}

async function executableHonorsOwnerFence(executable: string): Promise<boolean> {
  const baseDir = await mkdtemp(join(tmpdir(), 'agentbean-owner-fence-probe-'));
  try {
    const serviceDirectory = join(baseDir, 'service');
    await mkdir(serviceDirectory, { mode: 0o700 });
    await writeFile(join(serviceDirectory, 'runtime-owner.json'), '{"schemaVersion":1,"owner":"device-service"}\n', {
      mode: 0o600,
    });
    try {
      await execFileAsync(executable, ['--list-profiles'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: baseDir,
          AGENTBEAN_HOME: baseDir,
        },
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return false;
    } catch (error) {
      const output = `${readProcessOutput(error, 'stdout')}\n${readProcessOutput(error, 'stderr')}`;
      return output.includes('DEVICE_SERVICE_OWNS_RUNTIME：Legacy Daemon 已停用');
    }
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
}

function readProcessOutput(error: unknown, key: 'stdout' | 'stderr'): string {
  if (!error || typeof error !== 'object' || !(key in error)) return '';
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function isLegacyDaemonCommand(command: string): boolean {
  if (/\s(?:device)(?:\s|$)/.test(command) || /\sservice\s+run(?:\s|$)/.test(command)) return false;
  const launchTokens = command.trim().split(/\s+/).slice(0, 2);
  const launchPath = launchTokens.join(' ');
  return launchTokens.some((token) => /(?:^|\/)(?:agentbean|agentbean-daemon|agentbean-next-daemon)$/.test(token))
    || /(?:@agentbean\/daemon-next|apps\/daemon-next).*\/bin\.js(?:\s|$)/.test(launchPath)
    || /@agentbean\/daemon(?:@|\/|\s)/.test(command)
    || (launchTokens.some((token) => /(?:^|\/)daemon$/.test(token))
      && /\s--server-url\s/.test(command)
      && /\s--(?:profile-id|invite-code|all-profiles)(?:\s|$)/.test(command));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
