import { describe, expect, test } from 'vitest';
import {
  evaluatePackageArtifactReviewAuthority,
  evaluatePackageBatchArtifactReview,
  evaluatePackageReviewAndFinalize,
  evaluatePackageReviewAndRejectDelivery,
  evaluateRootHumanReviewAuthority,
  evaluateSubtaskHumanAcceptanceAuthority,
  mapPackageReviewRejection,
  type PackageArtifactReviewFacts,
} from '../src/package-review-policy.js';

const ownerActorFacts = {
  userId: 'user-owner', teamRole: 'owner' as const, projectLeadId: 'user-lead', stageReviewerIds: [] as string[],
};

function batchInput() {
  return {
    actorKind: 'human' as const,
    teamId: 'team-1',
    channelId: 'ch-1',
    package: {
      id: 'pkg-1', teamId: 'team-1', channelId: 'ch-1', deliveryId: 'delivery-1', revision: 1,
      members: [
        { collectionId: 'col-1', artifactVersionId: 'delivered-1' },
        { collectionId: 'col-2', artifactVersionId: 'delivered-2' },
      ],
    },
    deliveryId: 'delivery-1',
    expectedPackageRevision: 1,
    decision: 'approved' as const,
    targets: [
      { collectionId: 'col-1', artifactVersionId: 'current-1', versionCollectionId: 'col-1', currentVersionId: 'current-1', actorFacts: ownerActorFacts },
      { collectionId: 'col-2', artifactVersionId: 'current-2', versionCollectionId: 'col-2', currentVersionId: 'current-2', actorFacts: ownerActorFacts },
    ],
  };
}

const ownerFacts: PackageArtifactReviewFacts = {
  teamId: 'team-1',
  channelId: 'ch-1',
  actorFacts: {
    userId: 'user-owner',
    teamRole: 'owner',
    projectLeadId: 'user-lead',
    stageReviewerIds: ['user-reviewer'],
  },
  package: {
    id: 'pkg-1',
    teamId: 'team-1',
    channelId: 'ch-1',
    members: [
      { collectionId: 'col-1', artifactVersionId: 'ver-1' },
      { collectionId: 'col-2', artifactVersionId: 'ver-3' },
    ],
  },
  versionScope: { collectionId: 'col-1', versionId: 'ver-1', versionCollectionId: 'col-1' },
};

describe('evaluatePackageArtifactReviewAuthority (#1061 AC1/AC2)', () => {
  test('owner/admin/projectLead/stageReviewer 可审核,authority basis 正确', () => {
    const cases: Array<[typeof ownerFacts['actorFacts'], string]> = [
      [{ userId: 'user-owner', teamRole: 'owner', projectLeadId: 'user-lead', stageReviewerIds: ['user-reviewer'] }, 'team-owner'],
      [{ userId: 'user-admin', teamRole: 'admin', projectLeadId: 'user-lead', stageReviewerIds: [] }, 'team-admin'],
      [{ userId: 'user-lead', teamRole: 'member', projectLeadId: 'user-lead', stageReviewerIds: [] }, 'project-lead'],
      [{ userId: 'user-reviewer', teamRole: 'member', projectLeadId: 'user-lead', stageReviewerIds: ['user-reviewer'] }, 'stage-reviewer-delegation'],
    ];
    for (const [actorFacts, basis] of cases) {
      const decision = evaluatePackageArtifactReviewAuthority({
        actorKind: 'human',
        facts: { ...ownerFacts, actorFacts },
        decision: 'approved',
      });
      expect(decision).toEqual({ kind: 'allowed', authorityBasis: basis });
    }
  });

  test('AC2:普通成员 / 建议审核人 / Task assignee / Agent / PI Manager 均无审核权', () => {
    // 普通成员(非 stage reviewer、非 lead、非 owner/admin)。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        actorFacts: { userId: 'user-member', teamRole: 'member', projectLeadId: 'user-lead', stageReviewerIds: [] },
      },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
    // 建议审核人(不在 stageReviewerIds,只是频道成员)。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        actorFacts: { userId: 'user-suggested', teamRole: 'member', projectLeadId: 'user-lead', stageReviewerIds: [] },
      },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
    // Agent 一律拒绝。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'agent',
      facts: ownerFacts,
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_human' });
    // PI Manager 拒绝(只能代表人类最终化,#824 同款)。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'pi_manager',
      facts: ownerFacts,
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_human' });
  });

  test('AC1:version 必须是 package 冻结成员且属于声明的 collection', () => {
    // 版本不在 package 成员。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: { ...ownerFacts, versionScope: { collectionId: 'col-9', versionId: 'ver-9' } },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'version_not_in_package' });
    // 成员集合人工/Agent 修订后的 current 版本可继续从原 package 入口审核。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        versionScope: {
          collectionId: 'col-1',
          versionId: 'ver-2',
          versionCollectionId: 'col-1',
          currentVersionId: 'ver-2',
        },
      },
      decision: 'approved',
    })).toEqual({ kind: 'allowed', authorityBasis: 'team-owner' });
    // 同集合的任意历史版本仍不能借 package 入口取得审核作用域。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        versionScope: {
          collectionId: 'col-1',
          versionId: 'ver-history',
          versionCollectionId: 'col-1',
          currentVersionId: 'ver-2',
        },
      },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'version_not_in_package' });
    // 版本属于 package 成员 collection 但不是交付版本(成员锚定的是 ver-1,传 ver-2)。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: { ...ownerFacts, versionScope: { collectionId: 'col-1', versionId: 'ver-2' } },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'version_not_in_package' });
    // 声明 collection 与实际版本所属 collection 不一致。
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        versionScope: { collectionId: 'col-1', versionId: 'ver-1', versionCollectionId: 'col-2' },
      },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'version_not_in_collection' });
  });

  test('package 不存在 / 跨作用域 / 非法决策', () => {
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: { ...ownerFacts, package: null },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'package_not_found' });
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: { ...ownerFacts, package: { ...ownerFacts.package!, teamId: 'team-2' } },
      decision: 'approved',
    })).toEqual({ kind: 'rejected', reasonCode: 'package_out_of_scope' });
    expect(evaluatePackageArtifactReviewAuthority({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'pass',
    })).toEqual({ kind: 'rejected', reasonCode: 'invalid_decision' });
  });
});

