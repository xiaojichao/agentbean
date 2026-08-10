import { describe, expect, test, vi } from 'vitest';

import { loadAllPromotableArtifacts } from '../lib/promotable-artifacts';

function file(id: string, filename: string, logicalPath: string) {
  return {
    artifact: { id, filename },
    source: { senderKind: 'agent' as const, senderId: 'agent-1', messageCreatedAt: 1 },
    logicalPath,
  };
}

describe('loadAllPromotableArtifacts', () => {
  test('独立遍历根目录、子目录和全部分页，不受当前文件视图状态限制', async () => {
    const listPage = vi.fn(async (path: string, cursor?: string) => {
      if (path === '' && cursor === undefined) {
        return {
          ok: true,
          files: [file('root-1', 'root.md', 'root.md')],
          directories: [{ path: 'outputs', name: 'outputs', fileCount: 2, updatedAt: 3 }],
          nextCursor: 'root-next',
        };
      }
      if (path === '' && cursor === 'root-next') {
        return {
          ok: true,
          files: [file('root-2', 'notes.md', 'notes.md')],
          directories: [{ path: 'outputs', name: 'outputs', fileCount: 2, updatedAt: 3 }],
        };
      }
      if (path === 'outputs') {
        return {
          ok: true,
          files: [file('nested-1', 'script.md', 'outputs/script.md')],
          directories: [{ path: 'outputs/images', name: 'images', fileCount: 1, updatedAt: 2 }],
        };
      }
      return {
        ok: true,
        files: [file('nested-2', 'frame.png', 'outputs/images/frame.png')],
        directories: [],
      };
    });

    await expect(loadAllPromotableArtifacts(listPage)).resolves.toEqual([
      { id: 'root-2', filename: 'notes.md', logicalPath: 'notes.md' },
      { id: 'nested-2', filename: 'frame.png', logicalPath: 'outputs/images/frame.png' },
      { id: 'nested-1', filename: 'script.md', logicalPath: 'outputs/script.md' },
      { id: 'root-1', filename: 'root.md', logicalPath: 'root.md' },
    ]);
    expect(listPage.mock.calls).toEqual([
      ['', undefined],
      ['', 'root-next'],
      ['outputs', undefined],
      ['outputs/images', undefined],
    ]);
  });

  test('任一目录加载失败时不返回不完整候选集', async () => {
    await expect(loadAllPromotableArtifacts(async () => ({ ok: false, error: '无权读取' })))
      .rejects.toThrow('无权读取');
  });
});
