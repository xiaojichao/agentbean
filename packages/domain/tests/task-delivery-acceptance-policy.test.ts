import { describe, expect, test } from 'vitest';
import { evaluateTaskDeliveryFileReviewGate } from '../src/index.js';

describe('task delivery acceptance file review gate', () => {
  test('没有必需文件时门禁不适用并允许沿用无文件交付流程', () => {
    expect(evaluateTaskDeliveryFileReviewGate({ requiredFiles: [] })).toEqual({
      kind: 'allowed',
      coverage: {
        available: true,
        applicable: false,
        requiredCount: 0,
        approvedCount: 0,
        pendingCount: 0,
        changesRequestedCount: 0,
        rejectedCount: 0,
        unavailableCount: 0,
        complete: true,
        items: [],
      },
    });
  });

  test('只有全部必需成员的 current 版本 approved 才允许验收', () => {
    const approved = {
      collectionId: 'collection-a', currentVersionId: 'version-a', shortLabel: 'F1',
      filename: '剧本.md', reviewState: 'approved' as const,
    };
    const pending = {
      collectionId: 'collection-b', currentVersionId: 'version-b', shortLabel: 'F2',
      filename: '分镜.md', reviewState: 'pending' as const,
    };

    expect(evaluateTaskDeliveryFileReviewGate({ requiredFiles: [approved, pending] })).toMatchObject({
      kind: 'rejected',
      reasonCode: 'required_file_reviews_incomplete',
      coverage: { requiredCount: 2, approvedCount: 1, pendingCount: 1, complete: false },
      blockers: [pending],
    });
    expect(evaluateTaskDeliveryFileReviewGate({
      requiredFiles: [approved, { ...pending, reviewState: 'approved' }],
    })).toMatchObject({
      kind: 'allowed',
      coverage: { requiredCount: 2, approvedCount: 2, complete: true },
    });
  });

  test.each(['changes_requested', 'rejected', 'unavailable'] as const)(
    '%s current 版本会阻止验收并进入对应覆盖计数',
    (reviewState) => {
      const decision = evaluateTaskDeliveryFileReviewGate({
        requiredFiles: [{
          collectionId: 'collection-a', shortLabel: 'F1', filename: '剧本.md', reviewState,
        }],
      });
      expect(decision.kind).toBe('rejected');
      expect(decision.coverage.complete).toBe(false);
      expect(decision.coverage[reviewState === 'changes_requested'
        ? 'changesRequestedCount'
        : reviewState === 'rejected' ? 'rejectedCount' : 'unavailableCount']).toBe(1);
    },
  );
});
