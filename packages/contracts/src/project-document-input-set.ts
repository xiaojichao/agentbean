import type { ID } from './common.js';
import type { ProjectReferenceSelectionSourceKind } from './project-reference.js';

/** Device/Agent adapter 公开协商的 ProjectDocumentInputSet 合同版本。 */
export const PROJECT_DOCUMENT_INPUT_SET_CONTRACT_VERSION = 1;

export interface ProjectDocumentInputSetItemSourceDto {
  readonly referenceSetId: ID;
  readonly selectionId: ID;
  readonly selectionSourceKind: ProjectReferenceSelectionSourceKind;
  readonly bundleId?: ID;
  readonly bundleName?: string;
}

/**
 * Invocation 创建时冻结的必需 Markdown 输入。
 * relativePath 是 Device 临时输入目录内的路径，不是 Channel file index 路径。
 */
export interface ProjectDocumentInputSetItemV1 {
  readonly documentId: ID;
  readonly baseRevisionId: ID;
  readonly revisionNumber: number;
  readonly artifactId: ID;
  readonly displayName: string;
  readonly summary: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly source: ProjectDocumentInputSetItemSourceDto;
}

export interface ProjectDocumentInputSetV1 {
  readonly id: ID;
  readonly contractVersion: 1;
  readonly required: true;
  readonly referenceSetId: ID;
  readonly items: readonly ProjectDocumentInputSetItemV1[];
}

/** Device 物化完成后写入临时输入目录的 manifest。 */
export interface ProjectDocumentInputSetManifestItemV1 extends ProjectDocumentInputSetItemV1 {
  readonly localPath: string;
}

export interface ProjectDocumentInputSetManifestV1 {
  readonly contractVersion: 1;
  readonly inputSetId: ID;
  readonly invocationId: ID;
  readonly items: readonly ProjectDocumentInputSetManifestItemV1[];
}

/**
 * Device 根据 manifest 的稳定 documentId/baseRevisionId 与内容摘要提交结果。
 * 文件名与本地路径只用于展示和物化，绝不参与文档身份判定。
 */
export interface ProjectDocumentInputSetItemResultProposalV1 {
  readonly documentId: ID;
  readonly baseRevisionId: ID;
  readonly status: 'unchanged' | 'changed' | 'failed';
  readonly sha256?: string;
  readonly artifactId?: ID;
  readonly error?: string;
}

export interface ProjectDocumentInputSetResultProposalV1 {
  readonly contractVersion: 1;
  readonly inputSetId: ID;
  readonly invocationId: ID;
  readonly items: readonly ProjectDocumentInputSetItemResultProposalV1[];
}

export type ProjectDocumentInputSetItemResultStatus =
  | 'unchanged'
  | 'committed'
  | 'conflict'
  | 'failed';

export interface ProjectDocumentInputSetItemResultDto {
  readonly documentId: ID;
  readonly baseRevisionId: ID;
  readonly status: ProjectDocumentInputSetItemResultStatus;
  readonly artifactId?: ID;
  readonly revisionId?: ID;
  readonly error?: string;
  readonly createdAt: number;
}

export interface ProjectDocumentInputSetResultDto {
  readonly contractVersion: 1;
  readonly inputSetId: ID;
  readonly invocationId: ID;
  readonly items: readonly ProjectDocumentInputSetItemResultDto[];
}
