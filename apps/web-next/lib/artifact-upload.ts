export function artifactUploadUrl(serverUrl: string, networkId: string, token: string): string {
  return authedApiUrl(serverUrl, `/api/teams/${encodeURIComponent(networkId)}/artifacts/upload`, token);
}

export function artifactUploadProxyUrl(networkId: string, token: string): string {
  return `/api/teams/${encodeURIComponent(networkId)}/artifacts/upload?token=${encodeURIComponent(token)}`;
}

export function artifactUploadFallbackUrls(serverUrl: string, networkId: string, token: string): string[] {
  const urls = [
    artifactUploadUrl(serverUrl, networkId, token),
    artifactUploadProxyUrl(networkId, token),
  ];
  return [...new Set(urls)];
}

function authedApiUrl(serverUrl: string, path: string, token: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${serverUrl}${path}${sep}token=${encodeURIComponent(token)}`;
}
