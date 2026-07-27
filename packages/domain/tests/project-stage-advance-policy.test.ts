import { describe, expect, test } from 'vitest';

import {
  evaluateProjectStageAdvance,
  type ProjectStageAdvanceFacts,
} from '../src/project-stage-advance-policy.js';

function facts(overrides: Partial<ProjectStageAdvanceFacts> = {}): ProjectStageAdvanceFacts {
  return {
    channelWritable: true,
    piHealthy: true,
    autoCoordinationEnabled: true,
    taskStatus: 'todo',
    taskRevision: 4,
    stageTaskRevision: 4,
    coordinationTaskRevision: 4,
    claimStatus: 'none',
    invocationStatus: 'none',
    executionGateAllowed: true,
    requiredInputCount: 2,
    stableInputCount: 2,
    stableInputFenceCurrent: true,
    eligibleAgentIds: ['agent-1'],
    ...overrides,
  };
}

describe('Project Stage 推进策略', () => {
  test('权威门禁、稳定输入和 Agent 能力均满足时发布 Offer，接受前不形成 owner', () => {
    expect(evaluateProjectStageAdvance(facts())).toEqual({
      kind: 'publish_offer',
      targetAgentIds: ['agent-1'],
    });
  });

  test('Team 自动协调关闭时只建议，不创建 Offer、InputSet 或 Invocation', () => {
    expect(evaluateProjectStageAdvance(facts({
      autoCoordinationEnabled: false,
    }))).toEqual({
      kind: 'suggest',
      targetAgentIds: ['agent-1'],
    });
  });

  test.each([
    ['channel_archived', { channelWritable: false }],
    ['pi_degraded', { piHealthy: false }],
    ['execution_gate_blocked', { executionGateAllowed: false }],
    ['required_input_incomplete', { stableInputCount: 1 }],
    ['stable_input_stale', { stableInputFenceCurrent: false }],
    ['task_revision_stale', { stageTaskRevision: 3 }],
    ['task_revision_stale', { coordinationTaskRevision: 3 }],
    ['no_eligible_agent', { eligibleAgentIds: [] }],
  ] as const)('fail closed：%s', (reason, overrides) => {
    expect(evaluateProjectStageAdvance(facts(overrides))).toEqual({
      kind: 'waiting',
      reason,
    });
  });

  test('Agent 明确接受并形成当前 claim 后才允许创建 Invocation', () => {
    expect(evaluateProjectStageAdvance(facts({
      claimStatus: 'active',
      claimedAgentId: 'agent-1',
    }))).toEqual({
      kind: 'create_invocation',
      targetAgentId: 'agent-1',
    });
  });

  test.each([
    ['claim_stale', { claimStatus: 'stale', claimedAgentId: 'agent-1' }],
    ['invocation_active', {
      claimStatus: 'active',
      claimedAgentId: 'agent-1',
      invocationStatus: 'active',
    }],
    ['task_not_pending', { taskStatus: 'done' }],
  ] as const)('重复或迟到推进被 fence：%s', (reason, overrides) => {
    expect(evaluateProjectStageAdvance(facts(overrides))).toEqual({
      kind: 'waiting',
      reason,
    });
  });
});
