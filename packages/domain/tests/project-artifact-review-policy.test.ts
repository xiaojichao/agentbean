import { describe, expect, test } from 'vitest';

import {
  deriveProjectArtifactVersionReviewState,
  evaluateArtifactReviewAuthority,
  evaluateProjectArtifactFinalization,
  hasProjectArtifactDecisionAuthority,
  type ProjectArtifactAuthorityFacts,
  type ProjectArtifactReviewFact,
} from '../src/project-artifact-review-policy.js';

const ownerFacts: ProjectArtifactAuthorityFacts = {
  userId: 'owner-1',
  teamRole: 'owner',
  projectLeadId: 'lead-1',
  stageReviewerIds: [],
};
const memberFacts: ProjectArtifactAuthorityFacts = {
  userId: 'member-1',
  teamRole: 'member',
  projectLeadId: 'lead-1',
  stageReviewerIds: [],
};
const approvedReview: ProjectArtifactReviewFact = {
  id: 'review-approved',
  versionId: 'version-1',
  decision: 'approved',
  createdAt: 10,
};
const baseFinalization = {
  teamId: 'team-1',
  channelId: 'channel-1',
  actorKind: 'human' as const,
  actorFacts: ownerFacts,
  collection: {
    id: 'collection-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    revision: 3,
  },
  expectedCollectionRevision: 3,
  targetVersion: {
    id: 'version-1',
    collectionId: 'collection-1',
    reviews: [approvedReview],
  },
};

describe('#824 版本审核状态', () => {
  test.each([
    [[], 'pending'],
    [[{ ...approvedReview, decision: 'approved' as const }], 'approved'],
    [[{ ...approvedReview, decision: 'rejected' as const }], 'rejected'],
    [[{ ...approvedReview, decision: 'changes_requested' as const }], 'changes_requested'],
  ])('按最新审核派生 %s → %s', (reviews, expected) => {
    expect(deriveProjectArtifactVersionReviewState(reviews)).toBe(expected);
  });

  test('createdAt 相同时以 id 决定最新一条', () => {
    expect(deriveProjectArtifactVersionReviewState([
      { ...approvedReview, id: 'review-a', decision: 'approved' },
      { ...approvedReview, id: 'review-b', decision: 'changes_requested' },
    ])).toBe('changes_requested');
  });
});

describe('#824 审核授权', () => {
  test.each([
    ['owner', ownerFacts],
    ['admin', { ...ownerFacts, userId: 'admin-1', teamRole: 'admin' as const }],
    ['项目负责人', { ...memberFacts, userId: 'lead-1' }],
    ['Stage reviewer', { ...memberFacts, stageReviewerIds: ['member-1'] }],
  ])('%s 可以审核', (_label, facts) => {
    expect(evaluateArtifactReviewAuthority({
      actorKind: 'human',
      facts,
      decision: 'approved',
    })).toEqual({ kind: 'allowed' });
  });

  test.each([
    ['agent', 'actor_not_human'],
    ['pi_manager', 'actor_not_human'],
  ] as const)('%s 不能提交审核', (actorKind, reasonCode) => {
    expect(evaluateArtifactReviewAuthority({
      actorKind,
      facts: ownerFacts,
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode });
  });

  test('普通成员的编辑权限不隐含审核权限', () => {
    expect(evaluateArtifactReviewAuthority({
      actorKind: 'human',
      facts: memberFacts,
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
  });

  test('运行时非法 decision 被拒绝', () => {
    expect(evaluateArtifactReviewAuthority({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'invalid' as 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'invalid_decision' });
  });
});

describe('#824 最终版策略', () => {
  test('首次最终化记录明确的 approved 审核依据', () => {
    expect(evaluateProjectArtifactFinalization(baseFinalization)).toEqual({
      kind: 'finalize',
      collectionId: 'collection-1',
      versionId: 'version-1',
      basisReviewId: 'review-approved',
      collectionRevision: 4,
    });
  });

  test('切换最终版记录 previousVersionId', () => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      collection: { ...baseFinalization.collection, finalVersionId: 'version-old' },
    })).toMatchObject({
      kind: 'finalize',
      previousVersionId: 'version-old',
      versionId: 'version-1',
    });
  });

  test('目标已是最终版时回放且不受 revision fence 影响', () => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      expectedCollectionRevision: 1,
      collection: { ...baseFinalization.collection, finalVersionId: 'version-1' },
    })).toEqual({
      kind: 'replay_current_final',
      collectionId: 'collection-1',
      versionId: 'version-1',
    });
  });

  test.each([
    ['无审核', [], 'version_not_approved'],
    ['最新 rejected', [{ ...approvedReview }, {
      ...approvedReview,
      id: 'review-rejected',
      decision: 'rejected' as const,
      createdAt: 11,
    }], 'version_not_approved'],
    ['最新 changes_requested', [{ ...approvedReview }, {
      ...approvedReview,
      id: 'review-changes',
      decision: 'changes_requested' as const,
      createdAt: 11,
    }], 'version_not_approved'],
  ])('%s 时不能最终化', (_label, reviews, reasonCode) => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      targetVersion: { ...baseFinalization.targetVersion, reviews },
    })).toEqual({ kind: 'rejected', reasonCode });
  });

  test('revision fence 陈旧时拒绝', () => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      expectedCollectionRevision: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_revision_stale' });
  });

  test.each([
    ['agent', ownerFacts, 'actor_not_human'],
    ['human', memberFacts, 'actor_not_authorized'],
  ] as const)('%s 无权最终化', (actorKind, actorFacts, reasonCode) => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      actorKind,
      actorFacts,
    })).toEqual({ kind: 'rejected', reasonCode });
  });

  test('Manager 缺少确认或确认人无权限时 fail closed', () => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      actorKind: 'pi_manager',
    })).toEqual({ kind: 'rejected', reasonCode: 'manager_confirmation_missing' });

    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      actorKind: 'pi_manager',
      humanConfirmation: {
        confirmedBy: 'member-1',
        confirmerFacts: memberFacts,
      },
    })).toEqual({ kind: 'rejected', reasonCode: 'manager_confirmation_unauthorized' });
  });

  test.each([
    ['集合缺失', { collection: null }, 'collection_not_found'],
    ['集合跨作用域', {
      collection: { ...baseFinalization.collection, channelId: 'channel-2' },
    }, 'collection_out_of_scope'],
    ['版本不属于集合', {
      targetVersion: { ...baseFinalization.targetVersion, collectionId: 'collection-2' },
    }, 'version_not_in_collection'],
  ])('%s 时拒绝', (_label, override, reasonCode) => {
    expect(evaluateProjectArtifactFinalization({
      ...baseFinalization,
      ...override,
    })).toEqual({ kind: 'rejected', reasonCode });
  });
});

describe('#824 决定权限谓词', () => {
  test('owner/admin/项目负责人/Stage reviewer 有权，普通成员与非成员无权', () => {
    expect(hasProjectArtifactDecisionAuthority(ownerFacts)).toBe(true);
    expect(hasProjectArtifactDecisionAuthority({ ...ownerFacts, teamRole: 'admin' })).toBe(true);
    expect(hasProjectArtifactDecisionAuthority({ ...memberFacts, userId: 'lead-1' })).toBe(true);
    expect(hasProjectArtifactDecisionAuthority({
      ...memberFacts,
      stageReviewerIds: ['member-1'],
    })).toBe(true);
    expect(hasProjectArtifactDecisionAuthority(memberFacts)).toBe(false);
    expect(hasProjectArtifactDecisionAuthority({ ...memberFacts, teamRole: null })).toBe(false);
  });
});
