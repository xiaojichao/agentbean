import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open, rm, type FileHandle } from 'node:fs/promises';

interface LockOwnerV1 {
  readonly schemaVersion: 1;
  readonly ownerToken: string;
  readonly pid: number;
  readonly createdAt: number;
  readonly heartbeatAt: number;
}

export interface LocalMemoryFileLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly staleHeartbeatMs?: number;
}

interface AcquiredLock {
  readonly handle: FileHandle;
  readonly identity: Pick<Stats, 'dev' | 'ino'>;
  readonly owner: LockOwnerV1;
}

interface LockHeartbeat {
  stop(): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 10;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_HEARTBEAT_MS = 30_000;
const MAX_LOCK_BYTES = 4_096;

/**
 * Cross-process lock with explicit ownership. A lock is reclaimed only when its
 * heartbeat is stale and its PID is no longer alive; mtime alone is never used.
 */
export async function withLocalMemoryFileLock<T>(
  lockFile: string,
  operation: () => Promise<T>,
  options: LocalMemoryFileLockOptions = {},
): Promise<T> {
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const pollMs = positiveInteger(options.pollMs ?? DEFAULT_POLL_MS);
  const heartbeatMs = positiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  const staleHeartbeatMs = positiveInteger(options.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS);
  if (heartbeatMs >= staleHeartbeatMs) throw new Error('LOCAL_MEMORY_LOCK_OPTIONS_INVALID');
  const deadline = Date.now() + timeoutMs;
  let acquired: AcquiredLock | undefined;
  while (!acquired) {
    try {
      acquired = await createLock(lockFile);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw new Error('LOCAL_MEMORY_LOCK_FAILED');
      if (await reclaimAbandonedLock(lockFile, staleHeartbeatMs)) continue;
      if (Date.now() >= deadline) throw new Error('LOCAL_MEMORY_LOCK_TIMEOUT');
      await delay(pollMs);
    }
  }

  const heartbeat = startHeartbeat(acquired, heartbeatMs);
  try {
    return await operation();
  } finally {
    await heartbeat.stop();
    await acquired.handle.close().catch(() => undefined);
    await removeLockIfOwner(lockFile, acquired).catch(() => undefined);
  }
}

async function createLock(lockFile: string): Promise<AcquiredLock> {
  const handle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  const timestamp = Date.now();
  const owner: LockOwnerV1 = {
    schemaVersion: 1,
    ownerToken: randomUUID(),
    pid: process.pid,
    createdAt: timestamp,
    heartbeatAt: timestamp,
  };
  try {
    await writeOwner(handle, owner);
    const metadata = await handle.stat();
    return { handle, identity: fileIdentity(metadata), owner };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await removeLockIfToken(lockFile, owner.ownerToken).catch(() => undefined);
    throw error;
  }
}

function startHeartbeat(acquired: AcquiredLock, heartbeatMs: number): LockHeartbeat {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    const owner: LockOwnerV1 = { ...acquired.owner, heartbeatAt: Date.now() };
    pending = pending.then(() => writeOwner(acquired.handle, owner)).catch(() => undefined);
  }, heartbeatMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}

async function writeOwner(handle: FileHandle, owner: LockOwnerV1): Promise<void> {
  const serialized = Buffer.from(`${JSON.stringify(owner)}\n`, 'utf8');
  let offset = 0;
  while (offset < serialized.length) {
    const { bytesWritten } = await handle.write(
      serialized,
      offset,
      serialized.length - offset,
      offset,
    );
    if (bytesWritten <= 0) throw new Error('LOCAL_MEMORY_LOCK_WRITE_FAILED');
    offset += bytesWritten;
  }
  await handle.truncate(serialized.length);
  await handle.sync();
}

async function reclaimAbandonedLock(lockFile: string, staleHeartbeatMs: number): Promise<boolean> {
  const snapshot = await readLock(lockFile);
  if (!snapshot) return false;
  if (Date.now() - snapshot.owner.heartbeatAt <= staleHeartbeatMs || isPidAlive(snapshot.owner.pid)) {
    return false;
  }
  return removeLockIfOwner(lockFile, snapshot);
}

async function removeLockIfOwner(
  lockFile: string,
  expected: Pick<AcquiredLock, 'identity' | 'owner'>,
): Promise<boolean> {
  const current = await readLock(lockFile);
  if (!current
    || current.owner.ownerToken !== expected.owner.ownerToken
    || !sameIdentity(current.identity, expected.identity)) {
    return false;
  }
  await rm(lockFile);
  return true;
}

async function removeLockIfToken(lockFile: string, ownerToken: string): Promise<boolean> {
  const current = await readLock(lockFile);
  if (!current || current.owner.ownerToken !== ownerToken) return false;
  await rm(lockFile);
  return true;
}

async function readLock(lockFile: string): Promise<AcquiredLock | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(lockFile, constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    return undefined;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size <= 0 || metadata.size > MAX_LOCK_BYTES) return undefined;
    const buffer = Buffer.alloc(Number(metadata.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length) return undefined;
    const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!isLockOwner(parsed)) return undefined;
    return { handle, identity: fileIdentity(metadata), owner: parsed };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isLockOwner(value: unknown): value is LockOwnerV1 {
  if (!value || typeof value !== 'object') return false;
  const owner = value as Partial<LockOwnerV1>;
  return Object.keys(owner).length === 5
    && owner.schemaVersion === 1
    && typeof owner.ownerToken === 'string'
    && owner.ownerToken.length > 0
    && Number.isSafeInteger(owner.pid)
    && Number(owner.pid) > 0
    && Number.isSafeInteger(owner.createdAt)
    && Number.isSafeInteger(owner.heartbeatAt)
    && Number(owner.heartbeatAt) >= Number(owner.createdAt);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

function fileIdentity(metadata: Stats): Pick<Stats, 'dev' | 'ino'> {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(
  left: Pick<Stats, 'dev' | 'ino'>,
  right: Pick<Stats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function noFollowFlag(): number {
  return typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('LOCAL_MEMORY_LOCK_OPTIONS_INVALID');
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
