/**
 * #1178 从任务审核工作区回到讨论串并冻结修改依据 —— Server 集成测试兜底（切片 4）。
 *
 * 设计结论（design.md §0）：Server 零新命令。本文件锁定「阶段交接路径」的组合行为——
 * thread 消息 + package selection（delivered/current 指针或 package_members 显式）+ @Agent，
 * 经 message:send 冻结 ProjectReferenceSet → targeted Offer（frozenInputs）→ acceptance →
 * claim → Invocation（frozen intent）全链路的冻结/追溯/fail-closed 语义。
 *
 * 覆盖（memory + SQLite 双后端）：
 * - AC4：delivered 策略交接 → referenceSet 冻结具体 artifactVersionId，可从消息追溯；
 *   Offer 冻结同一版本；acceptance 前无 claim。
 * - AC7：冻结后 current（append 新版本）与 final（finalize 旧版本）双双漂移 →
 *   历史消息 referenceSet 不变；漂移后创建的 Invocation 仍用 Offer 冻结输入，不重新解析。
 * - AC8：Offer 发布后 acceptance 前 task revision 漂移 → TASK_CLAIM_OFFER_TASK_REVISION_CHANGED；
 *   reject-delivery 推进 attempt → 旧 Offer acceptance TASK_CLAIM_OFFER_STALE；均零部分写。
 * - AC9：跨频道 package 引用 → VALIDATION_ERROR/selections_rejected/package_not_found，
 *   消息不落库、无 Offer。
 * - AC6：reject-delivery 后新 attempt 交接（显式 package_members「基于此修改」）→
 *   冻结旧交付版本，Offer 绑定 attempt 2，acceptance 成功；旧 review/delivery append-only 保留。
 * - AC6 现状特征化：reject（changes_requested）后用 delivered 指针策略交接 →
 *   REVIEW_BASIS_BLOCKED（指针解析不过 review 闸，显式选择才放行）。
 *   ⚠ 这与 design.md §2.3「要求修改后继续」预填 delivered 策略存在张力，见任务报告。
 * - AC10：新 delivery 发布 + review 后，delivery-overview / getOutputPackage / artifact library
 *   / 历史消息 referenceSet 四处读回一致（历史引用不漂移）。
 *
 * 已被既有测试覆盖、本文件不重复（证据见任务报告）：
 * - 发送层频道归档 / 无 authority / @不合格 Agent（task-linked-request-offer.test.ts）；
 * - acceptance 层 CHANNEL_ARCHIVED / FROZEN_BASIS_CHANGED / FROZEN_INPUT_STALE / TTL 过期（同文件）；
 * - current 指针冻结后 append 不改写历史（output-package-reference.test.ts AC8，非 thread 语境）；
 * - 私有频道非成员读/写拒绝（output-package-reference.test.ts AC7）；
 * - minimumConsistency 水位未追上 → PROJECTION_NOT_READY（output-package-consistency.test.ts、
 *   task-delivery-overview.test.ts AC7）；
 * - reject-delivery 原子性与幂等（package-review-command.test.ts AC6/AC10）。
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
  type SendMessageInput,
  type ServerNextUseCases,
} from '../src/application/usecases.js';
import { createTaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };

const TASK_ID = 'task-handoff';
const THREAD_ROOT_ID = 'msg-handoff';
const RUN_ID = 'run-1';
const STAGE_ID = 'stage-1';
const PACKAGE_ID = 'pkg-1';
const COLLECTION_ID = 'col-1';
const VERSION_ID = 'ver-1';
const ARTIFACT_ID = 'art-1';
const DELIVERY_ID = 'del-1';

interface Seed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  userId: string;
  teamId: string;
  channelId: string;
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

/**
 * 阶段交接最小现场：tracked subtask（coordination，maxAttempts 3）+ 绑定讨论串根消息
 * （meta.taskId）+ 绑定 Stage + 已成形的 OutputPackage（delivered=ver-1，collection current=ver-1）
 * + management run/lease（Invocation 用）。
 */
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
  const channelId = channel.channel.id;
  const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-a', hostname: 'device-a' });
  if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
  const agents = await app.registerDiscoveredAgents({
    teamId,
    deviceId: hello.device.id,
    agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
  });
  if (!agents.ok) throw new Error(agents.error);
  const agentId = agents.agents[0]!.id;
  const member = await app.addChannelAgentMember({ userId, teamId, channelId, agentId });
  if (!member.ok) throw new Error(member.error);

  // tracked subtask（阶段任务）。
  await repositories.tasks.create({
    id: TASK_ID,
    teamId,
    title: '产出报告',
    status: 'in_progress',
    creatorId: userId,
    channelId,
    tags: [],
    sortOrder: 0,
    revision: 1,
    supersededByRevision: null,
    createdAt: 3,
    updatedAt: 3,
  });

  // 项目 profile + 绑定 Stage（阶段审核工作区语境；版本 stageId 的作用域校验需要）。
  const profile = {
    id: 'profile-1', teamId, channelId,
    projectLeadId: userId, defaultReviewerIds: [userId], revision: 1,
    createdBy: userId, createdAt: 1, updatedAt: 1,
  };
  await repositories.channelProjects.createInitialStage({
    expectedRevision: 0,
    profile,
    stage: {
      id: STAGE_ID, teamId, channelId,
      taskId: TASK_ID, taskRevision: 1, name: '报告阶段', goal: '产出报告',
      ownerId: userId, reviewerIds: [userId], acceptanceCriteria: ['完成'],
      createdAt: 1, updatedAt: 1,
    },
    mutation: {
      teamId, channelId, idempotencyKey: 'stage-1', requestFingerprint: 'stage-1',
      profileId: profile.id, stageId: STAGE_ID,
      resultRevision: 1, resultOverview: {} as never, createdAt: 1,
    },
  });

  // delivery 产物 artifact（version 的 artifact FK 需要）+ OutputPackage（delivered=ver-1）。
  await repositories.artifacts.create({
    id: ARTIFACT_ID, teamId, channelId, uploaderId: agentId,
    filename: 'report.md', mimeType: 'text/markdown', sizeBytes: 12, pathKind: 'workspace', createdAt: 2,
  });
  await recordPackage(repositories, {
    teamId, channelId, agentId,
    packageId: PACKAGE_ID, publishId: 'pub-1', deliveryId: DELIVERY_ID,
    taskAttempt: 1, createdAt: 500,
    collection: { mode: 'create', collectionId: COLLECTION_ID, name: 'out/report.md', kind: 'deliverable' },
    version: { id: VERSION_ID, artifactId: ARTIFACT_ID, stageId: STAGE_ID },
  });

  // management run（task_coordinations.management_run_id FK）+ run lease（invokeTask 鉴权）。
  await repositories.management.runs.create({
    schemaVersion: 1,
    id: RUN_ID,
    teamId,
    channelId,
    rootTaskId: 'root-task-handoff',
    rootMessageId: 'msg-root-handoff',
    initiatedByUserId: userId,
    mode: 'managed',
    status: 'running',
    placementPolicy: {
      placement: 'device',
      allowServerContext: false,
      requireLocalModelCredentials: true,
    },
    checkpointRevision: 1,
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
    createdAt: 3,
    updatedAt: 3,
  });
  await repositories.management.leases.put({
    managementRunId: RUN_ID,
    workerId: 'worker-1',
    host: { kind: 'device', deviceId: hello.device.id, profileId: profile.id },
    leaseTokenHash: createHash('sha256').update('token').digest('hex'),
    leaseFingerprint: 'fingerprint',
    fencingToken: 1,
    acquiredAt: 3,
    heartbeatAt: 3,
    expiresAt: 10_000,
  });
  await repositories.taskCoordination.coordinations.create({
    schemaVersion: 1,
    taskId: TASK_ID,
    teamId,
    taskRevision: 1,
    managementRunId: RUN_ID,
    rootTaskId: 'root-task-handoff',
    parentTaskId: 'root-task-handoff',
    nodeKind: 'subtask',
    reviewPolicy: 'human',
    claimPolicy: 'open',
    requiredCapabilities: [],
    maxAttempts: 3,
    attempt: 1,
    humanAcceptanceAuthorityIds: [userId],
    createdAt: 3,
    updatedAt: 3,
  });

  // 绑定讨论串根消息（meta.taskId 是 task-linked 的唯一绑定事实）。
  await repositories.messages.append({
    id: THREAD_ROOT_ID,
    teamId,
    channelId,
    threadId: THREAD_ROOT_ID,
    senderKind: 'human',
    senderId: userId,
    body: '阶段任务：产出报告',
    createdAt: 3,
    meta: { taskId: TASK_ID },
  });

  return { repositories, app, userId, teamId, channelId, agentId, close };
}

