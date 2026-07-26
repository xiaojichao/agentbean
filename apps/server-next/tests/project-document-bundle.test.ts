import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import { parseChannelFileRolloutConfig } from '../src/application/channel-file-rollout.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const MARKDOWN_ROLLOUT = parseChannelFileRolloutConfig({
  AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING: 'on',
});

const SOURCE_ROOT = { id: 'root-output', kind: 'run_output' as const, label: '运行输出' };

describe('#825 一次 Markdown 输出的固定文档包', () => {
  let globalDb: DatabaseWithClose;
  let teamDb: DatabaseWithClose;
  let repositories: ServerNextRepositories;
  let app: ServerNextUseCases;
  let now = 1_000;
  let id = 0;

  const createApp = (): ServerNextUseCases => createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `bundle-id-${++id}` },
    messageIngestionMode: 'legacy',
    channelFileRollout: MARKDOWN_ROLLOUT,
  });

  /** 用真实 derive 路径建立带 derivationSource 的文档，保证来源事实与生产一致。 */
  const deriveDocument = async (input: {
    artifactId: string;
    filename: string;
    userId?: string;
  }): Promise<{ documentId: string; revisionId: string }> => {
    const result = await app.deriveChannelDocument({
      userId: input.userId ?? 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      sourceArtifactId: input.artifactId,
      filename: input.filename,
      content: `# ${input.filename}\n`,
    });
    if (!result.ok) throw new Error(`derive failed: ${result.error} ${result.message ?? ''}`);
    return { documentId: result.document.id, revisionId: result.document.currentRevisionId };
  };

  beforeEach(async () => {
    globalDb = new Database(':memory:');
    teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    repositories = createSqliteRepositories({ globalDb, teamDb });
    app = createApp();

    for (const user of [
      { id: 'owner-1', username: 'owner' },
      { id: 'member-1', username: 'member' },
      { id: 'outsider-1', username: 'outsider' },
    ]) {
      await repositories.users.create({
        ...user, passwordHash: 'hash', role: 'user', createdAt: now, updatedAt: now,
      });
    }
    await repositories.teams.create({
      id: 'team-1', name: '项目团队', path: 'project-team',
      visibility: 'private', ownerId: 'owner-1', createdAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'owner-1', username: 'owner', role: 'owner', joinedAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'member-1', username: 'member', role: 'member', joinedAt: now,
    });
    await repositories.channels.create({
      id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'launch',
      visibility: 'private', createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'member-1'], agentMemberIds: ['agent-1'],
      createdAt: now, updatedAt: now, archivedAt: null, revision: 1,
    });
    await repositories.dispatches.create({
      id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', status: 'succeeded', requestId: 'request-1',
      prompt: '生成文档', createdAt: now, updatedAt: now,
    });
    await repositories.workspaceRuns.create({
      id: 'run-1', teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-1',
      agentId: 'agent-1', status: 'succeeded', createdAt: now, updatedAt: now, artifactIds: [],
    });
    await repositories.dispatches.create({
      id: 'dispatch-2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-2',
      agentId: 'agent-1', status: 'succeeded', requestId: 'request-2',
      prompt: '第二次运行', createdAt: now, updatedAt: now,
    });
    await repositories.workspaceRuns.create({
      id: 'run-2', teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-2',
      agentId: 'agent-1', status: 'succeeded', createdAt: now, updatedAt: now, artifactIds: [],
    });

    for (const artifact of [
      { id: 'artifact-plan', filename: 'plan.md', mimeType: 'text/markdown', relativePath: 'docs/plan.md', workspaceRunId: 'run-1' },
      { id: 'artifact-spec', filename: 'spec.md', mimeType: 'text/markdown', relativePath: 'docs/spec.md', workspaceRunId: 'run-1' },
      { id: 'artifact-later', filename: 'later.md', mimeType: 'text/markdown', relativePath: 'docs/later.md', workspaceRunId: 'run-1' },
      { id: 'artifact-run2', filename: 'other.md', mimeType: 'text/markdown', relativePath: 'docs/other.md', workspaceRunId: 'run-2' },
    ]) {
      await repositories.artifacts.create({
        ...artifact, teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-1',
        uploaderId: 'agent-1', sizeBytes: 32, sourceRoot: SOURCE_ROOT,
        pathKind: 'generated', role: 'run_output', createdAt: now,
      });
    }
  });

  afterEach(() => {
    globalDb.close();
    teamDb.close();
  });

  test('从同一次 Run 创建 Bundle，成员固定保存 documentId 与 initialRevisionId', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const spec = await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });

    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1',
      documentIds: [plan.documentId, spec.documentId],
    });

    expect(created).toMatchObject({
      ok: true,
      replayed: false,
      archived: false,
      bundle: {
        name: '发布文档包',
        memberCount: 2,
        createdBy: 'owner-1',
        source: { kind: 'workspace_run', workspaceRunId: 'run-1', agentId: 'agent-1' },
        members: [
          {
            documentId: plan.documentId,
            position: 0,
            initialRevisionId: plan.revisionId,
            initialRevisionNumber: 1,
            initialFilename: 'plan.md',
            current: { revisionId: plan.revisionId, revisionNumber: 1, source: 'run', changedSinceJoin: false },
          },
          {
            documentId: spec.documentId,
            position: 1,
            initialRevisionId: spec.revisionId,
            initialFilename: 'spec.md',
          },
        ],
      },
    });
  });

  test('成员文档被修订后：initialRevisionId 不变，当前 revision 投影更新为编辑来源与时间', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!created.ok) throw new Error('bundle creation failed');

    const saved = await app.saveChannelDocument({
      userId: 'member-1', teamId: 'team-1', channelId: 'channel-1',
      documentId: plan.documentId, baseRevisionId: plan.revisionId,
      content: '# 人工修订后的计划\n',
    });
    if (!saved.ok) throw new Error('save failed');
    expect(saved.document.currentRevisionId).not.toBe(plan.revisionId);

    const detail = await app.getProjectDocumentBundle({
      userId: 'member-1', teamId: 'team-1', channelId: 'channel-1',
      bundleId: created.bundle.id,
    });

    expect(detail).toMatchObject({
      ok: true,
      bundle: {
        members: [{
          documentId: plan.documentId,
          // 加入时的事实原封不动。
          initialRevisionId: plan.revisionId,
          initialRevisionNumber: 1,
          initialFilename: 'plan.md',
          current: {
            revisionId: saved.document.currentRevisionId,
            revisionNumber: 2,
            source: 'edit',
            createdBy: 'member-1',
            changedSinceJoin: true,
          },
        }],
      },
    });
  });

  test('同一次 Run 后续新增的 Markdown 不回填旧 Bundle，只能形成新 Bundle', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const first = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '第一批',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!first.ok) throw new Error('bundle creation failed');

    const later = await deriveDocument({ artifactId: 'artifact-later', filename: 'later.md' });
    const second = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-2', name: '第二批',
      workspaceRunId: 'run-1', documentIds: [later.documentId],
    });
    if (!second.ok) throw new Error('second bundle creation failed');

    const reread = await app.getProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1', bundleId: first.bundle.id,
    });
    if (!reread.ok) throw new Error('bundle read failed');
    expect(reread.bundle.memberCount).toBe(1);
    expect(reread.bundle.members.map((member) => member.documentId)).toEqual([plan.documentId]);

    const listed = await app.listProjectDocumentBundles({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    if (!listed.ok) throw new Error('bundle list failed');
    expect(listed.bundles.map((bundle) => bundle.name)).toEqual(['第二批', '第一批']);
  });

  test('非 Markdown、运行日志与来源不一致的文档都不能成为成员', async () => {
    await repositories.artifacts.create({
      id: 'artifact-data', teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-1',
      workspaceRunId: 'run-1', uploaderId: 'agent-1', filename: 'data.csv', mimeType: 'text/csv',
      sizeBytes: 20, relativePath: 'data/data.csv', sourceRoot: SOURCE_ROOT,
      pathKind: 'generated', role: 'run_output', createdAt: now,
    });
    await repositories.artifacts.create({
      id: 'artifact-log', teamId: 'team-1', channelId: 'channel-1', dispatchId: 'dispatch-1',
      workspaceRunId: 'run-1', uploaderId: 'agent-1', filename: 'workspace-run.log',
      mimeType: 'text/markdown', sizeBytes: 20, relativePath: 'logs/workspace-run.log',
      sourceRoot: SOURCE_ROOT, pathKind: 'generated', role: 'run_output', createdAt: now,
    });
    // 非 Markdown / 运行日志根本无法建立 ChannelDocument —— derive 路径直接拒绝。
    await expect(app.deriveChannelDocument({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      sourceArtifactId: 'artifact-data', filename: 'data.csv', content: 'x',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const logDocument = await deriveDocument({ artifactId: 'artifact-log', filename: 'run-log.md' });
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const otherRun = await deriveDocument({ artifactId: 'artifact-run2', filename: 'other.md' });

    // 运行日志即便被强行 derive，其 artifact 仍被 domain 判为 run_log。
    await expect(app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-log', name: '含日志',
      workspaceRunId: 'run-1', documentIds: [plan.documentId, logDocument.documentId],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    // 另一次 Run 产出的文档来源不一致。
    await expect(app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-mixed', name: '跨运行',
      workspaceRunId: 'run-1', documentIds: [plan.documentId, otherRun.documentId],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    // 不存在的文档。
    await expect(app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-missing', name: '缺失成员',
      workspaceRunId: 'run-1', documentIds: [plan.documentId, 'channel-document:nope'],
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const listed = await app.listProjectDocumentBundles({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    if (!listed.ok) throw new Error('bundle list failed');
    expect(listed.bundles).toEqual([]);
  });

  test('重复命令幂等，同 key 不同命令与跨作用域 Run 被拒绝', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const command = {
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    };

    const first = await app.createProjectDocumentBundle(command);
    const replay = await app.createProjectDocumentBundle(command);
    if (!first.ok || !replay.ok) throw new Error('bundle creation failed');
    expect(replay.replayed).toBe(true);
    expect(replay.bundle.id).toBe(first.bundle.id);

    await expect(app.createProjectDocumentBundle({ ...command, name: '换个名字' }))
      .resolves.toMatchObject({ ok: false, error: 'CONFLICT' });

    // 跨作用域：另一个频道的 Run 不可用于本频道。
    await repositories.channels.create({
      id: 'channel-2', teamId: 'team-1', kind: 'channel', name: 'other',
      visibility: 'private', createdBy: 'owner-1',
      humanMemberIds: ['owner-1'], agentMemberIds: [], createdAt: now, updatedAt: now,
      archivedAt: null, revision: 1,
    });
    await repositories.dispatches.create({
      id: 'dispatch-3', teamId: 'team-1', channelId: 'channel-2', messageId: 'message-3',
      agentId: 'agent-1', status: 'succeeded', requestId: 'request-3',
      prompt: '别的频道', createdAt: now, updatedAt: now,
    });
    await repositories.workspaceRuns.create({
      id: 'run-foreign', teamId: 'team-1', channelId: 'channel-2', dispatchId: 'dispatch-3',
      agentId: 'agent-1', status: 'succeeded', createdAt: now, updatedAt: now, artifactIds: [],
    });
    await expect(app.createProjectDocumentBundle({
      ...command, idempotencyKey: 'bundle-foreign-run', workspaceRunId: 'run-foreign',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const listed = await app.listProjectDocumentBundles({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    if (!listed.ok) throw new Error('bundle list failed');
    expect(listed.bundles).toHaveLength(1);
  });

  test('归档频道可读取 Bundle，但拒绝创建新 Bundle', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const later = await deriveDocument({ artifactId: 'artifact-later', filename: 'later.md' });
    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!created.ok) throw new Error('bundle creation failed');

    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });

    const detail = await app.getProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1', bundleId: created.bundle.id,
    });
    expect(detail).toMatchObject({ ok: true, archived: true });

    const listed = await app.listProjectDocumentBundles({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    expect(listed).toMatchObject({ ok: true, archived: true });

    await expect(app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-archived', name: '归档后新建',
      workspaceRunId: 'run-1', documentIds: [later.documentId],
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('权限边界：非频道成员不可读取，普通成员不可创建', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!created.ok) throw new Error('bundle creation failed');

    await expect(app.getProjectDocumentBundle({
      userId: 'outsider-1', teamId: 'team-1', channelId: 'channel-1', bundleId: created.bundle.id,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.listProjectDocumentBundles({
      userId: 'outsider-1', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    // 频道成员可读。
    await expect(app.listProjectDocumentBundles({
      userId: 'member-1', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: true });

    // 但普通成员的 Markdown 编辑权不隐含建包权。
    await expect(app.createProjectDocumentBundle({
      userId: 'member-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-by-member', name: '成员建包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('Bundle 只是投影：它不阻塞成员文档删除，也不阻塞频道删除', async () => {
    // 内存仓储没有外键，这条回归必须走真实 SQLite 才有意义。
    expect(teamDb.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });

    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!created.ok) throw new Error('bundle creation failed');

    // deleteChannel 先删 ChannelDocument、后删 channel 行；成员外键若为 RESTRICT
    // 会在第一步抛 FOREIGN KEY constraint failed，使该频道永久无法删除。
    await expect(app.deleteChannel({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: true });

    expect(teamDb.prepare('SELECT COUNT(*) AS n FROM project_document_bundles').get())
      .toMatchObject({ n: 0 });
    expect(teamDb.prepare('SELECT COUNT(*) AS n FROM project_document_bundle_members').get())
      .toMatchObject({ n: 0 });
    expect(teamDb.prepare('SELECT COUNT(*) AS n FROM project_document_bundle_mutations').get())
      .toMatchObject({ n: 0 });
  });

  test('成员行不阻塞单个 ChannelDocument 的删除（document_id 外键必须 CASCADE）', async () => {
    // deleteByChannel 先删 revisions、后删 documents，initial_revision_id 的 CASCADE 会
    // 先清空成员行，使 document_id 上的约束在那条路径上永远碰不到。这里直接删 document
    // 行来单独钉住它，否则该外键退回 RESTRICT 也不会被任何测试发现。
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!created.ok) throw new Error('bundle creation failed');
    expect(teamDb.prepare('SELECT COUNT(*) AS n FROM project_document_bundle_members').get())
      .toMatchObject({ n: 1 });

    expect(() => teamDb.prepare('DELETE FROM channel_documents WHERE id = ?').run(plan.documentId))
      .not.toThrow();
    expect(teamDb.prepare('SELECT COUNT(*) AS n FROM project_document_bundle_members').get())
      .toMatchObject({ n: 0 });

    // Bundle 本体仍在，详情把已消失的成员投影为 current: null，而不是整体读取失败。
    const detail = await app.getProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1', bundleId: created.bundle.id,
    });
    expect(detail).toMatchObject({ ok: true, bundle: { members: [] } });
  });

  test('内存仓储与 SQLite 的 Bundle 级联语义一致（两套实现不得分叉）', async () => {
    const memory = createInMemoryRepositories();
    const now0 = 1;
    await memory.channels.create({
      id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'c',
      visibility: 'private', createdBy: 'owner-1', humanMemberIds: ['owner-1'],
      agentMemberIds: [], createdAt: now0, updatedAt: now0, archivedAt: null, revision: 1,
    });
    const artifact = {
      id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'agent-1',
      filename: 'plan.md', mimeType: 'text/markdown', sizeBytes: 10, createdAt: now0,
    };
    await memory.channelDocuments.create({
      document: {
        id: 'document-1', teamId: 'team-1', channelId: 'channel-1', filename: 'plan.md',
        currentRevisionId: 'revision-1', createdAt: now0, updatedAt: now0,
      },
      revision: {
        id: 'revision-1', documentId: 'document-1', artifact, revision: 1,
        createdBy: 'owner-1', createdAt: now0, source: 'run', published: false,
      },
    });
    await memory.projectDocumentBundles.create({
      bundle: {
        id: 'bundle-1', teamId: 'team-1', channelId: 'channel-1', name: 'B',
        source: { kind: 'workspace_run', workspaceRunId: 'run-1', agentId: 'agent-1', runCreatedAt: now0 },
        memberCount: 1, createdBy: 'owner-1', createdAt: now0,
      },
      members: [{
        bundleId: 'bundle-1', position: 0, documentId: 'document-1',
        initialRevisionId: 'revision-1', initialRevisionNumber: 1, initialFilename: 'plan.md',
      }],
      mutation: {
        teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'k',
        requestFingerprint: 'f', bundleId: 'bundle-1', createdAt: now0,
      },
    });

    // 删文档：成员行随之消失，绝不阻塞（对齐 SQLite ON DELETE CASCADE）。
    await memory.channelDocuments.deleteByChannel('channel-1');
    await expect(memory.projectDocumentBundles.listMembers({ bundleId: 'bundle-1' }))
      .resolves.toEqual([]);

    // 删频道：Bundle 本体与幂等记录也一并消失。
    await memory.channels.delete({ channelId: 'channel-1' });
    await expect(memory.projectDocumentBundles.list({ teamId: 'team-1', channelId: 'channel-1' }))
      .resolves.toEqual([]);
    await expect(memory.projectDocumentBundles.getMutation({
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'k',
    })).resolves.toBeNull();
  });

  test('客户端提交的 teamId 不能扩大权限：非成员 Team 的写读都被拒', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const created = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'bundle-key-1', name: '发布文档包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!created.ok) throw new Error('bundle creation failed');

    // owner-1 不是 team-2 成员，即便自带 teamId 也不得读取或写入该作用域。
    await repositories.teams.create({
      id: 'team-2', name: '别人的团队', path: 'other-team',
      visibility: 'private', ownerId: 'outsider-1', createdAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-2', userId: 'outsider-1', username: 'outsider', role: 'owner', joinedAt: now,
    });

    await expect(app.listProjectDocumentBundles({
      userId: 'owner-1', teamId: 'team-2', channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.getProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-2', channelId: 'channel-1', bundleId: created.bundle.id,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-2', channelId: 'channel-1',
      idempotencyKey: 'bundle-cross-team', name: '跨 Team 建包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    // 反向：team-2 成员不能读 team-1 频道的 Bundle。
    await expect(app.getProjectDocumentBundle({
      userId: 'outsider-1', teamId: 'team-1', channelId: 'channel-1', bundleId: created.bundle.id,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});
