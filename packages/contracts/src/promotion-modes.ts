import type { ID, UnixMs } from './common.js';
import {
  COMMAND_PROVENANCE_KINDS,
  type CommandProvenanceKind,
  type CommandProvenanceRefV1,
} from './message-tracer.js';
import type {
  PromotionFreshnessBasisV1,
  PromotionObjectiveSnapshotV1,
} from './promotion-gate.js';

/**
 * #923 / ADR-0069 的 Promotion modes 合同。
 *
 * 模型 evaluator 只允许产生无副作用判断；任何 root Task 创建仍须进入 Promotion gate。
 * proposal token 是 Server 签发的不透明凭据，并同时由 proposalId、revision、approver 与 expiresAt
 * 绑定，调用方不能自报 authority。
 */

export const SEMANTIC_PROMOTION_ROLLOUT_MODES = ['off', 'shadow', 'proposal-only'] as const;
export type SemanticPromotionRolloutMode = (typeof SEMANTIC_PROMOTION_ROLLOUT_MODES)[number];

export interface SemanticPromotionRolloutStateV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly mode: SemanticPromotionRolloutMode;
  readonly revision: number;
  readonly updatedAt: UnixMs;
}

export const SEMANTIC_PROMOTION_VERDICTS = ['no-promotion', 'clarification', 'proposal'] as const;
export type SemanticPromotionVerdict = (typeof SEMANTIC_PROMOTION_VERDICTS)[number];

export interface SemanticPromotionEvaluationV1 {
  readonly schemaVersion: 1;
  readonly sourceLineage: CommandProvenanceRefV1;
  readonly sourceRevision?: number;
  readonly verdict: SemanticPromotionVerdict;
  readonly clarificationQuestion?: string;
  readonly objectiveSnapshot?: PromotionObjectiveSnapshotV1;
  readonly rationaleCode: string;
}

export const PROMOTION_PROPOSAL_STATUSES = [
  'open', 'accepted', 'rejected', 'cancelled', 'expired',
] as const;
export type PromotionProposalStatus = (typeof PROMOTION_PROPOSAL_STATUSES)[number];

export interface PromotionProposalV1 {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly sourceLineage: CommandProvenanceRefV1;
  readonly sourceRevision?: number;
  readonly requesterId: ID;
  readonly approverId: ID;
  readonly objectiveSnapshot: PromotionObjectiveSnapshotV1;
  readonly status: PromotionProposalStatus;
  readonly revision: number;
  readonly authorizationToken: string;
  readonly expiresAt: UnixMs;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export const PROMOTION_PROPOSAL_ACTIONS = ['accept', 'reject', 'cancel', 'expire'] as const;
export type PromotionProposalAction = (typeof PROMOTION_PROPOSAL_ACTIONS)[number];

export interface PromotionProposalActionV1 {
  readonly schemaVersion: 1;
  readonly action: PromotionProposalAction;
  readonly proposalId: ID;
  readonly expectedRevision: number;
  /** Server 签发、绑定 proposal revision / approver / expiry 的不透明 token。 */
  readonly authorizationToken: string;
  readonly idempotencyKey: string;
}

export interface TeamPromotionPolicyV1 {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly revision: number;
  readonly enabled: boolean;
  readonly ruleId: string;
  readonly preauthorized: boolean;
  readonly requireOrchestrationNeed: true;
  readonly updatedAt: UnixMs;
}

export type AgentEscalationScopeDecision = 'within-authorized-scope' | 'expands-authorized-scope';

/** ADR-0069 Promotion modes 的封闭 command/capability registry。 */
export const PROMOTION_MODE_COMMAND_NAMES = [
  'promotion-proposal-action',
  'semantic-promotion-rollout-update',
  'team-promotion-policy-update',
  'agent-orchestration-escalation',
] as const;
export type PromotionModeCommandName = (typeof PROMOTION_MODE_COMMAND_NAMES)[number];

export const PROMOTION_MODE_CAPABILITIES_V1 = {
  schemaVersion: 1,
  commandNames: PROMOTION_MODE_COMMAND_NAMES,
  semanticRolloutModes: SEMANTIC_PROMOTION_ROLLOUT_MODES,
  modelMayDirectPromote: false,
  directAgentEscalationCreatesTargetedOffer: true,
} as const;

export interface AgentOrchestrationEscalationV1 {
  readonly schemaVersion: 1;
  readonly agentId: ID;
  readonly channelId: ID;
  readonly freshnessBasis: PromotionFreshnessBasisV1;
  readonly objectiveSnapshot: PromotionObjectiveSnapshotV1;
  readonly orchestrationNeed: boolean;
  readonly scopeDecision: AgentEscalationScopeDecision;
  readonly simpleRequest?: {
    readonly messageId: ID;
    readonly dispatchId: ID;
    readonly targetAgentId: ID;
  };
}

export interface AgentOrchestrationEscalationCommandV1 {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly escalation: AgentOrchestrationEscalationV1;
}

export interface SemanticPromotionEvaluateCommandV1 {
  readonly schemaVersion: 1;
  readonly channelId: ID;
  readonly approverId: ID;
  readonly evaluation?: SemanticPromotionEvaluationV1;
  readonly evaluatorFailed?: boolean;
  readonly exclusion?: 'chat-only' | 'task-linked' | 'negative-expression';
}

export interface TeamPromotionPolicyApplicationV1 {
  readonly schemaVersion: 1;
  readonly channelId: ID;
  readonly ruleId: string;
  readonly orchestrationNeed: boolean;
  readonly exclusion?: 'chat-only' | 'task-linked' | 'negative-expression';
  readonly objectiveSnapshot: PromotionObjectiveSnapshotV1;
  readonly freshnessBasis: PromotionFreshnessBasisV1;
  readonly idempotencyKey: string;
}

const INVALID = 'PROMOTION_MODES_PAYLOAD_INVALID';

function exact(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(INVALID);
  }
}

