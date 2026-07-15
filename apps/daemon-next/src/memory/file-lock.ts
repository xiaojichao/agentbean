import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readRegularFileNoFollow, SafeFileReadError } from './safe-file-read.js';

interface LockOwnerV2 {
  readonly schemaVersion: 2;
  readonly ownerToken: string;
  readonly pid: number;
  readonly createdAt: number;
}

interface LockHeartbeatV1 {
  readonly schemaVersion: 1;
  readonly ownerToken: string;
  readonly heartbeatAt: number;
}

interface ValidOwnerState {
  readonly kind: 'valid';
  readonly identity: FileIdentity;
  readonly metadata: Stats;
  readonly owner: LockOwnerV2;
  readonly legacyHeartbeatAt?: number;
}

interface MalformedOwnerState {
  readonly kind: 'malformed';
  readonly identity: FileIdentity;
  readonly metadata: Stats;
}

type OwnerState = { readonly kind: 'missing' }
  | { readonly kind: 'unsafe' }
  | ValidOwnerState
  | MalformedOwnerState;

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface AcquiredLock {
  readonly identity: FileIdentity;
  readonly owner: LockOwnerV2;
  readonly heartbeatFile: string;
}

interface LockHeartbeat {
  stop(): Promise<void>;
}

export interface LocalMemoryFileLockOptions {
  readonly timeoutMs?: number;
  readonly pollMs?: number;
  readonly heartbeatMs?: number;
  readonly staleHeartbeatMs?: number;
  readonly malformedGraceMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_MS = 10;
const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_STALE_HEARTBEAT_MS = 30_000;
const DEFAULT_MALFORMED_GRACE_MS = 30_000;
const MAX_LOCK_BYTES = 4_096;

/**
 * Cross-process lock with immutable owner identity and atomically replaced,
 * token-specific heartbeats. ESRCH owners are reclaimed immediately.
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
  const malformedGraceMs = positiveInteger(options.malformedGraceMs ?? DEFAULT_MALFORMED_GRACE_MS);
  if (heartbeatMs >= staleHeartbeatMs) throw new Error('LOCAL_MEMORY_LOCK_OPTIONS_INVALID');
  const deadline = Date.now() + timeoutMs;
  let acquired: AcquiredLock | undefined;
  while (!acquired) {
    try {
      acquired = await createLock(lockFile);
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw new Error('LOCAL_MEMORY_LOCK_FAILED');
      if (await reclaimAbandonedLock(lockFile, staleHeartbeatMs, malformedGraceMs, pollMs)) continue;
      if (Date.now() >= deadline) throw new Error('LOCAL_MEMORY_LOCK_TIMEOUT');
      await delay(pollMs);
    }
  }

  const heartbeat = startHeartbeat(acquired, heartbeatMs);
  try {
    return await operation();
  } finally {
    await heartbeat.stop();
    await removeLockIfOwner(lockFile, acquired).catch(() => undefined);
    await rm(acquired.heartbeatFile, { force: true }).catch(() => undefined);
  }
}

async function createLock(lockFile: string): Promise<AcquiredLock> {
  const timestamp = Date.now();
  const owner: LockOwnerV2 = {
    schemaVersion: 2,
    ownerToken: randomUUID(),
    pid: process.pid,
    createdAt: timestamp,
  };
  const heartbeatFile = lockHeartbeatFile(lockFile, owner.ownerToken);
  const ownerTemporary = `${lockFile}.owner-tmp-${process.pid}-${randomUUID()}`;
  try {
    await atomicReplace(heartbeatFile, serializeHeartbeat(owner, timestamp));
    const identity = await writeSyncedExclusive(ownerTemporary, `${JSON.stringify(owner)}\n`);
    await link(ownerTemporary, lockFile);
    await syncDirectory(dirname(lockFile));
    return { identity, owner, heartbeatFile };
  } catch (error) {
    await rm(heartbeatFile, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(ownerTemporary, { force: true }).catch(() => undefined);
  }
}

function startHeartbeat(acquired: AcquiredLock, heartbeatMs: number): LockHeartbeat {
  let pending = Promise.resolve();
  const timer = setInterval(() => {
    pending = pending
      .then(() => atomicReplace(
        acquired.heartbeatFile,
        serializeHeartbeat(acquired.owner, Date.now()),
      ))
      .catch(() => undefined);
  }, heartbeatMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
    },
  };
}

async function reclaimAbandonedLock(
  lockFile: string,
  staleHeartbeatMs: number,
  malformedGraceMs: number,
  stabilityCheckMs: number,
): Promise<boolean> {
  const state = await readOwnerState(lockFile);
  if (state.kind === 'missing' || state.kind === 'unsafe') return false;
  if (state.kind === 'malformed') {
    if (Date.now() - state.metadata.mtimeMs <= malformedGraceMs) return false;
    return removeMalformedIfStable(lockFile, state, stabilityCheckMs);
  }

  const pidState = inspectPid(state.owner.pid);
  if (pidState === 'dead') return removeValidOwner(lockFile, state);
  const heartbeatAt = await readHeartbeatAt(lockFile, state);
  if (heartbeatAt !== undefined && Date.now() - heartbeatAt > staleHeartbeatMs) {
    return removeValidOwner(lockFile, state);
  }
  if (heartbeatAt === undefined && Date.now() - state.metadata.mtimeMs > malformedGraceMs) {
    return removeValidOwnerIfStable(lockFile, state, stabilityCheckMs);
  }
  return false;
}

async function removeValidOwner(lockFile: string, state: ValidOwnerState): Promise<boolean> {
  const removed = await removeLockIfOwner(lockFile, state);
  if (removed) {
    await rm(lockHeartbeatFile(lockFile, state.owner.ownerToken), { force: true }).catch(() => undefined);
  }
  return removed;
}

async function removeValidOwnerIfStable(
  lockFile: string,
  expected: ValidOwnerState,
  stabilityCheckMs: number,
): Promise<boolean> {
  await delay(stabilityCheckMs);
  const current = await readOwnerState(lockFile);
  if (current.kind !== 'valid'
    || current.owner.ownerToken !== expected.owner.ownerToken
    || !sameIdentity(current.identity, expected.identity)
    || current.metadata.mtimeMs !== expected.metadata.mtimeMs) {
    return false;
  }
  return removeValidOwner(lockFile, current);
}

async function removeMalformedIfStable(
  lockFile: string,
  expected: MalformedOwnerState,
  stabilityCheckMs: number,
): Promise<boolean> {
  await delay(stabilityCheckMs);
  const current = await readOwnerState(lockFile);
  if (current.kind !== 'malformed'
    || !sameIdentity(current.identity, expected.identity)
    || current.metadata.size !== expected.metadata.size
    || current.metadata.mtimeMs !== expected.metadata.mtimeMs) {
    return false;
  }
  const finalMetadata = await lstat(lockFile).catch(() => undefined);
  if (!finalMetadata
    || finalMetadata.isSymbolicLink()
    || !finalMetadata.isFile()
    || !sameIdentity(fileIdentity(finalMetadata), expected.identity)) {
    return false;
  }
  await rm(lockFile);
  return true;
}

async function removeLockIfOwner(
  lockFile: string,
  expected: Pick<AcquiredLock, 'identity' | 'owner'>,
): Promise<boolean> {
  const current = await readOwnerState(lockFile);
  if (current.kind !== 'valid'
    || current.owner.ownerToken !== expected.owner.ownerToken
    || !sameIdentity(current.identity, expected.identity)) {
    return false;
  }
  await rm(lockFile);
  return true;
}

async function readOwnerState(lockFile: string): Promise<OwnerState> {
  try {
    const snapshot = await readRegularFileNoFollow(lockFile, MAX_LOCK_BYTES);
    const identity = fileIdentity(snapshot.metadata);
    let parsed: unknown;
    try {
      parsed = JSON.parse(snapshot.data.toString('utf8')) as unknown;
    } catch {
      return { kind: 'malformed', identity, metadata: snapshot.metadata };
    }
    const owner = parseOwner(parsed);
    return owner
      ? { kind: 'valid', identity, metadata: snapshot.metadata, ...owner }
      : { kind: 'malformed', identity, metadata: snapshot.metadata };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
    if (error instanceof SafeFileReadError) return inspectOversizedMalformedLock(lockFile);
    return { kind: 'unsafe' };
  }
}

async function inspectOversizedMalformedLock(lockFile: string): Promise<OwnerState> {
  try {
    const metadata = await lstat(lockFile);
    if (!metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.size <= MAX_LOCK_BYTES) return { kind: 'unsafe' };
    return { kind: 'malformed', identity: fileIdentity(metadata), metadata };
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'missing' } : { kind: 'unsafe' };
  }
}

function parseOwner(value: unknown): {
  readonly owner: LockOwnerV2;
  readonly legacyHeartbeatAt?: number;
} | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const common = typeof record.ownerToken === 'string'
    && record.ownerToken.length > 0
    && Number.isSafeInteger(record.pid)
    && Number(record.pid) > 0
    && Number.isSafeInteger(record.createdAt);
  if (!common) return undefined;
  if (record.schemaVersion === 2 && Object.keys(record).length === 4) {
    return { owner: record as unknown as LockOwnerV2 };
  }
  if (record.schemaVersion === 1
    && Object.keys(record).length === 5
    && Number.isSafeInteger(record.heartbeatAt)
    && Number(record.heartbeatAt) >= Number(record.createdAt)) {
    return {
      owner: {
        schemaVersion: 2,
        ownerToken: String(record.ownerToken),
        pid: Number(record.pid),
        createdAt: Number(record.createdAt),
      },
      legacyHeartbeatAt: Number(record.heartbeatAt),
    };
  }
  return undefined;
}

async function readHeartbeatAt(lockFile: string, state: ValidOwnerState): Promise<number | undefined> {
  if (state.legacyHeartbeatAt !== undefined) return state.legacyHeartbeatAt;
  try {
    const snapshot = await readRegularFileNoFollow(
      lockHeartbeatFile(lockFile, state.owner.ownerToken),
      MAX_LOCK_BYTES,
    );
    const parsed = JSON.parse(snapshot.data.toString('utf8')) as unknown;
    return isHeartbeat(parsed, state.owner.ownerToken) ? parsed.heartbeatAt : undefined;
  } catch {
    return undefined;
  }
}

function isHeartbeat(value: unknown, ownerToken: string): value is LockHeartbeatV1 {
  if (!value || typeof value !== 'object') return false;
  const heartbeat = value as Partial<LockHeartbeatV1>;
  return Object.keys(heartbeat).length === 3
    && heartbeat.schemaVersion === 1
    && heartbeat.ownerToken === ownerToken
    && Number.isSafeInteger(heartbeat.heartbeatAt);
}

function serializeHeartbeat(owner: LockOwnerV2, heartbeatAt: number): string {
  const heartbeat: LockHeartbeatV1 = {
    schemaVersion: 1,
    ownerToken: owner.ownerToken,
    heartbeatAt,
  };
  return `${JSON.stringify(heartbeat)}\n`;
}

async function atomicReplace(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeSyncedExclusive(temporary, content);
    await rename(temporary, file);
    await syncDirectory(dirname(file));
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeSyncedExclusive(file: string, content: string): Promise<FileIdentity> {
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
  try {
    await writeAll(handle, Buffer.from(content, 'utf8'));
    await handle.sync();
    return fileIdentity(await handle.stat());
  } finally {
    await handle.close();
  }
}

async function writeAll(handle: FileHandle, content: Buffer): Promise<void> {
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(content, offset, content.length - offset, offset);
    if (bytesWritten <= 0) throw new Error('LOCAL_MEMORY_LOCK_WRITE_FAILED');
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Some target platforms do not support directory fsync; the file fsync remains mandatory.
  }
}

function lockHeartbeatFile(lockFile: string, ownerToken: string): string {
  return `${lockFile}.heartbeat-${ownerToken}`;
}

function inspectPid(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'dead';
    if (errorCode(error) === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function fileIdentity(metadata: Pick<Stats, 'dev' | 'ino'>): FileIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
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
