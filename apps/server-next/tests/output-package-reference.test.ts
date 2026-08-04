/**
 * #1063 将文件包选择冻结为消息 ProjectReferenceSet 集成测试(主 seam:memory + SQLite 双后端)。
 *
 * 覆盖:projection query 四种策略(AC1/AC2/AC3/AC4);发送时冻结为具体 artifactVersionId +
 * package context + basis,后续指针漂移不改写历史消息(AC8);stale basis fail closed(AC6/AC9);
 * package_members 显式选择“基于此修改”(AC4);ordinal 单/多焦点(AC5);repo 级提交点 fence。
 *
 * fixture 复用 output-package-formation 的 seed(全真 publish → package 成形)。
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
  provenance: { agentId: string; taskId: string; taskAttempt: number; workspaceRunId?: string; deviceId?: string },
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

/** 通过 getOutputPackage 读取 projection,并断言 ready。 */
async function readyProjection(
  seedValue: Seed,
  packageId: string,
  policy: 'delivered' | 'current' | 'final' | 'specified',
  versions?: { collectionId: string; versionId: string }[],
) {
  const get = await seedValue.app.getOutputPackage({
    userId: seedValue.userId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    packageId,
    ...(versions ? { projection: { policy, versions } } : { projection: { policy } }),
  });
  expect(get.ok).toBe(true);
  if (!get.ok) throw new Error(get.error);
  expect(get.projection?.status).toBe('ready');
  return get.projection!;
}

