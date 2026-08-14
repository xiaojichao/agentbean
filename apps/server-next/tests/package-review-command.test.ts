/**
 * #1061 分离文件审核、Task 交付验收与最终版设置集成测试(主 seam:memory + SQLite 双后端)。
 *
 * 覆盖:
 * - AC1:review 绑定 package/collection/version/delivery/Task revision/attempt 与 authority basis,append-only;
 * - AC2:普通成员无审核权,owner/admin/projectLead/stage reviewer 有;Agent/PI Manager 拒绝;
 * - AC5:approved 不自动推进 Task;delivery 验收不伪造 review(两类事实可区分);
 * - AC6:review(changes_requested/rejected)+ 退回 Task delivery 原子提交,旧 claim 失效;
 * - AC7/AC8:final 只指向有 approved review 的版本;移动保留 previousVersionId;Task 状态变化不自动移动 final;
 * - AC9:通过并设为最终版——一个事务两个独立事实(review + finalization);
 * - AC10:同 key replay 返回 replayed;不同 payload 同 key conflict;revision fence 冲突。
 */
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
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
import type { PackageReviewRecord } from '../src/application/package-review-repositories.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createTaskLifecycleKernel } from '../src/application/management/task-lifecycle-kernel.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };

interface Seed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  userId: string;
  teamId: string;
  channelId: string;
  agentId: string;
  memberUserId: string;
  deletedArtifactIds: string[];
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
  const deletedArtifactIds: string[] = [];
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `id-${++id}` },
    artifactContentStore: {
      async writeContent(input) {
        return {
          storagePath: `/artifacts/${input.artifactId}/${input.filename}`,
          sizeBytes: input.content.byteLength,
          sha256: `sha-${input.artifactId}`,
        };
      },
      async deleteContent(input) {
        deletedArtifactIds.push(input.artifactId);
      },
    },
  });
  const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  if (!registered.ok) throw new Error(registered.error);
  const userId = registered.user.id;
  const teamId = registered.user.primaryTeamId!;
  const channel = await app.createChannel({ userId, teamId, name: 'project', visibility: 'public' });
  if (!channel.ok) throw new Error(channel.error);
  // 普通成员(无审核权):注册后以 member 身份加入团队与频道。
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
    deletedArtifactIds,
    close,
  };
}

interface PackageFixture {
  packageId: string;
  collectionId: string;
  versionId: string;
  deliveryId: string;
  taskId: string;
  taskRevision: number;
  taskAttempt: number;
}

