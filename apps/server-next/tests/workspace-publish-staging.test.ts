import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';
import {
  createFileWorkspaceStagingContentStore,
  workspaceStagingRelativePath,
} from '../src/application/workspace-staging-content-store.js';

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createIds(ids: string[]) {
  let i = 0;
  return () => {
    const id = ids[i];
    i += 1;
    if (!id) throw new Error(`ran out of ids at ${i}`);
    return id;
  };
}

async function seedWorkspace() {
  const repositories = createInMemoryRepositories();
  let now = 100;
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => now },
    ids: {
      nextId: createIds([
        'user-1', 'team-1', 'all-1', 'channel-1',
        'workspace-1', 'revision-1',
        // staging commits consume artifact + revision ids；并发 race 额外多占
        'art-1', 'rev-2', 'art-2', 'rev-3', 'art-3', 'rev-4',
        'art-4', 'rev-5', 'art-5', 'rev-6', 'art-6', 'rev-7',
        'art-7', 'rev-8', 'art-8', 'rev-9',
      ]),
    },
  });
  await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  const channel = await app.createChannel({
    userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
  });
  if (!channel.ok) throw new Error(channel.error);
  const cid = channel.channel.id;
  await repositories.artifacts.create({
    id: 'seed-art', teamId: 'team-1', channelId: cid, uploaderId: 'user-1',
    filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
  });
  const created = await app.createProjectChannelWorkspace({
    userId: 'user-1', teamId: 'team-1', channelId: cid,
    files: [{ path: 'base.txt', artifactId: 'seed-art' }],
  });
  if (!created.ok) throw new Error(created.error);
  return {
    repositories,
    app,
    cid,
    baselineRevisionId: created.workspace.currentRevisionId,
    tick: (ms: number) => { now += ms; },
    setNow: (value: number) => { now = value; },
  };
}

