import { describe, expect, test } from 'vitest';

import {
  evaluateSelectionEligibility,
  resolvePackageReferenceOrdinal,
  resolveReferenceOrdinal,
  type ProjectReferenceDocumentCandidate,
} from '../src/project-reference-policy.js';

const channel = {
  teamId: 'team-1',
  channelId: 'channel-1',
  archived: false,
  visible: true,
};
const scope = { teamId: 'team-1', channelId: 'channel-1' };
const document = (
  documentId: string,
  revisionId = `${documentId}-revision-1`,
  bundlePosition?: number,
): ProjectReferenceDocumentCandidate => ({
  documentId,
  revisionId,
  revisionNumber: 1,
  filename: `${documentId}.md`,
  teamId: scope.teamId,
  channelId: scope.channelId,
  visible: true,
  ...(bundlePosition === undefined ? {} : { bundlePosition }),
});

describe('#826 Selection 资格判定', () => {
  test('整包按当前 revision 冻结并保留 Bundle 语境', () => {
    expect(evaluateSelectionEligibility({
      request: { kind: 'bundle_all', bundleId: 'bundle-1' },
      bundle: {
        bundleId: 'bundle-1',
        teamId: scope.teamId,
        channelId: scope.channelId,
        name: '交付包',
        visible: true,
        members: [document('doc-a', 'revision-3', 1), document('doc-b', 'revision-2', 2)],
      },
    }, channel, scope)).toEqual({
      eligible: true,
      preview: {
        sourceKind: 'bundle_all',
        bundle: { bundleId: 'bundle-1', name: '交付包', memberCount: 2 },
        items: [
          {
            kind: 'document_revision',
            documentId: 'doc-a',
            revisionId: 'revision-3',
            revisionNumber: 1,
            filename: 'doc-a.md',
            bundlePosition: 1,
          },
          {
            kind: 'document_revision',
            documentId: 'doc-b',
            revisionId: 'revision-2',
            revisionNumber: 1,
            filename: 'doc-b.md',
            bundlePosition: 2,
          },
        ],
      },
    });
  });

  test('包外成员、重复成员与陈旧 revision 均 fail closed', () => {
    const bundle = {
      bundleId: 'bundle-1',
      teamId: scope.teamId,
      channelId: scope.channelId,
      name: '交付包',
      visible: true,
      members: [document('doc-a', 'revision-2', 1)],
    };
    expect(evaluateSelectionEligibility({
      request: { kind: 'bundle_subset', bundleId: 'bundle-1', documentIds: ['doc-z'] },
      bundle,
    }, channel, scope)).toMatchObject({ eligible: false, code: 'not_bundle_member' });
    expect(evaluateSelectionEligibility({
      request: { kind: 'bundle_subset', bundleId: 'bundle-1', documentIds: ['doc-a', 'doc-a'] },
      bundle,
    }, channel, scope)).toMatchObject({ eligible: false, code: 'duplicate_reference' });
    expect(evaluateSelectionEligibility({
      request: {
        kind: 'bundle_all',
        bundleId: 'bundle-1',
        expectedRevisions: [{ documentId: 'doc-a', revisionId: 'revision-1' }],
      },
      bundle,
    }, channel, scope)).toMatchObject({ eligible: false, code: 'revision_stale' });
  });

  test('单文档与明确产物版本验证作用域和可见性', () => {
    expect(evaluateSelectionEligibility({
      request: { kind: 'document', documentId: 'doc-a', expectedRevisionId: 'revision-1' },
      document: document('doc-a', 'revision-2'),
    }, channel, scope)).toMatchObject({ eligible: false, code: 'revision_stale' });
    expect(evaluateSelectionEligibility({
      request: { kind: 'artifact_version', collectionId: 'collection-1', versionId: 'version-1' },
      artifactVersion: {
        collectionId: 'collection-1',
        versionId: 'version-1',
        versionNumber: 3,
        artifactId: 'artifact-1',
        filename: 'report.pdf',
        teamId: scope.teamId,
        channelId: scope.channelId,
        visible: true,
      },
    }, channel, scope)).toMatchObject({
      eligible: true,
      preview: { sourceKind: 'artifact_version' },
    });
  });

  test('归档、频道不可见和跨作用域优先拒绝', () => {
    const selection = {
      request: { kind: 'document' as const, documentId: 'doc-a' },
      document: document('doc-a'),
    };
    expect(evaluateSelectionEligibility(
      selection,
      { ...channel, archived: true },
      scope,
    )).toMatchObject({ eligible: false, code: 'channel_archived' });
    expect(evaluateSelectionEligibility(
      selection,
      { ...channel, visible: false },
      scope,
    )).toMatchObject({ eligible: false, code: 'channel_unavailable' });
    expect(evaluateSelectionEligibility(
      selection,
      channel,
      { ...scope, channelId: 'channel-2' },
    )).toMatchObject({ eligible: false, code: 'scope_mismatch' });
  });
});

