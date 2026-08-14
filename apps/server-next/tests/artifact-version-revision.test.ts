/**
 * #1062 明确版本修订与 Markdown 并发冲突集成测试(主 seam:memory + SQLite 双后端)。
 *
 * 覆盖:
 * - AC1/AC3:「基于此修改」冻结 sourceVersion/review basis/package/delivery,Server 复验并
 *   持久化 revisionBasis;新版本 lineage 含来源版本,source 继承旧版本的 task/run/invocation;
 * - AC2:保存原子产生新 Artifact + 新 ProjectArtifactVersion 并移动 collection.currentVersionId;
 * - AC4:新版本 reviewState=pending(不继承旧 review);finalVersionId 不移动;Task 不被触碰;
 * - AC5:原 Run artifact 行与旧版本行不被改写(不可变);
 * - AC6/AC8:stale base / stale collection revision / stale basis → 结构化 conflict
 *   (details.revisionConflict 带 base/Server 最新/草稿保留),零部分写入;归档/撤权 fail closed;
 * - AC9:保存成功不向聊天流投影 system 活动消息(版本状态看 Files/Task);
 * - AC10:receipt 幂等(同 key replay 恢复同一版本;异 payload conflict);
 *   availableActions 只在 rejected/changes_requested 成员下发 revise-version;
 * - 原子性:事务中段失败 → 零部分行(artifact/version/collection/receipt 全部不出现)。
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type { OutputPackageRecord } from '../src/application/output-package-repositories.js';
import type { ArtifactRevisionConflictDto } from '../../../packages/contracts/src/index.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };

interface Seed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  userId: string;
  teamId: string;
  channelId: string;
  agentId: string;
  memberUserId: string;
  contentWrites: string[];
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
  const contentWrites: string[] = [];
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `id-${++id}` },
    artifactContentStore: {
      async writeContent(input) {
        const content = input.content.toString('utf8');
        contentWrites.push(content);
        return {
          storagePath: `artifacts/${input.artifactId}/${input.filename}`,
          sizeBytes: input.content.length,
          sha256: `sha-${content.length}`,
        };
      },
      deleteContent: vi.fn(async () => undefined),
    },
  });
  const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  if (!registered.ok) throw new Error(registered.error);
  const userId = registered.user.id;
  const teamId = registered.user.primaryTeamId!;
  const channel = await app.createChannel({ userId, teamId, name: 'project', visibility: 'public' });
  if (!channel.ok) throw new Error(channel.error);
  const member = await app.registerUser({ username: 'member1', password: 'secret', teamName: 'Team2' });
  if (!member.ok) throw new Error(member.error);
  await repositories.teams.addMember({ teamId, userId: member.user.id, role: 'member', joinedAt: 150 });
  const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-a', hostname: 'device-a' });
  if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
  const agents = await app.registerDiscoveredAgents({
    teamId,
    deviceId: hello.device.id,
    agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
  });
  if (!agents.ok) throw new Error(agents.error);
  const agentId = agents.agents[0]!.id;
  const addAgent = await app.addChannelAgentMember({ userId, teamId, channelId: channel.channel.id, agentId });
  if (!addAgent.ok) throw new Error(addAgent.error);
  return {
    repositories,
    app,
    userId,
    teamId,
    channelId: channel.channel.id,
    agentId,
    memberUserId: member.user.id,
    contentWrites,
    close,
  };
}

interface PackageFixture {
  packageId: string;
  collectionId: string;
  versionId: string;
  deliveryId: string;
  taskId: string;
  artifactId: string;
}

/** 构造一个最小 package(直接 recordPackageFormation;交付版本带 run/invocation 来源)。 */
async function seedPackage(
  repositories: ServerNextRepositories,
  seedValue: Seed,
  opts?: { filename?: string; mimeType?: string },
): Promise<PackageFixture> {
  const taskId = `task-${seedValue.channelId}`;
  const artifactId = `art-${seedValue.channelId}-1`;
  await repositories.artifacts.create({
    id: artifactId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    uploaderId: seedValue.agentId,
    filename: opts?.filename ?? 'report.md',
    mimeType: opts?.mimeType ?? 'text/markdown',
    sizeBytes: 12,
    pathKind: 'workspace',
    role: 'run_output',
    workspaceRunId: 'run-1',
    createdAt: 400,
  });
  const record: OutputPackageRecord = {
    teamId: seedValue.teamId,
    packageId: `pkg-${seedValue.channelId}-1`,
    channelId: seedValue.channelId,
    deliveryId: `del-${seedValue.channelId}-1`,
    publishId: `pub-${seedValue.channelId}-1`,
    workspaceRevisionId: `rev-${seedValue.channelId}-1`,
    agentId: seedValue.agentId,
    taskId,
    taskBinding: 'managed',
    taskRevision: 1,
    taskAttempt: 1,
    memberCount: 1,
    status: 'recorded',
    createdAt: 500,
  };
  const result = await repositories.outputPackages.recordPackageFormation({
    record,
    members: [{
      sequence: 1,
      shortLabel: 'F1',
      role: 'deliverable',
      requiredForFinal: true,
      sourcePath: 'out/report.md',
      filename: opts?.filename ?? 'report.md',
      sizeBytes: 12,
      collection: { mode: 'create', collectionId: `col-${seedValue.channelId}-1`, name: 'out/report.md', kind: 'deliverable' },
      version: {
        id: `ver-${seedValue.channelId}-1`,
        artifactId,
        taskId,
        taskRevision: 1,
        sourceWorkspaceRunId: 'run-1',
        sourceInvocationId: 'inv-1',
      },
    }],
    receipt: {
      receiptId: `rcpt-${seedValue.channelId}-1`,
      teamId: seedValue.teamId,
      commandName: 'record-agent-output-package',
      commandSchemaVersion: 1,
      idempotencyKey: `record-agent-output-package:${seedValue.channelId}:pub-${seedValue.channelId}-1`,
      commandHash: 'x',
      outcome: 'applied',
      committedRevisions: [],
      eventRefs: [],
      commitTime: 500,
      resultAvailable: true,
      createdAt: 500,
    },
    tombstone: {
      id: `tomb-${seedValue.channelId}-1`,
      teamId: seedValue.teamId,
      commandName: 'record-agent-output-package',
      idempotencyKey: `record-agent-output-package:${seedValue.channelId}:pub-${seedValue.channelId}-1`,
      commandHash: 'x',
      receiptId: `rcpt-${seedValue.channelId}-1`,
      outcome: 'applied',
      resultAvailable: true,
      createdAt: 500,
    },
  });
  if (result.kind !== 'created') throw new Error(`package seed failed: ${result.kind}`);
  return {
    packageId: record.packageId,
    collectionId: `col-${seedValue.channelId}-1`,
    versionId: `ver-${seedValue.channelId}-1`,
    deliveryId: record.deliveryId,
    taskId,
    artifactId,
  };
}

