/**
 * #993 Project Channel Workspace 双 Device 端到端契约测试
 *
 * 在 Server usecase seam 上用两套 Device 凭证串联：
 * A 导入 → B 物化 → 原子发布 / 冲突 → 离线与可恢复发布 → 源 Device 删除后成果仍可读。
 * 不依赖真实双机；断言只盯 Ack、revision 清单、冲突结果与权限拒绝。
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';
import type { ServerNextUseCases } from '../src/application/usecases.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

function createIds(values: string[]) {
  let index = 0;
  return () => {
    const id = values[index];
    index += 1;
    if (!id) throw new Error(`ran out of ids at ${index}`);
    return id;
  };
}

type DualDeviceFixture = {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  teamId: string;
  userId: string;
  channelId: string;
  deviceA: { id: string; token: string };
  deviceB: { id: string; token: string };
  agentBId: string;
};

/**
 * 公共 harness：owner + 公开项目频道 + Device A/B + B 上的 Agent。
 * 预分配足够 id，避免 createIds 提前耗尽。
 */
async function seedDualDeviceProject(options?: {
  channelVisibility?: 'public' | 'private';
  extraIds?: string[];
}): Promise<DualDeviceFixture> {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 1_000 },
    ids: {
      nextId: createIds([
        'user-1',
        'team-1',
        'all-1',
        'channel-1',
        'device-a',
        'device-b',
        'agent-b',
        'ws-1',
        'rev-1',
        'rev-2',
        'rev-3',
        'rev-4',
        'art-seed',
        'art-pub',
        'art-conflict',
        // 私有频道 / outsider / staging 后续 nextId 预算
        'channel-private',
        'device-outsider',
        'ws-private',
        'rev-private',
        'agent-lose',
        'stg-art-1',
        'stg-rev-2',
        'stg-rev-3',
        ...(options?.extraIds ?? []),
      ]),
    },
  });

  const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  if (!registered.ok) throw new Error(registered.error);
  const userId = registered.user.id;
  const teamId = registered.user.primaryTeamId!;

  const visibility = options?.channelVisibility ?? 'public';
  const channel = await app.createChannel({
    userId,
    teamId,
    name: 'project',
    visibility,
    ...(visibility === 'private' ? { humanMemberIds: [userId] } : {}),
  });
  if (!channel.ok) throw new Error(channel.error);
  const channelId = channel.channel.id;

  const helloA = await app.deviceHello({
    teamId,
    ownerId: userId,
    machineId: 'machine-a',
    hostname: 'device-a',
  });
  const helloB = await app.deviceHello({
    teamId,
    ownerId: userId,
    machineId: 'machine-b',
    hostname: 'device-b',
  });
  if (!helloA.ok || !helloA.credentials) throw new Error('device A hello failed');
  if (!helloB.ok || !helloB.credentials) throw new Error('device B hello failed');

  const agentsB = await app.registerDiscoveredAgents({
    teamId,
    deviceId: helloB.device.id,
    agents: [{ name: 'Agent-B', adapterKind: 'hermes', category: 'agentos-hosted' }],
  });
  if (!agentsB.ok) throw new Error(agentsB.error);
  const agentBId = agentsB.agents[0]!.id;
  // #1044：publish provenance 的 Agent 必须是频道成员（dispatch/publish authority 一致）。
  const membership = await app.addChannelAgentMember({ userId, teamId, channelId, agentId: agentBId });
  if (!membership.ok) throw new Error(membership.error);

  return {
    repositories,
    app,
    teamId,
    userId,
    channelId,
    deviceA: { id: helloA.device.id, token: helloA.credentials.token },
    deviceB: { id: helloB.device.id, token: helloB.credentials.token },
    agentBId,
  };
}

async function createSeedArtifact(
  repositories: ServerNextRepositories,
  input: { id: string; teamId: string; channelId: string; userId: string; filename: string; sizeBytes?: number },
): Promise<void> {
  await repositories.artifacts.create({
    id: input.id,
    teamId: input.teamId,
    channelId: input.channelId,
    uploaderId: input.userId,
    filename: input.filename,
    mimeType: 'text/plain',
    sizeBytes: input.sizeBytes ?? 16,
    pathKind: 'workspace',
    createdAt: 900,
  });
}

