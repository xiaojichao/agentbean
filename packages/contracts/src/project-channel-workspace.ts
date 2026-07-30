import type { ID, UnixMs } from './common.js';

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
