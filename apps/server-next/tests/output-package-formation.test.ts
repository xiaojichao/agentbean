/**
 * #1060 OutputPackage 成形集成测试(主 seam:memory + SQLite 双后端)。
 *
 * 覆盖:committed publish 在一个业务事务中创建/追加 collection+version 并形成唯一 package
 * (AC1);成员冻结/顺序/短标识/交付版本/provenance(AC2);delivered 投影保留、新文件不并入
 * 旧包(AC3);创建或追加只适用于 collection,package 不可追加,同 delivery replay 收敛(AC4);
 * package 出现不推进 Task(AC6);拒绝不留部分事实、committed revision 保持可恢复(AC7/AC8);
 * 重复 Device 回调/同 key replay 返回同一 receipt(AC9)。
 *
 * Device seam 窄证明:未 commit / commit 失败的开 staging 不进入本流程(由
 * workspace-publish-authority.test.ts 的 commit 权威复验覆盖,此处只断言 committed 才能成形)。
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import {
  createServerNextUseCases,
  type ServerNextUseCases,
} from '../src/application/usecases.js';
import { attemptOutputPackageFormation } from '../src/application/output-package-handler.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface Seed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  userId: string;
  teamId: string;
  channelId: string;
  device: { id: string; token: string };
  agentId: string;
  baselineRevisionId: string;
  close: () => void;
}

const variants: Array<{ name: string; make: () => { repositories: ServerNextRepositories; close: () => void } }> = [
  { name: 'memory', make: () => ({ repositories: createInMemoryRepositories(), close: () => undefined }) },
  {
    name: 'sqlite',
    make: () => {
      const globalDb = new Database(':memory:') as DatabaseWithClose;
      const teamDb = new Database(':memory:') as DatabaseWithClose;
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      return {
        repositories: createSqliteRepositories({ globalDb, teamDb }),
        close: () => {
          globalDb.close();
          teamDb.close();
        },
      };
    },
  },
];

async function seed(variant: (typeof variants)[number]): Promise<Seed> {
  const { repositories, close } = variant.make();
  let now = 100;
  let id = 0;
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `id-${++id}` },
  });
  const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  if (!registered.ok) throw new Error(registered.error);
  const userId = registered.user.id;
  const teamId = registered.user.primaryTeamId!;
  const channel = await app.createChannel({ userId, teamId, name: 'project', visibility: 'public' });
  if (!channel.ok) throw new Error(channel.error);
  const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-a', hostname: 'device-a' });
  if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
  const agents = await app.registerDiscoveredAgents({
    teamId,
    deviceId: hello.device.id,
    agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
  });
  if (!agents.ok) throw new Error(agents.error);
  const agentId = agents.agents[0]!.id;
  const member = await app.addChannelAgentMember({ userId, teamId, channelId: channel.channel.id, agentId });
  if (!member.ok) throw new Error(member.error);
  await repositories.artifacts.create({
    id: 'seed-art', teamId, channelId: channel.channel.id, uploaderId: userId,
    filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
  });
  const workspace = await app.createProjectChannelWorkspace({
    userId, teamId, channelId: channel.channel.id,
    files: [{ path: 'base.txt', artifactId: 'seed-art' }],
  });
  if (!workspace.ok) throw new Error(workspace.error);
  return {
    repositories,
    app,
    userId,
    teamId,
    channelId: channel.channel.id,
    device: { id: hello.device.id, token: hello.credentials.token },
    agentId,
    baselineRevisionId: workspace.workspace.currentRevisionId,
    close,
  };
}

async function currentWorkspaceRevision(seedValue: Seed): Promise<string> {
  const workspace = await seedValue.app.getProjectChannelWorkspace({
    userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
  });
  if (!workspace.ok) throw new Error(workspace.error);
  return workspace.workspace.currentRevisionId;
}

async function commitDelivery(
  seedValue: Seed,
  publishId: string,
  files: Array<{ path: string; body: Buffer }>,
  provenance: { agentId: string; taskId: string; taskAttempt: number; workspaceRunId?: string; deviceId?: string },
) {
  // 每批 delivery 以当前 workspace revision 为基线(与 daemon 实际行为一致:读取最新冻结输入)。
  const baselineRevisionId = await currentWorkspaceRevision(seedValue);
  const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
    token: seedValue.device.token,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    publishId,
    baselineRevisionId,
    files: files.map((file) => ({
      path: file.path,
      filename: file.path.split('/').pop()!,
      mimeType: 'text/plain',
      expectedSizeBytes: file.body.length,
      expectedSha256: sha256(file.body),
    })),
    provenance,
  });
  if (!begin.ok) throw new Error(begin.error);
  for (const file of files) {
    const put = await seedValue.app.putWorkspacePublishStagingFileForDevice({
      token: seedValue.device.token,
      teamId: seedValue.teamId,
      channelId: seedValue.channelId,
      publishId,
      path: file.path,
      offset: 0,
      content: file.body,
    });
    if (!put.ok) throw new Error(put.error);
  }
  const commit = await seedValue.app.commitWorkspacePublishStagingForDevice({
    token: seedValue.device.token,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    publishId,
  });
  if (!commit.ok) throw new Error(commit.error);
  return commit;
}

/** managed Task + coordination 的最小 seed(含 management run FK)。 */
async function seedManagedTask(seedValue: Seed, taskId: string, attempt: number, runId = 'run-1') {
  await seedValue.repositories.management.runs.create({
    schemaVersion: 1,
    id: runId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    rootMessageId: `msg-${runId}`,
    mode: 'managed',
    status: 'running',
    placementPolicy: { placement: 'auto', allowServerContext: false, requireLocalModelCredentials: false },
    checkpointRevision: 0,
    budget: { maxSubtasks: 4, maxDepth: 3, maxExternalInvocations: 8 },
    createdAt: 10,
    updatedAt: 10,
  });
  await seedValue.repositories.tasks.create({
    id: taskId,
    teamId: seedValue.teamId,
    title: 'deliver docs',
    status: 'in_progress',
    creatorId: seedValue.userId,
    channelId: seedValue.channelId,
    tags: [],
    sortOrder: 0,
    createdAt: 10,
    updatedAt: 10,
  });
  await seedValue.repositories.taskCoordination.coordinations.create({
    taskId,
    teamId: seedValue.teamId,
    managementRunId: runId,
    nodeKind: 'subtask',
    reviewPolicy: 'manager',
    claimPolicy: 'open',
    requiredCapabilities: [],
    acceptanceCriteria: [],
    dependencyTaskIds: [],
    attempt,
    maxAttempts: 3,
    taskRevision: 1,
    createdAt: 10,
    updatedAt: 10,
  });
}

