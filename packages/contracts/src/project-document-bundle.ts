import type { ID, UnixMs } from './common.js';
import type { ArtifactSourceRootDto } from './artifact.js';
import type { ChannelDocumentRevisionSource } from './channel-document.js';

/**
 * #825：一次来源明确的 Agent 输出所产生的多份 Markdown 组成一个固定成员的文档包。
 *
 * Bundle 不是第二套正文/修订/编辑/恢复/发布模型：member 只保存 ChannelDocument 身份
 * 与纳入包时的 initialRevisionId，正文与修订权威始终是 ChannelDocument。
 * 成员在创建时冻结；后续新增 Markdown 不回填旧 Bundle。
 */
export type ProjectDocumentBundleSourceKind = 'workspace_run';

export interface ProjectDocumentBundleSourceDto {
  readonly kind: ProjectDocumentBundleSourceKind;
  readonly workspaceRunId: ID;
  readonly agentId: ID;
  /** 反查自 dispatch attempt；旧运行没有 management 接线时缺省。 */
  readonly invocationId?: ID;
  readonly taskId?: ID;
  readonly messageId?: ID;
  readonly sourceRoot?: ArtifactSourceRootDto;
  readonly runCreatedAt: UnixMs;
}

/** 成员加入包时冻结的事实，永不随文档修订变化。 */
export interface ProjectDocumentBundleMemberDto {
  readonly documentId: ID;
  readonly position: number;
  readonly initialRevisionId: ID;
  readonly initialRevisionNumber: number;
  readonly initialFilename: string;
}

/** 成员加入时的固定事实 + Server 计算的当前 revision 投影。 */
export interface ProjectDocumentBundleMemberViewDto extends ProjectDocumentBundleMemberDto {
  readonly current: ProjectDocumentBundleMemberCurrentDto | null;
}

export interface ProjectDocumentBundleMemberCurrentDto {
  readonly revisionId: ID;
  readonly revisionNumber: number;
  readonly filename: string;
  /** 当前 revision 由什么产生：附件、运行产物、人工编辑或恢复。 */
  readonly source: ChannelDocumentRevisionSource;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
  readonly changedSinceJoin: boolean;
}

export interface ProjectDocumentBundleDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly name: string;
  readonly source: ProjectDocumentBundleSourceDto;
  readonly memberCount: number;
  readonly createdBy: ID;
  readonly createdAt: UnixMs;
}

export interface ProjectDocumentBundleDetailDto extends ProjectDocumentBundleDto {
  readonly members: readonly ProjectDocumentBundleMemberViewDto[];
}

export interface ListProjectDocumentBundlesInput {
  userId?: ID;
  teamId: ID;
  channelId: ID;
}

export interface GetProjectDocumentBundleInput extends ListProjectDocumentBundlesInput {
  bundleId: ID;
}

export interface CreateProjectDocumentBundleInput extends ListProjectDocumentBundlesInput {
  idempotencyKey: string;
  name: string;
  workspaceRunId: ID;
  /** 显式成员；Server 不从文件名、目录或 mime 猜测应当包含哪些文档。 */
  documentIds: readonly ID[];
}

export interface ProjectDocumentBundleListResultDto {
  readonly bundles: readonly ProjectDocumentBundleDto[];
  readonly archived: boolean;
}

export interface ProjectDocumentBundleResultDto {
  readonly bundle: ProjectDocumentBundleDetailDto;
  readonly archived: boolean;
}
