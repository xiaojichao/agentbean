import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';

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
        'workspace-1', 'revision-1', 'seed-art',
        'art-new-1', 'art-new-2', 'revision-2',
        'art-retry', 'revision-3',
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
