import type { ID, UnixMs } from './common.js';

/**
 * #826：把「引用哪些项目内容」在 `message:send` 那一刻冻结成稳定引用集。
 *
 * 三层区分是本合同的全部要点：
 * - **选择请求**（`ProjectReferenceSelectionRequestDto`）是发送前的意图，只在一次请求内有效；
 * - **冻结项**（`ProjectReferenceItemDto`）是发送时刻的事实，含 `revisionId` / `versionId` 这类
 *   不随后续修订变化的身份；
 * - **引用集**（`ProjectReferenceSetDto`）与 Message 原子写入，历史消息与后续 Invocation
 *   永远读它，不重新解析当前文档、当前 Bundle 投影或集合的 current/final 指针。
 *
 * 因此文档被修订、Bundle 当前投影变化、集合最终版切换，都不会改写已发送消息的引用。
 */

/**
 * 引用集合同版本。旧消息按写入时的版本解释 —— 新增语义必须提升版本，
 * 不得就地改变既有 items 的含义。
 */
export const PROJECT_REFERENCE_SET_CONTRACT_VERSION = 1;

/** Selection 是怎么形成的。这条事实要在历史消息里长期展示，因此随引用集持久化。 */
export type ProjectReferenceSelectionSourceKind =
  /** 从文档包一键全选。 */
  | 'bundle_all'
  /** 展开文档包后多选其中若干成员。 */
  | 'bundle_subset'
  /** 直接引用单个 Markdown 文档。 */
  | 'document'
  /** 引用明确的 ProjectArtifactVersion。 */
  | 'artifact_version'
  /** #1063：整包引用——交付时冻结版本(delivered 投影)。 */
  | 'package_delivered'
  /** #1063：整包引用——发送时逐成员解析 collection currentVersionId。 */
  | 'package_current'
  /** #1063：整包引用——只取已有 finalVersionId 的正式成员。 */
  | 'package_final'
  /** #1063：包内显式单选/多选/“基于此修改”——具体 artifactVersionId。 */
  | 'package_specified';

/**
 * 发送方对某个文档「我看到的是哪一版」的声明。
 * Server 用它做乐观并发控制：与当前 revision 不符即拒绝，绝不静默冻结更新的版本。
 */
export interface ProjectDocumentExpectedRevisionDto {
  readonly documentId: ID;
  readonly revisionId: ID;
}

export interface ProjectReferenceBundleAllRequestDto {
  readonly kind: 'bundle_all';
  readonly bundleId: ID;
  readonly expectedRevisions?: readonly ProjectDocumentExpectedRevisionDto[];
}

export interface ProjectReferenceBundleSubsetRequestDto {
  readonly kind: 'bundle_subset';
  readonly bundleId: ID;
  /** 必须是该包的成员；顺序由发送方给定，Server 不重排。 */
  readonly documentIds: readonly ID[];
  readonly expectedRevisions?: readonly ProjectDocumentExpectedRevisionDto[];
}

export interface ProjectReferenceDocumentRequestDto {
  readonly kind: 'document';
  readonly documentId: ID;
  readonly expectedRevisionId?: ID;
}

export interface ProjectReferenceArtifactVersionRequestDto {
  readonly kind: 'artifact_version';
  readonly collectionId: ID;
  /** 明确的版本身份。刻意不接受「集合的当前版/最终版」这类指针式引用。 */
  readonly versionId: ID;
}

/**
 * #1063：整包投影选择可引用的指针策略。
 * `specified` 刻意不在其中——显式版本选择走 `package_members` arm。
 */
export const PROJECT_REFERENCE_PACKAGE_PROJECTION_POLICIES = ['delivered', 'current', 'final'] as const;
export type ProjectReferencePackageProjectionPolicy =
  (typeof PROJECT_REFERENCE_PACKAGE_PROJECTION_POLICIES)[number];

/**
 * 预览/选择时刻某成员 collection 的 revision 快照（fence）。
 * Server 发送时复核：任一成员 revision 漂移即 `revision_stale`，绝不静默换版本（#1063 AC6/AC9）。
 */
export interface ProjectPackageMemberExpectedRevisionDto {
  readonly collectionId: ID;
  readonly revision: number;
}

/**
 * #1063：整包引用（packageId + projection policy）。
 * - `delivered`：还原 package 创建时的冻结版本，不依赖 collection 现状，无需 fence；
 * - `current`/`final`：指针式解析，`expectedMemberRevisions` 必填——UI 从
 *   `get-output-package` projection 响应拿到成员 collection revision 后原样回传。
 */
