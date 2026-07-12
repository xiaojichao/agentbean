import type {
  ManagementCheckpointContextHintsV1,
  ManagementCheckpointV1,
} from '@agentbean/contracts';

export interface ManagementCheckpointFacts {
  readonly managementRunId: string;
  readonly lastEventSequence: number;
  readonly taskGraphRevision: number;
  readonly openTaskIds: readonly string[];
  readonly waitingInvocationIds: readonly string[];
  readonly completedInvocationIds: readonly string[];
  readonly validMemoryCapsuleIds: readonly string[];
}

export interface EvaluateManagementCheckpointInput {
  readonly checkpoint: ManagementCheckpointV1;
  readonly facts: ManagementCheckpointFacts;
}

export type ManagementCheckpointRebuildReason =
  | 'management-run-mismatch'
  | 'event-sequence-mismatch'
  | 'task-graph-revision-mismatch'
  | 'missing-open-task'
  | 'missing-waiting-invocation'
  | 'missing-completed-invocation'
  | 'invalid-memory-capsule';

export type ManagementCheckpointDecision =
  | {
      readonly kind: 'usable';
      readonly contextHints: ManagementCheckpointContextHintsV1;
    }
  | {
      readonly kind: 'rebuild_required';
      readonly reasons: readonly ManagementCheckpointRebuildReason[];
    };

export function evaluateManagementCheckpoint(
  input: EvaluateManagementCheckpointInput,
): ManagementCheckpointDecision {
  const reasons = new Set<ManagementCheckpointRebuildReason>();
  const authoritative = input.checkpoint.authoritative;
  const openTaskIds = new Set(input.facts.openTaskIds);
  const waitingInvocationIds = new Set(input.facts.waitingInvocationIds);
  const completedInvocationIds = new Set(input.facts.completedInvocationIds);
  const validMemoryCapsuleIds = new Set(input.facts.validMemoryCapsuleIds);

  if (input.checkpoint.managementRunId !== input.facts.managementRunId) {
    reasons.add('management-run-mismatch');
  }
  if (authoritative.lastEventSequence !== input.facts.lastEventSequence) {
    reasons.add('event-sequence-mismatch');
  }
  if (authoritative.taskGraphRevision !== input.facts.taskGraphRevision) {
    reasons.add('task-graph-revision-mismatch');
  }
  if (authoritative.openTaskIds.some((id) => !openTaskIds.has(id))) {
    reasons.add('missing-open-task');
  }
  if (authoritative.waitingInvocationIds.some((id) => !waitingInvocationIds.has(id))) {
    reasons.add('missing-waiting-invocation');
  }
  if (authoritative.completedInvocationIds.some((id) => !completedInvocationIds.has(id))) {
    reasons.add('missing-completed-invocation');
  }
  if (authoritative.memoryCapsuleIds.some((id) => !validMemoryCapsuleIds.has(id))) {
    reasons.add('invalid-memory-capsule');
  }

  if (reasons.size > 0) {
    return { kind: 'rebuild_required', reasons: [...reasons] };
  }
  return { kind: 'usable', contextHints: input.checkpoint.contextHints };
}
