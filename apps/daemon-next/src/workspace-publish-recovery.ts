/**
 * #967 Device 侧可恢复 Workspace 发布。
 *
 * 将「稳定 publish identity + 本地待上传文件清单」持久化到 Device 管理目录；
 * daemon 重启或网络中断后，可按同一 identity 查询 Server 状态、续传未完成文件并 commit。
 * 本地缓存不能证明已发布——以 Server 查询结果为准。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export type LocalWorkspacePublishStatus = 'pending' | 'committed' | 'abandoned';

export interface LocalWorkspacePublishFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly expectedSizeBytes: number;
  readonly expectedSha256: string;
  /** #1044 本机上传进度镜像（Server receivedBytes 仍是权威；此处仅支撑 manifest 可检查性）。 */
  readonly uploadedBytes?: number;
  readonly complete?: boolean;
}

export interface LocalWorkspacePublishRecord {
  readonly publishId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly baselineRevisionId: string;
  readonly files: readonly LocalWorkspacePublishFile[];
  readonly status: LocalWorkspacePublishStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly committedRevisionId?: string;
  readonly provenance?: {
    readonly agentId: string;
    readonly taskId: string;
    readonly taskAttempt: number;
    /** #1044 可选追溯：产出交付的 WorkspaceRun 与交付 Device。 */
    readonly workspaceRunId?: string;
    readonly deviceId?: string;
  };
}

export interface WorkspacePublishRecoveryStore {
  save(record: LocalWorkspacePublishRecord): void;
  get(publishId: string): LocalWorkspacePublishRecord | null;
  listPending(): LocalWorkspacePublishRecord[];
  markCommitted(publishId: string, committedRevisionId: string, now: number): void;
  /** #1044 回写单文件上传进度（每个 put 成功后与 resume 同步 Server 进度时调用）。 */
  markProgress(publishId: string, path: string, uploadedBytes: number, complete: boolean, now: number): void;
  /** #1044 冲突/不可恢复批次标记为 abandoned：保留可诊断状态，不再参与自动 resume。 */
  markAbandoned(publishId: string, now: number): void;
  remove(publishId: string): void;
}

