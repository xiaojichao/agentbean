import type {
  AgentOrchestrationEscalationV1,
  PromotionProposalAction,
  PromotionProposalStatus,
  PromotionProposalV1,
  SemanticPromotionEvaluationV1,
  SemanticPromotionRolloutMode,
  TeamPromotionPolicyV1,
} from '@agentbean/contracts';

export type SemanticPromotionExclusion = 'chat-only' | 'task-linked' | 'negative-expression';

export type SemanticPromotionPath =
  | { readonly kind: 'not-evaluated' }
  | { readonly kind: 'excluded'; readonly reason: SemanticPromotionExclusion }
  | { readonly kind: 'evaluator-unavailable' }
  | { readonly kind: 'shadow-audit'; readonly evaluation: SemanticPromotionEvaluationV1 }
  | { readonly kind: 'no-promotion'; readonly evaluation: SemanticPromotionEvaluationV1 }
  | { readonly kind: 'show-clarification'; readonly evaluation: SemanticPromotionEvaluationV1 }
  | { readonly kind: 'show-proposal'; readonly evaluation: SemanticPromotionEvaluationV1 };

/**
 * 语义 evaluator 永远不返回 direct promotion：off 不调用，shadow 只记审计，
 * proposal-only 最多展示 clarification/proposal。排除项先于模型结果。
 */
export function evaluateSemanticPromotionPath(input: {
  readonly rollout: SemanticPromotionRolloutMode;
  readonly exclusion?: SemanticPromotionExclusion;
  readonly evaluation?: SemanticPromotionEvaluationV1;
  readonly evaluatorFailed?: boolean;
}): SemanticPromotionPath {
  if (input.rollout === 'off') return { kind: 'not-evaluated' };
  if (input.exclusion) return { kind: 'excluded', reason: input.exclusion };
  if (input.evaluatorFailed || !input.evaluation) return { kind: 'evaluator-unavailable' };
  if (input.rollout === 'shadow') return { kind: 'shadow-audit', evaluation: input.evaluation };
  if (input.evaluation.verdict === 'clarification') {
    return { kind: 'show-clarification', evaluation: input.evaluation };
  }
  if (input.evaluation.verdict === 'proposal') {
    return { kind: 'show-proposal', evaluation: input.evaluation };
  }
  return { kind: 'no-promotion', evaluation: input.evaluation };
}

const ACTION_TO_STATUS: Readonly<Record<
  PromotionProposalAction,
  Exclude<PromotionProposalStatus, 'open'>
>> = {
  accept: 'accepted',
  reject: 'rejected',
  cancel: 'cancelled',
  expire: 'expired',
};

export type PromotionProposalTransitionDecision =
  | { readonly kind: 'apply'; readonly nextStatus: Exclude<PromotionProposalStatus, 'open'> }
  | { readonly kind: 'no-op'; readonly status: Exclude<PromotionProposalStatus, 'open'> }
  | { readonly kind: 'conflict'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** revision、token、合法 approver 与 expiry 在同一纯策略中收敛，terminal action 可幂等重放。 */
export function evaluatePromotionProposalTransition(input: {
  readonly proposal: PromotionProposalV1;
  readonly action: PromotionProposalAction;
  readonly expectedRevision: number;
  readonly actorId?: string;
  readonly tokenMatches: boolean;
  readonly now: number;
  readonly systemActor?: boolean;
}): PromotionProposalTransitionDecision {
  const target = ACTION_TO_STATUS[input.action];
  if (input.proposal.status !== 'open') {
    return input.proposal.status === target
      ? { kind: 'no-op', status: target }
      : { kind: 'conflict', reason: 'proposal-already-terminal' };
  }
  if (input.expectedRevision !== input.proposal.revision) {
    return { kind: 'conflict', reason: 'proposal-revision-changed' };
  }
  if (!input.tokenMatches) return { kind: 'rejected', reason: 'authorization-token-invalid' };
  if (input.now >= input.proposal.expiresAt && input.action !== 'expire') {
    return { kind: 'conflict', reason: 'proposal-expired' };
  }
  if (input.action === 'expire') {
    if (!input.systemActor || input.now < input.proposal.expiresAt) {
      return { kind: 'rejected', reason: 'proposal-expiry-not-authorized' };
    }
    return { kind: 'apply', nextStatus: 'expired' };
  }
  if (input.action === 'cancel') {
    if (input.actorId !== input.proposal.requesterId) {
      return { kind: 'rejected', reason: 'proposal-requester-required' };
    }
    return { kind: 'apply', nextStatus: 'cancelled' };
  }
  if (input.actorId !== input.proposal.approverId) {
    return { kind: 'rejected', reason: 'proposal-approver-required' };
  }
  return { kind: 'apply', nextStatus: target };
}

export type TeamPromotionPolicyDecision =
  | { readonly kind: 'direct-promotion'; readonly policyRevision: number }
  | { readonly kind: 'no-promotion'; readonly reason: string };

/** Team policy 只接受版本化、预授权、确定性命中且确有 orchestration need 的结构化入口。 */
export function evaluateTeamPromotionPolicy(input: {
  readonly policy: TeamPromotionPolicyV1;
  readonly ruleId: string;
  readonly orchestrationNeed: boolean;
  readonly exclusion?: SemanticPromotionExclusion;
}): TeamPromotionPolicyDecision {
  if (input.exclusion) return { kind: 'no-promotion', reason: input.exclusion };
  if (!input.policy.enabled) return { kind: 'no-promotion', reason: 'policy-disabled' };
  if (!input.policy.preauthorized) return { kind: 'no-promotion', reason: 'policy-not-preauthorized' };
  if (input.policy.ruleId !== input.ruleId) return { kind: 'no-promotion', reason: 'policy-rule-mismatch' };
  if (!input.orchestrationNeed) return { kind: 'no-promotion', reason: 'orchestration-not-needed' };
  return { kind: 'direct-promotion', policyRevision: input.policy.revision };
}

export type AgentEscalationDecision =
  | { readonly kind: 'direct-promotion' }
  | { readonly kind: 'proposal-required'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string };

/** 只有当前责任 Agent 能升级；扩大 scope/risk/cost/data 边界时只能生成 proposal。 */
export function evaluateAgentOrchestrationEscalation(input: {
  readonly escalation: AgentOrchestrationEscalationV1;
  readonly responsibleAgentId?: string;
}): AgentEscalationDecision {
  if (!input.responsibleAgentId || input.responsibleAgentId !== input.escalation.agentId) {
    return { kind: 'rejected', reason: 'agent-not-responsible' };
  }
  if (!input.escalation.orchestrationNeed) {
    return { kind: 'rejected', reason: 'orchestration-not-needed' };
  }
  if (input.escalation.scopeDecision === 'expands-authorized-scope'
    || input.escalation.objectiveSnapshot.riskLevel === 'high') {
    return { kind: 'proposal-required', reason: 'authorization-boundary-expands' };
  }
  return { kind: 'direct-promotion' };
}