function string(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(INVALID);
}

function integer(value: unknown, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(INVALID);
}

function provenance(value: unknown): void {
  exact(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) throw new Error(INVALID);
  string(value.id);
  if (value.revision !== undefined) integer(value.revision);
  if (value.sequence !== undefined) integer(value.sequence);
  if (value.scope !== undefined) string(value.scope);
  if (value.hash !== undefined) string(value.hash);
}

function objective(value: unknown): void {
  exact(value, ['schemaVersion', 'objective', 'scope', 'riskLevel', 'dataSnapshot'],
    ['schemaVersion', 'objective', 'scope', 'riskLevel']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  string(value.objective);
  string(value.scope);
  if (value.riskLevel !== 'low' && value.riskLevel !== 'medium' && value.riskLevel !== 'high') {
    throw new Error(INVALID);
  }
  if (value.dataSnapshot !== undefined) string(value.dataSnapshot);
}

export function parseSemanticPromotionEvaluationV1(value: unknown): SemanticPromotionEvaluationV1 {
  exact(value,
    ['schemaVersion', 'sourceLineage', 'sourceRevision', 'verdict', 'clarificationQuestion',
      'objectiveSnapshot', 'rationaleCode'],
    ['schemaVersion', 'sourceLineage', 'verdict', 'rationaleCode']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  provenance(value.sourceLineage);
  if (value.sourceRevision !== undefined) integer(value.sourceRevision);
  if (!SEMANTIC_PROMOTION_VERDICTS.includes(value.verdict as SemanticPromotionVerdict)) throw new Error(INVALID);
  string(value.rationaleCode);
  if (value.verdict === 'clarification') {
    string(value.clarificationQuestion);
    if (value.objectiveSnapshot !== undefined) throw new Error(INVALID);
  } else if (value.verdict === 'proposal') {
    objective(value.objectiveSnapshot);
    if (value.clarificationQuestion !== undefined) throw new Error(INVALID);
  } else if (value.clarificationQuestion !== undefined || value.objectiveSnapshot !== undefined) {
    throw new Error(INVALID);
  }
  return structuredClone(value) as unknown as SemanticPromotionEvaluationV1;
}

export function parseSemanticPromotionRolloutStateV1(value: unknown): SemanticPromotionRolloutStateV1 {
  exact(value, ['schemaVersion', 'teamId', 'mode', 'revision', 'updatedAt'],
    ['schemaVersion', 'teamId', 'mode', 'revision', 'updatedAt']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  string(value.teamId);
  if (!SEMANTIC_PROMOTION_ROLLOUT_MODES.includes(value.mode as SemanticPromotionRolloutMode)) {
    throw new Error(INVALID);
  }
  integer(value.revision, 1);
  integer(value.updatedAt);
  return structuredClone(value) as unknown as SemanticPromotionRolloutStateV1;
}

export function parseTeamPromotionPolicyV1(value: unknown): TeamPromotionPolicyV1 {
  exact(value,
    ['schemaVersion', 'teamId', 'revision', 'enabled', 'ruleId', 'preauthorized',
      'requireOrchestrationNeed', 'updatedAt'],
    ['schemaVersion', 'teamId', 'revision', 'enabled', 'ruleId', 'preauthorized',
      'requireOrchestrationNeed', 'updatedAt']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  string(value.teamId);
  integer(value.revision, 1);
  if (typeof value.enabled !== 'boolean' || typeof value.preauthorized !== 'boolean'
    || value.requireOrchestrationNeed !== true) throw new Error(INVALID);
  string(value.ruleId);
  integer(value.updatedAt);
  return structuredClone(value) as unknown as TeamPromotionPolicyV1;
}

export function parsePromotionProposalV1(value: unknown): PromotionProposalV1 {
  exact(value,
    ['schemaVersion', 'id', 'teamId', 'channelId', 'sourceLineage', 'sourceRevision', 'requesterId',
      'approverId', 'objectiveSnapshot', 'status', 'revision', 'authorizationToken', 'expiresAt',
      'createdAt', 'updatedAt'],
    ['schemaVersion', 'id', 'teamId', 'channelId', 'sourceLineage', 'requesterId', 'approverId',
      'objectiveSnapshot', 'status', 'revision', 'authorizationToken', 'expiresAt', 'createdAt', 'updatedAt']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  for (const field of ['id', 'teamId', 'channelId', 'requesterId', 'approverId', 'authorizationToken'] as const) {
    string(value[field]);
  }
  provenance(value.sourceLineage);
  if (value.sourceRevision !== undefined) integer(value.sourceRevision);
  objective(value.objectiveSnapshot);
  if (!PROMOTION_PROPOSAL_STATUSES.includes(value.status as PromotionProposalStatus)) throw new Error(INVALID);
  integer(value.revision, 1);
  integer(value.expiresAt);
  integer(value.createdAt);
  integer(value.updatedAt);
  return structuredClone(value) as unknown as PromotionProposalV1;
}

export function parsePromotionProposalActionV1(value: unknown): PromotionProposalActionV1 {
  exact(value,
    ['schemaVersion', 'action', 'proposalId', 'expectedRevision', 'authorizationToken', 'idempotencyKey'],
    ['schemaVersion', 'action', 'proposalId', 'expectedRevision', 'authorizationToken', 'idempotencyKey']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  if (!PROMOTION_PROPOSAL_ACTIONS.includes(value.action as PromotionProposalAction)) throw new Error(INVALID);
  string(value.proposalId);
  integer(value.expectedRevision, 1);
  string(value.authorizationToken);
  string(value.idempotencyKey);
  return structuredClone(value) as unknown as PromotionProposalActionV1;
}

export function parseAgentOrchestrationEscalationV1(value: unknown): AgentOrchestrationEscalationV1 {
  exact(value,
    ['schemaVersion', 'agentId', 'channelId', 'freshnessBasis', 'objectiveSnapshot',
      'orchestrationNeed', 'scopeDecision', 'simpleRequest'],
    ['schemaVersion', 'agentId', 'channelId', 'freshnessBasis', 'objectiveSnapshot',
      'orchestrationNeed', 'scopeDecision']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  string(value.agentId);
  string(value.channelId);
  exact(value.freshnessBasis, ['schemaVersion', 'sourceLineage', 'sourceRevision'],
    ['schemaVersion', 'sourceLineage']);
  if (value.freshnessBasis.schemaVersion !== 1) throw new Error(INVALID);
  provenance(value.freshnessBasis.sourceLineage);
  if (value.freshnessBasis.sourceRevision !== undefined) integer(value.freshnessBasis.sourceRevision);
  objective(value.objectiveSnapshot);
  if (typeof value.orchestrationNeed !== 'boolean') throw new Error(INVALID);
  if (value.scopeDecision !== 'within-authorized-scope'
    && value.scopeDecision !== 'expands-authorized-scope') throw new Error(INVALID);
  if (value.simpleRequest !== undefined) {
    exact(value.simpleRequest, ['messageId', 'dispatchId', 'targetAgentId'],
      ['messageId', 'dispatchId', 'targetAgentId']);
    string(value.simpleRequest.messageId);
    string(value.simpleRequest.dispatchId);
    string(value.simpleRequest.targetAgentId);
  }
  return structuredClone(value) as unknown as AgentOrchestrationEscalationV1;
}

export function parseAgentOrchestrationEscalationCommandV1(
  value: unknown,
): AgentOrchestrationEscalationCommandV1 {
  exact(value, ['schemaVersion', 'idempotencyKey', 'escalation'],
    ['schemaVersion', 'idempotencyKey', 'escalation']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  string(value.idempotencyKey);
  return {
    schemaVersion: 1,
    idempotencyKey: value.idempotencyKey,
    escalation: parseAgentOrchestrationEscalationV1(value.escalation),
  };
}

export function parseSemanticPromotionEvaluateCommandV1(
  value: unknown,
): SemanticPromotionEvaluateCommandV1 {
  exact(value,
    ['schemaVersion', 'channelId', 'approverId', 'evaluation', 'evaluatorFailed', 'exclusion'],
    ['schemaVersion', 'channelId', 'approverId']);
  if (value.schemaVersion !== 1) throw new Error(INVALID);
  string(value.channelId);
  string(value.approverId);
  if (value.evaluatorFailed !== undefined && typeof value.evaluatorFailed !== 'boolean') throw new Error(INVALID);
  if (value.exclusion !== undefined
    && !['chat-only', 'task-linked', 'negative-expression'].includes(value.exclusion as string)) {
    throw new Error(INVALID);
  }
  return {
    schemaVersion: 1,
    channelId: value.channelId,
    approverId: value.approverId,
    ...(value.evaluation === undefined
      ? {}
      : { evaluation: parseSemanticPromotionEvaluationV1(value.evaluation) }),
    ...(value.evaluatorFailed === undefined ? {} : { evaluatorFailed: value.evaluatorFailed }),
    ...(value.exclusion === undefined
      ? {}
      : { exclusion: value.exclusion as SemanticPromotionEvaluateCommandV1['exclusion'] }),
  };
}

export function parseTeamPromotionPolicyApplicationV1(
  value: unknown,
): TeamPromotionPolicyApplicationV1 {
  exact(value,
    ['schemaVersion', 'channelId', 'ruleId', 'orchestrationNeed', 'exclusion',
      'objectiveSnapshot', 'freshnessBasis', 'idempotencyKey'],
    ['schemaVersion', 'channelId', 'ruleId', 'orchestrationNeed',
      'objectiveSnapshot', 'freshnessBasis', 'idempotencyKey']);
  if (value.schemaVersion !== 1 || typeof value.orchestrationNeed !== 'boolean') throw new Error(INVALID);
  string(value.channelId);
  string(value.ruleId);
  string(value.idempotencyKey);
  if (value.exclusion !== undefined
    && !['chat-only', 'task-linked', 'negative-expression'].includes(value.exclusion as string)) {
    throw new Error(INVALID);
  }
  objective(value.objectiveSnapshot);
  exact(value.freshnessBasis, ['schemaVersion', 'sourceLineage', 'sourceRevision'],
    ['schemaVersion', 'sourceLineage']);
  if (value.freshnessBasis.schemaVersion !== 1) throw new Error(INVALID);
  provenance(value.freshnessBasis.sourceLineage);
  if (value.freshnessBasis.sourceRevision !== undefined) integer(value.freshnessBasis.sourceRevision);
  return structuredClone(value) as unknown as TeamPromotionPolicyApplicationV1;
}