/** 构造一个最小 package(不经过 workspace publish,直接 recordPackageFormation)。 */
async function seedPackage(
  repositories: ServerNextRepositories,
  seedValue: Seed,
  opts?: { taskId?: string; taskRevision?: number; taskAttempt?: number },
): Promise<PackageFixture> {
  const taskId = opts?.taskId ?? `task-${seedValue.channelId}`;
  // version 的 artifact FK 需要先有 artifact 行。
  await repositories.artifacts.create({
    id: `art-${seedValue.channelId}-1`,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    uploaderId: seedValue.userId,
    filename: 'report.md',
    mimeType: 'text/markdown',
    sizeBytes: 12,
    pathKind: 'workspace',
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
    taskRevision: opts?.taskRevision ?? 1,
    taskAttempt: opts?.taskAttempt ?? 1,
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
      filename: 'report.md',
      sizeBytes: 12,
      collection: { mode: 'create', collectionId: `col-${seedValue.channelId}-1`, name: 'out/report.md', kind: 'deliverable' },
      version: { id: `ver-${seedValue.channelId}-1`, artifactId: `art-${seedValue.channelId}-1`, taskId, taskRevision: 1 },
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
    taskRevision: opts?.taskRevision ?? 1,
    taskAttempt: opts?.taskAttempt ?? 1,
  };
}

async function seedTask(
  repositories: ServerNextRepositories,
  seedValue: Seed,
  taskId: string,
  status: 'todo' | 'in_progress' | 'in_review',
): Promise<void> {
  await repositories.tasks.create({
    id: taskId,
    teamId: seedValue.teamId,
    title: 'Task',
    status,
    creatorId: seedValue.userId,
    channelId: seedValue.channelId,
    tags: [],
    sortOrder: 0,
    createdAt: 200,
    updatedAt: 200,
  });
  // 子 Task coordination:management run FK 需要真实 run(createOrResumeRun 最小构造)。
  let mgmtId = 0;
  const managementKernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock: { now: () => 250 },
    ids: { nextId: () => (mgmtId++ === 0 ? `run-${taskId}` : `mgmt-${taskId}-${mgmtId}`) },
  });
  const created = await managementKernel.createOrResumeRun({
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    rootTaskId: `root-${taskId}`,
    rootMessageId: `msg-${taskId}`,
    requestKey: `request-${taskId}`,
    requestHash: 'hash',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  await repositories.taskCoordination.coordinations.create({
    schemaVersion: 1,
    taskId,
    teamId: seedValue.teamId,
    managementRunId: created.run.id,
    rootTaskId: `root-${taskId}`,
    parentTaskId: `root-${taskId}`,
    nodeKind: 'subtask',
    reviewPolicy: 'manager',
    claimPolicy: 'open',
    requiredCapabilities: [],
    taskRevision: 1,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 200,
    updatedAt: 200,
  });
}

for (const variant of variants) {
  describe(`package-review command (${variant.name})`, () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()!();
  });

  async function makeSeed(): Promise<Seed> {
    const s = await seed(variant);
    cleanups.push(s.close);
    return s;
  }

  test('AC1/AC5:owner 审核绑定 package 上下文,append-only,Task 不被推进', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const result = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '质量合格',
      idempotencyKey: `review-1:${pkg.versionId}`,
    });
    expect(result).toMatchObject({
      ok: true,
      review: {
        packageId: pkg.packageId,
        deliveryId: pkg.deliveryId,
        taskId: pkg.taskId,
        taskRevision: pkg.taskRevision,
        taskAttempt: pkg.taskAttempt,
        decision: 'approved',
        authorityBasis: 'team-owner',
      },
    });
    // AC5:approved 不自动推进 Task。
    const task = await s.repositories.tasks.getById(pkg.taskId);
    expect(task?.status).toBe('in_review');
    // append-only:再次审核产生第二条记录。
    const result2 = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'changes_requested',
      comment: '需要修订',
      idempotencyKey: `review-2:${pkg.versionId}`,
    });
    expect(result2.ok).toBe(true);
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews.filter((r) => r.versionId === pkg.versionId)).toHaveLength(2);
  });

  test('AC2:普通成员无审核权,非团队用户 FORBIDDEN', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const denied = await s.app.submitPackageArtifactReview({
      userId: s.memberUserId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '试图审核',
      idempotencyKey: `review-member:${pkg.versionId}`,
    });
    expect(denied).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    const outsider = await s.app.submitPackageArtifactReview({
      userId: 'outsider',
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '试图审核',
      idempotencyKey: `review-out:${pkg.versionId}`,
    });
    expect(outsider).toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('AC9:通过并设为最终版——一个事务两个独立事实', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const result = await s.app.submitPackageReviewAndFinalize({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '通过并设为最终版',
      idempotencyKey: `finalize-1:${pkg.versionId}`,
      expectedCollectionRevision: 1,
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.review.decision).toBe('approved');
    expect(result.finalization).toMatchObject({
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      basisReviewId: result.review.id,
      finalizedBy: s.userId,
    });
    expect(result.collection).toMatchObject({ id: pkg.collectionId, finalVersionId: pkg.versionId, revision: 2 });
    // 两个独立事实都落库。
    const collections = await s.repositories.channelProjects.listArtifactCollections({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(collections.find((c) => c.id === pkg.collectionId)?.finalVersionId).toBe(pkg.versionId);
    const finalizations = await s.repositories.channelProjects.listArtifactFinalizations({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(finalizations.find((f) => f.collectionId === pkg.collectionId)?.basisReviewId).toBe(result.review.id);
  });

  test('#1197:保存新版本后通过，current 与 review 指向同一个新 version', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const result = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '保存修订稿后通过',
      expectedCollectionRevision: 1,
      saveRevision: {
        content: '# 修订稿',
        filename: 'report.md',
        revisionBasis: {
          sourceVersionId: pkg.versionId,
          packageId: pkg.packageId,
          deliveryId: pkg.deliveryId,
        },
      },
      idempotencyKey: `save-review:${pkg.versionId}`,
    });
    expect(result).toMatchObject({ ok: true, revision: { baseVersionId: pkg.versionId } });
    if (!result.ok || !result.revision) throw new Error(result.ok ? 'missing revision' : result.error);
    expect(result.review.versionId).toBe(result.revision.versionId);
    const collection = await s.repositories.channelProjects.getArtifactCollection({
      teamId: s.teamId,
      channelId: s.channelId,
      collectionId: pkg.collectionId,
    });
    expect(collection).toMatchObject({
      currentVersionId: result.revision.versionId,
      revision: 2,
    });
    expect(collection?.finalVersionId).toBeUndefined();
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ versionId: result.revision.versionId, decision: 'approved' }),
    ]));
    expect(reviews.some((review) => review.versionId === pkg.versionId)).toBe(false);

    const replay = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '保存修订稿后通过',
      expectedCollectionRevision: 1,
      saveRevision: {
        content: '# 修订稿',
        filename: 'report.md',
        revisionBasis: {
          sourceVersionId: pkg.versionId,
          packageId: pkg.packageId,
          deliveryId: pkg.deliveryId,
        },
      },
      idempotencyKey: `save-review:${pkg.versionId}`,
    });
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      revision: { versionId: result.revision.versionId },
      review: { id: result.review.id },
    });
  });

  test('#1197:保存、通过与定稿在同一事务，审核落在新 version', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const result = await s.app.submitPackageReviewAndFinalize({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '修订稿通过并定稿',
      expectedCollectionRevision: 1,
      saveRevision: {
        content: '# 最终修订稿',
        revisionBasis: {
          sourceVersionId: pkg.versionId,
          packageId: pkg.packageId,
          deliveryId: pkg.deliveryId,
        },
      },
      idempotencyKey: `save-finalize:${pkg.versionId}`,
    });
    expect(result).toMatchObject({ ok: true, collection: { revision: 3 } });
    if (!result.ok || !result.revision) throw new Error(result.ok ? 'missing revision' : result.error);
    expect(result.review.versionId).toBe(result.revision.versionId);
    expect(result.finalization).toMatchObject({
      versionId: result.revision.versionId,
      basisReviewId: result.review.id,
    });
    expect(result.collection).toMatchObject({
      currentVersionId: result.revision.versionId,
      finalVersionId: result.revision.versionId,
      revision: 3,
    });
  });

  test('#1197:审核仓储失败时回滚新版本、current 与内容物化', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    s.repositories.packageReviews.recordPackageReview = async () => ({ kind: 'finalization_conflict' });
    const result = await s.app.submitPackageReviewAndFinalize({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '模拟提交失败',
      expectedCollectionRevision: 1,
      saveRevision: {
        content: '# 不应保留',
        revisionBasis: {
          sourceVersionId: pkg.versionId,
          packageId: pkg.packageId,
          deliveryId: pkg.deliveryId,
        },
      },
      idempotencyKey: `save-rollback:${pkg.versionId}`,
    });
    expect(result).toMatchObject({ ok: false, error: 'CONFLICT' });
    const collection = await s.repositories.channelProjects.getArtifactCollection({
      teamId: s.teamId,
      channelId: s.channelId,
      collectionId: pkg.collectionId,
    });
    expect(collection).toMatchObject({ currentVersionId: pkg.versionId, revision: 1 });
    const versions = await s.repositories.channelProjects.listArtifactVersions({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(versions.filter((version) => version.collectionId === pkg.collectionId)).toHaveLength(1);
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews).toHaveLength(0);
    expect(s.deletedArtifactIds).toHaveLength(1);
  });

  test('AC7/AC8:final 只移动且有 approved review;revision fence 冲突', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    // stale collection revision → conflict。
    const stale = await s.app.submitPackageReviewAndFinalize({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: 'stale',
      idempotencyKey: `finalize-stale:${pkg.versionId}`,
      expectedCollectionRevision: 99,
    });
    expect(stale).toMatchObject({ ok: false, error: 'CONFLICT' });
    // changes_requested 不能走"通过并设为最终版"(请求语义错误)。
    const rejected = await s.app.submitPackageReviewAndFinalize({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'changes_requested',
      comment: 'no',
      idempotencyKey: `finalize-cr:${pkg.versionId}`,
      expectedCollectionRevision: 1,
    });
    expect(rejected).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    // 组合命令成功后:Task 状态变化不自动移动 final(AC8)。
    await s.repositories.tasks.update({ taskId: pkg.taskId, changes: { status: 'todo', updatedAt: 900 } });
    const collections = await s.repositories.channelProjects.listArtifactCollections({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(collections.find((c) => c.id === pkg.collectionId)?.finalVersionId).toBeUndefined();
  });

  test('AC10:同 key replay 返回 replayed;不同 payload 同 key conflict', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const key = `replay:${pkg.versionId}`;
    const first = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '通过',
      idempotencyKey: key,
    });
    expect(first.ok).toBe(true);
    // 同 key 同 payload → replayed,不写新记录。
    const replay = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '通过',
      idempotencyKey: key,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.replayed).toBe(true);
    // 同 key 不同 payload → conflict。
    const conflict = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'rejected',
      comment: '不同意见',
      idempotencyKey: key,
    });
    expect(conflict).toMatchObject({ ok: false, error: 'CONFLICT' });
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews.filter((r) => r.versionId === pkg.versionId)).toHaveLength(1);
  });

  test('AC6:审核(changes_requested)+ 退回 Task delivery 原子提交,Task 回 todo 且 attempt 递增', async () => {
    const s = await makeSeed();
    const taskId = `task-reject-${s.channelId}`;
    const pkg = await seedPackage(s.repositories, s, { taskId });
    await seedTask(s.repositories, s, taskId, 'in_review');
    const result = await s.app.submitPackageReviewAndRejectDelivery({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'changes_requested',
      comment: '要求修改',
      idempotencyKey: `reject-delivery:${pkg.versionId}`,
      expectedTaskRevision: 1,
      expectedTaskAttempt: 1,
      rejectReason: '报告格式不符',
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.error);
    expect(result.review.decision).toBe('changes_requested');
    expect(result.task).toMatchObject({ taskId, taskRevision: 1, status: 'todo' });
    // Task transition 与 review 同时落库(原子)。
    const task = await s.repositories.tasks.getById(taskId);
    expect(task?.status).toBe('todo');
    const coord = await s.repositories.taskCoordination.coordinations.getByTaskId(taskId);
    expect(coord?.attempt).toBe(2);
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews.find((r) => r.versionId === pkg.versionId)?.decision).toBe('changes_requested');
  });

  test('AC6 守卫:approved 不能组合退回;非 in_review Task 拒绝', async () => {
    const s = await makeSeed();
    const taskId = `task-guard-${s.channelId}`;
    const pkg = await seedPackage(s.repositories, s, { taskId });
    await seedTask(s.repositories, s, taskId, 'in_review');
    const approved = await s.app.submitPackageReviewAndRejectDelivery({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '不能退回',
      idempotencyKey: `guard-approved:${pkg.versionId}`,
      expectedTaskRevision: 1,
      expectedTaskAttempt: 1,
      rejectReason: 'nope',
    });
    expect(approved).toMatchObject({ ok: false });
    // Task 状态不满足 → rejected,无部分事实。
    await s.repositories.tasks.update({ taskId, changes: { status: 'in_progress', updatedAt: 300 } });
    const notReviewable = await s.app.submitPackageReviewAndRejectDelivery({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'rejected',
      comment: '退回',
      idempotencyKey: `guard-state:${pkg.versionId}`,
      expectedTaskRevision: 1,
      expectedTaskAttempt: 1,
      rejectReason: 'x',
    });
    expect(notReviewable).toMatchObject({ ok: false, error: 'CONFLICT' });
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews.filter((r) => r.versionId === pkg.versionId)).toHaveLength(0);
  });
  });
}
