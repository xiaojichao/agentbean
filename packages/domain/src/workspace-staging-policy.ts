/**
 * #967 Project Channel Workspace 大文件暂存、断网续传与可恢复发布 —— 纯规则。
 *
 * 合同来源：#958 决议 + #960 Implementation Decisions。
 * - 文件先进入 Server-side staging，完整校验且被同一 publish 原子引用后才进入 revision。
 * - 稳定 publish identity 支持续传、幂等结果查询与超时清理。
 * - 单文件 / 单次 publish 大小上限由 Server 配置治理；超限明确拒绝，不截断成功。
 * - 二进制同路径竞争由 #966 evaluateWorkspacePublish 在 commit 时报告冲突。
 *
 * 无 server 依赖、无 IO。
 */

/** 默认单文件上限（与 DEFAULT_ARTIFACT_MAX_BYTES 对齐：250 MiB）。 */
export const DEFAULT_WORKSPACE_STAGING_FILE_MAX_BYTES = 250 * 1024 * 1024;
/** 默认单次 publish 总字节上限（与 DEFAULT_ARTIFACT_RUN_MAX_BYTES 对齐：1 GiB）。 */
export const DEFAULT_WORKSPACE_STAGING_PUBLISH_MAX_BYTES = 1024 * 1024 * 1024;
/** 默认未提交 staging 保留期：24h。 */
export const DEFAULT_WORKSPACE_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;

export type WorkspaceStagingStatus = 'open' | 'committed' | 'failed';

export interface WorkspaceStagingLimits {
  readonly maxFileBytes: number;
  readonly maxPublishBytes: number;
}

export type EvaluateWorkspaceStagingSizeLimitsDecision =
  | { readonly kind: 'ok' }
  | { readonly kind: 'rejected'; readonly reason: 'file-too-large' | 'publish-too-large' | 'invalid-size' };

/**
 * 校验单文件与累计 publish 体量是否在配置上限内。
 * 超限 → rejected（调用方必须拒绝且不截断成功）。
 */
export function evaluateWorkspaceStagingSizeLimits(input: {
  readonly fileBytes: number;
  readonly totalBytesAfter: number;
  readonly limits: WorkspaceStagingLimits;
}): EvaluateWorkspaceStagingSizeLimitsDecision {
  if (!Number.isFinite(input.fileBytes) || input.fileBytes < 0
    || !Number.isFinite(input.totalBytesAfter) || input.totalBytesAfter < 0) {
    return { kind: 'rejected', reason: 'invalid-size' };
  }
  if (input.fileBytes > input.limits.maxFileBytes) {
    return { kind: 'rejected', reason: 'file-too-large' };
  }
  if (input.totalBytesAfter > input.limits.maxPublishBytes) {
    return { kind: 'rejected', reason: 'publish-too-large' };
  }
  return { kind: 'ok' };
}

export type EvaluateWorkspaceStagingUploadDecision =
  | { readonly kind: 'accept'; readonly nextReceivedBytes: number; readonly complete: boolean }
  | { readonly kind: 'already-complete' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-offset'
        | 'overflow'
        | 'size-mismatch'
        | 'empty-chunk'
        | 'already-failed';
    };

/**
 * 判定一次字节续传能否写入。
 * - 已 complete → already-complete（幂等，不重复写）。
 * - offset 必须等于当前 receivedBytes（严格串行续传，禁止空洞）。
 * - 写入后不得超过 expectedSizeBytes。
 */
export function evaluateWorkspaceStagingUpload(input: {
  readonly expectedSizeBytes: number;
  readonly receivedBytes: number;
  readonly complete: boolean;
  readonly offset: number;
  readonly chunkLength: number;
}): EvaluateWorkspaceStagingUploadDecision {
  if (input.complete) return { kind: 'already-complete' };
  if (!Number.isFinite(input.chunkLength) || input.chunkLength <= 0) {
    return { kind: 'rejected', reason: 'empty-chunk' };
  }
  if (!Number.isFinite(input.offset) || input.offset < 0 || input.offset !== input.receivedBytes) {
    return { kind: 'rejected', reason: 'invalid-offset' };
  }
  if (!Number.isFinite(input.expectedSizeBytes) || input.expectedSizeBytes < 0) {
    return { kind: 'rejected', reason: 'size-mismatch' };
  }
  const next = input.receivedBytes + input.chunkLength;
  if (next > input.expectedSizeBytes) {
    return { kind: 'rejected', reason: 'overflow' };
  }
  return {
    kind: 'accept',
    nextReceivedBytes: next,
    complete: next === input.expectedSizeBytes,
  };
}

