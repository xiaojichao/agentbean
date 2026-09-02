import { describe, expect, test, vi } from 'vitest';
import { createMessageRouteAnalysisService } from '../src/application/message-route-analysis-service.js';
import { createInMemoryRepositories } from '../src/index.js';

async function setup(body: string) {
  const repositories = createInMemoryRepositories();
  await repositories.teams.create({
    id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1,
  });
  await repositories.channels.create({
    id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'Channel', visibility: 'private',
    createdBy: 'user-1', humanMemberIds: ['user-1'], agentMemberIds: ['agent-b', 'agent-a'],
    createdAt: 1, updatedAt: 1,
  });
  await repositories.messages.append({
    id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
    senderKind: 'human', senderId: 'user-1', body, createdAt: 10,
  });
  await repositories.channelCoordinationUnitOfWork.run((tx) => tx.routes.create({
    id: 'route-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
    messageRevision: 1, status: 'pending', attempt: 0, nextRetryAt: null, routeKind: null,
    intentSource: null, riskLevel: null, targetAgentIds: [], requiredCapabilityIds: [],
    linkedTaskId: null, diagnosticCode: null, createdAt: 10, updatedAt: 10,
  }));
  return repositories;
}

describe('message route analysis service (#1270)', () => {
  test('PI 不可用时仍对低风险 collective directive 确定性派发，并记录可审计来源', async () => {
    const repositories = await setup('各位，请分别介绍一下自己吧');
    const applyAuthorizedRoute = vi.fn(async () => ({ linkedTaskId: 'root-task-1' }));
    const service = createMessageRouteAnalysisService({
      unitOfWork: repositories.channelCoordinationUnitOfWork,
      clock: { now: () => 100 },
      applyAuthorizedRoute,
    });

    const [resolved] = await service.processPending();
    expect(resolved).toMatchObject({
      status: 'resolved', routeKind: 'collaboration', intentSource: 'deterministic_fallback',
      targetAgentIds: ['agent-a', 'agent-b'], linkedTaskId: 'root-task-1', diagnosticCode: null,
    });
    expect(applyAuthorizedRoute).toHaveBeenCalledWith(expect.objectContaining({
      senderId: 'user-1', riskLevel: 'low', targetAgentIds: ['agent-a', 'agent-b'],
    }));
  });

  test('无法确定性分类且 PI 不可用时进入 deferred，Message 不丢失且可重试', async () => {
    const repositories = await setup('帮我看看这个方案');
    let now = 100;
    const service = createMessageRouteAnalysisService({
      unitOfWork: repositories.channelCoordinationUnitOfWork,
      clock: { now: () => now }, retryDelayMs: 50,
      applyAuthorizedRoute: async () => ({ linkedTaskId: 'root-task-1' }),
    });

    const [deferred] = await service.processPending();
    expect(deferred).toMatchObject({
      status: 'deferred', nextRetryAt: 150, diagnosticCode: 'PI_ROUTE_ANALYZER_UNAVAILABLE',
    });
    await expect(repositories.messages.getById('message-1')).resolves.toMatchObject({
      body: '帮我看看这个方案',
    });

    service.bindPiAnalyzer(async () => ({
      routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-a'],
      requiredCapabilityIds: [],
      subtasks: [{
        title: '查看方案', objective: '查看方案', targetAgentId: 'agent-a',
        requiredCapabilityIds: [], acceptanceCriteria: ['给出结论'],
      }],
    }));
    now = 151;
    const [recovered] = await service.processPending();
    expect(recovered).toMatchObject({
      status: 'resolved', routeKind: 'direct_agent', intentSource: 'pi', linkedTaskId: 'root-task-1',
    });
  });

  test('PI proposal 不能把任务目标扩到频道外 Agent', async () => {
    const repositories = await setup('复杂任务');
    const service = createMessageRouteAnalysisService({
      unitOfWork: repositories.channelCoordinationUnitOfWork,
      clock: { now: () => 100 },
      analyzeWithPi: async () => ({
        routeKind: 'complex_task', riskLevel: 'low', targetAgentIds: ['agent-outside'],
        requiredCapabilityIds: [],
      }),
      applyAuthorizedRoute: async () => ({ linkedTaskId: 'should-not-run' }),
    });

    const [failed] = await service.processPending();
    expect(failed).toMatchObject({ status: 'failed', diagnosticCode: 'PI_ROUTE_TARGET_OUT_OF_SCOPE' });
  });

  test('高风险 PI proposal 只形成 clarification，不进入派发且不替代 Action approval', async () => {
    const repositories = await setup('请执行高风险外部操作');
    const applyAuthorizedRoute = vi.fn(async () => ({ linkedTaskId: 'must-not-run' }));
    const service = createMessageRouteAnalysisService({
      unitOfWork: repositories.channelCoordinationUnitOfWork,
      clock: { now: () => 100 },
      analyzeWithPi: async () => ({
        routeKind: 'complex_task', riskLevel: 'high', targetAgentIds: ['agent-a'],
        requiredCapabilityIds: [],
        subtasks: [{
          title: '高风险操作', objective: '执行高风险操作', targetAgentId: 'agent-a',
          requiredCapabilityIds: [], acceptanceCriteria: ['操作完成'], dependsOnSubtaskIndexes: [],
        }],
      }),
      applyAuthorizedRoute,
    });

    const [resolved] = await service.processPending();
    expect(resolved).toMatchObject({
      status: 'resolved', routeKind: 'clarification', riskLevel: 'high',
      diagnosticCode: 'PI_ROUTE_HIGH_RISK_REQUIRES_HUMAN', linkedTaskId: null,
    });
    expect(applyAuthorizedRoute).not.toHaveBeenCalled();
  });

  test('Server 重启后可重新领取超时 running route，且沿原 analysis lineage 收敛', async () => {
    const repositories = await setup('帮我看看这个方案');
    await repositories.channelCoordinationUnitOfWork.run((tx) => tx.routes.claimForProcessing({
      id: 'route-1', now: 100, runningBefore: 50,
    }));
    const applyAuthorizedRoute = vi.fn(async () => ({ linkedTaskId: 'root-task-recovered' }));
    const restartedService = createMessageRouteAnalysisService({
      unitOfWork: repositories.channelCoordinationUnitOfWork,
      clock: { now: () => 200 }, processingLeaseMs: 50,
      analyzeWithPi: async () => ({
        routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-a'],
        requiredCapabilityIds: [],
        subtasks: [{
          title: '查看方案', objective: '查看方案', targetAgentId: 'agent-a',
          requiredCapabilityIds: [], acceptanceCriteria: ['给出结论'], dependsOnSubtaskIndexes: [],
        }],
      }),
      applyAuthorizedRoute,
    });

    const [recovered] = await restartedService.processPending();
    expect(recovered).toMatchObject({
      id: 'route-1', messageId: 'message-1', attempt: 2,
      status: 'resolved', routeKind: 'direct_agent', linkedTaskId: 'root-task-recovered',
    });
    expect(applyAuthorizedRoute).toHaveBeenCalledTimes(1);
  });
});
