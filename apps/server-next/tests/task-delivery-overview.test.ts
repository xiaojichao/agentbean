/**
 * #1065 AC3/AC4 Task 交付聚合视图集成测试(memory + SQLite 双后端)。
 *
 * 覆盖:stage 目标/依赖、acceptance contract、责任焦点(仅由 Server 事实投影)、
 * 当前 delivery/package、合法 availableActions(可发现性,不授权)、完整执行链
 * 时间线(offer→acceptance→claim→execution_start→delivery→review/final→handoff)、
 * minimumConsistency 水位检查与权限边界。
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

async function seedTask(
  seedValue: Seed,
  taskId: string,
  opts?: {
    status?: 'todo' | 'in_progress' | 'in_review';
    preboundAuthorityIds?: string[];
    criteria?: string[];
  },
) {
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
    description: '产出交付文档',
    status: opts?.status ?? 'todo',
    creatorId: seedValue.userId,
    channelId: seedValue.channelId,
    tags: ['docs'],
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
    ...(opts?.preboundAuthorityIds
      ? { humanAcceptanceAuthorityIds: [...opts.preboundAuthorityIds] }
      : {}),
    taskRevision: 1,
    attempt: 1,
    maxAttempts: 3,
    createdAt: 10,
    updatedAt: 10,
  });
  for (const [position, statement] of (opts?.criteria ?? []).entries()) {
    await seedValue.repositories.taskCoordination.criteria.create({
      id: `criteria-${taskId}-${position}`,
      taskId,
      description: statement,
      evidenceRequired: false,
      introducedRevision: 1,
      position,
      createdAt: 10,
    });
  }
}

async function seedOffer(seedValue: Seed, taskId: string, offerId: string, opts?: { status?: string; responded?: boolean; frozen?: boolean }) {
  await seedValue.repositories.taskCoordination.offers.create({
    id: offerId,
    teamId: seedValue.teamId,
    taskId,
    agentId: seedValue.agentId,
    taskRevision: 1,
    taskAttempt: 1,
    manifestRevision: 0,
    objective: {
      objective: '继续任务', inputs: [], deliverables: [], constraints: [],
      riskLevel: 'low', requiredCapabilities: [], requiredSkills: [], preferredSkills: [],
    },
    ...(opts?.frozen
      ? { frozenInputs: [{ collectionId: 'col-x', artifactVersionId: 'ver-x', versionNumber: 1, filename: 'a.md', isFinal: false, reviewState: 'pending' }] }
      : {}),
    offerTtlMs: 15000,
    offerExpiresAt: 50000,
    hardSpecified: true,
    requirementConfirmation: false,
    status: (opts?.status as never) ?? 'open',
    response: opts?.responded
      ? { offerId, agentId: seedValue.agentId, kind: 'accepted', detail: null, respondedAt: 300 }
      : null,
    createdAt: 200,
    updatedAt: opts?.responded ? 300 : 200,
  });
}

async function seedClaim(seedValue: Seed, taskId: string, claimId: string, status: 'active' | 'released') {
  await seedValue.repositories.taskCoordination.claimLeases.create({
    id: claimId,
    teamId: seedValue.teamId,
    taskId,
    taskRevision: 1,
    taskAttempt: 1,
    agentId: seedValue.agentId,
    leaseTokenHash: 'hash',
    leaseFingerprint: 'fp',
    fencingToken: 1,
    status,
    acquiredAt: 400,
    heartbeatAt: 400,
    expiresAt: 90000,
    ...(status === 'released' ? { releasedAt: 500 } : {}),
  });
}

function token(streamId: string, revision: number): ConsistencyTokenV1 {
  return { schemaVersion: 1, entries: [{ streamKind: 'output-package', streamId, revision }] };
}

async function queryOverview(seedValue: Seed, taskId: string, minimumConsistency?: ConsistencyTokenV1) {
  const result = await seedValue.app.queryTaskDeliveryOverview({
    userId: seedValue.userId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    taskId,
    ...(minimumConsistency ? { minimumConsistency } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  return result.overview;
}

for (const variant of variants) {
  describe(`task delivery overview (${variant.name})`, () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => {
      while (cleanups.length > 0) cleanups.pop()!();
    });

    test('AC3:基本视图携带 task/acceptanceContract/delivery/availableActions/focus', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-overview-1';
      await seedTask(seedValue, taskId, { status: 'in_progress', preboundAuthorityIds: [seedValue.userId], criteria: ['文档可读'] });
      await commitDelivery(seedValue, 'pub-o1', [{ path: 'docs/o1.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });

      const overview = await queryOverview(seedValue, taskId);
      expect(overview.schemaVersion).toBe(1);
      expect(overview.task.id).toBe(taskId);
      expect(overview.task.status).toBe('in_progress');
      expect(overview.acceptanceContract).toMatchObject({
        nodeKind: 'root',
        reviewPolicy: 'human',
        humanAcceptanceAuthorityIds: [seedValue.userId],
        requiresHumanAcceptance: true,
        acceptanceCriteria: ['文档可读'],
        taskRevision: 1,
        attempt: 1,
        maxAttempts: 3,
      });
      expect(overview.delivery.packages).toHaveLength(1);
      expect(overview.delivery.focusPackageId).toBe(overview.delivery.packages[0]!.packageId);
      // availableActions:Server 计算的可发现性动作(open 总可用,review 需 in_review)。
      expect(overview.availableActions.map((a) => a.action)).toContain('open-task');
      expect(overview.availableActions.find((a) => a.action === 'delegate-to-agent')?.disabled).toBeUndefined();
      expect(overview.availableActions.find((a) => a.action === 'review-package')?.disabled).toBe(true);
      // 责任焦点:in_progress + 无 claim → 尚在等待(无 offer/claim 时不伪造 Agent 责任)。
      expect(overview.responsibilityFocus.kind).toBe('none');
      // 执行链:至少包含交付文件包事件。
      expect(overview.timeline.some((e) => e.kind === 'delivery')).toBe(true);
      expect(overview.audienceScope).toBe(`${seedValue.teamId}:${seedValue.channelId}:${seedValue.userId}`);
      expect(overview.consistencyToken.entries[0]).toEqual({
        streamKind: 'output-package', streamId: seedValue.channelId, revision: 1,
      });
    });

    test('AC4:focus 只由 Server 事实投影(offer_wait/execution_active/review_wait)', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      // offer_wait:open offer 未响应。
      const taskOffer = 'task-focus-offer';
      await seedTask(seedValue, taskOffer, { status: 'todo' });
      await seedOffer(seedValue, taskOffer, 'offer-1');
      expect((await queryOverview(seedValue, taskOffer)).responsibilityFocus.kind).toBe('offer_wait');

      // execution_active:in_progress + active claim。
      const taskExec = 'task-focus-exec';
      await seedTask(seedValue, taskExec, { status: 'in_progress' });
      await seedClaim(seedValue, taskExec, 'claim-1', 'active');
      const execFocus = (await queryOverview(seedValue, taskExec)).responsibilityFocus;
      expect(execFocus.kind).toBe('execution_active');
      expect(execFocus.claimLeaseId).toBe('claim-1');
      expect(execFocus.agentId).toBe(seedValue.agentId);

      // review_wait:in_review。
      const taskReview = 'task-focus-review';
      await seedTask(seedValue, taskReview, { status: 'in_review' });
      expect((await queryOverview(seedValue, taskReview)).responsibilityFocus.kind).toBe('review_wait');

      // none:无 coordination 的裸 task。
      const bareTaskId = 'task-focus-bare';
      await seedValue.repositories.tasks.create({
        id: bareTaskId, teamId: seedValue.teamId, title: 'bare', status: 'todo',
        creatorId: seedValue.userId, channelId: seedValue.channelId, tags: [], sortOrder: 0,
        createdAt: 1, updatedAt: 1,
      });
      expect((await queryOverview(seedValue, bareTaskId)).responsibilityFocus.kind).toBe('none');
    });

    test('AC4:执行链时间线(offer→acceptance→claim→execution_start→delivery)按时间升序', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-timeline-1';
      await seedTask(seedValue, taskId, { status: 'in_progress' });
      await seedOffer(seedValue, taskId, 'offer-tl', { responded: true });
      await seedClaim(seedValue, taskId, 'claim-tl', 'active');
      await commitDelivery(seedValue, 'pub-tl', [{ path: 'docs/tl.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });

      const overview = await queryOverview(seedValue, taskId);
      const kinds = overview.timeline.map((e) => e.kind);
      expect(kinds).toContain('offer');
      expect(kinds).toContain('acceptance');
      expect(kinds).toContain('claim');
      expect(kinds).toContain('execution_start');
      expect(kinds).toContain('delivery');
      // 时间升序(事件链可审计)。
      const ats = overview.timeline.map((e) => e.at);
      expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    });

    test('AC4:review/finalization/human_revision 进入时间线;handoff 由冻结输入 Offer 投影', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-timeline-2';
      await seedTask(seedValue, taskId, { status: 'in_review' });
      await seedOffer(seedValue, taskId, 'offer-ho', { frozen: true, responded: true });
      await commitDelivery(seedValue, 'pub-tl2', [{ path: 'docs/tl2.md', body: Buffer.from('v1') }], {
        agentId: seedValue.agentId, taskId, taskAttempt: 1,
      });
      const packageRecord = await seedValue.repositories.outputPackages.getPackageByPublishId({
        teamId: seedValue.teamId, publishId: 'pub-tl2',
      });
      if (!packageRecord) throw new Error('package not found');
      const member = packageRecord.members[0]!;

      const reviewed = await seedValue.app.submitPackageArtifactReview({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        packageId: packageRecord.package.packageId,
        collectionId: member.collectionId,
        versionId: member.artifactVersionId,
        decision: 'approved',
        comment: '合格',
        idempotencyKey: `review-tl2:${packageRecord.package.packageId}`,
      });
      expect(reviewed.ok).toBe(true);

      const overview = await queryOverview(seedValue, taskId);
      const kinds = overview.timeline.map((e) => e.kind);
      expect(kinds).toContain('handoff');
      expect(kinds).toContain('review');
      // 责任焦点:in_review → review_wait。
      expect(overview.responsibilityFocus.kind).toBe('review_wait');
    });

    test('AC9:availableActions 是可发现性投影(无 package 时 delegate disabled)', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-actions-1';
      await seedTask(seedValue, taskId, { status: 'in_progress' });
      const overview = await queryOverview(seedValue, taskId);
      const delegate = overview.availableActions.find((a) => a.action === 'delegate-to-agent')!;
      expect(delegate.disabled).toBe(true);
      expect(delegate.disabledReason).toBe('暂无交付文件包');
    });

    test('AC7:minimumConsistency 未追上 → PROJECTION_NOT_READY', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-consistency-1';
      await seedTask(seedValue, taskId, { status: 'todo' });
      const stale = await seedValue.app.queryTaskDeliveryOverview({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        taskId,
        minimumConsistency: token(seedValue.channelId, 5),
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error).toBe('PROJECTION_NOT_READY');
    });

    test('权限:跨频道 task → NOT_FOUND;无 coordination 的裸 task 也能打开', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const other = await seedValue.app.createChannel({
        userId: seedValue.userId, teamId: seedValue.teamId, name: 'other', visibility: 'public',
      });
      if (!other.ok) throw new Error(other.error);
      const taskId = 'task-scope-1';
      await seedTask(seedValue, taskId, { status: 'todo' });
      const wrongChannel = await seedValue.app.queryTaskDeliveryOverview({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: other.channel.id,
        taskId,
      });
      expect(wrongChannel.ok).toBe(false);
      if (!wrongChannel.ok) expect(wrongChannel.error).toBe('NOT_FOUND');
    });

    test('频道任务工作区一次返回受管与普通任务的 Server 治理投影', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const managedTaskId = 'task-workspace-managed';
      await seedTask(seedValue, managedTaskId, { status: 'in_progress' });
      await seedClaim(seedValue, managedTaskId, 'claim-workspace', 'active');
      const plainTaskId = 'task-workspace-plain';
      await seedValue.repositories.tasks.create({
        id: plainTaskId, teamId: seedValue.teamId, title: 'plain', status: 'todo',
        creatorId: seedValue.userId, channelId: seedValue.channelId, tags: [], sortOrder: 1,
        createdAt: 1, updatedAt: 1,
      });

      const result = await seedValue.app.queryChannelTaskWorkspace({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.workspace.schemaVersion).toBe(1);
      expect(result.workspace.audienceScope).toBe(`${seedValue.teamId}:${seedValue.channelId}:${seedValue.userId}`);
      const managed = result.workspace.entries.find((entry) => entry.task.id === managedTaskId)!;
      expect(managed.governance).toMatchObject({
        mode: 'managed',
        sources: ['task_coordination'],
        allowDirectStatusMutation: false,
        allowDirectAssigneeMutation: false,
        allowDirectDelete: false,
      });
      expect(managed.responsibilityFocus).toMatchObject({
        kind: 'execution_active', claimLeaseId: 'claim-workspace', agentId: seedValue.agentId,
      });
      const plain = result.workspace.entries.find((entry) => entry.task.id === plainTaskId)!;
      expect(plain.governance).toMatchObject({
        mode: 'plain', sources: [], allowDirectStatusMutation: true,
        allowDirectAssigneeMutation: true, allowDirectDelete: true,
      });
      expect(plain.responsibilityFocus.kind).toBe('none');
    });

    test('频道任务工作区在 Stage 灰度关闭后仍保留已持久化的治理约束', async () => {
      const seedValue = await seed(variant);
      cleanups.push(seedValue.close);
      const taskId = 'task-workspace-persisted-stage';
      await seedValue.repositories.tasks.create({
        id: taskId, teamId: seedValue.teamId, title: 'persisted stage', status: 'todo',
        creatorId: seedValue.userId, channelId: seedValue.channelId, tags: [], sortOrder: 0,
        createdAt: 1, updatedAt: 1,
      });
      const profile = {
        id: 'profile-workspace-persisted-stage',
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        projectLeadId: seedValue.userId,
        defaultReviewerIds: [seedValue.userId],
        revision: 1,
        createdBy: seedValue.userId,
        createdAt: 1,
        updatedAt: 1,
      };
      const stage = {
        id: 'stage-workspace-persisted-stage',
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        taskId,
        taskRevision: 1,
        name: '持久化阶段',
        goal: '灰度回退后仍保持治理',
        ownerId: seedValue.userId,
        reviewerIds: [seedValue.userId],
        acceptanceCriteria: ['保持只读治理'],
        createdAt: 1,
        updatedAt: 1,
      };
      await seedValue.repositories.channelProjects.createInitialStage({
        expectedRevision: 0,
        profile,
        stage,
        mutation: {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          idempotencyKey: 'persisted-stage-workspace',
          requestFingerprint: 'persisted-stage-workspace',
          profileId: profile.id,
          stageId: stage.id,
          resultRevision: 1,
          resultOverview: {} as never,
          createdAt: 1,
        },
      });
      const rollbackApp = createServerNextUseCases({
        repositories: seedValue.repositories,
        clock: { now: () => 1_000 },
        ids: { nextId: () => 'unused' },
        projectCollaborationRollout: {
          projectStage: false,
          reviewFinalization: false,
          bundleSelection: false,
          inputSetOutput: false,
          managerAutoAdvance: false,
        },
      });

      const result = await rollbackApp.queryChannelTaskWorkspace({
        userId: seedValue.userId,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      const entry = result.workspace.entries.find((item) => item.task.id === taskId)!;
      expect(entry.governance).toMatchObject({
        mode: 'managed',
        sources: ['project_stage'],
        allowDirectStatusMutation: false,
        allowDirectAssigneeMutation: false,
        allowDirectDelete: false,
      });
      expect(entry.review.reviewerIds).toEqual([seedValue.userId]);
      expect(entry.stage).toBeUndefined();
    });
  });
}
