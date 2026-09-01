import { describe, expect, test, vi } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createTaskClaimBroker } from '../src/application/management/task-claim-broker.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

async function enableAutomaticRouting(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  teamId: string,
  withPiPolicy: boolean,
) {
  await repositories.teamPiAuthorityMigrations.upsert({
    teamId, authorityEpoch: 1, migrationRevision: 1, state: 'new_authority',
    legacyWriterFenced: true, emergencyStop: false, cutoverVersion: 1,
    cutoverAt: 1, cutoverBy: 'owner', drainDeadlineAt: null, createdAt: 1, updatedAt: 1,
  });
  if (withPiPolicy) {
    await repositories.taskCoordinationUnitOfWork.run((tx) => tx.promotion.teamPolicy.upsert({
      schemaVersion: 1, teamId, revision: 1, enabled: true,
      ruleId: 'pi-message-route-v1', preauthorized: true,
      requireOrchestrationNeed: true, updatedAt: 1,
    }));
  }
}

async function waitForRouteResolution(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  messageId: string,
) {
  await vi.waitFor(async () => {
    const route = await repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(messageId));
    expect(route?.status).not.toBe('pending');
    expect(route?.status).not.toBe('running');
  });
}

describe('automatic channel collaboration routing (#1270)', () => {
  test('发送 ACK 不等待外部 PI，durable route 在后台继续处理', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    let releaseAnalyzer!: (value: { unavailable: true; diagnosticCode: string }) => void;
    const analyzerResult = new Promise<{ unavailable: true; diagnosticCode: string }>((resolve) => {
      releaseAnalyzer = resolve;
    });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: () => `async-route-${++id}` },
      analyzeMessageRouteWithPi: async () => analyzerResult,
    });
    const registered = await app.registerUser({ username: 'async-owner', password: 'secret', teamName: 'Async' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    await enableAutomaticRouting(repositories, teamId, true);
    const channel = await app.createChannel({ userId, teamId, name: 'Async route', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);

    const sent = await app.sendMessage({
      userId, teamId, channelId: channel.channel.id, body: '请分析这个任务',
    });
    expect(sent).toMatchObject({ ok: true, dispatches: [] });
    await vi.waitFor(async () => {
      const route = sent.ok
        ? await repositories.channelCoordinationUnitOfWork.run((tx) => tx.routes.getByMessageId(sent.message.id))
        : null;
      expect(route?.status).toBe('running');
    });
    releaseAnalyzer({ unavailable: true, diagnosticCode: 'PI_ROUTE_TEST_UNAVAILABLE' });
    if (sent.ok) await waitForRouteResolution(repositories, sent.message.id);
  });

  test('显式 semantic rollout 配置阻止 PI 绕过 Team policy 直接提升 Task', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    const ids = { nextId: () => `rollout-route-${++id}` };
    const clock = { now: () => 100 };
    const setupApp = createServerNextUseCases({ repositories, ids, clock });
    const registered = await setupApp.registerUser({ username: 'rollout-owner', password: 'secret', teamName: 'Rollout' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    await enableAutomaticRouting(repositories, teamId, true);
    await repositories.taskCoordinationUnitOfWork.run((tx) => tx.promotion.semanticRollout.upsert({
      schemaVersion: 1, teamId, mode: 'off', revision: 1, updatedAt: 100,
    }));
    const channel = await setupApp.createChannel({ userId, teamId, name: 'Rollout', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await setupApp.deviceHello({ teamId, ownerId: userId, machineId: 'rollout-machine', hostname: 'host' });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await setupApp.registerDiscoveredAgents({
      teamId, deviceId: hello.device.id,
      agents: [{ name: 'Reviewer', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    const reviewer = discovered.ok ? discovered.agents[0] : undefined;
    if (!reviewer) throw new Error('agent missing');
    await setupApp.addChannelAgentMember({ userId, teamId, channelId: channel.channel.id, agentId: reviewer.id });
    await repositories.agentExposure.manifests.create({
      id: `manifest-${reviewer.id}`, teamId, agentId: reviewer.id, revision: 1, status: 'active',
      capabilities: [], skills: [], constraints: [], availability: { status: 'available' },
      validFrom: 0, validUntil: null, createdBy: userId, now: 100,
    });
    const routedApp = createServerNextUseCases({
      repositories, ids, clock,
      analyzeMessageRouteWithPi: async () => ({
        routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: [reviewer.id],
        requiredCapabilityIds: [], subtasks: [{
          title: '审查', objective: '审查方案', targetAgentId: reviewer.id,
          requiredCapabilityIds: [], acceptanceCriteria: ['给出结论'], dependsOnSubtaskIndexes: [],
        }],
      }),
    });
    const sent = await routedApp.sendMessage({
      userId, teamId, channelId: channel.channel.id, body: '请审查方案',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await waitForRouteResolution(repositories, sent.message.id);
    await expect(repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(sent.message.id))).resolves.toMatchObject({
      status: 'deferred', diagnosticCode: 'MESSAGE_ROUTE_SEMANTIC_ROLLOUT_REQUIRES_REVIEW',
      linkedTaskId: null,
    });
  });

  test('不勾选协作、不 @Agent，也能把低风险 collective message 自动分解为每 Agent 一个 Offer', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    let now = 100;
    const ids = { nextId: () => `auto-route-${++id}` };
    const clock = { now: () => ++now };
    const broker = createTaskClaimBroker({ repositories, ids, clock, offerTtlMs: 60_000 });
    const app = createServerNextUseCases({
      repositories, ids, clock,
      onChannelCollaborationTasksPublished: async (taskIds) => {
        let offered = 0;
        for (const taskId of taskIds) offered += (await broker.prepareOffers(taskId)).length;
        return { offered };
      },
    });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    await enableAutomaticRouting(repositories, teamId, false);
    const created = await app.createChannel({ userId, teamId, name: '协作', visibility: 'public' });
    if (!created.ok) throw new Error(created.error);
    const channelId = created.channel.id;
    const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'm1', hostname: 'host' });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await app.registerDiscoveredAgents({
      teamId, deviceId: hello.device.id,
      agents: [
        { name: 'Alpha', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Beta', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Gamma', adapterKind: 'hermes', category: 'agentos-hosted' },
      ],
    });
    if (!discovered.ok) throw new Error(discovered.error);
    for (const agent of discovered.agents) {
      const added = await app.addChannelAgentMember({ userId, teamId, channelId, agentId: agent.id });
      if (!added.ok) throw new Error(added.error);
      await repositories.agentExposure.manifests.create({
        id: `manifest-${agent.id}`, teamId, agentId: agent.id, revision: 1, status: 'active',
        capabilities: [], skills: [], constraints: [], availability: { status: 'available' },
        validFrom: 0, validUntil: null, createdBy: userId, now: clock.now(),
      });
      const policy = await app.upsertAgentAutoAcceptPolicy({
        userId, teamId, agentId: agent.id, enabled: true, allowedCapabilityIds: [],
        allowUnspecifiedCapabilities: true, allowedRiskLevels: ['low'],
        maxActiveClaims: 1,
      });
      if (!policy.ok) throw new Error(policy.error);
    }

    const sent = await app.sendMessage({
      userId, teamId, channelId, clientMessageId: 'natural-collaboration',
      body: '各位，请分别介绍一下自己吧',
    });
    expect(sent).toMatchObject({ ok: true, dispatches: [] });
    if (!sent.ok) return;
    expect(sent).not.toHaveProperty('collaborationTask');
    await waitForRouteResolution(repositories, sent.message.id);

    const listed = await app.listTasks({ userId, teamId, channelId });
    if (!listed.ok) throw new Error(listed.error);
    expect(listed.tasks).toHaveLength(4);
    const subtasks = listed.tasks.filter((task) => task.tags.includes('channel-collaboration'));
    expect(subtasks).toHaveLength(3);
    expect(subtasks.map((task) => task.assigneeId).sort())
      .toEqual(discovered.agents.map((agent) => agent.id).sort());
    for (const task of subtasks) {
      const offers = await repositories.taskCoordination.offers.listByTask(task.id);
      expect(offers).toHaveLength(1);
      expect(offers[0]?.status).toBe('accepted');
      const coordination = await repositories.taskCoordination.coordinations.getByTaskId(task.id);
      const claim = await repositories.taskCoordination.claimLeases.getCurrent({
        taskId: task.id, taskRevision: task.revision, taskAttempt: coordination!.attempt,
      });
      expect(claim).toMatchObject({ status: 'active', agentId: task.assigneeId });
    }
    const route = await repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(sent.message.id));
    expect(route).toMatchObject({
      status: 'resolved', routeKind: 'collaboration', intentSource: 'deterministic_fallback',
      linkedTaskId: expect.any(String),
    });
    await expect(repositories.messages.getById(sent.message.id)).resolves.toMatchObject({
      body: '各位，请分别介绍一下自己吧',
    });
  });

  test('PI 为未指派简单请求选择 qualified Agent，并自动 acceptance 与 Claim', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    let now = 500;
    const ids = { nextId: () => `direct-route-${++id}` };
    const clock = { now: () => ++now };
    const broker = createTaskClaimBroker({ repositories, ids, clock, offerTtlMs: 60_000 });
    const setupApp = createServerNextUseCases({ repositories, ids, clock });
    const registered = await setupApp.registerUser({ username: 'direct-owner', password: 'secret', teamName: 'Direct' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    await enableAutomaticRouting(repositories, teamId, true);
    const channel = await setupApp.createChannel({ userId, teamId, name: '简单任务', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await setupApp.deviceHello({ teamId, ownerId: userId, machineId: 'direct-machine', hostname: 'host' });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await setupApp.registerDiscoveredAgents({
      teamId, deviceId: hello.device.id,
      agents: [{ name: 'Reviewer', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    if (!discovered.ok || !discovered.agents[0]) throw new Error('agent missing');
    const reviewer = discovered.agents[0];
    const routedApp = createServerNextUseCases({
      repositories, ids, clock,
      analyzeMessageRouteWithPi: async () => ({
        routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: [reviewer.id],
        requiredCapabilityIds: ['capability:v1:code-review'],
        subtasks: [{
          title: '审查方案', objective: '审查当前方案', targetAgentId: reviewer.id,
          requiredCapabilityIds: ['capability:v1:code-review'], acceptanceCriteria: ['给出审查结论'],
          dependsOnSubtaskIndexes: [],
        }],
      }),
      onChannelCollaborationTasksPublished: async (taskIds) => {
        let offered = 0;
        for (const taskId of taskIds) offered += (await broker.prepareOffers(taskId)).length;
        return { offered };
      },
    });
    const added = await routedApp.addChannelAgentMember({
      userId, teamId, channelId: channel.channel.id, agentId: reviewer.id,
    });
    if (!added.ok) throw new Error(added.error);
    await repositories.agentExposure.manifests.create({
      id: `manifest-${reviewer.id}`, teamId, agentId: reviewer.id, revision: 1, status: 'active',
      capabilities: [{
        name: 'code review', description: 'code review',
        registry: { capabilityId: 'capability:v1:code-review', registryVersion: 1 }, evidence: [],
      }],
      skills: [], constraints: [], availability: { status: 'available' },
      validFrom: 0, validUntil: null, createdBy: userId, now: clock.now(),
    });
    const policy = await routedApp.upsertAgentAutoAcceptPolicy({
      userId, teamId, agentId: reviewer.id, enabled: true,
      allowedCapabilityIds: ['capability:v1:code-review'], allowUnspecifiedCapabilities: false,
      allowedRiskLevels: ['low'], maxActiveClaims: 1,
    });
    if (!policy.ok) throw new Error(policy.error);

    await repositories.taskCoordinationUnitOfWork.run((tx) => tx.promotion.teamPolicy.upsert({
      schemaVersion: 1, teamId, revision: 2, enabled: false,
      ruleId: 'pi-message-route-v1', preauthorized: true,
      requireOrchestrationNeed: true, updatedAt: clock.now(),
    }));
    const policyBlocked = await routedApp.sendMessage({
      userId, teamId, channelId: channel.channel.id, clientMessageId: 'policy-disabled',
      body: '请审查另一个方案',
    });
    expect(policyBlocked.ok).toBe(true);
    if (!policyBlocked.ok) return;
    await waitForRouteResolution(repositories, policyBlocked.message.id);
    await expect(repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(policyBlocked.message.id))).resolves.toMatchObject({
      status: 'deferred', diagnosticCode: 'POLICY_DISABLED', linkedTaskId: null,
    });
    await repositories.taskCoordinationUnitOfWork.run((tx) => tx.promotion.teamPolicy.upsert({
      schemaVersion: 1, teamId, revision: 3, enabled: true,
      ruleId: 'pi-message-route-v1', preauthorized: true,
      requireOrchestrationNeed: true, updatedAt: clock.now(),
    }));

    const riskBlocked = await routedApp.sendMessage({
      userId, teamId, channelId: channel.channel.id, clientMessageId: 'server-risk',
      body: '请删除生产数据库中的全部数据',
    });
    expect(riskBlocked.ok).toBe(true);
    if (!riskBlocked.ok) return;
    await waitForRouteResolution(repositories, riskBlocked.message.id);
    await expect(repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(riskBlocked.message.id))).resolves.toMatchObject({
      status: 'resolved', routeKind: 'clarification', riskLevel: 'high',
      diagnosticCode: 'MESSAGE_ROUTE_HIGH_RISK_REQUIRES_HUMAN', linkedTaskId: null,
    });

    const sent = await routedApp.sendMessage({
      userId, teamId, channelId: channel.channel.id, clientMessageId: 'direct-natural',
      body: '请审查当前方案并给出结论',
    });
    expect(sent).toMatchObject({ ok: true, dispatches: [] });
    if (!sent.ok) return;
    await waitForRouteResolution(repositories, sent.message.id);
    const route = await repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(sent.message.id));
    expect(route).toMatchObject({
      status: 'resolved', routeKind: 'direct_agent', intentSource: 'pi', linkedTaskId: expect.any(String),
    });
    const listed = await routedApp.listTasks({ userId, teamId, channelId: channel.channel.id });
    if (!listed.ok) throw new Error(listed.error);
    const [subtask] = listed.tasks.filter((task) => task.tags.includes('channel-collaboration'));
    expect(subtask).toMatchObject({ assigneeId: reviewer.id, status: 'in_progress' });
    const [offer] = await repositories.taskCoordination.offers.listByTask(subtask!.id);
    expect(offer).toMatchObject({ status: 'accepted', agentId: reviewer.id });
    const coordination = await repositories.taskCoordination.coordinations.getByTaskId(subtask!.id);
    await expect(repositories.taskCoordination.claimLeases.getCurrent({
      taskId: subtask!.id, taskRevision: subtask!.revision, taskAttempt: coordination!.attempt,
    })).resolves.toMatchObject({ status: 'active', agentId: reviewer.id });
  });

  test('PI 可把普通未指派消息拆成多个能力匹配子任务，并发布定向 Offer', async () => {
    const repositories = createInMemoryRepositories();
    let id = 0;
    let now = 1_000;
    const ids = { nextId: () => `pi-route-${++id}` };
    const clock = { now: () => ++now };
    const broker = createTaskClaimBroker({ repositories, ids, clock, offerTtlMs: 60_000 });
    const app = createServerNextUseCases({ repositories, ids, clock });
    const registered = await app.registerUser({ username: 'owner2', password: 'secret', teamName: 'Team2' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    await enableAutomaticRouting(repositories, teamId, true);
    const channel = await app.createChannel({ userId, teamId, name: '智能路由', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'm2', hostname: 'host' });
    if (!hello.ok) throw new Error(hello.error);
    const discovered = await app.registerDiscoveredAgents({
      teamId, deviceId: hello.device.id,
      agents: [
        { name: 'Reviewer', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'Tester', adapterKind: 'hermes', category: 'agentos-hosted' },
      ],
    });
    if (!discovered.ok) throw new Error(discovered.error);
    const [reviewer, tester] = discovered.agents;
    if (!reviewer || !tester) throw new Error('agents missing');
    // 测试仓储不支持改主键，因此 analyzer 按真实 Agent id 返回。
    const analyzer = async () => ({
      routeKind: 'complex_task' as const, riskLevel: 'low' as const,
      targetAgentIds: [reviewer.id, tester.id],
      requiredCapabilityIds: ['capability:v1:code-review', 'capability:v1:behavior-testing'],
      subtasks: [
        { title: '审查实现', objective: '找出设计与实现风险', targetAgentId: reviewer.id,
          requiredCapabilityIds: ['capability:v1:code-review'], acceptanceCriteria: ['给出带依据的问题清单'],
          dependsOnSubtaskIndexes: [] },
        { title: '验证行为', objective: '根据审查结果验证核心用户路径', targetAgentId: tester.id,
          requiredCapabilityIds: ['capability:v1:behavior-testing'], acceptanceCriteria: ['给出通过或失败证据'],
          dependsOnSubtaskIndexes: [0] },
      ],
    });
    // Agent id 来自发现结果，因此在同一仓储上重建 use cases 并注入确定性 analyzer。
    const routedApp = createServerNextUseCases({
      repositories, ids, clock, analyzeMessageRouteWithPi: analyzer,
      onChannelCollaborationTasksPublished: async (taskIds) => {
        let offered = 0;
        for (const taskId of taskIds) offered += (await broker.prepareOffers(taskId)).length;
        return { offered };
      },
    });
    for (const [agent, capabilityId, capabilityName] of [
      [reviewer, 'capability:v1:code-review', 'code review'],
      [tester, 'capability:v1:behavior-testing', 'behavior testing'],
    ] as const) {
      const added = await routedApp.addChannelAgentMember({ userId, teamId, channelId: channel.channel.id, agentId: agent.id });
      if (!added.ok) throw new Error(added.error);
      await repositories.agentExposure.manifests.create({
        id: `manifest-${agent.id}`, teamId, agentId: agent.id, revision: 1, status: 'active',
        capabilities: [{
          name: capabilityName, description: capabilityName,
          registry: { capabilityId, registryVersion: 1 }, evidence: [],
        }],
        skills: [], constraints: [], availability: { status: 'available' },
        validFrom: 0, validUntil: null, createdBy: userId, now: clock.now(),
      });
      const policy = await routedApp.upsertAgentAutoAcceptPolicy({
        userId, teamId, agentId: agent.id, enabled: true,
        allowedCapabilityIds: [capabilityId], allowUnspecifiedCapabilities: false,
        allowedRiskLevels: ['low'], maxActiveClaims: 1,
      });
      if (!policy.ok) throw new Error(policy.error);
    }

    const sent = await routedApp.sendMessage({
      userId, teamId, channelId: channel.channel.id, clientMessageId: 'complex-natural',
      body: '请审查这次实现，并验证核心用户路径',
    });
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    await waitForRouteResolution(repositories, sent.message.id);
    const route = await repositories.channelCoordinationUnitOfWork.run((tx) =>
      tx.routes.getByMessageId(sent.message.id));
    expect(route).toMatchObject({
      status: 'resolved', routeKind: 'complex_task', intentSource: 'pi', linkedTaskId: expect.any(String),
      diagnosticCode: null,
    });
    const listed = await routedApp.listTasks({ userId, teamId, channelId: channel.channel.id });
    if (!listed.ok) throw new Error(listed.error);
    const subtasks = listed.tasks.filter((task) => task.tags.includes('channel-collaboration'));
    expect(subtasks.map((task) => task.title).sort()).toEqual(['审查实现', '验证行为']);
    const reviewTask = subtasks.find((task) => task.title === '审查实现')!;
    const testTask = subtasks.find((task) => task.title === '验证行为')!;
    const reviewCoordination = await repositories.taskCoordination.coordinations.getByTaskId(reviewTask.id);
    expect(reviewCoordination?.requiredCapabilities).toEqual(['code review']);
    await expect(repositories.taskCoordination.dependencies.list(testTask.id)).resolves.toEqual([
      expect.objectContaining({ taskId: testTask.id, dependencyTaskId: reviewTask.id }),
    ]);
    await expect(repositories.taskCoordination.offers.listByTask(reviewTask.id)).resolves.toEqual([
      expect.objectContaining({ status: 'accepted', agentId: reviewer.id }),
    ]);
    await expect(repositories.taskCoordination.claimLeases.getCurrent({
      taskId: reviewTask.id, taskRevision: reviewTask.revision, taskAttempt: reviewCoordination!.attempt,
    })).resolves.toMatchObject({ status: 'active', agentId: reviewer.id });
    await expect(repositories.taskCoordination.offers.listByTask(testTask.id)).resolves.toEqual([]);
  });
});
