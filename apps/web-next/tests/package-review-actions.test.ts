import { describe, expect, test, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  submitPackageArtifactReview: vi.fn(),
  submitPackageReviewAndFinalize: vi.fn(),
  submitPackageReviewAndRejectDelivery: vi.fn(),
  setArtifactFinalVersion: vi.fn(),
  acceptRootDelivery: vi.fn(),
  rejectRootDelivery: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    submitPackageArtifactReview: mocks.submitPackageArtifactReview,
    submitPackageReviewAndFinalize: mocks.submitPackageReviewAndFinalize,
    submitPackageReviewAndRejectDelivery: mocks.submitPackageReviewAndRejectDelivery,
    setArtifactFinalVersion: mocks.setArtifactFinalVersion,
  }),
  taskEvents: () => ({
    acceptRootDelivery: mocks.acceptRootDelivery,
    rejectRootDelivery: mocks.rejectRootDelivery,
  }),
}));

import {
  decisionForPackageAction,
  mutationLockKey,
  packageActionRequiresComment,
  packageActionRequiresRejectReason,
  submitDeliveryMutation,
  submitPackageMutation,
  validateDeliveryMutationDraft,
  validatePackageMutationDraft,
} from '../lib/package-review-actions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('package-review-actions helpers (#1177)', () => {
  test('动作映射到决策与表单字段要求', () => {
    expect(decisionForPackageAction('review-approved')).toBe('approved');
    expect(decisionForPackageAction('review-changes-requested')).toBe('changes_requested');
    expect(decisionForPackageAction('review-rejected')).toBe('rejected');
    expect(decisionForPackageAction('review-and-finalize')).toBe('approved');
    expect(decisionForPackageAction('review-and-reject-delivery')).toBe('changes_requested');
    expect(decisionForPackageAction('set-final')).toBeNull();
    expect(packageActionRequiresComment('set-final')).toBe(false);
    expect(packageActionRequiresComment('review-approved')).toBe(true);
    expect(packageActionRequiresRejectReason('review-and-reject-delivery')).toBe(true);
    expect(packageActionRequiresRejectReason('review-rejected')).toBe(false);
  });

  test('校验草稿：comment / rejectReason 必填', () => {
    expect(validatePackageMutationDraft('review-approved', { comment: '', rejectReason: '' })).toMatch(/审核意见/);
    expect(validatePackageMutationDraft('review-and-reject-delivery', {
      comment: '需要改',
      rejectReason: '',
    })).toMatch(/退回理由/);
    expect(validatePackageMutationDraft('set-final', { comment: '', rejectReason: '' })).toBeNull();
    expect(validateDeliveryMutationDraft('reject-delivery', { comment: '', rejectReason: '' })).toMatch(/退回理由/);
    expect(validateDeliveryMutationDraft('accept-delivery', { comment: '', rejectReason: '' })).toBeNull();
  });

  test('submitPackageMutation 走对应具名 command 并保留原 idempotency key', async () => {
    mocks.submitPackageArtifactReview.mockResolvedValue({ ok: true, review: { id: 'r1' } });
    mocks.submitPackageReviewAndFinalize.mockResolvedValue({ ok: true });
    mocks.submitPackageReviewAndRejectDelivery.mockResolvedValue({ ok: true });
    mocks.setArtifactFinalVersion.mockResolvedValue({ ok: true });

    const member = {
      sequence: 1,
      shortLabel: 'F1',
      collectionId: 'col-1',
      artifactVersionId: 'ver-1',
      requiredForFinal: true,
      sourcePath: 'a.md',
      filename: 'a.md',
      review: { covered: false, actualReviewerIds: [], records: [] },
      availableActions: {
        collectionId: 'col-1',
        versionId: 'ver-1',
        reviewState: 'pending' as const,
        isFinalVersion: false,
        collectionRevision: 3,
        actions: ['review-approved' as const],
      },
    };
    const pkg = {
      schemaVersion: 1 as const,
      packageId: 'pkg-1',
      teamId: 'team-1',
      channelId: 'ch-1',
      revision: 1,
      deliveryId: 'del-1',
      publishId: 'pub-1',
      workspaceRevisionId: 'ws-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskBinding: 'managed' as const,
      taskRevision: 4,
      taskAttempt: 2,
      members: [],
      memberCount: 0,
      status: 'recorded' as const,
      createdAt: 1,
    };

    await submitPackageMutation(
      { channelId: 'ch-1', package: pkg, member, action: 'review-approved' },
      { comment: '通过', rejectReason: '' },
      'key-review-1',
    );
    expect(mocks.submitPackageArtifactReview).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'ch-1',
      packageId: 'pkg-1',
      collectionId: 'col-1',
      versionId: 'ver-1',
      decision: 'approved',
      comment: '通过',
      idempotencyKey: 'key-review-1',
    }));

    await submitPackageMutation(
      { channelId: 'ch-1', package: pkg, member, action: 'review-and-finalize' },
      { comment: '过', rejectReason: '' },
      'key-final-1',
    );
    expect(mocks.submitPackageReviewAndFinalize).toHaveBeenCalledWith(expect.objectContaining({
      expectedCollectionRevision: 3,
      idempotencyKey: 'key-final-1',
      decision: 'approved',
    }));

    await submitPackageMutation(
      { channelId: 'ch-1', package: pkg, member, action: 'review-and-reject-delivery' },
      { comment: '改', rejectReason: '格式不对' },
      'key-reject-1',
    );
    expect(mocks.submitPackageReviewAndRejectDelivery).toHaveBeenCalledWith(expect.objectContaining({
      expectedTaskRevision: 4,
      expectedTaskAttempt: 2,
      rejectReason: '格式不对',
      decision: 'changes_requested',
      idempotencyKey: 'key-reject-1',
    }));

    await submitPackageMutation(
      { channelId: 'ch-1', package: pkg, member, action: 'set-final' },
      { comment: 'final', rejectReason: '' },
      'key-set-final-1',
    );
    expect(mocks.setArtifactFinalVersion).toHaveBeenCalledWith(expect.objectContaining({
      collectionId: 'col-1',
      versionId: 'ver-1',
      expectedCollectionRevision: 3,
      idempotencyKey: 'key-set-final-1',
    }));
  });

  test('submitDeliveryMutation 走 accept/reject root delivery', async () => {
    mocks.acceptRootDelivery.mockResolvedValue({ ok: true });
    mocks.rejectRootDelivery.mockResolvedValue({ ok: false, error: 'FORBIDDEN' });

    await submitDeliveryMutation(
      { taskId: 'task-1', expectedTaskRevision: 7, kind: 'accept-delivery' },
      { comment: '', rejectReason: '' },
    );
    expect(mocks.acceptRootDelivery).toHaveBeenCalledWith({
      taskId: 'task-1',
      expectedTaskRevision: 7,
    });

    const rejected = await submitDeliveryMutation(
      { taskId: 'task-1', expectedTaskRevision: 7, kind: 'reject-delivery' },
      { comment: '', rejectReason: '重做' },
    );
    expect(mocks.rejectRootDelivery).toHaveBeenCalledWith({
      taskId: 'task-1',
      reason: '重做',
      expectedTaskRevision: 7,
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toBe('FORBIDDEN');
  });

  test('mutationLockKey 按目标区分', () => {
    expect(mutationLockKey({
      kind: 'package', collectionId: 'c', versionId: 'v', action: 'review-approved',
    })).toBe('package:c:v:review-approved');
    expect(mutationLockKey({
      kind: 'delivery', taskId: 't', action: 'accept-delivery',
    })).toBe('delivery:t:accept-delivery');
  });
});