/** 最小 package 成形（不经过 workspace publish，直接 recordPackageFormation）。 */
async function recordPackage(
  repositories: ServerNextRepositories,
  input: {
    teamId: string;
    channelId: string;
    agentId: string;
    packageId: string;
    publishId: string;
    deliveryId: string;
    taskAttempt: number;
    createdAt: number;
    sizeBytes?: number;
    collection:
      | { mode: 'create'; collectionId: string; name: string; kind: string }
      | { mode: 'append'; collectionId: string; expectedRevision: number; expectedVersionCount: number };
    version: { id: string; artifactId: string; stageId?: string };
  },
): Promise<void> {
  const idempotencyKey = `record-agent-output-package:${input.channelId}:${input.publishId}`;
  const result = await repositories.outputPackages.recordPackageFormation({
    record: {
      teamId: input.teamId,
      packageId: input.packageId,
      channelId: input.channelId,
      deliveryId: input.deliveryId,
      publishId: input.publishId,
      workspaceRevisionId: `wrev-${input.publishId}`,
      agentId: input.agentId,
      taskId: TASK_ID,
      taskBinding: 'managed',
      taskRevision: 1,
      taskAttempt: input.taskAttempt,
      memberCount: 1,
      status: 'recorded',
      createdAt: input.createdAt,
    },
    members: [{
      sequence: 1,
      shortLabel: 'F1',
      role: 'deliverable',
      requiredForFinal: true,
      sourcePath: 'out/report.md',
      filename: 'report.md',
      sizeBytes: input.sizeBytes ?? 12,
      collection: input.collection,
      version: {
        id: input.version.id,
        artifactId: input.version.artifactId,
        ...(input.version.stageId ? { stageId: input.version.stageId } : {}),
        taskId: TASK_ID,
        taskRevision: 1,
      },
    }],
    receipt: {
      receiptId: `rcpt-${input.publishId}`,
      teamId: input.teamId,
      commandName: 'record-agent-output-package',
      commandSchemaVersion: 1,
      idempotencyKey,
      commandHash: 'x',
      outcome: 'applied',
      committedRevisions: [],
      eventRefs: [],
      commitTime: input.createdAt,
      resultAvailable: true,
      createdAt: input.createdAt,
    },
    tombstone: {
      id: `tomb-${input.publishId}`,
      teamId: input.teamId,
      commandName: 'record-agent-output-package',
      idempotencyKey,
      commandHash: 'x',
      receiptId: `rcpt-${input.publishId}`,
      outcome: 'applied',
      resultAvailable: true,
      createdAt: input.createdAt,
    },
  });
  if (result.kind !== 'created') throw new Error(`package seed failed: ${result.kind}`);
}

