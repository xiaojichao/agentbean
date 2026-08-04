import { describe, expect, test } from 'vitest';

import {
  resolveOutputPackageProjection,
  type OutputPackageProjectionCollectionFact,
  type OutputPackageProjectionMemberFact,
  type OutputPackageProjectionVersionFact,
} from '../src/output-package-projection-policy.js';
import type { ProjectArtifactVersionReviewState } from '@agentbean/contracts';

const member = (
  sequence: number,
  overrides: Partial<OutputPackageProjectionMemberFact> = {},
): OutputPackageProjectionMemberFact => ({
  sequence,
  shortLabel: `F${sequence}`,
  collectionId: `col-${sequence}`,
  deliveredVersionId: `ver-${sequence}-delivered`,
  requiredForFinal: true,
  filename: `file-${sequence}.md`,
  ...overrides,
});

const collection = (
  id: string,
  overrides: Partial<OutputPackageProjectionCollectionFact> = {},
): OutputPackageProjectionCollectionFact => ({
  id,
  revision: 2,
  currentVersionId: `${id}-current`,
  ...overrides,
});

const version = (
  id: string,
  collectionId: string,
  overrides: Partial<OutputPackageProjectionVersionFact> = {},
): OutputPackageProjectionVersionFact => ({
  id,
  collectionId,
  versionNumber: 1,
  artifactId: `art-${id}`,
  filename: `${id}.md`,
  visible: true,
  ...overrides,
});

const noReviews: ReadonlyMap<string, ProjectArtifactVersionReviewState> = new Map();

describe('#1063 resolveOutputPackageProjection', () => {
  test('delivered:还原 package 创建时冻结版本,不读 collection 指针', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1), member(2)],
      collections: [
        collection('col-1', { currentVersionId: 'ver-1-moved', revision: 5 }),
        collection('col-2'),
      ],
      versions: [
        version('ver-1-delivered', 'col-1', { versionNumber: 1 }),
        version('ver-1-moved', 'col-1', { versionNumber: 3 }),
        version('ver-2-delivered', 'col-2'),
      ],
      reviewStateByVersionId: noReviews,
      policy: 'delivered',
    });
    expect(resolution.status).toBe('ready');
    expect(resolution.members.map((entry) => entry.versionId)).toEqual([
      'ver-1-delivered', 'ver-2-delivered',
    ]);
    // delivered 还原不受 current 移动影响。
    expect(resolution.members[0]).toMatchObject({ versionNumber: 1, collectionRevision: 5 });
  });

  test('current:逐成员解析 currentVersionId;rejected/changes_requested 构成 current_not_formal 阻断', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1), member(2)],
      collections: [collection('col-1'), collection('col-2')],
      versions: [version('col-1-current', 'col-1'), version('col-2-current', 'col-2')],
      reviewStateByVersionId: new Map([
        ['col-1-current', 'approved'],
        ['col-2-current', 'rejected'],
      ]),
      policy: 'current',
    });
    expect(resolution.status).toBe('not_ready');
    // 可解析部分仍携带(供 UI 展示),但阻断清单把 F2 排除出默认正式输入。
    expect(resolution.members).toHaveLength(2);
    expect(resolution.blockers).toEqual([{
      code: 'current_not_formal',
      collectionId: 'col-2',
      shortLabel: 'F2',
      filename: 'file-2.md',
    }]);
  });

  test('current:pending/approved 不构成阻断', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1), member(2)],
      collections: [collection('col-1'), collection('col-2')],
      versions: [version('col-1-current', 'col-1'), version('col-2-current', 'col-2')],
      reviewStateByVersionId: new Map([['col-1-current', 'changes_requested']]),
      policy: 'current',
    });
    // changes_requested 同样阻断(AC4)。
    expect(resolution.status).toBe('not_ready');
    expect(resolution.blockers.map((b) => b.code)).toEqual(['current_not_formal']);
    expect(resolution.blockers[0]!.collectionId).toBe('col-1');
  });

  test('final:必需成员缺 finalVersionId 时整体 not_ready 并列出缺失项', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1), member(2)],
      collections: [
        collection('col-1', { finalVersionId: 'col-1-current' }),
        collection('col-2'),
      ],
      versions: [version('col-1-current', 'col-1'), version('col-2-current', 'col-2')],
      reviewStateByVersionId: noReviews,
      policy: 'final',
    });
    expect(resolution.status).toBe('not_ready');
    expect(resolution.blockers).toEqual([{
      code: 'missing_final',
      collectionId: 'col-2',
      shortLabel: 'F2',
      filename: 'file-2.md',
    }]);
    // 已有 final 的成员仍解析出来供展示。
    expect(resolution.members.map((entry) => entry.versionId)).toEqual(['col-1-current']);
    expect(resolution.members[0]).toMatchObject({ isFinalVersion: true });
  });

  test('final:非必需成员无 final 时明确省略,绝不以 current 补齐', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1), member(2, { requiredForFinal: false })],
      collections: [
        collection('col-1', { finalVersionId: 'col-1-current' }),
        collection('col-2'), // 无 final
      ],
      versions: [version('col-1-current', 'col-1'), version('col-2-current', 'col-2')],
      reviewStateByVersionId: noReviews,
      policy: 'final',
    });
    expect(resolution.status).toBe('ready');
    expect(resolution.members.map((entry) => entry.versionId)).toEqual(['col-1-current']);
    expect(resolution.omitted).toEqual([{
      collectionId: 'col-2',
      shortLabel: 'F2',
      filename: 'file-2.md',
      reason: 'final_not_required',
    }]);
    // 绝不出现 col-2 的 current 版本。
    expect(resolution.members.some((entry) => entry.collectionId === 'col-2')).toBe(false);
  });

  test('specified:逐项校验成员归属,非成员 collection 构成 version_not_in_package', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1)],
      collections: [collection('col-1')],
      versions: [version('ver-1-delivered', 'col-1'), version('ver-x', 'col-x')],
      reviewStateByVersionId: noReviews,
      policy: 'specified',
      specifiedVersions: [
        { collectionId: 'col-1', versionId: 'ver-1-delivered' },
        { collectionId: 'col-x', versionId: 'ver-x' },
      ],
    });
    expect(resolution.status).toBe('not_ready');
    expect(resolution.members.map((entry) => entry.versionId)).toEqual(['ver-1-delivered']);
    expect(resolution.blockers).toEqual([{
      code: 'version_not_in_package',
      collectionId: 'col-x',
      versionId: 'ver-x',
    }]);
  });

  test('specified:显式选择 rejected 版本不构成阻断(AC4 “基于此修改”)', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1)],
      collections: [collection('col-1', { currentVersionId: 'ver-1-delivered' })],
      versions: [version('ver-1-delivered', 'col-1')],
      reviewStateByVersionId: new Map([['ver-1-delivered', 'rejected']]),
      policy: 'specified',
      specifiedVersions: [{ collectionId: 'col-1', versionId: 'ver-1-delivered' }],
    });
    expect(resolution.status).toBe('ready');
    expect(resolution.members[0]).toMatchObject({ versionId: 'ver-1-delivered', reviewState: 'rejected' });
  });

  test('不可见版本按 collection_unavailable 阻断(权限变化即时生效)', () => {
    const resolution = resolveOutputPackageProjection({
      members: [member(1)],
      collections: [collection('col-1')],
      versions: [version('col-1-current', 'col-1', { visible: false })],
      reviewStateByVersionId: noReviews,
      policy: 'current',
    });
    expect(resolution.status).toBe('not_ready');
    expect(resolution.blockers.map((b) => b.code)).toEqual(['collection_unavailable']);
  });
});
