/**
 * #1005 Workspace publish staging 字节存储。
 * metadata 在 SQLite；内容在 dataDir 磁盘路径，避免大文件 BLOB 膨胀 team DB。
 */

import { createHash } from 'node:crypto';
import {
  closeSync,
  createReadStream,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface WorkspaceStagingContentStore {
  /** 严格串行：offset 必须等于当前文件长度；offset=0 时截断重建。 */
  appendChunk(input: {
    teamId: string;
    publishId: string;
    path: string;
    offset: number;
    chunk: Buffer;
  }): Promise<{ storagePath: string; sizeBytes: number }>;
  readContent(input: {
    teamId: string;
    publishId: string;
    path: string;
    storagePath?: string;
  }): Promise<Buffer | null>;
  /** 校验失败时回滚磁盘到已提交 metadata 长度。 */
  truncateTo(input: {
    teamId: string;
    publishId: string;
    path: string;
    sizeBytes: number;
  }): Promise<void>;
  /** 删除整个 publish 的暂存目录。 */
  deletePublish(input: { teamId: string; publishId: string }): Promise<void>;
}

/** 相对 dataDir 的路径：workspace-staging/{teamId}/{publishId}/{encodedPath} */
export function workspaceStagingRelativePath(
  teamId: string,
  publishId: string,
  workspacePath: string,
): string {
  const encoded = Buffer.from(workspacePath, 'utf8').toString('base64url');
  return join('workspace-staging', teamId, publishId, encoded);
}

export function createFileWorkspaceStagingContentStore(
  dataDir: string,
): WorkspaceStagingContentStore {
  const root = dataDir;

  function absolutePath(teamId: string, publishId: string, workspacePath: string): string {
    return join(root, workspaceStagingRelativePath(teamId, publishId, workspacePath));
  }

  return {
    async appendChunk(input) {
      const rel = workspaceStagingRelativePath(input.teamId, input.publishId, input.path);
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      if (input.offset === 0) {
        // 截断重建
        const fd = openSync(abs, 'w');
        try {
          if (input.chunk.length > 0) writeSync(fd, input.chunk);
        } finally {
          closeSync(fd);
        }
        return { storagePath: rel, sizeBytes: input.chunk.length };
      }
      const current = existsSync(abs) ? statSync(abs).size : 0;
      if (current !== input.offset) {
        throw new Error(`STAGING_OFFSET_MISMATCH expected=${input.offset} actual=${current}`);
      }
      const fd = openSync(abs, 'a');
      try {
        if (input.chunk.length > 0) writeSync(fd, input.chunk);
      } finally {
        closeSync(fd);
      }
      return { storagePath: rel, sizeBytes: current + input.chunk.length };
    },

    async readContent(input) {
      const abs = input.storagePath
        ? join(root, input.storagePath)
        : absolutePath(input.teamId, input.publishId, input.path);
      if (!existsSync(abs)) return null;
      return readFileSync(abs);
    },

    async truncateTo(input) {
      const abs = absolutePath(input.teamId, input.publishId, input.path);
      if (!existsSync(abs)) {
        if (input.sizeBytes === 0) return;
        return;
      }
      if (input.sizeBytes === 0) {
        rmSync(abs, { force: true });
        return;
      }
      const fd = openSync(abs, 'r+');
      try {
        ftruncateSync(fd, input.sizeBytes);
      } finally {
        closeSync(fd);
      }
    },

    async deletePublish(input) {
      const dir = join(root, 'workspace-staging', input.teamId, input.publishId);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 流式计算磁盘文件 sha256（commit 大文件时避免整包进内存两次）。 */
export async function sha256File(absolutePath: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(absolutePath), async function* (source) {
    for await (const chunk of source) {
      hash.update(chunk as Buffer);
      yield chunk;
    }
  });
  return hash.digest('hex');
}
