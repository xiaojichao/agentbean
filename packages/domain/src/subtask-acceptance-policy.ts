import type { AcceptanceCriterionDto, EvidenceRefDto } from '@agentbean/contracts';

export interface SubtaskCriterionResult {
  readonly criterionId: string;
  readonly passed: boolean;
  readonly evidenceRefs: readonly EvidenceRefDto[];
}

export interface EvidenceSnapshotFact {
  readonly ref: EvidenceRefDto;
  readonly available: boolean;
  readonly visible: boolean;
  readonly currentSnapshotHash: string;
}

export interface EvaluateSubtaskAcceptanceInput {
  readonly criteria: readonly AcceptanceCriterionDto[];
  readonly criteriaResults: readonly SubtaskCriterionResult[];
  readonly evidenceSnapshots: readonly EvidenceSnapshotFact[];
  readonly highRisk: boolean;
  readonly conflictingEvidence: boolean;
}

export type SubtaskAcceptanceRejection =
  | 'invalid-criterion-definition'
  | 'criterion-result-missing'
  | 'criterion-result-duplicate'
  | 'criterion-result-unknown'
  | 'criterion-failed'
  | 'required-evidence-missing'
  | 'evidence-kind-not-allowed'
  | 'evidence-snapshot-duplicate'
  | 'evidence-snapshot-missing'
  | 'evidence-source-unavailable'
  | 'evidence-source-not-visible'
  | 'evidence-snapshot-drifted';

export type SubtaskAcceptanceDecision =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'rejected'; readonly reason: SubtaskAcceptanceRejection }
  | { readonly kind: 'needs_human'; readonly reason: 'high-risk-judgment' | 'conflicting-evidence' };

function evidenceKey(ref: EvidenceRefDto): string {
  return `${ref.kind}:${ref.id}:${ref.snapshotHash}`;
}

export function evaluateSubtaskAcceptance(
  input: EvaluateSubtaskAcceptanceInput,
): SubtaskAcceptanceDecision {
  const criterionIds = input.criteria.map((criterion) => criterion.id);
  if (criterionIds.some((id) => id.length === 0)
    || new Set(criterionIds).size !== criterionIds.length) {
    return { kind: 'rejected', reason: 'invalid-criterion-definition' };
  }

  const resultIds = input.criteriaResults.map((result) => result.criterionId);
  if (new Set(resultIds).size !== resultIds.length) {
    return { kind: 'rejected', reason: 'criterion-result-duplicate' };
  }
  if (resultIds.some((id) => !criterionIds.includes(id))) {
    return { kind: 'rejected', reason: 'criterion-result-unknown' };
  }
  if (criterionIds.some((id) => !resultIds.includes(id))) {
    return { kind: 'rejected', reason: 'criterion-result-missing' };
  }

  const snapshotByKey = new Map<string, EvidenceSnapshotFact>();
  for (const fact of input.evidenceSnapshots) {
    const key = evidenceKey(fact.ref);
    if (snapshotByKey.has(key)) {
      return { kind: 'rejected', reason: 'evidence-snapshot-duplicate' };
    }
    snapshotByKey.set(key, fact);
  }
  for (const criterion of input.criteria) {
    const result = input.criteriaResults.find((candidate) => candidate.criterionId === criterion.id)!;
    if (!result.passed) return { kind: 'rejected', reason: 'criterion-failed' };
    if (criterion.evidenceRequired && result.evidenceRefs.length === 0) {
      return { kind: 'rejected', reason: 'required-evidence-missing' };
    }
    if (criterion.allowedEvidenceKinds !== undefined
      && result.evidenceRefs.some((ref) => !criterion.allowedEvidenceKinds!.includes(ref.kind))) {
      return { kind: 'rejected', reason: 'evidence-kind-not-allowed' };
    }
    for (const ref of result.evidenceRefs) {
      const snapshot = snapshotByKey.get(evidenceKey(ref));
      if (!snapshot) return { kind: 'rejected', reason: 'evidence-snapshot-missing' };
      if (!snapshot.available) return { kind: 'rejected', reason: 'evidence-source-unavailable' };
      if (!snapshot.visible) return { kind: 'rejected', reason: 'evidence-source-not-visible' };
      if (snapshot.currentSnapshotHash !== ref.snapshotHash) {
        return { kind: 'rejected', reason: 'evidence-snapshot-drifted' };
      }
    }
  }

  if (input.highRisk) return { kind: 'needs_human', reason: 'high-risk-judgment' };
  if (input.conflictingEvidence) return { kind: 'needs_human', reason: 'conflicting-evidence' };
  return { kind: 'accepted' };
}
