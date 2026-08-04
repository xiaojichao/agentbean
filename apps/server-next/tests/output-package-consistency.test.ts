/**
 * #1065 AC7 output-package 投影一致性(watermark 对照)集成测试。
 *
 * Chat/Task/Files 三处投影消费同一组 output-package 查询;查询带 minimumConsistency
 * 时对照该频道 output-package stream 水位(stream_kind='output-package',
 * stream_id=channelId,revision=写命令成功序列)。覆盖:
 * - 无 token 查询不受影响(AC7 不破坏既有路径);
 * - formation/review/save-revision 任一写命令成功后水位推进,旧 token 查询
 *   → PROJECTION_NOT_READY(不以旧数据伪装成功),新 token → ready;
 * - 跨频道隔离:一频道的写命令不推进另一频道水位。
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
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type { ConsistencyTokenV1 } from '../../../../packages/contracts/src/index.js';

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
    artifactContentStore: {
      async writeContent(input) {
        return {
          storagePath: `artifacts/${input.artifactId}/${input.filename}`,
          sizeBytes: input.content.length,
          sha256: `sha-${input.content.length}`,
        };
      },
      deleteContent: async () => undefined,
    },
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
    close,
  };
}

/** 当前 workspace revision(与 daemon 实际行为一致:每批 delivery 以最新冻结输入为基线)。 */
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
  provenance: { agentId: string; taskId: string; taskAttempt: number },
) {
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

/** managed Task + coordination 最小 seed(与 output-package-formation.test.ts 同构)。 */
async function seedManagedTask(seedValue: Seed, taskId: string, attempt: number, status: 'in_progress' | 'in_review') {
  await seedValue.repositories.management.runs.create({
    schemaVersion: 1,
    id: `run-${taskId}`,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    rootMessageId: `msg-${taskId}`,
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
    status,
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
    managementRunId: `run-${taskId}`,
    rootTaskId: taskId,
    parentTaskId: taskId,
    nodeKind: 'root',
    reviewPolicy: 'manager',
    claimPolicy: 'open',
    requiredCapabilities: [],
    taskRevision: 1,
    attempt,
    maxAttempts: 3,
    createdAt: 10,
    updatedAt: 10,
  });
}

/** 构造 output-package stream 的 consistency token。 */
function token(streamId: string, revision: number): ConsistencyTokenV1 {
  return { schemaVersion: 1, entries: [{ streamKind: 'output-package', streamId, revision }] };
}

async function watermarkRevision(seedValue: Seed, channelId: string): Promise<number> {
  const row = await seedValue.repositories.systemActivity!.watermarks.get('output-package', channelId);
  return row?.revision ?? 0;
}

for (const variant of variants) {
  describe(`output-package consistency (${variant.name})`, () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      while (cleanups.length > 0) cleanups.pop()!();
    });

    test('无 minimumConsistency 查询不受影响(AC7 不破坏既有路径)', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const listed = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) throw new Error(listed.error);
      expect(listed.packages).toEqual([]);
      expect(await watermarkRevision(seedValue, seedValue.channelId)).toBe(0);
    });

    test('formation 推进水位:旧 token → PROJECTION_NOT_READY,新 token → ready', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-consistency-1';
      await seedManagedTask(seedValue, taskId, 1, 'in_progress');
      await commitDelivery(seedValue, 'pub-c1', [{ path: 'docs/c1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      expect(await watermarkRevision(seedValue, seedValue.channelId)).toBe(1);

      // 带"当前已追上"的 token → ready。
      const current = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        minimumConsistency: token(seedValue.channelId, 1),
      });
      expect(current.ok).toBe(true);
      if (!current.ok) throw new Error(current.error);
      expect(current.packages).toHaveLength(1);

      // 带"尚未追上"的 token → PROJECTION_NOT_READY,不得用旧数据伪装成功。
      const stale = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        minimumConsistency: token(seedValue.channelId, 2),
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) throw new Error('expected failure');
      expect(stale.error).toBe('PROJECTION_NOT_READY');
      expect(stale.details?.notReadyStreams).toEqual([
        { streamKind: 'output-package', streamId: seedValue.channelId, revision: 2 },
      ]);

      const detail = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: current.packages[0]!.packageId,
        minimumConsistency: token(seedValue.channelId, 1),
      });
      expect(detail.ok).toBe(true);
    });

    test('review 命令 applied 后水位推进,旧 token 查询 not_ready', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-consistency-review';
      await seedManagedTask(seedValue, taskId, 1, 'in_review');
      await commitDelivery(seedValue, 'pub-cr', [{ path: 'docs/cr.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const packageRecord = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-cr',
      });
      if (!packageRecord) throw new Error('no package formed');
      const packageId = packageRecord.package.packageId;
      const member = packageRecord.members[0]!;

      const reviewed = await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        collectionId: member.collectionId,
        versionId: member.artifactVersionId,
        decision: 'approved',
        comment: '合格',
        idempotencyKey: `review-c:${packageId}`,
      });
      expect(reviewed.ok).toBe(true);
      if (!reviewed.ok) throw new Error(reviewed.error);
      expect(await watermarkRevision(seedValue, seedValue.channelId)).toBe(2);

      // 客户端声明"至少看到 review 后水位"→ ready;声明更高的未来水位 → not_ready。
      const stale = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        minimumConsistency: token(seedValue.channelId, 3),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error).toBe('PROJECTION_NOT_READY');
      const current = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        minimumConsistency: token(seedValue.channelId, 2),
      });
      expect(current.ok).toBe(true);
    });

    test('saveArtifactVersionRevision applied 后水位推进(current 投影随之变化)', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-consistency-save';
      await seedManagedTask(seedValue, taskId, 1, 'in_progress');
      await commitDelivery(seedValue, 'pub-cs', [{ path: 'docs/cs.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const packageRecord = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-cs',
      });
      if (!packageRecord) throw new Error('no package formed');
      const packageId = packageRecord.package.packageId;
      const member = packageRecord.members[0]!;

      const saved = await seedValue.app.saveArtifactVersionRevision({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        collectionId: member.collectionId,
        baseVersionId: member.artifactVersionId,
        content: '# 修订版\n\n回应审核意见。',
        expectedCollectionRevision: 1,
        revisionBasis: {
          sourceVersionId: member.artifactVersionId,
          packageId,
          deliveryId: packageRecord.package.deliveryId,
        },
        idempotencyKey: `revise-c:${member.artifactVersionId}`,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error);
      expect(await watermarkRevision(seedValue, seedValue.channelId)).toBe(2);

      const stale = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        minimumConsistency: token(seedValue.channelId, 3),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error).toBe('PROJECTION_NOT_READY');
    });

    test('跨频道隔离:一频道的写命令不推进另一频道水位', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const channelB = await seedValue.app.createChannel({
        userId: seedValue.userId, teamId: seedValue.teamId, name: 'other', visibility: 'public',
      });
      if (!channelB.ok) throw new Error(channelB.error);
      const taskId = 'task-consistency-b';
      await seedManagedTask(seedValue, taskId, 1, 'in_progress');
      await commitDelivery(seedValue, 'pub-b1', [{ path: 'docs/b1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      expect(await watermarkRevision(seedValue, seedValue.channelId)).toBe(1);
      expect(await watermarkRevision(seedValue, channelB.channel.id)).toBe(0);
      // 频道 B 的 token(尚未有任何写)→ PROJECTION_NOT_READY;频道 A 的 token → ready。
      const bStale = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: channelB.channel.id,
        minimumConsistency: token(channelB.channel.id, 1),
      });
      expect(bStale.ok).toBe(false);
      if (!bStale.ok) expect(bStale.error).toBe('PROJECTION_NOT_READY');
      const aCurrent = await seedValue.app.listOutputPackages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        minimumConsistency: token(seedValue.channelId, 1),
      });
      expect(aCurrent.ok).toBe(true);
    });
  });
}
