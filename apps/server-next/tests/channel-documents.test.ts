import { describe, expect, test, vi } from 'vitest';
import { createInMemoryRepositories, createInMemoryServerNext, createServerNextUseCases } from '../src/index';
import type { ArtifactRecord, ChannelDocumentRecord, ChannelDocumentRevisionRecord } from '../src/application/repositories';

describe('频道 Markdown 文档', () => {
  test('同名 Markdown 消息附件各自建立独立初始文档', async () => {
    const app = createInMemoryServerNext({
      now: () => 100,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'artifact-1', 'artifact-2', 'message-1', 'message-2']),
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    for (const artifactId of ['artifact-1', 'artifact-2']) {
      await app.uploadArtifact({
        userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
        filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 5,
        storagePath: `artifacts/team-1/${artifactId}/notes.md`,
      });
    }
    await app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'first', artifactIds: ['artifact-1'],
    });
    await app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'second', artifactIds: ['artifact-2'],
    });

    const result = await app.listChannelDocuments({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.documents.map((document) => ({
      id: document.id,
      artifactId: document.currentRevision.artifact.id,
      revision: document.currentRevision.revision,
    })).sort((left, right) => left.id.localeCompare(right.id))).toEqual([
      { id: 'channel-document:artifact-1', artifactId: 'artifact-1', revision: 1 },
      { id: 'channel-document:artifact-2', artifactId: 'artifact-2', revision: 1 },
    ]);
  });

  test('初始文档创建可幂等重放', async () => {
    const repositories = createInMemoryRepositories();
    const initial = createInitialRecords();

    await expect(repositories.channelDocuments.create(initial)).resolves.toEqual(initial.document);
    await expect(repositories.channelDocuments.create(initial)).resolves.toEqual(initial.document);
    await expect(repositories.channelDocuments.listRevisions({ documentId: initial.document.id })).resolves.toHaveLength(1);
  });

  test('历史 Markdown 附件按需回填，列表批量读取当前版本', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await repositories.messages.append({
      id: 'message-old', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-old',
      senderKind: 'agent', senderId: 'agent-1', body: 'legacy', createdAt: 100,
    });
    await repositories.artifacts.create({
      id: 'artifact-old', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-old',
      uploaderId: 'agent-1', filename: 'legacy.md', mimeType: 'text/markdown', sizeBytes: 6,
      storagePath: 'artifacts/team-1/artifact-old/legacy.md', pathKind: 'generated', createdAt: 100,
    });

    await expect(app.getChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      documentId: 'channel-document:artifact-old',
    })).resolves.toMatchObject({
      ok: true,
      document: { currentRevision: { artifact: { id: 'artifact-old' } } },
    });

    const revisionReads = vi.spyOn(repositories.channelDocuments, 'listRevisions');
    const listed = await app.listChannelDocuments({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
    });
    expect(listed).toMatchObject({
      ok: true,
      documents: [{ id: 'channel-document:artifact-old', currentRevision: { artifact: { id: 'artifact-old' } } }],
    });
    expect(revisionReads).not.toHaveBeenCalled();
  });

  test('已删除消息的带参数 Markdown 附件不能按需创建文档', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await repositories.messages.append({
      id: 'message-deleted',
      teamId: 'team-1',
      channelId: 'channel-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: '消息已删除',
      meta: { deletedAt: 150 },
      createdAt: 100,
    });
    await repositories.artifacts.create({
      id: 'artifact-deleted',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-deleted',
      uploaderId: 'user-1',
      filename: 'README',
      mimeType: 'text/markdown; charset=utf-8',
      sizeBytes: 6,
      createdAt: 100,
    });

    await expect(app.getChannelDocument({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      documentId: 'channel-document:artifact-deleted',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(repositories.channelDocuments.listByChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual([]);
  });

  test('连续保存保留旧 Artifact 并使用单调递增 revision', async () => {
    const repositories = createInMemoryRepositories();
    const writes: string[] = [];
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'artifact-2', 'revision-2', 'artifact-3', 'revision-3']) },
      artifactContentStore: {
        async writeContent(input) {
          writes.push(input.content.toString('utf8'));
          return { storagePath: `artifacts/${input.artifactId}/${input.filename}`, sizeBytes: input.content.length, sha256: `sha-${input.artifactId}` };
        },
        deleteContent: vi.fn(),
      },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const initial = createInitialRecords();
    await repositories.artifacts.create(initial.revision.artifact);
    await repositories.channelDocuments.create(initial);

    const second = await app.saveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
      baseRevisionId: initial.revision.id, content: '# second',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error(second.error);

    const third = await app.saveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
      baseRevisionId: second.document.currentRevisionId, content: '# third',
    });
    expect(third.ok).toBe(true);
    if (!third.ok) throw new Error(third.error);

    expect(third.document.currentRevision).toMatchObject({
      revision: 3,
      artifact: { id: 'artifact-3', filename: 'notes.md' },
    });
    await expect(repositories.artifacts.getForTeam({ teamId: 'team-1', artifactId: 'artifact-1' })).resolves.toMatchObject({
      id: 'artifact-1',
      messageId: 'message-1',
    });
    expect(writes).toEqual(['# second', '# third']);
  });

  test('拒绝超限和危险内容，并在并发基线过期时不写文件', async () => {
    const repositories = createInMemoryRepositories();
    const writeContent = vi.fn();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
      artifactContentStore: {
        writeContent,
      },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const initial = createInitialRecords();
    await repositories.artifacts.create(initial.revision.artifact);
    await repositories.channelDocuments.create(initial);

    await expect(app.saveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
      baseRevisionId: 'stale', content: 'safe',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.saveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
      baseRevisionId: initial.revision.id, content: '[bad](javascript:alert(1))',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.saveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
      baseRevisionId: initial.revision.id, content: 'x'.repeat(2 * 1024 * 1024 + 1),
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    expect(writeContent).not.toHaveBeenCalled();
  });
});

function createInitialRecords(): { document: ChannelDocumentRecord; revision: ChannelDocumentRevisionRecord } {
  const artifact: ArtifactRecord = {
    id: 'artifact-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    uploaderId: 'user-1',
    filename: 'notes.md',
    mimeType: 'text/markdown',
    sizeBytes: 7,
    storagePath: 'artifacts/team-1/artifact-1/notes.md',
    pathKind: 'upload',
    createdAt: 100,
  };
  const revision: ChannelDocumentRevisionRecord = {
    id: 'channel-document:artifact-1:revision:1',
    documentId: 'channel-document:artifact-1',
    artifact,
    revision: 1,
    createdBy: 'user-1',
    createdAt: 100,
  };
  return {
    document: {
      id: revision.documentId,
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: artifact.filename,
      currentRevisionId: revision.id,
      createdAt: 100,
      updatedAt: 100,
    },
    revision,
  };
}

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const value = ids[index];
    if (!value) throw new Error(`Missing id at index ${index}`);
    index += 1;
    return value;
  };
}
