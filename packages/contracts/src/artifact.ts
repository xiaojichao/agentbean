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