describe('Project Channel Workspace 双 Device 契约 (#993)', () => {
  test('AC1: Device A 导入 → Device B 物化同一 revision；无权方拒绝且不泄露路径', async () => {
    const { repositories, app, teamId, userId, channelId, deviceA, deviceB } = await seedDualDeviceProject();

    await createSeedArtifact(repositories, {
      id: 'art-seed',
      teamId,
      channelId,
      userId,
      filename: 'index.ts',
      sizeBytes: 100,
    });

    // Device A 显式导入 → 完整 revision + 最小 provenance（无绝对路径）
    const imported = await app.importProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId,
      files: [{ path: 'src/index.ts', artifactId: 'art-seed' }],
    });
    expect(imported).toMatchObject({
      ok: true,
      workspace: {
        currentRevision: {
          revision: 1,
          files: [{ path: 'src/index.ts', artifactId: 'art-seed' }],
        },
      },
    });
    if (!imported.ok) throw new Error(imported.error);
    const revisionId = imported.workspace.currentRevision.id;
    const provenance = imported.workspace.currentRevision.provenance;
    expect(provenance).toMatchObject({ kind: 'import', sourceDeviceId: deviceA.id });
    expect(Object.keys(provenance ?? {})).not.toContain('sourcePath');
    expect(Object.keys(provenance ?? {})).not.toContain('absolutePath');

    // Device B 物化同一 revision（不依赖 A 在线）
    const materialized = await app.materializeProjectChannelWorkspace({
      token: deviceB.token,
      teamId,
      channelId,
      revisionId,
    });
    expect(materialized).toMatchObject({
      ok: true,
      workspace: {
        currentRevision: {
          id: revisionId,
          revision: 1,
          files: [{ path: 'src/index.ts', artifactId: 'art-seed' }],
        },
      },
    });

    // 私有频道：非成员 Device 拒绝，错误中不携带路径/文件名
    const privateChannel = await app.createChannel({
      userId,
      teamId,
      name: 'secret-project',
      visibility: 'private',
      humanMemberIds: [userId],
    });
    if (!privateChannel.ok) throw new Error(privateChannel.error);
    const privateCid = privateChannel.channel.id;
    await createSeedArtifact(repositories, {
      id: 'art-private',
      teamId,
      channelId: privateCid,
      userId,
      filename: 'secret.txt',
    });
    // 私有频道成员（owner）的 Device A 可导入
    const privateImport = await app.importProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId: privateCid,
      files: [{ path: 'vault/secret.txt', artifactId: 'art-private' }],
    });
    expect(privateImport.ok).toBe(true);

    // 团队成员但不在私有频道内的 outsider Device → FORBIDDEN，且不泄露路径
    await repositories.users.create({
      id: 'user-outsider',
      username: 'outsider',
      role: 'user',
      passwordHash: 'x',
      createdAt: 1,
      updatedAt: 1,
    });
    await repositories.teams.addMember({
      teamId,
      userId: 'user-outsider',
      username: 'outsider',
      role: 'member',
      joinedAt: 1,
    });
    const helloOutsider = await app.deviceHello({
      teamId,
      ownerId: 'user-outsider',
      machineId: 'machine-outsider',
      hostname: 'outsider-host',
    });
    if (!helloOutsider.ok || !helloOutsider.credentials) throw new Error('outsider device hello failed');

    const denied = await app.materializeProjectChannelWorkspace({
      token: helloOutsider.credentials.token,
      teamId,
      channelId: privateCid,
    });
    expect(denied).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    if (denied.ok) throw new Error('expected FORBIDDEN');
    const deniedJson = JSON.stringify(denied);
    expect(deniedJson).not.toContain('vault/secret.txt');
    expect(deniedJson).not.toContain('secret.txt');
    expect(deniedJson).not.toContain('art-private');
  });

  test('AC2: Device B 基于冻结 baseline 原子发布 → Device A 可读新 revision + publish provenance', async () => {
    const { repositories, app, teamId, userId, channelId, deviceA, deviceB, agentBId } =
      await seedDualDeviceProject();

    await createSeedArtifact(repositories, {
      id: 'art-seed',
      teamId,
      channelId,
      userId,
      filename: 'base.txt',
    });
    await createSeedArtifact(repositories, {
      id: 'art-pub',
      teamId,
      channelId,
      userId,
      filename: 'out.txt',
    });

    const imported = await app.importProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId,
      files: [{ path: 'base.txt', artifactId: 'art-seed' }],
    });
    if (!imported.ok) throw new Error(imported.error);
    const baselineRevisionId = imported.workspace.currentRevision.id;

    // B 先 materialize 固定输入 revision（冻结输入）
    const inputSnap = await app.materializeProjectChannelWorkspace({
      token: deviceB.token,
      teamId,
      channelId,
      revisionId: baselineRevisionId,
    });
    expect(inputSnap).toMatchObject({
      ok: true,
      workspace: { currentRevision: { id: baselineRevisionId, revision: 1 } },
    });

    // B 侧 Agent 原子发布完整变更集（含 provenance）
    const published = await app.publishProjectChannelWorkspace({
      userId,
      teamId,
      channelId,
      baselineRevisionId,
      files: [
        { path: 'base.txt', artifactId: 'art-seed' },
        { path: 'docs/out.txt', artifactId: 'art-pub' },
      ],
      provenance: { agentId: agentBId, taskId: 'task-b-1', taskAttempt: 1 },
    });
    expect(published).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 2 } } });
    if (!published.ok) throw new Error(published.error);
    expect(published.workspace.currentRevision.files.map((f) => f.path).sort()).toEqual([
      'base.txt',
      'docs/out.txt',
    ]);
    expect(published.workspace.currentRevision.provenance).toMatchObject({
      kind: 'publish',
      agentId: agentBId,
      taskId: 'task-b-1',
      taskAttempt: 1,
      baselineRevisionId,
    });
    const publishedRevisionId = published.workspace.currentRevision.id;

    // 只产生一个新 revision：列表应为 [2, 1]
    const history = await app.listProjectChannelWorkspaceRevisions({
      userId,
      teamId,
      channelId,
    });
    expect(history).toMatchObject({ ok: true });
    if (!history.ok) throw new Error(history.error);
    expect(history.revisions.map((r) => r.revision)).toEqual([2, 1]);
    expect(history.revisions.filter((r) => r.revision === 2)).toHaveLength(1);

    // Device A 可读新 revision 与 provenance（跨设备可见成果）
    const seenByA = await app.materializeProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId,
      revisionId: publishedRevisionId,
    });
    expect(seenByA).toMatchObject({
      ok: true,
      workspace: {
        currentRevision: {
          id: publishedRevisionId,
          revision: 2,
          provenance: {
            kind: 'publish',
            agentId: agentBId,
            taskId: 'task-b-1',
            taskAttempt: 1,
            baselineRevisionId,
          },
        },
      },
    });
  });

  test('AC3: 同 baseline 同路径竞争 → 后提交冲突，无部分 revision', async () => {
    const { repositories, app, teamId, userId, channelId, deviceA, agentBId } =
      await seedDualDeviceProject({ extraIds: ['agent-a'] });

    // Device A 上独立 Agent 作为并发 loser 侧 provenance
    const agentsA = await app.registerDiscoveredAgents({
      teamId,
      deviceId: deviceA.id,
      agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    if (!agentsA.ok) throw new Error(agentsA.error);
    const agentAId = agentsA.agents[0]!.id;

    await createSeedArtifact(repositories, {
      id: 'art-seed',
      teamId,
      channelId,
      userId,
      filename: 'shared.txt',
    });
    await createSeedArtifact(repositories, {
      id: 'art-pub',
      teamId,
      channelId,
      userId,
      filename: 'shared-v2.txt',
    });
    await createSeedArtifact(repositories, {
      id: 'art-conflict',
      teamId,
      channelId,
      userId,
      filename: 'shared-v3.txt',
    });

    const imported = await app.importProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId,
      files: [{ path: 'shared.txt', artifactId: 'art-seed' }],
    });
    if (!imported.ok) throw new Error(imported.error);
    const baselineRevisionId = imported.workspace.currentRevision.id;

    // Device B 的 Agent 先基于 baseline 改 shared.txt 并发布成功
    const first = await app.publishProjectChannelWorkspace({
      userId,
      teamId,
      channelId,
      baselineRevisionId,
      files: [{ path: 'shared.txt', artifactId: 'art-pub' }],
      provenance: { agentId: agentBId, taskId: 'task-win', taskAttempt: 1 },
    });
    expect(first).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 2 } } });
    if (!first.ok) throw new Error(first.error);
    const winnerRevisionId = first.workspace.currentRevisionId;

    // Device A 的 Agent 仍用同一 baseline 并发发布 → 冲突
    const conflict = await app.publishProjectChannelWorkspace({
      userId,
      teamId,
      channelId,
      baselineRevisionId,
      files: [{ path: 'shared.txt', artifactId: 'art-conflict' }],
      provenance: { agentId: agentAId, taskId: 'task-lose', taskAttempt: 1 },
    });
    expect(conflict).toMatchObject({ ok: false, error: 'CONFLICT' });
    if (conflict.ok) throw new Error('expected CONFLICT');
    expect(conflict.details).toMatchObject({
      currentRevision: 2,
      conflictingPaths: ['shared.txt'],
    });

    // 无部分 revision：current 仍是 winner；历史只有 1 与 2
    const current = await app.getProjectChannelWorkspace({ userId, teamId, channelId });
    expect(current).toMatchObject({
      ok: true,
      workspace: {
        currentRevisionId: winnerRevisionId,
        currentRevision: { revision: 2, files: [{ path: 'shared.txt', artifactId: 'art-pub' }] },
      },
    });
    const history = await app.listProjectChannelWorkspaceRevisions({ userId, teamId, channelId });
    expect(history).toMatchObject({ ok: true });
    if (!history.ok) throw new Error(history.error);
    expect(history.revisions.map((r) => r.revision).sort()).toEqual([1, 2]);
    expect(history.revisions.some((r) => r.files.some((f) => f.artifactId === 'art-conflict'))).toBe(
      false,
    );
  });

  test('AC4: 源 Device 离线/删除后，已发布成果对有权方仍可读；无权方拒绝', async () => {
    const { repositories, app, teamId, userId, channelId, deviceA, deviceB, agentBId } =
      await seedDualDeviceProject();

    await createSeedArtifact(repositories, {
      id: 'art-seed',
      teamId,
      channelId,
      userId,
      filename: 'base.txt',
    });
    await createSeedArtifact(repositories, {
      id: 'art-pub',
      teamId,
      channelId,
      userId,
      filename: 'shipped.txt',
    });

    const imported = await app.importProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId,
      files: [{ path: 'base.txt', artifactId: 'art-seed' }],
    });
    if (!imported.ok) throw new Error(imported.error);
    const baselineRevisionId = imported.workspace.currentRevision.id;

    const published = await app.publishProjectChannelWorkspace({
      userId,
      teamId,
      channelId,
      baselineRevisionId,
      files: [
        { path: 'base.txt', artifactId: 'art-seed' },
        { path: 'shipped.txt', artifactId: 'art-pub' },
      ],
      provenance: { agentId: agentBId, taskId: 'task-ship', taskAttempt: 1 },
    });
    if (!published.ok) throw new Error(published.error);
    const publishedRevisionId = published.workspace.currentRevision.id;

    // 源 Device A 离线：B 仍可 materialize 已发布 revision（不依赖源在线）
    await app.markDeviceOffline({ deviceId: deviceA.id, timestamp: 2_000 });
    const whileOffline = await app.materializeProjectChannelWorkspace({
      token: deviceB.token,
      teamId,
      channelId,
      revisionId: publishedRevisionId,
    });
    expect(whileOffline).toMatchObject({
      ok: true,
      workspace: {
        currentRevision: {
          id: publishedRevisionId,
          revision: 2,
          files: expect.arrayContaining([
            expect.objectContaining({ path: 'shipped.txt', artifactId: 'art-pub' }),
          ]),
        },
      },
    });

    // 删除源 Device A：成果仍可读
    const deleted = await app.deleteDevice({ userId, deviceId: deviceA.id });
    expect(deleted).toMatchObject({ ok: true });
    expect(await repositories.devices.getById(deviceA.id)).toBeNull();

    const afterDelete = await app.materializeProjectChannelWorkspace({
      token: deviceB.token,
      teamId,
      channelId,
      revisionId: publishedRevisionId,
    });
    expect(afterDelete).toMatchObject({
      ok: true,
      workspace: { currentRevision: { id: publishedRevisionId, revision: 2 } },
    });
    const humanRead = await app.getProjectChannelWorkspace({
      userId,
      teamId,
      channelId,
      revisionId: publishedRevisionId,
    });
    expect(humanRead).toMatchObject({
      ok: true,
      workspace: {
        currentRevision: {
          provenance: { kind: 'publish', agentId: agentBId, taskId: 'task-ship' },
        },
      },
    });

    // 删除后凭证吊销：必须是 UNAUTHENTICATED，不能被「workspace 已存在 → CONFLICT」假阳性掩盖
    await expect(
      app.importProjectChannelWorkspace({
        token: deviceA.token,
        teamId,
        channelId,
        files: [{ path: 'should-not.txt', artifactId: 'art-pub' }],
      }),
    ).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    await expect(
      app.materializeProjectChannelWorkspace({
        token: deviceA.token,
        teamId,
        channelId,
        revisionId: publishedRevisionId,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });

    // 无权 outsider（非团队成员）拒绝
    await repositories.users.create({
      id: 'user-outsider',
      username: 'outsider',
      role: 'user',
      passwordHash: 'x',
      createdAt: 1,
      updatedAt: 1,
    });
    await expect(
      app.getProjectChannelWorkspace({
        userId: 'user-outsider',
        teamId,
        channelId,
      }),
    ).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('AC5: 同一 publishId 续传/幂等 commit；源 Device 离线不阻断；未 commit 不可见', async () => {
    const { repositories, app, teamId, userId, channelId, deviceA, deviceB, agentBId } =
      await seedDualDeviceProject();

    await createSeedArtifact(repositories, {
      id: 'art-seed',
      teamId,
      channelId,
      userId,
      filename: 'base.txt',
    });

    const imported = await app.importProjectChannelWorkspace({
      token: deviceA.token,
      teamId,
      channelId,
      files: [{ path: 'base.txt', artifactId: 'art-seed' }],
    });
    if (!imported.ok) throw new Error(imported.error);
    const baselineRevisionId = imported.workspace.currentRevision.id;

    // 源 A 离线后 B 仍可基于已物化 baseline 走 staging 发布
    await app.markDeviceOffline({ deviceId: deviceA.id, timestamp: 1_500 });
    const materializeB = await app.materializeProjectChannelWorkspace({
      token: deviceB.token,
      teamId,
      channelId,
      revisionId: baselineRevisionId,
    });
    expect(materializeB).toMatchObject({ ok: true });

    const part1 = Buffer.from('hello ');
    const part2 = Buffer.from('world!');
    const full = Buffer.concat([part1, part2]);
    const publishId = 'pub-dual-device-resume-1';

    const begin = await app.beginWorkspacePublishStaging({
      userId,
      teamId,
      channelId,
      publishId,
      baselineRevisionId,
      files: [
        {
          path: 'docs/out.txt',
          filename: 'out.txt',
          mimeType: 'text/plain',
          expectedSizeBytes: full.length,
          expectedSha256: sha256(full),
        },
      ],
      provenance: { agentId: agentBId, taskId: 'task-resume', taskAttempt: 1 },
    });
    expect(begin).toMatchObject({ ok: true, staging: { status: 'open', publishId } });

    const half = await app.putWorkspacePublishStagingFile({
      userId,
      teamId,
      channelId,
      publishId,
      path: 'docs/out.txt',
      offset: 0,
      content: part1,
    });
    expect(half).toMatchObject({
      ok: true,
      staging: { files: [{ receivedBytes: part1.length, complete: false }] },
    });

    // 上传中：频道 revision 仍为 baseline，不含 docs/out.txt
    const mid = await app.getProjectChannelWorkspace({ userId, teamId, channelId });
    expect(mid).toMatchObject({ ok: true });
    if (!mid.ok) throw new Error(mid.error);
    expect(mid.workspace.currentRevision.id).toBe(baselineRevisionId);
    expect(mid.workspace.currentRevision.files.map((f) => f.path)).toEqual(['base.txt']);

    // 续传剩余字节
    const rest = await app.putWorkspacePublishStagingFile({
      userId,
      teamId,
      channelId,
      publishId,
      path: 'docs/out.txt',
      offset: part1.length,
      content: part2,
    });
    expect(rest).toMatchObject({ ok: true, staging: { files: [{ complete: true }] } });

    const commit1 = await app.commitWorkspacePublishStaging({
      userId,
      teamId,
      channelId,
      publishId,
    });
    expect(commit1).toMatchObject({ ok: true });
    if (!commit1.ok) throw new Error(commit1.error);
    expect(commit1.workspace?.currentRevision.revision).toBe(2);
    expect(commit1.workspace?.currentRevision.files.map((f) => f.path).sort()).toEqual([
      'docs/out.txt',
    ]);
    const committedRevisionId = commit1.workspace!.currentRevisionId;

    // 幂等 commit：不重复创建 revision
    const commit2 = await app.commitWorkspacePublishStaging({
      userId,
      teamId,
      channelId,
      publishId,
    });
    expect(commit2).toMatchObject({ ok: true });
    if (!commit2.ok) throw new Error(commit2.error);
    expect(commit2.staging.committedRevisionId).toBe(committedRevisionId);
    expect(commit2.workspace?.currentRevisionId).toBe(committedRevisionId);

    // Device B 可物化已提交 revision
    const seenByB = await app.materializeProjectChannelWorkspace({
      token: deviceB.token,
      teamId,
      channelId,
      revisionId: committedRevisionId,
    });
    expect(seenByB).toMatchObject({
      ok: true,
      workspace: {
        currentRevision: {
          id: committedRevisionId,
          revision: 2,
          files: [{ path: 'docs/out.txt' }],
        },
      },
    });

    const history = await app.listProjectChannelWorkspaceRevisions({ userId, teamId, channelId });
    expect(history).toMatchObject({ ok: true });
    if (!history.ok) throw new Error(history.error);
    expect(history.revisions.map((r) => r.revision)).toEqual([2, 1]);
  });
});
