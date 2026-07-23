import { describe, expect, test, vi } from 'vitest';
import { createInMemoryRepositories, createInMemoryServerNext, createServerNextUseCases } from '../src/index';
import type { ArtifactRecord, ChannelDocumentRecord, ChannelDocumentRevisionRecord } from '../src/application/repositories';

describe('频道 Markdown 文档', () => {
  test('从 Run Markdown 派生独立文档并把相对资源固定到同一来源根的 Artifact', async () => {
    const repositories = createInMemoryRepositories();
    const writes: string[] = [];
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds([
        'user-1', 'team-1', 'channel-1',
        'artifact-derived', 'document-derived', 'revision-derived',
        'artifact-second', 'revision-second',
      ]) },
      artifactContentStore: {
        async writeContent(input) {
          writes.push(input.content.toString('utf8'));
          return { storagePath: `artifacts/${input.artifactId}/${input.filename}`, sizeBytes: input.content.length, sha256: 'sha-derived' };
        },
        deleteContent: vi.fn(),
      },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await repositories.messages.append({
      id: 'message-task', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-task',
      senderKind: 'human', senderId: 'user-1', body: '生成报告', meta: { taskId: 'task-1' }, createdAt: 90,
    });
    await repositories.dispatches.create({
      id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-task',
      agentId: 'agent-1', status: 'succeeded', requestId: 'request-1', prompt: '生成报告', createdAt: 90, updatedAt: 100,
    });
    await repositories.workspaceRuns.create({
      id: 'run-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-task',
      dispatchId: 'dispatch-1', agentId: 'agent-1', status: 'succeeded', createdAt: 90, updatedAt: 100, artifactIds: [],
    });
    const sourceRoot = { id: 'root-output', kind: 'run_output' as const, label: '运行输出' };
    for (const artifact of [
      { id: 'artifact-source', filename: 'report.md', mimeType: 'text/markdown', relativePath: 'docs/./report.md' },
      { id: 'artifact-image', filename: 'chart.png', mimeType: 'image/png', relativePath: 'images/chart.png' },
      { id: 'artifact-video', filename: 'demo.mp4', mimeType: 'video/mp4', relativePath: 'media/demo.mp4' },
      { id: 'artifact-file', filename: 'data.csv', mimeType: 'text/csv', relativePath: 'data/data.csv' },
      { id: 'artifact-paren', filename: 'data(1).csv', mimeType: 'text/csv', relativePath: 'data/data(1).csv' },
      { id: 'artifact-nested-paren', filename: 'data((1)).csv', mimeType: 'text/csv', relativePath: 'data/data((1)).csv' },
    ]) {
      await repositories.artifacts.create({
        ...artifact, teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-1', workspaceRunId: 'run-1',
        uploaderId: 'agent-1', sizeBytes: 10, sourceRoot, pathKind: 'generated', role: 'run_output', createdAt: 100,
      });
    }
    await repositories.artifacts.create({
      id: 'artifact-other-root', teamId: 'team-1', channelId: 'channel-1',
      dispatchId: 'dispatch-1', workspaceRunId: 'run-1', uploaderId: 'agent-1',
      filename: 'missing.png', mimeType: 'image/png', sizeBytes: 10,
      relativePath: 'docs/missing.png', pathKind: 'generated', role: 'run_output',
      sourceRoot: { id: 'root-private', kind: 'configured_output', label: '其他来源根' }, createdAt: 100,
    });

    await expect(app.getChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      documentId: 'channel-document:artifact-source',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const result = await app.deriveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', sourceArtifactId: 'artifact-source',
      filename: '派生报告.md',
      content: '![图](../images/chart.png)\n[视频](../media/demo.mp4)\n[数据](../data/data.csv)\n'
        + '![缺失](missing.png)\n![空格路径](<../images/chart.png>)\n[括号路径](../data/data(1).csv)\n'
        + '[多层括号路径](../data/data((1)).csv)\n'
        + '![引用图][chart]\n[chart]: ../images/chart.png\n'
        + '~~~~ markdown example\n![代码示例](/api/teams/team-1/artifacts/foreign/preview)\n'
        + '[example]: ../data/example.csv\n~~~~\n'
        + '``内联 ` 示例 ![图](/api/teams/team-1/artifacts/foreign/preview)``',
    });

    expect(result).toMatchObject({
      ok: true,
      document: {
        id: 'document-derived',
        currentRevision: {
          source: {
            taskId: 'task-1', workspaceRunId: 'run-1', agentId: 'agent-1',
            sourceRoot: { id: 'root-output' }, relativePath: 'docs/./report.md',
            normalizedRelativePath: 'docs/report.md', artifactId: 'artifact-source',
          },
          resources: [
            { original: '../images/chart.png', status: 'resolved', artifactId: 'artifact-image', kind: 'image' },
            { original: '../images/chart.png', status: 'resolved', artifactId: 'artifact-image', kind: 'image' },
            { original: '../media/demo.mp4', status: 'resolved', artifactId: 'artifact-video', kind: 'video' },
            { original: '../data/data.csv', status: 'resolved', artifactId: 'artifact-file', kind: 'file' },
            { original: 'missing.png', status: 'missing', kind: 'image' },
            { original: '../images/chart.png', status: 'resolved', artifactId: 'artifact-image', kind: 'image' },
            { original: '../data/data(1).csv', status: 'resolved', artifactId: 'artifact-paren', kind: 'file' },
            { original: '../data/data((1)).csv', status: 'resolved', artifactId: 'artifact-nested-paren', kind: 'file' },
          ],
        },
      },
    });
    expect(writes).toEqual([
      '![图](/api/teams/team-1/artifacts/artifact-image/preview)\n'
      + '[视频](/api/teams/team-1/artifacts/artifact-video/preview)\n'
      + '[数据](/api/teams/team-1/artifacts/artifact-file/download)\n'
      + '![缺失](artifact-missing:docs%2Fmissing.png)\n'
      + '![空格路径](/api/teams/team-1/artifacts/artifact-image/preview)\n'
      + '[括号路径](/api/teams/team-1/artifacts/artifact-paren/download)\n'
      + '[多层括号路径](/api/teams/team-1/artifacts/artifact-nested-paren/download)\n'
      + '![引用图][chart]\n'
      + '[chart]: /api/teams/team-1/artifacts/artifact-image/preview\n'
      + '~~~~ markdown example\n![代码示例](/api/teams/team-1/artifacts/foreign/preview)\n'
      + '[example]: ../data/example.csv\n~~~~\n'
      + '``内联 ` 示例 ![图](/api/teams/team-1/artifacts/foreign/preview)``',
    ]);
    await expect(repositories.artifacts.getForTeam({
      teamId: 'team-1', artifactId: 'artifact-source',
    })).resolves.toMatchObject({ relativePath: 'docs/./report.md' });

    if (!result.ok) throw new Error(result.error);
    const second = await app.saveChannelDocument({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      documentId: result.document.id, baseRevisionId: result.document.currentRevisionId,
      content: '![图](../images/chart.png)\n[新增缺失](new.bin)',
    });
    expect(second).toMatchObject({
      ok: true,
      document: {
        currentRevision: {
          revision: 2,
          source: { artifactId: 'artifact-source' },
          resources: [
            { original: '../images/chart.png', status: 'resolved', artifactId: 'artifact-image' },
            { original: 'new.bin', status: 'missing' },
          ],
        },
      },
    });
    expect(writes[1]).toBe(
      '![图](/api/teams/team-1/artifacts/artifact-image/preview)\n'
      + '[新增缺失](artifact-missing:docs%2Fnew.bin)',
    );
    const revisions = await repositories.channelDocuments.listRevisions({ documentId: result.document.id });
    expect(revisions[0]).toMatchObject({
      revision: 2, resources: [{ original: '../images/chart.png' }, { original: 'new.bin' }],
    });
    expect(revisions[1]?.revision).toBe(1);
    expect(revisions[1]?.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ original: '../images/chart.png' }),
      expect.objectContaining({ original: '../media/demo.mp4' }),
    ]));
    await expect(app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      files: [expect.objectContaining({
        documentId: result.document.id,
        documentRevision: 2,
        documentSource: expect.objectContaining({ artifactId: 'artifact-source', artifactRole: 'run_output' }),
        artifact: expect.objectContaining({ id: 'artifact-second' }),
      })],
    });
  });

  test('派生拒绝同名、越界和超过 500 个相对资源，失败时不产生半保存', async () => {
    const repositories = createInMemoryRepositories();
    const writeContent = vi.fn();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'artifact-target', 'revision-target']) },
      artifactContentStore: { writeContent },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const initial = createInitialRecords();
    await repositories.artifacts.create(initial.revision.artifact);
    await repositories.channelDocuments.create(initial);
    await repositories.workspaceRuns.create({
      id: 'run-1', teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-1', agentId: 'agent-1',
      status: 'succeeded', createdAt: 90, updatedAt: 100, artifactIds: ['artifact-source'],
    });
    await repositories.artifacts.create({
      id: 'artifact-source', teamId: 'team-1', channelId: 'channel-1', workspaceRunId: 'run-1',
      uploaderId: 'agent-1', filename: 'notes.md', mimeType: 'text/markdown', sizeBytes: 10,
      relativePath: 'docs/notes.md', pathKind: 'generated', role: 'run_output',
      sourceRoot: { id: 'root-output', kind: 'run_output', label: '运行输出' }, createdAt: 100,
    });
    await repositories.artifacts.create({
      id: 'artifact-other-run', teamId: 'team-1', channelId: 'channel-1', workspaceRunId: 'run-other',
      uploaderId: 'agent-2', filename: 'secret.txt', mimeType: 'text/plain', sizeBytes: 10,
      relativePath: 'docs/secret.txt', pathKind: 'generated', role: 'run_output',
      sourceRoot: { id: 'root-output', kind: 'run_output', label: '运行输出' }, createdAt: 100,
    });
    const input = {
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', sourceArtifactId: 'artifact-source',
      filename: 'notes.md',
    };

    await expect(app.deriveChannelDocument({ ...input, content: 'safe' }))
      .resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.deriveChannelDocument({ ...input, filename: 'renamed.md', content: '[越界](../../secret.txt)' }))
      .resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.deriveChannelDocument({
      ...input,
      filename: 'renamed.md',
      content: '[跨 Run](/api/teams/team-1/artifacts/artifact-other-run/preview)',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.deriveChannelDocument({
      ...input,
      filename: 'renamed.md',
      content: '~~~\r\n代码示例\r\n~~~\r\n[跨 Run](/api/teams/team-1/artifacts/artifact-other-run/preview)',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.deriveChannelDocument({
      ...input,
      filename: 'renamed.md',
      content: '[伪固定](/api/teams/team-1/artifacts/artifact-source/preview?download=1)',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.deriveChannelDocument({
      ...input,
      filename: 'renamed.md',
      content: '[危险](javascript:alert(1))',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.deriveChannelDocument({
      ...input,
      filename: 'renamed.md',
      content: Array.from({ length: 501 }, (_, index) => `[${index}](asset-${index}.png)`).join('\n'),
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    expect(writeContent).not.toHaveBeenCalled();
    await expect(repositories.channelDocuments.listByChannel({
      teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toHaveLength(1);

    await expect(app.deriveChannelDocument({
      ...input,
      content: 'safe',
      targetDocumentId: initial.document.id,
      targetBaseRevisionId: initial.revision.id,
    })).resolves.toMatchObject({
      ok: true,
      document: {
        id: initial.document.id,
        currentRevision: { revision: 2, source: { artifactId: 'artifact-source' } },
      },
    });
    expect(writeContent).toHaveBeenCalledTimes(1);
  });

  test('并发派生到不同目标文档时只允许一个目标占用同名文件名', async () => {
    const repositories = createInMemoryRepositories();
    const first = createInitialRecords();
    const secondArtifact: ArtifactRecord = {
      ...first.revision.artifact,
      id: 'artifact-2',
      messageId: 'message-2',
      filename: 'second.md',
    };
    const secondRevision: ChannelDocumentRevisionRecord = {
      ...first.revision,
      id: 'channel-document:artifact-2:revision:1',
      documentId: 'channel-document:artifact-2',
      artifact: secondArtifact,
    };
    const secondDocument: ChannelDocumentRecord = {
      ...first.document,
      id: secondRevision.documentId,
      filename: secondArtifact.filename,
      currentRevisionId: secondRevision.id,
    };
    await repositories.artifacts.create(first.revision.artifact);
    await repositories.channelDocuments.create(first);
    await repositories.artifacts.create(secondArtifact);
    await repositories.channelDocuments.create({ document: secondDocument, revision: secondRevision });

    const revisions = [
      {
        document: first.document,
        baseRevision: first.revision,
        artifact: { ...first.revision.artifact, id: 'artifact-next-1', filename: 'shared.md' },
        revisionId: 'revision-next-1',
      },
      {
        document: secondDocument,
        baseRevision: secondRevision,
        artifact: { ...secondArtifact, id: 'artifact-next-2', filename: 'shared.md' },
        revisionId: 'revision-next-2',
      },
    ];
    const results = await Promise.all(revisions.map(({ document, baseRevision, artifact, revisionId }) =>
      repositories.channelDocuments.addRevision({
        documentId: document.id,
        expectedCurrentRevisionId: baseRevision.id,
        document: { ...document, filename: 'shared.md', currentRevisionId: revisionId },
        revision: {
          id: revisionId,
          documentId: document.id,
          artifact,
          revision: 2,
          createdBy: 'user-1',
          createdAt: 200,
        },
        artifact,
        requireUniqueFilename: true,
      })));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    const documents = await repositories.channelDocuments.listByChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    });
    expect(documents.filter((document) => document.filename === 'shared.md')).toHaveLength(1);
  });

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

    await expect(app.listChannelDocuments({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: true, documents: [] });
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

  test('同一基础 revision 的并发保存只有一个成功且失败写入不会留下孤儿数据', async () => {
    const repositories = createInMemoryRepositories();
    const deleteContent = vi.fn();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'artifact-2', 'artifact-3', 'revision-2', 'revision-3']) },
      artifactContentStore: {
        async writeContent(input) {
          return {
            storagePath: `artifacts/${input.artifactId}/${input.filename}`,
            sizeBytes: input.content.length,
            sha256: `sha-${input.artifactId}`,
          };
        },
        deleteContent,
      },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const initial = createInitialRecords();
    await repositories.artifacts.create(initial.revision.artifact);
    await repositories.channelDocuments.create(initial);

    const results = await Promise.all([
      app.saveChannelDocument({
        userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
        baseRevisionId: initial.revision.id, content: '# first writer',
      }),
      app.saveChannelDocument({
        userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', documentId: initial.document.id,
        baseRevisionId: initial.revision.id, content: '# second writer',
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toMatchObject([{ error: 'CONFLICT' }]);
    await expect(repositories.channelDocuments.listRevisions({ documentId: initial.document.id })).resolves.toHaveLength(2);
    await expect(repositories.artifacts.listByChannel({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toHaveLength(2);
    expect(deleteContent).toHaveBeenCalledTimes(1);
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
