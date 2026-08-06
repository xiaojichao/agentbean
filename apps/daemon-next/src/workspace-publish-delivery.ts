/**
 * #1003：将本地 collected 输出经 staging begin→put→commit 原子发布到 Project Channel Workspace。
 * 不经「先公开 upload artifact 再 publish」的旧路径。
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { CollectedArtifact } from './artifact-collector.js';
import {
  buildLocalWorkspacePublishFile,
  type LocalWorkspacePublishRecord,
  type StagingRemoteClient,
  type WorkspacePublishRecoveryStore,
} from './workspace-publish-recovery.js';

export type DeliverWorkspaceOutputsResult =
  | {
      readonly kind: 'committed';
      readonly publishId: string;
      readonly committedRevisionId: string;
      readonly artifactIds: string[];
      readonly files: Array<{ path: string; artifactId: string }>;
    }
  | { readonly kind: 'conflict'; readonly publishId: string; readonly conflictingPaths?: readonly string[] }
  | { readonly kind: 'failed'; readonly publishId: string; readonly error: string }
  | { readonly kind: 'skipped'; readonly reason: string };

export interface DeliverWorkspaceOutputsViaStagingInput {
  readonly store: WorkspacePublishRecoveryStore;
  readonly client: StagingRemoteClient;
  readonly teamId: string;
  readonly channelId: string;
  readonly baselineRevisionId?: string;
  readonly collected: readonly CollectedArtifact[];
  readonly publishId?: string;
  readonly now: number;
  readonly provenance?: LocalWorkspacePublishRecord['provenance'];
}

/**
 * 稳定 publish identity：同一 dispatch + channel + baseline 收敛到同一 id，支持重试幂等。
 */
export function buildDispatchWorkspacePublishId(input: {
  dispatchId: string;
  channelId: string;
  /** 首次发布（频道尚无 workspace）时省略；用空串占位保证 publishId 仍确定性派生。 */
  baselineRevisionId?: string;
}): string {
  const digest = createHash('sha256')
    .update(`${input.dispatchId}\0${input.channelId}\0${input.baselineRevisionId ?? ''}`)
    .digest('hex')
    .slice(0, 24);
  return `dispatch-${digest}`;
}

/**
 * 完整交付：写本地 pending → begin → put 全量 → commit。
 * 失败/冲突时 pending 保留供 resume；已 committed 幂等。
 */
