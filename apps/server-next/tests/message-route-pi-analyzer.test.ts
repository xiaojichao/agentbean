import { describe, expect, test, vi } from 'vitest';
import type { AgentCapabilityDirectoryDto } from '../../../packages/contracts/src/index.js';
import { createMessageRoutePiAnalyzer } from '../src/application/message-route-pi-analyzer.js';
import type { MessageRouteAnalysisRecord } from '../src/application/message-tracer-repositories.js';

const analysis: MessageRouteAnalysisRecord = {
  id: 'route-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
  messageRevision: 1, status: 'running', attempt: 1, nextRetryAt: null, routeKind: null,
  intentSource: null, riskLevel: null, targetAgentIds: [], requiredCapabilityIds: [],
  linkedTaskId: null, diagnosticCode: null, createdAt: 1, updatedAt: 1,
};

const directory: AgentCapabilityDirectoryDto = {
  teamId: 'team-1', channelId: 'channel-1', generatedAt: 1,
  entries: [{
    agentId: 'agent-1', agentName: 'Reviewer', manifestId: 'manifest-1', manifestRevision: 1,
    available: true,
    capabilities: [{
      registry: { capabilityId: 'cap-review', registryVersion: 1 },
      name: 'code review', description: 'Review code', evidence: [],
    }],
    skills: [], disabledCapabilities: [], disabledSkills: [], constraints: [],
  }],
};

function okFetch(content: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 }, model: 'test-model',
    }),
  });
}

function createAnalyzer(overrides: Partial<Parameters<typeof createMessageRoutePiAnalyzer>[0]> = {}) {
  return createMessageRoutePiAnalyzer({
    resolveActiveTarget: async () => ({
      kind: 'available',
      config: { baseUrl: 'https://api.example.com', modelId: 'test-model', timeoutMs: 10_000, maxOutputTokens: 1024 },
      apiKey: 'test-key',
    }),
    resolveCapabilityDirectory: async () => directory,
    fetch: okFetch({
      routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-1'],
      requiredCapabilityIds: ['cap-review'],
      subtasks: [{
        title: '审查改动', objective: '审查当前改动', targetAgentId: 'agent-1',
        requiredCapabilityIds: ['cap-review'], acceptanceCriteria: ['给出问题清单'],
        dependsOnSubtaskIndexes: [],
      }],
    }),
    ...overrides,
  });
}

