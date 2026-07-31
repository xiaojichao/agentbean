import { describe, expect, test } from 'vitest';
import { createHttpWorkspaceStagingPutClient } from '../src/workspace-publish-http-client.js';

describe('workspace-publish-http-client (#967 hardening)', () => {
  test('putChunk 以 raw body + query 调用 staging put 路由', async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: ArrayBuffer | Uint8Array }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({
        url,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: init?.body as Uint8Array,
      });
      return new Response(JSON.stringify({
        ok: true,
        staging: { files: [{ path: 'a.bin', receivedBytes: 4, complete: true }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const client = createHttpWorkspaceStagingPutClient({
      serverUrl: 'http://localhost:9',
      token: 'tok',
      fetch: fetchMock,
    });
    const result = await client.putChunk({
      teamId: 'team-1',
      channelId: 'ch-1',
      publishId: 'pub-1',
      path: 'a.bin',
      offset: 0,
      content: Buffer.from('data'),
    });
    expect(result).toEqual({
      ok: true,
      staging: { files: [{ path: 'a.bin', receivedBytes: 4, complete: true }] },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/api/teams/team-1/workspace-publish-staging/put');
    expect(calls[0]!.url).toContain('publishId=pub-1');
    expect(calls[0]!.url).toContain('offset=0');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers?.Authorization).toBe('Bearer tok');
    expect(Buffer.from(calls[0]!.body as Uint8Array).toString()).toBe('data');
  });

  test('HTTP 错误映射为 ok:false', async () => {
    const client = createHttpWorkspaceStagingPutClient({
      serverUrl: 'http://localhost:9',
      token: 'tok',
      fetch: async () => new Response(JSON.stringify({ ok: false, error: 'VALIDATION_ERROR' }), { status: 400 }),
    });
    await expect(client.putChunk({
      teamId: 't', channelId: 'c', publishId: 'p', path: 'a', offset: 0, content: Buffer.from('x'),
    })).resolves.toEqual({ ok: false, error: 'VALIDATION_ERROR' });
  });
});
