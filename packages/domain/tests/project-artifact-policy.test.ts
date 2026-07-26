import { describe, expect, test } from 'vitest';

import {
  evaluateArtifactPromotion,
  evaluateProjectArtifactLineage,
} from '../src/project-artifact-policy.js';

const scope = { teamId: 'team-1', channelId: 'channel-1' };

describe('#823 Artifact 提升决策', () => {
  test('无既有版本且未指定集合时创建集合并生成首版', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionName: '主视觉',
      existingCollectionNames: ['分镜'],
    })).toEqual({ kind: 'create_collection', versionNumber: 1, collectionRevision: 1 });
  });

  test('集合名称已存在时拒绝，稳定身份不被重复占用', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionName: '分镜',
      existingCollectionNames: ['分镜'],
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_name_conflict' });
  });

  test('追加到既有集合时版本序号与 collection revision 同时递增', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionId: 'collection-1',
      expectedCollectionRevision: 3,
      targetCollection: {
        id: 'collection-1',
        ...scope,
        name: '分镜',
        revision: 3,
        versionCount: 2,
      },
    })).toEqual({
      kind: 'append_version',
      collectionId: 'collection-1',
      versionNumber: 3,
      collectionRevision: 4,
    });
  });

  test('revision fence 陈旧时拒绝写入', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionId: 'collection-1',
      expectedCollectionRevision: 2,
      targetCollection: {
        id: 'collection-1',
        ...scope,
        name: '分镜',
        revision: 3,
        versionCount: 2,
      },
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_revision_stale' });
  });

  test('跨 Channel 集合被拒绝', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionId: 'collection-1',
      expectedCollectionRevision: 1,
      targetCollection: {
        id: 'collection-1',
        teamId: 'team-1',
        channelId: 'channel-2',
        name: '分镜',
        revision: 1,
        versionCount: 1,
      },
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_out_of_scope' });
  });

  test('目标集合不存在时拒绝', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionId: 'collection-1',
      expectedCollectionRevision: 1,
      targetCollection: null,
    })).toEqual({ kind: 'rejected', reasonCode: 'collection_not_found' });
  });

  test.each([
    ['未指定集合的重试', undefined],
    ['指定同一集合的重试', 'collection-1'],
  ])('同一 Artifact 的%s回放既有版本而不新增', (_label, requestedCollectionId) => {
    expect(evaluateArtifactPromotion({
      ...scope,
      ...(requestedCollectionId ? { requestedCollectionId, expectedCollectionRevision: 1 } : {}),
      existingVersionForArtifact: { id: 'version-1', collectionId: 'collection-1' },
    })).toEqual({
      kind: 'replay_existing_version',
      collectionId: 'collection-1',
      versionId: 'version-1',
    });
  });

  test('已提升的 Artifact 被指向另一个集合时拒绝', () => {
    expect(evaluateArtifactPromotion({
      ...scope,
      requestedCollectionId: 'collection-2',
      expectedCollectionRevision: 1,
      existingVersionForArtifact: { id: 'version-1', collectionId: 'collection-1' },
    })).toEqual({ kind: 'rejected', reasonCode: 'artifact_promoted_to_other_collection' });
  });
});

describe('#823 lineage 作用域', () => {
  test('同频道内的版本与 Artifact 引用被保留原样', () => {
    expect(evaluateProjectArtifactLineage({
      ...scope,
      promotedArtifactId: 'artifact-new',
      candidates: [
        { kind: 'project_version', refId: 'version-1', scope },
        { kind: 'artifact', refId: 'artifact-input', scope },
      ],
    })).toEqual({
      ok: true,
      lineage: [
        { kind: 'project_version', refId: 'version-1' },
        { kind: 'artifact', refId: 'artifact-input' },
      ],
    });
  });

  test.each([
    ['跨频道引用', { kind: 'project_version' as const, refId: 'version-x', scope: { teamId: 'team-1', channelId: 'channel-2' } }, 'lineage_out_of_scope'],
    ['不可见引用', { kind: 'artifact' as const, refId: 'artifact-x', scope: null }, 'lineage_out_of_scope'],
    ['自引用', { kind: 'artifact' as const, refId: 'artifact-new', scope }, 'lineage_self_reference'],
  ])('%s被拒绝', (_label, candidate, reasonCode) => {
    expect(evaluateProjectArtifactLineage({
      ...scope,
      promotedArtifactId: 'artifact-new',
      candidates: [candidate],
    })).toEqual({ ok: false, reasonCode });
  });

  test('重复引用被拒绝', () => {
    expect(evaluateProjectArtifactLineage({
      ...scope,
      promotedArtifactId: 'artifact-new',
      candidates: [
        { kind: 'project_version', refId: 'version-1', scope },
        { kind: 'project_version', refId: 'version-1', scope },
      ],
    })).toEqual({ ok: false, reasonCode: 'lineage_duplicate' });
  });
});
