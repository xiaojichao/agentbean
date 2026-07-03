import type { Artifact } from './schema';

type ArtifactUrlKind = 'preview' | 'download';

export function chatArtifactUrl(
  artifact: Artifact,
  kind: ArtifactUrlKind,
  options: { serverUrl: string; token: string; teamId?: string },
): string | null {
  const explicitPath = kind === 'preview' ? artifact.previewUrl : artifact.downloadUrl;
  const path = explicitPath ?? fallbackArtifactPath(artifact, kind, options.teamId);
  if (!path) return null;
  const sep = path.includes('?') ? '&' : '?';
  return `${options.serverUrl}${path}${sep}token=${encodeURIComponent(options.token)}`;
}

function fallbackArtifactPath(artifact: Artifact, kind: ArtifactUrlKind, teamId?: string): string | null {
  const ownerTeamId = artifact.teamId ?? teamId;
  if (!ownerTeamId || !artifact.id) return null;
  return `/api/teams/${encodeURIComponent(ownerTeamId)}/artifacts/${encodeURIComponent(artifact.id)}/${kind}`;
}