describe('Workspace publish staging (#967)', () => {
  test('上传中的内容不出现在 revision / 频道文件索引 / 可下载 artifact 列表', async () => {
    const { app, cid, baselineRevisionId, repositories } = await seedWorkspace();
    const body = Buffer.from('binary-payload-v1');
    const begin = await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-invisible-1',
      baselineRevisionId,
      files: [{
        path: 'media/clip.bin',
        filename: 'clip.bin',
        mimeType: 'application/octet-stream',
        expectedSizeBytes: body.length,
        expectedSha256: sha256(body),
      }],
    });
    expect(begin.ok).toBe(true);
    if (!begin.ok) throw new Error(begin.error);

    const put = await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-invisible-1',
      path: 'media/clip.bin',
      offset: 0,
      content: body,
    });
    expect(put).toMatchObject({ ok: true, staging: { status: 'open', files: [{ complete: true }] } });

    // revision 仍是基线，不含暂存路径
    const workspace = await app.getProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
    });
    expect(workspace).toMatchObject({ ok: true });
    if (!workspace.ok) throw new Error(workspace.error);
    expect(workspace.workspace.currentRevision.files.map((f) => f.path)).toEqual(['base.txt']);
    expect(workspace.workspace.currentRevision.files.some((f) => f.path === 'media/clip.bin')).toBe(false);

    // 频道文件索引：无 message/run 的 staging 字节不会以 artifact 出现
    const beforeArtifacts = await repositories.artifacts.listByChannel({ teamId: 'team-1', channelId: cid });
    expect(beforeArtifacts.some((a) => a.filename === 'clip.bin')).toBe(false);

    const files = await app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
    });
    // file browser 可能因 rollout 关闭而 NOT_FOUND；若开启，也不应含 clip.bin
    if (files.ok) {
      const names = files.files.map((e) => e.logicalPath);
      expect(names).not.toContain('media/clip.bin');
      expect(names).not.toContain('clip.bin');
    }
  });

  test('同一 publishId 可续传与查询；重复 commit 不重复创建 revision', async () => {
    const { app, cid, baselineRevisionId } = await seedWorkspace();
    const part1 = Buffer.from('hello ');
    const part2 = Buffer.from('world!');
    const full = Buffer.concat([part1, part2]);
    const begin = await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-1',
      baselineRevisionId,
      files: [{
        path: 'docs/out.txt',
        expectedSizeBytes: full.length,
        expectedSha256: sha256(full),
        mimeType: 'text/plain',
        filename: 'out.txt',
      }],
    });
    expect(begin.ok).toBe(true);

    // 再次 begin 同 plan → 幂等
    const begin2 = await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-1',
      baselineRevisionId,
      files: [{
        path: 'docs/out.txt',
        expectedSizeBytes: full.length,
        expectedSha256: sha256(full),
        mimeType: 'text/plain',
        filename: 'out.txt',
      }],
    });
    expect(begin2).toMatchObject({ ok: true, staging: { publishId: 'pub-resume-1', status: 'open' } });

    const half = await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-1', path: 'docs/out.txt', offset: 0, content: part1,
    });
    expect(half).toMatchObject({
      ok: true,
      staging: { files: [{ receivedBytes: part1.length, complete: false }] },
    });

    // 错误 offset 拒绝
    await expect(app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-1', path: 'docs/out.txt', offset: 0, content: part2,
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    const rest = await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-1', path: 'docs/out.txt', offset: part1.length, content: part2,
    });
    expect(rest).toMatchObject({ ok: true, staging: { files: [{ complete: true }] } });

    const got = await app.getWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-resume-1',
    });
    expect(got).toMatchObject({ ok: true, staging: { status: 'open', files: [{ complete: true }] } });

    const commit1 = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-resume-1',
    });
    expect(commit1.ok).toBe(true);
    if (!commit1.ok) throw new Error(commit1.error);
    expect(commit1.workspace?.currentRevision.revision).toBe(2);
    expect(commit1.workspace?.currentRevision.files.map((f) => f.path).sort()).toEqual(['docs/out.txt']);
    const revId = commit1.workspace!.currentRevisionId;

    const commit2 = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-resume-1',
    });
    expect(commit2.ok).toBe(true);
    if (!commit2.ok) throw new Error(commit2.error);
    expect(commit2.staging.committedRevisionId).toBe(revId);
    expect(commit2.workspace?.currentRevisionId).toBe(revId);
    expect(commit2.workspace?.currentRevision.revision).toBe(2);
  });

  test('超限明确拒绝且不截断成功；同路径竞争返回 conflict', async () => {
    const { app, cid, baselineRevisionId, repositories } = await seedWorkspace();

    // 单文件超限
    const tooLarge = await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-limit-1',
      baselineRevisionId,
      files: [{
        path: 'huge.bin',
        expectedSizeBytes: 1000,
        expectedSha256: 'a'.repeat(64),
      }],
      limits: { maxFileBytes: 100, maxPublishBytes: 10_000 },
    });
    expect(tooLarge).toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: { reason: 'file-too-large' },
    });

    // 为冲突场景：先用另一 publish 改掉同路径
    const v1 = Buffer.from('version-one');
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-win',
      baselineRevisionId,
      files: [{
        path: 'shared.bin',
        expectedSizeBytes: v1.length,
        expectedSha256: sha256(v1),
        filename: 'shared.bin',
      }],
    });
    await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-win', path: 'shared.bin', offset: 0, content: v1,
    });
    const win = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-win',
    });
    expect(win.ok).toBe(true);
    if (!win.ok) throw new Error(win.error);
    const newBaseline = win.workspace!.currentRevisionId;

    // 落后基线的 publish：同路径竞争 → conflict，不自动合并
    const v2 = Buffer.from('version-two');
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-lose',
      baselineRevisionId, // 故意用旧基线
      files: [{
        path: 'shared.bin',
        expectedSizeBytes: v2.length,
        expectedSha256: sha256(v2),
        filename: 'shared.bin',
      }],
    });
    await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-lose', path: 'shared.bin', offset: 0, content: v2,
    });
    const conflict = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-lose',
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: 'CONFLICT',
      details: {
        currentRevisionId: newBaseline,
        conflictingPaths: expect.arrayContaining(['shared.bin']),
      },
    });

    // conflict 后 revision 仍是 winner 的版本
    const current = await app.getProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
    });
    expect(current).toMatchObject({
      ok: true,
      workspace: { currentRevisionId: newBaseline, currentRevision: { revision: 2 } },
    });
    void repositories;
  });

  test('publish 成功但 staging 未标 committed 时，重试 commit 半态收敛', async () => {
    const { app, cid, baselineRevisionId, repositories } = await seedWorkspace();
    const body = Buffer.from('half-state-payload');
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-half',
      baselineRevisionId,
      files: [{
        path: 'half.txt',
        expectedSizeBytes: body.length,
        expectedSha256: sha256(body),
        filename: 'half.txt',
        mimeType: 'text/plain',
      }],
    });
    await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-half', path: 'half.txt', offset: 0, content: body,
    });
    // 完整 commit 一次
    const first = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-half',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error);
    const revId = first.workspace!.currentRevisionId;

    // 模拟崩溃窗口：强行把 staging 打回 open、清掉 committedRevisionId
    const staging = await repositories.workspacePublishStagings.getByPublishId({
      teamId: 'team-1', publishId: 'pub-half',
    });
    expect(staging).toBeTruthy();
    await repositories.workspacePublishStagings.update({
      ...staging!,
      status: 'open',
      committedRevisionId: undefined,
      committedWorkspaceId: undefined,
      files: staging!.files.map((f) => ({ ...f, complete: true, content: body })),
      updatedAt: staging!.updatedAt + 1,
    });

    // 重试 commit：应收敛到同一 revision，不新建
    const recovered = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-half',
    });
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) throw new Error(recovered.error);
    expect(recovered.staging.status).toBe('committed');
    expect(recovered.staging.committedRevisionId).toBe(revId);
    expect(recovered.workspace?.currentRevisionId).toBe(revId);
    expect(recovered.workspace?.currentRevision.revision).toBe(2);

    const got = await app.getWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-half',
    });
    expect(got).toMatchObject({
      ok: true,
      staging: { status: 'committed', committedRevisionId: revId },
    });
  });

  test('并发 commit 同基线：败者 CAS 冲突后清理孤儿 artifact', async () => {
    const { app, cid, baselineRevisionId, repositories } = await seedWorkspace();
    const a = Buffer.from('alpha-payload');
    const b = Buffer.from('bravo-payload');
    for (const [publishId, body, path] of [
      ['pub-race-a', a, 'a.bin'],
      ['pub-race-b', b, 'b.bin'],
    ] as const) {
      await app.beginWorkspacePublishStaging({
        userId: 'user-1', teamId: 'team-1', channelId: cid,
        publishId,
        baselineRevisionId,
        files: [{
          path,
          expectedSizeBytes: body.length,
          expectedSha256: sha256(body),
          filename: path,
        }],
      });
      await app.putWorkspacePublishStagingFile({
        userId: 'user-1', teamId: 'team-1', channelId: cid,
        publishId, path, offset: 0, content: body,
      });
    }
    const before = await repositories.artifacts.listByChannel({ teamId: 'team-1', channelId: cid });
    const [r1, r2] = await Promise.all([
      app.commitWorkspacePublishStaging({
        userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-race-a',
      }),
      app.commitWorkspacePublishStaging({
        userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-race-b',
      }),
    ]);
    const outcomes = [r1, r2];
    const wins = outcomes.filter((o) => o.ok);
    const losses = outcomes.filter((o) => !o.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ ok: false, error: 'CONFLICT' });

    const after = await repositories.artifacts.listByChannel({ teamId: 'team-1', channelId: cid });
    // seed artifact + 胜者 1 个文件；败者物化的 intermediate 必须被删掉
    expect(after.length).toBe(before.length + 1);
    if (!wins[0]!.ok) throw new Error('expected win');
    const winPaths = new Set(wins[0]!.workspace!.currentRevision.files.map((f) => f.path));
    // 仅胜者路径的 artifact 保留（相对 path 的 revision 引用）
    const revisionArtifactIds = new Set(wins[0]!.workspace!.currentRevision.files.map((f) => f.artifactId));
    const extras = after.filter((art) => art.id !== 'seed-art' && !revisionArtifactIds.has(art.id));
    expect(extras).toEqual([]);
    expect(winPaths.size).toBe(1);
  });

  test('空文件 size=0 可 complete 并提交', async () => {
    const { app, cid, baselineRevisionId } = await seedWorkspace();
    const emptySha = sha256(Buffer.alloc(0));
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-empty',
      baselineRevisionId,
      files: [{
        path: 'empty.bin',
        expectedSizeBytes: 0,
        expectedSha256: emptySha,
        filename: 'empty.bin',
      }],
    });
    const put = await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-empty', path: 'empty.bin', offset: 0, content: Buffer.alloc(0),
    });
    expect(put).toMatchObject({ ok: true, staging: { files: [{ complete: true, receivedBytes: 0 }] } });
    const committed = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-empty',
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.error);
    expect(committed.workspace?.currentRevision.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'empty.bin', sizeBytes: 0 })]),
    );
  });

  test('过期未提交暂存安全清理；committed 结果仍可查询', async () => {
    const { app, cid, baselineRevisionId, setNow } = await seedWorkspace();
    const body = Buffer.from('temp');
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-expire',
      baselineRevisionId,
      files: [{
        path: 'tmp.bin',
        expectedSizeBytes: body.length,
        expectedSha256: sha256(body),
      }],
    });
    await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-expire', path: 'tmp.bin', offset: 0, content: body.subarray(0, 2),
    });

    // 未过期：仍可查询
    await expect(app.getWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-expire',
    })).resolves.toMatchObject({ ok: true, staging: { status: 'open' } });

    // 推进时间超过保留期并清理
    setNow(100 + 24 * 60 * 60 * 1000 + 1);
    const cleaned = await app.cleanupExpiredWorkspacePublishStaging({
      retentionMs: 24 * 60 * 60 * 1000,
      now: 100 + 24 * 60 * 60 * 1000 + 1,
    });
    expect(cleaned).toMatchObject({ ok: true, cleaned: 1 });
    await expect(app.getWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-expire',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    // 已提交的 publish 不被清理
    setNow(200);
    const doneBody = Buffer.from('done');
    // 需要刷新 baseline：workspace 仍在 rev1（expire 未 commit）
    const ws = await app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid });
    if (!ws.ok) throw new Error(ws.error);
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-keep',
      baselineRevisionId: ws.workspace.currentRevisionId,
      files: [{
        path: 'keep.bin',
        expectedSizeBytes: doneBody.length,
        expectedSha256: sha256(doneBody),
      }],
    });
    await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-keep', path: 'keep.bin', offset: 0, content: doneBody,
    });
    const committed = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-keep',
    });
    expect(committed.ok).toBe(true);
    setNow(200 + 24 * 60 * 60 * 1000 * 10);
    await app.cleanupExpiredWorkspacePublishStaging({
      retentionMs: 24 * 60 * 60 * 1000,
      now: 200 + 24 * 60 * 60 * 1000 * 10,
    });
    await expect(app.getWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-keep',
    })).resolves.toMatchObject({
      ok: true,
      staging: { status: 'committed', committedRevisionId: expect.any(String) },
    });
  });
});