export interface ProjectReferencePackageProjectionRequestDto {
  readonly kind: 'package_projection';
  readonly packageId: ID;
  readonly policy: ProjectReferencePackageProjectionPolicy;
  readonly expectedMemberRevisions?: readonly ProjectPackageMemberExpectedRevisionDto[];
}

/**
 * #1063：包内显式选择（单选=members 长度 1；多选=多个；「基于此修改」=显式选择
 * rejected/changes_requested 的具体版本）。版本必须属于 package 成员的 collection，
 * Server 逐项校验成员归属；显式版本不过 review 闸（用户显式意图优先）。
 */
export interface ProjectReferencePackageMemberVersionDto {
  readonly collectionId: ID;
  readonly versionId: ID;
}

export interface ProjectReferencePackageMembersRequestDto {
  readonly kind: 'package_members';
  readonly packageId: ID;
  /** 顺序由发送方给定，Server 不重排。 */
  readonly members: readonly ProjectReferencePackageMemberVersionDto[];
}

/**
 * 发送方提交的选择意图。
 *
 * 这个联合类型**刻意没有序号arm**：「第 3 个文件」永远无法进入 `message:send`。
 * 短编号只能先经 `project:resolve-reference-ordinal` 换成明确 id，
 * 于是「短编号不能成为长期身份」是合同层的结构性保证，而不是运行时约定。
 */
export type ProjectReferenceSelectionRequestDto =
  | ProjectReferenceBundleAllRequestDto
  | ProjectReferenceBundleSubsetRequestDto
  | ProjectReferenceDocumentRequestDto
  | ProjectReferenceArtifactVersionRequestDto
  | ProjectReferencePackageProjectionRequestDto
  | ProjectReferencePackageMembersRequestDto;

export type ProjectReferenceItemKind = 'document_revision' | 'artifact_version';

/** 冻结的文档引用：documentId + 发送时的 revisionId。 */
export interface ProjectDocumentRevisionReferenceItemDto {
  readonly kind: 'document_revision';
  readonly documentId: ID;
  readonly revisionId: ID;
  readonly revisionNumber: number;
  /** 发送时的展示名快照；仅用于展示，不参与身份判断。 */
  readonly filename: string;
  /** 该项在来源 Bundle 中的成员位次；单文档选择缺省。 */
  readonly bundlePosition?: number;
}

/** 冻结的产物引用：明确的版本 id，不随集合 current/final 指针移动。 */
export interface ProjectArtifactVersionReferenceItemDto {
  readonly kind: 'artifact_version';
  readonly collectionId: ID;
  readonly versionId: ID;
  readonly versionNumber: number;
  readonly artifactId: ID;
  readonly filename: string;
  /**
   * #1063：解析时 basis——仅当本 item 由 current/final 指针解析而来时携带
   * （解析当刻的 collection revision）。提交点据此复核指针未漂移；
   * delivered/specified 等显式版本语义的 item 刻意不携带（不设 revision fence）。
   */
  readonly collectionRevision?: number;
}

export type ProjectReferenceItemDto =
  | ProjectDocumentRevisionReferenceItemDto
  | ProjectArtifactVersionReferenceItemDto;

/** 发送时刻的 Bundle 语境快照。名称与成员数是快照，之后包本身也不会变。 */
export interface ProjectReferenceBundleContextDto {
  readonly bundleId: ID;
  readonly name: string;
  readonly memberCount: number;
}

/**
 * #1063：发送/预览时刻的 OutputPackage 语境快照。
 * policy 即「用途」事实——历史消息展示该引用是按哪个投影解析的；
 * package 本身不可变，memberCount 与成员身份创建后冻结。
 */
export interface ProjectReferencePackageContextDto {
  readonly packageId: ID;
  readonly policy: ProjectReferencePackageProjectionPolicy | 'specified';
  readonly memberCount: number;
}

/** 冻结前的投影：`project:resolve-references` 用它让 composer 先看到将要冻结什么。 */
export interface ProjectReferenceSelectionPreviewDto {
  readonly sourceKind: ProjectReferenceSelectionSourceKind;
  readonly bundle?: ProjectReferenceBundleContextDto;
  readonly package?: ProjectReferencePackageContextDto;
  readonly items: readonly ProjectReferenceItemDto[];
}

export interface ProjectReferenceSelectionDto extends ProjectReferenceSelectionPreviewDto {
  readonly id: ID;
  readonly position: number;
  readonly createdAt: UnixMs;
}

