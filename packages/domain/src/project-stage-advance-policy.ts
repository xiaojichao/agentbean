import type { TaskStatus } from '@agentbean/contracts';

export type ProjectStageAdvanceWaitingReason =
  | 'channel_archived'
  | 'automation_unavailable'
  | 'task_not_pending'
  | 'task_revision_stale'
  | 'execution_gate_blocked'
  | 'required_input_incomplete'
  | 'stable_input_stale'
  | 'no_eligible_agent'
  | 'claim_stale'
  | 'invocation_active';

export interface ProjectStageAdvanceFacts {
  readonly channelWritable: boolean;
  readonly piAutomationAvailable: boolean;
  readonly autoCoordinationEnabled: boolean;
  readonly taskStatus: TaskStatus;
  readonly taskRevision: number;
  readonly stageTaskRevision: number;
  readonly coordinationTaskRevision: number;
  readonly claimStatus: 'none' | 'active' | 'stale';
  readonly claimedAgentId?: string;
  readonly invocationStatus: 'none' | 'active';
  readonly executionGateAllowed: boolean;
  readonly requiredInputCount: number;
  readonly stableInputCount: number;
  readonly stableInputFenceCurrent: boolean;
  readonly eligibleAgentIds: readonly string[];
}

export type ProjectStageAdvanceDecision =
  | { readonly kind: 'waiting'; readonly reason: ProjectStageAdvanceWaitingReason }
  | { readonly kind: 'suggest'; readonly targetAgentIds: readonly string[] }
  | { readonly kind: 'publish_offer'; readonly targetAgentIds: readonly string[] }
  | { readonly kind: 'create_invocation'; readonly targetAgentId: string };

/**
 * #829 的纯推进策略。调用方只传 Server 权威事实；本函数不会从名字、路径或聊天文本猜输入。
 * 顺序刻意 fail closed：任何 fence 或权限边界失效都先于建议、Offer 和 Invocation。
 */
export function evaluateProjectStageAdvance(
  facts: ProjectStageAdvanceFacts,
): ProjectStageAdvanceDecision {
  if (!facts.channelWritable) return { kind: 'waiting', reason: 'channel_archived' };
  if (!facts.piAutomationAvailable) return { kind: 'waiting', reason: 'automation_unavailable' };
  if (facts.taskStatus !== 'todo' && facts.taskStatus !== 'in_progress') {
    return { kind: 'waiting', reason: 'task_not_pending' };
  }
  if (facts.stageTaskRevision !== facts.taskRevision
    || facts.coordinationTaskRevision !== facts.taskRevision) {
    return { kind: 'waiting', reason: 'task_revision_stale' };
  }
  if (!facts.executionGateAllowed) {
    return { kind: 'waiting', reason: 'execution_gate_blocked' };
  }
  if (facts.stableInputCount !== facts.requiredInputCount) {
    return { kind: 'waiting', reason: 'required_input_incomplete' };
  }
  if (!facts.stableInputFenceCurrent) {
    return { kind: 'waiting', reason: 'stable_input_stale' };
  }
  if (facts.invocationStatus === 'active') {
    return { kind: 'waiting', reason: 'invocation_active' };
  }
  if (facts.claimStatus === 'stale') return { kind: 'waiting', reason: 'claim_stale' };
  if (facts.claimStatus === 'active') {
    if (!facts.claimedAgentId || !facts.eligibleAgentIds.includes(facts.claimedAgentId)) {
      return { kind: 'waiting', reason: 'claim_stale' };
    }
    return { kind: 'create_invocation', targetAgentId: facts.claimedAgentId };
  }
  if (facts.eligibleAgentIds.length === 0) {
    return { kind: 'waiting', reason: 'no_eligible_agent' };
  }
  const targetAgentIds = [...facts.eligibleAgentIds];
  return facts.autoCoordinationEnabled
    ? { kind: 'publish_offer', targetAgentIds }
    : { kind: 'suggest', targetAgentIds };
}
