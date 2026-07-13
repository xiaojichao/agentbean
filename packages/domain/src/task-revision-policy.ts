import type { AcceptanceCriterionDto } from '@agentbean/contracts';

export interface TaskRevisionSemanticState {
  readonly objective: string;
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly dependencyTaskIds: readonly string[];
  readonly claimPolicy: 'open' | 'targeted';
  readonly assigneeId?: string;
}

export interface EvaluateTaskRevisionChangeInput {
  readonly currentRevision: number;
  readonly expectedRevision: number;
  readonly current: TaskRevisionSemanticState;
  readonly next: TaskRevisionSemanticState;
  readonly retiredCriterionIds: readonly string[];
}

export type TaskRevisionRejection =
  | 'invalid-revision'
  | 'stale-revision'
  | 'future-revision'
  | 'revision-overflow'
  | 'invalid-semantic-state'
  | 'invalid-criterion-identity'
  | 'criterion-id-reused'
  | 'retired-criterion-id-reused';

export type TaskRevisionChangeDecision =
  | { readonly kind: 'unchanged'; readonly revision: number }
  | {
      readonly kind: 'revised';
      readonly revision: number;
      readonly retiredCriterionIds: readonly string[];
    }
  | { readonly kind: 'rejected'; readonly reason: TaskRevisionRejection };

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function uniqueNonEmpty(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0) && new Set(values).size === values.length;
}

function validState(state: TaskRevisionSemanticState): boolean {
  if (state.objective.length === 0 || !uniqueNonEmpty(state.dependencyTaskIds)) return false;
  if (state.claimPolicy === 'open' && state.assigneeId !== undefined) return false;
  if (state.claimPolicy === 'targeted' && !state.assigneeId) return false;
  return state.acceptanceCriteria.every((criterion) => criterion.id.length > 0
    && criterion.description.length > 0
    && (criterion.allowedEvidenceKinds === undefined
      || new Set(criterion.allowedEvidenceKinds).size === criterion.allowedEvidenceKinds.length));
}

function criterionSemanticsEqual(
  left: AcceptanceCriterionDto,
  right: AcceptanceCriterionDto,
): boolean {
  const leftKinds = [...(left.allowedEvidenceKinds ?? [])].sort();
  const rightKinds = [...(right.allowedEvidenceKinds ?? [])].sort();
  return left.description === right.description
    && left.evidenceRequired === right.evidenceRequired
    && JSON.stringify(leftKinds) === JSON.stringify(rightKinds);
}

function statesEqual(left: TaskRevisionSemanticState, right: TaskRevisionSemanticState): boolean {
  if (left.objective !== right.objective
    || left.claimPolicy !== right.claimPolicy
    || left.assigneeId !== right.assigneeId) return false;
  const leftDependencies = [...left.dependencyTaskIds].sort();
  const rightDependencies = [...right.dependencyTaskIds].sort();
  if (JSON.stringify(leftDependencies) !== JSON.stringify(rightDependencies)) return false;
  if (left.acceptanceCriteria.length !== right.acceptanceCriteria.length) return false;
  return left.acceptanceCriteria.every((criterion, index) => {
    const other = right.acceptanceCriteria[index];
    return other !== undefined
      && criterion.id === other.id
      && criterionSemanticsEqual(criterion, other);
  });
}

export function authorizeTaskRevision(input: {
  readonly currentRevision: number;
  readonly presentedRevision: number;
}): { readonly kind: 'authorized'; readonly revision: number }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-revision' | 'stale-revision' | 'future-revision' } {
  if (!isPositiveSafeInteger(input.currentRevision) || !isPositiveSafeInteger(input.presentedRevision)) {
    return { kind: 'rejected', reason: 'invalid-revision' };
  }
  if (input.presentedRevision < input.currentRevision) return { kind: 'rejected', reason: 'stale-revision' };
  if (input.presentedRevision > input.currentRevision) return { kind: 'rejected', reason: 'future-revision' };
  return { kind: 'authorized', revision: input.currentRevision };
}

export function evaluateTaskRevisionChange(
  input: EvaluateTaskRevisionChangeInput,
): TaskRevisionChangeDecision {
  const revisionDecision = authorizeTaskRevision({
    currentRevision: input.currentRevision,
    presentedRevision: input.expectedRevision,
  });
  if (revisionDecision.kind === 'rejected') return revisionDecision;
  if (!validState(input.current) || !validState(input.next)) {
    return { kind: 'rejected', reason: 'invalid-semantic-state' };
  }

  const currentIds = input.current.acceptanceCriteria.map((criterion) => criterion.id);
  const nextIds = input.next.acceptanceCriteria.map((criterion) => criterion.id);
  if (!uniqueNonEmpty(currentIds) || !uniqueNonEmpty(nextIds)
    || !uniqueNonEmpty(input.retiredCriterionIds)
    || input.retiredCriterionIds.some((id) => currentIds.includes(id))) {
    return { kind: 'rejected', reason: 'invalid-criterion-identity' };
  }

  const currentById = new Map(input.current.acceptanceCriteria.map((criterion) => [criterion.id, criterion]));
  const retired = new Set(input.retiredCriterionIds);
  for (const criterion of input.next.acceptanceCriteria) {
    const existing = currentById.get(criterion.id);
    if (existing && !criterionSemanticsEqual(existing, criterion)) {
      return { kind: 'rejected', reason: 'criterion-id-reused' };
    }
    if (!existing && retired.has(criterion.id)) {
      return { kind: 'rejected', reason: 'retired-criterion-id-reused' };
    }
  }

  if (statesEqual(input.current, input.next)) {
    return { kind: 'unchanged', revision: input.currentRevision };
  }
  if (input.currentRevision === Number.MAX_SAFE_INTEGER) {
    return { kind: 'rejected', reason: 'revision-overflow' };
  }
  for (const criterionId of currentIds) {
    if (!nextIds.includes(criterionId)) retired.add(criterionId);
  }
  return {
    kind: 'revised',
    revision: input.currentRevision + 1,
    retiredCriterionIds: [...retired].sort(),
  };
}
