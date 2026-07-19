import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface LockOwner {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly nonce: string;
  readonly acquiredAt: string;
}

export interface DeviceServiceLock {
  release(): Promise<void>;
}

export class DeviceServiceAlreadyRunningError extends Error {
  readonly code = 'SERVICE_ALREADY_RUNNING';

  constructor() {
    super('SERVICE_ALREADY_RUNNING');
    this.name = 'DeviceServiceAlreadyRunningError';
  }
}

export interface AcquireDeviceServiceLockOptions {
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly now?: () => Date;
}

export async function acquireDeviceServiceLock(
  lockDirectory: string,
  options: AcquireDeviceServiceLockOptions = {},
): Promise<DeviceServiceLock> {
  const pid = options.pid ?? process.pid;
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const now = options.now ?? (() => new Date());
  const owner: LockOwner = {
    schemaVersion: 1,
    pid,
    nonce: randomUUID(),
    acquiredAt: now().toISOString(),
  };

  await mkdir(dirname(lockDirectory), { recursive: true, mode: 0o700 });
  const candidateDirectory = `${lockDirectory}.candidate-${owner.nonce}`;
  await mkdir(candidateDirectory, { mode: 0o700 });
  await writeFile(`${candidateDirectory}/owner.json`, `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await rename(candidateDirectory, lockDirectory);
        acquired = true;
        return {
          async release() {
            const current = await readLockOwner(lockDirectory);
            if (current?.nonce !== owner.nonce) return;
            await rm(lockDirectory, { recursive: true, force: true });
          },
        };
      } catch (error) {
        if (!isNodeError(error, 'EEXIST') && !isNodeError(error, 'ENOTEMPTY')) throw error;
      }
      const current = await readLockOwner(lockDirectory);
      if (current && isProcessAlive(current.pid)) {
        throw new DeviceServiceAlreadyRunningError();
      }
      const quarantine = `${lockDirectory}.stale-${randomUUID()}`;
      try {
        await rename(lockDirectory, quarantine);
      } catch (renameError) {
        if (isNodeError(renameError, 'ENOENT')) continue;
        throw renameError;
      }
      await rm(quarantine, { recursive: true, force: true });
    }
  } finally {
    if (!acquired) await rm(candidateDirectory, { recursive: true, force: true });
  }
  throw new DeviceServiceAlreadyRunningError();
}

async function readLockOwner(lockDirectory: string): Promise<LockOwner | null> {
  try {
    const candidate = JSON.parse(await readFile(`${lockDirectory}/owner.json`, 'utf8')) as Partial<LockOwner>;
    if (candidate.schemaVersion !== 1 || !Number.isSafeInteger(candidate.pid)
      || (candidate.pid as number) <= 0 || typeof candidate.nonce !== 'string') {
      return null;
    }
    return candidate as LockOwner;
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || error instanceof SyntaxError) return null;
    throw error;
  }
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