describe('message route PI analyzer (#1270)', () => {
  test('只使用限域 Capability Directory，返回可授权的简单任务 proposal', async () => {
    const fetchFn = okFetch({
      routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-1'],
      requiredCapabilityIds: ['cap-review'],
      subtasks: [{
        title: '审查改动', objective: '审查当前改动', targetAgentId: 'agent-1',
        requiredCapabilityIds: ['cap-review'], acceptanceCriteria: ['给出问题清单'],
        dependsOnSubtaskIndexes: [],
      }],
    });
    const analyzer = createAnalyzer({ fetch: fetchFn });

    await expect(analyzer({ analysis, body: '帮我审查代码', channelAgentIds: ['agent-1'] }))
      .resolves.toMatchObject({ routeKind: 'direct_agent', targetAgentIds: ['agent-1'] });
    const request = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body));
    const serializedRequest = JSON.stringify(request.messages);
    expect(serializedRequest).toContain('cap-review');
    expect(serializedRequest).not.toContain('sourcePath');
  });

  test('拒绝模型虚构 Capability 或越权绑定 Agent', async () => {
    const analyzer = createAnalyzer({
      fetch: okFetch({
        routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-1'],
        requiredCapabilityIds: ['cap-invented'],
        subtasks: [{
          title: '执行', objective: '执行', targetAgentId: 'agent-1',
          requiredCapabilityIds: ['cap-invented'], acceptanceCriteria: ['完成'],
          dependsOnSubtaskIndexes: [],
        }],
      }),
    });

    await expect(analyzer({ analysis, body: '执行', channelAgentIds: ['agent-1'] }))
      .resolves.toEqual({ unavailable: true, diagnosticCode: 'PI_ROUTE_CAPABILITY_UNAUTHORIZED' });
  });

  test('拒绝用未被选中 Agent 的 Capability 满足顶层任务要求', async () => {
    const analyzer = createAnalyzer({
      resolveCapabilityDirectory: async () => ({
        ...directory,
        entries: [
          ...directory.entries,
          {
            agentId: 'agent-2', agentName: 'Tester', manifestId: 'manifest-2', manifestRevision: 1,
            available: true,
            capabilities: [{
              registry: { capabilityId: 'cap-test', registryVersion: 1 },
              name: 'test', description: 'Run tests', evidence: [],
            }],
            skills: [], disabledCapabilities: [], disabledSkills: [], constraints: [],
          },
        ],
      }),
      fetch: okFetch({
        routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-1'],
        requiredCapabilityIds: ['cap-test'],
        subtasks: [{
          title: '审查改动', objective: '审查当前改动', targetAgentId: 'agent-1',
          requiredCapabilityIds: ['cap-review'], acceptanceCriteria: ['给出问题清单'],
          dependsOnSubtaskIndexes: [],
        }],
      }),
    });

    await expect(analyzer({ analysis, body: '审查并测试', channelAgentIds: ['agent-1', 'agent-2'] }))
      .resolves.toEqual({ unavailable: true, diagnosticCode: 'PI_ROUTE_CAPABILITY_UNAUTHORIZED' });
  });

  test('即使 Capability Directory 含有记录，也拒绝选择当前频道成员之外的 Agent', async () => {
    const analyzer = createAnalyzer({
      resolveCapabilityDirectory: async () => ({
        ...directory,
        entries: [
          ...directory.entries,
          {
            agentId: 'agent-2', agentName: 'Tester', manifestId: 'manifest-2', manifestRevision: 1,
            available: true,
            capabilities: [{
              registry: { capabilityId: 'cap-test', registryVersion: 1 },
              name: 'test', description: 'Run tests', evidence: [],
            }],
            skills: [], disabledCapabilities: [], disabledSkills: [], constraints: [],
          },
        ],
      }),
      fetch: okFetch({
        routeKind: 'direct_agent', riskLevel: 'low', targetAgentIds: ['agent-2'],
        requiredCapabilityIds: ['cap-test'],
        subtasks: [{
          title: '执行测试', objective: '执行测试', targetAgentId: 'agent-2',
          requiredCapabilityIds: ['cap-test'], acceptanceCriteria: ['测试完成'],
          dependsOnSubtaskIndexes: [],
        }],
      }),
    });

    await expect(analyzer({ analysis, body: '执行测试', channelAgentIds: ['agent-1'] }))
      .resolves.toEqual({ unavailable: true, diagnosticCode: 'PI_ROUTE_CAPABILITY_UNAUTHORIZED' });
  });

  test('complex_task 接受只引用更早节点的依赖并保留 DAG 计划', async () => {
    const analyzer = createAnalyzer({
      resolveCapabilityDirectory: async () => ({
        ...directory,
        entries: [
          ...directory.entries,
          {
            agentId: 'agent-2', agentName: 'Tester', manifestId: 'manifest-2', manifestRevision: 1,
            available: true,
            capabilities: [{
              registry: { capabilityId: 'cap-test', registryVersion: 1 },
              name: 'test', description: 'Run tests', evidence: [],
            }],
            skills: [], disabledCapabilities: [], disabledSkills: [], constraints: [],
          },
        ],
      }),
      fetch: okFetch({
        routeKind: 'complex_task', riskLevel: 'low', targetAgentIds: ['agent-1', 'agent-2'],
        requiredCapabilityIds: ['cap-review', 'cap-test'],
        subtasks: [
          {
            title: '审查改动', objective: '审查当前改动', targetAgentId: 'agent-1',
            requiredCapabilityIds: ['cap-review'], acceptanceCriteria: ['给出问题清单'],
            dependsOnSubtaskIndexes: [],
          },
          {
            title: '验证修复', objective: '根据审查结果验证修复', targetAgentId: 'agent-2',
            requiredCapabilityIds: ['cap-test'], acceptanceCriteria: ['给出验证证据'],
            dependsOnSubtaskIndexes: [0],
          },
        ],
      }),
    });

    await expect(analyzer({ analysis, body: '先审查再验证', channelAgentIds: ['agent-1', 'agent-2'] }))
      .resolves.toMatchObject({
        routeKind: 'complex_task',
        subtasks: [
          expect.objectContaining({ dependsOnSubtaskIndexes: [] }),
          expect.objectContaining({ dependsOnSubtaskIndexes: [0] }),
        ],
      });
  });

  test('拒绝自引用、前向引用或重复索引形成的非法 DAG', async () => {
    const analyzer = createAnalyzer({
      fetch: okFetch({
        routeKind: 'complex_task', riskLevel: 'low', targetAgentIds: ['agent-1'],
        requiredCapabilityIds: ['cap-review'],
        subtasks: [
          {
            title: '第一步', objective: '第一步', targetAgentId: 'agent-1',
            requiredCapabilityIds: ['cap-review'], acceptanceCriteria: ['完成第一步'],
            dependsOnSubtaskIndexes: [],
          },
          {
            title: '第二步', objective: '第二步', targetAgentId: 'agent-1',
            requiredCapabilityIds: ['cap-review'], acceptanceCriteria: ['完成第二步'],
            dependsOnSubtaskIndexes: [1],
          },
        ],
      }),
    });

    await expect(analyzer({ analysis, body: '执行复杂任务', channelAgentIds: ['agent-1'] }))
      .resolves.toEqual({ unavailable: true, diagnosticCode: 'PI_ROUTE_OUTPUT_INVALID' });
  });

  test('Active PI Model 不可用时返回可恢复诊断，不猜测 Agent', async () => {
    const fetchFn = vi.fn();
    const analyzer = createAnalyzer({
      resolveActiveTarget: async () => ({ kind: 'unavailable', diagnosticCode: 'PI_ACTIVE_MODEL_NOT_SET' }),
      fetch: fetchFn,
    });

    await expect(analyzer({ analysis, body: '帮我处理', channelAgentIds: ['agent-1'] }))
      .resolves.toEqual({ unavailable: true, diagnosticCode: 'PI_ACTIVE_MODEL_NOT_SET' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
