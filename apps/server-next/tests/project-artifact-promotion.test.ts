import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type {
  ProjectArtifactCollectionDto,
  ProjectArtifactLineageRefDto,
  ProjectArtifactVersionDto,
} from '../../../packages/contracts/src/index.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

interface PromoteOverrides {
  idempotencyKey: string;
  artifactId: string;
  stageId?: string;
  collectionId?: string;
  expectedCollectionRevision?: number;
  collection?: { name: string; kind: string };
  lineage?: ProjectArtifactLineageRefDto[];
  sourceInvocationId?: string;
  userId?: string;
}

describe('#823 将现有 Artifact 提升为逻辑产物版本', () => {
  let globalDb: DatabaseWithClose;
  let teamDb: DatabaseWithClose;
  let repositories: ServerNextRepositories;
  let app: ServerNextUseCases;
  const stageIds = new Map<string, string>();
  let now = 100;
  let id = 0;

  const promote = (overrides: PromoteOverrides) => app.promoteArtifactToProjectVersion({
    userId: overrides.userId ?? 'owner-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    idempotencyKey: overrides.idempotencyKey,
    artifactId: overrides.artifactId,
    stageId: overrides.stageId ?? (stageIds.get('channel-1') as string),
    ...(overrides.collectionId
      ? {
        collectionId: overrides.collectionId,
        expectedCollectionRevision: overrides.expectedCollectionRevision,
      }
      : { collection: overrides.collection ?? { name: '分镜脚本', kind: 'storyboard' } }),
    ...(overrides.lineage ? { lineage: overrides.lineage } : {}),
    ...(overrides.sourceInvocationId ? { sourceInvocationId: overrides.sourceInvocationId } : {}),
  });

  const listLibrary = (userId = 'owner-1') => app.listProjectArtifactCollections({
    userId,
    teamId: 'team-1',
    channelId: 'channel-1',
  });

  beforeEach(async () => {
    globalDb = new Database(':memory:');
    teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    repositories = createSqliteRepositories({ globalDb, teamDb });
    stageIds.clear();

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
    await repositories.users.create({
      id: 'member-1',
      username: 'member',
      passwordHash: 'hash',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'member-1',
      username: 'member',
      role: 'member',
      joinedAt: now,
    });
    for (const channelId of ['channel-1', 'channel-2']) {
      await repositories.channels.create({
        id: channelId,
        teamId: 'team-1',
        kind: 'channel',
        name: channelId,
        visibility: 'private',
        createdBy: 'owner-1',
        humanMemberIds: ['owner-1', 'member-1'],
        agentMemberIds: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        revision: 1,
      });
      await repositories.tasks.create({
        id: `task-${channelId}`,
        teamId: 'team-1',
        channelId,
        title: '完成分镜脚本',
        status: 'todo',
        creatorId: 'owner-1',
        assigneeId: 'owner-1',
        tags: [],
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    for (const [artifactId, channelId] of [
      ['artifact-1', 'channel-1'],
      ['artifact-2', 'channel-1'],
      ['artifact-other-channel', 'channel-2'],
    ] as const) {
      await repositories.messages.append({
        id: `message-${artifactId}`,
        teamId: 'team-1',
        channelId,
        senderKind: 'human',
        senderId: 'owner-1',
        body: '交付分镜',
        createdAt: now,
      });
      await repositories.artifacts.create({
        id: artifactId,
        teamId: 'team-1',
        channelId,
        messageId: `message-${artifactId}`,
        uploaderId: 'owner-1',
        filename: `${artifactId}.md`,
        mimeType: 'text/markdown',
        sizeBytes: 128,
        relativePath: `deliverables/${artifactId}.md`,
        pathKind: 'upload',
        role: 'attachment',
        createdAt: now,
      });
    }

    app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-artifact-id-${++id}` },
      messageIngestionMode: 'legacy',
    });
    for (const channelId of ['channel-1', 'channel-2']) {
      const created = await app.createInitialProjectStage({
        userId: 'owner-1',
        teamId: 'team-1',
        channelId,
        expectedRevision: 0,
        idempotencyKey: `initial-stage-${channelId}`,
        projectLeadId: 'owner-1',
        defaultReviewerIds: ['member-1'],
        stage: {
          name: '分镜',
          goal: '形成可审核分镜',
          ownerId: 'owner-1',
          reviewerIds: ['member-1'],
          acceptanceCriteria: ['镜头完整'],
          taskId: `task-${channelId}`,
        },
      });
      if (!created.ok) throw new Error(`Failed to seed project stage for ${channelId}`);
      stageIds.set(channelId, created.overview.stages[0]!.id);
    }
  });

  afterEach(() => {
    globalDb.close();
    teamDb.close();
  });

  test('项目负责人从可见 Artifact 创建集合与首版，来源与 current 指针由 Server 决定', async () => {
    await expect(listLibrary()).resolves.toEqual({
      ok: true,
      library: { collections: [], archived: false },
    });

    const promoted = await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    expect(promoted).toMatchObject({
      ok: true,
      replayed: false,
      collection: {
        teamId: 'team-1',
        channelId: 'channel-1',
        name: '分镜脚本',
        kind: 'storyboard',
        revision: 1,
        createdBy: 'owner-1',
      },
      version: {
        versionNumber: 1,
        artifact: { id: 'artifact-1' },
        source: {
          stageId: stageIds.get('channel-1'),
          taskId: 'task-channel-1',
          taskRevision: 1,
          messageId: 'message-artifact-1',
        },
        lineage: [],
        promotedBy: 'owner-1',
      },
    });
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    expect(collection.currentVersionId).toBe(version.id);
    expect(collection.versions.map((entry) => entry.versionNumber)).toEqual([1]);
    // 未提供来源 Invocation 时不会被凭空补齐。
    expect(version.source.invocationId).toBeUndefined();
  });

  test('向既有集合追加版本时序号递增、current 指针前移、collection revision 前进', async () => {
    const first = await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    const collectionId = successCollection(first).id;
    const firstVersionId = successVersion(first).id;

    const second = await promote({
      idempotencyKey: 'promote-2',
      artifactId: 'artifact-2',
      collectionId,
      expectedCollectionRevision: 1,
      lineage: [{ kind: 'project_version', refId: firstVersionId }],
    });
    expect(second).toMatchObject({
      ok: true,
      replayed: false,
      collection: { id: collectionId, revision: 2 },
      version: {
        versionNumber: 2,
        artifact: { id: 'artifact-2' },
        lineage: [{ kind: 'project_version', refId: firstVersionId }],
      },
    });
    const collection = successCollection(second);
    expect(collection.currentVersionId).toBe(successVersion(second).id);
    expect(collection.versions.map((entry) => entry.versionNumber)).toEqual([1, 2]);
  });

  test('陈旧的 collection revision fence 被拒绝，current 指针不变', async () => {
    const first = await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    const collectionId = successCollection(first).id;

    await expect(promote({
      idempotencyKey: 'promote-stale',
      artifactId: 'artifact-2',
      collectionId,
      expectedCollectionRevision: 99,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });

    await expect(listLibrary()).resolves.toMatchObject({
      ok: true,
      library: {
        collections: [{ revision: 1, currentVersionId: successVersion(first).id, versions: [{ versionNumber: 1 }] }],
      },
    });
  });

  test('同一 Artifact 的重复提升幂等：换 idempotencyKey 也不新增版本', async () => {
    const first = await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    const collectionId = successCollection(first).id;

    const retried = await promote({
      idempotencyKey: 'promote-retry',
      artifactId: 'artifact-1',
      collectionId,
      expectedCollectionRevision: 1,
    });
    expect(retried).toMatchObject({
      ok: true,
      replayed: true,
      version: { id: successVersion(first).id, versionNumber: 1 },
      collection: { id: collectionId, revision: 1 },
    });
    expect(successCollection(retried).versions).toHaveLength(1);
  });

  test('相同 idempotencyKey 重放返回原结果，不同命令 fail closed', async () => {
    const first = await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    await expect(promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' }))
      .resolves.toMatchObject({ ok: true, replayed: true, version: { id: successVersion(first).id } });
    await expect(promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-2' }))
      .resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('同一 Artifact 被指向另一个集合时拒绝，不产生第二个版本', async () => {
    await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    const other = await promote({
      idempotencyKey: 'promote-other-collection',
      artifactId: 'artifact-2',
      collection: { name: '服装设定', kind: 'costume' },
    });
    await expect(promote({
      idempotencyKey: 'promote-conflict',
      artifactId: 'artifact-1',
      collectionId: successCollection(other).id,
      expectedCollectionRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });

    const library = await listLibrary();
    expect(library.ok && library.library.collections.flatMap((collection) => collection.versions)).toHaveLength(2);
  });

  test('集合名称是稳定身份：同名集合被拒绝', async () => {
    await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    await expect(promote({ idempotencyKey: 'promote-2', artifactId: 'artifact-2' }))
      .resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('文件名、目录、mime 与 pathKind 不能替代显式集合声明', async () => {
    await expect(app.promoteArtifactToProjectVersion({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'promote-implicit',
      artifactId: 'artifact-1',
      stageId: stageIds.get('channel-1') as string,
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(listLibrary()).resolves.toEqual({
      ok: true,
      library: { collections: [], archived: false },
    });
  });

  test('跨作用域的 Artifact、Stage 与 lineage 被拒绝', async () => {
    await expect(promote({
      idempotencyKey: 'promote-cross-artifact',
      artifactId: 'artifact-other-channel',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    await expect(promote({
      idempotencyKey: 'promote-cross-stage',
      artifactId: 'artifact-1',
      stageId: stageIds.get('channel-2') as string,
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    await expect(promote({
      idempotencyKey: 'promote-cross-lineage',
      artifactId: 'artifact-1',
      lineage: [{ kind: 'artifact', refId: 'artifact-other-channel' }],
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    await expect(listLibrary()).resolves.toMatchObject({ ok: true, library: { collections: [] } });
  });

  test('运行产物记录 Workspace Run 来源，但 workspace-run 内部日志不可提升', async () => {
    await repositories.workspaceRuns.create({
      id: 'run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      status: 'succeeded',
      createdAt: now,
      updatedAt: now,
      artifactIds: ['artifact-run-log', 'artifact-run-output'],
    });
    await repositories.artifacts.create({
      id: 'artifact-run-log',
      teamId: 'team-1',
      channelId: 'channel-1',
      workspaceRunId: 'run-1',
      uploaderId: 'owner-1',
      filename: 'workspace-run.log',
      mimeType: 'text/plain',
      sizeBytes: 64,
      relativePath: 'logs/workspace-run.log',
      pathKind: 'workspace',
      role: 'intermediate',
      createdAt: now,
    });
    await repositories.artifacts.create({
      id: 'artifact-run-output',
      teamId: 'team-1',
      channelId: 'channel-1',
      workspaceRunId: 'run-1',
      uploaderId: 'owner-1',
      filename: 'storyboard.md',
      mimeType: 'text/markdown',
      sizeBytes: 256,
      relativePath: 'out/storyboard.md',
      pathKind: 'workspace',
      role: 'run_output',
      createdAt: now,
    });

    await expect(promote({
      idempotencyKey: 'promote-run-log',
      artifactId: 'artifact-run-log',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    await expect(promote({
      idempotencyKey: 'promote-run-output',
      artifactId: 'artifact-run-output',
    })).resolves.toMatchObject({
      ok: true,
      version: {
        artifact: { id: 'artifact-run-output' },
        source: { workspaceRunId: 'run-1' },
      },
    });
  });

  test('只有项目负责人或 Team owner/admin 能提升，普通成员与非成员被拒绝', async () => {
    await expect(promote({
      idempotencyKey: 'promote-member',
      artifactId: 'artifact-1',
      userId: 'member-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    await expect(promote({
      idempotencyKey: 'promote-outsider',
      artifactId: 'artifact-1',
      userId: 'outsider-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    // 普通频道成员仍可读取逻辑产物投影。
    await expect(listLibrary('member-1')).resolves.toMatchObject({ ok: true });
  });

  test('归档频道可读取集合与版本，但拒绝提升与新增版本', async () => {
    const first = await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    const collectionId = successCollection(first).id;
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });

    await expect(listLibrary()).resolves.toMatchObject({
      ok: true,
      library: {
        archived: true,
        collections: [{ id: collectionId, versions: [{ versionNumber: 1 }] }],
      },
    });

    await expect(promote({
      idempotencyKey: 'promote-archived',
      artifactId: 'artifact-2',
      collectionId,
      expectedCollectionRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    // 归档前已提交的写入在归档后重试仍然回放原结果。
    await expect(promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' }))
      .resolves.toMatchObject({ ok: true, replayed: true });
  });

  test('陈旧 Task revision 的 Invocation 结果不能污染当前任务', async () => {
    await seedInvocation(repositories, { invocationId: 'invocation-stale', taskRevision: 0 });
    await seedInvocation(repositories, { invocationId: 'invocation-current', taskRevision: 1 });

    await expect(promote({
      idempotencyKey: 'promote-stale-invocation',
      artifactId: 'artifact-1',
      sourceInvocationId: 'invocation-stale',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });

    await expect(promote({
      idempotencyKey: 'promote-current-invocation',
      artifactId: 'artifact-1',
      sourceInvocationId: 'invocation-current',
    })).resolves.toMatchObject({
      ok: true,
      version: { source: { invocationId: 'invocation-current', taskRevision: 1 } },
    });
  });

  test('跨频道 Invocation 不能作为项目产物来源', async () => {
    await seedInvocation(repositories, {
      invocationId: 'invocation-other-channel',
      taskRevision: 1,
      channelId: 'channel-2',
    });
    await expect(promote({
      idempotencyKey: 'promote-cross-invocation',
      artifactId: 'artifact-1',
      sourceInvocationId: 'invocation-other-channel',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  test('提升后普通文件视图不回归：Artifact 仍出现在频道文件库', async () => {
    const listFiles = () => app.listChannelFiles({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      path: 'deliverables',
    });
    const before = await listFiles();
    await promote({ idempotencyKey: 'promote-1', artifactId: 'artifact-1' });
    const after = await listFiles();
    expect(before.ok && after.ok).toBe(true);
    expect(fileIds(after)).toEqual(fileIds(before));
    expect(fileIds(after)).toContain('artifact-1');
  });

  test('内存仓库在原子提交点复核 Artifact 作用域', async () => {
    const memory = createInMemoryRepositories();
    await expect(memory.channelProjects.promoteArtifact({
      teamId: 'team-1',
      channelId: 'channel-1',
      collection: {
        id: 'collection-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        name: '分镜脚本',
        kind: 'storyboard',
        revision: 1,
        currentVersionId: 'version-1',
        versionCount: 1,
        createdBy: 'owner-1',
        createdAt: 1,
        updatedAt: 1,
      },
      createsCollection: true,
      version: {
        id: 'version-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        collectionId: 'collection-1',
        versionNumber: 1,
        artifactId: 'artifact-missing',
        stageId: 'stage-1',
        taskId: 'task-1',
        taskRevision: 1,
        lineage: [],
        promotedBy: 'owner-1',
        createdAt: 1,
      },
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'memory-1',
        requestFingerprint: 'fingerprint-1',
        collectionId: 'collection-1',
        versionId: 'version-1',
        createdAt: 1,
      },
    })).resolves.toEqual({ kind: 'artifact_scope_conflict' });
  });
});

async function seedInvocation(
  repositories: ServerNextRepositories,
  input: { invocationId: string; taskRevision: number; channelId?: string },
): Promise<void> {
  const channelId = input.channelId ?? 'channel-1';
  await repositories.management.runs.create({
    schemaVersion: 1,
    id: `run-${input.invocationId}`,
    teamId: 'team-1',
    channelId,
    rootMessageId: `message-artifact-${channelId === 'channel-1' ? '1' : 'other-channel'}`,
    mode: 'managed',
    status: 'running',
    placementPolicy: {
      placement: 'device',
      allowServerContext: false,
      requireLocalModelCredentials: true,
    },
    checkpointRevision: 0,
    budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
    createdAt: 2,
    updatedAt: 2,
  });
  await repositories.management.invocations.create({
    schemaVersion: 1,
    id: input.invocationId,
    managementRunId: `run-${input.invocationId}`,
    intent: {
      schemaVersion: 1,
      teamId: 'team-1',
      channelId,
      targetAgentId: 'agent-1',
      targetKind: 'custom',
      objective: '产出分镜',
      taskContext: {
        taskId: `task-${channelId}`,
        taskRevision: input.taskRevision,
        taskAttempt: 1,
        claimLeaseId: `lease-${input.invocationId}`,
      },
      acceptanceCriteria: [],
      dependencyResults: [],
      attachmentIds: [],
    },
    intentHash: `hash-${input.invocationId}`,
    idempotencyKey: `invoke-${input.invocationId}`,
    createdAt: 2,
  });
}

function successCollection(result: unknown): ProjectArtifactCollectionDto {
  const typed = result as { ok: boolean; collection?: ProjectArtifactCollectionDto };
  if (!typed.ok || !typed.collection) throw new Error('Expected a successful promotion result');
  return typed.collection;
}

function successVersion(result: unknown): ProjectArtifactVersionDto {
  const typed = result as { ok: boolean; version?: ProjectArtifactVersionDto };
  if (!typed.ok || !typed.version) throw new Error('Expected a successful promotion result');
  return typed.version;
}

function fileIds(result: unknown): string[] {
  const typed = result as { files?: { artifact: { id: string } }[] };
  return (typed.files ?? []).map((entry) => entry.artifact.id);
}
