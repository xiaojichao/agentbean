import type { ID, UnixMs } from './common.js';
import type { AgentInvocationTaskContextV1, DependencyResultRefDto } from './invocation.js';
import type { AcceptanceCriterionDto, EvidenceRefDto } from './task-coordination.js';

export type AgentHandoffKind = 'delegate' | 'consult' | 'review' | 'template_request' | 'continuation';
export type SerialAgentHandoffKind = Extract<AgentHandoffKind, 'consult' | 'template_request' | 'continuation'>;
export type AgentHandoffReturnMode = 'return_to_manager' | 'return_to_source_agent' | 'deliver_to_root';

export interface AgentCollaborationProposalV1 {
  readonly schemaVersion: 1;
  readonly sourceInvocationId: ID;
  readonly sourceAgentId: ID;
  readonly sourceTaskContext?: AgentInvocationTaskContextV1;
  readonly toAgentId: ID;
  readonly kind: SerialAgentHandoffKind;
  readonly objective: string;
  readonly reason: string;
  readonly contextRefs: readonly EvidenceRefDto[];
  readonly dependencyResults: readonly DependencyResultRefDto[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly attachmentIds: readonly ID[];
  readonly returnMode: AgentHandoffReturnMode;
  readonly deadlineAt?: UnixMs;
}

export interface AgentCollaborationProposalRecordDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly managementRunId: ID;
  readonly proposal: AgentCollaborationProposalV1;
  readonly proposalHash: string;
  readonly idempotencyKey: string;
  readonly createdAt: UnixMs;
}

export interface AgentHandoffIntentV1 {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly sourceProposalId?: ID;
  readonly sourceInvocationId?: ID;
  readonly fromAgentId?: ID;
  readonly toAgentId: ID;
  readonly kind: AgentHandoffKind;
  readonly objective: string;
  readonly reason: string;
  readonly contextRefs: readonly EvidenceRefDto[];
  readonly dependencyResults: readonly DependencyResultRefDto[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly attachmentIds: readonly ID[];
  readonly contextCapsuleId?: ID;
  readonly returnMode: AgentHandoffReturnMode;
  readonly deadlineAt?: UnixMs;
}

export type AgentHandoffStatus =
  | 'requested'
  | 'accepted'
  | 'running'
  | 'returned'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface AgentHandoffRecordDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly managementRunId: ID;
  readonly intent: AgentHandoffIntentV1;
  readonly intentHash: string;
  readonly idempotencyKey: string;
  readonly invocationId?: ID;
  readonly status: AgentHandoffStatus;
  readonly acceptedAt?: UnixMs;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export interface AgentHandoffTraceDto {
  readonly id: ID;
  readonly fromAgentId?: ID;
  readonly toAgentId: ID;
  readonly kind: AgentHandoffKind;
  readonly objective: string;
  readonly status: AgentHandoffStatus;
  readonly invocationId?: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

export function parseAgentCollaborationProposalV1(value: unknown): AgentCollaborationProposalV1 {
  const proposal = record(value);
  exactKeys(proposal, [
    'schemaVersion', 'sourceInvocationId', 'sourceAgentId', 'sourceTaskContext', 'toAgentId',
    'kind', 'objective', 'reason', 'contextRefs', 'dependencyResults', 'acceptanceCriteria',
    'attachmentIds', 'returnMode', 'deadlineAt',
  ], [
    'schemaVersion', 'sourceInvocationId', 'sourceAgentId', 'toAgentId', 'kind', 'objective',
    'reason', 'contextRefs', 'dependencyResults', 'acceptanceCriteria', 'attachmentIds', 'returnMode',
  ]);
  if (proposal.schemaVersion !== 1) invalid();
  id(proposal.sourceInvocationId); id(proposal.sourceAgentId); id(proposal.toAgentId);
  if (!['consult', 'template_request', 'continuation'].includes(String(proposal.kind))) invalid();
  text(proposal.objective); text(proposal.reason);
  if (!['return_to_manager', 'return_to_source_agent', 'deliver_to_root'].includes(String(proposal.returnMode))) invalid();
  idArray(proposal.attachmentIds);
  if (proposal.deadlineAt !== undefined) integer(proposal.deadlineAt, 0);
  if (proposal.sourceTaskContext !== undefined) {
    const context = record(proposal.sourceTaskContext);
    exactKeys(context, ['taskId', 'rootTaskId', 'taskRevision', 'taskAttempt', 'claimLeaseId'],
      ['taskId', 'taskRevision', 'taskAttempt', 'claimLeaseId']);
    id(context.taskId); id(context.claimLeaseId);
    if (context.rootTaskId !== undefined) id(context.rootTaskId);
    integer(context.taskRevision, 1); integer(context.taskAttempt, 1);
  }
  array(proposal.contextRefs).forEach((candidate) => {
    const ref = record(candidate);
    exactKeys(ref, ['kind', 'id', 'snapshotHash', 'snapshotRevision', 'capturedAt'],
      ['kind', 'id', 'snapshotHash', 'capturedAt']);
    if (!['message', 'artifact', 'workspace-run', 'invocation', 'task'].includes(String(ref.kind))) invalid();
    id(ref.id); text(ref.snapshotHash); integer(ref.capturedAt, 0);
    if (ref.snapshotRevision !== undefined) integer(ref.snapshotRevision, 0);
  });
  array(proposal.dependencyResults).forEach((candidate) => {
    const result = record(candidate);
    exactKeys(result, ['invocationId', 'resultRevision', 'artifactIds', 'workspaceRunId'],
      ['invocationId', 'resultRevision', 'artifactIds']);
    id(result.invocationId); integer(result.resultRevision, 1); idArray(result.artifactIds);
    if (result.workspaceRunId !== undefined) id(result.workspaceRunId);
  });
  array(proposal.acceptanceCriteria).forEach((candidate) => {
    const criterion = record(candidate);
    exactKeys(criterion, ['id', 'description', 'evidenceRequired', 'allowedEvidenceKinds'],
      ['id', 'description', 'evidenceRequired']);
    id(criterion.id); text(criterion.description);
    if (typeof criterion.evidenceRequired !== 'boolean') invalid();
    if (criterion.allowedEvidenceKinds !== undefined) {
      const kinds = array(criterion.allowedEvidenceKinds);
      if (kinds.some((kind) => !['message', 'artifact', 'workspace-run', 'invocation', 'task'].includes(String(kind)))) invalid();
    }
  });
  return structuredClone(proposal) as unknown as AgentCollaborationProposalV1;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 256) invalid(); return value; }
function idArray(value: unknown): void { array(value).forEach(id); }
function id(value: unknown): void { if (typeof value !== 'string' || value.length === 0 || value.length > 256) invalid(); }
function text(value: unknown): void { if (typeof value !== 'string' || value.length === 0 || value.length > 32_768) invalid(); }
function integer(value: unknown, minimum: number): void { if (!Number.isSafeInteger(value) || Number(value) < minimum) invalid(); }
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))
    || required.some((key) => !Object.hasOwn(value, key) || value[key] === undefined)
    || Object.values(value).some((entry) => entry === undefined)) invalid();
}
function invalid(): never { throw new Error('AGENT_COLLABORATION_PROPOSAL_INVALID'); }