describe('#826 短编号解析', () => {
  const members = [
    { bundleId: 'bundle-a', documentId: 'a-1', revisionId: 'a-1-r1', position: 1, filename: 'a.md' },
    { bundleId: 'bundle-a', documentId: 'a-3', revisionId: 'a-3-r7', position: 3, filename: 'a3.md' },
    { bundleId: 'bundle-b', documentId: 'b-3', revisionId: 'b-3-r2', position: 3, filename: 'b3.md' },
  ];

  test('唯一焦点解析为明确 documentId', () => {
    expect(resolveReferenceOrdinal(3, ['bundle-a'], members)).toEqual({
      kind: 'resolved',
      selection: { kind: 'document', documentId: 'a-3', expectedRevisionId: 'a-3-r7' },
      candidate: {
        scopeId: 'bundle-a',
        documentId: 'a-3',
        revisionId: 'a-3-r7',
        position: 3,
        filename: 'a3.md',
      },
    });
  });

  test('多焦点返回全部候选，不猜测', () => {
    const result = resolveReferenceOrdinal(3, ['bundle-a', 'bundle-b'], members);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((candidate) => candidate.scopeId)).toEqual(['bundle-a', 'bundle-b']);
    }
  });

  test('无焦点、越界或非法序号均 not_found', () => {
    expect(resolveReferenceOrdinal(3, [], members)).toEqual({ kind: 'not_found' });
    expect(resolveReferenceOrdinal(2, ['bundle-a'], members)).toEqual({ kind: 'not_found' });
    expect(resolveReferenceOrdinal(0, ['bundle-a'], members)).toEqual({ kind: 'not_found' });
  });
});

