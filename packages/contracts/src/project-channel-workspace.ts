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
 * Minimal provenance for a workspace import.
 * Records which device initiated the import without exposing device absolute paths.
 */
export interface WorkspaceImportProvenanceDto {
  /** Device that performed the import. */
  sourceDeviceId: ID;
  /** When the import happened (server-assigned timestamp). */
  importedAt: UnixMs;
}

export interface ProjectChannelWorkspaceRevisionDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  revision: number;
  files: ProjectChannelWorkspaceFileDto[];
  createdBy: ID;
  createdAt: UnixMs;
  /** Set when this revision was created via device import; absent for purely server-side creations. */
  provenance?: WorkspaceImportProvenanceDto;
}

export interface ProjectChannelWorkspaceDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  currentRevisionId: ID;
  currentRevision: ProjectChannelWorkspaceRevisionDto;
}