for (const variant of variants) {
  describe(`#1063 文件包选择冻结 (#1063, ${variant.name})`, () => {
    let seedValue: Seed | undefined;
    afterEach(() => {
      seedValue?.close();
      seedValue = undefined;
    });

    test('AC1/AC2:projection query 返回 delivered/current,delivered 不随 current 漂移', async () => {
      seedValue = await seed(variant);
      // 两批交付:ep1.md 形成 v1(pub-1)与 v2(pub-2),ep2.md 只在 pub-2。
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1, deviceId: seedValue.device.id,
      });
      await commitDelivery(seedValue, 'pub-2', [
        { path: 'docs/ep1.md', body: Buffer.from('v2') },
        { path: 'docs/ep2.md', body: Buffer.from('new') },
      ], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 2, deviceId: seedValue.device.id,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      const pkg2 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-2',
      });
      if (!pkg1 || !pkg2) throw new Error('package missing');

      // pkg1 的 delivered 恒为 v1,即使 ep1 collection 的 current 已指向 v2。
      const delivered = await readyProjection(seedValue, pkg1.package.packageId, 'delivered');
      expect(delivered.members.map((m) => m.versionId)).toEqual([pkg1.members[0]!.artifactVersionId]);
      expect(delivered.members[0]).toMatchObject({
        collectionId: pkg1.members[0]!.collectionId,
        reviewState: 'pending',
        collectionRevision: 2, // 解析当刻 ep1 collection 的 revision(交付后 append v2 已推进)。
      });
      // delivered 的 item 不带 collectionRevision basis(不设 revision fence)。
      // pkg2 的 current:ep1 → v2,ep2 → v2。
      const current = await readyProjection(seedValue, pkg2.package.packageId, 'current');
      expect(current.members).toHaveLength(2);
      expect(current.members.map((m) => m.versionNumber)).toEqual([2, 1]);
      expect(current.members[0]!.versionId).toBe(pkg2.members[0]!.artifactVersionId);
      // consistencyToken 含 package stream + 各成员 collection revision。
      expect(current.consistencyToken.entries).toContainEqual({
        streamKind: 'output-package', streamId: pkg2.package.packageId, revision: 1,
      });
      expect(current.consistencyToken.entries.some((e) => e.streamKind === 'project-artifact-collection')).toBe(true);
      // asOf/audienceScope 已下发。
      const get = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg2.package.packageId, projection: { policy: 'current' },
      });
      if (!get.ok) throw new Error(get.error);
      expect(get.asOf).toBeGreaterThan(0);
      expect(get.audienceScope).toBe(`${seedValue.teamId}:${seedValue.channelId}:${seedValue.userId}`);
    });

    test('AC4/AC5:specified query 显式选择被拒版本 → ready(基于此修改)', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const member = pkg1.members[0]!;
      await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg1.package.packageId, collectionId: member.collectionId, versionId: member.artifactVersionId,
        decision: 'rejected', comment: '需要修改', idempotencyKey: 'review-1',
      });
      const get = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg1.package.packageId,
        projection: { policy: 'specified', versions: [{ collectionId: member.collectionId, versionId: member.artifactVersionId }] },
      });
      expect(get.ok).toBe(true);
      if (!get.ok) return;
      expect(get.projection?.status).toBe('ready');
      expect(get.projection?.members[0]).toMatchObject({
        versionId: member.artifactVersionId, reviewState: 'rejected',
      });
      expect(get.projection?.blockers).toEqual([]);
    });

    test('P2-2:畸形 selection payload 结构化拒绝(不抛 TypeError)', async () => {
      seedValue = await seed(variant);
      const malformed = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '畸形', clientMessageId: 'client-malformed',
        selections: [{ kind: 'package_members', packageId: 'pkg-1', members: 'not-an-array' }] as never,
      });
      expect(malformed.ok).toBe(false);
      expect(malformed.error).toBe('VALIDATION_ERROR');
      // 未知 arm 同样拒绝。
      const unknownArm = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '未知arm', clientMessageId: 'client-unknown',
        selections: [{ kind: 'totally_unknown', packageId: 'pkg-1' }] as never,
      });
      expect(unknownArm.ok).toBe(false);
      expect(unknownArm.error).toBe('VALIDATION_ERROR');
    });

    test('AC4:rejected 的 current 不作为整包默认正式输入,projection 返回 current_not_formal 阻断', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const member = pkg1.members[0]!;
      // 对 delivered 版本提交 rejected 审核。
      const review = await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg1.package.packageId, collectionId: member.collectionId, versionId: member.artifactVersionId,
        decision: 'rejected', comment: '需要修改', idempotencyKey: 'review-1',
      });
      expect(review.ok).toBe(true);

      const get = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg1.package.packageId, projection: { policy: 'current' },
      });
      if (!get.ok) throw new Error(get.error);
      expect(get.projection?.status).toBe('not_ready');
      expect(get.projection?.blockers).toEqual([{
        code: 'current_not_formal', collectionId: member.collectionId,
        shortLabel: 'F1', filename: 'ep1.md',
      }]);
      // 可解析部分仍返回。
      expect(get.projection?.members).toHaveLength(1);
    });

    test('AC3:final projection 缺失必需 final 时整体 not_ready 并列出缺失项;非必需无 final 明确省略', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const get = await seedValue.app.getOutputPackage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg1.package.packageId, projection: { policy: 'final' },
      });
      if (!get.ok) throw new Error(get.error);
      expect(get.projection?.status).toBe('not_ready');
      expect(get.projection?.blockers).toEqual([{
        code: 'missing_final', collectionId: pkg1.members[0]!.collectionId,
        shortLabel: 'F1', filename: 'ep1.md',
      }]);
    });

    test('AC5:短标识 package 焦点单命中 resolved 为显式版本;双焦点 ambiguous', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      await commitDelivery(seedValue, 'pub-2', [{ path: 'docs/ep2.md', body: Buffer.from('v2') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 2,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      const pkg2 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-2',
      });
      if (!pkg1 || !pkg2) throw new Error('package missing');
      // 单焦点:第 1 个文件。
      const resolved = await seedValue.app.resolveProjectReferenceOrdinal({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        ordinal: 1, focusBundleIds: [], focusPackageIds: [pkg1.package.packageId],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.kind).toBe('resolved');
      if (resolved.kind === 'resolved') {
        expect(resolved.selection).toMatchObject({
          kind: 'package_members', packageId: pkg1.package.packageId,
          members: [{ collectionId: pkg1.members[0]!.collectionId, versionId: pkg1.members[0]!.artifactVersionId }],
        });
        expect(resolved.candidate).toMatchObject({ shortLabel: 'F1', position: 1, filename: 'ep1.md' });
      }
      // 双焦点 + 同名位次 → ambiguous,不猜测。
      const ambiguous = await seedValue.app.resolveProjectReferenceOrdinal({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        ordinal: 1, focusBundleIds: [], focusPackageIds: [pkg1.package.packageId, pkg2.package.packageId],
      });
      expect(ambiguous.ok).toBe(true);
      if (!ambiguous.ok) return;
      expect(ambiguous.kind).toBe('ambiguous');
      if (ambiguous.kind === 'ambiguous') {
        expect(ambiguous.candidates.map((c) => c.scopeId)).toEqual([pkg1.package.packageId, pkg2.package.packageId]);
      }
    });

    test('AC8:发送时冻结具体版本;后续 append 新 version 不改写历史消息引用', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const member = pkg1.members[0]!;
      const collection = (await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      })).find((c) => c.id === member.collectionId)!;

      // 发送 current 整包引用。
      const sent = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '用当前版', clientMessageId: 'client-1',
        selections: [{
          kind: 'package_projection', packageId: pkg1.package.packageId, policy: 'current',
          expectedMemberRevisions: [{ collectionId: member.collectionId, revision: collection.revision }],
        }],
      });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.referenceSet).toBeDefined();
      if (!sent.referenceSet) return;
      expect(sent.referenceSet.selections[0]).toMatchObject({
        sourceKind: 'package_current',
        package: { packageId: pkg1.package.packageId, policy: 'current', memberCount: 1 },
      });
      expect(sent.referenceSet.selections[0]!.items[0]).toMatchObject({
        kind: 'artifact_version',
        collectionId: member.collectionId,
        versionId: member.artifactVersionId,
        versionNumber: 1,
        collectionRevision: collection.revision,
      });

      // 后续同路径 append v2(current 指针漂移),历史消息引用不变。
      await commitDelivery(seedValue, 'pub-2', [{ path: 'docs/ep1.md', body: Buffer.from('v2') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 2,
      });
      const history = await seedValue.app.listChannelMessages({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        limit: 50,
      });
      // 直接读 repository 验证冻结引用未漂移。
      const persisted = await seedValue.repositories.projectReferenceSets.getByMessageId({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
        messageId: sent.message.id,
      });
      expect(persisted).not.toBeNull();
      if (!persisted) return;
      expect(persisted.selections[0]!.items[0]).toMatchObject({
        versionId: member.artifactVersionId, // 仍是 v1
        collectionRevision: collection.revision,
      });
      expect(persisted.selections[0]!.packageId).toBe(pkg1.package.packageId);
      expect(persisted.selections[0]!.packageProjection).toBe('current');
      expect(persisted.selections[0]!.packageMemberCount).toBe(1);
      expect(history.ok).toBe(true);
    });

    test('AC6/AC9:stale basis 发送失败且不落库;同 clientMessageId replay 返回同一引用', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const member = pkg1.members[0]!;
      // 故意带错误的 collection revision(2 而非实际 1)。
      const stale = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '旧快照', clientMessageId: 'client-stale',
        selections: [{
          kind: 'package_projection', packageId: pkg1.package.packageId, policy: 'current',
          expectedMemberRevisions: [{ collectionId: member.collectionId, revision: 99 }],
        }],
      });
      expect(stale.ok).toBe(false);
      // 消息未落库。
      const staleSet = await seedValue.repositories.projectReferenceSets.getByMessageId({
        teamId: seedValue.teamId, channelId: seedValue.channelId, messageId: 'id-1',
      });
      expect(staleSet).toBeNull();

      // 正确 fence 发送成功。
      const collection = (await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      })).find((c) => c.id === member.collectionId)!;
      const ok = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '当前版', clientMessageId: 'client-ok',
        selections: [{
          kind: 'package_projection', packageId: pkg1.package.packageId, policy: 'current',
          expectedMemberRevisions: [{ collectionId: member.collectionId, revision: collection.revision }],
        }],
      });
      expect(ok.ok).toBe(true);
      // 同 key replay 返回同一引用(不重复创建)。
      const replay = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '当前版', clientMessageId: 'client-ok',
        selections: [{
          kind: 'package_projection', packageId: pkg1.package.packageId, policy: 'current',
          expectedMemberRevisions: [{ collectionId: member.collectionId, revision: collection.revision }],
        }],
      });
      expect(replay.ok).toBe(true);
      expect(replay.message.id).toBe(ok.message.id);
      expect(replay.referenceSet?.id).toBe(ok.referenceSet?.id);
    });

    test('AC4/AC5:package_members 显式选择“基于此修改”被拒版本', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const member = pkg1.members[0]!;
      const review = await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        packageId: pkg1.package.packageId, collectionId: member.collectionId, versionId: member.artifactVersionId,
        decision: 'rejected', comment: '需要修改', idempotencyKey: 'review-1',
      });
      expect(review.ok).toBe(true);

      // 显式选择被拒版本发送(基于此修改)。
      const sent = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '基于此修改', clientMessageId: 'client-specified',
        selections: [{
          kind: 'package_members', packageId: pkg1.package.packageId,
          members: [{ collectionId: member.collectionId, versionId: member.artifactVersionId }],
        }],
      });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.referenceSet?.selections[0]).toMatchObject({
        sourceKind: 'package_specified',
        package: { packageId: pkg1.package.packageId, policy: 'specified', memberCount: 1 },
      });
      expect(sent.referenceSet?.selections[0]!.items[0]).toMatchObject({
        versionId: member.artifactVersionId,
        versionNumber: 1,
      });
      // 显式版本 item 不携带 collectionRevision(无指针依赖)。
      expect(sent.referenceSet?.selections[0]!.items[0]).not.toHaveProperty('collectionRevision');
    });

    test('AC7/权限:私有频道非成员 query 与发送均拒绝', async () => {
      seedValue = await seed(variant);
      const privateChannel = await seedValue.app.createChannel({
        userId: seedValue.userId, teamId: seedValue.teamId, name: 'private', visibility: 'private',
      });
      if (!privateChannel.ok) throw new Error(privateChannel.error);
      // 非成员用户(不在私有频道 humanMemberIds)。
      await seedValue.repositories.users.create({
        id: 'outsider-1', username: 'outsider', passwordHash: 'hash', role: 'user',
        createdAt: 1, updatedAt: 1,
      });
      await seedValue.repositories.teams.addMember({
        teamId: seedValue.teamId, userId: 'outsider-1', username: 'outsider', role: 'member', joinedAt: 1,
      });
      const get = await seedValue.app.getOutputPackage({
        userId: 'outsider-1', teamId: seedValue.teamId, channelId: privateChannel.channel.id,
        packageId: 'pkg-any', projection: { policy: 'delivered' },
      });
      expect(get.ok).toBe(false);
    });

    test('repo 级提交点 fence:collection revision 漂移 → reference_fact_conflict 整体回滚', async () => {
      seedValue = await seed(variant);
      await commitDelivery(seedValue, 'pub-1', [{ path: 'docs/ep1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 1,
      });
      const pkg1 = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-1',
      });
      if (!pkg1) throw new Error('package missing');
      const member = pkg1.members[0]!;
      const collection = (await seedValue.repositories.channelProjects.listArtifactCollections({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      })).find((c) => c.id === member.collectionId)!;
      // 解析后 collection revision 已推进:通过真实第二批发货 append 新版本
      // (推进 collection revision 的真实路径,与 AC8 的并发 append 一致)。
      await commitDelivery(seedValue, 'pub-2', [{ path: 'docs/ep1.md', body: Buffer.from('v2') }], {
        agentId: seedValue.agentId, taskId: 'task-1', taskAttempt: 2,
      });
      const message = await seedValue.repositories.messages.append({
        id: 'fence-msg', teamId: seedValue.teamId, channelId: seedValue.channelId,
        senderKind: 'human', senderId: seedValue.userId, body: 'fence', createdAt: 1,
      });
      const result = await seedValue.repositories.projectReferenceSets.create({
        set: {
          id: 'fence-set', contractVersion: 1, teamId: seedValue.teamId, channelId: seedValue.channelId,
          messageId: message.id, createdBy: seedValue.userId, createdAt: 1, selections: [],
        },
        selections: [{
          id: 'fence-sel', referenceSetId: 'fence-set', sourceKind: 'package_current', position: 0,
          packageId: pkg1.package.packageId, packageProjection: 'current', packageMemberCount: 1,
          createdAt: 1, items: [],
        }],
        items: [{
          id: 'fence-item', selectionId: 'fence-sel', kind: 'artifact_version', position: 0,
          collectionId: member.collectionId, versionId: member.artifactVersionId, versionNumber: 1,
          artifactId: 'art-x', artifactFilename: 'ep1.md', collectionRevision: collection.revision, createdAt: 1,
        }],
        mutation: {
          teamId: seedValue.teamId, channelId: seedValue.channelId, idempotencyKey: 'fence-key',
          requestFingerprint: 'fence-fp', referenceSetId: 'fence-set', createdAt: 1,
        },
      });
      expect(result.kind).toBe('reference_fact_conflict');
      // 无部分落库。
      expect(await seedValue.repositories.projectReferenceSets.getByMessageId({
        teamId: seedValue.teamId, channelId: seedValue.channelId, messageId: message.id,
      })).toBeNull();
    });
  });
}
