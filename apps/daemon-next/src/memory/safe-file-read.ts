import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';

export interface SafeFileReadOptions {
  /** Test hook for exercising platforms such as Windows without O_NOFOLLOW. */
  readonly forceIdentityFallback?: boolean;
}

export interface SafeFileSnapshot {
  readonly data: Buffer;
  readonly metadata: Stats;
}

export class SafeFileReadError extends Error {
  readonly code = 'SAFE_FILE_INVALID';

  constructor() {
    super('SAFE_FILE_INVALID');
  }
}

/** Reads a regular file through one bounded handle without ever following its final symlink. */
export async function readRegularFileNoFollow(
  path: string,
  maxBytes: number,
  options: SafeFileReadOptions = {},
): Promise<SafeFileSnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new SafeFileReadError();
  const noFollow = typeof constants.O_NOFOLLOW === 'number' && constants.O_NOFOLLOW !== 0
    ? constants.O_NOFOLLOW
    : undefined;
  return noFollow !== undefined && !options.forceIdentityFallback
    ? readNativeNoFollow(path, maxBytes, noFollow)
    : readWithIdentityFallback(path, maxBytes);
}

async function readNativeNoFollow(
  path: string,
  maxBytes: number,
  noFollow: number,
): Promise<SafeFileSnapshot> {
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    assertReadableMetadata(before, maxBytes);
    return await readBoundedStable(handle, before, maxBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readWithIdentityFallback(path: string, maxBytes: number): Promise<SafeFileSnapshot> {
  const beforePath = await lstat(path);
  if (beforePath.isSymbolicLink()) throw new SafeFileReadError();
  assertReadableMetadata(beforePath, maxBytes);
  const canonicalBefore = await realpath(path);
  const handle = await open(path, constants.O_RDONLY);
  try {
    const opened = await handle.stat();
    const [afterPath, canonicalAfter] = await Promise.all([lstat(path), realpath(path)]);
    if (afterPath.isSymbolicLink()
      || canonicalBefore !== canonicalAfter
      || !sameReliableIdentity(beforePath, opened)
      || !sameReliableIdentity(opened, afterPath)) {
      throw new SafeFileReadError();
    }
    assertReadableMetadata(opened, maxBytes);
    return await readBoundedStable(handle, opened, maxBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBoundedStable(
  handle: FileHandle,
  before: Stats,
  maxBytes: number,
): Promise<SafeFileSnapshot> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  const after = await handle.stat();
  assertReadableMetadata(after, maxBytes);
  if (offset > maxBytes || !sameReliableIdentity(before, after) || metadataChanged(before, after)) {
    throw new SafeFileReadError();
  }
  return { data: buffer.subarray(0, offset), metadata: after };
}

function assertReadableMetadata(metadata: Stats, maxBytes: number): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 0 || metadata.size > maxBytes) {
    throw new SafeFileReadError();
  }
}

function sameReliableIdentity(left: Stats, right: Stats): boolean {
  const reliable = Number.isSafeInteger(left.dev)
    && Number.isSafeInteger(left.ino)
    && Number.isSafeInteger(right.dev)
    && Number.isSafeInteger(right.ino)
    && (left.dev !== 0 || left.ino !== 0)
    && (right.dev !== 0 || right.ino !== 0);
  return reliable && left.dev === right.dev && left.ino === right.ino;
}

function metadataChanged(left: Stats, right: Stats): boolean {
  return left.size !== right.size
    || left.mtimeMs !== right.mtimeMs
    || left.ctimeMs !== right.ctimeMs;
}
