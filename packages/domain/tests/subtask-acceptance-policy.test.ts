import { describe, expect, test } from 'vitest';

import {
  evaluateSubtaskAcceptance,
  type EvidenceSnapshotFact,
  type EvaluateSubtaskAcceptanceInput,
} from '../src/index.js';

const criteria = [
  {
    id: 'criterion-1',
    description: '测试通过',
    evidenceRequired: true,
    allowedEvidenceKinds: ['workspace-run'] as const,
  },
  {
    id: 'criterion-2',
    description: '结果有摘要',
    evidenceRequired: false,
  },
];

const evidenceRef = {
  kind: 'workspace-run' as const,
  id: 'run-1',
  snapshotHash: 'hash-1',
  snapshotRevision: 1,
  capturedAt: 100,
};

const snapshot: EvidenceSnapshotFact = {
  ref: evidenceRef,
  available: true,
  visible: true,
  currentSnapshotHash: 'hash-1',
};

function input(
  overrides: Partial<EvaluateSubtaskAcceptanceInput> = {},
): EvaluateSubtaskAcceptanceInput {
  return {
    criteria,
    criteriaResults: [
      { criterionId: 'criterion-1', passed: true, evidenceRefs: [evidenceRef] },
      { criterionId: 'criterion-2', passed: true, evidenceRefs: [] },
    ],
    evidenceSnapshots: [snapshot],
    highRisk: false,
    conflictingEvidence: false,
    ...overrides,
  };
}

describe('Phase 2 subtask acceptance policy', () => {
  test('accepts only complete passing criteria with stable visible evidence', () => {
    expect(evaluateSubtaskAcceptance(input())).toEqual({ kind: 'accepted' });
  });

  test.each([
    [[], 'criterion-result-missing'],
    [[
      { criterionId: 'criterion-1', passed: true, evidenceRefs: [evidenceRef] },
      { criterionId: 'criterion-1', passed: true, evidenceRefs: [evidenceRef] },
      { criterionId: 'criterion-2', passed: true, evidenceRefs: [] },
    ], 'criterion-result-duplicate'],
    [[
      { criterionId: 'criterion-1', passed: true, evidenceRefs: [evidenceRef] },
      { criterionId: 'criterion-2', passed: true, evidenceRefs: [] },
      { criterionId: 'criterion-unknown', passed: true, evidenceRefs: [] },
    ], 'criterion-result-unknown'],
  ] as const)('rejects invalid criterion coverage: %s', (criteriaResults, reason) => {
    expect(evaluateSubtaskAcceptance(input({ criteriaResults })))
      .toEqual({ kind: 'rejected', reason });
  });

  test('rejects a failed criterion', () => {
    expect(evaluateSubtaskAcceptance(input({
      criteriaResults: [
        { criterionId: 'criterion-1', passed: false, evidenceRefs: [evidenceRef] },
        { criterionId: 'criterion-2', passed: true, evidenceRefs: [] },
      ],
    }))).toEqual({ kind: 'rejected', reason: 'criterion-failed' });
  });

  test('required evidence must be present and of an allowed kind', () => {
    expect(evaluateSubtaskAcceptance(input({
      criteriaResults: [
        { criterionId: 'criterion-1', passed: true, evidenceRefs: [] },
        { criterionId: 'criterion-2', passed: true, evidenceRefs: [] },
      ],
    }))).toEqual({ kind: 'rejected', reason: 'required-evidence-missing' });

    const messageRef = { ...evidenceRef, kind: 'message' as const };
    expect(evaluateSubtaskAcceptance(input({
      criteriaResults: [
        { criterionId: 'criterion-1', passed: true, evidenceRefs: [messageRef] },
        { criterionId: 'criterion-2', passed: true, evidenceRefs: [] },
      ],
      evidenceSnapshots: [{ ...snapshot, ref: messageRef }],
    }))).toEqual({ kind: 'rejected', reason: 'evidence-kind-not-allowed' });
  });

  test.each([
    [[], 'evidence-snapshot-missing'],
    [[{ ...snapshot, available: false }], 'evidence-source-unavailable'],
    [[{ ...snapshot, visible: false }], 'evidence-source-not-visible'],
    [[{ ...snapshot, currentSnapshotHash: 'hash-changed' }], 'evidence-snapshot-drifted'],
  ] as const)('evidence facts fail closed: %s', (evidenceSnapshots, reason) => {
    expect(evaluateSubtaskAcceptance(input({ evidenceSnapshots })))
      .toEqual({ kind: 'rejected', reason });
  });

  test('high-risk or conflicting evidence requires human review', () => {
    expect(evaluateSubtaskAcceptance(input({ highRisk: true })))
      .toEqual({ kind: 'needs_human', reason: 'high-risk-judgment' });
    expect(evaluateSubtaskAcceptance(input({ conflictingEvidence: true })))
      .toEqual({ kind: 'needs_human', reason: 'conflicting-evidence' });
  });

  test('duplicate criterion definitions fail closed', () => {
    expect(evaluateSubtaskAcceptance(input({ criteria: [criteria[0]!, criteria[0]!] })))
      .toEqual({ kind: 'rejected', reason: 'invalid-criterion-definition' });
  });

  test('duplicate snapshot facts fail closed instead of silently choosing one', () => {
    expect(evaluateSubtaskAcceptance(input({
      evidenceSnapshots: [snapshot, { ...snapshot, visible: false }],
    }))).toEqual({ kind: 'rejected', reason: 'evidence-snapshot-duplicate' });
  });
});
