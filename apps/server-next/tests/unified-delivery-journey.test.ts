/**
 * #1065 AC13 贯穿旅程 + AC6 三处投影一致性(memory + SQLite 双后端)。
 *
 * 旅程:文件包出现(讨论串卡片)→ Task 审核(review)→ Files 版本核对(同一
 * Server 事实)→ 基于此修改(新版本移动 current)→ finalization(最终版投影 ready)。
 *
 * 全程只消费同一组 Server projections:getOutputPackage / artifact library /
 * projection(delivered/current/final),任一 command 成功后所有 surface 以新的
 * consistency basis 显示同一 identity、revision 与结果(AC6);不伪造旧数据。
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
    reviewPolicy: 'human',
    claimPolicy: 'open',
    requiredCapabilities: [],
    humanAcceptanceAuthorityIds: [seedValue.userId],
    taskRevision: 1,
    attempt,
    maxAttempts: 3,
    createdAt: 10,
    updatedAt: 10,
  });
}

for (const variant of variants) {
  describe(`unified delivery journey (${variant.name})`, () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      while (cleanups.length > 0) cleanups.pop()!();
    });

    test('AC13:交付→讨论串卡片→审核→Files 核对→基于此修改→final 全程一致', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-journey-1';
      await seedManagedTask(seedValue, taskId, 1, 'in_review');
      await commitDelivery(seedValue, 'pub-j1', [{ path: 'docs/j1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const packageRecord = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-j1',
      });
      if (!packageRecord) throw new Error('package not formed');
      const packageId = packageRecord.package.packageId;
      const member = packageRecord.members[0]!;

      // ① 讨论串卡片出现(meta 快照与冻结成员一致)。
      const card = await seedValue.repositories.messages.getByClientMessageId({
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        clientMessageId: `output-package:${packageId}`,
      });
      expect(card).not.toBeNull();
      if (!card) return;
      expect((card.meta as Record<string, unknown>).kind).toBe('output-package');
      expect((card.meta as Record<string, unknown>).packageId).toBe(packageId);

      // ② Task 审核 approved。
      const reviewed = await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        collectionId: member.collectionId,
        versionId: member.artifactVersionId,
        decision: 'approved',
        comment: '质量合格',
        idempotencyKey: `journey-review:${packageId}`,
      });
      expect(reviewed.ok).toBe(true);
      if (!reviewed.ok) throw new Error(reviewed.error);

      // ③ Files 与 Chat 显示同一 reviewState(AC6 同一组 Server 事实)。
      const detail = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, packageId,
      });
      if (!detail.ok) throw new Error(detail.error);
      expect(detail.availableActions[0]?.reviewState).toBe('approved');
      const library = await seedValue.app.listProjectArtifactCollections({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      if (!library.ok) throw new Error(library.error);
      const collection = library.library.collections.find((c) => c.id === member.collectionId);
      const version = collection?.versions.find((v) => v.id === member.artifactVersionId);
      expect(version?.reviewState).toBe('approved');
      // 交付包归属同一版本(Files 的 packageMembership 与 Chat 卡片同 identity)。
      expect(version?.packageMemberships).toEqual([
        {
          packageId,
          sequence: 1,
          shortLabel: 'F1',
          deliveredAt: version!.createdAt,
          taskId,
        },
      ]);

      // ④ 基于此修改:要求修改后人工修订,新版本移动 current(AC6:Chat 的 current 投影同新版本)。
      await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        collectionId: member.collectionId,
        versionId: member.artifactVersionId,
        decision: 'changes_requested',
        comment: '补充说明',
        idempotencyKey: `journey-changes:${packageId}`,
      });
      // changes_requested 后 latestReviewId 由 Server 下发(revision 修订依据)。
      const afterChanges = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, packageId,
      });
      if (!afterChanges.ok) throw new Error(afterChanges.error);
      const basisReviewId = afterChanges.availableActions[0]?.latestReviewId;
      expect(basisReviewId).toBeTruthy();
      const saved = await seedValue.app.saveArtifactVersionRevision({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        collectionId: member.collectionId,
        baseVersionId: member.artifactVersionId,
        content: '# 修订版\n\n补充说明。',
        expectedCollectionRevision: 1,
        revisionBasis: {
          sourceVersionId: member.artifactVersionId,
          ...(basisReviewId ? { basisReviewId } : {}),
          packageId,
          deliveryId: packageRecord.package.deliveryId,
        },
        idempotencyKey: `journey-revise:${member.artifactVersionId}`,
      });
      expect(saved.ok).toBe(true);
      if (!saved.ok) throw new Error(saved.error);
      const revisedVersionId = saved.revision.versionId;
      const currentProjection = await seedValue.app.getOutputPackage({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        projection: { policy: 'current' },
      });
      if (!currentProjection.ok) throw new Error(currentProjection.error);
      expect(currentProjection.projection?.status).toBe('ready');
      expect(currentProjection.projection?.members[0]?.versionId).toBe(revisedVersionId);
      const libraryAfter = await seedValue.app.listProjectArtifactCollections({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      if (!libraryAfter.ok) throw new Error(libraryAfter.error);
      const collectionAfter = libraryAfter.library.collections.find((c) => c.id === member.collectionId);
      expect(collectionAfter?.currentVersionId).toBe(revisedVersionId);

      // ⑤ final:审核通过并设为最终版 → final 投影 ready 且指向交付版本(AC6)。
      // #1062 AC4：修订版本不移动 final——最终版留在交付版本(包成员冻结身份)。
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const collectionRevision = libraryAfter.library.collections.find((c) => c.id === member.collectionId)!.revision;
      const finalized = await seedValue.app.submitPackageReviewAndFinalize({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        collectionId: member.collectionId,
        versionId: member.artifactVersionId,
        decision: 'approved',
        comment: '验收通过',
        expectedCollectionRevision: collectionRevision,
        idempotencyKey: `journey-finalize:${member.artifactVersionId}`,
      });
      expect(finalized.ok).toBe(true);
      if (!finalized.ok) throw new Error(finalized.error);
      const finalProjection = await seedValue.app.getOutputPackage({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        projection: { policy: 'final' },
      });
      if (!finalProjection.ok) throw new Error(finalProjection.error);
      expect(finalProjection.projection?.status).toBe('ready');
      // #1062 AC4：修订版本不移动 final——最终版留在交付版本(包成员冻结身份)。
      expect(finalProjection.projection?.members[0]?.versionId).toBe(member.artifactVersionId);
      expect(finalProjection.projection?.members[0]?.isFinalVersion).toBe(true);
      const libraryFinal = await seedValue.app.listProjectArtifactCollections({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      if (!libraryFinal.ok) throw new Error(libraryFinal.error);
      expect(libraryFinal.library.collections.find((c) => c.id === member.collectionId)?.finalVersionId)
        .toBe(member.artifactVersionId);
    });

    test('AC13:final 缺失时 final 投影 not_ready 且 blockers 结构化(Files/Chat 同源)', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-journey-2';
      await seedManagedTask(seedValue, taskId, 1, 'in_review');
      await commitDelivery(seedValue, 'pub-j2', [{ path: 'docs/j2.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const packageRecord = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-j2',
      });
      if (!packageRecord) throw new Error('package not formed');
      const packageId = packageRecord.package.packageId;

      const finalProjection = await seedValue.app.getOutputPackage({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId,
        projection: { policy: 'final' },
      });
      if (!finalProjection.ok) throw new Error(finalProjection.error);
      expect(finalProjection.projection?.status).toBe('not_ready');
      expect(finalProjection.projection?.blockers.some((blocker) => blocker.code === 'missing_final')).toBe(true);
    });
  });
}