describe('#1063 package 资格裁决', () => {
  const packageFacts = (overrides: Partial<{
    packageId: string; teamId: string; channelId: string; memberCount: number;
    members: typeof packageFacts extends never ? never : { sequence: number; shortLabel: string; collectionId: string; deliveredVersionId: string; requiredForFinal: boolean; filename: string }[];
    collections: { id: string; revision: number; currentVersionId: string }[];
    versions: { id: string; collectionId: string; versionNumber: number; artifactId: string; filename: string; visible: boolean }[];
    reviewStateByVersionId: Map<string, string>;
  }> = {}) => {
    return {
      packageId: 'pkg-1',
      teamId: scope.teamId,
      channelId: scope.channelId,
      memberCount: 1,
      members: [{
        sequence: 1, shortLabel: 'F1', collectionId: 'col-1',
        deliveredVersionId: 'ver-delivered', requiredForFinal: true, filename: 'a.md',
      }],
      collections: [{ id: 'col-1', revision: 2, currentVersionId: 'ver-current' }],
      versions: [{ id: 'ver-current', collectionId: 'col-1', versionNumber: 2, artifactId: 'art-1', filename: 'a.md', visible: true }],
      reviewStateByVersionId: new Map([['ver-current', 'pending']]),
      ...overrides,
    };
  };

  const candidate = (overrides: Partial<Record<string, unknown>> = {}) => {
    const packageProjection = packageFacts();
    return {
      request: {
        kind: 'package_projection', packageId: 'pkg-1', policy: 'current',
        expectedMemberRevisions: [{ collectionId: 'col-1', revision: 2 }],
      },
      packageProjection,
      ...overrides,
    };
  };

  test('current 整包:精确 revision fence 匹配才 eligible,fence 漂移 fail closed', () => {
    const selection = candidate();
    const verdict = evaluateSelectionEligibility(selection, channel, scope);
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) {
      expect(verdict.preview.sourceKind).toBe('package_current');
      expect(verdict.preview.package).toEqual({ packageId: 'pkg-1', policy: 'current', memberCount: 1 });
      expect(verdict.preview.items[0]).toMatchObject({
        kind: 'artifact_version', versionId: 'ver-current', collectionRevision: 2,
      });
    }
    // fence 漂移(collection revision 已到 3)。
    const stale = candidate();
    (stale.packageProjection as { collections: { id: string; revision: number; currentVersionId: string }[] }).collections = [
      { id: 'col-1', revision: 3, currentVersionId: 'ver-current' },
    ];
    expect(evaluateSelectionEligibility(stale, channel, scope)).toMatchObject({
      eligible: false, code: 'revision_stale',
    });
  });

  test('current 整包:被拒 current 不参与整包默认正式输入(projection_blocked)', () => {
    const selection = candidate();
    (selection.packageProjection as { reviewStateByVersionId: Map<string, string> }).reviewStateByVersionId = new Map([['ver-current', 'rejected']]);
    const verdict = evaluateSelectionEligibility(selection, channel, scope);
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) {
      expect(verdict.code).toBe('package_projection_blocked');
      expect(verdict.memberBlockers).toEqual([{
        code: 'current_not_formal', collectionId: 'col-1', shortLabel: 'F1', filename: 'a.md',
      }]);
    }
  });

  test('final 整包:必需成员缺 final → package_projection_blocked + missing_final', () => {
    const selection = candidate({
      request: {
        kind: 'package_projection', packageId: 'pkg-1', policy: 'final',
        expectedMemberRevisions: [{ collectionId: 'col-1', revision: 2 }],
      },
    });
    (selection.packageProjection as { collections: { id: string; revision: number; currentVersionId: string }[] }).collections = [
      { id: 'col-1', revision: 2, currentVersionId: 'ver-current' },
    ];
    const verdict = evaluateSelectionEligibility(selection, channel, scope);
    expect(verdict.eligible).toBe(false);
    if (!verdict.eligible) {
      expect(verdict.code).toBe('package_projection_blocked');
      expect(verdict.memberBlockers).toEqual([{
        code: 'missing_final', collectionId: 'col-1', shortLabel: 'F1', filename: 'a.md',
      }]);
    }
  });

  test('package 不存在/跨作用域 → package_not_found / scope_mismatch', () => {
    expect(evaluateSelectionEligibility(
      { request: { kind: 'package_projection', packageId: 'pkg-x', policy: 'delivered' }, packageProjection: null },
      channel, scope,
    )).toMatchObject({ eligible: false, code: 'package_not_found' });
    const cross = candidate();
    (cross.packageProjection as { teamId: string }).teamId = 'team-9';
    expect(evaluateSelectionEligibility(cross, channel, scope)).toMatchObject({
      eligible: false, code: 'scope_mismatch',
    });
  });

  test('package_members 显式选择:成员归属校验与顺序保留', () => {
    const selection = {
      request: {
        kind: 'package_members', packageId: 'pkg-1',
        members: [{ collectionId: 'col-1', versionId: 'ver-current' }],
      },
      packageMembers: {
        packageId: 'pkg-1', teamId: scope.teamId, channelId: scope.channelId, memberCount: 1,
        members: [{
          sequence: 1, shortLabel: 'F1', collectionId: 'col-1',
          deliveredVersionId: 'ver-delivered', requiredForFinal: true, filename: 'a.md',
        }],
        collections: [{ id: 'col-1', revision: 2, currentVersionId: 'ver-current' }],
        versions: [{ id: 'ver-current', collectionId: 'col-1', versionNumber: 2, artifactId: 'art-1', filename: 'a.md', visible: true }],
        reviewStateByVersionId: new Map([['ver-current', 'rejected']]),
      },
    };
    // 显式选择 rejected 版本允许(AC4 “基于此修改”)。
    const verdict = evaluateSelectionEligibility(selection, channel, scope);
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) {
      expect(verdict.preview.sourceKind).toBe('package_specified');
      expect(verdict.preview.package?.policy).toBe('specified');
      expect(verdict.preview.items[0]).toMatchObject({ versionId: 'ver-current' });
    }
    // 跨成员 collection → version_not_in_package。
    const crossVersion = {
      ...selection,
      request: {
        kind: 'package_members', packageId: 'pkg-1',
        members: [{ collectionId: 'col-99', versionId: 'ver-current' }],
      },
    };
    expect(evaluateSelectionEligibility(crossVersion, channel, scope)).toMatchObject({
      eligible: false, code: 'version_not_in_package',
    });
  });
});

describe('#1063 package 短编号解析', () => {
  const pkgMembers = [
    { packageId: 'pkg-a', collectionId: 'a-col', versionId: 'a-ver', versionNumber: 2, shortLabel: 'F1', position: 1, filename: 'a.md' },
    { packageId: 'pkg-a', collectionId: 'a-col3', versionId: 'a-ver3', versionNumber: 1, shortLabel: 'F3', position: 3, filename: 'a3.md' },
    { packageId: 'pkg-b', collectionId: 'b-col3', versionId: 'b-ver3', versionNumber: 1, shortLabel: 'F3', position: 3, filename: 'b3.md' },
  ];

  test('唯一焦点解析为显式 package_members 选择(不跟随指针)', () => {
    expect(resolvePackageReferenceOrdinal(3, ['pkg-a'], pkgMembers)).toEqual({
      kind: 'resolved',
      selection: {
        kind: 'package_members', packageId: 'pkg-a',
        members: [{ collectionId: 'a-col3', versionId: 'a-ver3' }],
      },
      candidate: {
        scopeId: 'pkg-a', collectionId: 'a-col3', versionId: 'a-ver3', versionNumber: 1,
        shortLabel: 'F3', position: 3, filename: 'a3.md',
      },
    });
  });

  test('多焦点命中全部返回候选,不猜测', () => {
    const result = resolvePackageReferenceOrdinal(3, ['pkg-a', 'pkg-b'], pkgMembers);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates.map((entry) => entry.scopeId)).toEqual(['pkg-a', 'pkg-b']);
    }
  });

  test('无焦点/越界/非法序号均 not_found', () => {
    expect(resolvePackageReferenceOrdinal(3, [], pkgMembers)).toEqual({ kind: 'not_found' });
    expect(resolvePackageReferenceOrdinal(2, ['pkg-a'], pkgMembers)).toEqual({ kind: 'not_found' });
    expect(resolvePackageReferenceOrdinal(0, ['pkg-a'], pkgMembers)).toEqual({ kind: 'not_found' });
  });
});

