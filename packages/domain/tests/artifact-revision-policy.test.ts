import { describe, expect, test } from 'vitest';
import {
  evaluateArtifactVersionRevision,
  type ArtifactVersionRevisionFacts,
} from '../src/artifact-revision-policy.js';

/**
 * #1062 domain 判定矩阵:修订保存的 authority/scope/fence/basis 全部由 Server 加载事实 +
 * 纯函数判定;applied 计划只含 Server 推导的继承来源与 lineage(不信客户端自报)。
 */

const baseFacts: ArtifactVersionRevisionFacts = {
  teamId: 'team-1',
  channelId: 'ch-1',
  channelArchived: false,
  editingEnabled: true,
  actorKind: 'human',
  actorCanViewChannel: true,
  collection: {
    id: 'col-1',
    teamId: 'team-1',
    channelId: 'ch-1',
    revision: 3,
    currentVersionId: 'ver-1',
    finalVersionId: 'ver-0',
    latestVersionNumber: 2,
  },
  baseVersion: {
    id: 'ver-1',
    collectionId: 'col-1',
    versionNumber: 2,
    isMarkdown: true,
    source: {
      stageId: 'stage-1',
      taskId: 'task-1',
      taskRevision: 2,
      messageId: 'msg-1',
      workspaceRunId: 'run-1',
      invocationId: 'inv-1',
    },
  },
  sourceVersion: {
    id: 'ver-1',
    collectionId: 'col-1',
    source: {
      stageId: 'stage-1',
      taskId: 'task-1',
      taskRevision: 2,
      messageId: 'msg-1',
      workspaceRunId: 'run-1',
      invocationId: 'inv-1',
    },
  },
  basisReview: {
    id: 'rev-1',
    versionId: 'ver-1',
    decision: 'changes_requested',
  },
  sourceVersionLatestReviewId: 'rev-1',
  basisPackage: {
    id: 'pkg-1',
    deliveryId: 'del-1',
    members: [{ collectionId: 'col-1', artifactVersionId: 'ver-1' }],
  },
};

const validInput = {
  collectionId: 'col-1',
  baseVersionId: 'ver-1',
  expectedCollectionRevision: 3,
  revisionBasis: {
    sourceVersionId: 'ver-1',
    basisReviewId: 'rev-1',
    packageId: 'pkg-1',
    deliveryId: 'del-1',
  },
} as const;

