import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, test } from 'vitest';
import {
  buildDispatchWorkspacePublishId,
  deliverWorkspaceOutputsViaStaging,
} from '../src/workspace-publish-delivery.js';
import {
  createFilesystemWorkspacePublishRecoveryStore,
  type StagingRemoteClient,
} from '../src/workspace-publish-recovery.js';
import type { CollectedArtifact } from '../src/artifact-collector.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-deliver-'));
  dirs.push(dir);
  return dir;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function collected(root: string, name: string, body: string): CollectedArtifact {
  const absolutePath = join(root, name);
  writeFileSync(absolutePath, body);
  const bytes = Buffer.from(body);
  return {
    absolutePath,
    relativePath: name,
    filename: name,
    sizeBytes: bytes.length,
    sha256: sha256(bytes),
    role: 'deliverable',
    sourceRoot: { id: 'out', kind: 'run_output', label: 'outputs' },
  };
}

describe('workspace-publish-delivery (#1003)', () => {
  test('buildDispatchWorkspacePublishId 对同一 dispatch/baseline 稳定', () => {
    const a = buildDispatchWorkspacePublishId({
      dispatchId: 'd1', channelId: 'c1', baselineRevisionId: 'rev-1',
    });
    const b = buildDispatchWorkspacePublishId({
      dispatchId: 'd1', channelId: 'c1', baselineRevisionId: 'rev-1',
    });
    const c = buildDispatchWorkspacePublishId({
      dispatchId: 'd2', channelId: 'c1', baselineRevisionId: 'rev-1',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('dispatch-')).toBe(true);
  });

  test('begin→put→commit 成功并返回 artifactIds；pending 标记 committed', async () => {
    const root = tempDir();
    const store = createFilesystemWorkspacePublishRecoveryStore(root);
    const fileRoot = tempDir();
    const item = collected(fileRoot, 'out.txt', 'hello-staging');

    let putCalls = 0;
    let beginProvenance: unknown;
    const client: StagingRemoteClient = {
      async begin(input) {
        beginProvenance = input.provenance;
        return {
          ok: true,
          staging: {
            status: 'open',
            files: [{ path: 'out.txt', receivedBytes: 0, complete: false }],
          },
        };
      },
      async putChunk() {
        putCalls += 1;
        return {
          ok: true,
          staging: {
            files: [{ path: 'out.txt', receivedBytes: item.sizeBytes, complete: true }],
          },
        };
      },
      async get() {
        return {
          ok: true,
          staging: {
            status: 'open',
            files: [{ path: 'out.txt', receivedBytes: 0, complete: false }],
          },
        };
      },
      async commit() {
        return {
          ok: true,
          staging: { status: 'committed', committedRevisionId: 'rev-2' },
          workspace: {
            currentRevisionId: 'rev-2',
            currentRevision: {
              id: 'rev-2',
              files: [{ path: 'out.txt', artifactId: 'art-out' }],
            },
          },
        };
      },
    };

    const result = await deliverWorkspaceOutputsViaStaging({
      store,
      client,
      teamId: 'team-1',
      channelId: 'ch-1',
      baselineRevisionId: 'rev-1',
      collected: [item],
      publishId: 'pub-deliver-1',
      now: 1000,
      provenance: { agentId: 'agent-1', taskId: 'task-1', taskAttempt: 3 },
    });

    expect(result).toEqual({
      kind: 'committed',
      publishId: 'pub-deliver-1',
      committedRevisionId: 'rev-2',
      artifactIds: ['art-out'],
      files: [{ path: 'out.txt', artifactId: 'art-out' }],
    });
    expect(putCalls).toBe(1);
    expect(beginProvenance).toEqual({ agentId: 'agent-1', taskId: 'task-1', taskAttempt: 3 });
    expect(store.get('pub-deliver-1')?.provenance).toEqual({ agentId: 'agent-1', taskId: 'task-1', taskAttempt: 3 });
    expect(store.get('pub-deliver-1')?.status).toBe('committed');
    expect(store.listPending()).toHaveLength(0);
  });

  test('commit CONFLICT 不伪造已发布，pending 仍保留', async () => {
    const root = tempDir();
    const store = createFilesystemWorkspacePublishRecoveryStore(root);
    const fileRoot = tempDir();
    const item = collected(fileRoot, 'a.bin', 'abc');

    const client: StagingRemoteClient = {
      async begin() {
        return {
          ok: true,
          staging: { status: 'open', files: [{ path: 'a.bin', receivedBytes: 0, complete: false }] },
        };
      },
      async putChunk() {
        return {
          ok: true,
          staging: { files: [{ path: 'a.bin', receivedBytes: 3, complete: true }] },
        };
      },
      async get() {
        return {
          ok: true,
          staging: { status: 'open', files: [{ path: 'a.bin', receivedBytes: 0, complete: false }] },
        };
      },
      async commit() {
        return {
          ok: false,
          error: 'CONFLICT',
          details: { conflictingPaths: ['a.bin'] },
        };
      },
    };

    const result = await deliverWorkspaceOutputsViaStaging({
      store,
      client,
      teamId: 't',
      channelId: 'c',
      baselineRevisionId: 'rev-1',
      collected: [item],
      publishId: 'pub-conflict',
      now: 10,
    });

    expect(result).toEqual({
      kind: 'conflict',
      publishId: 'pub-conflict',
      conflictingPaths: ['a.bin'],
    });
    expect(store.get('pub-conflict')?.status).toBe('pending');
    expect(store.listPending()).toHaveLength(1);
  });

  test('已 committed 的 publishId 幂等收敛', async () => {
    const root = tempDir();
    const store = createFilesystemWorkspacePublishRecoveryStore(root);
    store.save({
      publishId: 'pub-done',
      teamId: 't',
      channelId: 'c',
      baselineRevisionId: 'rev-1',
      files: [],
      status: 'committed',
      committedRevisionId: 'rev-9',
      createdAt: 1,
      updatedAt: 2,
    });
    const client: StagingRemoteClient = {
      async begin() { throw new Error('no begin'); },
      async putChunk() { throw new Error('no put'); },
      async get() { throw new Error('no get'); },
      async commit() { throw new Error('no commit'); },
    };
    const result = await deliverWorkspaceOutputsViaStaging({
      store,
      client,
      teamId: 't',
      channelId: 'c',
      baselineRevisionId: 'rev-1',
      collected: [collected(tempDir(), 'x.txt', 'x')],
      publishId: 'pub-done',
      now: 99,
    });
    expect(result).toMatchObject({
      kind: 'committed',
      publishId: 'pub-done',
      committedRevisionId: 'rev-9',
    });
  });
});
