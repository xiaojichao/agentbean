import { NextRequest, NextResponse } from 'next/server';

const configuredServerUrl = process.env.AGENT_BEAN_SERVER_URL
  ?? process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL
  ?? 'http://localhost:4000';

function serverUrl(path: string): string {
  return `${configuredServerUrl.replace(/\/+$/, '')}${path}`;
}

export async function proxyArtifactUpload(req: NextRequest, teamId: string) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const headers = new Headers();
  const contentType = req.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const contentLength = req.headers.get('content-length');
  if (contentLength) headers.set('content-length', contentLength);
  if (token) headers.set('authorization', `Bearer ${token}`);
  const upstream = await fetch(serverUrl(`/api/teams/${encodeURIComponent(teamId)}/artifacts/upload`), {
    method: 'POST',
    headers,
    body: req.body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get('content-type');
  if (upstreamContentType) responseHeaders.set('content-type', upstreamContentType);
  return new NextResponse(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
