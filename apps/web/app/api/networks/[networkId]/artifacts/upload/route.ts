import { NextRequest, NextResponse } from 'next/server';

const configuredServerUrl = process.env.AGENT_BEAN_SERVER_URL
  ?? process.env.NEXT_PUBLIC_AGENT_BEAN_SERVER_URL
  ?? 'http://localhost:4000';

function serverUrl(path: string): string {
  return `${configuredServerUrl.replace(/\/+$/, '')}${path}`;
}

export async function POST(req: NextRequest, { params }: { params: { networkId: string } }) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const form = await req.formData();
  const upstream = await fetch(serverUrl(`/api/networks/${encodeURIComponent(params.networkId)}/artifacts/upload`), {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  const body = await upstream.arrayBuffer();
  const contentType = upstream.headers.get('content-type');
  return new NextResponse(body, {
    status: upstream.status,
    headers: contentType ? { 'content-type': contentType } : undefined,
  });
}