describe('evaluateArtifactVersionRevision (#1062)', () => {
  test('applied:完整 basis + 双 fence 通过 → 计划含继承 source 与 lineage', () => {
    const decision = evaluateArtifactVersionRevision({ facts: baseFacts, input: validInput });
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') return;
    expect(decision.plan.collectionId).toBe('col-1');
    expect(decision.plan.baseVersionId).toBe('ver-1');
    expect(decision.plan.sourceVersionId).toBe('ver-1');
    expect(decision.plan.basisReviewId).toBe('rev-1');
    expect(decision.plan.packageId).toBe('pkg-1');
    expect(decision.plan.deliveryId).toBe('del-1');
    // AC3:lineage 保留旧 version;继承 source 来自 Server 持久化事实而非客户端。
    expect(decision.plan.lineage).toEqual([{ kind: 'project_version', refId: 'ver-1' }]);
    expect(decision.plan.inheritedSource).toEqual({
      stageId: 'stage-1',
      taskId: 'task-1',
      taskRevision: 2,
      messageId: 'msg-1',
      workspaceRunId: 'run-1',
      invocationId: 'inv-1',
    });
    expect(decision.plan.nextVersionNumber).toBe(3);
    expect(decision.plan.nextCollectionRevision).toBe(4);
  });

  test('applied:最小 basis(仅 sourceVersionId);base≠source 时 lineage 含两者', () => {
    const facts: ArtifactVersionRevisionFacts = {
      ...baseFacts,
      sourceVersion: {
        id: 'ver-0',
        collectionId: 'col-1',
        source: { taskId: 'task-1', taskRevision: 1 },
      },
      basisReview: null,
      sourceVersionLatestReviewId: null,
      basisPackage: null,
    };
    const decision = evaluateArtifactVersionRevision({
      facts,
      input: {
        collectionId: 'col-1',
        baseVersionId: 'ver-1',
        expectedCollectionRevision: 3,
        revisionBasis: { sourceVersionId: 'ver-0' },
      },
    });
    expect(decision.kind).toBe('applied');
    if (decision.kind !== 'applied') return;
    expect(decision.plan.lineage).toEqual([
      { kind: 'project_version', refId: 'ver-0' },
      { kind: 'project_version', refId: 'ver-1' },
    ]);
    // 继承来源来自 sourceVersion(用户明确基于的那个版本)。
    expect(decision.plan.inheritedSource).toEqual({ taskId: 'task-1', taskRevision: 1 });
    expect(decision.plan.basisReviewId).toBeUndefined();
    expect(decision.plan.packageId).toBeUndefined();
  });

  test('rejected:编辑未启用 / 频道归档 / 非人类或非频道成员', () => {
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, editingEnabled: false }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-editing-disabled' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, channelArchived: true }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'channel-archived' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, actorKind: 'agent' }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'actor-not-authorized' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, actorKind: 'pi_manager' }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'actor-not-authorized' });
    // AC8:权限撤销 fail closed。
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, actorCanViewChannel: false }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'actor-not-authorized' });
  });

  test('rejected:collection 不存在或跨频道 / version 不属于 collection / 非 Markdown', () => {
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, collection: null }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection-not-found' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, collection: { ...baseFacts.collection!, channelId: 'ch-2' } }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection-not-found' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, baseVersion: null }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'version-not-in-collection' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, baseVersion: { ...baseFacts.baseVersion!, collectionId: 'col-9' } },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'version-not-in-collection' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, sourceVersion: null }, input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'version-not-in-collection' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, baseVersion: { ...baseFacts.baseVersion!, isMarkdown: false } },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'not-markdown-version' });
  });

  test('rejected:basis review 不属于 sourceVersion 或 decision 非否定结论', () => {
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, basisReview: { id: 'rev-1', versionId: 'ver-other', decision: 'rejected' } },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, basisReview: { id: 'rev-1', versionId: 'ver-1', decision: 'approved' } },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
    // 声称的 review 根本不存在。
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, basisReview: null, sourceVersionLatestReviewId: null },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
  });

  test('rejected:package/delivery 与 sourceVersion 冻结成员身份对不上', () => {
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, basisPackage: null },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
    expect(evaluateArtifactVersionRevision({
      facts: { ...baseFacts, basisPackage: { ...baseFacts.basisPackage!, deliveryId: 'del-9' } },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
    expect(evaluateArtifactVersionRevision({
      facts: {
        ...baseFacts,
        basisPackage: {
          ...baseFacts.basisPackage!,
          members: [{ collectionId: 'col-1', artifactVersionId: 'ver-9' }],
        },
      },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
    // packageId 提供但 deliveryId 缺省 → 无法冻结 delivery 依据,拒绝(不静默降级)。
    expect(evaluateArtifactVersionRevision({
      facts: baseFacts,
      input: { ...validInput, revisionBasis: { ...validInput.revisionBasis, deliveryId: undefined } },
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
  });

  test('conflict:base 已非 current → base-version-stale', () => {
    const decision = evaluateArtifactVersionRevision({
      facts: { ...baseFacts, collection: { ...baseFacts.collection!, currentVersionId: 'ver-2' } },
      input: validInput,
    });
    expect(decision).toEqual({ kind: 'conflict', code: 'base-version-stale' });
  });

  test('conflict:collection revision 漂移(并发 append/finalization)→ collection-revision-stale', () => {
    const decision = evaluateArtifactVersionRevision({
      facts: { ...baseFacts, collection: { ...baseFacts.collection!, revision: 4 } },
      input: validInput,
    });
    expect(decision).toEqual({ kind: 'conflict', code: 'collection-revision-stale' });
  });

  test('conflict:basis review 已被更新审核取代 → revision-basis-stale', () => {
    const decision = evaluateArtifactVersionRevision({
      facts: { ...baseFacts, sourceVersionLatestReviewId: 'rev-2' },
      input: validInput,
    });
    expect(decision).toEqual({ kind: 'conflict', code: 'revision-basis-stale' });
  });

  test('conflict 优先级:base fence 先于 collection fence;basis 校验先于 fence(防止用错误 basis 试 fence)', () => {
    expect(evaluateArtifactVersionRevision({
      facts: {
        ...baseFacts,
        collection: { ...baseFacts.collection!, currentVersionId: 'ver-2', revision: 9 },
      },
      input: validInput,
    })).toEqual({ kind: 'conflict', code: 'base-version-stale' });
    // basis mismatch(rejected)先于 fence conflict。
    expect(evaluateArtifactVersionRevision({
      facts: {
        ...baseFacts,
        basisReview: null,
        sourceVersionLatestReviewId: null,
        collection: { ...baseFacts.collection!, currentVersionId: 'ver-2' },
      },
      input: validInput,
    })).toEqual({ kind: 'rejected', reasonCode: 'revision-basis-mismatch' });
  });
});
