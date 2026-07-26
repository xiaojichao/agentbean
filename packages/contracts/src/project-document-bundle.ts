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

/**
 * #830：建包失败的结构化原因。放进 FailureAck.details 后，调用方（回填、Web）
 * 不必解析人类可读 message 就能精确归因 —— 回填的原因码统计正是建立在它之上。
 */
export type ProjectDocumentBundleFailureReason =
  | 'not_team_member'
  | 'invalid_request'
  | 'idempotency_conflict'
  | 'channel_archived'
  | 'actor_not_authorized'
  | 'run_unavailable'
  | 'run_not_public'
  | 'invocation_task_unavailable'
  | 'invocation_stale'
  | 'members_unavailable'
  | 'members_ineligible'
  | 'member_scope_conflict'
  | 'bundle_unavailable';

/** 逐成员原因码。code 在合同层是不透明字符串，权威取值由 domain 成员资格策略给出。 */
export interface ProjectDocumentBundleMemberRejectionDto {
  readonly documentId: ID;
  readonly code: string;
}

export interface ProjectDocumentBundleFailureDetailsDto {
  readonly reason: ProjectDocumentBundleFailureReason;
  readonly rejections?: readonly ProjectDocumentBundleMemberRejectionDto[];
}

/** dry_run 只裁决并记录，不写任何 Bundle；apply 才落库。 */
export type ProjectDocumentBundleBackfillMode = 'dry_run' | 'apply';

/**
 * #830 回填报告。只含计数与稳定原因码 —— 不含正文、文件名、相对路径或设备绝对路径，
 * 因此可以安全地随运维指标端点一起暴露。
 */
export interface ProjectDocumentBundleBackfillReportDto {
  readonly mode: ProjectDocumentBundleBackfillMode;
  /** 全部候选 Run 已裁决完毕。 */
  readonly completed: boolean;
  /** 已裁决的候选 Run 总数。 */
  readonly candidates: number;
  /** 证明可以成包的 Run 数；dry_run 下即「将会创建」。 */
  readonly backfillable: number;
  /** 实际写入的 Bundle 数；dry_run 恒为 0。 */
  readonly created: number;
  /** 已有 Bundle（人工创建或前一轮回填），本轮不改动。 */
  readonly existing: number;
  /** 来源事实矛盾或成员集不可证，保持未分组。 */
  readonly ambiguous: number;
  /** 有明确、非歧义原因被排除。 */
  readonly skipped: number;
  /** 未预期错误；这些候选会在后续批次重试。 */
  readonly failed: number;
  /** 原因码直方图。 */
  readonly reasons: Readonly<Record<string, number>>;
}

export interface ProjectDocumentBundleListResultDto {
  readonly bundles: readonly ProjectDocumentBundleDto[];
  readonly archived: boolean;
}

export interface ProjectDocumentBundleResultDto {
  readonly bundle: ProjectDocumentBundleDetailDto;
  readonly archived: boolean;
}
