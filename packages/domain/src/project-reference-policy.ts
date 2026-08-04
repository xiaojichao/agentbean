import type {
  ProjectReferenceItemDto,
  ProjectReferenceMemberBlockerDto,
  ProjectReferenceOrdinalCandidateDto,
  ProjectReferenceOrdinalPackageCandidateDto,
  ProjectReferenceSelectionPreviewDto,
  ProjectReferenceSelectionRequestDto,
  ResolveProjectReferenceOrdinalResultDto,
} from '@agentbean/contracts';
import {
  resolveOutputPackageProjection,
  resolveProjectPackageMemberVersion,
  type OutputPackageProjectionCollectionFact,
  type OutputPackageProjectionMemberFact,
  type OutputPackageProjectionVersionFact,
} from './output-package-projection-policy.js';
import type { ProjectArtifactVersionReviewState } from '@agentbean/contracts';

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
  | 'collection_mismatch'
  /** #1063：package 不存在或不属于本 Team/Channel。 */
  | 'package_not_found'
  /** #1063：整包投影被结构化阻断(final 缺失/被拒 current/成员不可用)。 */
  | 'package_projection_blocked'
  /** #1063：显式选择的版本不属于 package 任何成员的 collection。 */
  | 'version_not_in_package';

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

/**
 * #1063：package 选择候选。package/成员身份由 Server 从不可变事实读取;
 * collections/versions/reviewStates 是解析时的同快照事实。
 */
export interface ProjectReferencePackageCandidate {
  readonly packageId: string;
  readonly teamId: string;
  readonly channelId: string;
  readonly memberCount: number;
  readonly members: readonly OutputPackageProjectionMemberFact[];
  readonly collections: readonly OutputPackageProjectionCollectionFact[];
  readonly versions: readonly OutputPackageProjectionVersionFact[];
  readonly reviewStateByVersionId: ReadonlyMap<string, ProjectArtifactVersionReviewState>;
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
  }
  | {
    readonly request: Extract<ProjectReferenceSelectionRequestDto, { kind: 'package_projection' }>;
    readonly packageProjection: ProjectReferencePackageCandidate | null;
  }
  | {
    readonly request: Extract<ProjectReferenceSelectionRequestDto, { kind: 'package_members' }>;
    readonly packageMembers: ProjectReferencePackageCandidate | null;
  };

export type ProjectReferenceSelectionEligibility =
  | { readonly eligible: true; readonly preview: ProjectReferenceSelectionPreviewDto }
  | {
    readonly eligible: false;
    readonly code: ProjectReferenceSelectionRejectionCode;
    readonly refId?: string;
    /** #1063：整包投影阻断时的逐项成员清单(供 composer 精确提示)。 */
    readonly memberBlockers?: readonly ProjectReferenceMemberBlockerDto[];
  };

