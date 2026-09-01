import { describe, expect, test } from 'vitest';
import { classifyDeterministicMessageRoute, shouldCreateMessageRouteAnalysis } from '../src/index.js';

describe('deterministic message route policy (#1270)', () => {
  test('只有未指派的人类频道根消息进入分析', () => {
    expect(shouldCreateMessageRouteAnalysis({
      senderKind: 'human', channelKind: 'channel', threadId: null,
      hasAgentMention: false, hasTaskLinkage: false,
    })).toBe(true);
    expect(shouldCreateMessageRouteAnalysis({
      senderKind: 'human', channelKind: 'channel', threadId: null,
      hasAgentMention: true, hasTaskLinkage: false,
    })).toBe(false);
    expect(shouldCreateMessageRouteAnalysis({
      senderKind: 'human', channelKind: 'dm', threadId: null,
      hasAgentMention: false, hasTaskLinkage: false,
    })).toBe(false);
  });

  test('无模型时识别“各位分别自我介绍”并冻结排序后的频道 Agent', () => {
    expect(classifyDeterministicMessageRoute({
      body: '各位，请分别介绍一下自己吧',
      channelAgentIds: ['agent-b', 'agent-a', 'agent-b'],
    })).toEqual({
      kind: 'low_risk_collective', policyVersion: 1,
      directive: 'introduce_channel_agents', targetAgentIds: ['agent-a', 'agent-b'],
    });
  });

  test('不把普通未指派消息猜成任务或随机指派', () => {
    expect(classifyDeterministicMessageRoute({
      body: '帮我看看这个方案', channelAgentIds: ['agent-a'],
    })).toEqual({ kind: 'requires_pi', policyVersion: 1 });
  });
});
