import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import type {
  ProjectArtifactCollectionDto,
  ProjectArtifactFinalizationDto,
  ProjectArtifactReviewDto,
  ProjectArtifactVersionDto,
  ProjectArtifactReviewDecision,
} from '../../../packages/contracts/src/index.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

type Backend = 'memory' | 'sqlite';

describe.each<Backend>(['memory', 'sqlite'])('#824 人工审核与唯一最终版（%s）', (backend) => {
  let globalDb: DatabaseWithClose | undefined;
  let teamDb: DatabaseWithClose | undefined;
  let repositories: ServerNextRepositories;
  let app: ServerNextUseCases;
  let stageId: string;
  let now: number;
  let id: number;

  beforeEach(async () => {
    now = 100;
    id = 0;
    if (backend === 'sqlite') {
      globalDb = new Database(':memory:');
      teamDb = new Database(':memory:');
      globalDb.exec('PRAGMA foreign_keys = ON;');
      teamDb.exec('PRAGMA foreign_keys = ON;');
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      repositories = createSqliteRepositories({ globalDb, teamDb });
    } else {
      repositories = createInMemoryRepositories();
    }

    for (const [userId, role] of [
      ['owner-1', 'owner'],
      ['reviewer-1', 'member'],
      ['member-1', 'member'],
    ] as const) {
      await repositories.users.create({
        id: userId,
        username: userId,
        passwordHash: 'hash',
        role: 'user',
        createdAt: now,
        updatedAt: now,
      });
      if (userId === 'owner-1') {
        await repositories.teams.create({
          id: 'team-1',
          name: '项目团队',
          path: 'project-team',
          visibility: 'private',
          ownerId: 'owner-1',
          createdAt: now,
        });
      }
      await repositories.teams.addMember({
        teamId: 'team-1',
        userId,
        username: userId,
        role,
        joinedAt: now,
      });
    }
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: '项目频道',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'reviewer-1', 'member-1'],
      agentMemberIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      revision: 1,
    });
    await repositories.tasks.create({
      id: 'task-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      title: '完成分镜脚本',
      status: 'todo',
      creatorId: 'owner-1',
      assigneeId: 'owner-1',
      tags: [],
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    for (const artifactId of ['artifact-1', 'artifact-2']) {
      await repositories.messages.append({
        id: `message-${artifactId}`,
        teamId: 'team-1',
        channelId: 'channel-1',
        senderKind: 'human',
        senderId: 'owner-1',
        body: `交付 ${artifactId}`,
        createdAt: now,
      });
      await repositories.artifacts.create({
        id: artifactId,
        teamId: 'team-1',
        channelId: 'channel-1',
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
      ids: { nextId: () => `artifact-review-id-${++id}` },
      messageIngestionMode: 'legacy',
    });
    const created = await app.createInitialProjectStage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'initial-stage',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '分镜',
        goal: '形成可审核分镜',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['镜头完整'],
        taskId: 'task-1',
      },
    });
    if (!created.ok) throw new Error('Failed to seed project stage');
    stageId = created.overview.stages[0]!.id;
  });

  afterEach(() => {
    globalDb?.close();
    teamDb?.close();
  });

  const promoteFirst = () => app.promoteArtifactToProjectVersion({
    userId: 'owner-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    idempotencyKey: 'promote-1',
    artifactId: 'artifact-1',
    stageId,
    collection: { name: '分镜脚本', kind: 'storyboard' },
  });

  const promoteSecond = (collectionId: string, expectedCollectionRevision: number) =>
    app.promoteArtifactToProjectVersion({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'promote-2',
      artifactId: 'artifact-2',
      stageId,
      collectionId,
      expectedCollectionRevision,
    });

  const review = (input: {
    versionId: string;
    idempotencyKey: string;
    decision?: ProjectArtifactReviewDecision;
    comment?: string;
    userId?: string;
  }) => app.submitArtifactReview({
    userId: input.userId ?? 'owner-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    idempotencyKey: input.idempotencyKey,
    versionId: input.versionId,
    decision: input.decision ?? 'approved',
    comment: input.comment ?? '审核通过',
    basis: [{ kind: 'message', refId: 'message-artifact-1' }],
  });

  const finalize = (input: {
    collectionId: string;
    versionId: string;
    expectedCollectionRevision: number;
    idempotencyKey: string;
    userId?: string;
  }) => app.setArtifactFinalVersion({
    userId: input.userId ?? 'owner-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    collectionId: input.collectionId,
    versionId: input.versionId,
    expectedCollectionRevision: input.expectedCollectionRevision,
    idempotencyKey: input.idempotencyKey,
    reason: '人工确认可交付',
  });

  test('审核成功后版本 reviewState 变为 approved，并保留完整审核记录', async () => {
    const promoted = await promoteFirst();
    const version = successVersion(promoted);
    const reviewed = await review({ versionId: version.id, idempotencyKey: 'review-1' });
    expect(reviewed).toMatchObject({
      ok: true,
      replayed: false,
      review: { decision: 'approved', reviewedBy: 'owner-1' },
      version: {
        id: version.id,
        reviewState: 'approved',
        reviews: [{ decision: 'approved', reviewedBy: 'owner-1' }],
      },
    });
  });

  test('同一 key 重复审核回放；不同 key 的相同决定会追加两条', async () => {
    const version = successVersion(await promoteFirst());
    const first = await review({ versionId: version.id, idempotencyKey: 'review-1' });
    await expect(review({ versionId: version.id, idempotencyKey: 'review-1' }))
      .resolves.toMatchObject({
        ok: true,
        replayed: true,
        review: { id: successReview(first).id },
        version: { reviews: [{ id: successReview(first).id }] },
      });
    const second = await review({ versionId: version.id, idempotencyKey: 'review-2' });
    expect(successVersion(second).reviews).toHaveLength(2);
  });

  test('同一 key 携带不同 fingerprint 时 fail closed', async () => {
    const version = successVersion(await promoteFirst());
    await review({ versionId: version.id, idempotencyKey: 'review-1' });
    await expect(review({
      versionId: version.id,
      idempotencyKey: 'review-1',
      decision: 'rejected',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('审核必须记录非空意见与至少一条可见依据', async () => {
    const version = successVersion(await promoteFirst());
    await expect(app.submitArtifactReview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'review-empty-comment',
      versionId: version.id,
      decision: 'approved',
      comment: '  ',
      basis: [{ kind: 'message', refId: 'message-artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.submitArtifactReview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'review-empty-basis',
      versionId: version.id,
      decision: 'approved',
      comment: '审核通过',
      basis: [],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('归档频道拒绝新审核，但归档前的相同请求仍可回放', async () => {
    const version = successVersion(await promoteFirst());
    await review({ versionId: version.id, idempotencyKey: 'review-before-archive' });
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });
    await expect(review({ versionId: version.id, idempotencyKey: 'review-new' }))
      .resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(review({ versionId: version.id, idempotencyKey: 'review-before-archive' }))
      .resolves.toMatchObject({ ok: true, replayed: true });
  });

  test('非成员与无决定权的普通成员都不能审核', async () => {
    const version = successVersion(await promoteFirst());
    await expect(review({
      versionId: version.id,
      idempotencyKey: 'review-outsider',
      userId: 'outsider-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(review({
      versionId: version.id,
      idempotencyKey: 'review-member',
      userId: 'member-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(review({
      versionId: version.id,
      idempotencyKey: 'review-stage-reviewer',
      userId: 'reviewer-1',
    })).resolves.toMatchObject({ ok: true });
  });

  test('首次最终化设置唯一 finalVersionId 并写入审计', async () => {
    const promoted = await promoteFirst();
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    await review({ versionId: version.id, idempotencyKey: 'review-1' });
    const finalized = await finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-1',
    });
    expect(finalized).toMatchObject({
      ok: true,
      replayed: false,
      collection: {
        id: collection.id,
        revision: 2,
        finalVersionId: version.id,
        finalizations: [{
          versionId: version.id,
          actorKind: 'human',
          finalizedBy: 'owner-1',
        }],
      },
    });
    expect(successFinalization(finalized).previousVersionId).toBeUndefined();
  });

  test('切换最终版只移动集合指针，保留旧版本审核与切换来源', async () => {
    const first = await promoteFirst();
    const collectionId = successCollection(first).id;
    const firstVersion = successVersion(first);
    const second = await promoteSecond(collectionId, 1);
    const secondVersion = successVersion(second);
    await review({ versionId: firstVersion.id, idempotencyKey: 'review-1' });
    await review({ versionId: secondVersion.id, idempotencyKey: 'review-2' });
    await finalize({
      collectionId,
      versionId: firstVersion.id,
      expectedCollectionRevision: 2,
      idempotencyKey: 'finalize-1',
    });
    const switched = await finalize({
      collectionId,
      versionId: secondVersion.id,
      expectedCollectionRevision: 3,
      idempotencyKey: 'finalize-2',
    });
    expect(switched).toMatchObject({
      ok: true,
      collection: {
        revision: 4,
        finalVersionId: secondVersion.id,
        finalizations: [
          { versionId: firstVersion.id },
          { versionId: secondVersion.id, previousVersionId: firstVersion.id },
        ],
        versions: [
          { id: firstVersion.id, reviewState: 'approved' },
          { id: secondVersion.id, reviewState: 'approved' },
        ],
      },
    });
  });

  test('并发切换最终版时 revision fence 只允许一个提交成功', async () => {
    const first = await promoteFirst();
    const collectionId = successCollection(first).id;
    const firstVersion = successVersion(first);
    const secondVersion = successVersion(await promoteSecond(collectionId, 1));
    await review({ versionId: firstVersion.id, idempotencyKey: 'review-concurrent-1' });
    await review({ versionId: secondVersion.id, idempotencyKey: 'review-concurrent-2' });

    const results = await Promise.all([
      finalize({
        collectionId,
        versionId: firstVersion.id,
        expectedCollectionRevision: 2,
        idempotencyKey: 'finalize-concurrent-1',
      }),
      finalize({
        collectionId,
        versionId: secondVersion.id,
        expectedCollectionRevision: 2,
        idempotencyKey: 'finalize-concurrent-2',
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ ok: false, error: 'CONFLICT' }),
    ]);
  });

  test('未审核、最新 rejected 或 changes_requested 的版本不能最终化', async () => {
    const promoted = await promoteFirst();
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    await expect(finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-pending',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await review({
      versionId: version.id,
      idempotencyKey: 'review-rejected',
      decision: 'rejected',
    });
    await expect(finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-rejected',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await review({
      versionId: version.id,
      idempotencyKey: 'review-approved',
      decision: 'approved',
    });
    await review({
      versionId: version.id,
      idempotencyKey: 'review-changes',
      decision: 'changes_requested',
    });
    await expect(finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-changes',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('先 rejected 后 approved 时按最新审核允许最终化', async () => {
    const promoted = await promoteFirst();
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    await review({
      versionId: version.id,
      idempotencyKey: 'review-rejected',
      decision: 'rejected',
    });
    await review({
      versionId: version.id,
      idempotencyKey: 'review-approved',
      decision: 'approved',
    });
    await expect(finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-1',
    })).resolves.toMatchObject({ ok: true, collection: { finalVersionId: version.id } });
  });

  test('产物审核与最终化不建立第二套 Task 状态', async () => {
    const promoted = await promoteFirst();
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    await review({ versionId: version.id, idempotencyKey: 'review-task-state' });
    await finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-task-state',
    });
    await expect(repositories.tasks.getById('task-1')).resolves.toMatchObject({
      id: 'task-1',
      status: 'todo',
    });
  });

  test('陈旧 revision 与无决定权成员的最终化都被拒绝', async () => {
    const promoted = await promoteFirst();
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    await review({ versionId: version.id, idempotencyKey: 'review-1' });
    await expect(finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 99,
      idempotencyKey: 'finalize-stale',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(finalize({
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-member',
      userId: 'member-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('最终化幂等回放不新增审计，同 key 不同目标 fail closed', async () => {
    const first = await promoteFirst();
    const collectionId = successCollection(first).id;
    const firstVersion = successVersion(first);
    const secondVersion = successVersion(await promoteSecond(collectionId, 1));
    await review({ versionId: firstVersion.id, idempotencyKey: 'review-1' });
    await review({ versionId: secondVersion.id, idempotencyKey: 'review-2' });
    await finalize({
      collectionId,
      versionId: firstVersion.id,
      expectedCollectionRevision: 2,
      idempotencyKey: 'finalize-1',
    });
    const replayed = await finalize({
      collectionId,
      versionId: firstVersion.id,
      expectedCollectionRevision: 2,
      idempotencyKey: 'finalize-1',
    });
    expect(replayed).toMatchObject({
      ok: true,
      replayed: true,
      collection: { finalizations: [{ versionId: firstVersion.id }] },
    });
    await expect(finalize({
      collectionId,
      versionId: secondVersion.id,
      expectedCollectionRevision: 3,
      idempotencyKey: 'finalize-1',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('Manager 最终化复验确认消息作者与确认人权限', async () => {
    const promoted = await promoteFirst();
    const collection = successCollection(promoted);
    const version = successVersion(promoted);
    await review({ versionId: version.id, idempotencyKey: 'review-1' });
    await repositories.management.runs.create({
      schemaVersion: 1,
      id: 'management-run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      rootMessageId: 'message-artifact-1',
      initiatedByUserId: 'owner-1',
      mode: 'managed',
      status: 'running',
      placementPolicy: {
        placement: 'device',
        allowServerContext: false,
        requireLocalModelCredentials: true,
      },
      checkpointRevision: 0,
      budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: now,
      updatedAt: now,
    });
    await expect(app.setArtifactFinalVersion({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-manager-invalid',
      manager: {
        managementRunId: 'management-run-1',
        humanConfirmation: {
          kind: 'message',
          refId: 'message-artifact-1',
          confirmedBy: 'member-1',
        },
      },
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    await expect(app.setArtifactFinalVersion({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      collectionId: collection.id,
      versionId: version.id,
      expectedCollectionRevision: 1,
      idempotencyKey: 'finalize-manager-valid',
      manager: {
        managementRunId: 'management-run-1',
        humanConfirmation: {
          kind: 'message',
          refId: 'message-artifact-1',
          confirmedBy: 'owner-1',
        },
      },
    })).resolves.toMatchObject({
      ok: true,
      finalization: {
        actorKind: 'pi_manager',
        finalizedBy: 'owner-1',
        managementRunId: 'management-run-1',
        humanConfirmation: { refId: 'message-artifact-1', confirmedBy: 'owner-1' },
      },
    });
  });
});

function successCollection(result: unknown): ProjectArtifactCollectionDto {
  const typed = result as { ok: boolean; collection?: ProjectArtifactCollectionDto };
  if (!typed.ok || !typed.collection) throw new Error('Expected a successful collection result');
  return typed.collection;
}

function successVersion(result: unknown): ProjectArtifactVersionDto {
  const typed = result as { ok: boolean; version?: ProjectArtifactVersionDto };
  if (!typed.ok || !typed.version) throw new Error('Expected a successful version result');
  return typed.version;
}

function successReview(result: unknown): ProjectArtifactReviewDto {
  const typed = result as { ok: boolean; review?: ProjectArtifactReviewDto };
  if (!typed.ok || !typed.review) throw new Error('Expected a successful review result');
  return typed.review;
}

function successFinalization(result: unknown): ProjectArtifactFinalizationDto {
  const typed = result as { ok: boolean; finalization?: ProjectArtifactFinalizationDto };
  if (!typed.ok || !typed.finalization) throw new Error('Expected a successful finalization result');
  return typed.finalization;
}
