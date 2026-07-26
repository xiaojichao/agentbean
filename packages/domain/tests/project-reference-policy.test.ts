import { describe, expect, test } from 'vitest';

import {
  evaluateSelectionEligibility,
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
