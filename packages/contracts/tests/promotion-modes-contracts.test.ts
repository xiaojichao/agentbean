import { describe, expect, test } from 'vitest';

import {
  SEMANTIC_PROMOTION_ROLLOUT_MODES,
  PROMOTION_MODE_CAPABILITIES_V1,
  parseAgentOrchestrationEscalationCommandV1,
  parseAgentOrchestrationEscalationV1,
  parsePromotionProposalActionV1,
  parsePromotionProposalV1,
  parseSemanticPromotionEvaluationV1,
  parseSemanticPromotionEvaluateCommandV1,
  parseSemanticPromotionRolloutStateV1,
  parseTeamPromotionPolicyApplicationV1,
  parseTeamPromotionPolicyV1,
} from '../src/promotion-modes.js';

describe('semantic promotion rollout contracts', () => {
  test('只接受 off、shadow 与 proposal-only，且 evaluator 结果不包含 auto-promote', () => {
    expect(SEMANTIC_PROMOTION_ROLLOUT_MODES).toEqual(['off', 'shadow', 'proposal-only']);
    expect(PROMOTION_MODE_CAPABILITIES_V1).toMatchObject({
      modelMayDirectPromote: false,
      directAgentEscalationCreatesTargetedOffer: true,
    });
    expect(parseSemanticPromotionRolloutStateV1({
      schemaVersion: 1,
      teamId: 'team-1',
      mode: 'proposal-only',
      revision: 2,
      updatedAt: 1_000,
    })).toMatchObject({ mode: 'proposal-only', revision: 2 });
    expect(parseSemanticPromotionEvaluationV1({
      schemaVersion: 1,
      sourceLineage: { kind: 'message', id: 'msg-1' },
      sourceRevision: 3,
      verdict: 'proposal',
      objectiveSnapshot: {
        schemaVersion: 1,
        objective: '整理发布准备工作',
        scope: '当前频道与只读项目资料',
        riskLevel: 'low',
      },
      rationaleCode: 'MULTI_AGENT_ORCHESTRATION_NEEDED',
    })).toMatchObject({ verdict: 'proposal' });
    expect(() => parseSemanticPromotionEvaluationV1({
      schemaVersion: 1,
      sourceLineage: { kind: 'message', id: 'msg-1' },
      verdict: 'auto-promote',
      rationaleCode: 'MODEL_DECIDED',
    })).toThrow(/PROMOTION_MODES_PAYLOAD_INVALID/);
  });
});

describe('promotion proposal and Agent escalation contracts', () => {
  const proposal = {
    schemaVersion: 1,
    id: 'proposal-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    sourceLineage: { kind: 'message', id: 'msg-1' },
    sourceRevision: 2,
    requesterId: 'user-1',
    approverId: 'user-1',
    objectiveSnapshot: {
      schemaVersion: 1,
      objective: '协调多个 Agent 完成交付',
      scope: '当前频道',
      riskLevel: 'low',
    },
    status: 'open',
    revision: 1,
    authorizationToken: 'opaque-token',
    expiresAt: 2_000,
    createdAt: 1_000,
    updatedAt: 1_000,
  } as const;

  test('proposal 与 action 都是 exact-key、revision-bound 合同', () => {
    expect(parsePromotionProposalV1(proposal)).toEqual(proposal);
    expect(parsePromotionProposalActionV1({
      schemaVersion: 1,
      action: 'accept',
      proposalId: 'proposal-1',
      expectedRevision: 1,
      authorizationToken: 'opaque-token',
      idempotencyKey: 'accept-1',
    })).toMatchObject({ expectedRevision: 1 });
    expect(() => parsePromotionProposalActionV1({
      schemaVersion: 1,
      action: 'accept',
      proposalId: 'proposal-1',
      expectedRevision: 1,
      authorizationToken: 'opaque-token',
      idempotencyKey: 'accept-1',
      actorId: 'client-must-not-self-report',
    })).toThrow(/PROMOTION_MODES_PAYLOAD_INVALID/);
  });

  test('Agent escalation 绑定 Freshness basis，simple request 只携带稳定 handoff 身份', () => {
    const escalation = {
      schemaVersion: 1,
      agentId: 'agent-1',
      channelId: 'channel-1',
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'msg-1' },
        sourceRevision: 2,
      },
      objectiveSnapshot: proposal.objectiveSnapshot,
      orchestrationNeed: true,
      scopeDecision: 'within-authorized-scope',
      simpleRequest: {
        messageId: 'msg-1',
        dispatchId: 'dispatch-1',
        targetAgentId: 'agent-1',
      },
    } as const;
    expect(parseAgentOrchestrationEscalationV1(escalation)).toEqual(escalation);
    expect(parseAgentOrchestrationEscalationCommandV1({
      schemaVersion: 1,
      idempotencyKey: 'escalate-1',
      escalation,
    })).toMatchObject({ idempotencyKey: 'escalate-1', escalation });
    expect(() => parseAgentOrchestrationEscalationV1({
      ...escalation,
      simpleRequest: { ...escalation.simpleRequest, executionSecret: 'x' },
    })).toThrow(/PROMOTION_MODES_PAYLOAD_INVALID/);
  });

  test('Team policy parser 只接受版本化且显式预授权的 exact-key payload', () => {
    expect(parseTeamPromotionPolicyV1({
      schemaVersion: 1,
      teamId: 'team-1',
      revision: 1,
      enabled: true,
      ruleId: 'structured-workflow',
      preauthorized: true,
      requireOrchestrationNeed: true,
      updatedAt: 1_000,
    })).toMatchObject({ teamId: 'team-1', revision: 1 });
    expect(parseTeamPromotionPolicyApplicationV1({
      schemaVersion: 1,
      channelId: 'channel-1',
      ruleId: 'structured-workflow',
      orchestrationNeed: true,
      objectiveSnapshot: proposal.objectiveSnapshot,
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: 'msg-1' },
        sourceRevision: 2,
      },
      idempotencyKey: 'policy-apply-1',
    })).toMatchObject({ ruleId: 'structured-workflow' });
    expect(parseSemanticPromotionEvaluateCommandV1({
      schemaVersion: 1,
      channelId: 'channel-1',
      approverId: 'reviewer-1',
      evaluatorFailed: true,
    })).toMatchObject({ evaluatorFailed: true });
  });
});
