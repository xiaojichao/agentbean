import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, afterEach } from 'vitest';
import {
  buildLocalWorkspacePublishFile,
  createFilesystemWorkspacePublishRecoveryStore,
  resumeLocalWorkspacePublish,
  type StagingRemoteClient,
  type LocalWorkspacePublishRecord,
} from '../src/workspace-publish-recovery.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-publish-'));
  dirs.push(dir);
  return dir;
}

describe('workspace-publish-recovery (#967 断网/重启可恢复发布)', () => {
  test('本地 pending 持久化后可列出并在 Server 已 committed 时收敛', async () => {
    const root = tempDir();
    const store = createFilesystemWorkspacePublishRecoveryStore(root);
    const fileDir = tempDir();
    const abs = join(fileDir, 'out.bin');
    writeFileSync(abs, Buffer.from('hello-bin'));
    const file = buildLocalWorkspacePublishFile({ path: 'out.bin', absolutePath: abs });
    const record: LocalWorkspacePublishRecord = {
      publishId: 'pub-recover-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      baselineRevisionId: 'rev-1',
      files: [file],
      status: 'pending',
      createdAt: 100,
      updatedAt: 100,
    };
    store.save(record);
    expect(store.listPending()).toHaveLength(1);

    const client: StagingRemoteClient = {
      async begin() { throw new Error('should not begin'); },
      async putChunk() { throw new Error('should not put'); },
      async get() {
        return {
          ok: true,
          staging: {
            status: 'committed',
            committedRevisionId: 'rev-2',
            files: [{ path: 'out.bin', receivedBytes: file.expectedSizeBytes, complete: true }],
          },
        };
      },
      async commit() { throw new Error('should not commit'); },
    };

    const result = await resumeLocalWorkspacePublish({
      store, client, publishId: 'pub-recover-1', now: 200,
    });
    expect(result).toEqual({ kind: 'committed', committedRevisionId: 'rev-2' });
    expect(store.get('pub-recover-1')?.status).toBe('committed');
    expect(store.listPending()).toHaveLength(0);
  });

  test('Server 无会话时 re-begin + 从 offset 续传未完成字节后 commit', async () => {
    const root = tempDir();
    const store = createFilesystemWorkspacePublishRecoveryStore(root);
    const fileDir = tempDir();
    const abs = join(fileDir, 'clip.mp4');
    const payload = Buffer.from('0123456789abcdef');
    writeFileSync(abs, payload);
    const file = buildLocalWorkspacePublishFile({
      path: 'media/clip.mp4',
      absolutePath: abs,
      mimeType: 'video/mp4',
    });
    store.save({
      publishId: 'pub-resume-2',
      teamId: 'team-1',
      channelId: 'channel-1',
      baselineRevisionId: 'rev-1',
      files: [file],
      status: 'pending',
      createdAt: 1,
      updatedAt: 1,
    });

    let began = false;
    let putOffset: number | undefined;
    let putLen = 0;
    let committed = false;
    const remoteReceived = 4; // 模拟已上传 4 字节后断网

    const client: StagingRemoteClient = {
      async begin() {
        began = true;
        return {
          ok: true,
          staging: {
            status: 'open',
            files: [{ path: file.path, receivedBytes: 0, complete: false }],
          },
        };
      },
      async putChunk(input) {
        putOffset = input.offset;
        putLen = input.content.length;
        return {
          ok: true,
          staging: {
            files: [{ path: file.path, receivedBytes: input.offset + input.content.length, complete: true }],
          },
        };
      },
      async get() {
        if (!began && !committed) {
          return { ok: false, error: 'NOT_FOUND' };
        }
        return {
          ok: true,
          staging: {
            status: committed ? 'committed' : 'open',
            ...(committed ? { committedRevisionId: 'rev-9' } : {}),
            files: [{
              path: file.path,
              receivedBytes: committed ? file.expectedSizeBytes : remoteReceived,
              complete: committed,
            }],
          },
        };
      },
      async commit() {
        committed = true;
        return {
          ok: true,
          staging: { status: 'committed', committedRevisionId: 'rev-9' },
          workspace: { currentRevisionId: 'rev-9' },
        };
      },
    };

    // 第一次 get 失败 → begin；第二次 get 返回 receivedBytes=4；put 从 4 续传
    let getCount = 0;
    const countingClient: StagingRemoteClient = {
      begin: client.begin,
      putChunk: client.putChunk,
      commit: client.commit,
      async get(input) {
        getCount += 1;
        if (getCount === 1) return { ok: false, error: 'NOT_FOUND' };
        return {
          ok: true,
          staging: {
            status: 'open',
            files: [{ path: file.path, receivedBytes: remoteReceived, complete: false }],
          },
        };
      },
    };

    const result = await resumeLocalWorkspacePublish({
      store,
      client: countingClient,
      publishId: 'pub-resume-2',
      now: 50,
    });
    expect(began).toBe(true);
    expect(putOffset).toBe(4);
    expect(putLen).toBe(payload.length - 4);
    expect(result).toEqual({ kind: 'committed', committedRevisionId: 'rev-9' });
  });

  test('二进制同路径冲突向上返回 conflict，不伪造已发布', async () => {
    const root = tempDir();
    const store = createFilesystemWorkspacePublishRecoveryStore(root);
    const fileDir = tempDir();
    const abs = join(fileDir, 'a.bin');
    writeFileSync(abs, Buffer.from('abc'));
    const file = buildLocalWorkspacePublishFile({ path: 'a.bin', absolutePath: abs });
    store.save({
      publishId: 'pub-conflict',
      teamId: 't', channelId: 'c', baselineRevisionId: 'rev-1',
      files: [file], status: 'pending', createdAt: 1, updatedAt: 1,
    });

    const client: StagingRemoteClient = {
      async begin() {
        return { ok: true, staging: { status: 'open', files: [{ path: 'a.bin', receivedBytes: 0, complete: false }] } };
      },
      async putChunk() {
        return { ok: true, staging: { files: [{ path: 'a.bin', receivedBytes: 3, complete: true }] } };
      },
      async get() {
        return { ok: true, staging: { status: 'open', files: [{ path: 'a.bin', receivedBytes: 0, complete: false }] } };
      },
      async commit() {
        return { ok: false, error: 'CONFLICT', details: { conflictingPaths: ['a.bin'] } };
      },
    };

    const result = await resumeLocalWorkspacePublish({
      store, client, publishId: 'pub-conflict', now: 10,
    });
    expect(result).toEqual({ kind: 'conflict', conflictingPaths: ['a.bin'] });
    expect(store.get('pub-conflict')?.status).toBe('pending');
  });
});
