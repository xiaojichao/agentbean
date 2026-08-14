import type { ProjectArtifactVersionReviewState } from '@agentbean/contracts';

/**
 * Agent-managed Task 的文件审核门禁。
 *
 * OutputPackage 只冻结成员身份；门禁始终检查每个必需成员 collection 的
 * currentVersionId，避免人工保存新版本后仍用旧交付版本的 approved 结论放行。
 */
export interface TaskDeliveryRequiredFileReviewFact {
  readonly collectionId: string;
  readonly currentVersionId?: string;
  readonly shortLabel: string;
  readonly filename: string;
  readonly reviewState: ProjectArtifactVersionReviewState | 'unavailable';
}

export interface TaskDeliveryFileReviewCoverage {
  readonly available: true;
  readonly applicable: boolean;
  readonly requiredCount: number;
  readonly approvedCount: number;
  readonly pendingCount: number;
  readonly changesRequestedCount: number;
  readonly rejectedCount: number;
  readonly unavailableCount: number;
  readonly complete: boolean;
  readonly items: readonly TaskDeliveryRequiredFileReviewFact[];
}

export type TaskDeliveryFileReviewGateDecision
  = | { readonly kind: 'allowed'; readonly coverage: TaskDeliveryFileReviewCoverage }
    | {
      readonly kind: 'rejected';
      readonly reasonCode: 'required_file_reviews_incomplete';
      readonly coverage: TaskDeliveryFileReviewCoverage;
      readonly blockers: readonly TaskDeliveryRequiredFileReviewFact[];
    };

export function evaluateTaskDeliveryFileReviewGate(input: {
  readonly requiredFiles: readonly TaskDeliveryRequiredFileReviewFact[];
}): TaskDeliveryFileReviewGateDecision {
  const items = [...input.requiredFiles];
  const requiredCount = items.length;
  const approvedCount = items.filter((item) => item.reviewState === 'approved').length;
  const pendingCount = items.filter((item) => item.reviewState === 'pending').length;
  const changesRequestedCount = items.filter((item) => item.reviewState === 'changes_requested').length;
  const rejectedCount = items.filter((item) => item.reviewState === 'rejected').length;
  const unavailableCount = items.filter((item) => item.reviewState === 'unavailable').length;
  const coverage: TaskDeliveryFileReviewCoverage = {
    available: true,
    applicable: requiredCount > 0,
    requiredCount,
    approvedCount,
    pendingCount,
    changesRequestedCount,
    rejectedCount,
    unavailableCount,
    complete: requiredCount === 0 || approvedCount === requiredCount,
    items,
  };
  const blockers = items.filter((item) => item.reviewState !== 'approved');
  return blockers.length === 0
    ? { kind: 'allowed', coverage }
    : { kind: 'rejected', reasonCode: 'required_file_reviews_incomplete', coverage, blockers };
}
