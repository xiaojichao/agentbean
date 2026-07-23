import type { ID, UnixMs } from './common.js';
import type { MemoryCapsuleRefDto } from './management-memory.js';

export type ArtifactPathKind = 'upload' | 'workspace' | 'generated';
export type ArtifactRole = 'intermediate' | 'run_output' | 'deliverable' | 'attachment';
export type ArtifactSourceRootKind = 'run_output' | 'agent_workspace' | 'configured_output' | 'adapter_generated' | 'legacy_run';
export type WorkspaceRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ArtifactSourceRootDto {
  id: ID;
  kind: ArtifactSourceRootKind;
  label: string;
}
export type ArtifactPreviewStatus = 'pending' | 'processing' | 'ready' | 'failed' | 'unsupported';

export interface ArtifactPreviewDto {
  status: ArtifactPreviewStatus;
  url?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  updatedAt?: UnixMs;
}

export const DEFAULT_ARTIFACT_MAX_BYTES = 250 * 1024 * 1024;
export const DEFAULT_ARTIFACT_RUN_MAX_BYTES = 1024 * 1024 * 1024;

export type ArtifactSkipReason =
  | 'FILE_TOO_LARGE'
  | 'RUN_TOTAL_EXCEEDED'
  | 'COLLECTION_FAILED'
  | 'UPLOAD_FAILED';

export interface SkippedArtifactDiagnostic {
  filename: string;
  relativePath: string;
  sizeBytes: number;
  reason: ArtifactSkipReason;
}

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
  role?: ArtifactRole;
  sourceRoot?: ArtifactSourceRootDto;
  sha256?: string;
  createdAt: UnixMs;
  downloadUrl?: string;
  previewUrl?: string;
  preview?: ArtifactPreviewDto;
}

export interface WorkspaceRunDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  messageId?: ID;
  sourceMessageId?: ID;
  dispatchId: ID;
  agentId: ID;
  deviceId?: ID;
  status: WorkspaceRunStatus;
  cwd?: string;
  command?: string;
  logExcerpt?: string;
  exitCode?: number;
  startedAt?: UnixMs;
  completedAt?: UnixMs;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  artifactIds: ID[];
  managementInvocationId?: ID;
  memoryCapsuleRef?: MemoryCapsuleRefDto;
}