describe('#1063 final 整包 + omitted 成员发送路径(P2-1)', () => {
  test('final 整包:非必需成员无 final 被 omitted,fence 只覆盖解析参与成员,可发送', () => {
    const packageProjection = {
      packageId: 'pkg-1',
      teamId: scope.teamId,
      channelId: scope.channelId,
      memberCount: 2,
      members: [
        { sequence: 1, shortLabel: 'F1', collectionId: 'col-1', deliveredVersionId: 'ver-1-delivered', requiredForFinal: true, filename: 'a.md' },
        { sequence: 2, shortLabel: 'F2', collectionId: 'col-2', deliveredVersionId: 'ver-2-delivered', requiredForFinal: false, filename: 'b.md' },
      ],
      collections: [
        { id: 'col-1', revision: 2, currentVersionId: 'ver-1-current', finalVersionId: 'ver-1-current' },
        { id: 'col-2', revision: 1, currentVersionId: 'ver-2-current' },
      ],
      versions: [
        { id: 'ver-1-current', collectionId: 'col-1', versionNumber: 2, artifactId: 'art-1', filename: 'a.md', visible: true },
        { id: 'ver-2-current', collectionId: 'col-2', versionNumber: 1, artifactId: 'art-2', filename: 'b.md', visible: true },
      ],
      reviewStateByVersionId: new Map(),
    };
    // fence 只覆盖 F1(解析参与成员),F2 omitted 不设 fence。
    const selection = {
      request: {
        kind: 'package_projection', packageId: 'pkg-1', policy: 'final',
        expectedMemberRevisions: [{ collectionId: 'col-1', revision: 2 }],
      },
      packageProjection,
    };
    const verdict = evaluateSelectionEligibility(selection, channel, scope);
    expect(verdict.eligible).toBe(true);
    if (verdict.eligible) {
      expect(verdict.preview.sourceKind).toBe('package_final');
      expect(verdict.preview.items).toHaveLength(1);
      expect(verdict.preview.items[0]).toMatchObject({
        versionId: 'ver-1-current', collectionRevision: 2,
      });
    }
  });

  test('final 整包:fence 覆盖了 omitted 成员 → revision_stale(多出 fence 拒绝)', () => {
    const packageProjection = {
      packageId: 'pkg-1',
      teamId: scope.teamId,
      channelId: scope.channelId,
      memberCount: 2,
      members: [
        { sequence: 1, shortLabel: 'F1', collectionId: 'col-1', deliveredVersionId: 'ver-1-delivered', requiredForFinal: true, filename: 'a.md' },
        { sequence: 2, shortLabel: 'F2', collectionId: 'col-2', deliveredVersionId: 'ver-2-delivered', requiredForFinal: false, filename: 'b.md' },
      ],
      collections: [
        { id: 'col-1', revision: 2, currentVersionId: 'ver-1-current', finalVersionId: 'ver-1-current' },
        { id: 'col-2', revision: 1, currentVersionId: 'ver-2-current' },
      ],
      versions: [
        { id: 'ver-1-current', collectionId: 'col-1', versionNumber: 2, artifactId: 'art-1', filename: 'a.md', visible: true },
        { id: 'ver-2-current', collectionId: 'col-2', versionNumber: 1, artifactId: 'art-2', filename: 'b.md', visible: true },
      ],
      reviewStateByVersionId: new Map(),
    };
    const selection = {
      request: {
        kind: 'package_projection', packageId: 'pkg-1', policy: 'final',
        expectedMemberRevisions: [
          { collectionId: 'col-1', revision: 2 },
          { collectionId: 'col-2', revision: 1 },
        ],
      },
      packageProjection,
    };
    expect(evaluateSelectionEligibility(selection, channel, scope)).toMatchObject({
      eligible: false, code: 'revision_stale',
    });
  });
});