/** 向 COLLECTION_ID 追加新版本（current 指针移动、collection revision 推进）并形成新 package。 */
async function appendPackageVersion(
  seedValue: Seed,
  input: { packageId: string; publishId: string; deliveryId: string; versionId: string; artifactId: string; taskAttempt: number; createdAt: number },
): Promise<void> {
  await seedValue.repositories.artifacts.create({
    id: input.artifactId, teamId: seedValue.teamId, channelId: seedValue.channelId,
    uploaderId: seedValue.agentId, filename: 'report.md', mimeType: 'text/markdown',
    sizeBytes: 16, pathKind: 'workspace', createdAt: input.createdAt,
  });
  const collection = await seedValue.repositories.channelProjects.getArtifactCollection({
    teamId: seedValue.teamId, channelId: seedValue.channelId, collectionId: COLLECTION_ID,
  });
  if (!collection) throw new Error('collection missing');
  await recordPackage(seedValue.repositories, {
    teamId: seedValue.teamId, channelId: seedValue.channelId, agentId: seedValue.agentId,
    packageId: input.packageId, publishId: input.publishId, deliveryId: input.deliveryId,
    taskAttempt: input.taskAttempt, createdAt: input.createdAt, sizeBytes: 16,
    collection: {
      mode: 'append', collectionId: COLLECTION_ID,
      expectedRevision: collection.revision, expectedVersionCount: collection.versionCount,
    },
    version: { id: input.versionId, artifactId: input.artifactId, stageId: STAGE_ID },
  });
}