export async function deliverWorkspaceOutputsViaStaging(
  input: DeliverWorkspaceOutputsViaStagingInput,
): Promise<DeliverWorkspaceOutputsResult> {
  if (input.collected.length === 0) {
    return { kind: 'skipped', reason: 'EMPTY_COLLECTED' };
  }

  const files = input.collected.map((artifact) =>
    buildLocalWorkspacePublishFile({
      path: normalizeRelativePath(artifact.relativePath || artifact.filename),
      absolutePath: artifact.absolutePath,
      mimeType: mimeTypeForFilename(artifact.filename),
    }));

  const publishId = input.publishId
    ?? `pub-${randomUUID().replace(/-/g, '').slice(0, 20)}`;

  // 已 committed 则直接收敛
  const existing = input.store.get(publishId);
  if (existing?.status === 'committed' && existing.committedRevisionId) {
    return {
      kind: 'committed',
      publishId,
      committedRevisionId: existing.committedRevisionId,
      artifactIds: [],
      files: [],
    };
  }
  // #1044：已判终态冲突的批次不再重复上传（同 baseline 冲突不可恢复）。
  if (existing?.status === 'abandoned') {
    return { kind: 'conflict', publishId };
  }

  const record: LocalWorkspacePublishRecord = {
    publishId,
    teamId: input.teamId,
    channelId: input.channelId,
    baselineRevisionId: input.baselineRevisionId,
    files,
    status: 'pending',
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
  input.store.save(record);

  const began = await input.client.begin({
    publishId,
    teamId: input.teamId,
    channelId: input.channelId,
    baselineRevisionId: input.baselineRevisionId,
    files: files.map((f) => ({
      path: f.path,
      filename: f.filename,
      mimeType: f.mimeType,
      expectedSizeBytes: f.expectedSizeBytes,
      expectedSha256: f.expectedSha256,
    })),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  if (!began.ok) {
    return { kind: 'failed', publishId, error: began.error };
  }

  // 查询进度，严格 offset 续传
  const status = await input.client.get({
    publishId,
    teamId: input.teamId,
    channelId: input.channelId,
  });
  if (status.ok && status.staging.status === 'committed' && status.staging.committedRevisionId) {
    input.store.markCommitted(publishId, status.staging.committedRevisionId, input.now);
    return {
      kind: 'committed',
      publishId,
      committedRevisionId: status.staging.committedRevisionId,
      artifactIds: [],
      files: [],
    };
  }

  const remoteFiles = status.ok ? status.staging.files : began.staging.files;
  // #1044：以 Server 进度为权威同步本机批次 manifest（崩溃窗口可能丢失最后一次回写）。
  for (const remote of remoteFiles) {
    if (remote.receivedBytes > 0 || remote.complete) {
      input.store.markProgress(publishId, remote.path, remote.receivedBytes, remote.complete, input.now);
    }
  }
  for (const file of files) {
    const remote = remoteFiles.find((f) => f.path === file.path);
    if (remote?.complete) continue;
    const offset = remote?.receivedBytes ?? 0;
    const bytes = readFileSync(file.absolutePath);
    const chunk = offset > 0 ? bytes.subarray(offset) : bytes;
    if (chunk.length === 0 && file.expectedSizeBytes > 0) {
      return { kind: 'failed', publishId, error: `EMPTY_CHUNK_FOR ${file.path}` };
    }
    // size=0：仍 put 空 chunk 一次
    const put = await input.client.putChunk({
      publishId,
      teamId: input.teamId,
      channelId: input.channelId,
      path: file.path,
      offset,
      content: Buffer.from(chunk),
    });
    if (!put.ok) {
      return { kind: 'failed', publishId, error: put.error };
    }
    const updated = put.staging.files.find((f) => f.path === file.path);
    input.store.markProgress(
      publishId,
      file.path,
      updated?.receivedBytes ?? offset + chunk.length,
      updated?.complete ?? false,
      input.now,
    );
  }

  const committed = await input.client.commit({
    publishId,
    teamId: input.teamId,
    channelId: input.channelId,
  });
  if (!committed.ok) {
    if (committed.error === 'CONFLICT' || committed.details?.conflictingPaths) {
      // 同 baseline 冲突是终态（重试需新 baseline → 新 publishId）；标记 abandoned 保留诊断。
      input.store.markAbandoned(publishId, input.now);
      return {
        kind: 'conflict',
        publishId,
        ...(committed.details?.conflictingPaths
          ? { conflictingPaths: committed.details.conflictingPaths }
          : {}),
      };
    }
    return { kind: 'failed', publishId, error: committed.error };
  }

  const revisionId = committed.staging.committedRevisionId
    ?? committed.workspace?.currentRevisionId
    ?? committed.workspace?.currentRevision?.id
    ?? 'unknown';
  input.store.markCommitted(publishId, revisionId, input.now);

  const revisionFiles = (committed.workspace?.currentRevision?.files ?? []).map((f) => ({
    path: f.path,
    artifactId: f.artifactId,
  }));

  return {
    kind: 'committed',
    publishId,
    committedRevisionId: revisionId,
    artifactIds: revisionFiles.map((f) => f.artifactId),
    files: revisionFiles,
  };
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.?\//, '');
}

/** #1044 提升到模块级导出：publish output manifest 与 delivery 必须使用同一 mime 推断。 */
export function mimeTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.zip')) return 'application/zip';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  return 'application/octet-stream';
}