for (const variant of variants) {
  describe(`OutputPackage formation (#1060, ${variant.name})`, () => {
    let seedValue: Seed | undefined;
    afterEach(() => {
      seedValue?.close();
      seedValue = undefined;
    });

    test('AC1:committed publish 原子形成 package,含冻结成员与唯一 delivery', async () => {
      seedValue = await seed(variant);
      const body = Buffer.from('delivery-1');
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body }], {
        agentId: seedValue.agentId,
        taskId: 'task-synthetic-1',
        taskAttempt: 1,
        deviceId: seedValue.device.id,
      });

      const byPublish = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId,
        publishId: 'pub-1',
      });
      expect(byPublish).not.toBeNull();
      if (!byPublish) return;
      const { package: record, members } = byPublish;
      expect(record.taskBinding).toBe('unmanaged');
      expect(record.taskAttempt).toBe(1);
      expect(record.taskRevision).toBeUndefined();
      expect(record.workspaceRevisionId).toBeTruthy();
      expect(record.agentId).toBe(seedValue.agentId);
      expect(record.memberCount).toBe(1);
      expect(members).toHaveLength(1);
      const member = members[0]!;
      expect(member.sequence).toBe(1);
      expect(member.shortLabel).toBe('F1');
      expect(member.sourcePath).toBe('docs/ep1.md');
      expect(member.role).toBe('deliverable');
      expect(member.requiredForFinal).toBe(true);
      expect(member.sha256).toBe(sha256(body));

      // 逻辑产物集合与版本已在一个业务事务中创建。
      const collections = await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
      });
      expect(collections).toHaveLength(1);
      expect(collections[0]!.name).toBe('docs/ep1.md');
      expect(collections[0]!.versionCount).toBe(1);
      expect(collections[0]!.currentVersionId).toBe(member.artifactVersionId);
      const versions = await seedValue.repositories.channelProjects.listArtifactVersions({
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
      });
      expect(versions).toHaveLength(1);
      expect(versions[0]!.collectionId).toBe(collections[0]!.id);
      expect(versions[0]!.artifactId).toBeTruthy();
      expect(versions[0]!.sourceWorkspaceRunId).toBeUndefined();
      expect(versions[0]!.taskId).toBe('task-synthetic-1');

      // 三处投影读取同一 Server 事实。
      const get = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: record.packageId,
      });
      expect(get.ok).toBe(true);
      if (!get.ok) return;
      expect(get.package.members).toHaveLength(1);
      expect(get.package.packageId).toBe(record.packageId);
      expect(get.package.workspaceRevisionId).toBe(record.workspaceRevisionId);
      expect(get.package.taskBinding).toBe('unmanaged');
    });

    test('AC1/AC3:后续同路径交付追加 collection 新 version;新路径形成新 package,旧 package 不变', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 1,
      });
      await commitDelivery(seedValue, 'pub-2', [
        { path: 'docs/ep1.md', body: Buffer.from('v2') },
        { path: 'docs/ep2.md', body: Buffer.from('new') },
      ], {
        agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 2,
      });

      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      const pkg2 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-2',
      });
      expect(pkg1).not.toBeNull();
      expect(pkg2).not.toBeNull();
      if (!pkg1 || !pkg2) return;
      // 两个 package 独立;新文件不并入旧包(AC3)。
      expect(pkg1.package.packageId).not.toBe(pkg2.package.packageId);
      expect(pkg1.package.memberCount).toBe(1);
      expect(pkg2.package.memberCount).toBe(2);

      // 同路径 → 同一 collection 两个版本;delivered 版本各自冻结(AC3)。
      const pkg1Members = [...pkg1.members].sort((a, b) => a.sequence - b.sequence);
      const pkg2Members = [...pkg2.members].sort((a, b) => a.sequence - b.sequence);
      expect(pkg1Members[0]!.collectionId).toBe(pkg2Members[0]!.collectionId);
      expect(pkg1Members[0]!.artifactVersionId).not.toBe(pkg2Members[0]!.artifactVersionId);
      const collections = await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      const ep1 = collections.find((c) => c.name === 'docs/ep1.md');
      expect(ep1?.versionCount).toBe(2);
      // 第二版的成员顺序/短标识按交付 manifest 冻结。
      expect(pkg2Members.map((m) => [m.sequence, m.shortLabel, m.sourcePath])).toEqual([
        [1, 'F1', 'docs/ep1.md'],
        [2, 'F2', 'docs/ep2.md'],
      ]);
    });

    test('AC4/AC9:重复 commit 与同 key replay 收敛同一 package,不重复创建', async () => {
      seedValue = await seed(variant);
      const body = Buffer.from('replay-1');
      const provenance = { agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 1 };
      await commitDelivery(seedValue, 'pub-replay', [{ path: 'docs/r.md', body }], provenance);

      const first = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-replay',
      });
      expect(first).not.toBeNull();
      if (!first) return;

      // 重复 Device 回调(commit 幂等短路)→ 同一最终结果,不新建 package。
      const again = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.device.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-replay',
      });
      expect(again.ok).toBe(true);
      const second = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-replay',
      });
      expect(second?.package.packageId).toBe(first.package.packageId);
      const collections = await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(collections).toHaveLength(1);
      expect(collections[0]!.versionCount).toBe(1);

      // 同 key 直接 replay(handler 级,outcome_unknown 收敛路径)→ replayed 同一 package。
      const replay = await attemptOutputPackageFormation(
        {
          repositories: seedValue.repositories,
          clock: { now: () => 9999 },
          ids: { nextId: () => 'should-not-be-used' },
        },
        {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          publishId: 'pub-replay',
          workspaceRevisionId: first.package.workspaceRevisionId,
        },
      );
      expect(replay.kind).toBe('replayed');
      if (replay.kind !== 'replayed') return;
      expect(replay.packageId).toBe(first.package.packageId);
    });

    test('AC6:managed delivery 形成 package 不推进 Task 状态', async () => {
      seedValue = await seed(variant);
      const taskId = 'task-managed-1';
      await seedManagedTask(seedValue, taskId, 1);

      await commitDelivery(seedValue, 'pub-managed', [{ path: 'docs/m.md', body: Buffer.from('m') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const byPublish = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-managed',
      });
      expect(byPublish).not.toBeNull();
      if (!byPublish) return;
      // managed 绑定冻结当前 task revision;无 workspaceRunId 时不绑定 invocation/claim。
      expect(byPublish.package.taskBinding).toBe('managed');
      expect(byPublish.package.taskRevision).toBe(1);
      expect(byPublish.package.invocationId).toBeUndefined();
      expect(byPublish.package.claimLeaseId).toBeUndefined();

      // 关键不变量:package 出现本身不推进 Task(AC6)。
      const task = await seedValue.repositories.tasks.getById(taskId);
      expect(task?.status).toBe('in_progress');
      expect(task?.revision).toBe(1);
    });

    test('AC7/AC8:managed attempt 漂移 → 拒绝,无部分事实,committed revision 保持可恢复,UI 只见 pending', async () => {
      seedValue = await seed(variant);
      const taskId = 'task-attempt-1';
      // coordination.attempt=2(relinquish/retry 后的新 attempt);本次 delivery 声明 attempt=1
      // → commit 本身成功(commit 层不查 attempt),但 formation 被 attempt fence 拒绝。
      await seedManagedTask(seedValue, taskId, 2);
      const commit = await commitDelivery(seedValue, 'pub-attempt', [{ path: 'docs/a.md', body: Buffer.from('a') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const revisionId = commit.workspace.currentRevisionId;

      const result = await attemptOutputPackageFormation(
        {
          repositories: seedValue.repositories,
          clock: { now: () => 9999 },
          ids: { nextId: () => `retry-${Math.random()}` },
        },
        {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          publishId: 'pub-attempt',
          workspaceRevisionId: revisionId,
        },
      );
      expect(result).toMatchObject({ kind: 'rejected', reasonCode: 'task-attempt-superseded' });

      // 无部分 version/package 事实(AC7)。
      const collections = await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(collections).toHaveLength(0);
      const byPublish = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-attempt',
      });
      expect(byPublish).toBeNull();

      // committed revision 保持可恢复事实;查询投影显示 pendingDeliveries(AC8)。
      const list = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.packages).toHaveLength(0);
      expect(list.pendingDeliveries).toHaveLength(1);
      expect(list.pendingDeliveries[0]!.publishId).toBe('pub-attempt');
      expect(list.pendingDeliveries[0]!.workspaceRevisionId).toBe(revisionId);
      expect(list.pendingDeliveries[0]!.taskAttempt).toBe(1);
    });

    test('AC7:Agent 撤权后重复回调收敛既有 package;新 delivery 被 commit 权威复验拒绝,无部分事实', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-revoke', [{ path: 'docs/r.md', body: Buffer.from('r') }], {
        agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 1,
      });
      const before = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-revoke',
      });
      expect(before).not.toBeNull();
      if (!before) return;

      // 撤权后同 key 再跑 handler → replayed(既有 receipt 收敛,不重建、不改写)。
      await seedValue.app.removeChannelAgentMember({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, agentId: seedValue.agentId,
      });
      const replay = await attemptOutputPackageFormation(
        {
          repositories: seedValue.repositories,
          clock: { now: () => 9999 },
          ids: { nextId: () => 'x' },
        },
        {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          publishId: 'pub-revoke',
          workspaceRevisionId: before.package.workspaceRevisionId,
        },
      );
      expect(replay.kind).toBe('replayed');
      const after = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-revoke',
      });
      expect(after?.package.packageId).toBe(before.package.packageId);

      // 撤权后新 delivery:begin fail-fast 权威复验拒绝(既有 #1044 检查),无 staging/package 残留。
      const body = Buffer.from('revoked-2');
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.device.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-revoke-2',
        baselineRevisionId: before.package.workspaceRevisionId,
        files: [{ path: 'docs/r2.md', filename: 'r2.md', mimeType: 'text/plain', expectedSizeBytes: body.length, expectedSha256: sha256(body) }],
        provenance: { agentId: seedValue.agentId, taskId: 'task-synthetic-2', taskAttempt: 1 },
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
      const rejected = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-revoke-2',
      });
      expect(rejected).toBeNull();
      const collections = await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(collections).toHaveLength(1); // 只有首次成功交付的集合,无部分事实。
    });

    test('AC8:formation 成功后 pendingDeliveries 消失,package 列表可见', async () => {
      seedValue = await seed(variant);
      // 手动 staging committed 但不触发 formation:直接 seed staging + revision(等价 formation 失败后的恢复态)。
      const body = Buffer.from('pending');
      await commitDelivery(seedValue, 'pub-pending', [{ path: 'docs/p.md', body }], {
        agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 1,
      });
      const listAfter = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(listAfter.ok).toBe(true);
      if (!listAfter.ok) return;
      // commit 自动 formation 已成功 → 无 pending,有 package。
      expect(listAfter.pendingDeliveries).toHaveLength(0);
      expect(listAfter.packages).toHaveLength(1);
      expect(listAfter.packages[0]!.memberCount).toBe(1);
      expect(listAfter.packages[0]!.publishId).toBe('pub-pending');
    });

    test('原子性:预置同 artifact 版本冲突 → conflict,无 package/members 部分事实', async () => {
      seedValue = await seed(variant);
      // 预置:先把 artifact 提升为逻辑产物版本(模拟人工 promote),再交付同 artifact。
      const body = Buffer.from('atomic');
      await commitDelivery(seedValue, 'pub-atomic', [{ path: 'docs/a.md', body }], {
        agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 1,
      });
      const pkg = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-atomic',
      });
      expect(pkg).not.toBeNull();
      if (!pkg) return;
      const member = pkg.members[0]!;
      const artifactId = (await seedValue.repositories.channelProjects.listArtifactVersions({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      }))[0]!.artifactId;

      // 第二笔交付声明同一个 artifact(不同 version id)→ 仓库自然键复核必须 conflict。
      const otherRevisionId = pkg.package.workspaceRevisionId;
      const conflict = await seedValue.repositories.outputPackages.recordPackageFormation({
        record: {
          teamId: seedValue.teamId,
          packageId: 'pkg-conflict',
          channelId: seedValue.channelId,
          deliveryId: 'del-conflict',
          publishId: 'pub-conflict',
          workspaceRevisionId: otherRevisionId,
          agentId: seedValue.agentId,
          taskId: 'task-synthetic-1',
          taskBinding: 'unmanaged',
          taskAttempt: 1,
          memberCount: 1,
          status: 'recorded',
          createdAt: 2000,
        },
        members: [{
          sequence: 1,
          shortLabel: 'F1',
          role: 'deliverable',
          requiredForFinal: true,
          sourcePath: 'docs/a.md',
          filename: 'a.md',
          sizeBytes: body.length,
          collection: { mode: 'create', collectionId: 'col-conflict', name: 'docs/a.md', kind: 'deliverable' },
          version: {
            id: 'ver-conflict',
            artifactId,
            taskId: 'task-synthetic-1',
            taskRevision: 1,
          },
        }],
        receipt: {
          receiptId: 'rc-conflict',
          teamId: seedValue.teamId,
          commandName: 'record-agent-output-package',
          commandSchemaVersion: 1,
          idempotencyKey: 'record-agent-output-package:ch:pub-conflict',
          commandHash: 'hash-conflict',
          outcome: 'applied',
          committedRevisions: [],
          eventRefs: [],
          commitTime: 2000,
          resultAvailable: true,
          createdAt: 2000,
        },
        tombstone: {
          id: 'tb-conflict',
          teamId: seedValue.teamId,
          commandName: 'record-agent-output-package',
          idempotencyKey: 'record-agent-output-package:ch:pub-conflict',
          commandHash: 'hash-conflict',
          receiptId: 'rc-conflict',
          outcome: 'applied',
          resultAvailable: true,
          createdAt: 2000,
        },
      });
      expect(conflict).toEqual({ kind: 'conflict', reason: 'artifact-version-conflict' });
      // 无部分 package 事实:conflict package 不存在,原 package 未被改写。
      const notFormed = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-conflict',
      });
      expect(notFormed).toBeNull();
      const still = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-atomic',
      });
      expect(still?.package.packageId).toBe(pkg.package.packageId);
      const collections = await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(collections).toHaveLength(1);
      expect(collections[0]!.versionCount).toBe(1);
      expect(member.collectionId).toBe(collections[0]!.id);
    });

    test('AC9:同 key 不同 payload → 无副作用 conflict(ADR-0067 hash 比对)', async () => {
      seedValue = await seed(variant);
      const body = Buffer.from('hash-1');
      const commit = await commitDelivery(seedValue, 'pub-hash', [{ path: 'docs/h.md', body }], {
        agentId: seedValue.agentId, taskId: 'task-synthetic-1', taskAttempt: 1,
      });
      const revisionId = commit.workspace.currentRevisionId;
      const formed = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-hash',
      });
      expect(formed).not.toBeNull();
      if (!formed) return;

      // 同 key(同 channelId+publishId)但 workspaceRevisionId 漂移 → conflict,不 replay。
      const drifted = await attemptOutputPackageFormation(
        {
          repositories: seedValue.repositories,
          clock: { now: () => 9999 },
          ids: { nextId: () => 'noop' },
        },
        {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          publishId: 'pub-hash',
          workspaceRevisionId: 'rev-drifted',
        },
      );
      expect(drifted).toMatchObject({ kind: 'conflict', reasonCode: 'idempotency-key-hash-mismatch' });
      // 无副作用:package 不变,无新消息。
      const still = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-hash',
      });
      expect(still?.package.packageId).toBe(formed.package.packageId);
      expect(revisionId).toBe(formed.package.workspaceRevisionId);
    });

    test('#1111 AC1:讨论串内触发的交付,卡片 threadId 归属该讨论串 root', async () => {
      seedValue = await seed(variant);
      const { repositories, teamId, channelId, userId, agentId } = seedValue;
      // 主线 root(自存根)+ 讨论串内触发消息。
      await repositories.messages.append({
        id: 'root-1', teamId, channelId, threadId: 'root-1',
        senderKind: 'user', senderId: userId, body: '话题:周报告', createdAt: 5,
      });
      await repositories.messages.append({
        id: 'msg-in-thread', teamId, channelId, threadId: 'root-1',
        senderKind: 'user', senderId: userId, body: '@Agent-A 交付一下', createdAt: 6,
      });
      await repositories.dispatches.create({
        id: 'disp-thread', teamId, channelId, messageId: 'msg-in-thread', agentId,
        status: 'succeeded', requestId: 'req-thread', createdAt: 7, updatedAt: 7, prompt: '交付',
      });
      await repositories.workspaceRuns.create({
        id: 'run-thread', teamId, channelId, dispatchId: 'disp-thread', agentId,
        status: 'succeeded', createdAt: 8, updatedAt: 8, artifactIds: [],
      });
      await commitDelivery(seedValue, 'pub-thread', [{ path: 'docs/t1.md', body: Buffer.from('t1') }], {
        agentId, taskId: 'task-synthetic-thread', taskAttempt: 1, workspaceRunId: 'run-thread',
      });
      const byPublish = await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-thread' });
      expect(byPublish).not.toBeNull();
      const card = await repositories.messages.getByClientMessageId({
        teamId, channelId, clientMessageId: `output-package:${byPublish!.package.packageId}`,
      });
      expect(card).not.toBeNull();
      expect(card!.threadId).toBe('root-1');
      // 讨论串读取可见;且卡片不作为主线 root。
      const thread = await repositories.messages.listByThread({ channelId, threadId: 'root-1', limit: 50 });
      expect(thread.some((message) => message.id === card!.id)).toBe(true);
    });

    test('#1111 AC2:主线 root 直接触发的交付,卡片 threadId=该消息 id(进其话题讨论串)', async () => {
      seedValue = await seed(variant);
      const { repositories, teamId, channelId, userId, agentId } = seedValue;
      await repositories.messages.append({
        id: 'msg-root-2', teamId, channelId, threadId: 'msg-root-2',
        senderKind: 'user', senderId: userId, body: '@Agent-A 新话题交付', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: 'disp-root', teamId, channelId, messageId: 'msg-root-2', agentId,
        status: 'succeeded', requestId: 'req-root', createdAt: 7, updatedAt: 7, prompt: '交付',
      });
      await repositories.workspaceRuns.create({
        id: 'run-root', teamId, channelId, dispatchId: 'disp-root', agentId,
        status: 'succeeded', createdAt: 8, updatedAt: 8, artifactIds: [],
      });
      await commitDelivery(seedValue, 'pub-root', [{ path: 'docs/t2.md', body: Buffer.from('t2') }], {
        agentId, taskId: 'task-synthetic-root', taskAttempt: 1, workspaceRunId: 'run-root',
      });
      const byPublish = await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-root' });
      const card = await repositories.messages.getByClientMessageId({
        teamId, channelId, clientMessageId: `output-package:${byPublish!.package.packageId}`,
      });
      expect(card!.threadId).toBe('msg-root-2');
    });

    test('#1111 内嵌:结果回报带 publishId 时,回复消息 meta 携带 outputPackageCard 快照', async () => {
      seedValue = await seed(variant);
      const { repositories, app, teamId, channelId, userId, agentId } = seedValue;
      await repositories.messages.append({
        id: 'msg-inline', teamId, channelId, threadId: 'msg-inline',
        senderKind: 'user', senderId: userId, body: '@Agent-A 交付', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: 'disp-inline', teamId, channelId, messageId: 'msg-inline', agentId,
        status: 'accepted', requestId: 'req-inline', createdAt: 7, updatedAt: 7, prompt: '交付',
      });
      await commitDelivery(seedValue, 'pub-inline', [{ path: 'docs/t6.md', body: Buffer.from('t6') }], {
        agentId, taskId: 'disp-inline', taskAttempt: 1, workspaceRunId: 'disp-inline',
      });
      const result = await app.receiveDispatchResult({
        dispatchId: 'disp-inline',
        agentId,
        body: '搞定！文件已生成。',
        workspaceRun: { status: 'succeeded', publishId: 'pub-inline' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const inline = result.message?.meta?.outputPackageCard as Record<string, unknown> | undefined;
      expect(inline).toBeDefined();
      expect(inline?.kind).toBe('output-package');
      expect(inline?.publishId).toBe('pub-inline');
      expect(inline?.memberCount).toBe(1);
      const members = inline?.members as Array<{ filename: string }>;
      expect(members[0]?.filename).toBe('t6.md');
    });

    test('#1111 生产形态:provenance.workspaceRunId=dispatchId(≠ workspace_runs.id),经 dispatch 兜底解析', async () => {
      seedValue = await seed(variant);
      const { repositories, teamId, channelId, userId, agentId } = seedValue;
      // 生产实证(2026-08-07):daemon 上报 provenance.workspaceRunId === dispatchId === taskId,
      // 而 server 侧 workspace_runs 行有独立 id —— 只按 runId 查会 miss,必须 dispatch 兜底。
      await repositories.messages.append({
        id: 'msg-prod', teamId, channelId, threadId: 'msg-prod',
        senderKind: 'user', senderId: userId, body: '@Agent-A 交付', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: 'disp-prod', teamId, channelId, messageId: 'msg-prod', agentId,
        status: 'succeeded', requestId: 'req-prod', createdAt: 7, updatedAt: 7, prompt: '交付',
      });
      await repositories.workspaceRuns.create({
        id: 'run-server-side-id', teamId, channelId, dispatchId: 'disp-prod', agentId,
        status: 'succeeded', createdAt: 8, updatedAt: 8, artifactIds: [],
      });
      await commitDelivery(seedValue, 'pub-prod', [{ path: 'docs/t4.md', body: Buffer.from('t4') }], {
        agentId, taskId: 'task-synthetic-prod', taskAttempt: 1, workspaceRunId: 'disp-prod',
      });
      const byPublish = await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-prod' });
      const card = await repositories.messages.getByClientMessageId({
        teamId, channelId, clientMessageId: `output-package:${byPublish!.package.packageId}`,
      });
      expect(card).not.toBeNull();
      expect(card!.threadId).toBe('msg-prod');
    });

    test('managed 生产形态:commit 早于 workspace run 落库时仍形成讨论串卡片', async () => {
      seedValue = await seed(variant);
      const { repositories, app, teamId, channelId, userId, agentId } = seedValue;
      const taskId = 'task-managed-alias';
      const managementRunId = 'run-managed-alias';
      const dispatchId = 'dispatch-managed-alias';
      const invocationId = 'invocation-managed-alias';
      const claimLeaseId = 'claim-managed-alias';
      await seedManagedTask(seedValue, taskId, 1, managementRunId);
      await repositories.messages.append({
        id: 'msg-managed-alias', teamId, channelId, threadId: 'msg-managed-alias',
        senderKind: 'user', senderId: userId, body: '请在讨论串交付', createdAt: 5,
      });
      await repositories.taskCoordination.claimLeases.create({
        id: claimLeaseId, teamId, taskId, taskRevision: 1, taskAttempt: 1, agentId,
        leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint', fencingToken: 1,
        status: 'active', acquiredAt: 5, heartbeatAt: 5, expiresAt: 10_000,
      });
      await repositories.management.invocations.create({
        schemaVersion: 1,
        id: invocationId,
        managementRunId,
        intent: {
          schemaVersion: 1, teamId, channelId, targetAgentId: agentId, targetKind: 'custom',
          objective: '请在讨论串交付',
          taskContext: { taskId, rootTaskId: taskId, taskRevision: 1, taskAttempt: 1, claimLeaseId },
          acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
        },
        intentHash: 'intent-hash', idempotencyKey: 'invocation-key', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: dispatchId, teamId, channelId, messageId: 'msg-managed-alias', agentId,
        status: 'succeeded', requestId: `management:${invocationId}:1`, prompt: '请在讨论串交付',
        createdAt: 5, updatedAt: 6, completedAt: 6,
      });
      await repositories.management.dispatchAttempts.create({
        id: 'attempt-managed-alias', invocationId, dispatchId, attemptNumber: 1,
        status: 'succeeded', startedAt: 5, completedAt: 6,
      });

      await commitDelivery(seedValue, 'pub-managed-alias', [{ path: 'docs/managed.md', body: Buffer.from('managed') }], {
        agentId, taskId, taskAttempt: 1, workspaceRunId: dispatchId,
      });
      // 真实 run 尚未落库时不冻结 dispatch alias，等待结果回报阶段补齐 lineage。
      expect(await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-managed-alias' })).toBeNull();
      await repositories.workspaceRuns.create({
        id: 'run-managed-alias-server', teamId, channelId, dispatchId, agentId,
        status: 'succeeded', createdAt: 7, updatedAt: 7, artifactIds: [],
      });
      const replay = await app.receiveDispatchResult({
        dispatchId, agentId, body: '已交付',
        workspaceRun: { id: 'run-managed-alias-server', status: 'succeeded', publishId: 'pub-managed-alias' },
      });
      expect(replay.ok).toBe(true);
      const byPublish = await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-managed-alias' });
      expect(byPublish).not.toBeNull();
      const card = await repositories.messages.getByClientMessageId({
        teamId, channelId, clientMessageId: `output-package:${byPublish!.package.packageId}`,
      });
      expect(card?.threadId).toBe('msg-managed-alias');
    });

    test('managed 生产形态:首次成形被 lineage 时序拒绝时,结果回报会重试并内嵌卡片', async () => {
      seedValue = await seed(variant);
      const { repositories, app, teamId, channelId, userId, agentId } = seedValue;
      const taskId = 'task-managed-retry';
      const managementRunId = 'run-managed-retry';
      const dispatchId = 'dispatch-managed-retry';
      const invocationId = 'invocation-managed-retry';
      const claimLeaseId = 'claim-managed-retry';
      await seedManagedTask(seedValue, taskId, 1, managementRunId);
      await repositories.messages.append({
        id: 'msg-managed-retry', teamId, channelId, threadId: 'msg-managed-retry',
        senderKind: 'user', senderId: userId, body: '请补齐讨论串交付', createdAt: 5,
      });

      // commit 时尚未有 dispatch/invocation 事实,模拟真实的 commit → result 时序。
      await commitDelivery(seedValue, 'pub-managed-retry', [{ path: 'docs/retry.md', body: Buffer.from('retry') }], {
        agentId, taskId, taskAttempt: 1, workspaceRunId: dispatchId,
      });
      expect(await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-managed-retry' })).toBeNull();

      await repositories.taskCoordination.claimLeases.create({
        id: claimLeaseId, teamId, taskId, taskRevision: 1, taskAttempt: 1, agentId,
        leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint', fencingToken: 1,
        status: 'active', acquiredAt: 5, heartbeatAt: 5, expiresAt: 10_000,
      });
      await repositories.management.invocations.create({
        schemaVersion: 1,
        id: invocationId,
        managementRunId,
        intent: {
          schemaVersion: 1, teamId, channelId, targetAgentId: agentId, targetKind: 'custom',
          objective: '请补齐讨论串交付',
          taskContext: { taskId, rootTaskId: taskId, taskRevision: 1, taskAttempt: 1, claimLeaseId },
          acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
        },
        intentHash: 'intent-hash', idempotencyKey: 'invocation-key', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: dispatchId, teamId, channelId, messageId: 'msg-managed-retry', agentId,
        status: 'accepted', requestId: `management:${invocationId}:1`, prompt: '请补齐讨论串交付',
        createdAt: 5, updatedAt: 6,
      });
      await repositories.management.dispatchAttempts.create({
        id: 'attempt-managed-retry', invocationId, dispatchId, attemptNumber: 1,
        status: 'accepted', startedAt: 5,
      });

      const result = await app.receiveDispatchResult({
        dispatchId, agentId, body: '已补齐文件包。',
        workspaceRun: { status: 'succeeded', publishId: 'pub-managed-retry' },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.message?.meta?.outputPackageCard).toMatchObject({
        kind: 'output-package', publishId: 'pub-managed-retry', memberCount: 1,
      });
      expect(await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-managed-retry' })).not.toBeNull();

      // Dispatch 已完成后的重复回报仍会进入 reconciliation，而不是直接 CONFLICT。
      const replay = await app.receiveDispatchResult({
        dispatchId, agentId, body: '已补齐文件包。',
        workspaceRun: { status: 'succeeded', publishId: 'pub-managed-retry' },
      });
      expect(replay.ok).toBe(true);
    });

    test('终态重复回报:publish staging 未提交时不确认 delivered,保留重试机会', async () => {
      seedValue = await seed(variant);
      const { repositories, app, teamId, channelId, agentId, userId } = seedValue;
      const dispatchId = 'dispatch-replay-pending';
      await repositories.messages.append({
        id: 'msg-replay-pending', teamId, channelId, threadId: 'msg-replay-pending',
        senderKind: 'user', senderId: userId, body: '等待文件包', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: dispatchId, teamId, channelId, messageId: 'msg-replay-pending', agentId,
        status: 'succeeded', requestId: 'request-replay-pending', prompt: '等待文件包',
        createdAt: 5, updatedAt: 6, completedAt: 6,
      });

      const result = await app.receiveDispatchResult({
        dispatchId,
        agentId,
        body: '已完成',
        workspaceRun: { status: 'succeeded', publishId: 'publish-not-committed' },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('INTERNAL_ERROR');
    });

    test('历史补偿:终态结果只增补经 provenance 绑定的 publishId 时补写原回复卡片', async () => {
      seedValue = await seed(variant);
      const { repositories, app, teamId, channelId, agentId, userId } = seedValue;
      const dispatchId = 'dispatch-historical-package';
      await repositories.messages.append({
        id: 'msg-historical-package', teamId, channelId, threadId: 'msg-historical-package',
        senderKind: 'user', senderId: userId, body: '生成周报', createdAt: 5,
      });
      await repositories.dispatches.create({
        id: dispatchId, teamId, channelId, messageId: 'msg-historical-package', agentId,
        status: 'accepted', requestId: 'request-historical-package', prompt: '生成周报',
        createdAt: 5, updatedAt: 6,
      });
      await repositories.messages.append({
        id: 'msg-historical-package-claim', teamId, channelId,
        threadId: 'msg-historical-package', senderKind: 'agent', senderId: agentId,
        body: '我来处理，会先看请求和附件，再把结果发在线程里。', createdAt: 7,
        meta: { kind: 'task-claim-confirmed', dispatchId, replyScope: 'thread' },
      });
      const originalWorkspaceRun = {
        id: dispatchId,
        status: 'succeeded' as const,
        cwd: '.',
        command: 'hermes -z [query elided]',
        logExcerpt: '已输出到 ~/Desktop/周报/',
        exitCode: 0,
        startedAt: 10,
        completedAt: 20,
      };
      const original = await app.receiveDispatchResult({
        dispatchId, agentId, body: '已完成', workspaceRun: originalWorkspaceRun,
      });
      expect(original.ok).toBe(true);
      if (!original.ok) return;
      expect(original.message?.meta?.outputPackageCard).toBeUndefined();

      await commitDelivery(seedValue, 'publish-historical-package', [
        { path: '周报.md', body: Buffer.from('weekly') },
      ], {
        agentId, taskId: dispatchId, taskAttempt: 1, workspaceRunId: dispatchId,
      });
      const replay = await app.receiveDispatchResult({
        dispatchId,
        agentId,
        body: '已完成',
        workspaceRun: { ...originalWorkspaceRun, publishId: 'publish-historical-package' },
      });
      expect(replay.ok).toBe(true);
      const dispatchMessages = await repositories.messages.listByDispatch(dispatchId);
      const claimMessage = dispatchMessages.find((message) => message.id === 'msg-historical-package-claim');
      const deliveryMessage = dispatchMessages.find((message) => message.id === original.message?.id);
      expect(claimMessage?.meta?.outputPackageCard).toBeUndefined();
      expect(deliveryMessage?.id).toBe(original.message?.id);
      expect(deliveryMessage?.meta?.outputPackageCard).toMatchObject({
        kind: 'output-package', publishId: 'publish-historical-package', memberCount: 1,
      });
    });

    test('历史补偿:不得把同频道同 Agent 的其他 dispatch publish 串到原回复', async () => {
      seedValue = await seed(variant);
      const { repositories, app, teamId, channelId, agentId, userId } = seedValue;
      const dispatchA = 'dispatch-historical-a';
      const dispatchB = 'dispatch-historical-b';
      await repositories.messages.append({
        id: 'msg-historical-a', teamId, channelId, threadId: 'msg-historical-a',
        senderKind: 'user', senderId: userId, body: '生成 A', createdAt: 5,
      });
      await repositories.messages.append({
        id: 'msg-historical-b', teamId, channelId, threadId: 'msg-historical-b',
        senderKind: 'user', senderId: userId, body: '生成 B', createdAt: 6,
      });
      await repositories.dispatches.create({
        id: dispatchA, teamId, channelId, messageId: 'msg-historical-a', agentId,
        status: 'accepted', requestId: 'request-historical-a', prompt: '生成 A', createdAt: 7, updatedAt: 7,
      });
      await repositories.dispatches.create({
        id: dispatchB, teamId, channelId, messageId: 'msg-historical-b', agentId,
        status: 'succeeded', requestId: 'request-historical-b', prompt: '生成 B', createdAt: 8, updatedAt: 8,
      });
      const originalWorkspaceRun = {
        id: dispatchA, status: 'succeeded' as const, cwd: '.', startedAt: 10, completedAt: 20,
      };
      const original = await app.receiveDispatchResult({
        dispatchId: dispatchA, agentId, body: 'A 已完成', workspaceRun: originalWorkspaceRun,
      });
      expect(original.ok).toBe(true);
      await commitDelivery(seedValue, 'publish-historical-b', [
        { path: 'B.md', body: Buffer.from('b') },
      ], {
        agentId, taskId: dispatchB, taskAttempt: 1, workspaceRunId: dispatchB,
      });

      const replay = await app.receiveDispatchResult({
        dispatchId: dispatchA,
        agentId,
        body: 'A 已完成',
        workspaceRun: { ...originalWorkspaceRun, publishId: 'publish-historical-b' },
      });
      expect(replay.ok).toBe(false);
      const deliveryMessage = (await repositories.messages.listByDispatch(dispatchA))[0];
      expect(deliveryMessage?.meta?.outputPackageCard).toBeUndefined();
    });

    test('#1111 AC4:解析链断裂(无 workspaceRunId)时卡片回退主线(无 threadId),不丢卡片', async () => {
      seedValue = await seed(variant);
      const { repositories, teamId, channelId, agentId } = seedValue;
      await commitDelivery(seedValue, 'pub-nochain', [{ path: 'docs/t3.md', body: Buffer.from('t3') }], {
        agentId, taskId: 'task-synthetic-nochain', taskAttempt: 1,
      });
      const byPublish = await repositories.outputPackages.getPackageByPublishId({ teamId, publishId: 'pub-nochain' });
      const card = await repositories.messages.getByClientMessageId({
        teamId, channelId, clientMessageId: `output-package:${byPublish!.package.packageId}`,
      });
      expect(card).not.toBeNull();
      expect(card!.threadId ?? null).toBeNull();
    });

    test('AC8:Task 摘要按 taskId 过滤 pendingDeliveries(不显示其他任务的事实)', async () => {
      seedValue = await seed(variant);
      // 任务 A:committed 但 formation 被 attempt fence 拒绝 → 该任务的 pending。
      await seedManagedTask(seedValue, 'task-pend-a', 2, 'run-a');
      await commitDelivery(seedValue, 'pub-pend-a', [{ path: 'docs/a.md', body: Buffer.from('a') }], {
        agentId: seedValue.agentId, taskId: 'task-pend-a', taskAttempt: 1,
      });
      // 任务 B:正常形成 package。
      await seedManagedTask(seedValue, 'task-pend-b', 1, 'run-b');
      await commitDelivery(seedValue, 'pub-pend-b', [{ path: 'docs/b.md', body: Buffer.from('b') }], {
        agentId: seedValue.agentId, taskId: 'task-pend-b', taskAttempt: 1,
      });

      const listForA = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, taskId: 'task-pend-a',
      });
      expect(listForA.ok).toBe(true);
      if (!listForA.ok) return;
      expect(listForA.packages).toHaveLength(0);
      expect(listForA.pendingDeliveries).toHaveLength(1);
      expect(listForA.pendingDeliveries[0]!.taskId).toBe('task-pend-a');

      const listForB = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, taskId: 'task-pend-b',
      });
      expect(listForB.ok).toBe(true);
      if (!listForB.ok) return;
      expect(listForB.packages).toHaveLength(1);
      expect(listForB.pendingDeliveries).toHaveLength(0);

      // 全频道视角:两个任务的事实都可见(不互相污染)。
      const all = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.packages).toHaveLength(1);
      expect(all.pendingDeliveries).toHaveLength(1);
    });
  });
}

// SQLite 特有:确认 0076/0077 migration 落地(表 + 约束 + 注册)。
describe('SQLite output-package schema (migrations team/0076+0077)', () => {
  test('package/members/receipt/tombstone 表存在,0076/0077 记入 schema_migrations', () => {
    const db = new Database(':memory:') as DatabaseWithClose;
    applyTeamMigrations(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of ['output_packages', 'output_package_members', 'output_package_command_receipts', 'output_package_idempotency_tombstones']) {
      expect(names).toContain(expected);
    }
    // #1060:versions.stage_id 可空(交付形成版本无 Stage 来源)。
    const stageIdNullable = db.prepare(
      "SELECT 1 FROM pragma_table_info('project_artifact_versions') WHERE name = 'stage_id' AND \"notnull\" = 0",
    ).get();
    expect(stageIdNullable).toBeTruthy();
    const applied = db.prepare("SELECT 1 FROM schema_migrations WHERE id = 'team/0077_output_packages.sql'").get();
    expect(applied).toBeTruthy();
    db.close();
  });
});
