import type {
  ProjectReferenceItemDto,
  ProjectReferenceOrdinalCandidateDto,
  ProjectReferenceSelectionPreviewDto,
  ProjectReferenceSelectionRequestDto,
  ResolveProjectReferenceOrdinalResultDto,
} from '@agentbean/contracts';

/**
 * #826 项目稳定引用的纯策略。调用方先读取当前事实，本模块负责 fail-closed 裁决，
 * 不接触仓储，也不把短编号作为长期身份。
 */

export type ProjectReferenceSelectionRejectionCode =
  | 'channel_archived'
  | 'channel_unavailable'
  | 'scope_mismatch'
  | 'not_visible'
  | 'not_found'
  | 'empty_selection'
  | 'duplicate_reference'
  | 'not_bundle_member'
  | 'revision_stale'
  | 'collection_mismatch';

export interface ProjectReferenceChannelSnapshot {
  readonly teamId: string;
  readonly channelId: string;
  readonly archived: boolean;
  readonly visible: boolean;
}

export interface ProjectReferenceScope {
  readonly teamId: string;
  readonly channelId: string;
}

export interface ProjectReferenceDocumentCandidate {
  readonly documentId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly filename: string;
  readonly visible: boolean;
  /** 1-based position when the document was resolved through a Bundle. */
  readonly bundlePosition?: number;
}

export interface ProjectReferenceArtifactVersionCandidate {
  readonly collectionId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly artifactId: string;
  readonly filename: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly visible: boolean;
}

export interface ProjectReferenceBundleCandidate {
  readonly bundleId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly name: string;
  readonly visible: boolean;
  readonly members: readonly ProjectReferenceDocumentCandidate[];
}

export type ProjectReferenceSelectionCandidate =
  | {
    readonly request: Extract<ProjectReferenceSelectionRequestDto, { kind: 'bundle_all' | 'bundle_subset' }>;
    readonly bundle: ProjectReferenceBundleCandidate | null;
  }
  | {
    readonly request: Extract<ProjectReferenceSelectionRequestDto, { kind: 'document' }>;
    readonly document: ProjectReferenceDocumentCandidate | null;
  }
  | {
    readonly request: Extract<ProjectReferenceSelectionRequestDto, { kind: 'artifact_version' }>;
    readonly artifactVersion: ProjectReferenceArtifactVersionCandidate | null;
  };

export type ProjectReferenceSelectionEligibility =
  | { readonly eligible: true; readonly preview: ProjectReferenceSelectionPreviewDto }
  | {
    readonly eligible: false;
    readonly code: ProjectReferenceSelectionRejectionCode;
    readonly refId?: string;
  };

export function evaluateSelectionEligibility(
  selection: ProjectReferenceSelectionCandidate,
  channel: ProjectReferenceChannelSnapshot,
  scope: ProjectReferenceScope,
): ProjectReferenceSelectionEligibility {
  if (channel.teamId !== scope.teamId || channel.channelId !== scope.channelId) {
    return { eligible: false, code: 'scope_mismatch' };
  }
  if (!channel.visible) return { eligible: false, code: 'channel_unavailable' };
  if (channel.archived) return { eligible: false, code: 'channel_archived' };

  if ('document' in selection) {
    const { request } = selection;
    const document = selection.document;
    if (!document) return rejected('not_found', request.documentId);
    const basic = evaluateDocument(document, scope, request.expectedRevisionId);
    if (basic) return basic;
    return accepted(request.kind, [toDocumentItem(document)]);
  }

  if ('artifactVersion' in selection) {
    const { request } = selection;
    const version = selection.artifactVersion;
    if (!version) return rejected('not_found', request.versionId);
    if (version.teamId !== scope.teamId || version.channelId !== scope.channelId) {
      return rejected('scope_mismatch', request.versionId);
    }
    if (!version.visible) return rejected('not_visible', request.versionId);
    if (version.collectionId !== request.collectionId) {
      return rejected('collection_mismatch', request.versionId);
    }
    return accepted(request.kind, [{
      kind: 'artifact_version',
      collectionId: version.collectionId,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      artifactId: version.artifactId,
      filename: version.filename,
    }]);
  }

  const { request, bundle } = selection;
  if (!bundle) return rejected('not_found', request.bundleId);
  if (bundle.bundleId !== request.bundleId
    || bundle.teamId !== scope.teamId
    || bundle.channelId !== scope.channelId) {
    return rejected('scope_mismatch', request.bundleId);
  }
  if (!bundle.visible) return rejected('not_visible', request.bundleId);

  const selectedDocuments = request.kind === 'bundle_all'
    ? [...bundle.members]
    : selectBundleSubset(request.documentIds, bundle.members);
  if ('eligible' in selectedDocuments) return selectedDocuments;
  if (selectedDocuments.length === 0) return rejected('empty_selection', request.bundleId);

  const expected = new Map<string, string>();
  for (const revision of request.expectedRevisions ?? []) {
    if (expected.has(revision.documentId)) {
      return rejected('duplicate_reference', revision.documentId);
    }
    expected.set(revision.documentId, revision.revisionId);
  }
  for (const document of selectedDocuments) {
    const documentVerdict = evaluateDocument(document, scope, expected.get(document.documentId));
    if (documentVerdict) return documentVerdict;
  }
  return {
    eligible: true,
    preview: {
      sourceKind: request.kind,
      bundle: {
        bundleId: bundle.bundleId,
        name: bundle.name,
        memberCount: bundle.members.length,
      },
      items: selectedDocuments.map(toDocumentItem),
    },
  };
}

