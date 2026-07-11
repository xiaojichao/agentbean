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

function authedApiUrl(serverUrl: string, path: string, token: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${serverUrl}${path}${sep}token=${encodeURIComponent(token)}`;
}
