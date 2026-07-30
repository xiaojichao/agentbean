import { describe, expect, test } from 'vitest';

import {
  evaluateAgentOrchestrationEscalation,
  evaluatePromotionProposalTransition,
  evaluateSemanticPromotionPath,
  evaluateTeamPromotionPolicy,
} from '../src/promotion-modes-policy.js';
import type {
  AgentOrchestrationEscalationV1,
  PromotionProposalV1,
  TeamPromotionPolicyV1,
} from '@agentbean/contracts';

const proposal = {
  schemaVersion: 1,
  sourceLineage: { kind: 'message', id: 'msg-1' },
  verdict: 'proposal',
  objectiveSnapshot: {
    schemaVersion: 1,
    objective: '协调多个 Agent 完成交付',
    scope: '当前频道',
    riskLevel: 'low',
  },
  rationaleCode: 'ORCHESTRATION_NEEDED',
} as const;

describe('evaluateSemanticPromotionPath', () => {
  test('off 不评估、shadow 只审计、proposal-only 只展示建议且永不 auto-promote', () => {
    expect(evaluateSemanticPromotionPath({ rollout: 'off' })).toEqual({ kind: 'not-evaluated' });
    expect(evaluateSemanticPromotionPath({ rollout: 'shadow', evaluation: proposal }))
      .toEqual({ kind: 'shadow-audit', evaluation: proposal });
    expect(evaluateSemanticPromotionPath({ rollout: 'proposal-only', evaluation: proposal }))
      .toEqual({ kind: 'show-proposal', evaluation: proposal });
  });
});

const storedProposal: PromotionProposalV1 = {
  schemaVersion: 1,
  id: 'proposal-1',
  teamId: 'team-1',
  channelId: 'channel-1',
  sourceLineage: { kind: 'message', id: 'msg-1' },
  sourceRevision: 3,
  requesterId: 'requester-1',
  approverId: 'approver-1',
  objectiveSnapshot: proposal.objectiveSnapshot,
  status: 'open',
  revision: 2,
  authorizationToken: 'opaque',
  expiresAt: 2_000,
  createdAt: 1_000,
  updatedAt: 1_000,
};

describe('evaluatePromotionProposalTransition', () => {
  test('只有合法 approver 的当前 revision token 可 accept，重放幂等', () => {
    expect(evaluatePromotionProposalTransition({
      proposal: storedProposal,
      action: 'accept',
      expectedRevision: 2,
      actorId: 'approver-1',
      tokenMatches: true,
      now: 1_500,
    })).toEqual({ kind: 'apply', nextStatus: 'accepted' });
    expect(evaluatePromotionProposalTransition({
      proposal: { ...storedProposal, status: 'accepted' },
      action: 'accept',
      expectedRevision: 2,
      actorId: 'approver-1',
      tokenMatches: true,
      now: 1_500,
    })).toEqual({ kind: 'no-op', status: 'accepted' });
  });

  test('非法 approver、旧 revision 与过期 token 都不产生 accept', () => {
    expect(evaluatePromotionProposalTransition({
      proposal: storedProposal,
      action: 'accept',
      expectedRevision: 2,
      actorId: 'observer',
      tokenMatches: true,
      now: 1_500,
    })).toMatchObject({ kind: 'rejected' });
    expect(evaluatePromotionProposalTransition({
      proposal: storedProposal,
      action: 'accept',
      expectedRevision: 1,
      actorId: 'approver-1',
      tokenMatches: true,
      now: 1_500,
    })).toMatchObject({ kind: 'conflict' });
    expect(evaluatePromotionProposalTransition({
      proposal: storedProposal,
      action: 'accept',
      expectedRevision: 2,
      actorId: 'approver-1',
      tokenMatches: true,
      now: 2_000,
    })).toMatchObject({ kind: 'conflict', reason: 'proposal-expired' });
  });
});

describe('deterministic Team policy and Agent escalation', () => {
  const policy: TeamPromotionPolicyV1 = {
    schemaVersion: 1,
    teamId: 'team-1',
    revision: 4,
    enabled: true,
    ruleId: 'structured-workflow',
    preauthorized: true,
    requireOrchestrationNeed: true,
    updatedAt: 1_000,
  };
  const escalation: AgentOrchestrationEscalationV1 = {
    schemaVersion: 1,
    agentId: 'agent-1',
    channelId: 'channel-1',
    freshnessBasis: {
      schemaVersion: 1,
      sourceLineage: { kind: 'message', id: 'msg-1' },
      sourceRevision: 3,
    },
    objectiveSnapshot: proposal.objectiveSnapshot,
    orchestrationNeed: true,
    scopeDecision: 'within-authorized-scope',
  };

  test('policy 必须预授权、确定性命中且排除 chat-only/Task linkage/否定表达', () => {
    expect(evaluateTeamPromotionPolicy({
      policy,
      ruleId: 'structured-workflow',
      orchestrationNeed: true,
    })).toEqual({ kind: 'direct-promotion', policyRevision: 4 });
    expect(evaluateTeamPromotionPolicy({
      policy,
      ruleId: 'structured-workflow',
      orchestrationNeed: true,
      exclusion: 'chat-only',
    })).toEqual({ kind: 'no-promotion', reason: 'chat-only' });
  });

  test('旁观 Agent 被拒绝，越界 Agent escalation 只能 proposal', () => {
    expect(evaluateAgentOrchestrationEscalation({
      escalation,
      responsibleAgentId: 'observer',
    })).toEqual({ kind: 'rejected', reason: 'agent-not-responsible' });
    expect(evaluateAgentOrchestrationEscalation({
      escalation: { ...escalation, scopeDecision: 'expands-authorized-scope' },
      responsibleAgentId: 'agent-1',
    })).toEqual({ kind: 'proposal-required', reason: 'authorization-boundary-expands' });
    expect(evaluateAgentOrchestrationEscalation({
      escalation,
      responsibleAgentId: 'agent-1',
    })).toEqual({ kind: 'direct-promotion' });
  });
});
