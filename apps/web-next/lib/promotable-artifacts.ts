import type { ChannelFileDirectoryDto, ChannelFileEntryDto } from '@agentbean/contracts';

export interface PromotableArtifactCandidate {
  id: string;
  filename: string;
  logicalPath?: string;
}

interface ChannelFilePage {
  ok: boolean;
  files?: readonly ChannelFileEntryDto[];
  directories?: readonly ChannelFileDirectoryDto[];
  nextCursor?: string;
  error?: string;
}

type ListChannelFilePage = (path: string, cursor?: string) => Promise<ChannelFilePage>;

/**
 * 为“提升为逻辑产物”独立遍历频道文件树。
 *
 * 不能复用普通文件视图的当前目录、搜索条件或分页状态，否则深层目录和后续页
 * 会从提升下拉框中消失。这里按 Server 返回的目录逐层遍历，并消费每个目录的
 * 全部分页；最终仍只提交稳定 artifactId。
 */
export async function loadAllPromotableArtifacts(
  listPage: ListChannelFilePage,
): Promise<PromotableArtifactCandidate[]> {
  const pendingPaths = [''];
  const seenPaths = new Set<string>();
  const artifacts = new Map<string, PromotableArtifactCandidate>();

  while (pendingPaths.length > 0) {
    const path = pendingPaths.shift()!;
    if (seenPaths.has(path)) continue;
    seenPaths.add(path);

    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const page = await listPage(path, cursor);
      if (!page.ok || !page.files) {
        throw new Error(page.error ?? '加载可提升文件失败');
      }
      for (const entry of page.files) {
        artifacts.set(entry.artifact.id, {
          id: entry.artifact.id,
          filename: entry.artifact.filename,
          ...(entry.logicalPath ? { logicalPath: entry.logicalPath } : {}),
        });
      }
      for (const directory of page.directories ?? []) {
        if (!seenPaths.has(directory.path)) pendingPaths.push(directory.path);
      }

      const nextCursor = page.nextCursor;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error('频道文件分页游标重复');
      }
      if (nextCursor) seenCursors.add(nextCursor);
      cursor = nextCursor;
    } while (cursor);
  }

  return [...artifacts.values()].sort((left, right) =>
    (left.logicalPath ?? left.filename).localeCompare(right.logicalPath ?? right.filename, 'zh-CN'));
}
