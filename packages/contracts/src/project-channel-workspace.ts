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

export interface ProjectChannelWorkspaceRevisionDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  revision: number;
  files: ProjectChannelWorkspaceFileDto[];
  createdBy: ID;
  createdAt: UnixMs;
}

export interface ProjectChannelWorkspaceDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  currentRevisionId: ID;
  currentRevision: ProjectChannelWorkspaceRevisionDto;
}