/** 在交付版本上直接追加一条 rejected/changes_requested 审核(构造修订 basis)。 */
async function seedNegativeReview(
  repositories: ServerNextRepositories,
  seedValue: Seed,
  fixture: PackageFixture,
  decision: 'rejected' | 'changes_requested' = 'changes_requested',
): Promise<string> {
  const reviewId = `review-${fixture.versionId}`;
  const appended = await repositories.channelProjects.appendArtifactReview({
    review: {
      id: reviewId,
      teamId: seedValue.teamId,
      channelId: seedValue.channelId,
      collectionId: fixture.collectionId,
      versionId: fixture.versionId,
      packageId: fixture.packageId,
      deliveryId: fixture.deliveryId,
      taskId: fixture.taskId,
      taskRevision: 1,
      taskAttempt: 1,
      authorityBasis: 'team-owner',
      decision,
      comment: '需要修订',
      basis: [],
      reviewedBy: seedValue.userId,
      createdAt: 600,
    },
    mutation: {
      teamId: seedValue.teamId,
      channelId: seedValue.channelId,
      idempotencyKey: `seed-review:${reviewId}`,
      requestFingerprint: `fp-${reviewId}`,
      kind: 'review',
      collectionId: fixture.collectionId,
      versionId: fixture.versionId,
      reviewId,
      createdAt: 600,
    },
  });
  if (appended.kind !== 'created') throw new Error(`review seed failed: ${appended.kind}`);
  return reviewId;
}

function saveInput(seedValue: Seed, fixture: PackageFixture, reviewId: string) {
  return {
    userId: seedValue.userId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    collectionId: fixture.collectionId,
    baseVersionId: fixture.versionId,
    content: '# 修订后的报告\n\n回应审核意见。',
    expectedCollectionRevision: 1,
    revisionBasis: {
      sourceVersionId: fixture.versionId,
      basisReviewId: reviewId,
      packageId: fixture.packageId,
      deliveryId: fixture.deliveryId,
    },
    idempotencyKey: `revise:${fixture.versionId}:${seedValue.userId}`,
  };
}