/** 基于目录的 JSON 持久化（原子 rename 写）。 */
export function createFilesystemWorkspacePublishRecoveryStore(
  rootDir: string,
): WorkspacePublishRecoveryStore {
  const dir = join(rootDir, 'workspace-publish-pending');
  mkdirSync(dir, { recursive: true });

  const pathFor = (publishId: string) => join(dir, `${sanitizeId(publishId)}.json`);

  return {
    save(record) {
      const target = pathFor(record.publishId);
      const temp = `${target}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(record, null, 2), 'utf8');
      renameSync(temp, target);
    },
    get(publishId) {
      const target = pathFor(publishId);
      if (!existsSync(target)) return null;
      return JSON.parse(readFileSync(target, 'utf8')) as LocalWorkspacePublishRecord;
    },
    listPending() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            return JSON.parse(readFileSync(join(dir, name), 'utf8')) as LocalWorkspacePublishRecord;
          } catch {
            return null;
          }
        })
        .filter((row): row is LocalWorkspacePublishRecord => Boolean(row && row.status === 'pending'))
        .sort((a, b) => a.createdAt - b.createdAt);
    },
    markCommitted(publishId, committedRevisionId, now) {
      const existing = this.get(publishId);
      if (!existing) return;
      this.save({
        ...existing,
        status: 'committed',
        committedRevisionId,
        updatedAt: now,
      });
    },
    markProgress(publishId, path, uploadedBytes, complete, now) {
      const existing = this.get(publishId);
      if (!existing) return;
      this.save({
        ...existing,
        files: existing.files.map((file) => file.path === path
          ? { ...file, uploadedBytes, complete }
          : file),
        updatedAt: now,
      });
    },
    markAbandoned(publishId, now) {
      const existing = this.get(publishId);
      if (!existing || existing.status === 'committed') return;
      this.save({ ...existing, status: 'abandoned', updatedAt: now });
    },
    remove(publishId) {
      const target = pathFor(publishId);
      if (existsSync(target)) rmSync(target, { force: true });
    },
  };
}

export interface StagingRemoteClient {
  begin(input: {
    publishId: string;
    teamId: string;
    channelId: string;
    baselineRevisionId: string;
    files: Array<{
      path: string;
      filename: string;
      mimeType: string;
      expectedSizeBytes: number;
      expectedSha256: string;
    }>;
    provenance?: LocalWorkspacePublishRecord['provenance'];
  }): Promise<{ ok: true; staging: { status: string; files: Array<{ path: string; receivedBytes: number; complete: boolean }> } } | { ok: false; error: string }>;
  putChunk(input: {
    publishId: string;
    teamId: string;
    channelId: string;
    path: string;
    offset: number;
    content: Buffer;
  }): Promise<{ ok: true; staging: { files: Array<{ path: string; receivedBytes: number; complete: boolean }> } } | { ok: false; error: string }>;
  get(input: {
    publishId: string;
    teamId: string;
    channelId: string;
  }): Promise<
    | {
        ok: true;
        staging: {
          status: string;
          committedRevisionId?: string;
          files: Array<{ path: string; receivedBytes: number; complete: boolean }>;
        };
      }
    | { ok: false; error: string }
  >;
  commit(input: {
    publishId: string;
    teamId: string;
    channelId: string;
  }): Promise<
    | {
        ok: true;
        staging: { status: string; committedRevisionId?: string };
        workspace?: {
          currentRevisionId: string;
          currentRevision?: {
            id: string;
            files: Array<{ path: string; artifactId: string }>;
          };
        };
      }
    | { ok: false; error: string; details?: { conflictingPaths?: string[] } }
  >;
}

export type ResumeWorkspacePublishResult =
  | { readonly kind: 'committed'; readonly committedRevisionId: string }
  | { readonly kind: 'conflict'; readonly conflictingPaths?: readonly string[] }
  | { readonly kind: 'failed'; readonly error: string }
  | { readonly kind: 'not-found' };

/**
 * 恢复一个本地 pending publish：查询 Server → 续传未完成 → commit。
 * 若 Server 已 committed，收敛本地状态且不重复创建 revision。
 */
export async function resumeLocalWorkspacePublish(input: {
  readonly store: WorkspacePublishRecoveryStore;
  readonly client: StagingRemoteClient;
  readonly publishId: string;
  readonly now: number;
  readonly readFile?: (absolutePath: string) => Buffer;
}): Promise<ResumeWorkspacePublishResult> {
  const record = input.store.get(input.publishId);
  if (!record) return { kind: 'not-found' };
  if (record.status === 'committed' && record.committedRevisionId) {
    return { kind: 'committed', committedRevisionId: record.committedRevisionId };
  }

  const remote = await input.client.get({
    publishId: record.publishId,
    teamId: record.teamId,
    channelId: record.channelId,
  });

  if (remote.ok && remote.staging.status === 'committed' && remote.staging.committedRevisionId) {
    input.store.markCommitted(record.publishId, remote.staging.committedRevisionId, input.now);
    return { kind: 'committed', committedRevisionId: remote.staging.committedRevisionId };
  }

  // Server 无会话或已过期 → 重新 begin（同一 identity + 同 plan 幂等）。
  let staging = remote.ok ? remote.staging : null;
  if (!staging) {
    const began = await input.client.begin({
      publishId: record.publishId,
      teamId: record.teamId,
      channelId: record.channelId,
      baselineRevisionId: record.baselineRevisionId,
      files: record.files.map((f) => ({
        path: f.path,
        filename: f.filename,
        mimeType: f.mimeType,
        expectedSizeBytes: f.expectedSizeBytes,
        expectedSha256: f.expectedSha256,
      })),
      ...(record.provenance ? { provenance: record.provenance } : {}),
    });
    if (!began.ok) return { kind: 'failed', error: began.error };
    const refreshed = await input.client.get({
      publishId: record.publishId,
      teamId: record.teamId,
      channelId: record.channelId,
    });
    if (!refreshed.ok) return { kind: 'failed', error: refreshed.error };
    staging = refreshed.staging;
  }

  // #1044：以 Server 进度为权威同步本机 manifest（崩溃窗口可能丢失最后一次回写）。
  for (const remoteFile of staging.files) {
    if (remoteFile.receivedBytes > 0 || remoteFile.complete) {
      input.store.markProgress(
        record.publishId,
        remoteFile.path,
        remoteFile.receivedBytes,
        remoteFile.complete,
        input.now,
      );
    }
  }

  const readFile = input.readFile ?? ((p: string) => readFileSync(p));
  for (const file of record.files) {
    const remoteFile = staging.files.find((f) => f.path === file.path);
    if (remoteFile?.complete) continue;
    const offset = remoteFile?.receivedBytes ?? 0;
    const bytes = readFile(file.absolutePath);
    if (bytes.length !== file.expectedSizeBytes) {
      return { kind: 'failed', error: `Local file size mismatch for ${file.path}` };
    }
    // 从 offset 续传剩余字节。
    const chunk = offset > 0 ? bytes.subarray(offset) : bytes;
    if (chunk.length === 0) continue;
    const put = await input.client.putChunk({
      publishId: record.publishId,
      teamId: record.teamId,
      channelId: record.channelId,
      path: file.path,
      offset,
      content: Buffer.from(chunk),
    });
    if (!put.ok) return { kind: 'failed', error: put.error };
    const updated = put.staging.files.find((f) => f.path === file.path);
    input.store.markProgress(
      record.publishId,
      file.path,
      updated?.receivedBytes ?? offset + chunk.length,
      updated?.complete ?? false,
      input.now,
    );
  }

  const committed = await input.client.commit({
    publishId: record.publishId,
    teamId: record.teamId,
    channelId: record.channelId,
  });
  if (!committed.ok) {
    if (committed.error === 'CONFLICT' || committed.details?.conflictingPaths) {
      // 同 baseline 冲突是终态（重试需新 baseline → 新 publishId）；标记 abandoned 保留诊断。
      input.store.markAbandoned(record.publishId, input.now);
      return { kind: 'conflict', conflictingPaths: committed.details?.conflictingPaths };
    }
    return { kind: 'failed', error: committed.error };
  }
  const revisionId = committed.staging.committedRevisionId
    ?? committed.workspace?.currentRevisionId
    ?? 'unknown';
  input.store.markCommitted(record.publishId, revisionId, input.now);
  return { kind: 'committed', committedRevisionId: revisionId };
}

/** 从本地绝对路径构建计划条目（size + sha256）。 */
export function buildLocalWorkspacePublishFile(input: {
  path: string;
  absolutePath: string;
  mimeType?: string;
}): LocalWorkspacePublishFile {
  const bytes = readFileSync(input.absolutePath);
  const filename = input.path.split('/').pop() || 'file.bin';
  return {
    path: input.path,
    absolutePath: input.absolutePath,
    filename,
    mimeType: input.mimeType ?? 'application/octet-stream',
    expectedSizeBytes: bytes.length,
    expectedSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function sanitizeId(publishId: string): string {
  return publishId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
}
