import type { ID, UnixMs } from './common.js';
import type { ArtifactRole } from './artifact.js';

/** A complete, immutable file manifest for one Project Channel Workspace revision. */
export interface ProjectChannelWorkspaceFileDto {
  path: string;
  artifactId: ID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
}

/**
 * Provenance for a workspace revision created via device import.
 * Records which device initiated the import without exposing device absolute paths.
 */
export interface WorkspaceImportProvenanceDto {
  readonly kind: 'import';
  /** Device that performed the import. */
  readonly sourceDeviceId: ID;
  /** When the import happened (server-assigned timestamp). */
  readonly importedAt: UnixMs;
}

/**
 * #966 Provenance for a workspace revision created via atomic publish by an Agent.
 * Records the delivering Agent/Task attempt and the baseline revision it was based on,
 * so members can trace any published file back to its source Task/Agent.
 */
export interface WorkspacePublishProvenanceDto {
  readonly kind: 'publish';
  /** Agent that delivered this revision. */
  readonly agentId: ID;
  /** Task attempt that produced this delivery. */
  readonly taskId: ID;
  readonly taskAttempt: number;
  /** Workspace revision the Agent read as its fixed input (baseline). */
  readonly baselineRevisionId: ID;
  /** When the publish happened (server-assigned timestamp). */
  readonly publishedAt: UnixMs;
}

/** Discriminated provenance for a workspace revision. */
export type WorkspaceRevisionProvenanceDto = WorkspaceImportProvenanceDto | WorkspacePublishProvenanceDto;

export interface ProjectChannelWorkspaceRevisionDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  revision: number;
  files: ProjectChannelWorkspaceFileDto[];
  createdBy: ID;
  createdAt: UnixMs;
  /** Set when this revision was created via device import (#964) or atomic Agent publish (#966). */
  provenance?: WorkspaceRevisionProvenanceDto;
}

export interface ProjectChannelWorkspaceDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  currentRevisionId: ID;
  currentRevision: ProjectChannelWorkspaceRevisionDto;
}

/**
 * #969 归档导出中一项交付物的元数据与 provenance。
 *
 * 只含 artifact 元数据（不含 blob 字节）——客户端经既有 artifact 端点按 artifactId 取内容。
 * provenance 锚点：workspaceRunId（产出执行）+ sha256（内容校验）+ createdAt。
 */
export interface ArchiveExportDeliverableDto {
  artifactId: ID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  role: ArtifactRole;
  sha256?: string;
  /** 产出该交付物的 workspace run。 */
  workspaceRunId?: ID;
  createdAt: UnixMs;
}

/**
 * #969 Project Channel Workspace 归档导出的封存清单（只读副本）。
 *
 * 由拥有频道治理权限的人类请求：冻结的最后 revision + 已发布交付物 + 必要 provenance。
 * 导出只装配既有授权可读数据——不恢复频道、不扩大权限、不改变任何状态。
 */
export interface ArchiveExportManifestDto {
  teamId: ID;
  channelId: ID;
  /** 导出时刻（server 赋值）。 */
  exportedAt: UnixMs;
  /** 发起导出的治理者。 */
  exportedByUserId: ID;
  /** 冻结的最后（当前）revision，含其 import provenance。 */
  revision: ProjectChannelWorkspaceRevisionDto;
  /** 已发布交付物（role=deliverable），按当前授权可读。 */
  deliverables: ArchiveExportDeliverableDto[];
}

/**
 * #968 One file a local user has chosen to apply back to a local directory.
 * Mirrors the relevant subset of ProjectChannelWorkspaceFileDto (no mimeType needed
 * for a disk write). The server never learns the target absolute path.
 */
export interface WorkspaceApplyFileEntryDto {
  path: string;
  artifactId: ID;
  filename: string;
  sizeBytes: number;
  sha256?: string;
}

/** #968 Why a revision file cannot be applied at its path. */
export type WorkspaceApplyConflictReasonDto = 'LOCAL_FILE_EXISTS';

export interface WorkspaceApplyConflictDto {
  path: string;
  reason: WorkspaceApplyConflictReasonDto;
}

/**
 * #968 Preview of applying a published revision to a local directory.
 * Pure result of diffing a revision manifest against a local listing — no I/O,
 * no device provenance, so it is source-Device independent by construction.
 */
export interface WorkspaceApplyPlanDto {
  toWrite: WorkspaceApplyFileEntryDto[];
  conflicts: WorkspaceApplyConflictDto[];
}
