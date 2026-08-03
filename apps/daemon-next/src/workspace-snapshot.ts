import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseDeviceWorkspaceSnapshot, type DeviceWorkspaceSnapshotDto } from '../../../packages/contracts/src/index.js';

export type DeviceWorkspaceSnapshotMaterializeError =
  | 'SNAPSHOT_INVALID'
  | 'SNAPSHOT_INCOMPLETE'
  | 'DOWNLOAD_FAILED'
  | 'IDENTITY_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'SHA_MISMATCH'
  | 'AUTHORITY_REVOKED'
  | 'PERMISSION'
  | 'WRITE_FAILED';

export type DeviceWorkspaceSnapshotMaterializeResult =
  | { readonly ok: true; readonly snapshotDir: string; readonly written: readonly string[]; readonly offline: boolean }
  | { readonly ok: false; readonly error: DeviceWorkspaceSnapshotMaterializeError };

export interface MaterializeDeviceWorkspaceSnapshotInput {
  readonly snapshot: DeviceWorkspaceSnapshotDto;
  readonly snapshotDir: string;
  readonly serverUrl: string;
  readonly token: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly fetch?: typeof fetch;
  /** Online refresh against Server authority before any new bytes are downloaded. */
  readonly refreshSnapshot?: () => Promise<DeviceWorkspaceSnapshotDto | null>;
}

function safeRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function permissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
}

