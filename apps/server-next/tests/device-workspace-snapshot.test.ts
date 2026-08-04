import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('#1043 Server Device workspace snapshot', () => {
  test('current resolves to a concrete artifactVersionId and remains frozen after current moves', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({ repositories, clock: { now: () => 100 }, ids: { nextId: (() => { let n = 0; return () => `id-${++n}`; })() } });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({ userId: registered.user.id, teamId, name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await app.deviceHello({ teamId, ownerId: registered.user.id, machineId: 'machine-1', hostname: 'device-1' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    const discovered = await app.registerDiscoveredAgents({ teamId, deviceId: hello.device.id, agents: [{ name: 'agent', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    if (!discovered.ok) throw new Error(discovered.error);
    const agentId = discovered.agents[0]!.id;
    const member = await app.addChannelAgentMember({ userId: registered.user.id, teamId, channelId: channel.channel.id, agentId });
    if (!member.ok) throw new Error(member.error);
    const task = await repositories.tasks.create({ id: 'task-1', teamId, channelId: channel.channel.id, title: 'task', status: 'todo', creatorId: registered.user.id, assigneeId: registered.user.id, tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
    const stage = await app.createInitialProjectStage({
      userId: registered.user.id, teamId, channelId: channel.channel.id, expectedRevision: 0, idempotencyKey: 'stage-1', projectLeadId: registered.user.id,
      defaultReviewerIds: [registered.user.id], stage: { name: 'stage', goal: 'goal', ownerId: registered.user.id, reviewerIds: [registered.user.id], acceptanceCriteria: ['ok'], taskId: task.id },
    });
    if (!stage.ok) throw new Error(stage.error);
    const stageId = stage.overview.stages[0]!.id;
    const artifact1 = await repositories.artifacts.create({ id: 'artifact-1', teamId, channelId: channel.channel.id, uploaderId: registered.user.id, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: sha256('first'), pathKind: 'upload', role: 'attachment', createdAt: 1 });
    const promoted1 = await app.promoteArtifactToProjectVersion({ userId: registered.user.id, teamId, channelId: channel.channel.id, idempotencyKey: 'promote-1', artifactId: artifact1.id, stageId, collection: { name: 'files', kind: 'bundle' } });
    if (!promoted1.ok) throw new Error(promoted1.error);
    const snapshot = await app.createDeviceWorkspaceSnapshot({
      token: hello.credentials.token, teamId, channelId: channel.channel.id, agentId, taskId: task.id, taskAttempt: 1, workspaceRunId: 'run-1', selections: [{ kind: 'current', collectionId: promoted1.collection.id }],
    });
    expect(snapshot).toMatchObject({ ok: true, snapshot: { immutable: true, inputSet: { items: [{ artifactVersionId: promoted1.version.id, artifactId: 'artifact-1' }] } } });
    if (!snapshot.ok) throw new Error(snapshot.error);
    await expect(app.getDeviceWorkspaceSnapshot({ token: hello.credentials.token, teamId, channelId: channel.channel.id, snapshotId: snapshot.snapshot.id })).resolves.toMatchObject({ ok: true });
    const restarted = createServerNextUseCases({ repositories, clock: { now: () => 101 }, ids: { nextId: (() => { let n = 100; return () => `id-${++n}`; })() } });
    await expect(restarted.getDeviceWorkspaceSnapshot({ token: hello.credentials.token, teamId, channelId: channel.channel.id, snapshotId: snapshot.snapshot.id })).resolves.toMatchObject({ ok: true, snapshot: { id: snapshot.snapshot.id } });
    await expect(app.getArtifactFileForDevice({
      token: hello.credentials.token,
      teamId,
      artifactId: 'artifact-1',
      expectedArtifactVersionId: promoted1.version.id,
    })).resolves.toMatchObject({ ok: true });
    await expect(app.getArtifactFileForDevice({
      token: hello.credentials.token,
      teamId,
      artifactId: 'artifact-1',
      expectedArtifactVersionId: 'version-from-another-snapshot',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const artifact2 = await repositories.artifacts.create({ id: 'artifact-2', teamId, channelId: channel.channel.id, uploaderId: registered.user.id, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 6, sha256: sha256('second'), pathKind: 'upload', role: 'attachment', createdAt: 2 });
    const promoted2 = await app.promoteArtifactToProjectVersion({ userId: registered.user.id, teamId, channelId: channel.channel.id, idempotencyKey: 'promote-2', artifactId: artifact2.id, stageId, collectionId: promoted1.collection.id, expectedCollectionRevision: 1 });
    expect(promoted2).toMatchObject({ ok: true, collection: { currentVersionId: expect.not.stringMatching(promoted1.version.id) } });
    expect(snapshot.snapshot.inputSet.items[0]!.artifactVersionId).toBe(promoted1.version.id);
    const artifact3 = await repositories.artifacts.create({ id: 'artifact-3', teamId, channelId: channel.channel.id, uploaderId: registered.user.id, filename: 'c.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: sha256('third'), pathKind: 'upload', role: 'attachment', createdAt: 3 });
    const promoted3 = await app.promoteArtifactToProjectVersion({ userId: registered.user.id, teamId, channelId: channel.channel.id, idempotencyKey: 'promote-3', artifactId: artifact3.id, stageId, collection: { name: 'other-files', kind: 'bundle' } });
    if (!promoted3.ok) throw new Error(promoted3.error);
    const packageSnapshot = await app.createDeviceWorkspaceSnapshot({
      token: hello.credentials.token, teamId, channelId: channel.channel.id, agentId, taskId: task.id, taskAttempt: 2, workspaceRunId: 'run-package', selections: [{ kind: 'file_package', collectionId: promoted1.collection.id, memberCollectionIds: [promoted1.collection.id, promoted3.collection.id] }],
    });
    expect(packageSnapshot.ok).toBe(true);
    if (!packageSnapshot.ok) throw new Error(packageSnapshot.error);
    expect(packageSnapshot.snapshot.inputSet.items.map((item) => item.artifactId)).toEqual(['artifact-2', 'artifact-3']);
    expect(packageSnapshot.snapshot.inputSet.items.map((item) => item.artifactVersionId)).toEqual([promoted2.version.id, promoted3.version.id]);
    await expect(app.createDeviceWorkspaceSnapshot({
      token: hello.credentials.token, teamId, channelId: channel.channel.id, agentId, taskId: task.id, taskAttempt: 2, workspaceRunId: 'run-2', selections: [{ kind: 'final', collectionId: promoted1.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await repositories.agents.softDelete({ agentId, timestamp: 200 });
    await expect(app.getDeviceWorkspaceSnapshot({ token: hello.credentials.token, teamId, channelId: channel.channel.id, snapshotId: snapshot.snapshot.id })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});

/**
 * #1053：跨 Team 可见 Agent（primary Team A，visibleTeamIds 覆盖 Team B 且是
 * Team B Channel 的 agent member）执行 Team B 的 dispatch 时，snapshot
 * create/get 与 artifact 下载不得再因 primaryTeamId !== targetTeamId 或
 * device token team 不匹配目标 Team 而拒绝；Agent/Device 换绑、visible Team
 * 移除、membership 移除、Channel archive、token 无效继续 fail closed。
 */
describe('#1053 跨 Team 可见 Agent 的 snapshot 授权', () => {
  async function setupCrossTeam() {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({ repositories, clock: { now: () => 100 }, ids: { nextId: (() => { let n = 0; return () => `id-${++n}`; })() } });
    const ownerA = await app.registerUser({ username: 'owner-a', password: 'secret', teamName: 'TeamA' });
    if (!ownerA.ok) throw new Error(ownerA.error);
    const teamA = ownerA.user.primaryTeamId!;
    const ownerB = await app.registerUser({ username: 'owner-b', password: 'secret', teamName: 'TeamB' });
    if (!ownerB.ok) throw new Error(ownerB.error);
    const teamB = ownerB.user.primaryTeamId!;
    const channelB = await app.createChannel({ userId: ownerB.user.id, teamId: teamB, name: 'project', visibility: 'public' });
    if (!channelB.ok) throw new Error(channelB.error);
    const hello = await app.deviceHello({ teamId: teamA, ownerId: ownerA.user.id, machineId: 'machine-1', hostname: 'device-1' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    // 直接 upsert agent：primary Team A，visibleTeamIds 覆盖 Team B（内存 upsert 对
    // 已存在 agent 保留原可见性，新 agent 才取输入值——跨 Team 初始态只能一次造好）。
    const agentId = 'agent-cross-1';
    await repositories.agents.upsert({
      id: agentId, primaryTeamId: teamA, visibleTeamIds: [teamA, teamB],
      name: 'cross-agent', source: 'discovered', category: 'agentos-hosted',
      adapterKind: 'hermes', ownerId: ownerA.user.id, deviceId: hello.device.id,
      status: 'online', lastSeenAt: 1000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    // Team B 的管理者把 Agent 加进目标频道。
    const member = await app.addChannelAgentMember({ userId: ownerB.user.id, teamId: teamB, channelId: channelB.channel.id, agentId });
    if (!member.ok) throw new Error(member.error);
    // Team B 的频道内容：task + stage + 一个 promoted artifact version。
    const task = await repositories.tasks.create({ id: 'task-b1', teamId: teamB, channelId: channelB.channel.id, title: 'task', status: 'todo', creatorId: ownerB.user.id, assigneeId: ownerB.user.id, tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
    const stage = await app.createInitialProjectStage({
      userId: ownerB.user.id, teamId: teamB, channelId: channelB.channel.id, expectedRevision: 0, idempotencyKey: 'stage-b1', projectLeadId: ownerB.user.id,
      defaultReviewerIds: [ownerB.user.id], stage: { name: 'stage', goal: 'goal', ownerId: ownerB.user.id, reviewerIds: [ownerB.user.id], acceptanceCriteria: ['ok'], taskId: task.id },
    });
    if (!stage.ok) throw new Error(stage.error);
    const stageId = stage.overview.stages[0]!.id;
    await repositories.artifacts.create({ id: 'artifact-b1', teamId: teamB, channelId: channelB.channel.id, uploaderId: ownerB.user.id, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: sha256('cross'), pathKind: 'upload', role: 'attachment', createdAt: 1 });
    const promoted = await app.promoteArtifactToProjectVersion({ userId: ownerB.user.id, teamId: teamB, channelId: channelB.channel.id, idempotencyKey: 'promote-b1', artifactId: 'artifact-b1', stageId, collection: { name: 'files', kind: 'bundle' } });
    if (!promoted.ok) throw new Error(promoted.error);
    return {
      repositories, app, ownerA, ownerB, teamA, teamB,
      channelId: channelB.channel.id,
      deviceId: hello.device.id,
      token: hello.credentials.token,
      agentId, taskId: task.id, promoted,
    };
  }

  test('跨 Team 可见 Agent 可以 create/get snapshot 并下载 artifact', async () => {
    const ctx = await setupCrossTeam();
    const { app, token, teamB, channelId, agentId, taskId, promoted } = ctx;
    const created = await app.createDeviceWorkspaceSnapshot({
      token, teamId: teamB, channelId, agentId, taskId, taskAttempt: 3, workspaceRunId: 'run-cross-1',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    });
    expect(created).toMatchObject({ ok: true, snapshot: { teamId: teamB, provenance: { agentId, taskAttempt: 3 } } });
    if (!created.ok) throw new Error(created.error);
    await expect(app.getDeviceWorkspaceSnapshot({ token, teamId: teamB, channelId, snapshotId: created.snapshot.id }))
      .resolves.toMatchObject({ ok: true, snapshot: { id: created.snapshot.id } });
    // #1056：跨 Team 下载按声明的执行 Agent 逐 Agent 授权。
    await expect(app.getArtifactFileForDevice({
      token, teamId: teamB, artifactId: 'artifact-b1', agentId, expectedArtifactVersionId: promoted.version.id,
    })).resolves.toMatchObject({ ok: true });
    // version 不匹配仍 fail closed。
    await expect(app.getArtifactFileForDevice({
      token, teamId: teamB, artifactId: 'artifact-b1', agentId, expectedArtifactVersionId: 'version-not-in-snapshot',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });

  test('Agent 不可见目标 Team 时 create/get/download 均 fail closed', async () => {
    const ctx = await setupCrossTeam();
    const { repositories, app, ownerA, token, teamA, teamB, channelId, taskId, promoted } = ctx;
    // 同一 Device 上的另一个 Agent：可见 Team 不含 Team B（等价于 visible 已被移除）。
    const hiddenAgentId = 'agent-cross-hidden';
    await repositories.agents.upsert({
      id: hiddenAgentId, primaryTeamId: teamA, visibleTeamIds: [teamA],
      name: 'hidden-agent', source: 'discovered', category: 'agentos-hosted',
      adapterKind: 'hermes', ownerId: ownerA.user.id, deviceId: ctx.deviceId,
      status: 'online', lastSeenAt: 1000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await expect(app.createDeviceWorkspaceSnapshot({
      token, teamId: teamB, channelId, agentId: hiddenAgentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-3',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    // 已授权 Agent 的既有 snapshot：Agent 被软删（visible 清空）后 get 实时复验 fail closed。
    const created = await app.createDeviceWorkspaceSnapshot({
      token, teamId: teamB, channelId, agentId: ctx.agentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-2',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    });
    if (!created.ok) throw new Error(created.error);
    await repositories.agents.softDelete({ agentId: ctx.agentId, timestamp: 200 });
    await expect(app.getDeviceWorkspaceSnapshot({ token, teamId: teamB, channelId, snapshotId: created.snapshot.id }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.getArtifactFileForDevice({ token, teamId: teamB, artifactId: 'artifact-b1', agentId: ctx.agentId }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('Channel membership 移除后 fail closed', async () => {
    const ctx = await setupCrossTeam();
    const { app, ownerB, token, teamB, channelId, agentId, taskId, promoted } = ctx;
    const removed = await app.removeChannelAgentMember({ userId: ownerB.user.id, teamId: teamB, channelId, agentId });
    if (!removed.ok) throw new Error(removed.error);
    await expect(app.createDeviceWorkspaceSnapshot({
      token, teamId: teamB, channelId, agentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-4',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.getArtifactFileForDevice({ token, teamId: teamB, artifactId: 'artifact-b1', agentId }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('Channel archive 后 create/get fail closed', async () => {
    const ctx = await setupCrossTeam();
    const { repositories, app, token, teamB, channelId, agentId, taskId, promoted } = ctx;
    const created = await app.createDeviceWorkspaceSnapshot({
      token, teamId: teamB, channelId, agentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-5',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    });
    if (!created.ok) throw new Error(created.error);
    await repositories.channels.update({ channelId, changes: { archivedAt: 200, updatedAt: 200 } });
    await expect(app.createDeviceWorkspaceSnapshot({
      token, teamId: teamB, channelId, agentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-6',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.getDeviceWorkspaceSnapshot({ token, teamId: teamB, channelId, snapshotId: created.snapshot.id }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('Agent/Device 换绑与无效 token fail closed', async () => {
    const ctx = await setupCrossTeam();
    const { app, ownerA, teamA, token, teamB, channelId, agentId, taskId, promoted } = ctx;
    // 同一 home Team 的另一台 Device：token 有效但未绑定该 Agent。
    const other = await app.deviceHello({ teamId: teamA, ownerId: ownerA.user.id, machineId: 'machine-2', hostname: 'device-2' });
    if (!other.ok || !other.credentials) throw new Error('other device hello failed');
    await expect(app.createDeviceWorkspaceSnapshot({
      token: other.credentials.token, teamId: teamB, channelId, agentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-7',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.getArtifactFileForDevice({ token: other.credentials.token, teamId: teamB, artifactId: 'artifact-b1', agentId: ctx.agentId }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    // 无效 token。
    await expect(app.createDeviceWorkspaceSnapshot({
      token: 'abn_device.garbage.sig', teamId: teamB, channelId, agentId, taskId, taskAttempt: 1, workspaceRunId: 'run-cross-8',
      selections: [{ kind: 'current', collectionId: promoted.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    await expect(app.getArtifactFileForDevice({ token: 'abn_device.garbage.sig', teamId: teamB, artifactId: 'artifact-b1' }))
      .resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    // device owner 被移出 home Team 后 token 不再有效（直接打仓储绕过 usecase 的
    // owner 保护，模拟成员关系被管理端移除后的状态）。
    await ctx.repositories.teams.removeMember({ teamId: teamA, userId: ownerA.user.id });
    await expect(app.getArtifactFileForDevice({ token, teamId: teamB, artifactId: 'artifact-b1', agentId: ctx.agentId }))
      .resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});
