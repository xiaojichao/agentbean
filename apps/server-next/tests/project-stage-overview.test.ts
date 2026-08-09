import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases } from '../src/application/usecases.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('频道项目首个 Stage 总览', () => {
  let globalDb: DatabaseWithClose;
  let teamDb: DatabaseWithClose;
  let now = 100;
  let id = 0;

  beforeEach(async () => {
    globalDb = new Database(':memory:');
    teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);

    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.users.create({
      id: 'owner-1',
      username: 'owner',
      passwordHash: 'hash',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.users.create({
      id: 'reviewer-1',
      username: 'reviewer',
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
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'reviewer-1',
      username: 'reviewer',
      role: 'member',
      joinedAt: now,
    });
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'launch',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'reviewer-1'],
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
      title: '完成发布方案',
      description: '准备可审核的发布方案',
      status: 'todo',
      creatorId: 'owner-1',
      assigneeId: 'owner-1',
      tags: [],
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    globalDb.close();
    teamDb.close();
  });

  test('普通频道不预创建画像，首次写入立即返回由 Task 聚合的 Stage 总览', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-id-${++id}` },
      messageIngestionMode: 'legacy',
    });

    await expect(app.getChannelProjectOverview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual({ ok: true, overview: null });

    const created = await app.createInitialProjectStage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'initial-stage-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '发布准备',
        goal: '形成可执行、可审核的发布方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['发布步骤完整', '回滚方案明确'],
        taskId: 'task-1',
      },
    });

    expect(created).toMatchObject({
      ok: true,
      replayed: false,
      overview: {
        profile: {
          teamId: 'team-1',
          channelId: 'channel-1',
          projectLeadId: 'owner-1',
          defaultReviewerIds: ['reviewer-1'],
          revision: 1,
        },
        stages: [{
          teamId: 'team-1',
          channelId: 'channel-1',
          name: '发布准备',
          goal: '形成可执行、可审核的发布方案',
          ownerId: 'owner-1',
          reviewerIds: ['reviewer-1'],
          acceptanceCriteria: ['发布步骤完整', '回滚方案明确'],
          task: {
            id: 'task-1',
            title: '完成发布方案',
            status: 'todo',
          },
          aggregateStatus: 'pending',
          blockingReasons: [{
            code: 'task_not_started',
            taskId: 'task-1',
          }],
          advance: {
            kind: 'waiting',
            reason: 'automation_unavailable',
          },
        }],
      },
    });

    await expect(app.getChannelProjectOverview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toEqual(expect.objectContaining({
      ok: true,
      overview: expect.objectContaining({
        profile: expect.objectContaining({ revision: 1 }),
        stages: [expect.objectContaining({ aggregateStatus: 'pending' })],
      }),
    }));
  });

  test('相同 mutation 重试返回同一结果，篡改幂等键载荷和陈旧 revision 被拒绝', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-id-${++id}` },
      messageIngestionMode: 'legacy',
    });
    const command = {
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'initial-stage-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '发布准备',
        goal: '形成可执行、可审核的发布方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['发布步骤完整'],
        taskId: 'task-1',
      },
    };

    const first = await app.createInitialProjectStage(command);
    expect(first).toMatchObject({ ok: true, replayed: false });
    await expect(app.createInitialProjectStage({
      ...command,
      stage: { ...command.stage, goal: '被篡改的目标' },
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('idempotencyKey'),
    });
    await expect(app.createInitialProjectStage({
      ...command,
      idempotencyKey: 'initial-stage-2',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('revision'),
    });
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });
    const replay = await app.createInitialProjectStage(command);
    expect(replay).toEqual({ ...(first as Extract<typeof first, { ok: true }>), replayed: true });

    await expect(repositories.channelProjects.listStages({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toHaveLength(1);
  });

  test('绑定 Stage 后拒绝移动或删除 Task，项目总览保持可读', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.channels.create({
      id: 'channel-2',
      teamId: 'team-1',
      kind: 'channel',
      name: 'other',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1'],
      agentMemberIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      revision: 1,
    });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-id-${++id}` },
      messageIngestionMode: 'legacy',
    });
    await expect(app.createInitialProjectStage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'initial-stage-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '发布准备',
        goal: '形成发布方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['发布步骤完整'],
        taskId: 'task-1',
      },
    })).resolves.toMatchObject({ ok: true });

    await expect(app.updateTask({
      userId: 'owner-1',
      teamId: 'team-1',
      taskId: 'task-1',
      channelId: 'channel-2',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('Project Stage'),
    });
    await expect(repositories.tasks.update({
      taskId: 'task-1',
      changes: { channelId: 'channel-2', updatedAt: ++now },
    })).rejects.toThrow(/FOREIGN KEY/);
    await expect(app.deleteTask({
      userId: 'owner-1',
      teamId: 'team-1',
      taskId: 'task-1',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('Project Stage'),
    });
    await expect(app.getChannelProjectOverview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      overview: {
        stages: [{ task: { id: 'task-1', channelId: 'channel-1' } }],
      },
    });
  });

  test('Task revision 后旧审核结论不再影响 Stage 聚合', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-id-${++id}` },
      messageIngestionMode: 'legacy',
    });
    await expect(app.createInitialProjectStage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'initial-stage-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '发布准备',
        goal: '形成发布方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['发布步骤完整'],
        taskId: 'task-1',
      },
    })).resolves.toMatchObject({ ok: true });
    await expect(repositories.tasks.updateAtRevision({
      taskId: 'task-1',
      expectedRevision: 1,
      nextRevision: 2,
      reasonCode: 'TASK_REVISED',
      changes: { status: 'in_review', updatedAt: ++now },
    })).resolves.toMatchObject({ revision: 2 });

    repositories.taskCoordination.deliveries.listByTask = async () => [{
      schemaVersion: 1,
      id: 'old-delivery',
      teamId: 'team-1',
      taskId: 'task-1',
      taskRevision: 1,
      taskAttempt: 1,
      claimLeaseId: 'old-claim',
      invocationId: 'old-invocation',
      idempotencyKey: 'old-delivery',
      summary: '旧版本交付',
      claims: [],
      evidenceRefs: [],
      createdAt: now,
    }];
    repositories.taskCoordination.acceptances.getCanonicalByDelivery = async () => ({
      schemaVersion: 1,
      id: 'old-acceptance',
      teamId: 'team-1',
      taskId: 'task-1',
      deliveryId: 'old-delivery',
      expectedTaskRevision: 1,
      taskAttempt: 1,
      claimLeaseId: 'old-claim',
      decision: 'rejected',
      criteriaResults: [],
      reason: '旧版本拒绝',
      decidedBy: 'manager',
      decidedAt: now,
      decisionVersion: 1,
      canonical: true,
    });

    await expect(app.getChannelProjectOverview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      overview: {
        stages: [{
          task: { id: 'task-1', status: 'in_review' },
          aggregateStatus: 'in_review',
          blockingReasons: [{ code: 'review_pending', taskId: 'task-1' }],
        }],
      },
    });
  });

  test('内存仓库使用当前 Task revision 创建 Stage，并在原子提交点拒绝已迁出频道的 Task', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.users.create({
      id: 'owner-1',
      username: 'owner',
      passwordHash: 'hash',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.users.create({
      id: 'reviewer-1',
      username: 'reviewer',
      passwordHash: 'hash',
      role: 'user',
      createdAt: now,
      updatedAt: now,
    });
    await repositories.teams.create({
      id: 'team-1',
      name: '项目团队',
      path: 'project-team-memory',
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
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'reviewer-1',
      username: 'reviewer',
      role: 'member',
      joinedAt: now,
    });
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'launch',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'reviewer-1'],
      agentMemberIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      revision: 1,
    });
    await repositories.channels.create({
      id: 'channel-2',
      teamId: 'team-1',
      kind: 'channel',
      name: 'delivery',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'reviewer-1'],
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
      title: '完成发布方案',
      status: 'todo',
      creatorId: 'owner-1',
      assigneeId: 'owner-1',
      tags: [],
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    await repositories.tasks.create({
      id: 'task-2',
      teamId: 'team-1',
      channelId: 'channel-2',
      title: '完成交付方案',
      status: 'todo',
      creatorId: 'owner-1',
      assigneeId: 'owner-1',
      tags: [],
      sortOrder: 1,
      createdAt: now,
      updatedAt: now,
    });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-id-${++id}` },
      messageIngestionMode: 'legacy',
    });

    await expect(app.createInitialProjectStage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      expectedRevision: 0,
      idempotencyKey: 'memory-success',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '交付准备',
        goal: '形成交付方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['交付步骤完整'],
        taskId: 'task-2',
      },
    })).resolves.toMatchObject({
      ok: true,
      replayed: false,
      overview: {
        stages: [{
          task: { id: 'task-2' },
        }],
      },
    });

    const createInitialStage = repositories.channelProjects.createInitialStage;
    repositories.channelProjects.createInitialStage = async (input) => {
      await repositories.tasks.update({
        taskId: input.stage.taskId,
        changes: { channelId: 'channel-2', updatedAt: ++now },
      });
      return createInitialStage(input);
    };
    await expect(app.createInitialProjectStage({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'memory-race',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '发布准备',
        goal: '形成发布方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['发布步骤完整'],
        taskId: 'task-1',
      },
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('changed scope or revision'),
    });
    await expect(repositories.channelProjects.getProfile({
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toBeNull();
  });

  test('拒绝跨频道或不存在的 Task，归档后总览可读但写入被拒绝', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.channels.create({
      id: 'channel-2',
      teamId: 'team-1',
      kind: 'channel',
      name: 'other',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1'],
      agentMemberIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      revision: 1,
    });
    await repositories.tasks.create({
      id: 'task-2',
      teamId: 'team-1',
      channelId: 'channel-2',
      title: '其他频道任务',
      status: 'todo',
      creatorId: 'owner-1',
      tags: [],
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `project-id-${++id}` },
      messageIngestionMode: 'legacy',
    });
    const command = {
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      expectedRevision: 0,
      idempotencyKey: 'initial-stage-1',
      projectLeadId: 'owner-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '发布准备',
        goal: '形成发布方案',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['发布步骤完整'],
        taskId: 'task-2',
      },
    };

    await expect(app.createInitialProjectStage({
      ...command,
      userId: 'reviewer-1',
      projectLeadId: 'reviewer-1',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.createInitialProjectStage(command)).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    await expect(app.createInitialProjectStage({
      ...command,
      stage: { ...command.stage, taskId: 'missing-task' },
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });

    const created = await app.createInitialProjectStage({
      ...command,
      stage: { ...command.stage, taskId: 'task-1' },
    });
    expect(created).toMatchObject({ ok: true });
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });

    await expect(app.getChannelProjectOverview({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      overview: {
        archived: true,
        stages: [{ task: { id: 'task-1' } }],
      },
    });
    await expect(app.createInitialProjectStage({
      ...command,
      idempotencyKey: 'archived-write',
      stage: { ...command.stage, taskId: 'task-1' },
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('Archived'),
    });
  });
});