function selectBundleSubset(
  documentIds: readonly string[],
  members: readonly ProjectReferenceDocumentCandidate[],
): ProjectReferenceDocumentCandidate[]
  | Extract<ProjectReferenceSelectionEligibility, { eligible: false }> {
  if (documentIds.length === 0) return [];
  const seen = new Set<string>();
  const selected: ProjectReferenceDocumentCandidate[] = [];
  for (const documentId of documentIds) {
    if (seen.has(documentId)) return rejected('duplicate_reference', documentId);
    seen.add(documentId);
    const member = members.find((candidate) => candidate.documentId === documentId);
    if (!member) return rejected('not_bundle_member', documentId);
    selected.push(member);
  }
  return selected;
}

function evaluateDocument(
  document: ProjectReferenceDocumentCandidate,
  scope: ProjectReferenceScope,
  expectedRevisionId?: string,
): Extract<ProjectReferenceSelectionEligibility, { eligible: false }> | null {
  if (document.teamId !== scope.teamId || document.channelId !== scope.channelId) {
    return rejected('scope_mismatch', document.documentId);
  }
  if (!document.visible) return rejected('not_visible', document.documentId);
  if (expectedRevisionId !== undefined && expectedRevisionId !== document.revisionId) {
    return rejected('revision_stale', document.documentId);
  }
  return null;
}

function toDocumentItem(document: ProjectReferenceDocumentCandidate): ProjectReferenceItemDto {
  return {
    kind: 'document_revision',
    documentId: document.documentId,
    revisionId: document.revisionId,
    revisionNumber: document.revisionNumber,
    filename: document.filename,
    ...(document.bundlePosition === undefined ? {} : { bundlePosition: document.bundlePosition }),
  };
}

function accepted(
  sourceKind: ProjectReferenceSelectionPreviewDto['sourceKind'],
  items: readonly ProjectReferenceItemDto[],
): ProjectReferenceSelectionEligibility {
  return { eligible: true, preview: { sourceKind, items } };
}

function rejected(
  code: ProjectReferenceSelectionRejectionCode,
  refId?: string,
): Extract<ProjectReferenceSelectionEligibility, { eligible: false }> {
  return { eligible: false, code, ...(refId === undefined ? {} : { refId }) };
}

export interface ProjectReferenceOrdinalBundleMember {
  readonly bundleId: string;
  readonly documentId: string;
  readonly position: number;
  readonly filename: string;
}

/**
 * 解析「第 N 个文件」。只有一个焦点 Bundle 且该位置恰好命中一个成员时才 resolved；
 * 多焦点的命中项全部作为候选返回，调用方不得猜测。
 */
export function resolveReferenceOrdinal(
  ordinal: number,
  focusBundleIds: readonly string[],
  bundleMembers: readonly ProjectReferenceOrdinalBundleMember[],
): ResolveProjectReferenceOrdinalResultDto {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return { kind: 'not_found' };
  const focused = new Set(focusBundleIds);
  const candidates: ProjectReferenceOrdinalCandidateDto[] = bundleMembers
    .filter((member) => focused.has(member.bundleId) && member.position === ordinal)
    .map((member) => ({
      scopeId: member.bundleId,
      documentId: member.documentId,
      position: member.position,
      filename: member.filename,
    }));
  if (focusBundleIds.length === 1 && candidates.length === 1) {
    const candidate = candidates[0] as ProjectReferenceOrdinalCandidateDto;
    return {
      kind: 'resolved',
      selection: { kind: 'document', documentId: candidate.documentId },
      candidate,
    };
  }
  return candidates.length > 0 ? { kind: 'ambiguous', candidates } : { kind: 'not_found' };
}
