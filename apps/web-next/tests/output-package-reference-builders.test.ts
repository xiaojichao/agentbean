import { describe, expect, test, vi } from 'vitest';

/**
 * 文件包引用构建层(#1063/#1065,从 OutputPackageCard 抽取的纯函数)。
 *
 * 覆盖:
 * - loadPackageProjection:getOutputPackage(projection) 的可用性守卫(ok+projection);
 * - buildPackageProjectionSelection:ready → package_projection 选择(带
 *   expectedMemberRevisions fence,delivered 无 fence);not_ready → blockers 清单;
 * - buildPackageMembersSelection:单选/多选 → package_members;空列表 → null。
 *
 * 语义与 OutputPackageCard 原实现完全一致(纯移动,不改行为)。
 */

const mocks = vi.hoisted(() => ({
  getOutputPackage: vi.fn(),
}));

vi.mock('@/lib/socket', () => ({
  projectEvents: () => ({
    getOutputPackage: mocks.getOutputPackage,
  }),
}));

import {
  buildPackageMembersSelection,
  buildPackageProjectionSelection,
  loadPackageProjection,
} from '../lib/output-package-reference';

const readyProjection = {
  policy: 'current' as const,
  status: 'ready' as const,
  members: [
    {
      sequence: 1, shortLabel: 'F1', collectionId: 'col-1', versionId: 'ver-1',
      versionNumber: 1, artifactId: 'art-1', filename: 'ep1.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 3,
    },
    {
      sequence: 2, shortLabel: 'F2', collectionId: 'col-2', versionId: 'ver-2',
      versionNumber: 1, artifactId: 'art-2', filename: 'ep2.md',
      reviewState: 'pending' as const, isFinalVersion: false, collectionRevision: 1,
    },
  ],
  blockers: [],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

const notReadyProjection = {
  policy: 'final' as const,
  status: 'not_ready' as const,
  members: [],
  blockers: [
    { code: 'missing_final' as const, collectionId: 'col-1', shortLabel: 'F1', filename: 'ep1.md' },
    { code: 'current_not_formal' as const, collectionId: 'col-2' },
  ],
  omitted: [],
  consistencyToken: { schemaVersion: 1, entries: [] },
};

describe('loadPackageProjection', () => {
  test('ok 且带 projection 时返回解析结果块', async () => {
    mocks.getOutputPackage.mockResolvedValue({
      ok: true, projection: readyProjection, asOf: 100, audienceScope: 'team-1:channel-1:u-1',
    });
    const result = await loadPackageProjection('channel-1', 'pkg-1', 'current');
    expect(mocks.getOutputPackage).toHaveBeenCalledWith({
      channelId: 'channel-1', packageId: 'pkg-1', projection: { policy: 'current' },
    });
    expect(result).toEqual(readyProjection);
  });

  test('!ok 或缺 projection 时返回 null(调用方不产生选择、不展示阻断)', async () => {
    mocks.getOutputPackage.mockResolvedValue({ ok: false, error: 'boom' });
    expect(await loadPackageProjection('channel-1', 'pkg-1', 'current')).toBeNull();
    mocks.getOutputPackage.mockResolvedValue({ ok: true });
    expect(await loadPackageProjection('channel-1', 'pkg-1', 'final')).toBeNull();
  });
});

describe('buildPackageProjectionSelection', () => {
  test('ready + current → package_projection 选择带 expectedMemberRevisions fence', () => {
    const built = buildPackageProjectionSelection('pkg-1', 'current', readyProjection);
    expect(built.blockers).toEqual([]);
    expect(built.selection).toEqual({
      kind: 'package_projection',
      packageId: 'pkg-1',
      policy: 'current',
      expectedMemberRevisions: [
        { collectionId: 'col-1', revision: 3 },
        { collectionId: 'col-2', revision: 1 },
      ],
    });
  });

  test('ready + delivered → 选择不带 fence(delivered 是冻结事实)', () => {
    const built = buildPackageProjectionSelection('pkg-1', 'delivered', readyProjection);
    expect(built.selection).toEqual({
      kind: 'package_projection',
      packageId: 'pkg-1',
      policy: 'delivered',
    });
    expect(built.selection).not.toHaveProperty('expectedMemberRevisions');
  });

  test('not_ready → 阻断清单,不产生选择;shortLabel/filename 缺省时回落空串', () => {
    const built = buildPackageProjectionSelection('pkg-1', 'final', notReadyProjection);
    expect(built.selection).toBeUndefined();
    expect(built.blockers).toEqual([
      { shortLabel: 'F1', filename: 'ep1.md', code: 'missing_final' },
      { shortLabel: '', filename: '', code: 'current_not_formal' },
    ]);
  });
});

describe('buildPackageMembersSelection', () => {
  test('单选/多选 → package_members 显式选择(顺序按发送方给定)', () => {
    expect(buildPackageMembersSelection('pkg-1', [{ collectionId: 'col-1', versionId: 'ver-1' }]))
      .toEqual({
        kind: 'package_members', packageId: 'pkg-1',
        members: [{ collectionId: 'col-1', versionId: 'ver-1' }],
      });
    expect(buildPackageMembersSelection('pkg-1', [
      { collectionId: 'col-1', versionId: 'ver-1' },
      { collectionId: 'col-2', versionId: 'ver-2' },
    ])).toEqual({
      kind: 'package_members', packageId: 'pkg-1',
      members: [
        { collectionId: 'col-1', versionId: 'ver-1' },
        { collectionId: 'col-2', versionId: 'ver-2' },
      ],
    });
  });

  test('空成员 → null(调用方不产生选择)', () => {
    expect(buildPackageMembersSelection('pkg-1', [])).toBeNull();
  });
});