describe('Workspace staging disk content store (#1005)', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function seedWithDiskStore() {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-staging-'));
    tempDirs.push(dataDir);
    const stagingContentStore = createFileWorkspaceStagingContentStore(dataDir);
    const repositories = createInMemoryRepositories();
    let now = 100;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids: {
        nextId: createIds([
          'user-1', 'team-1', 'all-1', 'channel-1',
          'workspace-1', 'revision-1',
          'art-1', 'rev-2', 'art-2', 'rev-3', 'art-3', 'rev-4',
        ]),
      },
      stagingContentStore,
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({
      userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
    });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    await repositories.artifacts.create({
      id: 'seed-art', teamId: 'team-1', channelId: cid, uploaderId: 'user-1',
      filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
    });
    const created = await app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      files: [{ path: 'base.txt', artifactId: 'seed-art' }],
    });
    if (!created.ok) throw new Error(created.error);
    return {
      dataDir,
      stagingContentStore,
      repositories,
      app,
      cid,
      baselineRevisionId: created.workspace.currentRevisionId,
      setNow: (value: number) => { now = value; },
    };
  }

  test('多分片 put 写磁盘且不把 content 塞进 staging 记录', async () => {
    const { app, cid, baselineRevisionId, repositories, dataDir } = await seedWithDiskStore();
    const part1 = Buffer.from('hello ');
    const part2 = Buffer.from('disk!!');
    const full = Buffer.concat([part1, part2]);
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-disk-1',
      baselineRevisionId,
      files: [{
        path: 'out/big.bin',
        expectedSizeBytes: full.length,
        expectedSha256: sha256(full),
      }],
    });
    const half = await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-disk-1', path: 'out/big.bin', offset: 0, content: part1,
    });
    expect(half).toMatchObject({ ok: true, staging: { files: [{ complete: false, receivedBytes: part1.length }] } });

    const rel = workspaceStagingRelativePath('team-1', 'pub-disk-1', 'out/big.bin');
    const abs = join(dataDir, rel);
    expect(existsSync(abs)).toBe(true);

    const storedHalf = await repositories.workspacePublishStagings.getByPublishId({
      teamId: 'team-1', publishId: 'pub-disk-1',
    });
    expect(storedHalf?.files[0]?.storagePath).toBe(rel);
    expect(storedHalf?.files[0]?.content).toBeUndefined();

    const rest = await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-disk-1', path: 'out/big.bin', offset: part1.length, content: part2,
    });
    expect(rest).toMatchObject({ ok: true, staging: { files: [{ complete: true, receivedBytes: full.length }] } });

    const committed = await app.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-disk-1',
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw new Error(committed.error);
    expect(committed.workspace?.currentRevision.files).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'out/big.bin', sizeBytes: full.length })]),
    );
    // commit 后清理 staging 目录
    expect(existsSync(join(dataDir, 'workspace-staging', 'team-1', 'pub-disk-1'))).toBe(false);
  });

  test('同 dataDir 新 store 实例可续传（模拟进程重启后同一磁盘）', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'agentbean-staging-resume-'));
    tempDirs.push(dataDir);
    const repositories = createInMemoryRepositories();
    let now = 100;
    const ids = {
      nextId: createIds([
        'user-1', 'team-1', 'all-1', 'channel-1',
        'workspace-1', 'revision-1',
        'art-1', 'rev-2',
      ]),
    };
    const app1 = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids,
      stagingContentStore: createFileWorkspaceStagingContentStore(dataDir),
    });
    await app1.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app1.createChannel({
      userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public',
    });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    await repositories.artifacts.create({
      id: 'seed-art', teamId: 'team-1', channelId: cid, uploaderId: 'user-1',
      filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
    });
    const created = await app1.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      files: [{ path: 'base.txt', artifactId: 'seed-art' }],
    });
    if (!created.ok) throw new Error(created.error);
    const part1 = Buffer.from('resume-');
    const part2 = Buffer.from('works!');
    const full = Buffer.concat([part1, part2]);
    await app1.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-disk',
      baselineRevisionId: created.workspace.currentRevisionId,
      files: [{
        path: 'r.bin',
        expectedSizeBytes: full.length,
        expectedSha256: sha256(full),
      }],
    });
    await app1.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-disk', path: 'r.bin', offset: 0, content: part1,
    });

    // 模拟进程重启：新 store（同 dataDir）+ 新 usecase（metadata 仍在 repositories）
    const app2 = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids,
      stagingContentStore: createFileWorkspaceStagingContentStore(dataDir),
    });
    const rest = await app2.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-resume-disk', path: 'r.bin', offset: part1.length, content: part2,
    });
    expect(rest).toMatchObject({ ok: true, staging: { files: [{ complete: true }] } });
    const committed = await app2.commitWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid, publishId: 'pub-resume-disk',
    });
    expect(committed.ok).toBe(true);
  });

  test('cleanup 过期 open staging 时删除磁盘目录', async () => {
    const { app, cid, baselineRevisionId, dataDir, setNow } = await seedWithDiskStore();
    const body = Buffer.from('temp-disk');
    await app.beginWorkspacePublishStaging({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-disk-expire',
      baselineRevisionId,
      files: [{
        path: 'tmp.bin',
        expectedSizeBytes: body.length,
        expectedSha256: sha256(body),
      }],
    });
    await app.putWorkspacePublishStagingFile({
      userId: 'user-1', teamId: 'team-1', channelId: cid,
      publishId: 'pub-disk-expire', path: 'tmp.bin', offset: 0, content: body.subarray(0, 4),
    });
    const stagingDir = join(dataDir, 'workspace-staging', 'team-1', 'pub-disk-expire');
    expect(existsSync(stagingDir)).toBe(true);

    setNow(100 + 24 * 60 * 60 * 1000 + 1);
    const cleaned = await app.cleanupExpiredWorkspacePublishStaging({
      retentionMs: 24 * 60 * 60 * 1000,
      now: 100 + 24 * 60 * 60 * 1000 + 1,
    });
    expect(cleaned).toMatchObject({ ok: true, cleaned: 1 });
    expect(existsSync(stagingDir)).toBe(false);
  });
});
