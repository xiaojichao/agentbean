import type { ID, UnixMs } from './common.js';

export type ArtifactPathKind = 'upload' | 'workspace' | 'generated';
export type WorkspaceRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ArtifactDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  messageId?: ID;
  dispatchId?: ID;
  workspaceRunId?: ID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  relativePath?: string;
  pathKind?: ArtifactPathKind;
  sha256?: string;
  createdAt: UnixMs;
  downloadUrl?: string;
  previewUrl?: string;
}

export interface WorkspaceRunDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  messageId?: ID;
  dispatchId: ID;
  agentId: ID;
  deviceId?: ID;
  status: WorkspaceRunStatus;
  cwd?: string;
  exitCode?: number;
  startedAt?: UnixMs;
  completedAt?: UnixMs;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  artifactIds: ID[];
}
