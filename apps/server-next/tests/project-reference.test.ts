import { createRequire } from 'node:module';
import { beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('#826 冻结项目引用并随消息发送', () => {
  let repositories: ServerNextRepositories;
  let app: ServerNextUseCases;
  let id = 0;
  let now = 1_000;

  beforeEach(async () => {
    repositories = createInMemoryRepositories();
    app = createServerNextUseCases({
      repositories,
      ids: { nextId: () => `reference-id-${++id}` },
      clock: { now: () => ++now },
      messageIngestionMode: 'legacy',
    });
    await repositories.users.create({
      id: 'owner-1',
      username: 'owner',
      passwordHash: 'hash',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.teams.create({
      id: 'team-1',
      name: '项目团队',
      path: 'project-team',
      visibility: 'private',
      ownerId: 'owner-1',
      createdAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'owner-1',
      username: 'owner',
      role: 'owner',
      joinedAt: now,
    });
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'launch',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1'],
      agentMemberIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      revision: 1,
    });
    const artifact = {
      id: 'artifact-doc-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      uploaderId: 'owner-1',
      filename: 'plan.md',
      mimeType: 'text/markdown',
      sizeBytes: 20,
      createdAt: now,
    };
    await repositories.channelDocuments.create({
      document: {
        id: 'document-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        filename: 'plan.md',
        currentRevisionId: 'revision-1',
        createdAt: now,
        updatedAt: now,
      },
      revision: {
        id: 'revision-1',
        documentId: 'document-1',
        artifact,
        revision: 1,
        createdBy: 'owner-1',
        createdAt: now,
        source: 'attachment',
        published: false,
      },
    });
    await repositories.projectDocumentBundles.create({
      bundle: {
        id: 'bundle-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        name: '交付包',
        source: {
          kind: 'workspace_run',
          workspaceRunId: 'run-1',
          agentId: 'agent-1',
          runCreatedAt: now,
        },
        memberCount: 1,
        createdBy: 'owner-1',
        createdAt: now,
      },
      members: [{
        bundleId: 'bundle-1',
        position: 0,
        documentId: 'document-1',
        initialRevisionId: 'revision-1',
        initialRevisionNumber: 1,
        initialFilename: 'plan.md',
      }],
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'bundle-key',
        requestFingerprint: 'bundle-fingerprint',
        bundleId: 'bundle-1',
        createdAt: now,
      },
    });
  });

  test('resolve 整包并按短编号解析唯一焦点', async () => {
    await expect(app.resolveProjectReferences({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      selections: [{ kind: 'bundle_all', bundleId: 'bundle-1' }],
    })).resolves.toMatchObject({
      ok: true,
      selections: [{
        sourceKind: 'bundle_all',
        bundle: { bundleId: 'bundle-1', name: '交付包', memberCount: 1 },
        items: [{ documentId: 'document-1', revisionId: 'revision-1', bundlePosition: 1 }],
      }],
    });
    await expect(app.resolveProjectReferenceOrdinal({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      ordinal: 1,
      focusBundleIds: ['bundle-1'],
    })).resolves.toMatchObject({
      ok: true,
      kind: 'resolved',
      selection: { kind: 'document', documentId: 'document-1' },
    });
  });

  test('发送原子保存引用集；修订及重连后回看仍指向发送时 revision', async () => {
    const sent = await app.sendMessage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '请按计划执行',
      clientMessageId: 'client-message-1',
      selections: [{
        kind: 'document',
        documentId: 'document-1',
        expectedRevisionId: 'revision-1',
      }],
    });
    expect(sent).toMatchObject({
      ok: true,
      referenceSet: {
        contractVersion: 1,
        selections: [{
          sourceKind: 'document',
          items: [{ documentId: 'document-1', revisionId: 'revision-1' }],
        }],
      },
    });
    if (!sent.ok) throw new Error('message send failed');

    const nextArtifact = {
      id: 'artifact-doc-2',
      teamId: 'team-1',
      channelId: 'channel-1',
      uploaderId: 'owner-1',
      filename: 'plan.md',
      mimeType: 'text/markdown',
      sizeBytes: 30,
      createdAt: ++now,
    };
    await repositories.channelDocuments.addRevision({
      documentId: 'document-1',
      expectedCurrentRevisionId: 'revision-1',
      document: {
        id: 'document-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        filename: 'plan.md',
        currentRevisionId: 'revision-2',
        createdAt: now - 1,
        updatedAt: now,
      },
      revision: {
        id: 'revision-2',
        documentId: 'document-1',
        artifact: nextArtifact,
        revision: 2,
        createdBy: 'owner-1',
        createdAt: now,
        source: 'edit',
        published: false,
      },
      artifact: nextArtifact,
      operation: {
        documentId: 'document-1',
        idempotencyKey: 'edit-1',
        operationType: 'save',
        requestFingerprint: 'edit-fingerprint',
        revisionId: 'revision-2',
      },
    });

    const history = await app.listChannelMessages({ channelId: 'channel-1', limit: 20 });
    expect(history).toMatchObject({
      ok: true,
      messages: [{
        id: sent.message.id,
        referenceSet: {
          selections: [{ items: [{ revisionId: 'revision-1', revisionNumber: 1 }] }],
        },
      }],
    });

    const reconnectedApp = createServerNextUseCases({
      repositories,
      ids: { nextId: () => `reconnected-reference-id-${++id}` },
      clock: { now: () => ++now },
      messageIngestionMode: 'legacy',
    });
    await expect(reconnectedApp.listChannelMessages({
      channelId: 'channel-1',
      limit: 20,
    })).resolves.toMatchObject({
      ok: true,
      messages: [{
        id: sent.message.id,
        referenceSet: {
          selections: [{ items: [{ revisionId: 'revision-1', revisionNumber: 1 }] }],
        },
      }],
    });
  });

  test('相同 clientMessageId 重放同一引用集，不创建第二条消息', async () => {
    const command = {
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '引用计划',
      clientMessageId: 'client-message-replay',
      selections: [{ kind: 'document' as const, documentId: 'document-1' }],
    };
    const first = await app.sendMessage(command);
    const replay = await app.sendMessage(command);
    if (!first.ok || !replay.ok) throw new Error('message send failed');
    expect(replay.message.id).toBe(first.message.id);
    expect(replay.referenceSet?.id).toBe(first.referenceSet?.id);
    const messages = await repositories.messages.listByChannel('channel-1', 20);
    expect(messages).toHaveLength(1);
  });

  test('相同 clientMessageId 改变任务语义时 fail closed', async () => {
    const command = {
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '引用计划',
      clientMessageId: 'client-message-conflict',
      selections: [{ kind: 'document' as const, documentId: 'document-1' }],
    };
    await expect(app.sendMessage(command)).resolves.toMatchObject({ ok: true });
    await expect(app.sendMessage({ ...command, asTask: true })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
  });

  test('引用事实提交点复核当前 revision，拒绝预检后的并发修订', async () => {
    await expect(repositories.projectReferenceSets.create({
      set: {
        id: 'set-stale',
        contractVersion: 1,
        teamId: 'team-1',
        channelId: 'channel-1',
        messageId: 'message-stale',
        createdBy: 'owner-1',
        createdAt: now,
        selections: [],
      },
      selections: [{
        id: 'selection-stale',
        referenceSetId: 'set-stale',
        sourceKind: 'document',
        position: 0,
        createdAt: now,
        items: [],
      }],
      items: [{
        id: 'item-stale',
        selectionId: 'selection-stale',
        kind: 'document_revision',
        position: 0,
        documentId: 'document-1',
        revisionId: 'revision-old',
        revisionNumber: 0,
        filename: 'plan.md',
        createdAt: now,
      }],
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'stale-commit',
        requestFingerprint: 'stale-fingerprint',
        referenceSetId: 'set-stale',
        createdAt: now,
      },
    })).resolves.toEqual({ kind: 'reference_fact_conflict' });
  });

  test('陈旧 expected revision 与归档频道均拒绝整条消息', async () => {
    await expect(app.sendMessage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '陈旧引用',
      clientMessageId: 'client-stale',
      selections: [{
        kind: 'document',
        documentId: 'document-1',
        expectedRevisionId: 'revision-old',
      }],
    })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: {
        reason: 'selections_rejected',
        rejections: [{ code: 'revision_stale' }],
      },
    });
    expect(await repositories.messages.listByChannel('channel-1', 20)).toEqual([]);

    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });
    await expect(app.sendMessage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '归档后发送',
      clientMessageId: 'client-archived',
      selections: [{ kind: 'document', documentId: 'document-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });
});

test('#826 SQLite 四表往返保持 Selection 与 item 顺序', async () => {
  const globalDb = new Database(':memory:');
  const teamDb = new Database(':memory:');
  try {
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'launch',
      visibility: 'public',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1'],
      agentMemberIds: [],
      createdAt: 1,
      updatedAt: 1,
      archivedAt: null,
      revision: 1,
    });
    await repositories.messages.append({
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      senderKind: 'human',
      senderId: 'owner-1',
      body: '引用',
      createdAt: 1,
    });
    const documentArtifact = {
      id: 'artifact-document-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      uploaderId: 'owner-1',
      filename: 'plan.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      createdAt: 1,
    };
    await repositories.channelDocuments.create({
      document: {
        id: 'document-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        filename: 'plan.md',
        currentRevisionId: 'revision-3',
        createdAt: 1,
        updatedAt: 1,
      },
      revision: {
        id: 'revision-3',
        documentId: 'document-1',
        artifact: documentArtifact,
        revision: 3,
        createdBy: 'owner-1',
        createdAt: 1,
        source: 'attachment',
        published: false,
      },
    });
    const selection = {
      id: 'selection-1',
      referenceSetId: 'set-1',
      sourceKind: 'document' as const,
      position: 0,
      createdAt: 1,
      items: [],
    };
    const item = {
      id: 'item-1',
      selectionId: selection.id,
      kind: 'document_revision' as const,
      position: 0,
      documentId: 'document-1',
      revisionId: 'revision-3',
      revisionNumber: 3,
      filename: 'plan.md',
      createdAt: 1,
    };
    const result = await repositories.projectReferenceSets.create({
      set: {
        id: 'set-1',
        contractVersion: 1,
        teamId: 'team-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        createdBy: 'owner-1',
        createdAt: 1,
        selections: [],
      },
      selections: [selection],
      items: [item],
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'client-1',
        requestFingerprint: 'fingerprint-1',
        referenceSetId: 'set-1',
        createdAt: 1,
      },
    });
    expect(result.kind).toBe('created');
    await expect(repositories.projectReferenceSets.getByMessageId({
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })).resolves.toMatchObject({
      id: 'set-1',
      selections: [{
        id: 'selection-1',
        items: [{ id: 'item-1', revisionId: 'revision-3', revisionNumber: 3 }],
      }],
    });
    await expect(repositories.projectReferenceSets.create({
      set: {
        id: 'set-other',
        contractVersion: 1,
        teamId: 'team-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        createdBy: 'owner-1',
        createdAt: 2,
        selections: [],
      },
      selections: [],
      items: [],
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'client-1',
        requestFingerprint: 'different',
        referenceSetId: 'set-other',
        createdAt: 2,
      },
    })).resolves.toEqual({ kind: 'idempotency_conflict' });
  } finally {
    globalDb.close();
    teamDb.close();
  }
});
