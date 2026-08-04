/**
 * #1064 从 Task 讨论串把冻结文件交给下游 Agent —— Server 集成测试（主 seam）。
 *
 * 覆盖（Seam 1：memory + SQLite 双后端）：
 * - 复验通过 → 消息成功 + 发布 targeted Offer（冻结 artifactVersionId、最小 preview）；
 * - authority 失败 / @不合格 Agent / 频道归档 → fail closed（消息未创建、无 offer、无 claim）；
 * - 同 clientMessageId replay → 不重复发布 Offer（AC12）；
 * - 无 selections / 非 tracked task → 保持既有 simple 路径（AC9，不建 offer 不建 dispatch 双投递）；
 * - review/final basis：被拒版本作为默认输入 → REVIEW_BASIS_BLOCKED；显式选择放行。
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
import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import { createTaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type { TaskCoordinationRecord } from '../src/application/task-coordination-repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };

interface Seed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  userId: string;
  otherUserId: string;
  teamId: string;
  channelId: string;
  agentId: string;
  offlineAgentId: string;
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

/** 任务讨论串的根消息 + 已 tracked 任务（coordination）+ 已 promote 的 artifact version。 */
async function seed(
  variant: (typeof variants)[number],
  options: { tracked?: boolean } = {},
): Promise<Seed> {
  const tracked = options.tracked ?? true;
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
  // outsider：同一 team 的普通成员（非 task requester/authority）。
  await repositories.users.create({
    id: 'user-outsider', username: 'outsider', passwordHash: 'x', role: 'user', createdAt: 1, updatedAt: 1,
  });
  await repositories.teams.addMember({ teamId, userId: 'user-outsider', role: 'member', joinedAt: 1 });
  const otherUserId = 'user-outsider';
  const channel = await app.createChannel({ userId, teamId, name: 'project', visibility: 'public' });
  if (!channel.ok) throw new Error(channel.error);
  const channelId = channel.channel.id;
  const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-a', hostname: 'device-a' });
  if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
  const agents = await app.registerDiscoveredAgents({
    teamId,
    deviceId: hello.device.id,
    agents: [
      { name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' },
      { name: 'Agent-B', adapterKind: 'hermes', category: 'agentos-hosted' },
    ],
  });
  if (!agents.ok) throw new Error(agents.error);
  const agentId = agents.agents[0]!.id;
  const offlineAgentId = agents.agents[1]!.id;
  for (const memberAgentId of [agentId, offlineAgentId]) {
    const member = await app.addChannelAgentMember({ userId, teamId, channelId, agentId: memberAgentId });
    if (!member.ok) throw new Error(member.error);
  }
  // Agent-B 离线：@不合格 Agent 场景（resolveEligibleAgentIds 按在线+可见过滤）。
  await repositories.agents.updateStatus({ agentId: offlineAgentId, status: 'offline', lastSeenAt: 1 });

  // tracked task 先建（promoteArtifact 校验 task 存在且 revision 匹配）。
  await repositories.tasks.create({
    id: 'root-task',
    teamId,
    title: '创作剧本',
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

  // artifact（公开频道文件）+ stage + collection/version（artifact_version 选择可解析）。
  await repositories.artifacts.create({
    id: 'seed-art', teamId, channelId, uploaderId: userId,
    filename: 'script.ep01.md', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
  });
  const profile = {
    id: 'profile-1', teamId, channelId,
    projectLeadId: userId, defaultReviewerIds: [userId], revision: 1,
    createdBy: userId, createdAt: 1, updatedAt: 1,
  };
  const stage = {
    id: 'stage-1', teamId, channelId,
    taskId: 'root-task', taskRevision: 1, name: 'Stage', goal: '产出剧本',
    ownerId: userId, reviewerIds: [userId], acceptanceCriteria: ['完成'],
    createdAt: 1, updatedAt: 1,
  };
  await repositories.channelProjects.createInitialStage({
    expectedRevision: 0, profile, stage,
    mutation: {
      teamId, channelId, idempotencyKey: 'stage-1',
      requestFingerprint: 'stage-1', profileId: profile.id, stageId: stage.id,
      resultRevision: 1, resultOverview: {} as never, createdAt: 1,
    },
  });
  await repositories.channelProjects.promoteArtifact({
    teamId,
    channelId,
    createsCollection: true,
    collection: {
      id: 'collection-1', teamId, channelId,
      name: '剧本', kind: 'file', revision: 1,
      currentVersionId: 'version-1', versionCount: 1,
      createdBy: userId, createdAt: 2, updatedAt: 2,
    },
    version: {
      id: 'version-1', teamId, channelId,
      collectionId: 'collection-1', versionNumber: 1,
      artifactId: 'seed-art', stageId: stage.id,
      taskId: 'root-task', taskRevision: 1, lineage: [],
      promotedBy: userId, createdAt: 2,
    },
    mutation: {
      teamId, channelId, idempotencyKey: 'promote-1',
      requestFingerprint: 'promote-1', collectionId: 'collection-1',
      versionId: 'version-1', createdAt: 2,
    },
  });

  // management run（sqlite task_coordinations.management_run_id FK 需要）。
  await repositories.management.runs.create({
    schemaVersion: 1,
    id: 'run-1',
    teamId,
    channelId,
    rootTaskId: 'root-task',
    rootMessageId: 'msg-root',
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

  // run lease（invokeTask 的 leaseAuthority 校验需要；token='token' 的 sha256）。
  await repositories.management.leases.put({
    managementRunId: 'run-1',
    workerId: 'worker-1',
    host: { kind: 'device', deviceId: 'device-1', profileId: 'profile-1' },
    leaseTokenHash: createHash('sha256').update('token').digest('hex'),
    leaseFingerprint: 'fingerprint',
    fencingToken: 1,
    acquiredAt: 3,
    heartbeatAt: 3,
    expiresAt: 10_000,
  });

  // coordination + criteria + root 消息（meta.taskId 绑定讨论串）。
  const coordination: TaskCoordinationRecord = {
    schemaVersion: 1,
    taskId: 'root-task',
    teamId,
    taskRevision: 1,
    managementRunId: 'run-1',
    nodeKind: 'root',
    reviewPolicy: 'human',
    // task-linked Offer 是 targeted 语义（用户显式 @Agent），coordination 本身保持 open。
    claimPolicy: 'open',
    requiredCapabilities: [],
    maxAttempts: 1,
    attempt: 1,
    humanAcceptanceAuthorityIds: [userId],
    createdAt: 3,
    updatedAt: 3,
  };
  if (tracked) {
    await repositories.taskCoordination.coordinations.create(coordination);
    await repositories.taskCoordination.criteria.create({
    taskId: 'root-task',
    id: 'criterion-1',
    description: '完成剧本初稿',
    evidenceRequired: false,
      introducedRevision: 1,
      position: 0,
    });
  }
  await repositories.messages.append({
    id: 'msg-root',
    teamId,
    channelId,
    threadId: 'msg-root',
    senderKind: 'human',
    senderId: userId,
    body: '创建任务：创作剧本',
    createdAt: 3,
    meta: { taskId: 'root-task' },
  });

  // subtask（可 claim）：task-linked acceptance/Invocation 测试使用。
  await repositories.tasks.create({
    id: 'task-child',
    teamId,
    title: '改写剧本',
    status: 'in_progress',
    creatorId: userId,
    channelId,
    tags: [],
    sortOrder: 1,
    revision: 1,
    supersededByRevision: null,
    createdAt: 4,
    updatedAt: 4,
  });
  if (tracked) {
    await repositories.taskCoordination.coordinations.create({
      schemaVersion: 1,
      taskId: 'task-child',
      teamId,
      taskRevision: 1,
      rootTaskId: 'root-task',
      parentTaskId: 'root-task',
      managementRunId: 'run-1',
      nodeKind: 'subtask',
      reviewPolicy: 'human',
      claimPolicy: 'open',
      requiredCapabilities: [],
      maxAttempts: 1,
      attempt: 1,
      humanAcceptanceAuthorityIds: [userId],
      createdAt: 4,
      updatedAt: 4,
    });
  }
  await repositories.messages.append({
    id: 'msg-child',
    teamId,
    channelId,
    threadId: 'msg-child',
    senderKind: 'human',
    senderId: userId,
    body: '子任务：改写剧本',
    createdAt: 4,
    meta: { taskId: 'task-child' },
  });

  return {
    repositories,
    app,
    userId,
    otherUserId,
    teamId,
    channelId,
    agentId,
    offlineAgentId,
    close,
  };
}

function taskLinkedRequest(seedValue: Seed, over: Record<string, unknown> = {}) {
  return {
    userId: seedValue.userId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    body: '@Agent-A 请基于交付继续处理',
    threadId: 'msg-root',
    clientMessageId: 'client-task-link-1',
    meta: { mentions: [{ id: seedValue.agentId, name: 'Agent-A', kind: 'agent', start: 0, end: 8 }] },
    selections: [{ kind: 'artifact_version', collectionId: 'collection-1', versionId: 'version-1' }],
    ...over,
  };
}

describe.each(variants)('Task-linked @Agent 请求（%s）', (variant) => {
  afterEach(() => { variant.make().close(); });

  test('复验通过 → 消息成功 + 发布 targeted Offer（冻结 artifactVersionId，最小 preview）', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue));
      if (!sent.ok) console.log('SEND FAIL:', sent.error, sent.message, JSON.stringify(sent.details));
      expect(sent.ok).toBe(true);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(1);
      const offer = offers[0]!;
      expect(offer.agentId).toBe(seedValue.agentId);
      expect(offer.hardSpecified).toBe(true);
      expect(offer.taskRevision).toBe(1);
      expect(offer.status).toBe('open');
      // 冻结输入：具体 artifactVersionId + 解析当刻 basis。
      expect(offer.frozenInputs).toEqual([
        expect.objectContaining({
          collectionId: 'collection-1',
          artifactVersionId: 'version-1',
          versionNumber: 1,
          filename: 'script.ep01.md',
          isFinal: false,
          reviewState: 'pending',
        }),
      ]);
      // 最小 preview（AC4）：objective.inputs 只披露文件名摘要。
      expect(offer.objective.inputs).toEqual(['script.ep01.md']);
      expect(offer.objective.deliverables).toEqual(['完成剧本初稿']);
      // 消息已创建（未走 dispatch 双投递——AC9）。
      const dispatch = await seedValue.repositories.dispatches.listByMessage(sent.message.id);
      expect(dispatch).toHaveLength(0);
    } finally { seedValue.close(); }
  });

  test('非 requester（无 authority）→ fail closed：消息未创建、无 offer', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue, { userId: seedValue.otherUserId }));
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.error).toBe('CONFLICT');
        expect(sent.details?.taskLinkedCode).toBe('TASK_AUTHORITY_DENIED');
      }
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(0);
      const messages = await seedValue.repositories.messages.listByChannel(seedValue.channelId, 50);
      expect(messages.some((message) => message.body.includes('请基于交付'))).toBe(false);
    } finally { seedValue.close(); }
  });

  test('@ 不合格 Agent（离线）→ AGENT_NOT_ELIGIBLE，不静默改派（AC5）', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue, {
        body: '@Agent-B 请继续',
        meta: { mentions: [{ id: seedValue.offlineAgentId, name: 'Agent-B', kind: 'agent', start: 0, end: 8 }] },
      }));
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.details?.taskLinkedCode).toBe('AGENT_NOT_ELIGIBLE');
      }
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(0);
    } finally { seedValue.close(); }
  });

  test('Channel 归档 → 消息层拒绝，无 offer、无 claim', async () => {
    const seedValue = await seed(variant);
    try {
      await seedValue.repositories.channels.archive({ channelId: seedValue.channelId, timestamp: 999 });
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue));
      expect(sent.ok).toBe(false);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(0);
    } finally { seedValue.close(); }
  });

  test('同 clientMessageId replay → 不重复发布 Offer（AC12）', async () => {
    const seedValue = await seed(variant);
    try {
      const first = await seedValue.app.sendMessage(taskLinkedRequest(seedValue));
      expect(first.ok).toBe(true);
      const second = await seedValue.app.sendMessage(taskLinkedRequest(seedValue));
      expect(second.ok).toBe(true);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(1);
    } finally { seedValue.close(); }
  });

  test('无项目引用（无 selections）→ 保持既有 simple 路径：无 offer、走 dispatch（AC9）', async () => {
    const seedValue = await seed(variant);
    try {
      const { selections: _dropped, ...withoutSelections } = taskLinkedRequest(seedValue);
      const sent = await seedValue.app.sendMessage(withoutSelections as never);
      expect(sent.ok).toBe(true);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(0);
      const dispatches = await seedValue.repositories.dispatches.listByMessage(sent.message.id);
      expect(dispatches.length).toBeGreaterThan(0);
    } finally { seedValue.close(); }
  });

  test('非 tracked task（无 coordination）→ 消息成功、无 offer（不建第二套协议）', async () => {
    const seedValue = await seed(variant, { tracked: false });
    try {
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue));
      if (!sent.ok) console.log('SEND FAIL:', sent.error, sent.message, JSON.stringify(sent.details));
      expect(sent.ok).toBe(true);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(0);
    } finally { seedValue.close(); }
  });

  test('review/final basis：指针解析输入 reviewState 冻结；显式选择放行（基于此修改）', async () => {
    const seedValue = await seed(variant);
    try {
      await seedValue.repositories.channelProjects.appendArtifactReview({
        review: {
          id: 'review-rejected', teamId: seedValue.teamId, channelId: seedValue.channelId,
          collectionId: 'collection-1', versionId: 'version-1',
          stageId: 'stage-1', decision: 'rejected', comment: '重写',
          authorityBasis: 'root-review-authority',
          basis: [], reviewedBy: seedValue.userId, createdAt: 50,
        },
        mutation: {
          teamId: seedValue.teamId, channelId: seedValue.channelId,
          idempotencyKey: 'review-rejected', requestFingerprint: 'review-rejected',
          kind: 'review', collectionId: 'collection-1', versionId: 'version-1',
          reviewId: 'review-rejected', createdAt: 50,
        },
      });
      // 显式「基于此修改」（artifact_version 是显式选择，不过 review 闸）→ 放行，
      // 且 frozenInputs 冻结解析当刻的 review basis（rejected）供 acceptance 复验。
      const explicit = await seedValue.app.sendMessage(taskLinkedRequest(seedValue));
      expect(explicit.ok).toBe(true);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(1);
      expect(offers[0]!.frozenInputs![0]!.reviewState).toBe('rejected');
    } finally { seedValue.close(); }
  });

  test('review/final basis：被拒版本作为默认输入（指针解析、非显式）→ REVIEW_BASIS_BLOCKED', async () => {
    const seedValue = await seed(variant);
    try {
      await seedValue.repositories.channelProjects.appendArtifactReview({
        review: {
          id: 'review-rejected-2', teamId: seedValue.teamId, channelId: seedValue.channelId,
          collectionId: 'collection-1', versionId: 'version-1',
          stageId: 'stage-1', decision: 'rejected', comment: '重写',
          authorityBasis: 'root-review-authority',
          basis: [], reviewedBy: seedValue.userId, createdAt: 50,
        },
        mutation: {
          teamId: seedValue.teamId, channelId: seedValue.channelId,
          idempotencyKey: 'review-rejected-2', requestFingerprint: 'review-rejected-2',
          kind: 'review', collectionId: 'collection-1', versionId: 'version-1',
          reviewId: 'review-rejected-2', createdAt: 50,
        },
      });
      const { evaluateTaskLinkedRequestContext } = await import('../src/application/task-linked-request-handler.js');
      const coordination = await seedValue.repositories.taskCoordination.coordinations.getByTaskId('root-task');
      const task = await seedValue.repositories.tasks.getById('root-task');
      if (!task || !coordination) throw new Error('expected task/coordination');
      const evaluation = await evaluateTaskLinkedRequestContext(
        {
          repositories: seedValue.repositories,
          ids: { nextId: () => 'id-x' },
          clock: { now: () => 999 },
          resolveEligibleAgentIds: async () => [seedValue.agentId],
        },
        {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          senderUserId: seedValue.userId,
          channelArchived: false,
          task,
          coordination,
          expectedTaskRevision: task.revision,
          expectedTaskAttempt: coordination.attempt,
          requestedAgentIds: [seedValue.agentId],
          // 指针解析（package_projection current）产生的 preview：reviewState 冻结为 rejected。
          previews: [{
            sourceKind: 'package_current',
            package: { packageId: 'pkg-1', policy: 'current', memberCount: 1 },
            items: [{
              kind: 'artifact_version',
              collectionId: 'collection-1',
              versionId: 'version-1',
              versionNumber: 1,
              artifactId: 'seed-art',
              filename: 'script.ep01.md',
              collectionRevision: 1,
            }],
          }],
          selectionRequests: [{
            kind: 'package_projection', packageId: 'pkg-1', policy: 'current',
            expectedMemberRevisions: [{ collectionId: 'collection-1', revision: 1 }],
          }],
          sourceMessageId: 'msg-root',
        },
      );
      expect(evaluation).toEqual({
        kind: 'rejected',
        code: 'REVIEW_BASIS_BLOCKED',
        blockedVersionIds: ['version-1'],
      });
    } finally { seedValue.close(); }
  });

  test('纯 @人类 mention + 引用 → 不触发 task-linked，回到既有 dispatch 路径（AC9）', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '@outsider 请基于交付继续处理',
        threadId: 'msg-root',
        clientMessageId: 'client-human-only-1',
        meta: { mentions: [{ id: seedValue.otherUserId, name: 'outsider', kind: 'human', start: 0, end: 10 }] },
        selections: [{ kind: 'artifact_version', collectionId: 'collection-1', versionId: 'version-1' }],
      });
      expect(sent.ok).toBe(true);
      // 无 offer；@人类 提及不触发 agent dispatch（既有语义），消息正常落地、不悬空。
      expect(await seedValue.repositories.taskCoordination.offers.listByTask('root-task')).toHaveLength(0);
      const dispatches = await seedValue.repositories.dispatches.listByMessage(sent.message.id);
      expect(dispatches).toHaveLength(0);
    } finally { seedValue.close(); }
  });

  test('@人类 + @Agent 混合 → 只对显式 @Agent 发布 Offer，人类提及不影响', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
        body: '@Agent-A @outsider 请基于交付继续处理',
        threadId: 'msg-root',
        clientMessageId: 'client-mixed-1',
        meta: {
          mentions: [
            { id: seedValue.agentId, name: 'Agent-A', kind: 'agent', start: 0, end: 8 },
            { id: seedValue.otherUserId, name: 'outsider', kind: 'human', start: 9, end: 19 },
          ],
        },
        selections: [{ kind: 'artifact_version', collectionId: 'collection-1', versionId: 'version-1' }],
      });
      expect(sent.ok).toBe(true);
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('root-task');
      expect(offers).toHaveLength(1);
      expect(offers[0]!.agentId).toBe(seedValue.agentId);
    } finally { seedValue.close(); }
  });

  test('Offer 过期 → not_accepted（TTL fail closed，无 claim）', async () => {
    const seedValue = await seed(variant);
    try {
      await seedValue.repositories.taskCoordination.offers.create({
        id: 'offer-expired', teamId: seedValue.teamId, taskId: 'task-child', agentId: seedValue.agentId,
        taskRevision: 1, taskAttempt: 1, manifestRevision: 0,
        objective: {
          objective: 'x', inputs: [], deliverables: [], constraints: [],
          riskLevel: 'low', requiredCapabilities: [], requiredSkills: [], preferredSkills: [],
        },
        offerTtlMs: 15000, offerExpiresAt: 500, // 已过期（now=1000）
        hardSpecified: true, requirementConfirmation: false,
        status: 'open', response: null, createdAt: 100, updatedAt: 100,
      });
      const broker = createTaskClaimBroker({
        repositories: seedValue.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => 'id-broker' },
      });
      const result = await broker.respondToOffer({
        offerId: 'offer-expired', agentId: seedValue.agentId, kind: 'accepted',
      });
      expect(result.kind).toBe('not_accepted');
      const claim = await seedValue.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: 'task-child', taskRevision: 1, taskAttempt: 1,
      });
      expect(claim).toBeNull();
    } finally { seedValue.close(); }
  });

  test('acceptance 时 Channel 已归档 → not_accepted（AC8 归档 fail closed）', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue, {
        threadId: 'msg-child', clientMessageId: 'client-arch-1',
      }));
      expect(sent.ok).toBe(true);
      await seedValue.repositories.channels.archive({ channelId: seedValue.channelId, timestamp: 900 });
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('task-child');
      const broker = createTaskClaimBroker({
        repositories: seedValue.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => 'id-broker' },
      });
      const result = await broker.respondToOffer({
        offerId: offers[0]!.id, agentId: seedValue.agentId, kind: 'accepted',
      });
      expect(result.kind).toBe('not_accepted');
      if (result.kind === 'not_accepted') {
        expect(result.diagnosticCode).toBe('TASK_CLAIM_CHANNEL_ARCHIVED');
      }
      const claim = await seedValue.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: 'task-child', taskRevision: 1, taskAttempt: 1,
      });
      expect(claim).toBeNull();
    } finally { seedValue.close(); }
  });

  test('acceptance 时 review/final basis 已变化 → not_accepted（AC8 basis 变化 fail closed）', async () => {
    const seedValue = await seed(variant);
    try {
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue, {
        threadId: 'msg-child', clientMessageId: 'client-basis-1',
      }));
      expect(sent.ok).toBe(true);
      // offer 冻结时 reviewState=pending；接受前被拒绝 → basis 变化 fail closed。
      await seedValue.repositories.channelProjects.appendArtifactReview({
        review: {
          id: 'review-late-reject', teamId: seedValue.teamId, channelId: seedValue.channelId,
          collectionId: 'collection-1', versionId: 'version-1',
          stageId: 'stage-1', decision: 'rejected', comment: '重写',
          authorityBasis: 'root-review-authority',
          basis: [], reviewedBy: seedValue.userId, createdAt: 950,
        },
        mutation: {
          teamId: seedValue.teamId, channelId: seedValue.channelId,
          idempotencyKey: 'review-late-reject', requestFingerprint: 'review-late-reject',
          kind: 'review', collectionId: 'collection-1', versionId: 'version-1',
          reviewId: 'review-late-reject', createdAt: 950,
        },
      });
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('task-child');
      const broker = createTaskClaimBroker({
        repositories: seedValue.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => 'id-broker' },
      });
      const result = await broker.respondToOffer({
        offerId: offers[0]!.id, agentId: seedValue.agentId, kind: 'accepted',
      });
      expect(result.kind).toBe('not_accepted');
      if (result.kind === 'not_accepted') {
        expect(result.diagnosticCode).toBe('TASK_CLAIM_FROZEN_BASIS_CHANGED');
      }
      const claim = await seedValue.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: 'task-child', taskRevision: 1, taskAttempt: 1,
      });
      expect(claim).toBeNull();
    } finally { seedValue.close(); }
  });

  test('task revision 漂移 → TASK_REVISION_STALE（handler 层直接评估，fail closed）', async () => {
    const seedValue = await seed(variant);
    try {
      const { evaluateTaskLinkedRequestContext } = await import('../src/application/task-linked-request-handler.js');
      const coordination = await seedValue.repositories.taskCoordination.coordinations.getByTaskId('root-task');
      const task = await seedValue.repositories.tasks.getById('root-task');
      if (!task || !coordination) throw new Error('expected task/coordination');
      const evaluation = await evaluateTaskLinkedRequestContext(
        {
          repositories: seedValue.repositories,
          ids: { nextId: () => 'id-x' },
          clock: { now: () => 999 },
          resolveEligibleAgentIds: async () => [seedValue.agentId],
        },
        {
          teamId: seedValue.teamId,
          channelId: seedValue.channelId,
          senderUserId: seedValue.userId,
          channelArchived: false,
          task: { ...task, revision: 2 }, // 模拟 revision 已漂移
          coordination,
          expectedTaskRevision: 1, // 客户端携带发送时快照
          expectedTaskAttempt: coordination.attempt,
          requestedAgentIds: [seedValue.agentId],
          previews: [{ sourceKind: 'artifact_version', items: [] }],
          selectionRequests: [],
          sourceMessageId: 'msg-root',
        },
      );
      expect(evaluation).toEqual({ kind: 'rejected', code: 'TASK_REVISION_STALE' });
    } finally { seedValue.close(); }
  });

  test('acceptance 复验：冻结版本已不存在 → not_accepted，无 claim/grant（AC6 fail closed）', async () => {
    const seedValue = await seed(variant);
    try {
      let brokerId = 0;
      const broker = createTaskClaimBroker({
        repositories: seedValue.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => `id-broker-${++brokerId}` },
      });
      // 手工造带 ghost frozenInputs 的 offer（模拟 offer 冻结后版本被删除/漂移）。
      await seedValue.repositories.taskCoordination.offers.create({
        id: 'offer-ghost', teamId: seedValue.teamId, taskId: 'task-child', agentId: seedValue.agentId,
        taskRevision: 1, taskAttempt: 1, manifestRevision: 0,
        objective: {
          objective: 'x', inputs: [], deliverables: [], constraints: [],
          riskLevel: 'low', requiredCapabilities: [], requiredSkills: [], preferredSkills: [],
        },
        offerTtlMs: 15000, offerExpiresAt: 1000 + 15000,
        hardSpecified: true, requirementConfirmation: false,
        frozenInputs: [{
          collectionId: 'collection-1', artifactVersionId: 'ghost-version',
          versionNumber: 9, artifactId: 'ghost-artifact', filename: 'ghost.md',
          isFinal: false, reviewState: 'pending',
        }],
        status: 'open', response: null, createdAt: 1000, updatedAt: 1000,
      });
      const result = await broker.respondToOffer({
        offerId: 'offer-ghost', agentId: seedValue.agentId, kind: 'accepted',
      });
      expect(result.kind).toBe('not_accepted');
      if (result.kind === 'not_accepted') {
        expect(result.diagnosticCode).toBe('TASK_CLAIM_FROZEN_INPUT_STALE');
      }
      // 不留部分事实：无 active claim、无 grant。
      const claim = await seedValue.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: 'task-child', taskRevision: 1, taskAttempt: 1,
      });
      expect(claim).toBeNull();
      const grants = await seedValue.repositories.taskCoordination.executionGrants.listActiveByTask('task-child');
      expect(grants).toHaveLength(0);
    } finally { seedValue.close(); }
  });

  test('Invocation intent 冻结 frozenInputs：acceptance 后创建 Invocation，intent 含 artifactVersionId + basis（AC7）', async () => {
    const seedValue = await seed(variant);
    try {
      // task-linked 消息（child 讨论串）→ offer（冻结 version-1 + review basis）。
      const sent = await seedValue.app.sendMessage(taskLinkedRequest(seedValue, {
        threadId: 'msg-child',
        clientMessageId: 'client-child-1',
      }));
      expect(sent.ok).toBe(true);
      let brokerId = 0;
      const broker = createTaskClaimBroker({
        repositories: seedValue.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => `id-broker-${++brokerId}` },
      });
      const offers = await seedValue.repositories.taskCoordination.offers.listByTask('task-child');
      expect(offers).toHaveLength(1);
      const accepted = await broker.respondToOffer({
        offerId: offers[0]!.id, agentId: seedValue.agentId, kind: 'accepted',
      });
      expect(accepted.kind).toBe('claim_granted');
      const claim = await seedValue.repositories.taskCoordination.claimLeases.getCurrent({
        taskId: 'task-child', taskRevision: 1, taskAttempt: 1,
      });
      if (!claim) throw new Error('claim expected after acceptance');
      let invId = 0;
      const gateway = createInvocationGateway({
        repositories: seedValue.repositories,
        clock: { now: () => 1000 },
        ids: { nextId: () => `id-inv-${++invId}` },
      });
      const created = await gateway.invokeTask({
        authority: { managementRunId: 'run-1', workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 },
        idempotencyKey: 'invoke-task-linked-1',
        taskId: 'task-child', expectedTaskRevision: 1, taskAttempt: 1,
        claimLeaseId: claim.id, objective: '基于交付继续处理', attachmentIds: [],
      });
      expect(created.disposition).toBe('created');
      // AC7：intent 写入冻结的具体 artifactVersionId + 解析当刻 basis，执行期不重新解析。
      expect(created.view.intent.frozenInputs).toEqual([expect.objectContaining({
        collectionId: 'collection-1',
        artifactVersionId: 'version-1',
        versionNumber: 1,
        filename: 'script.ep01.md',
        isFinal: false,
        reviewState: 'pending',
      })]);
    } finally { seedValue.close(); }
  });
});
