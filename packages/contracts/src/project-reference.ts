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
  | 'artifact_version';

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
  | ProjectReferenceArtifactVersionRequestDto;

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

/** 冻结前的投影：`project:resolve-references` 用它让 composer 先看到将要冻结什么。 */
export interface ProjectReferenceSelectionPreviewDto {
  readonly sourceKind: ProjectReferenceSelectionSourceKind;
  readonly bundle?: ProjectReferenceBundleContextDto;
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

/** 逐项原因码。code 在合同层不透明，权威取值由 domain 引用策略给出。 */
export interface ProjectReferenceRejectionDto {
  /** 在请求 selections 数组中的下标，让 composer 能定位到具体那个 chip。 */
  readonly selectionIndex: number;
  /** 被拒对象身份：documentId / bundleId / versionId。 */
  readonly refId?: ID;
  readonly code: string;
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
  /** 1 起的位次，与用户口语中的「第 N 个」对齐。 */
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
}

export type ResolveProjectReferenceOrdinalResultDto =
  | { readonly kind: 'resolved'; readonly selection: ProjectReferenceDocumentRequestDto; readonly candidate: ProjectReferenceOrdinalCandidateDto }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly ProjectReferenceOrdinalCandidateDto[] }
  | { readonly kind: 'not_found' };
