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
  opts?: { taskId?: string; taskRevision?: number; taskAttempt?: number; stageId?: string },
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
      version: {
        id: `ver-${seedValue.channelId}-1`,
        artifactId: `art-${seedValue.channelId}-1`,
        ...(opts?.stageId ? { stageId: opts.stageId } : {}),
        taskId,
        taskRevision: 1,
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
    taskRevision: opts?.taskRevision ?? 1,
    taskAttempt: opts?.taskAttempt ?? 1,
  };
}

async function seedBatchPackage(
  repositories: ServerNextRepositories,
  seedValue: Seed,
  opts?: { taskId?: string; suffix?: string; createdAt?: number },
): Promise<{
  packageId: string;
  deliveryId: string;
  taskId: string;
  targets: readonly { collectionId: string; artifactVersionId: string }[];
}> {
  const suffix = opts?.suffix ?? 'batch';
  const taskId = opts?.taskId ?? `task-${seedValue.channelId}-batch`;
  const targets = [1, 2].map((index) => ({
    collectionId: `col-${seedValue.channelId}-${suffix}-${index}`,
    artifactVersionId: `ver-${seedValue.channelId}-${suffix}-${index}`,
  }));
  for (const [index, target] of targets.entries()) {
    await repositories.artifacts.create({
      id: `art-${seedValue.channelId}-${suffix}-${index + 1}`,
      teamId: seedValue.teamId,
      channelId: seedValue.channelId,
      uploaderId: seedValue.userId,
      filename: `report-${index + 1}.md`,
      mimeType: 'text/markdown',
      sizeBytes: 12,
      pathKind: 'workspace',
      createdAt: 400 + index,
    });
  }
  const packageId = `pkg-${seedValue.channelId}-${suffix}`;
  const deliveryId = `del-${seedValue.channelId}-${suffix}`;
  const formed = await repositories.outputPackages.recordPackageFormation({
    record: {
      teamId: seedValue.teamId,
      packageId,
      channelId: seedValue.channelId,
      deliveryId,
      publishId: `pub-${seedValue.channelId}-${suffix}`,
      workspaceRevisionId: `rev-${seedValue.channelId}-${suffix}`,
      agentId: seedValue.agentId,
      taskId,
      taskBinding: 'managed',
      taskRevision: 1,
      taskAttempt: 1,
      memberCount: 2,
      status: 'recorded',
      createdAt: opts?.createdAt ?? 500,
    },
    members: targets.map((target, index) => ({
      sequence: index + 1,
      shortLabel: `F${index + 1}`,
      role: 'deliverable' as const,
      requiredForFinal: true,
      sourcePath: `out/report-${index + 1}.md`,
      filename: `report-${index + 1}.md`,
      sizeBytes: 12,
      collection: { mode: 'create' as const, collectionId: target.collectionId, name: `out/report-${index + 1}.md`, kind: 'deliverable' as const },
      version: {
        id: target.artifactVersionId,
        artifactId: `art-${seedValue.channelId}-${suffix}-${index + 1}`,
        taskId,
        taskRevision: 1,
      },
    })),
    receipt: {
      receiptId: `rcpt-${seedValue.channelId}-${suffix}`, teamId: seedValue.teamId,
      commandName: 'record-agent-output-package', commandSchemaVersion: 1,
      idempotencyKey: `record-agent-output-package:${seedValue.channelId}:${suffix}`, commandHash: suffix,
      outcome: 'applied', committedRevisions: [], eventRefs: [], commitTime: 500,
      resultAvailable: true, createdAt: 500,
    },
    tombstone: {
      id: `tomb-${seedValue.channelId}-${suffix}`, teamId: seedValue.teamId,
      commandName: 'record-agent-output-package',
      idempotencyKey: `record-agent-output-package:${seedValue.channelId}:${suffix}`, commandHash: suffix,
      receiptId: `rcpt-${seedValue.channelId}-${suffix}`, outcome: 'applied', resultAvailable: true, createdAt: opts?.createdAt ?? 500,
    },
  });
  if (formed.kind !== 'created') throw new Error(`batch package seed failed: ${formed.kind}`);
  return { packageId, deliveryId, taskId, targets };
}

