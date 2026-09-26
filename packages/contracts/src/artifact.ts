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

const SAFE_ARTIFACT_INLINE_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/csv',
  'text/markdown',
  'text/plain',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'audio/ogg',
]);

const ARTIFACT_PREVIEW_DERIVATIVE_MIME_TYPES = new Set([
  'application/pdf',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/wav',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);

export function normalizeArtifactMimeType(mimeType: string): string {
  return mimeType.toLowerCase().split(';', 1)[0]?.trim() ?? '';
}

const TEXT_ARTIFACT_EXTENSIONS = new Set([
  'bat', 'c', 'cc', 'cfg', 'cmd', 'conf', 'cpp', 'cs', 'css', 'csv', 'dart', 'dockerfile', 'env',
  'ex', 'exs', 'gql', 'go', 'gradle', 'graphql', 'h', 'hcl', 'hpp', 'hs', 'html', 'ini', 'java',
  'js', 'jsx', 'json', 'kt', 'less', 'lock', 'log', 'make', 'markdown', 'md', 'mdx', 'mjs', 'cjs',
  'mk', 'pl', 'php', 'properties', 'proto', 'ps1', 'py', 'r', 'rb', 'rst', 'rs', 'sass', 'scss',
  'sh', 'sql', 'svelte', 'swift', 'tf', 'toml', 'ts', 'tsx', 'txt', 'vue', 'xml', 'xsd', 'xsl',
  'yaml', 'yml', 'zsh',
]);

/** Maximum source size accepted by inline text previews and editors. */
export const MAX_TEXT_ARTIFACT_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Text files can be fetched and edited as UTF-8 source; never use this to render HTML as markup. */
export function isTextArtifact(artifact: { filename: string; mimeType: string }): boolean {
  const mimeType = normalizeArtifactMimeType(artifact.mimeType);
  if (mimeType.startsWith('image/') || mimeType.startsWith('audio/') || mimeType.startsWith('video/')
    || mimeType === 'application/pdf') return false;
  if (mimeType.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType.endsWith('+json') || mimeType.endsWith('+xml')) return true;
  const extension = artifact.filename.toLowerCase().split('.').at(-1) ?? '';
  return TEXT_ARTIFACT_EXTENSIONS.has(extension);
}

export function isSafeArtifactInlinePreviewMimeType(mimeType: string): boolean {
  return SAFE_ARTIFACT_INLINE_MIME_TYPES.has(normalizeArtifactMimeType(mimeType));
}

export function supportsArtifactPreviewDerivativeMimeType(mimeType: string): boolean {
  return ARTIFACT_PREVIEW_DERIVATIVE_MIME_TYPES.has(normalizeArtifactMimeType(mimeType));
}

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
  preview?: ArtifactPreviewDto;
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