export interface WorkspaceStagingFileReadiness {
  readonly path: string;
  readonly complete: boolean;
  readonly expectedSizeBytes: number;
  readonly receivedBytes: number;
  readonly sha256Match: boolean;
}

export type EvaluateWorkspaceStagingCommitReadinessDecision =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'empty-files' | 'incomplete' | 'hash-mismatch' | 'size-mismatch';
      readonly incompletePaths?: readonly string[];
      readonly hashMismatchPaths?: readonly string[];
      readonly sizeMismatchPaths?: readonly string[];
    };

/**
 * 判定 staging 是否可原子 commit。
 * 任一路径未 complete / size 不符 / sha 不符 → rejected（不产生部分 revision）。
 */
export function evaluateWorkspaceStagingCommitReadiness(
  files: readonly WorkspaceStagingFileReadiness[],
): EvaluateWorkspaceStagingCommitReadinessDecision {
  if (files.length === 0) return { kind: 'rejected', reason: 'empty-files' };
  const incompletePaths: string[] = [];
  const hashMismatchPaths: string[] = [];
  const sizeMismatchPaths: string[] = [];
  for (const file of files) {
    if (file.receivedBytes !== file.expectedSizeBytes || !file.complete) {
      incompletePaths.push(file.path);
      continue;
    }
    if (!file.sha256Match) hashMismatchPaths.push(file.path);
    if (file.receivedBytes !== file.expectedSizeBytes) sizeMismatchPaths.push(file.path);
  }
  if (incompletePaths.length > 0) {
    return { kind: 'rejected', reason: 'incomplete', incompletePaths: incompletePaths.sort() };
  }
  if (sizeMismatchPaths.length > 0) {
    return { kind: 'rejected', reason: 'size-mismatch', sizeMismatchPaths: sizeMismatchPaths.sort() };
  }
  if (hashMismatchPaths.length > 0) {
    return { kind: 'rejected', reason: 'hash-mismatch', hashMismatchPaths: hashMismatchPaths.sort() };
  }
  return { kind: 'ready' };
}

export type EvaluateWorkspaceStagingExpiryDecision =
  | { readonly kind: 'active' }
  | { readonly kind: 'expired-cleanable' }
  | { readonly kind: 'keep-committed' };

/**
 * 判定 staging 会话是否可安全清理。
 * - committed 结果永久保留查询（keep-committed），不按保留期删。
 * - open/failed 超过 retention → expired-cleanable。
 */
export function evaluateWorkspaceStagingExpiry(input: {
  readonly status: WorkspaceStagingStatus;
  readonly createdAt: number;
  readonly now: number;
  readonly retentionMs: number;
}): EvaluateWorkspaceStagingExpiryDecision {
  if (input.status === 'committed') return { kind: 'keep-committed' };
  if (!Number.isFinite(input.retentionMs) || input.retentionMs < 0) {
    return { kind: 'expired-cleanable' };
  }
  if (input.now - input.createdAt >= input.retentionMs) {
    return { kind: 'expired-cleanable' };
  }
  return { kind: 'active' };
}

/** 校验稳定 publish identity（非空、长度与字符集收敛，避免路径注入）。 */
export function normalizeWorkspacePublishId(value: string): string | null {
  const id = value.trim();
  if (!id || id.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(id)) return null;
  return id;
}

/**
 * begin 幂等：同一 publishId 再次 begin 时，关键字段必须一致，否则 conflict。
 * 关键字段：team/channel/baseline + 计划文件路径集合与每个路径的 expected size/sha。
 */
export function isCompatibleWorkspaceStagingBegin(input: {
  readonly existing: {
    readonly teamId: string;
    readonly channelId: string;
    readonly baselineRevisionId: string;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly expectedSizeBytes: number;
      readonly expectedSha256: string;
    }>;
  };
  readonly requested: {
    readonly teamId: string;
    readonly channelId: string;
    readonly baselineRevisionId: string;
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly expectedSizeBytes: number;
      readonly expectedSha256: string;
    }>;
  };
}): boolean {
  const a = input.existing;
  const b = input.requested;
  if (a.teamId !== b.teamId || a.channelId !== b.channelId || a.baselineRevisionId !== b.baselineRevisionId) {
    return false;
  }
  if (a.files.length !== b.files.length) return false;
  const byPath = new Map(a.files.map((f) => [f.path, f]));
  for (const file of b.files) {
    const existing = byPath.get(file.path);
    if (!existing) return false;
    if (existing.expectedSizeBytes !== file.expectedSizeBytes) return false;
    if (existing.expectedSha256.toLowerCase() !== file.expectedSha256.toLowerCase()) return false;
  }
  return true;
}
