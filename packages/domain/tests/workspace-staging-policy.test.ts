import { describe, expect, test } from 'vitest';

import {
  DEFAULT_WORKSPACE_STAGING_FILE_MAX_BYTES,
  DEFAULT_WORKSPACE_STAGING_PUBLISH_MAX_BYTES,
  DEFAULT_WORKSPACE_STAGING_RETENTION_MS,
  evaluateWorkspaceStagingCommitReadiness,
  evaluateWorkspaceStagingExpiry,
  evaluateWorkspaceStagingSizeLimits,
  evaluateWorkspaceStagingUpload,
  isCompatibleWorkspaceStagingBegin,
  normalizeWorkspacePublishId,
} from '../src/index.js';

const limits = {
  maxFileBytes: DEFAULT_WORKSPACE_STAGING_FILE_MAX_BYTES,
  maxPublishBytes: DEFAULT_WORKSPACE_STAGING_PUBLISH_MAX_BYTES,
};

describe('workspace-staging-policy (#967 暂存 / 续传 / 上限 / 清理)', () => {
  describe('evaluateWorkspaceStagingSizeLimits', () => {
    test('合法体量 → ok', () => {
      expect(evaluateWorkspaceStagingSizeLimits({
        fileBytes: 100,
        totalBytesAfter: 100,
        limits,
      })).toEqual({ kind: 'ok' });
    });

    test('单文件超限 → file-too-large，不截断成功', () => {
      expect(evaluateWorkspaceStagingSizeLimits({
        fileBytes: limits.maxFileBytes + 1,
        totalBytesAfter: limits.maxFileBytes + 1,
        limits,
      })).toEqual({ kind: 'rejected', reason: 'file-too-large' });
    });

    test('累计 publish 超限 → publish-too-large', () => {
      expect(evaluateWorkspaceStagingSizeLimits({
        fileBytes: 10,
        totalBytesAfter: limits.maxPublishBytes + 1,
        limits,
      })).toEqual({ kind: 'rejected', reason: 'publish-too-large' });
    });

    test('非法负数 → invalid-size', () => {
      expect(evaluateWorkspaceStagingSizeLimits({
        fileBytes: -1,
        totalBytesAfter: 0,
        limits,
      })).toEqual({ kind: 'rejected', reason: 'invalid-size' });
    });
  });

  describe('evaluateWorkspaceStagingUpload（断网续传）', () => {
    test('从 offset=0 写入完整文件 → accept complete', () => {
      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 10,
        receivedBytes: 0,
        complete: false,
        offset: 0,
        chunkLength: 10,
      })).toEqual({ kind: 'accept', nextReceivedBytes: 10, complete: true });
    });

    test('严格串行续传：offset 必须等于 receivedBytes', () => {
      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 10,
        receivedBytes: 4,
        complete: false,
        offset: 3,
        chunkLength: 2,
      })).toEqual({ kind: 'rejected', reason: 'invalid-offset' });

      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 10,
        receivedBytes: 4,
        complete: false,
        offset: 4,
        chunkLength: 3,
      })).toEqual({ kind: 'accept', nextReceivedBytes: 7, complete: false });
    });

    test('已 complete 再上传 → already-complete（幂等）', () => {
      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 10,
        receivedBytes: 10,
        complete: true,
        offset: 0,
        chunkLength: 10,
      })).toEqual({ kind: 'already-complete' });
    });

    test('写入超过 expectedSize → overflow，不截断成功', () => {
      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 10,
        receivedBytes: 8,
        complete: false,
        offset: 8,
        chunkLength: 4,
      })).toEqual({ kind: 'rejected', reason: 'overflow' });
    });

    test('空 chunk → empty-chunk', () => {
      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 10,
        receivedBytes: 0,
        complete: false,
        offset: 0,
        chunkLength: 0,
      })).toEqual({ kind: 'rejected', reason: 'empty-chunk' });
    });

    test('空文件 size=0 允许空 chunk 一次 complete', () => {
      expect(evaluateWorkspaceStagingUpload({
        expectedSizeBytes: 0,
        receivedBytes: 0,
        complete: false,
        offset: 0,
        chunkLength: 0,
      })).toEqual({ kind: 'accept', nextReceivedBytes: 0, complete: true });
    });
  });

  describe('evaluateWorkspaceStagingCommitReadiness', () => {
    test('全部 complete + sha 匹配 → ready', () => {
      expect(evaluateWorkspaceStagingCommitReadiness([
        { path: 'a.bin', complete: true, expectedSizeBytes: 10, receivedBytes: 10, sha256Match: true },
        { path: 'b.png', complete: true, expectedSizeBytes: 20, receivedBytes: 20, sha256Match: true },
      ])).toEqual({ kind: 'ready' });
    });

    test('空清单 → empty-files', () => {
      expect(evaluateWorkspaceStagingCommitReadiness([]))
        .toEqual({ kind: 'rejected', reason: 'empty-files' });
    });

    test('未传完 → incomplete（列出路径，不创建 revision）', () => {
      expect(evaluateWorkspaceStagingCommitReadiness([
        { path: 'a.bin', complete: true, expectedSizeBytes: 10, receivedBytes: 10, sha256Match: true },
        { path: 'b.png', complete: false, expectedSizeBytes: 20, receivedBytes: 5, sha256Match: false },
      ])).toEqual({
        kind: 'rejected',
        reason: 'incomplete',
        incompletePaths: ['b.png'],
      });
    });

    test('sha 不匹配 → hash-mismatch', () => {
      expect(evaluateWorkspaceStagingCommitReadiness([
        { path: 'a.bin', complete: true, expectedSizeBytes: 10, receivedBytes: 10, sha256Match: false },
      ])).toEqual({
        kind: 'rejected',
        reason: 'hash-mismatch',
        hashMismatchPaths: ['a.bin'],
      });
    });
  });

  describe('evaluateWorkspaceStagingExpiry', () => {
    test('committed 永久可查询，不按保留期清理', () => {
      expect(evaluateWorkspaceStagingExpiry({
        status: 'committed',
        createdAt: 0,
        now: DEFAULT_WORKSPACE_STAGING_RETENTION_MS * 10,
        retentionMs: DEFAULT_WORKSPACE_STAGING_RETENTION_MS,
      })).toEqual({ kind: 'keep-committed' });
    });

    test('open 未过期 → active', () => {
      expect(evaluateWorkspaceStagingExpiry({
        status: 'open',
        createdAt: 1000,
        now: 1000 + DEFAULT_WORKSPACE_STAGING_RETENTION_MS - 1,
        retentionMs: DEFAULT_WORKSPACE_STAGING_RETENTION_MS,
      })).toEqual({ kind: 'active' });
    });

    test('open 过期 → expired-cleanable', () => {
      expect(evaluateWorkspaceStagingExpiry({
        status: 'open',
        createdAt: 1000,
        now: 1000 + DEFAULT_WORKSPACE_STAGING_RETENTION_MS,
        retentionMs: DEFAULT_WORKSPACE_STAGING_RETENTION_MS,
      })).toEqual({ kind: 'expired-cleanable' });
    });
  });

  describe('normalizeWorkspacePublishId / isCompatibleWorkspaceStagingBegin', () => {
    test('合法 publishId 收敛；非法拒绝', () => {
      expect(normalizeWorkspacePublishId('  pub-1:abc_2  ')).toBe('pub-1:abc_2');
      expect(normalizeWorkspacePublishId('')).toBeNull();
      expect(normalizeWorkspacePublishId('../evil')).toBeNull();
      expect(normalizeWorkspacePublishId('has space')).toBeNull();
    });

    test('begin 幂等：同 plan 兼容；不同 baseline/size/sha 不兼容', () => {
      const base = {
        teamId: 't1',
        channelId: 'c1',
        baselineRevisionId: 'rev-1',
        files: [{ path: 'a.bin', expectedSizeBytes: 10, expectedSha256: 'aa' }],
      };
      expect(isCompatibleWorkspaceStagingBegin({ existing: base, requested: base })).toBe(true);
      expect(isCompatibleWorkspaceStagingBegin({
        existing: base,
        requested: { ...base, baselineRevisionId: 'rev-2' },
      })).toBe(false);
      expect(isCompatibleWorkspaceStagingBegin({
        existing: base,
        requested: {
          ...base,
          files: [{ path: 'a.bin', expectedSizeBytes: 11, expectedSha256: 'aa' }],
        },
      })).toBe(false);
    });
  });
});