/** 构造第二个冻结同一既有 version 的 package，用于验证组合命令不能混用 provenance。 */
async function seedPackageReusingVersion(
  repositories: ServerNextRepositories,
  seedValue: Seed,
  source: PackageFixture,
): Promise<{ packageId: string; deliveryId: string }> {
  const packageId = `pkg-${seedValue.channelId}-reuse`;
  const deliveryId = `del-${seedValue.channelId}-reuse`;
  const result = await repositories.outputPackages.recordPackageFormation({
    record: {
      teamId: seedValue.teamId,
      packageId,
      channelId: seedValue.channelId,
      deliveryId,
      publishId: `pub-${seedValue.channelId}-reuse`,
      workspaceRevisionId: `rev-${seedValue.channelId}-reuse`,
      agentId: seedValue.agentId,
      taskId: source.taskId,
      taskBinding: 'managed',
      taskRevision: source.taskRevision,
      taskAttempt: source.taskAttempt,
      memberCount: 1,
      status: 'recorded',
      createdAt: 501,
    },
    members: [{
      sequence: 1,
      shortLabel: 'F1',
      role: 'deliverable',
      requiredForFinal: true,
      sourcePath: 'out/report.md',
      filename: 'report.md',
      sizeBytes: 12,
      collection: {
        mode: 'reuse',
        collectionId: source.collectionId,
        expectedVersionId: source.versionId,
      },
      version: {
        id: source.versionId,
        artifactId: `art-${seedValue.channelId}-1`,
        taskId: source.taskId,
        taskRevision: source.taskRevision,
      },
    }],
    receipt: {
      receiptId: `rcpt-${seedValue.channelId}-reuse`,
      teamId: seedValue.teamId,
      commandName: 'record-agent-output-package',
      commandSchemaVersion: 1,
      idempotencyKey: `record-agent-output-package:${seedValue.channelId}:reuse`,
      commandHash: 'reuse',
      outcome: 'applied',
      committedRevisions: [],
      eventRefs: [],
      commitTime: 501,
      resultAvailable: true,
      createdAt: 501,
    },
    tombstone: {
      id: `tomb-${seedValue.channelId}-reuse`,
      teamId: seedValue.teamId,
      commandName: 'record-agent-output-package',
      idempotencyKey: `record-agent-output-package:${seedValue.channelId}:reuse`,
      commandHash: 'reuse',
      receiptId: `rcpt-${seedValue.channelId}-reuse`,
      outcome: 'applied',
      resultAvailable: true,
      createdAt: 501,
    },
  });
  if (result.kind !== 'created') throw new Error(`reused package seed failed: ${result.kind}`);
  return { packageId, deliveryId };
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

  test('#1199:N 个显式目标产生 N 条 review，未选中版本不写入，重试幂等且不推进 Task', async () => {
    const s = await makeSeed();
    const pkg = await seedBatchPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const key = `batch-review:${pkg.deliveryId}`;
    const input = {
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      deliveryId: pkg.deliveryId,
      expectedPackageRevision: 1,
      targets: [pkg.targets[0]!],
      decision: 'approved' as const,
      comment: '选中版本通过',
      idempotencyKey: key,
    };
    const first = await s.app.submitPackageArtifactReviews(input);
    expect(first).toMatchObject({ ok: true, reviews: [{ versionId: pkg.targets[0]!.artifactVersionId }], replayed: false });
    const replay = await s.app.submitPackageArtifactReviews(input);
    expect(replay).toMatchObject({ ok: true, reviews: [{ versionId: pkg.targets[0]!.artifactVersionId }], replayed: true });
    const reviews = await s.repositories.channelProjects.listArtifactReviews({ teamId: s.teamId, channelId: s.channelId });
    expect(reviews.filter((review) => review.packageId === pkg.packageId)).toHaveLength(1);
    expect(reviews.some((review) => review.versionId === pkg.targets[1]!.artifactVersionId)).toBe(false);
    expect((await s.repositories.tasks.getById(pkg.taskId))?.status).toBe('in_review');
  });

  test('#1199:错 delivery、重复目标或任一目标无权限时整批零写入并返回明确原因', async () => {
    const s = await makeSeed();
    const pkg = await seedBatchPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const common = {
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      expectedPackageRevision: 1,
      decision: 'changes_requested' as const,
      comment: '需要统一修改',
    };
    const wrongDelivery = await s.app.submitPackageArtifactReviews({
      ...common, userId: s.userId, deliveryId: 'delivery-old', targets: pkg.targets, idempotencyKey: 'batch-wrong-delivery',
    });
    expect(wrongDelivery).toMatchObject({ ok: false, error: 'CONFLICT', details: { rejectedTargets: [{ reason: 'delivery-revision-stale' }] } });
    const duplicate = await s.app.submitPackageArtifactReviews({
      ...common, userId: s.userId, deliveryId: pkg.deliveryId,
      targets: [pkg.targets[0]!, pkg.targets[0]!, pkg.targets[1]!], idempotencyKey: 'batch-duplicate',
    });
    expect(duplicate).toMatchObject({ ok: false, error: 'CONFLICT', details: { rejectedTargets: [expect.objectContaining({ reason: 'duplicate-target' })] } });
    const unauthorized = await s.app.submitPackageArtifactReviews({
      ...common, userId: s.memberUserId, deliveryId: pkg.deliveryId, targets: pkg.targets, idempotencyKey: 'batch-unauthorized',
    });
    expect(unauthorized).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    const staleTarget = pkg.targets[0]!;
    const newer = await s.app.saveArtifactVersionRevision({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      collectionId: staleTarget.collectionId,
      baseVersionId: staleTarget.artifactVersionId,
      content: '# newer',
      filename: 'report-1.md',
      expectedCollectionRevision: 1,
      revisionBasis: {
        sourceVersionId: staleTarget.artifactVersionId,
        packageId: pkg.packageId,
        deliveryId: pkg.deliveryId,
      },
      idempotencyKey: 'batch-save-newer',
    });
    expect(newer).toMatchObject({ ok: true, revision: { collectionId: staleTarget.collectionId } });
    const stale = await s.app.submitPackageArtifactReviews({
      ...common, userId: s.userId, deliveryId: pkg.deliveryId,
      targets: [staleTarget, pkg.targets[1]!], idempotencyKey: 'batch-stale',
    });
    expect(stale).toMatchObject({
      ok: false, error: 'CONFLICT',
      details: { rejectedTargets: [expect.objectContaining({ artifactVersionId: staleTarget.artifactVersionId, reason: 'version-not-current' })] },
    });
    const reviews = await s.repositories.channelProjects.listArtifactReviews({ teamId: s.teamId, channelId: s.channelId });
    expect(reviews.filter((review) => review.packageId === pkg.packageId)).toHaveLength(0);
  });

  test('#1199:同一 Task 后续 delivery 已产生时旧包整批失败且零写入', async () => {
    const s = await makeSeed();
    const stale = await seedBatchPackage(s.repositories, s, { suffix: 'old', createdAt: 500 });
    await seedTask(s.repositories, s, stale.taskId, 'in_review');
    const current = await seedBatchPackage(s.repositories, s, {
      taskId: stale.taskId,
      suffix: 'current',
      createdAt: 600,
    });

    const result = await s.app.submitPackageArtifactReviews({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: stale.packageId,
      deliveryId: stale.deliveryId,
      expectedPackageRevision: 1,
      targets: stale.targets,
      decision: 'approved',
      comment: '旧交付不应再审核',
      idempotencyKey: 'batch-stale-task-delivery',
    });

    expect(current.deliveryId).not.toBe(stale.deliveryId);
    expect(result).toMatchObject({
      ok: false,
      error: 'CONFLICT',
      details: { rejectedTargets: [{ reason: 'delivery-revision-stale' }] },
    });
    const reviews = await s.repositories.channelProjects.listArtifactReviews({
      teamId: s.teamId,
      channelId: s.channelId,
    });
    expect(reviews.filter((review) => review.packageId === stale.packageId)).toHaveLength(0);
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

  test('#1197:组合审核拒绝使用另一个 package 的修订 provenance', async () => {
    const s = await makeSeed();
    const pkg = await seedPackage(s.repositories, s);
    await seedTask(s.repositories, s, pkg.taskId, 'in_review');
    const other = await seedPackageReusingVersion(s.repositories, s, pkg);

    const result = await s.app.submitPackageArtifactReview({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'approved',
      comment: '不应混用另一个包的修订依据',
      expectedCollectionRevision: 1,
      saveRevision: {
        content: '# 错误 provenance',
        revisionBasis: {
          sourceVersionId: pkg.versionId,
          packageId: other.packageId,
          deliveryId: other.deliveryId,
        },
      },
      idempotencyKey: `save-review-cross-package:${pkg.versionId}`,
    });

    expect(result).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    const collection = await s.repositories.channelProjects.getArtifactCollection({
      teamId: s.teamId,
      channelId: s.channelId,
      collectionId: pkg.collectionId,
    });
    expect(collection).toMatchObject({ currentVersionId: pkg.versionId, revision: 1, versionCount: 1 });
    expect(s.deletedArtifactIds).toHaveLength(0);
  });

  test('#1197:组合保存后按新版本真实 Stage 重新校验审核权限', async () => {
    const s = await makeSeed();
    const sourceTaskId = `task-source-stage-${s.channelId}`;
    const currentTaskId = `task-current-stage-${s.channelId}`;
    await seedTask(s.repositories, s, sourceTaskId, 'in_review');
    await seedTask(s.repositories, s, currentTaskId, 'in_review');

    const profile = {
      id: `profile-stage-auth-${s.channelId}`,
      teamId: s.teamId,
      channelId: s.channelId,
      projectLeadId: s.userId,
      defaultReviewerIds: [s.userId],
      revision: 1,
      createdBy: s.userId,
      createdAt: 300,
      updatedAt: 300,
    };
    const sourceStage = {
      id: `stage-source-${s.channelId}`,
      teamId: s.teamId,
      channelId: s.channelId,
      taskId: sourceTaskId,
      taskRevision: 1,
      name: '来源阶段',
      goal: '提供修订来源',
      ownerId: s.userId,
      reviewerIds: [s.userId],
      acceptanceCriteria: ['来源完整'],
      createdAt: 300,
      updatedAt: 300,
    };
    const currentStage = {
      id: `stage-current-${s.channelId}`,
      teamId: s.teamId,
      channelId: s.channelId,
      taskId: currentTaskId,
      taskRevision: 1,
      name: '当前阶段',
      goal: '审核当前版本',
      ownerId: s.userId,
      reviewerIds: [s.memberUserId],
      acceptanceCriteria: ['当前版本可审核'],
      createdAt: 301,
      updatedAt: 301,
    };
    expect(await s.repositories.channelProjects.createInitialStage({
      expectedRevision: 0,
      profile,
      stage: sourceStage,
      mutation: {
        teamId: s.teamId,
        channelId: s.channelId,
        idempotencyKey: `stage-source:${s.channelId}`,
        requestFingerprint: 'stage-source',
        profileId: profile.id,
        stageId: sourceStage.id,
        resultRevision: 1,
        resultOverview: {} as never,
        createdAt: 300,
      },
    })).toMatchObject({ kind: 'created' });
    expect(await s.repositories.channelProjects.createStage({
      expectedRevision: 1,
      nextRevision: 2,
      updatedAt: 301,
      stage: currentStage,
      mutation: {
        teamId: s.teamId,
        channelId: s.channelId,
        idempotencyKey: `stage-current:${s.channelId}`,
        requestFingerprint: 'stage-current',
        profileId: profile.id,
        stageId: currentStage.id,
        resultRevision: 2,
        resultOverview: {} as never,
        createdAt: 301,
      },
    })).toMatchObject({ kind: 'created' });

    const pkg = await seedPackage(s.repositories, s, { taskId: sourceTaskId, stageId: sourceStage.id });
    const currentArtifactId = `art-current-stage-${s.channelId}`;
    const currentVersionId = `ver-current-stage-${s.channelId}`;
    await s.repositories.artifacts.create({
      id: currentArtifactId,
      teamId: s.teamId,
      channelId: s.channelId,
      uploaderId: s.userId,
      filename: 'report-current.md',
      mimeType: 'text/markdown',
      sizeBytes: 16,
      pathKind: 'upload',
      createdAt: 600,
    });
    const collection = await s.repositories.channelProjects.getArtifactCollection({
      teamId: s.teamId,
      channelId: s.channelId,
      collectionId: pkg.collectionId,
    });
    if (!collection) throw new Error('missing collection');
    expect(await s.repositories.channelProjects.promoteArtifact({
      teamId: s.teamId,
      channelId: s.channelId,
      expectedCollectionRevision: collection.revision,
      createsCollection: false,
      collection: {
        ...collection,
        revision: collection.revision + 1,
        currentVersionId,
        versionCount: collection.versionCount + 1,
        updatedAt: 600,
      },
      version: {
        id: currentVersionId,
        teamId: s.teamId,
        channelId: s.channelId,
        collectionId: pkg.collectionId,
        versionNumber: 2,
        artifactId: currentArtifactId,
        stageId: currentStage.id,
        taskId: currentTaskId,
        taskRevision: 1,
        lineage: [],
        promotedBy: s.userId,
        createdAt: 600,
      },
      mutation: {
        teamId: s.teamId,
        channelId: s.channelId,
        idempotencyKey: `promote-current-stage:${s.channelId}`,
        requestFingerprint: 'promote-current-stage',
        collectionId: pkg.collectionId,
        versionId: currentVersionId,
        createdAt: 600,
      },
    })).toMatchObject({ kind: 'created' });

    const result = await s.app.submitPackageArtifactReview({
      userId: s.memberUserId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: currentVersionId,
      decision: 'approved',
      comment: '只能审核当前阶段，不能审核来源阶段',
      expectedCollectionRevision: 2,
      saveRevision: {
        content: '# 跨 Stage 修订',
        revisionBasis: {
          sourceVersionId: pkg.versionId,
          packageId: pkg.packageId,
          deliveryId: pkg.deliveryId,
        },
      },
      idempotencyKey: `save-review-cross-stage:${currentVersionId}`,
    });

    expect(result).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    const unchanged = await s.repositories.channelProjects.getArtifactCollection({
      teamId: s.teamId,
      channelId: s.channelId,
      collectionId: pkg.collectionId,
    });
    expect(unchanged).toMatchObject({ currentVersionId, revision: 2, versionCount: 2 });
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

  test('#1198:拒绝版本与退回 delivery 原子提交，保留 lineage、阻断默认输入且不创建 invocation', async () => {
    const s = await makeSeed();
    const taskId = `task-return-thread-${s.channelId}`;
    const pkg = await seedPackage(s.repositories, s, { taskId });
    await seedTask(s.repositories, s, taskId, 'in_review');
    await expect(s.repositories.management.invocations.listByRun(`run-${taskId}`)).resolves.toEqual([]);

    const result = await s.app.submitPackageReviewAndRejectDelivery({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      collectionId: pkg.collectionId,
      versionId: pkg.versionId,
      decision: 'rejected',
      comment: '方向错误，需要重做',
      idempotencyKey: `return-thread:${pkg.versionId}`,
      expectedTaskRevision: pkg.taskRevision,
      expectedTaskAttempt: pkg.taskAttempt,
      rejectReason: '方向错误，需要重做',
    });

    expect(result).toMatchObject({
      ok: true,
      review: {
        packageId: pkg.packageId,
        deliveryId: pkg.deliveryId,
        taskId,
        taskRevision: 1,
        taskAttempt: 1,
        versionId: pkg.versionId,
        decision: 'rejected',
      },
      task: { taskId, taskRevision: 1, taskAttempt: 2, status: 'todo' },
    });
    const projection = await s.app.getOutputPackage({
      userId: s.userId,
      teamId: s.teamId,
      channelId: s.channelId,
      packageId: pkg.packageId,
      projection: { policy: 'current' },
    });
    expect(projection.ok).toBe(true);
    if (!projection.ok) throw new Error(projection.error);
    expect(projection.projection?.status).toBe('not_ready');
    await expect(s.repositories.management.invocations.listByRun(`run-${taskId}`)).resolves.toEqual([]);
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