describe('authority token (#1061 AC3/AC4)', () => {
  test('AC3:子 Task 人类验收须命中创建时预绑定 ids;未绑定 fail closed', () => {
    expect(evaluateSubtaskHumanAcceptanceAuthority({
      actorId: 'user-approver',
      preboundAuthorityIds: ['user-approver'],
    })).toEqual({ kind: 'allowed' });
    expect(evaluateSubtaskHumanAcceptanceAuthority({
      actorId: 'user-other',
      preboundAuthorityIds: ['user-approver'],
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
    // 未预绑定(存量 coordination)→ 人类不得验收。
    expect(evaluateSubtaskHumanAcceptanceAuthority({
      actorId: 'user-approver',
      preboundAuthorityIds: [],
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
  });

  test('AC4:根 Task Human review authority 接受才 done;未绑定无人可验收', () => {
    expect(evaluateRootHumanReviewAuthority({
      actorId: 'user-requester',
      preboundAuthorityIds: ['user-requester'],
    })).toEqual({ kind: 'allowed' });
    expect(evaluateRootHumanReviewAuthority({
      actorId: 'user-owner',
      preboundAuthorityIds: ['user-requester'],
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
    expect(evaluateRootHumanReviewAuthority({
      actorId: 'user-requester',
      preboundAuthorityIds: [],
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
  });
});

describe('evaluatePackageBatchArtifactReview (#1199)', () => {
  test('全部目标为当前版本且逐目标 authority 成立时返回 N 个写入计划', () => {
    const result = evaluatePackageBatchArtifactReview(batchInput());
    expect(result.kind).toBe('allowed');
    if (result.kind === 'allowed') {
      expect(result.targets).toHaveLength(2);
      expect(result.targets.map((target) => target.authorityBasis)).toEqual(['team-owner', 'team-owner']);
    }
  });

  test('任一 stale、无权限或重复目标时整批 rejected 并逐项列出原因', () => {
    const base = batchInput();
    const result = evaluatePackageBatchArtifactReview({
      ...base,
      targets: [
        { ...base.targets[0]!, currentVersionId: 'newer-1' },
        { ...base.targets[1]!, actorFacts: { ...ownerActorFacts, teamRole: 'member' as const } },
        base.targets[1]!,
      ],
    });
    expect(result).toEqual({
      kind: 'rejected',
      failures: [
        { collectionId: 'col-1', artifactVersionId: 'current-1', reasonCode: 'version_not_current' },
        { collectionId: 'col-2', artifactVersionId: 'current-2', reasonCode: 'actor_not_authorized' },
        { collectionId: 'col-2', artifactVersionId: 'current-2', reasonCode: 'duplicate_target' },
      ],
    });
  });

  test('delivery 与 package revision fence 漂移时 fail closed', () => {
    expect(evaluatePackageBatchArtifactReview({ ...batchInput(), deliveryId: 'delivery-old' })).toEqual({
      kind: 'rejected', failures: [{ reasonCode: 'delivery_revision_stale' }],
    });
    expect(evaluatePackageBatchArtifactReview({ ...batchInput(), expectedPackageRevision: 2 })).toEqual({
      kind: 'rejected', failures: [{ reasonCode: 'package_revision_stale' }],
    });
  });
});

describe('evaluatePackageReviewAndFinalize (#1061 AC9)', () => {
  test('同一操作者双 authority + revision fence 通过 → finalize', () => {
    const decision = evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'approved',
      collection: { id: 'col-1', teamId: 'team-1', channelId: 'ch-1', revision: 2 },
      expectedCollectionRevision: 2,
    });
    expect(decision).toEqual({ kind: 'finalize' });
  });

  test('review authority 失败(普通成员)→ rejected', () => {
    expect(evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        actorFacts: { userId: 'user-member', teamRole: 'member', projectLeadId: 'user-lead', stageReviewerIds: [] },
      },
      decision: 'approved',
      collection: { id: 'col-1', teamId: 'team-1', channelId: 'ch-1', revision: 2 },
      expectedCollectionRevision: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'actor_not_authorized' });
  });

  test('stage reviewer 按 #824 合同同时持有双 authority(同源) → finalize', () => {
    // #824 的 review 与 finalization 共用 hasProjectArtifactDecisionAuthority:
    // stage reviewer 通过 review 判定即同时满足 finalization authority(AC9 同操作者双权)。
    expect(evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: {
        ...ownerFacts,
        actorFacts: { userId: 'user-only-review', teamRole: 'member', projectLeadId: 'user-lead', stageReviewerIds: ['user-only-review'] },
      },
      decision: 'approved',
      collection: { id: 'col-1', teamId: 'team-1', channelId: 'ch-1', revision: 2 },
      expectedCollectionRevision: 2,
    })).toEqual({ kind: 'finalize' });
  });

  test('collection revision stale / 集合不存在 / 跨作用域 → rejected', () => {
    expect(evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'approved',
      collection: { id: 'col-1', teamId: 'team-1', channelId: 'ch-1', revision: 3 },
      expectedCollectionRevision: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_revision_stale' });
    expect(evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'approved',
      collection: null,
      expectedCollectionRevision: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_not_found' });
    expect(evaluatePackageReviewAndFinalize({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'approved',
      collection: { id: 'col-1', teamId: 'team-2', channelId: 'ch-1', revision: 2 },
      expectedCollectionRevision: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_out_of_scope' });
  });
});

describe('evaluatePackageReviewAndRejectDelivery (#1061 AC6)', () => {
  const task = {
    id: 'task-1',
    teamId: 'team-1',
    channelId: 'ch-1',
    revision: 3,
    nodeKind: 'subtask' as const,
    attempt: 2,
    status: 'in_review',
  };

  test('changes_requested/rejected + 当前 revision/attempt/delivery in_review → reject-delivery', () => {
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'changes_requested',
      task,
      expectedTaskRevision: 3,
      expectedTaskAttempt: 2,
    })).toEqual({ kind: 'reject-delivery' });
  });

  test('approved 不能组合退回(review-required-before-reject)', () => {
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'approved',
      task,
      expectedTaskRevision: 3,
      expectedTaskAttempt: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'review_required_before_reject' });
  });

  test('Task revision / attempt 漂移 → rejected', () => {
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'rejected',
      task,
      expectedTaskRevision: 2,
      expectedTaskAttempt: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'task_revision_stale' });
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'rejected',
      task,
      expectedTaskRevision: 3,
      expectedTaskAttempt: 1,
    })).toEqual({ kind: 'rejected', reasonCode: 'task_attempt_stale' });
    // 子 Task 必须显式携带 attempt。
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'rejected',
      task,
      expectedTaskRevision: 3,
    })).toEqual({ kind: 'rejected', reasonCode: 'task_attempt_stale' });
  });

  test('Task 不在 in_review / 无 managed Task 绑定 / 跨作用域 → rejected', () => {
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'rejected',
      task: { ...task, status: 'in_progress' },
      expectedTaskRevision: 3,
      expectedTaskAttempt: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'delivery_not_reviewable' });
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'rejected',
      task: null,
      expectedTaskRevision: 3,
      expectedTaskAttempt: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'delivery_not_found' });
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'rejected',
      task: { ...task, teamId: 'team-2' },
      expectedTaskRevision: 3,
      expectedTaskAttempt: 2,
    })).toEqual({ kind: 'rejected', reasonCode: 'delivery_out_of_scope' });
  });

  test('根 Task 不校验 attempt', () => {
    expect(evaluatePackageReviewAndRejectDelivery({
      actorKind: 'human',
      facts: ownerFacts,
      decision: 'changes_requested',
      task: { ...task, nodeKind: 'root', status: 'in_review' },
      expectedTaskRevision: 3,
    })).toEqual({ kind: 'reject-delivery' });
  });
});

describe('mapPackageReviewRejection', () => {
  test('domain 码 → contracts 公开码', () => {
    expect(mapPackageReviewRejection('actor_not_authorized')).toBe('actor-not-authorized');
    expect(mapPackageReviewRejection('version_not_in_package')).toBe('version-not-in-package');
    expect(mapPackageReviewRejection('collection_revision_stale')).toBe('collection-revision-stale');
    expect(mapPackageReviewRejection('review_required_before_reject')).toBe('review-required-before-reject');
    // 未知码 fallback。
    expect(mapPackageReviewRejection('unknown_code' as never)).toBe('invalid-request');
  });
});
