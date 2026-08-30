import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createServerNextUseCases } from '../src/application/usecases.js';

/**
 * 产品决策(2026-08-30):默认频道 #all 与私聊(DM)的聊天/任务/文件处理方式
 * 与普通频道统一(全频道锁项目工作台 + 文件库逻辑产物视图同一 gate)。
 *
 * 修前两类 server 硬拒:
 * - DM 被 5 处 `channel.kind !== 'channel'` 拦住项目写路径(createInitialProjectStage /
 *   prepareProjectStageEdgeMutation / promoteArtifactToProjectVersion / submitArtifactReview /
 *   setArtifactFinalVersion)——前端解锁后「配置首个项目阶段」会报 VALIDATION_ERROR。
 * - #all 被 3 处 `channel.name === 'all'` NOT_FOUND 拦住 Project Channel Workspace——
 *   daemon staging publish 被拒,#all 永远形成不了 OutputPackage。
 *
 * 本测试固化删除硬拒后 #all / DM 与普通频道对称的项目能力(参照 dm-workspace-publish)。
 */
describe('统一频道项目面(产品决策:#all 与 DM 对齐普通频道)', () => {
  const buildApp = () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1 },
      ids: { nextId: () => `id-${Math.random().toString(36).slice(2)}` },
    });
    return { repositories, app };
  };

  test('DM 频道可创建项目画像与后续阶段(修前 createInitialProjectStage/createProjectStage 拒 kind)', async () => {
    const { repositories, app } = buildApp();
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;

    const channelId = 'dm-1';
    await repositories.channels.create({
      id: channelId,
      teamId,
      kind: 'direct',
      name: 'dm-agent',
      visibility: 'private',
      humanMemberIds: [userId],
      agentMemberIds: [],
      createdAt: 1,
    });
    await repositories.tasks.create({
      id: 'dm-task-1',
      teamId,
      channelId,
      title: '私聊任务',
      status: 'todo',
      creatorId: userId,
      assigneeId: userId,
      tags: [],
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await repositories.tasks.create({
      id: 'dm-task-2',
      teamId,
      channelId,
      title: '私聊任务二',
      status: 'todo',
      creatorId: userId,
      assigneeId: userId,
      tags: [],
      sortOrder: 2,
      createdAt: 1,
      updatedAt: 1,
    });

    const initial = await app.createInitialProjectStage({
      userId,
      teamId,
      channelId,
      expectedRevision: 0,
      projectLeadId: userId,
      defaultReviewerIds: [userId],
      idempotencyKey: 'dm-initial',
      stage: {
        name: '阶段一',
        goal: '私聊里推进项目',
        ownerId: userId,
        reviewerIds: [userId],
        acceptanceCriteria: ['交付完整'],
        taskId: 'dm-task-1',
      },
    });
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    expect(initial.overview.stages).toHaveLength(1);

    const second = await app.createProjectStage({
      userId,
      teamId,
      channelId,
      expectedRevision: initial.overview.profile.revision,
      idempotencyKey: 'dm-second',
      stage: {
        name: '阶段二',
        goal: '继续推进',
        ownerId: userId,
        reviewerIds: [userId],
        acceptanceCriteria: ['完成'],
        taskId: 'dm-task-2',
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.overview.stages).toHaveLength(2);
  });

  test('默认频道 #all 可创建项目画像并访问 workspace(修前三处 name===all NOT_FOUND)', async () => {
    const { repositories, app } = buildApp();
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    const all = await repositories.channels.getDefaultChannel(teamId);
    if (!all) throw new Error('default #all channel missing');

    await repositories.tasks.create({
      id: 'all-task-1',
      teamId,
      channelId: all.id,
      title: '默认频道任务',
      status: 'todo',
      creatorId: userId,
      assigneeId: userId,
      tags: [],
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
    });

    // 项目阶段写路径(修前 #all 不拦,这里固化统一行为)。
    const initial = await app.createInitialProjectStage({
      userId,
      teamId,
      channelId: all.id,
      expectedRevision: 0,
      projectLeadId: userId,
      defaultReviewerIds: [userId],
      idempotencyKey: 'all-initial',
      stage: {
        name: '阶段一',
        goal: '默认频道里推进项目',
        ownerId: userId,
        reviewerIds: [userId],
        acceptanceCriteria: ['交付完整'],
        taskId: 'all-task-1',
      },
    });
    expect(initial.ok).toBe(true);

    // Project Channel Workspace(修前三处 access 对 name==='all' 硬拒 NOT_FOUND,
    // 连带 daemon staging publish 被拒 → #all 永远不形成 OutputPackage)。
    await repositories.artifacts.create({
      id: 'all-artifact-1',
      teamId,
      channelId: all.id,
      uploaderId: userId,
      filename: 'note.txt',
      mimeType: 'text/plain',
      sizeBytes: 6,
      pathKind: 'workspace',
      createdAt: 1,
    });
    const created = await app.createProjectChannelWorkspace({
      userId,
      teamId,
      channelId: all.id,
      files: [{ path: 'note.txt', artifactId: 'all-artifact-1' }],
    });
    expect(created.ok).toBe(true);

    const fetched = await app.getProjectChannelWorkspace({ userId, teamId, channelId: all.id });
    expect(fetched.ok).toBe(true);
  });
});
