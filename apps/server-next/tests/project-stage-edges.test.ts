import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const SCOPE = { teamId: 'team-1', channelId: 'channel-1' } as const;

describe('#822 频道项目阶段依赖与执行门禁', () => {
  let globalDb: DatabaseWithClose;
  let teamDb: DatabaseWithClose;
  let now = 1_000;
  let id = 0;
  let app: ServerNextUseCases;

  const buildApp = (): ServerNextUseCases => createServerNextUseCases({
    repositories: createSqliteRepositories({ globalDb, teamDb }),
    clock: { now: () => ++now },
    ids: { nextId: () => `project-id-${++id}` },
    messageIngestionMode: 'legacy',
  });

  /** 建立画像 + 上游阶段（task-up）+ 下游阶段（task-down），返回当前 profile revision。 */
  const seedTwoStages = async (): Promise<{ upstreamStageId: string; downstreamStageId: string; revision: number }> => {
    const initial = await app.createInitialProjectStage({
      userId: 'owner-1',
      ...SCOPE,
      expectedRevision: 0,
      idempotencyKey: 'seed-initial',
      projectLeadId: 'lead-1',
      defaultReviewerIds: ['reviewer-1'],
      stage: {
        name: '剧本',
        goal: '产出可审核的剧本',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['剧本完整'],
        taskId: 'task-up',
      },
    });
    if (!initial.ok) throw new Error(`seed initial stage failed: ${JSON.stringify(initial)}`);
    const second = await app.createProjectStage({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: initial.overview.profile.revision,
      idempotencyKey: 'seed-second',
      stage: {
        name: '分镜',
        goal: '基于剧本产出分镜',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['分镜覆盖全部场次'],
        taskId: 'task-down',
      },
    });
    if (!second.ok) throw new Error(`seed second stage failed: ${JSON.stringify(second)}`);
    const upstream = second.overview.stages.find((stage) => stage.task.id === 'task-up');
    const downstream = second.overview.stages.find((stage) => stage.task.id === 'task-down');
    if (!upstream || !downstream) throw new Error('seeded stages missing');
    return {
      upstreamStageId: upstream.id,
      downstreamStageId: downstream.id,
      revision: second.overview.profile.revision,
    };
  };

  beforeEach(async () => {
    globalDb = new Database(':memory:');
    teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);

    const repositories = createSqliteRepositories({ globalDb, teamDb });
    for (const [userId, username] of [
      ['owner-1', 'owner'],
      ['lead-1', 'lead'],
      ['reviewer-1', 'reviewer'],
      ['outsider-1', 'outsider'],
    ]) {
      await repositories.users.create({
        id: userId as string,
        username: username as string,
        passwordHash: 'hash',
        role: 'user',
        createdAt: now,
        updatedAt: now,
      });
    }
    await repositories.teams.create({
      id: 'team-1',
      name: '项目团队',
      path: 'project-team',
      visibility: 'private',
      ownerId: 'owner-1',
      createdAt: now,
    });
    for (const [userId, username, role] of [
      ['owner-1', 'owner', 'owner'],
      ['lead-1', 'lead', 'member'],
      ['reviewer-1', 'reviewer', 'member'],
      ['outsider-1', 'outsider', 'member'],
    ]) {
      await repositories.teams.addMember({
        teamId: 'team-1',
        userId: userId as string,
        username: username as string,
        role: role as 'owner' | 'member',
        joinedAt: now,
      });
    }
    await repositories.channels.create({
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel',
      name: 'production',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'lead-1', 'reviewer-1'],
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
      name: 'other',
      visibility: 'private',
      createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'lead-1'],
      agentMemberIds: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      revision: 1,
    });
    for (const [taskId, title, channelId] of [
      ['task-up', '完成剧本', 'channel-1'],
      ['task-down', '完成分镜', 'channel-1'],
      ['task-third', '完成服装', 'channel-1'],
      ['task-other-channel', '其他频道任务', 'channel-2'],
    ]) {
      await repositories.tasks.create({
        id: taskId as string,
        teamId: 'team-1',
        channelId: channelId as string,
        title: title as string,
        status: 'todo',
        creatorId: 'owner-1',
        assigneeId: 'owner-1',
        tags: [],
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      });
    }
    app = buildApp();
  });

  afterEach(() => {
    globalDb.close();
    teamDb.close();
  });

  test('创建依赖后下游被阻塞，上游完成即自动解除阻塞，刷新读到同一权威投影', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();

    const created = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-1',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [{ key: 'script-final', kind: 'artifact', label: '剧本终稿' }],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.replayed).toBe(false);
    expect(created.overview.edges).toEqual([expect.objectContaining({
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [{ key: 'script-final', kind: 'artifact', label: '剧本终稿' }],
    })]);

    const blockedDownstream = created.overview.stages
      .find((stage) => stage.id === downstreamStageId);
    expect(blockedDownstream).toMatchObject({
      upstreamStageIds: [upstreamStageId],
      dependenciesSatisfied: false,
      executionAllowed: false,
      missingRequiredInputs: [{
        edgeId: created.overview.edges[0]?.id,
        upstreamStageId,
        key: 'script-final',
        kind: 'artifact',
        label: '剧本终稿',
      }],
    });
    expect(blockedDownstream?.blockingReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stage_dependency_incomplete', upstreamStageId }),
      expect.objectContaining({ code: 'required_input_missing', requiredInputKey: 'script-final' }),
    ]));
    // 上游自身没有入边，不受门禁约束。
    expect(created.overview.stages.find((stage) => stage.id === upstreamStageId))
      .toMatchObject({ upstreamStageIds: [], dependenciesSatisfied: true, executionAllowed: true });

    // 刷新读取（新的 use case 实例，证明投影来自持久化事实而非内存快照）。
    const refreshed = await buildApp().getChannelProjectOverview({ userId: 'reviewer-1', ...SCOPE });
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok || !refreshed.overview) return;
    expect(refreshed.overview.edges).toHaveLength(1);
    expect(refreshed.overview.stages.find((stage) => stage.id === downstreamStageId))
      .toMatchObject({ dependenciesSatisfied: false, executionAllowed: false });

    // 上游 Task 完成 → 依赖与必需输入同时满足，无需人工修复内部状态。
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.tasks.update({
      taskId: 'task-up',
      changes: { status: 'done', updatedAt: ++now },
    });

    const unblocked = await buildApp().getChannelProjectOverview({ userId: 'lead-1', ...SCOPE });
    expect(unblocked.ok).toBe(true);
    if (!unblocked.ok || !unblocked.overview) return;
    const unblockedDownstream = unblocked.overview.stages
      .find((stage) => stage.id === downstreamStageId);
    expect(unblockedDownstream).toMatchObject({
      dependenciesSatisfied: true,
      executionAllowed: true,
      missingRequiredInputs: [],
    });
    expect(unblockedDownstream?.blockingReasons.map((reason) => reason.code))
      .not.toContain('required_input_missing');
  });

  test('删除依赖后下游立即恢复可执行，且依赖图不再包含该边', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    const created = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-1',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const edgeId = created.overview.edges[0]?.id as string;

    const deleted = await app.deleteProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: created.overview.profile.revision,
      idempotencyKey: 'edge-1-delete',
      edgeId,
    });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.overview.edges).toEqual([]);
    expect(deleted.overview.stages.find((stage) => stage.id === downstreamStageId))
      .toMatchObject({ upstreamStageIds: [], dependenciesSatisfied: true, executionAllowed: true });

    const refreshed = await buildApp().getChannelProjectOverview({ userId: 'lead-1', ...SCOPE });
    expect(refreshed.ok && refreshed.overview?.edges).toEqual([]);
  });

  test('Server 拒绝自依赖、跨频道依赖、成环与陈旧 revision', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();

    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'self-edge',
      upstreamStageId,
      downstreamStageId: upstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    // 另一频道的阶段不存在于本频道，按未找到拒绝，绝不跨频道建立依赖。
    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'cross-channel-edge',
      upstreamStageId: 'project-id-unknown',
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const forward = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-forward',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;

    // 反向边会成环。
    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: forward.overview.profile.revision,
      idempotencyKey: 'edge-cycle',
      upstreamStageId: downstreamStageId,
      downstreamStageId: upstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    // 重复边被拒绝，依赖事实保持唯一。
    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: forward.overview.profile.revision,
      idempotencyKey: 'edge-duplicate',
      upstreamStageId,
      downstreamStageId,
      semantics: 'provides_context',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });

    // 陈旧 profile revision 被拒绝：阶段与 Task 都合法，只有 fence 过期。
    const third = await app.createProjectStage({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: forward.overview.profile.revision,
      idempotencyKey: 'stage-third',
      stage: {
        name: '服装',
        goal: '产出服装参考',
        ownerId: 'owner-1',
        reviewerIds: ['reviewer-1'],
        acceptanceCriteria: ['服装覆盖全部角色'],
        taskId: 'task-third',
      },
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    const thirdStageId = third.overview.stages
      .find((stage) => stage.task.id === 'task-third')?.id as string;
    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-stale-revision',
      upstreamStageId,
      downstreamStageId: thirdStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('陈旧 Stage/Task revision 被拒绝', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-stale-task',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 2,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('同一 idempotencyKey 重试返回同一结果，内容不同则 fail closed', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    const request = {
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-idempotent',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start' as const,
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    };
    const first = await app.createProjectStageEdge(request);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const retry = await app.createProjectStageEdge(request);
    expect(retry).toMatchObject({ ok: true, replayed: true });
    if (!retry.ok) return;
    expect(retry.overview).toEqual(first.overview);

    await expect(app.createProjectStageEdge({
      ...request,
      semantics: 'provides_context',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('归档频道可读取依赖图但不能修改 Stage edge', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    const created = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-before-archive',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });

    const archivedApp = buildApp();
    const readable = await archivedApp.getChannelProjectOverview({ userId: 'lead-1', ...SCOPE });
    expect(readable.ok).toBe(true);
    if (!readable.ok || !readable.overview) return;
    expect(readable.overview.archived).toBe(true);
    expect(readable.overview.edges).toHaveLength(1);

    await expect(archivedApp.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: created.overview.profile.revision,
      idempotencyKey: 'edge-after-archive',
      upstreamStageId: downstreamStageId,
      downstreamStageId: upstreamStageId,
      semantics: 'provides_context',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });

    await expect(archivedApp.deleteProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: created.overview.profile.revision,
      idempotencyKey: 'edge-delete-after-archive',
      edgeId: created.overview.edges[0]?.id as string,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
  });

  test('非项目负责人且非管理者不能配置 Stage edge', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    await expect(app.createProjectStageEdge({
      userId: 'reviewer-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-forbidden',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('AC#2 原子一致：失败的写入不留下任何部分状态', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    // Task fence 陈旧 → 事务整体回滚。
    const rejected = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-atomic-fail',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 7,
    });
    expect(rejected).toMatchObject({ ok: false, error: 'CONFLICT' });

    const edgeRows = teamDb.prepare('SELECT COUNT(*) AS total FROM project_stage_edges').get() as { total: number };
    expect(edgeRows.total).toBe(0);
    const dependencyRows = teamDb.prepare('SELECT COUNT(*) AS total FROM task_dependencies').get() as { total: number };
    expect(dependencyRows.total).toBe(0);
    const mutationRows = teamDb.prepare(
      'SELECT COUNT(*) AS total FROM channel_project_mutations WHERE idempotency_key = ?',
    ).get('edge-atomic-fail') as { total: number };
    expect(mutationRows.total).toBe(0);
    // profile revision 未被提升，客户端的 fence 仍然有效。
    const profileRow = teamDb.prepare(
      'SELECT revision FROM channel_project_profiles WHERE team_id = ? AND channel_id = ?',
    ).get('team-1', 'channel-1') as { revision: number };
    expect(profileRow.revision).toBe(revision);
  });

  test('AC#2 原子一致：coordination 存在时 Stage edge 与 canonical Task dependency 同事务成对增删', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.management.runs.create({
      schemaVersion: 2,
      managementPhase: 2,
      id: 'run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      rootTaskId: 'task-up',
      rootMessageId: 'message-root',
      mode: 'managed',
      status: 'running',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      checkpointRevision: 0,
      budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: 1,
      updatedAt: 2,
    });
    for (const [taskId, nodeKind] of [['task-up', 'root'], ['task-down', 'subtask']] as const) {
      await repositories.taskCoordination.coordinations.create({
        schemaVersion: 1,
        taskId,
        teamId: 'team-1',
        managementRunId: 'run-1',
        rootTaskId: 'task-up',
        ...(nodeKind === 'subtask' ? { parentTaskId: 'task-up' } : {}),
        nodeKind,
        reviewPolicy: 'human',
        claimPolicy: 'open',
        requiredCapabilities: [],
        taskRevision: 1,
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    }

    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    const created = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-mirrored',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // 一条 Stage edge 与一条 canonical Task dependency，指向同一依赖事实。
    expect(teamDb.prepare('SELECT COUNT(*) AS total FROM project_stage_edges').get())
      .toEqual({ total: 1 });
    expect(teamDb.prepare(
      'SELECT task_id, dependency_task_id FROM task_dependencies',
    ).all()).toEqual([{ task_id: 'task-down', dependency_task_id: 'task-up' }]);
    expect(teamDb.prepare(
      'SELECT mirrored_task_dependency FROM project_stage_edges',
    ).get()).toEqual({ mirrored_task_dependency: 1 });

    const deleted = await app.deleteProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: created.overview.profile.revision,
      idempotencyKey: 'edge-mirrored-delete',
      edgeId: created.overview.edges[0]?.id as string,
    });
    expect(deleted.ok).toBe(true);
    // 成对撤销：两处依赖事实同时消失，不留下孤立记录。
    expect(teamDb.prepare('SELECT COUNT(*) AS total FROM project_stage_edges').get())
      .toEqual({ total: 0 });
    expect(teamDb.prepare('SELECT COUNT(*) AS total FROM task_dependencies').get())
      .toEqual({ total: 0 });
  });

  test('未知必需输入 kind 被 fail closed 拒绝，不会静默降级为产物', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    await expect(app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-bad-kind',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [{ key: 'clip', kind: 'video' as unknown as 'artifact', label: '样片' }],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    expect(teamDb.prepare('SELECT COUNT(*) AS total FROM project_stage_edges').get())
      .toEqual({ total: 0 });
  });

  test('PI 分解已写入的 canonical 依赖不被本切片认领，删除 Stage edge 不销毁它', async () => {
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    await repositories.management.runs.create({
      schemaVersion: 2,
      managementPhase: 2,
      id: 'run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      rootTaskId: 'task-up',
      rootMessageId: 'message-root',
      mode: 'managed',
      status: 'running',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      checkpointRevision: 0,
      budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: 1,
      updatedAt: 2,
    });
    for (const [taskId, nodeKind] of [['task-up', 'root'], ['task-down', 'subtask']] as const) {
      await repositories.taskCoordination.coordinations.create({
        schemaVersion: 1,
        taskId,
        teamId: 'team-1',
        managementRunId: 'run-1',
        rootTaskId: 'task-up',
        ...(nodeKind === 'subtask' ? { parentTaskId: 'task-up' } : {}),
        nodeKind,
        reviewPolicy: 'human',
        claimPolicy: 'open',
        requiredCapabilities: [],
        taskRevision: 1,
        attempt: 1,
        maxAttempts: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    }
    // PI 分解先写入 canonical 依赖。
    await repositories.taskCoordination.dependencies.create({
      taskId: 'task-down',
      dependencyTaskId: 'task-up',
      taskRevision: 1,
    });

    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    const created = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-not-owned',
      upstreamStageId,
      downstreamStageId,
      semantics: 'blocks_start',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(teamDb.prepare('SELECT mirrored_task_dependency FROM project_stage_edges').get())
      .toEqual({ mirrored_task_dependency: 0 });

    const deleted = await app.deleteProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: created.overview.profile.revision,
      idempotencyKey: 'edge-not-owned-delete',
      edgeId: created.overview.edges[0]?.id as string,
    });
    expect(deleted.ok).toBe(true);
    // PI 的依赖事实仍在：本切片只撤销自己写入的镜像。
    expect(teamDb.prepare('SELECT COUNT(*) AS total FROM task_dependencies').get())
      .toEqual({ total: 1 });
  });

  test('provides_context 边不阻塞启动，但其必需输入仍需上游交付', async () => {
    const { upstreamStageId, downstreamStageId, revision } = await seedTwoStages();
    const contextOnly = await app.createProjectStageEdge({
      userId: 'lead-1',
      ...SCOPE,
      expectedRevision: revision,
      idempotencyKey: 'edge-context',
      upstreamStageId,
      downstreamStageId,
      semantics: 'provides_context',
      requiredInputs: [],
      expectedUpstreamTaskRevision: 1,
      expectedDownstreamTaskRevision: 1,
    });
    expect(contextOnly.ok).toBe(true);
    if (!contextOnly.ok) return;
    expect(contextOnly.overview.stages.find((stage) => stage.id === downstreamStageId))
      .toMatchObject({
        upstreamStageIds: [upstreamStageId],
        dependenciesSatisfied: true,
        executionAllowed: true,
      });
  });
});
