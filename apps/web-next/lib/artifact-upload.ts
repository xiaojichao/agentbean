import { DEFAULT_ARTIFACT_MAX_BYTES } from '@agentbean/contracts';

const configuredMaxArtifactBytes = Number(process.env.NEXT_PUBLIC_AGENT_BEAN_MAX_ARTIFACT_BYTES ?? '');

export const artifactUploadMaxBytes = Number.isSafeInteger(configuredMaxArtifactBytes) && configuredMaxArtifactBytes > 0
  ? configuredMaxArtifactBytes
  : DEFAULT_ARTIFACT_MAX_BYTES;

export function artifactUploadUrl(serverUrl: string, teamId: string, token: string): string {
  return authedApiUrl(serverUrl, `/api/teams/${encodeURIComponent(teamId)}/artifacts/upload`, token);
}

export function artifactUploadProxyUrl(teamId: string, token: string): string {
  return `/api/teams/${encodeURIComponent(teamId)}/artifacts/upload?token=${encodeURIComponent(token)}`;
}

export function artifactUploadFallbackUrls(serverUrl: string, teamId: string, token: string): string[] {
  const urls = [
    artifactUploadUrl(serverUrl, teamId, token),
    artifactUploadProxyUrl(teamId, token),
  ];
  return [...new Set(urls)];
}

export function assertArtifactUploadWithinLimit(form: FormData, maxBytes = artifactUploadMaxBytes): void {
  for (const value of form.values()) {
    if (typeof File !== 'undefined' && value instanceof File && value.size > maxBytes) {
      throw new Error(`附件 ${value.name} 超过 ${formatByteLimit(maxBytes)} 上传上限`);
    }
  }
}

function formatByteLimit(bytes: number): string {
  if (bytes < 1024 * 1024) return `${bytes} B`;
  const megabytes = bytes / (1024 * 1024);
  return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

function authedApiUrl(serverUrl: string, path: string, token: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${serverUrl}${path}${sep}token=${encodeURIComponent(token)}`;
}