function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function snapshotManifest(snapshot: DeviceWorkspaceSnapshotDto): string {
  return `${JSON.stringify({ schemaVersion: 1, snapshot, complete: true }, null, 2)}\n`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateSnapshotShape(snapshot: DeviceWorkspaceSnapshotDto): boolean {
  if (snapshot.immutable !== true || snapshot.inputSet.contractVersion !== 1 || snapshot.inputSet.items.length === 0) return false;
  const paths = new Set<string>();
  const versions = new Set<string>();
  for (const item of snapshot.inputSet.items) {
    if (!safeRelativePath(item.path) || paths.has(item.path) || versions.has(item.artifactVersionId)
      || !item.artifactId || !item.collectionId || !/^[a-f0-9]{64}$/i.test(item.sha256)
      || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) return false;
    paths.add(item.path);
    versions.add(item.artifactVersionId);
  }
  return true;
}

async function verifyLocalSnapshot(snapshotDir: string, snapshot: DeviceWorkspaceSnapshotDto): Promise<boolean> {
  try {
    const raw = JSON.parse(await readFile(join(snapshotDir, 'manifest.json'), 'utf8')) as { snapshot?: DeviceWorkspaceSnapshotDto; complete?: boolean };
    if (!raw.complete || !raw.snapshot || !validateSnapshotShape(raw.snapshot)
      || raw.snapshot.id !== snapshot.id
      || raw.snapshot.workspaceRevisionId !== snapshot.workspaceRevisionId
      || canonicalJson(raw.snapshot) !== canonicalJson(snapshot)) return false;
    for (const item of snapshot.inputSet.items) {
      const file = await readFile(join(snapshotDir, item.path));
      if (file.byteLength !== item.sizeBytes) return false;
      if (createHash('sha256').update(file).digest('hex') !== item.sha256.toLowerCase()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function assertNoSymlinkPath(path: string): Promise<void> {
  let current = resolve(path);
  const trustedSystemSymlinks = new Set(['/var', '/tmp']);
  while (true) {
    try {
      if (!trustedSystemSymlinks.has(current) && (await lstat(current)).isSymbolicLink()) {
        throw new Error('SNAPSHOT_SYMLINK_ESCAPE');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

/** Server 在线时最小下载；已完成 snapshot 可直接离线复用。 */
export async function materializeDeviceWorkspaceSnapshot(
  input: MaterializeDeviceWorkspaceSnapshotInput,
): Promise<DeviceWorkspaceSnapshotMaterializeResult> {
  let snapshot: DeviceWorkspaceSnapshotDto;
  try {
    snapshot = parseDeviceWorkspaceSnapshot(input.snapshot);
  } catch {
    return { ok: false, error: 'SNAPSHOT_INVALID' };
  }
  if (input.teamId !== snapshot.teamId || input.channelId !== snapshot.channelId || !validateSnapshotShape(snapshot)) {
    return { ok: false, error: 'SNAPSHOT_INVALID' };
  }
  const snapshotDir = resolve(input.snapshotDir);
  try {
    await assertNoSymlinkPath(snapshotDir);
  } catch {
    return { ok: false, error: 'SNAPSHOT_INVALID' };
  }
  if (await verifyLocalSnapshot(snapshotDir, snapshot)) {
    return { ok: true, snapshotDir, written: snapshot.inputSet.items.map((item) => item.path), offline: true };
  }
  if (input.refreshSnapshot) {
    let refreshed: DeviceWorkspaceSnapshotDto | null;
    try {
      refreshed = await input.refreshSnapshot();
    } catch {
      return { ok: false, error: 'AUTHORITY_REVOKED' };
    }
    if (!refreshed) return { ok: false, error: 'AUTHORITY_REVOKED' };
    try {
      const parsed = parseDeviceWorkspaceSnapshot(refreshed);
      if (canonicalJson(parsed) !== canonicalJson(snapshot)) return { ok: false, error: 'IDENTITY_MISMATCH' };
    } catch {
      return { ok: false, error: 'AUTHORITY_REVOKED' };
    }
  }
  const fetchFn = input.fetch ?? fetch;
  const stagingDir = `${snapshotDir}.agentbean-snapshot-staging`;
  try {
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true });
  } catch (error) {
    return { ok: false, error: permissionError(error) ? 'PERMISSION' : 'WRITE_FAILED' };
  }
  try {
    for (const item of snapshot.inputSet.items) {
      const url = `${trimTrailingSlash(input.serverUrl)}/api/teams/${encodeURIComponent(input.teamId)}/artifacts/${encodeURIComponent(item.artifactId)}/download?artifactVersionId=${encodeURIComponent(item.artifactVersionId)}`;
      let response: Response;
      try {
        response = await fetchFn(url, { headers: { Authorization: `Bearer ${input.token}` } });
      } catch {
        throw new Error('DOWNLOAD_FAILED');
      }
      if (!response.ok) throw new Error('DOWNLOAD_FAILED');
      const remoteVersion = response.headers.get('x-artifact-version-id');
      if (remoteVersion !== item.artifactVersionId) throw new Error('IDENTITY_MISMATCH');
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength !== item.sizeBytes) throw new Error('SIZE_MISMATCH');
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256.toLowerCase()) throw new Error('SHA_MISMATCH');
      const path = join(stagingDir, item.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes, { mode: 0o444 });
      await chmod(path, 0o444);
    }
    await writeFile(join(stagingDir, 'manifest.json'), snapshotManifest(snapshot), { mode: 0o444 });
    await chmod(join(stagingDir, 'manifest.json'), 0o444);
    await mkdir(dirname(snapshotDir), { recursive: true });
    // Rename-based swap keeps the last known-good snapshot until the replacement
    // is fully staged. A failed swap attempts to restore the previous directory.
    const backupDir = `${snapshotDir}.agentbean-snapshot-backup-${randomUUID()}`;
    let movedExisting = false;
    try {
      try {
        await rename(snapshotDir, backupDir);
        movedExisting = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw error;
      }
      await rename(stagingDir, snapshotDir);
      if (movedExisting) await rm(backupDir, { recursive: true, force: true });
    } catch (error) {
      if (movedExisting) {
        try { await rename(backupDir, snapshotDir); } catch { /* retain diagnostic backup */ }
      }
      throw error;
    }
    return { ok: true, snapshotDir, written: snapshot.inputSet.items.map((item) => item.path), offline: false };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    const code = error instanceof Error ? error.message : '';
    if (code === 'DOWNLOAD_FAILED' || code === 'IDENTITY_MISMATCH' || code === 'SIZE_MISMATCH' || code === 'SHA_MISMATCH' || code === 'AUTHORITY_REVOKED') {
      return { ok: false, error: code };
    }
    return { ok: false, error: permissionError(error) ? 'PERMISSION' : 'WRITE_FAILED' };
  }
}

/** 离线启动门禁：只有完整且 hash/size 仍匹配的 snapshot 才能进入 run。 */
export async function assertDeviceWorkspaceSnapshotReady(
  snapshotDir: string,
  snapshot: DeviceWorkspaceSnapshotDto,
): Promise<void> {
  if (!validateSnapshotShape(snapshot) || !(await verifyLocalSnapshot(resolve(snapshotDir), snapshot))) throw new Error('SNAPSHOT_INCOMPLETE');
}

/** 将已物化 snapshot 的只读文件复制到本次 run inputs，run 不读取 current/final。 */
export async function materializeSnapshotInputs(snapshotDir: string, inputDir: string, snapshot: DeviceWorkspaceSnapshotDto): Promise<string[]> {
  await assertDeviceWorkspaceSnapshotReady(snapshotDir, snapshot);
  await assertNoSymlinkPath(inputDir);
  const written: string[] = [];
  for (const item of snapshot.inputSet.items) {
    const destination = join(resolve(inputDir), item.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(resolve(snapshotDir), item.path), destination);
    written.push(item.path);
  }
  return written;
}

export async function isDeviceWorkspaceSnapshotReady(snapshotDir: string, snapshot: DeviceWorkspaceSnapshotDto): Promise<boolean> {
  return validateSnapshotShape(snapshot) && verifyLocalSnapshot(resolve(snapshotDir), snapshot);
}
