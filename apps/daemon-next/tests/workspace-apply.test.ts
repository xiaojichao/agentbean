import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  materializeProjectChannelWorkspaceRevision,
  previewWorkspaceApply,
  type MaterializeWorkspaceRevisionInput,
} from '../src/workspace-apply.js';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ws-apply-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** build a fetch mock mapping artifactId -> response bytes (or status). */
function fetchByArtifact(map: Record<string, Buffer | number>) {
  return vi.fn(async (url: string) => {
    const artifactId = decodeURIComponent(/\/artifacts\/([^/]+)\/download$/.exec(String(url))?.[1] ?? '');
    const value = map[artifactId];
    if (value === undefined) return new Response(Buffer.from(''), { status: 404 });
    if (typeof value === 'number') return new Response(Buffer.from(''), { status: value });
    return new Response(value, { status: 200 });
  });
}

function revision(files: Array<{ path: string; artifactId: string; bytes: Buffer }>): MaterializeWorkspaceRevisionInput['revision'] {
  return {
    files: files.map((f) => ({
      path: f.path,
      artifactId: f.artifactId,
      filename: f.path.split('/').pop()!,
      sizeBytes: f.bytes.byteLength,
      sha256: sha256(f.bytes),
    })),
  };
}

describe('#968 materializeProjectChannelWorkspaceRevision', () => {
  test('成功：下载并原子写入全部文件到目标目录对应相对路径', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const a = Buffer.from('# README\n');
    const b = Buffer.from('export const x = 1;\n');
    const result = await materializeProjectChannelWorkspaceRevision({
      serverUrl: 'https://server.example',
      token: 'device-token',
      teamId: 'team-1',
      revision: revision([
        { path: 'README.md', artifactId: 'a-1', bytes: a },
        { path: 'src/index.ts', artifactId: 'a-2', bytes: b },
      ]),
      targetDir: target,
      fetch: fetchByArtifact({ 'a-1': a, 'a-2': b }),
    });
    expect(result).toEqual({ ok: true, written: ['README.md', 'src/index.ts'] });
    expect(existsSync(join(target, 'README.md'))).toBe(true);
    expect(existsSync(join(target, 'src/index.ts'))).toBe(true);
    expect(existsSync(join(target, '.agentbean-apply-staging'))).toBe(false);
  });

  test('同名冲突：目标目录已有同名文件 → CONFLICT，不写入（AC#2/#4）', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'README.md'), '# local original\n', 'utf8');
    const a = Buffer.from('# README\n');
    const result = await materializeProjectChannelWorkspaceRevision({
      serverUrl: 'https://server.example', token: 't', teamId: 'team-1',
      revision: revision([{ path: 'README.md', artifactId: 'a-1', bytes: a }]),
      targetDir: target,
      fetch: fetchByArtifact({ 'a-1': a }),
    });
    expect(result).toMatchObject({ ok: false, error: 'CONFLICT', conflicts: [{ path: 'README.md', reason: 'LOCAL_FILE_EXISTS' }] });
    // 原文件未被覆盖；无 staging 残留
    await expect(readFile(join(target, 'README.md'), 'utf8')).resolves.toBe('# local original\n');
    expect(existsSync(join(target, '.agentbean-apply-staging'))).toBe(false);
  });

  test('下载失败（非 2xx）→ DOWNLOAD_FAILED，目标目录无新增（AC#2 零部分写入）', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const a = Buffer.from('A'); const b = Buffer.from('BB');
    const result = await materializeProjectChannelWorkspaceRevision({
      serverUrl: 'https://server.example', token: 't', teamId: 'team-1',
      revision: revision([
        { path: 'a.txt', artifactId: 'a-1', bytes: a },
        { path: 'b.txt', artifactId: 'a-2', bytes: b },
      ]),
      targetDir: target,
      fetch: fetchByArtifact({ 'a-1': 500, 'a-2': b }), // 第一个即失败
    });
    expect(result).toMatchObject({ ok: false, error: 'DOWNLOAD_FAILED' });
    expect(existsSync(join(target, 'a.txt'))).toBe(false);
    expect(existsSync(join(target, 'b.txt'))).toBe(false);
    expect(existsSync(join(target, '.agentbean-apply-staging'))).toBe(false);
  });

  test('size 不匹配 → SIZE_MISMATCH，无残留', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const a = Buffer.from('hello');
    const result = await materializeProjectChannelWorkspaceRevision({
      serverUrl: 'https://server.example', token: 't', teamId: 'team-1',
      revision: { files: [{ path: 'a.txt', artifactId: 'a-1', filename: 'a.txt', sizeBytes: 999, sha256: sha256(a) }] },
      targetDir: target,
      fetch: fetchByArtifact({ 'a-1': a }), // 实际 5 字节 ≠ 声明 999
    });
    expect(result).toMatchObject({ ok: false, error: 'SIZE_MISMATCH' });
    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });

  test('SHA-256 不匹配 → SHA_MISMATCH，无残留', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const a = Buffer.from('hello');
    const result = await materializeProjectChannelWorkspaceRevision({
      serverUrl: 'https://server.example', token: 't', teamId: 'team-1',
      revision: { files: [{
        path: 'a.txt', artifactId: 'a-1', filename: 'a.txt', sizeBytes: a.byteLength,
        sha256: '0'.repeat(64), // 故意错误
      }] },
      targetDir: target,
      fetch: fetchByArtifact({ 'a-1': a }),
    });
    expect(result).toMatchObject({ ok: false, error: 'SHA_MISMATCH' });
    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });

  test('目标目录权限不足 → PERMISSION，无残留（AC#4）', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const a = Buffer.from('hello');
    await mkdir(target, { recursive: true });
    await chmod(target, 0o500); // r-x，不可写
    try {
      const result = await materializeProjectChannelWorkspaceRevision({
        serverUrl: 'https://server.example', token: 't', teamId: 'team-1',
        revision: revision([{ path: 'a.txt', artifactId: 'a-1', bytes: a }]),
        targetDir: target,
        fetch: fetchByArtifact({ 'a-1': a }),
      });
      expect(result).toMatchObject({ ok: false, error: 'PERMISSION' });
      expect(existsSync(join(target, 'a.txt'))).toBe(false);
      expect(existsSync(join(target, '.agentbean-apply-staging'))).toBe(false);
    } finally {
      await chmod(target, 0o700); // 恢复以便 afterEach 清理
    }
  });

  test('取消：仅调 previewWorkspaceApply（只读预览）→ 磁盘无变化（AC#4）', async () => {
    const root = await tempRoot();
    const target = join(root, 'repo');
    const a = Buffer.from('hello');
    const plan = await previewWorkspaceApply({
      revision: revision([{ path: 'a.txt', artifactId: 'a-1', bytes: a }]),
      targetDir: target,
    });
    expect(plan).toMatchObject({ ok: true, plan: { toWrite: [{ path: 'a.txt' }], conflicts: [] } });
    // 预览不写任何文件
    expect(existsSync(join(target, 'a.txt'))).toBe(false);
  });
});