export interface ProjectReferenceSetDto {
  readonly id: ID;
  readonly contractVersion: number;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly messageId: ID;
  readonly selections: readonly ProjectReferenceSelectionDto[];
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
}

/** 结构化失败原因。composer 据此精确提示，不必解析人类可读 message。 */
export type ProjectReferenceFailureReason =
  | 'not_team_member'
  | 'invalid_request'
  | 'channel_archived'
  | 'channel_unavailable'
  | 'idempotency_conflict'
  | 'selections_rejected';

/**
 * #1063：整包投影被阻断时的逐项阻断清单。
 * code 取值由 domain 投影策略给出（missing_final / current_not_formal /
 * collection_unavailable / version_not_in_package）。
 */
export interface ProjectReferenceMemberBlockerDto {
  readonly collectionId: ID;
  readonly shortLabel: string;
  readonly filename: string;
  readonly code: string;
}

/** 逐项原因码。code 在合同层不透明，权威取值由 domain 引用策略给出。 */
export interface ProjectReferenceRejectionDto {
  /** 在请求 selections 数组中的下标，让 composer 能定位到具体那个 chip。 */
  readonly selectionIndex: number;
  /** 被拒对象身份：documentId / bundleId / versionId / packageId。 */
  readonly refId?: ID;
  readonly code: string;
  /** #1063：整包投影阻断时逐项列出受影响成员（final 缺失/被拒 current 等）。 */
  readonly memberBlockers?: readonly ProjectReferenceMemberBlockerDto[];
}

export interface ProjectReferenceFailureDetailsDto {
  readonly reason: ProjectReferenceFailureReason;
  readonly rejections?: readonly ProjectReferenceRejectionDto[];
}

export interface ResolveProjectReferencesInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  selections: readonly ProjectReferenceSelectionRequestDto[];
}

export interface ResolveProjectReferencesResultDto {
  readonly selections: readonly ProjectReferenceSelectionPreviewDto[];
  readonly archived: boolean;
}

/**
 * 短编号候选。scopeId 是「焦点语境」身份（当前实现为 bundleId）——
 * 焦点不唯一时必须要求明确选择，不能靠位次猜测。
 */
export interface ProjectReferenceOrdinalCandidateDto {
  readonly scopeId: ID;
  readonly documentId: ID;
  /** 解析当刻的 revision fence，发送时必须原样回传。 */
  readonly revisionId: ID;
  /** 1 起的位次，与用户口语中的「第 N 个」对齐。 */
  readonly position: number;
  readonly filename: string;
}

/**
 * #1063：package 焦点的短编号（F1/F2/「第 3 个文件」）候选。
 * scopeId 是焦点 packageId；versionId 为解析当刻该成员的 current 版本——
 * 解析结果即显式版本身份（specified 语义），插入 chip 后不再跟随指针。
 */
export interface ProjectReferenceOrdinalPackageCandidateDto {
  readonly scopeId: ID;
  readonly collectionId: ID;
  readonly versionId: ID;
  readonly versionNumber: number;
  /** 包内冻结短标识（F1、F2……），仅焦点内唯一。 */
  readonly shortLabel: string;
  readonly position: number;
  readonly filename: string;
}

export interface ResolveProjectReferenceOrdinalInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
  ordinal: number;
  /** 客户端当前焦点里的文档包；为空或多于一个即视为焦点不唯一。 */
  focusBundleIds: readonly ID[];
  /** #1063：客户端当前焦点里的 OutputPackage；与 focusBundleIds 可同时为空。 */
  focusPackageIds?: readonly ID[];
}

export type ResolveProjectReferenceOrdinalResultDto =
  | {
    readonly kind: 'resolved';
    readonly selection: ProjectReferenceDocumentRequestDto | ProjectReferencePackageMembersRequestDto;
    readonly candidate: ProjectReferenceOrdinalCandidateDto | ProjectReferenceOrdinalPackageCandidateDto;
  }
  | {
    readonly kind: 'ambiguous';
    readonly candidates: readonly (
      | ProjectReferenceOrdinalCandidateDto
      | ProjectReferenceOrdinalPackageCandidateDto
    )[];
  }
  | { readonly kind: 'not_found' };

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验(#1063)
// ---------------------------------------------------------------------------

/**
 * selection request 的运行时校验。#1063 起新增 arm(package_projection/package_members)
 * 必须过 exact-key 校验(#1059 §9/测试原则:runtime schema 而非只编译 TS interface);
 * 既有四 arm 一并纳入同一 parser——web 端本就按 DTO 精确形状发送,收紧不改变现网行为。
 */
export const PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID = 'PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID';

function assertSelectionExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  }
}

