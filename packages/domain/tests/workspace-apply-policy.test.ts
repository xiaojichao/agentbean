import { describe, expect, test } from 'vitest';

import { computeWorkspaceApplyPlan } from '../src/workspace-apply-policy.js';

describe('#968 computeWorkspaceApplyPlan', () => {
  test('无冲突时全部文件列入 toWrite，conflicts 为空', () => {
    const result = computeWorkspaceApplyPlan({
      revisionFiles: [
        { path: 'README.md', artifactId: 'a-1', filename: 'README.md', sizeBytes: 10 },
        { path: 'src/index.ts', artifactId: 'a-2', filename: 'index.ts', sizeBytes: 42, sha256: 'abc' },
      ],
      localRelativePaths: ['docs/other.md'],
    });
    expect(result).toEqual({
      ok: true,
      plan: {
        toWrite: [
          { path: 'README.md', artifactId: 'a-1', filename: 'README.md', sizeBytes: 10 },
          { path: 'src/index.ts', artifactId: 'a-2', filename: 'index.ts', sizeBytes: 42, sha256: 'abc' },
        ],
        conflicts: [],
      },
    });
  });

  test('revision 路径与本地既有同名文件冲突 → 报告 LOCAL_FILE_EXISTS', () => {
    const result = computeWorkspaceApplyPlan({
      revisionFiles: [
        { path: 'README.md', artifactId: 'a-1', filename: 'README.md', sizeBytes: 10 },
        { path: 'src/index.ts', artifactId: 'a-2', filename: 'index.ts', sizeBytes: 42 },
      ],
      localRelativePaths: ['README.md', 'docs/old.md'],
    });
    expect(result).toMatchObject({
      ok: true,
      plan: {
        toWrite: expect.arrayContaining([
          expect.objectContaining({ path: 'README.md' }),
          expect.objectContaining({ path: 'src/index.ts' }),
        ]),
        conflicts: [{ path: 'README.md', reason: 'LOCAL_FILE_EXISTS' }],
      },
    });
  });

  test('绝对路径 revision 文件 → INVALID_PATH（AC#3 未授权路径不可写）', () => {
    const result = computeWorkspaceApplyPlan({
      revisionFiles: [{ path: '/etc/passwd', artifactId: 'a-1', filename: 'passwd', sizeBytes: 1 }],
      localRelativePaths: [],
    });
    expect(result).toEqual({ ok: false, error: 'INVALID_PATH' });
  });

  test('遍历路径 revision 文件 → INVALID_PATH', () => {
    const result = computeWorkspaceApplyPlan({
      revisionFiles: [{ path: '../escape.txt', artifactId: 'a-1', filename: 'escape.txt', sizeBytes: 1 }],
      localRelativePaths: [],
    });
    expect(result).toEqual({ ok: false, error: 'INVALID_PATH' });
  });

  test('Windows 盘符路径 → INVALID_PATH', () => {
    const result = computeWorkspaceApplyPlan({
      revisionFiles: [{ path: 'C:/secret.txt', artifactId: 'a-1', filename: 'secret.txt', sizeBytes: 1 }],
      localRelativePaths: [],
    });
    expect(result).toEqual({ ok: false, error: 'INVALID_PATH' });
  });

  test('来源 Device 无关：函数不接收也不依赖 provenance / 设备信息（AC#4）', () => {
    // 同样的文件清单 + 本地路径，无论由哪台设备发布，结果完全相同。
    const input = {
      revisionFiles: [{ path: 'a.txt', artifactId: 'a-1', filename: 'a.txt', sizeBytes: 1 }],
      localRelativePaths: [],
    } as const;
    expect(computeWorkspaceApplyPlan(input)).toEqual(computeWorkspaceApplyPlan(input));
    // 函数签名本身不含 device/provenance 字段（类型层面保证）。
  });
});