/** 阶段交接消息：绑定讨论串 + @Agent-A + package selection（默认 delivered 策略）。 */
function handoffRequest(
  seedValue: Seed,
  over: Partial<SendMessageInput> & { clientMessageId: string },
): SendMessageInput {
  return {
    userId: seedValue.userId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    body: '@Agent-A 请基于已交付版本继续修改',
    threadId: THREAD_ROOT_ID,
    meta: { mentions: [{ id: seedValue.agentId, name: 'Agent-A', kind: 'agent', start: 0, end: 8 }] },
    selections: [{ kind: 'package_projection', packageId: PACKAGE_ID, policy: 'delivered' }],
    ...over,
  };
}

function makeBroker(seedValue: Seed) {
  let id = 0;
  return createTaskClaimBroker({
    repositories: seedValue.repositories,
    clock: { now: () => 1000 },
    ids: { nextId: () => `id-broker-${++id}` },
  });
}

/** reject-delivery 前置：模拟交付已提交（task → in_review）。 */
async function markInReview(seedValue: Seed): Promise<void> {
  await seedValue.repositories.tasks.update({
    taskId: TASK_ID, changes: { status: 'in_review', updatedAt: 800 },
  });
}

for (const variant of variants) {
  describe(`阶段交接引用冻结 (#1178, ${variant.name})`, () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      while (cleanups.length > 0) cleanups.pop()!();
    });

    async function makeSeed(): Promise<Seed> {
      const s = await seed(variant);
      cleanups.push(s.close);
      return s;
    }

    test('AC4:delivered 策略交接 → referenceSet 冻结具体版本可从消息追溯;Offer 冻结同一版本,acceptance 前无 claim', async () => {
      const s = await makeSeed();
      const sent = await s.app.sendMessage(handoffRequest(s, { clientMessageId: 'client-ac4' }));
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      // referenceSet 冻结为具体 artifactVersionId（delivered 是冻结事实,item 不带 collectionRevision fence）。
      expect(sent.referenceSet?.selections[0]).toMatchObject({
        sourceKind: 'package_delivered',
        package: { packageId: PACKAGE_ID, policy: 'delivered', memberCount: 1 },
      });
      expect(sent.referenceSet?.selections[0]?.items[0]).toMatchObject({
        kind: 'artifact_version',
        collectionId: COLLECTION_ID,
        versionId: VERSION_ID,
        versionNumber: 1,
      });
      expect(sent.referenceSet?.selections[0]?.items[0]).not.toHaveProperty('collectionRevision');
      // 可从消息投影读回追溯（append-only,读路径不重解析）。
      const persisted = await s.repositories.projectReferenceSets.getByMessageId({
        teamId: s.teamId, channelId: s.channelId, messageId: sent.message.id,
      });
      expect(persisted?.messageId).toBe(sent.message.id);
      expect(persisted?.selections[0]?.packageId).toBe(PACKAGE_ID);
      expect(persisted?.selections[0]?.packageProjection).toBe('delivered');
      expect(persisted?.selections[0]?.items[0]?.versionId).toBe(VERSION_ID);
      // Offer 冻结同一版本（task-linked 交接事实）。
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({
        agentId: s.agentId, taskRevision: 1, taskAttempt: 1, hardSpecified: true, status: 'open',
      });
      expect(offers[0]!.frozenInputs).toEqual([expect.objectContaining({
        collectionId: COLLECTION_ID,
        artifactVersionId: VERSION_ID,
        versionNumber: 1,
        isFinal: false,
        reviewState: 'pending',
      })]);
      // AC5:Agent acceptance 前无 claim/执行责任。
      const claim = await s.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: TASK_ID, taskRevision: 1, taskAttempt: 1,
      });
      expect(claim).toBeNull();
    });

    test('AC7:冻结后 current/final 双双漂移 → 历史 referenceSet 不变;漂移后 Invocation 仍用冻结输入', async () => {
      const s = await makeSeed();
      // current 指针策略交接（带逐成员 revision fence）。
      const sent = await s.app.sendMessage(handoffRequest(s, {
        clientMessageId: 'client-ac7',
        selections: [{
          kind: 'package_projection', packageId: PACKAGE_ID, policy: 'current',
          expectedMemberRevisions: [{ collectionId: COLLECTION_ID, revision: 1 }],
        }],
      }));
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      expect(sent.referenceSet?.selections[0]?.items[0]).toMatchObject({
        versionId: VERSION_ID,
        collectionRevision: 1, // 解析当刻 basis
      });
      // acceptance（漂移前）→ claim。
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(1);
      const accepted = await makeBroker(s).respondToOffer({
        offerId: offers[0]!.id, agentId: s.agentId, kind: 'accepted',
      });
      expect(accepted.kind).toBe('claim_granted');
      const claim = await s.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: TASK_ID, taskRevision: 1, taskAttempt: 1,
      });
      if (!claim) throw new Error('claim expected after acceptance');

      // 漂移 ①：append ver-2 → current 指针移动、collection revision 推进。
      await appendPackageVersion(s, {
        packageId: 'pkg-2', publishId: 'pub-2', deliveryId: 'del-2',
        versionId: 'ver-2', artifactId: 'art-2', taskAttempt: 1, createdAt: 700,
      });
      // 漂移 ②：finalize ver-1 → final 指针移动（isFinal basis 变化）。
      const collectionAfterAppend = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: COLLECTION_ID,
      });
      expect(collectionAfterAppend?.revision).toBe(2);
      const finalized = await s.app.submitPackageReviewAndFinalize({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: PACKAGE_ID, collectionId: COLLECTION_ID, versionId: VERSION_ID,
        decision: 'approved', comment: '通过并设为最终版',
        expectedCollectionRevision: 2, idempotencyKey: 'finalize-ac7',
      });
      expect(finalized.ok).toBe(true);
      // sanity：漂移真实发生（current=ver-2、final=ver-1）。
      const collectionNow = await s.repositories.channelProjects.getArtifactCollection({
        teamId: s.teamId, channelId: s.channelId, collectionId: COLLECTION_ID,
      });
      expect(collectionNow?.currentVersionId).toBe('ver-2');
      expect(collectionNow?.finalVersionId).toBe(VERSION_ID);

      // 漂移后创建 Invocation：intent 仍冻结 ver-1（继承 accepted Offer 的 frozenInputs,不重新解析）。
      let invId = 0;
      const gateway = createInvocationGateway({
        repositories: s.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => `id-inv-${++invId}` },
      });
      const created = await gateway.invokeTask({
        authority: { managementRunId: RUN_ID, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 },
        idempotencyKey: 'invoke-ac7',
        taskId: TASK_ID, expectedTaskRevision: 1, taskAttempt: 1,
        claimLeaseId: claim.id, objective: '基于交付继续修改', attachmentIds: [],
      });
      expect(created.disposition).toBe('created');
      expect(created.view.intent.frozenInputs).toEqual([expect.objectContaining({
        collectionId: COLLECTION_ID,
        artifactVersionId: VERSION_ID,
        versionNumber: 1,
      })]);

      // 历史消息 referenceSet 保持原版本与原 basis（current/final 漂移不改写历史）。
      const persisted = await s.repositories.projectReferenceSets.getByMessageId({
        teamId: s.teamId, channelId: s.channelId, messageId: sent.message.id,
      });
      expect(persisted?.selections[0]?.items[0]).toMatchObject({
        versionId: VERSION_ID,
        collectionRevision: 1,
      });
    });

    test('AC8:Offer 发布后 task revision 漂移 → acceptance 结构化拒绝,零部分写', async () => {
      const s = await makeSeed();
      const sent = await s.app.sendMessage(handoffRequest(s, { clientMessageId: 'client-ac8-rev' }));
      expect(sent.ok).toBe(true);
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(1);
      // 交接前 task 已修订（revision 推进）→ 旧 basis 失效。
      await s.repositories.tasks.updateAtRevision({
        taskId: TASK_ID, expectedRevision: 1, nextRevision: 2,
        reasonCode: 'TASK_REVISED', changes: { title: '改题', updatedAt: 900 },
      });
      const result = await makeBroker(s).respondToOffer({
        offerId: offers[0]!.id, agentId: s.agentId, kind: 'accepted',
      });
      expect(result.kind).toBe('not_accepted');
      if (result.kind === 'not_accepted') {
        expect(result.diagnosticCode).toBe('TASK_CLAIM_OFFER_TASK_REVISION_CHANGED');
      }
      // 零部分写：无 claim、无 grant。
      const claim = await s.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: TASK_ID, taskRevision: 1, taskAttempt: 1,
      });
      expect(claim).toBeNull();
      const grants = await s.repositories.taskCoordination.executionGrants.listActiveByTask(TASK_ID);
      expect(grants).toHaveLength(0);
    });

    test('AC8:Offer 发布后 reject-delivery 推进 attempt → 旧 Offer acceptance TASK_CLAIM_OFFER_STALE,零部分写', async () => {
      const s = await makeSeed();
      const sent = await s.app.sendMessage(handoffRequest(s, { clientMessageId: 'client-ac8-attempt' }));
      expect(sent.ok).toBe(true);
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(1);
      expect(offers[0]!.taskAttempt).toBe(1);
      // 交付提交 → 审核要求修改并退回：task 回 todo、attempt 推进到 2（#1177 既有命令）。
      await markInReview(s);
      const rejected = await s.app.submitPackageReviewAndRejectDelivery({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: PACKAGE_ID, collectionId: COLLECTION_ID, versionId: VERSION_ID,
        decision: 'changes_requested', comment: '需要修改', rejectReason: '格式不符',
        expectedTaskRevision: 1, expectedTaskAttempt: 1, idempotencyKey: 'reject-ac8',
      });
      expect(rejected.ok).toBe(true);
      const coordination = await s.repositories.taskCoordination.coordinations.getByTaskId(TASK_ID);
      expect(coordination?.attempt).toBe(2);
      // 旧 Offer（冻结 attempt 1）acceptance → OFFER_STALE（revision 未变,预检不拦,事务内复核兜底）。
      const result = await makeBroker(s).respondToOffer({
        offerId: offers[0]!.id, agentId: s.agentId, kind: 'accepted',
      });
      expect(result.kind).toBe('not_accepted');
      if (result.kind === 'not_accepted') {
        expect(result.diagnosticCode).toBe('TASK_CLAIM_OFFER_STALE');
      }
      // 零部分写：两个 attempt 都无 claim、无 grant;旧 Offer 未被部分改写。
      for (const attempt of [1, 2]) {
        const claim = await s.repositories.taskCoordination.claimLeases.getCurrent({
          taskId: TASK_ID, taskRevision: 1, taskAttempt: attempt,
        });
        expect(claim).toBeNull();
      }
      const grants = await s.repositories.taskCoordination.executionGrants.listActiveByTask(TASK_ID);
      expect(grants).toHaveLength(0);
      const offerAfter = await s.repositories.taskCoordination.offers.getById(offers[0]!.id);
      expect(offerAfter?.status).toBe('open');
    });

    test('AC9:跨频道 package 引用 → VALIDATION_ERROR/package_not_found,消息不落库、无 Offer', async () => {
      const s = await makeSeed();
      // 第二频道有自己的 package（对交接频道不可见）。
      const other = await s.app.createChannel({
        userId: s.userId, teamId: s.teamId, name: 'other', visibility: 'public',
      });
      if (!other.ok) throw new Error(other.error);
      await s.repositories.artifacts.create({
        id: 'art-other', teamId: s.teamId, channelId: other.channel.id, uploaderId: s.userId,
        filename: 'other.md', mimeType: 'text/markdown', sizeBytes: 8, pathKind: 'workspace', createdAt: 2,
      });
      await recordPackage(s.repositories, {
        teamId: s.teamId, channelId: other.channel.id, agentId: s.agentId,
        packageId: 'pkg-other', publishId: 'pub-other', deliveryId: 'del-other',
        taskAttempt: 1, createdAt: 600,
        collection: { mode: 'create', collectionId: 'col-other', name: 'out/other.md', kind: 'deliverable' },
        // 跨频道 package 不带 stageId（0076 起可空;stage-1 属于本频道,复合 FK 不允许跨频道指）。
        version: { id: 'ver-other', artifactId: 'art-other' },
      });
      const sent = await s.app.sendMessage(handoffRequest(s, {
        clientMessageId: 'client-ac9',
        selections: [{ kind: 'package_projection', packageId: 'pkg-other', policy: 'delivered' }],
      }));
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.error).toBe('VALIDATION_ERROR');
        expect(sent.details?.reason).toBe('selections_rejected');
        expect(sent.details?.rejections).toEqual([{
          selectionIndex: 0, refId: 'pkg-other', code: 'package_not_found',
        }]);
      }
      // 消息未落库、无 Offer（fail closed 不留部分事实）。
      const messages = await s.repositories.messages.listByChannel(s.channelId, 50);
      expect(messages.some((message) => message.body.includes('请基于已交付'))).toBe(false);
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(0);
    });

    test('AC6:reject-delivery 后新 attempt 交接（显式 package_members）→ 冻结旧交付版本,acceptance 成功;旧事实 append-only 保留', async () => {
      const s = await makeSeed();
      // 交付提交 → 审核要求修改并退回（新 attempt 由 #1177 命令产生,本入口不重复语义）。
      await markInReview(s);
      const rejected = await s.app.submitPackageReviewAndRejectDelivery({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: PACKAGE_ID, collectionId: COLLECTION_ID, versionId: VERSION_ID,
        decision: 'changes_requested', comment: '需要修改', rejectReason: '格式不符',
        expectedTaskRevision: 1, expectedTaskAttempt: 1, idempotencyKey: 'reject-ac6',
      });
      expect(rejected.ok).toBe(true);
      if (!rejected.ok) return;
      expect(rejected.task).toMatchObject({ taskId: TASK_ID, taskRevision: 1, taskAttempt: 2, status: 'todo' });

      // 新 attempt 的交接消息显式引用旧交付版本（「基于此修改」= package_members,免 review 闸）。
      const sent = await s.app.sendMessage(handoffRequest(s, {
        clientMessageId: 'client-ac6',
        body: '@Agent-A 请基于已交付版本继续修改（第二轮）',
        selections: [{
          kind: 'package_members', packageId: PACKAGE_ID,
          members: [{ collectionId: COLLECTION_ID, versionId: VERSION_ID }],
        }],
      }));
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      // 冻结结果 = 旧交付版本（specified 语义,不带指针 basis）。
      expect(sent.referenceSet?.selections[0]).toMatchObject({
        sourceKind: 'package_specified',
        package: { packageId: PACKAGE_ID, policy: 'specified', memberCount: 1 },
      });
      expect(sent.referenceSet?.selections[0]?.items[0]).toMatchObject({
        collectionId: COLLECTION_ID, versionId: VERSION_ID, versionNumber: 1,
      });
      // Offer 绑定新 attempt,冻结输入携带 changes_requested basis 快照。
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({ taskRevision: 1, taskAttempt: 2, status: 'open' });
      expect(offers[0]!.frozenInputs).toEqual([expect.objectContaining({
        artifactVersionId: VERSION_ID,
        reviewState: 'changes_requested',
        isFinal: false,
      })]);
      // acceptance 成功（冻结 basis 与当前一致）→ claim 属于新 attempt。
      const accepted = await makeBroker(s).respondToOffer({
        offerId: offers[0]!.id, agentId: s.agentId, kind: 'accepted',
      });
      expect(accepted.kind).toBe('claim_granted');
      const claim = await s.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: TASK_ID, taskRevision: 1, taskAttempt: 2,
      });
      expect(claim).not.toBeNull();
      // 旧事实 append-only 保留：review 历史不覆盖、旧 package/delivered 投影仍指向 ver-1。
      const reviews = await s.repositories.channelProjects.listArtifactReviews({
        teamId: s.teamId, channelId: s.channelId,
      });
      expect(reviews.filter((review) => review.versionId === VERSION_ID)).toHaveLength(1);
      expect(reviews[0]?.decision).toBe('changes_requested');
      const delivered = await s.app.getOutputPackage({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: PACKAGE_ID, projection: { policy: 'delivered' },
      });
      expect(delivered.ok).toBe(true);
      if (!delivered.ok) return;
      expect(delivered.projection?.status).toBe('ready');
      expect(delivered.projection?.members[0]?.versionId).toBe(VERSION_ID);
      const packageRecord = await s.repositories.outputPackages.getPackageByPublishId({
        teamId: s.teamId, publishId: 'pub-1',
      });
      expect(packageRecord?.package.deliveryId).toBe(DELIVERY_ID);
    });

    test('AC6 现状特征化:changes_requested 后 delivered 指针交接 → REVIEW_BASIS_BLOCKED(显式选择才放行)', async () => {
      // 注意：本用例锁定的是**现有机制**——指针解析（delivered/current）的输入不过 review 闸豁免，
      // 只有显式 package_members/artifact_version 放行。design.md §2.3「要求修改后继续」预填
      // delivered 策略在「刚要求修改完」的场景会命中本拒绝,该张力已在任务报告中列出待设计裁决。
      const s = await makeSeed();
      await markInReview(s);
      const rejected = await s.app.submitPackageReviewAndRejectDelivery({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: PACKAGE_ID, collectionId: COLLECTION_ID, versionId: VERSION_ID,
        decision: 'changes_requested', comment: '需要修改', rejectReason: '格式不符',
        expectedTaskRevision: 1, expectedTaskAttempt: 1, idempotencyKey: 'reject-ac6b',
      });
      expect(rejected.ok).toBe(true);
      const sent = await s.app.sendMessage(handoffRequest(s, { clientMessageId: 'client-ac6b' }));
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.error).toBe('CONFLICT');
        expect(sent.details?.taskLinkedCode).toBe('REVIEW_BASIS_BLOCKED');
        expect(sent.details?.blockedVersionIds).toEqual([VERSION_ID]);
      }
      // fail closed：消息未落库、无 Offer。
      const messages = await s.repositories.messages.listByChannel(s.channelId, 50);
      expect(messages.some((message) => message.body.includes('请基于已交付'))).toBe(false);
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      expect(offers).toHaveLength(0);
    });

    test('AC10:新 delivery 发布 + review 后,overview / output-package / library / 历史 referenceSet 四处一致', async () => {
      const s = await makeSeed();
      // 交接（current 指针,带 fence）→ acceptance → claim（责任焦点来自 Server 事实）。
      const sent = await s.app.sendMessage(handoffRequest(s, {
        clientMessageId: 'client-ac10',
        selections: [{
          kind: 'package_projection', packageId: PACKAGE_ID, policy: 'current',
          expectedMemberRevisions: [{ collectionId: COLLECTION_ID, revision: 1 }],
        }],
      }));
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;
      const offers = await s.repositories.taskCoordination.offers.listByTask(TASK_ID);
      const accepted = await makeBroker(s).respondToOffer({
        offerId: offers[0]!.id, agentId: s.agentId, kind: 'accepted',
      });
      expect(accepted.kind).toBe('claim_granted');

      // 新 delivery 回到同一 task：pkg-2（append ver-2,current 移动）。
      await appendPackageVersion(s, {
        packageId: 'pkg-2', publishId: 'pub-2', deliveryId: 'del-2',
        versionId: 'ver-2', artifactId: 'art-2', taskAttempt: 1, createdAt: 900,
      });
      // 新交付版本审核通过。
      const reviewed = await s.app.submitPackageArtifactReview({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: 'pkg-2', collectionId: COLLECTION_ID, versionId: 'ver-2',
        decision: 'approved', comment: '合格', idempotencyKey: 'review-ac10',
      });
      expect(reviewed.ok).toBe(true);

      // Tasks 面：delivery-overview 焦点 = 最新 package。
      const overview = await s.app.queryTaskDeliveryOverview({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId, taskId: TASK_ID,
      });
      expect(overview.ok).toBe(true);
      if (!overview.ok) return;
      expect(overview.overview.delivery.focusPackageId).toBe('pkg-2');
      expect(overview.overview.delivery.packages.map((pkg) => pkg.packageId))
        .toEqual(expect.arrayContaining([PACKAGE_ID, 'pkg-2']));
      // Files 面①：getOutputPackage(pkg-2) delivered 投影 ready 且 review 状态一致。
      const detail = await s.app.getOutputPackage({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId, packageId: 'pkg-2',
      });
      expect(detail.ok).toBe(true);
      if (!detail.ok) return;
      expect(detail.availableActions[0]?.reviewState).toBe('approved');
      const projection = await s.app.getOutputPackage({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        packageId: 'pkg-2', projection: { policy: 'delivered' },
      });
      expect(projection.ok).toBe(true);
      if (!projection.ok) return;
      expect(projection.projection?.status).toBe('ready');
      expect(projection.projection?.members[0]).toMatchObject({
        versionId: 'ver-2', reviewState: 'approved',
      });
      // Files 面②：artifact library current 已移动到 ver-2,版本携带同一 review 事实。
      const library = await s.app.listProjectArtifactCollections({
        userId: s.userId, teamId: s.teamId, channelId: s.channelId,
      });
      expect(library.ok).toBe(true);
      if (!library.ok) return;
      const collection = library.library.collections.find((item) => item.id === COLLECTION_ID);
      expect(collection?.currentVersionId).toBe('ver-2');
      expect(collection?.versions.find((version) => version.id === 'ver-2')?.reviewState).toBe('approved');
      // Thread 面：历史交接消息 referenceSet 仍是冻结的 ver-1（新 delivery 不改写历史）。
      const persisted = await s.repositories.projectReferenceSets.getByMessageId({
        teamId: s.teamId, channelId: s.channelId, messageId: sent.message.id,
      });
      expect(persisted?.selections[0]?.items[0]).toMatchObject({
        versionId: VERSION_ID,
        collectionRevision: 1,
      });
    });
  });
}