for (const variant of variants) {
  describe(`artifact-version revision (${variant.name})`, () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      while (cleanups.length > 0) cleanups.pop()!();
    });

    async function makeSeed(): Promise<Seed> {
      const s = await seed(variant);
      cleanups.push(s.close);
      return s;
    }

    test('回归:socket bind 注入的 currentDeviceId 不导致 ARTIFACT_REVISION_PAYLOAD_INVALID', async () => {
      // bind 层 withAuthenticatedUserId 无条件注入 currentDeviceId;usecase 必须剥离后再过
      // exact-key 校验,否则该事件全链路永远 INTERNAL_ERROR(既有用例直调 usecase 未覆盖)。
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const result = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        currentDeviceId: 'device-socket-injected',
      });
      expect(result).toMatchObject({ ok: true, replayed: false });
    });

    test('AC1/AC2/AC3/AC4/AC9:基于此修改成功保存——原子产生新版本、移动 current、不继承不移动、活动投影', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const before = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: fixture.collectionId,
      });
      expect(before?.currentVersionId).toBe(fixture.versionId);
      expect(before?.revision).toBe(1);

      const result = await s.app.saveArtifactVersionRevision(saveInput(s, fixture, reviewId));
      expect(result).toMatchObject({ ok: true, replayed: false });
      if (!result.ok) throw new Error(result.error);
      const saved = result.revision;
      expect(saved.collectionId).toBe(fixture.collectionId);
      expect(saved.versionNumber).toBe(2);
      expect(saved.baseVersionId).toBe(fixture.versionId);
      expect(saved.sourceVersionId).toBe(fixture.versionId);
      expect(saved.basisReviewId).toBe(reviewId);
      expect(saved.packageId).toBe(fixture.packageId);
      expect(saved.deliveryId).toBe(fixture.deliveryId);
      expect(saved.currentVersionId).toBe(saved.versionId);
      expect(saved.collectionRevision).toBe(2);
      // AC4:final 不移动(本 fixture 未设置 final → 仍为空)。
      expect(saved.finalVersionId).toBeUndefined();
      // AC2:内容经 content store 物化。
      expect(s.contentWrites).toEqual(['# 修订后的报告\n\n回应审核意见。']);

      // AC2/AC4:collection current 移动、revision 推进;旧版本行不改写(AC5)。
      const after = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: fixture.collectionId,
      });
      expect(after?.currentVersionId).toBe(saved.versionId);
      expect(after?.revision).toBe(2);
      expect(after?.versionCount).toBe(2);
      expect(after?.finalVersionId).toBeUndefined();
      const versions = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      const newVersion = versions.find((candidate) => candidate.id === saved.versionId);
      expect(newVersion).toMatchObject({
        versionNumber: 2,
        promotedBy: s.userId,
        // AC3:继承交付来源(Server 推导)。
        taskId: fixture.taskId,
        taskRevision: 1,
        sourceWorkspaceRunId: 'run-1',
        sourceInvocationId: 'inv-1',
        revisedFromVersionId: fixture.versionId,
        revisionBasisReviewId: reviewId,
        revisionPackageId: fixture.packageId,
        revisionDeliveryId: fixture.deliveryId,
      });
      expect(newVersion?.lineage).toEqual([{ kind: 'project_version', refId: fixture.versionId }]);
      // AC4:新版本零 review;旧版本 review 仍在旧版本上(不迁移)。
      const reviews = await s.repositories.channelProjects.listArtifactReviews({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(reviews.filter((review) => review.versionId === saved.versionId)).toHaveLength(0);
      expect(reviews.filter((review) => review.versionId === fixture.versionId)).toHaveLength(1);
      // AC5:原 Run artifact 行不改写。
      const originArtifact = await s.repositories.artifacts.getForTeam({
        teamId: s.teamId, artifactId: fixture.artifactId,
      });
      expect(originArtifact?.workspaceRunId).toBe('run-1');
      expect(originArtifact?.sizeBytes).toBe(12);

      // AC9:版本状态只在 Files/Task 更新；不向聊天流写 system 活动消息。
      const messages = await s.repositories.messages.listByChannel(s.channelId, 100);
      expect(messages.filter((message) => message.meta?.kind === 'artifact-version-revision')).toHaveLength(0);
    });

    test('AC10:同 key replay 恢复同一版本不产生重复行;异 payload 同 key → conflict 无副作用', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const input = saveInput(s, fixture, reviewId);
      const first = await s.app.saveArtifactVersionRevision(input);
      if (!first.ok) throw new Error(first.error);
      const replay = await s.app.saveArtifactVersionRevision(input);
      expect(replay).toMatchObject({ ok: true, replayed: true });
      if (!replay.ok) throw new Error(replay.error);
      expect(replay.revision.versionId).toBe(first.revision.versionId);
      const versions = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(versions).toHaveLength(2);
      // 保存/replay 均不向聊天流投影活动卡。
      const messages = await s.repositories.messages.listByChannel(s.channelId, 100);
      expect(messages.filter((message) => message.meta?.kind === 'artifact-version-revision')).toHaveLength(0);

      const conflict = await s.app.saveArtifactVersionRevision({ ...input, content: '# 别的内容' });
      expect(conflict).toMatchObject({ ok: false, error: 'CONFLICT' });
      const versionsAfter = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(versionsAfter).toHaveLength(2);
    });

    test('AC6/AC7:stale base → 结构化 conflict(base/Server 最新/草稿保留),零部分写入', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      // 第一次保存把 current 推进到 v2。
      const first = await s.app.saveArtifactVersionRevision(saveInput(s, fixture, reviewId));
      if (!first.ok) throw new Error(first.error);
      // 另一会话仍以 v1 为 base 保存 → stale(不带 basis review,避免 basis stale 抢先)。
      const stale = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        revisionBasis: { sourceVersionId: fixture.versionId },
        expectedCollectionRevision: 2,
        idempotencyKey: 'revise:stale-1',
      });
      expect(stale).toMatchObject({ ok: false, error: 'CONFLICT' });
      if (stale.ok) throw new Error('expected conflict');
      const details = stale.details as { revisionConflict?: ArtifactRevisionConflictDto } | undefined;
      expect(details?.revisionConflict).toMatchObject({
        code: 'base-version-stale',
        baseVersionId: fixture.versionId,
        serverCurrentVersionId: first.revision.versionId,
        serverCurrentVersionNumber: 2,
        collectionRevision: 2,
        draftPreserved: true,
      });
      // 零部分写入:版本数/content store 写入数/collection revision 全部不变。
      const versions = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(versions).toHaveLength(2);
      expect(s.contentWrites).toHaveLength(1);
      const collection = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: fixture.collectionId,
      });
      expect(collection?.revision).toBe(2);
    });

    test('AC8:stale collection revision(并发 finalization/append 已推进)→ conflict', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const stale = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        expectedCollectionRevision: 99,
        idempotencyKey: 'revise:stale-rev',
      });
      expect(stale).toMatchObject({ ok: false, error: 'CONFLICT' });
      if (stale.ok) throw new Error('expected conflict');
      expect((stale.details as { revisionConflict?: ArtifactRevisionConflictDto })?.revisionConflict?.code)
        .toBe('collection-revision-stale');
      const versions = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(versions).toHaveLength(1);
    });

    test('AC8:basis review 已被更新的审核取代 → revision-basis-stale conflict', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      // 审核者随后在该版本上追加了更新的 review(approved),用户仍基于旧 review 修订。
      await s.repositories.channelProjects.appendArtifactReview({
        review: {
          id: `review-2-${fixture.versionId}`,
          teamId: s.teamId,
          channelId: s.channelId,
          collectionId: fixture.collectionId,
          versionId: fixture.versionId,
          authorityBasis: 'team-owner',
          decision: 'approved',
          comment: '复核通过',
          basis: [],
          reviewedBy: s.userId,
          createdAt: 601,
        },
        mutation: {
          teamId: s.teamId,
          channelId: s.channelId,
          idempotencyKey: 'seed-review:2',
          requestFingerprint: 'fp-2',
          kind: 'review',
          collectionId: fixture.collectionId,
          versionId: fixture.versionId,
          reviewId: `review-2-${fixture.versionId}`,
          createdAt: 601,
        },
      });
      const stale = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        idempotencyKey: 'revise:stale-basis',
      });
      expect(stale).toMatchObject({ ok: false, error: 'CONFLICT' });
      if (stale.ok) throw new Error('expected conflict');
      expect((stale.details as { revisionConflict?: ArtifactRevisionConflictDto })?.revisionConflict?.code)
        .toBe('revision-basis-stale');
    });

    test('AC1/AC8:basis 对不上(review 不属于来源版本/approved 作 basis/package 成员身份不符)→ rejected 零写入', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      // review 属于别的版本。
      const wrongVersion = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        revisionBasis: { ...saveInput(s, fixture, reviewId).revisionBasis, basisReviewId: 'review-foreign' },
        idempotencyKey: 'revise:mismatch-1',
      });
      expect(wrongVersion).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
      // package 不含来源版本。
      const wrongPackage = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        revisionBasis: {
          sourceVersionId: fixture.versionId,
          packageId: 'pkg-foreign',
          deliveryId: 'del-foreign',
        },
        idempotencyKey: 'revise:mismatch-2',
      });
      expect(wrongPackage).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
      const versions = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(versions).toHaveLength(1);
      expect(s.contentWrites).toHaveLength(0);
    });

    test('AC8:非团队成员/归档频道/非 Markdown 版本 fail closed', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const outsider = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        userId: 'outsider',
        idempotencyKey: 'revise:outsider',
      });
      expect(outsider).toMatchObject({ ok: false, error: 'FORBIDDEN' });

      const archived = await s.repositories.channels.archive({ channelId: s.channelId, timestamp: 700 });
      expect(archived?.archivedAt).toBe(700);
      const onArchived = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        idempotencyKey: 'revise:archived',
      });
      expect(onArchived).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });

    test('非 Markdown base 版本 → rejected(not-markdown-version)', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s, { filename: 'chart.png', mimeType: 'image/png' });
      const result = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, 'unused'),
        revisionBasis: { sourceVersionId: fixture.versionId },
        idempotencyKey: 'revise:binary',
      });
      expect(result).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
      expect(result.ok ? '' : result.message).toContain('not-markdown-version');
    });

    test('AC4:final 指针在修订后不移动(已有 final 的集合)', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      // 先有一次 approved + final 设在交付版本上(直接构造 finalization 事实)。
      await s.repositories.channelProjects.appendArtifactReview({
        review: {
          id: `review-ok-${fixture.versionId}`,
          teamId: s.teamId,
          channelId: s.channelId,
          collectionId: fixture.collectionId,
          versionId: fixture.versionId,
          authorityBasis: 'team-owner',
          decision: 'approved',
          comment: '通过',
          basis: [],
          reviewedBy: s.userId,
          createdAt: 599,
        },
        mutation: {
          teamId: s.teamId, channelId: s.channelId,
          idempotencyKey: 'seed-review:ok', requestFingerprint: 'fp-ok', kind: 'review',
          collectionId: fixture.collectionId, versionId: fixture.versionId,
          reviewId: `review-ok-${fixture.versionId}`, createdAt: 599,
        },
      });
      const finalized = await s.repositories.channelProjects.setArtifactFinalVersion({
        teamId: s.teamId,
        channelId: s.channelId,
        collectionId: fixture.collectionId,
        expectedCollectionRevision: 1,
        nextRevision: 2,
        updatedAt: 610,
        finalization: {
          id: `fin-${fixture.versionId}`,
          teamId: s.teamId,
          channelId: s.channelId,
          collectionId: fixture.collectionId,
          versionId: fixture.versionId,
          basisReviewId: `review-ok-${fixture.versionId}`,
          actorKind: 'human',
          finalizedBy: s.userId,
          createdAt: 610,
        },
        mutation: {
          teamId: s.teamId, channelId: s.channelId,
          idempotencyKey: 'seed-fin:1', requestFingerprint: 'fp-fin', kind: 'finalization',
          collectionId: fixture.collectionId, versionId: fixture.versionId,
          finalizationId: `fin-${fixture.versionId}`, createdAt: 610,
        },
      });
      expect(finalized.kind).toBe('finalized');
      // finalization 之后追加 rejected review:它成为最新 review,作为修订 basis;
      // 旧 approved 仍是 final 的依据(final 指针不被此命令移动)。
      const reviewId = await seedNegativeReview(s.repositories, s, fixture, 'rejected');
      // collection revision 已被 finalization 推进到 2。
      const saved = await s.app.saveArtifactVersionRevision({
        ...saveInput(s, fixture, reviewId),
        expectedCollectionRevision: 2,
        idempotencyKey: 'revise:with-final',
      });
      expect(saved).toMatchObject({ ok: true });
      if (!saved.ok) throw new Error(saved.error);
      // AC4:final 仍指向交付版本;新版本的 finalVersionId 回报不变。
      expect(saved.revision.finalVersionId).toBe(fixture.versionId);
      const collection = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: fixture.collectionId,
      });
      expect(collection?.finalVersionId).toBe(fixture.versionId);
      expect(collection?.currentVersionId).toBe(saved.revision.versionId);
    });

    test('AC11 入口:getOutputPackage 只对 rejected/changes_requested 的 Markdown 成员下发 revise-version', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      // 无 review → pending:无 revise 动作。
      const pending = await s.app.getOutputPackage({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId, packageId: fixture.packageId,
      });
      expect(pending.ok).toBe(true);
      if (!pending.ok) throw new Error(pending.error);
      expect(pending.availableActions[0]?.actions ?? []).not.toContain('revise-version');

      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const rejected = await s.app.getOutputPackage({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId, packageId: fixture.packageId,
      });
      if (!rejected.ok) throw new Error(rejected.error);
      expect(rejected.availableActions[0]?.actions).toContain('revise-version');
      expect(rejected.availableActions[0]?.latestReviewId).toBe(reviewId);
    });

    test('current projection 前移后为当前版本下发审核与修订动作', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const deliveredReviewId = await seedNegativeReview(s.repositories, s, fixture);
      const saved = await s.app.saveArtifactVersionRevision(saveInput(s, fixture, deliveredReviewId));
      if (!saved.ok) throw new Error(saved.error);

      const currentVersionId = saved.revision.versionId;
      const currentReviewId = `review-${currentVersionId}`;
      const appended = await s.repositories.channelProjects.appendArtifactReview({
        review: {
          id: currentReviewId,
          teamId: s.teamId,
          channelId: s.channelId,
          collectionId: fixture.collectionId,
          versionId: currentVersionId,
          authorityBasis: 'team-owner',
          decision: 'changes_requested',
          comment: '当前修订仍需修改',
          basis: [],
          reviewedBy: s.userId,
          createdAt: 700,
        },
        mutation: {
          teamId: s.teamId,
          channelId: s.channelId,
          idempotencyKey: `seed-review:${currentReviewId}`,
          requestFingerprint: `fp-${currentReviewId}`,
          kind: 'review',
          collectionId: fixture.collectionId,
          versionId: currentVersionId,
          reviewId: currentReviewId,
          createdAt: 700,
        },
      });
      expect(appended.kind).toBe('created');

      const detail = await s.app.getOutputPackage({
        userId: s.userId,
        teamId: s.teamId,
        channelId: s.channelId,
        packageId: fixture.packageId,
        projection: { policy: 'current' },
      });
      if (!detail.ok) throw new Error(detail.error);
      expect(detail.projection).toMatchObject({
        status: 'not_ready',
        members: [expect.objectContaining({ versionId: currentVersionId, reviewState: 'changes_requested' })],
      });
      expect(detail.availableActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ versionId: fixture.versionId }),
        expect.objectContaining({
          collectionId: fixture.collectionId,
          versionId: currentVersionId,
          latestReviewId: currentReviewId,
          actions: expect.arrayContaining(['revise-version']),
        }),
      ]));
      const currentActions = detail.availableActions.find((entry) => entry.versionId === currentVersionId)?.actions ?? [];
      expect(currentActions).toContain('review-approved');
      expect(currentActions).toContain('review-changes-requested');
      expect(currentActions).not.toContain('set-final');
      const historicalActions = detail.availableActions
        .find((entry) => entry.versionId === fixture.versionId)?.actions ?? [];
      expect(historicalActions).not.toContain('revise-version');
    });

    test('AC3:library 投影携带 revisionBasis(lineage 可见性)', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      const saved = await s.app.saveArtifactVersionRevision(saveInput(s, fixture, reviewId));
      if (!saved.ok) throw new Error(saved.error);
      const library = await s.app.listProjectArtifactCollections({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
      });
      if (!library.ok) throw new Error(library.error);
      const collection = library.library.collections.find((c) => c.id === fixture.collectionId);
      const revised = collection?.versions.find((v) => v.id === saved.revision.versionId);
      expect(revised?.revisionBasis).toEqual({
        revisedFromVersionId: fixture.versionId,
        basisReviewId: reviewId,
        packageId: fixture.packageId,
        deliveryId: fixture.deliveryId,
      });
      expect(revised?.reviewState).toBe('pending');
      // current 指向新版本;旧版本保持 delivered 事实。
      expect(collection?.currentVersionId).toBe(saved.revision.versionId);
    });

    test('#1065 AC5:library 版本携带 packageMemberships(交付包归属由 Server 投影)', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const library = await s.app.listProjectArtifactCollections({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
      });
      if (!library.ok) throw new Error(library.error);
      const collection = library.library.collections.find((c) => c.id === fixture.collectionId);
      const delivered = collection?.versions.find((v) => v.id === fixture.versionId);
      // 交付形成的版本 → 归属该 package(F1)。
      expect(delivered?.packageMemberships).toEqual([
        {
          packageId: fixture.packageId,
          sequence: 1,
          shortLabel: 'F1',
          deliveredAt: delivered!.createdAt,
          taskId: fixture.taskId,
        },
      ]);
    });

    test('原子性:事务中段失败(artifact 主键被占)→ 零部分行', async () => {
      const s = await makeSeed();
      const fixture = await seedPackage(s.repositories, s);
      const reviewId = await seedNegativeReview(s.repositories, s, fixture);
      // 仓储 seam 直测:预占 artifact 主键,迫使事务在 INSERT artifact 处失败;
      // 断言 version/collection/receipt 全部不出现(事务整体回滚)。
      const collection = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: fixture.collectionId,
      });
      const collisionArtifactId = 'art-collision';
      await s.repositories.artifacts.create({
        id: collisionArtifactId,
        teamId: s.teamId,
        channelId: s.channelId,
        uploaderId: s.userId,
        filename: 'collision.md',
        mimeType: 'text/markdown',
        sizeBytes: 1,
        pathKind: 'upload',
        createdAt: 700,
      });
      const commit = await s.repositories.artifactRevisions.recordArtifactVersionRevision({
        teamId: s.teamId,
        channelId: s.channelId,
        expectedCollectionRevision: collection!.revision,
        expectedCurrentVersionId: fixture.versionId,
        collection: {
          ...collection!,
          revision: collection!.revision + 1,
          currentVersionId: 'ver-new',
          versionCount: collection!.versionCount + 1,
          updatedAt: 800,
        },
        artifact: {
          id: collisionArtifactId,
          teamId: s.teamId,
          channelId: s.channelId,
          uploaderId: s.userId,
          filename: 'report.md',
          mimeType: 'text/markdown',
          sizeBytes: 10,
          pathKind: 'upload',
          role: 'attachment',
          createdAt: 800,
        },
        version: {
          id: 'ver-new',
          teamId: s.teamId,
          channelId: s.channelId,
          collectionId: fixture.collectionId,
          versionNumber: 2,
          artifactId: collisionArtifactId,
          taskId: fixture.taskId,
          taskRevision: 1,
          lineage: [{ kind: 'project_version', refId: fixture.versionId }],
          promotedBy: s.userId,
          revisedFromVersionId: fixture.versionId,
          revisionBasisReviewId: reviewId,
          createdAt: 800,
        },
        receipt: {
          receiptId: 'rcpt-rev-1',
          teamId: s.teamId,
          commandName: 'save-artifact-version-revision',
          commandSchemaVersion: 1,
          idempotencyKey: 'revise:atomicity',
          commandHash: 'h',
          outcome: 'applied',
          committedRevisions: [],
          eventRefs: [],
          commitTime: 800,
          resultAvailable: true,
          createdAt: 800,
        },
        tombstone: {
          id: 'tomb-rev-1',
          teamId: s.teamId,
          commandName: 'save-artifact-version-revision',
          idempotencyKey: 'revise:atomicity',
          commandHash: 'h',
          receiptId: 'rcpt-rev-1',
          outcome: 'applied',
          resultAvailable: true,
          createdAt: 800,
        },
      });
      expect(commit.kind).toBe('conflict');
      // 零部分行:无新版本、current 未动、receipt 未写。
      const versions = await s.repositories.channelProjects.listArtifactVersions({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(versions).toHaveLength(1);
      const after = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: fixture.collectionId,
      });
      expect(after?.currentVersionId).toBe(fixture.versionId);
      const receipt = await s.repositories.artifactRevisions.receipts.getByIdempotencyKey({
        teamId: s.teamId, idempotencyKey: 'revise:atomicity',
      });
      expect(receipt).toBeNull();
    });
  });
}