/** policy → 冻结 sourceKind 映射(「用途」事实随引用集持久化)。 */
const PACKAGE_POLICY_SOURCE_KINDS = {
  delivered: 'package_delivered',
  current: 'package_current',
  final: 'package_final',
} as const;

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

  // #1063 整包投影:指针策略(current/final)必须带逐成员 revision fence 且精确匹配成员集合,
  // 解析被阻断时逐项返回 memberBlockers,绝不静默换版本或降级。
  if ('packageProjection' in selection) {
    const { request } = selection;
    const candidate = selection.packageProjection;
    if (!candidate) return rejected('package_not_found', request.packageId);
    if (candidate.teamId !== scope.teamId || candidate.channelId !== scope.channelId) {
      return rejected('scope_mismatch', request.packageId);
    }
    const resolution = resolveOutputPackageProjection({
      members: candidate.members,
      collections: candidate.collections,
      versions: candidate.versions,
      reviewStateByVersionId: candidate.reviewStateByVersionId,
      policy: request.policy,
    });
    // 投影非 ready(final 缺失/被拒 current/不可用)时阻断优先——缺 final 的包
    // 返回 package_projection_blocked + 缺失清单,而不是 revision_stale。
    if (resolution.status !== 'ready') {
      return {
        eligible: false,
        code: 'package_projection_blocked',
        refId: request.packageId,
        memberBlockers: resolution.blockers.map((blocker) => ({
          collectionId: blocker.collectionId,
          shortLabel: blocker.shortLabel ?? '',
          filename: blocker.filename ?? '',
          code: blocker.code,
        })),
      };
    }
    // 投影 ready 后才校验 fence:只覆盖实际参与解析的成员(current/final 解析出的
    // members;omitted 成员不设 fence——它明确被省略,不依赖其 collection 指针)。
    // 每个参与成员必须有匹配 fence,且与解析当刻的 collection revision 一致;
    // 多出的 fence(不属于本包/不属于解析参与集)同样拒绝。
    // (delivered 策略是冻结事实,不依赖任何 collection 指针,无需 fence。)
    if (request.policy === 'current' || request.policy === 'final') {
      const expectedEntries = request.expectedMemberRevisions ?? [];
      const expected = new Map<string, number>();
      for (const entry of expectedEntries) {
        if (expected.has(entry.collectionId)) return rejected('duplicate_reference', entry.collectionId);
        expected.set(entry.collectionId, entry.revision);
      }
      const parsedMembers = resolution.members;
      for (const member of parsedMembers) {
        const collection = candidate.collections.find((c) => c.id === member.collectionId);
        const expectedRevision = expected.get(member.collectionId);
        if (expectedRevision === undefined || !collection || collection.revision !== expectedRevision) {
          return rejected('revision_stale', member.collectionId);
        }
      }
      if (expected.size !== parsedMembers.length) {
        return rejected('revision_stale', request.packageId);
      }
    }
    return {
      eligible: true,
      preview: {
        sourceKind: PACKAGE_POLICY_SOURCE_KINDS[request.policy],
        package: {
          packageId: candidate.packageId,
          policy: request.policy,
          memberCount: candidate.memberCount,
        },
        items: resolution.members.map((member): ProjectReferenceItemDto => ({
          kind: 'artifact_version',
          collectionId: member.collectionId,
          versionId: member.versionId,
          versionNumber: member.versionNumber,
          artifactId: member.artifactId,
          filename: member.filename,
          // 指针解析(current/final)的 item 携带解析时 basis;delivered 语义不依赖指针,不带。
          ...(request.policy === 'delivered' ? {} : { collectionRevision: member.collectionRevision }),
        })),
      },
    };
  }

  // #1063 包内显式选择(单选/多选/“基于此修改”):逐项校验成员归属与可见性,
  // 显式版本不过 review 闸;顺序保留发送方给定顺序。
  if ('packageMembers' in selection) {
    const { request } = selection;
    const candidate = selection.packageMembers;
    if (!candidate) return rejected('package_not_found', request.packageId);
    if (candidate.teamId !== scope.teamId || candidate.channelId !== scope.channelId) {
      return rejected('scope_mismatch', request.packageId);
    }
    if (request.members.length === 0) return rejected('empty_selection', request.packageId);
    const memberCollectionIds = new Set(candidate.members.map((member) => member.collectionId));
    const seen = new Set<string>();
    const items: ProjectReferenceItemDto[] = [];
    for (const requested of request.members) {
      if (seen.has(requested.versionId)) return rejected('duplicate_reference', requested.versionId);
      seen.add(requested.versionId);
      const verdict = resolveProjectPackageMemberVersion({
        memberCollectionIds,
        versions: candidate.versions,
      }, requested.collectionId, requested.versionId);
      if (verdict.kind === 'not_in_package') {
        return rejected('version_not_in_package', requested.versionId);
      }
      if (verdict.kind === 'not_visible') return rejected('not_visible', requested.versionId);
      const version = verdict.version;
      items.push({
        kind: 'artifact_version',
        collectionId: version.collectionId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        artifactId: version.artifactId,
        filename: version.filename,
      });
    }
    return {
      eligible: true,
      preview: {
        sourceKind: 'package_specified',
        package: {
          packageId: candidate.packageId,
          policy: 'specified',
          memberCount: candidate.memberCount,
        },
        items,
      },
    };
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
  readonly revisionId: string;
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
      revisionId: member.revisionId,
      position: member.position,
      filename: member.filename,
    }));
  if (focusBundleIds.length === 1 && candidates.length === 1) {
    const candidate = candidates[0] as ProjectReferenceOrdinalCandidateDto;
    return {
      kind: 'resolved',
      selection: {
        kind: 'document',
        documentId: candidate.documentId,
        expectedRevisionId: candidate.revisionId,
      },
      candidate,
    };
  }
  return candidates.length > 0 ? { kind: 'ambiguous', candidates } : { kind: 'not_found' };
}

/**
 * #1063：package 焦点内的短编号成员事实。
 * versionId 为解析当刻该成员 collection 的 current 版本(由 Server 读取),
 * position 与 package 冻结 sequence 对齐(F1 ↔ 1)。
 */
export interface ProjectReferenceOrdinalPackageMember {
  readonly packageId: string;
  readonly collectionId: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly shortLabel: string;
  readonly position: number;
  readonly filename: string;
}

/**
 * 解析 package 焦点内的「F N / 第 N 个文件」。只有一个焦点 package 且该位次恰好
 * 命中一个成员时才 resolved——解析结果即显式版本身份(package_members/specified
 * 语义),插入 chip 后不跟随指针;多焦点命中全部作为候选返回,调用方不得猜测。
 */
export function resolvePackageReferenceOrdinal(
  ordinal: number,
  focusPackageIds: readonly string[],
  packageMembers: readonly ProjectReferenceOrdinalPackageMember[],
): ResolveProjectReferenceOrdinalResultDto {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) return { kind: 'not_found' };
  const focused = new Set(focusPackageIds);
  const candidates: ProjectReferenceOrdinalPackageCandidateDto[] = packageMembers
    .filter((member) => focused.has(member.packageId) && member.position === ordinal)
    .map((member) => ({
      scopeId: member.packageId,
      collectionId: member.collectionId,
      versionId: member.versionId,
      versionNumber: member.versionNumber,
      shortLabel: member.shortLabel,
      position: member.position,
      filename: member.filename,
    }));
  if (focusPackageIds.length === 1 && candidates.length === 1) {
    const candidate = candidates[0] as ProjectReferenceOrdinalPackageCandidateDto;
    return {
      kind: 'resolved',
      selection: {
        kind: 'package_members',
        packageId: candidate.scopeId,
        members: [{ collectionId: candidate.collectionId, versionId: candidate.versionId }],
      },
      candidate,
    };
  }
  return candidates.length > 0 ? { kind: 'ambiguous', candidates } : { kind: 'not_found' };
}