function assertSelectionId(value: unknown): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  }
}

function assertSelectionRevision(value: unknown): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  }
}

function assertExpectedDocumentRevisions(value: unknown): void {
  if (!Array.isArray(value)) throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  for (const entry of value) {
    assertSelectionExactKeys(entry, ['documentId', 'revisionId'], ['documentId', 'revisionId']);
    assertSelectionId(entry.documentId);
    assertSelectionId(entry.revisionId);
  }
}

function assertExpectedMemberRevisions(value: unknown): void {
  if (!Array.isArray(value)) throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  for (const entry of value) {
    assertSelectionExactKeys(entry, ['collectionId', 'revision'], ['collectionId', 'revision']);
    assertSelectionId(entry.collectionId);
    assertSelectionRevision(entry.revision);
  }
}

function assertPackageMemberVersions(value: unknown): void {
  if (!Array.isArray(value)) throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  for (const entry of value) {
    assertSelectionExactKeys(entry, ['collectionId', 'versionId'], ['collectionId', 'versionId']);
    assertSelectionId(entry.collectionId);
    assertSelectionId(entry.versionId);
  }
}

/** 解析单个 selection request;形状不合法时抛出 PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID。 */
export function parseProjectReferenceSelectionRequestV1(
  value: unknown,
): ProjectReferenceSelectionRequestDto {
  // 先取 kind 判别(此处不 exact-key——各 arm 的完整键集在分支内校验)。
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  }
  const kind = (value as Record<string, unknown>).kind;
  switch (kind) {
    case 'bundle_all':
      assertSelectionExactKeys(value, ['kind', 'bundleId', 'expectedRevisions'], ['kind', 'bundleId']);
      assertSelectionId(value.bundleId);
      if (value.expectedRevisions !== undefined) assertExpectedDocumentRevisions(value.expectedRevisions);
      break;
    case 'bundle_subset':
      assertSelectionExactKeys(value,
        ['kind', 'bundleId', 'documentIds', 'expectedRevisions'], ['kind', 'bundleId', 'documentIds']);
      assertSelectionId(value.bundleId);
      if (!Array.isArray(value.documentIds)) throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
      value.documentIds.forEach(assertSelectionId);
      if (value.expectedRevisions !== undefined) assertExpectedDocumentRevisions(value.expectedRevisions);
      break;
    case 'document':
      assertSelectionExactKeys(value,
        ['kind', 'documentId', 'expectedRevisionId'], ['kind', 'documentId']);
      assertSelectionId(value.documentId);
      if (value.expectedRevisionId !== undefined) assertSelectionId(value.expectedRevisionId);
      break;
    case 'artifact_version':
      assertSelectionExactKeys(value,
        ['kind', 'collectionId', 'versionId'], ['kind', 'collectionId', 'versionId']);
      assertSelectionId(value.collectionId);
      assertSelectionId(value.versionId);
      break;
    case 'package_projection':
      assertSelectionExactKeys(value,
        ['kind', 'packageId', 'policy', 'expectedMemberRevisions'], ['kind', 'packageId', 'policy']);
      assertSelectionId(value.packageId);
      if (!PROJECT_REFERENCE_PACKAGE_PROJECTION_POLICIES.includes(
        value.policy as ProjectReferencePackageProjectionPolicy,
      )) {
        throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
      }
      if (value.expectedMemberRevisions !== undefined) {
        assertExpectedMemberRevisions(value.expectedMemberRevisions);
      }
      break;
    case 'package_members':
      assertSelectionExactKeys(value,
        ['kind', 'packageId', 'members'], ['kind', 'packageId', 'members']);
      assertSelectionId(value.packageId);
      assertPackageMemberVersions(value.members);
      break;
    default:
      throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as ProjectReferenceSelectionRequestDto;
}

/** 解析 selections 数组(message:send 与 resolve-references 共用)。 */
export function parseProjectReferenceSelectionRequestsV1(
  value: unknown,
): readonly ProjectReferenceSelectionRequestDto[] {
  if (!Array.isArray(value)) throw new Error(PROJECT_REFERENCE_SELECTION_PAYLOAD_INVALID);
  return value.map((entry) => parseProjectReferenceSelectionRequestV1(entry));
}