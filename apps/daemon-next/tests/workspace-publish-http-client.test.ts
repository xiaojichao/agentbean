import { describe, expect, test } from 'vitest';
import {
  createHttpWorkspaceStagingClient,
  createHttpWorkspaceStagingPutClient,
  fetchProjectChannelWorkspaceCurrent,
} from '../src/workspace-publish-http-client.js';

describe('workspace-publish-http-client (#1003 full HTTP)', () => {
  test('putChunk 以 raw body + query 调用 staging put 路由', async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string> }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({
        url,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({
        ok: true,
        staging: { files: [{ path: 'a.bin', receivedBytes: 4, complete: true }] },
      }), { status: 200 });
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
    expect(result.ok).toBe(true);
    expect(calls[0]!.url).toContain('/workspace-publish-staging/put');
    expect(calls[0]!.headers?.Authorization).toBe('Bearer tok');
  });

  test('putChunk 中文路径:header 百分号编码(query 仍是权威传输)', async () => {
    // 生产实证(2026-08-07):中文文件名「OpenSNS-能力与技能清单.md」直塞
    // x-workspace-path header,undici 以 ByteString 错误拒绝(header 只许 Latin-1),
    // 整个 publish 失败、dispatch 被标记 failed。
    const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      calls.push({
        url: typeof input === 'string' ? input : input.toString(),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(JSON.stringify({
        ok: true,
        staging: { files: [{ path: 'OpenSNS-能力与技能清单.md', receivedBytes: 4, complete: true }] },
      }), { status: 200 });
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
      path: 'OpenSNS-能力与技能清单.md',
      offset: 0,
      content: Buffer.from('data'),
    });
    expect(result.ok).toBe(true);
    // header 必须是 Latin-1 安全的编码形态;query 保持可读(由 server 以 query 为准)。
    expect(calls[0]!.headers?.['x-workspace-path']).toBe(encodeURIComponent('OpenSNS-能力与技能清单.md'));
    expect(decodeURIComponent(calls[0]!.headers!['x-workspace-path']!)).toBe('OpenSNS-能力与技能清单.md');
    expect(calls[0]!.url).toContain(`path=${encodeURIComponent('OpenSNS-能力与技能清单.md')}`);
  });

  test('begin/get/commit 走 JSON HTTP', async () => {
    const paths: string[] = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      paths.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('/begin')) {
        return new Response(JSON.stringify({
          ok: true,
          staging: { status: 'open', files: [{ path: 'a', receivedBytes: 0, complete: false }] },
        }), { status: 200 });
      }
      if (url.includes('/commit')) {
        return new Response(JSON.stringify({
          ok: true,
          staging: { status: 'committed', committedRevisionId: 'rev-2' },
          workspace: {
            currentRevisionId: 'rev-2',
            currentRevision: { id: 'rev-2', files: [{ path: 'a', artifactId: 'art-1' }] },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        ok: true,
        staging: { status: 'open', files: [{ path: 'a', receivedBytes: 0, complete: false }] },
      }), { status: 200 });
    };

    const client = createHttpWorkspaceStagingClient({
      serverUrl: 'http://s',
      token: 't',
      fetch: fetchMock,
    });
    await expect(client.begin({
      publishId: 'p', teamId: 't1', channelId: 'c1', baselineRevisionId: 'r1',
      files: [{ path: 'a', filename: 'a', mimeType: 'text/plain', expectedSizeBytes: 1, expectedSha256: 'a'.repeat(64) }],
    })).resolves.toMatchObject({ ok: true });
    await expect(client.get({ publishId: 'p', teamId: 't1', channelId: 'c1' }))
      .resolves.toMatchObject({ ok: true });
    await expect(client.commit({ publishId: 'p', teamId: 't1', channelId: 'c1' }))
      .resolves.toMatchObject({
        ok: true,
        workspace: { currentRevisionId: 'rev-2' },
      });
    expect(paths.some((p) => p.includes('/begin'))).toBe(true);
    expect(paths.some((p) => p.includes('/commit'))).toBe(true);
    expect(paths.some((p) => p.includes('workspace-publish-staging?') || p.includes('workspace-publish-staging&') || p.includes('publishId=p'))).toBe(true);
  });

  test('fetchProjectChannelWorkspaceCurrent 解析 currentRevisionId', async () => {
    const result = await fetchProjectChannelWorkspaceCurrent({
      serverUrl: 'http://s',
      token: 't',
      teamId: 'team',
      channelId: 'ch',
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        workspace: { currentRevisionId: 'rev-cur', currentRevision: { id: 'rev-cur' } },
      }), { status: 200 }),
    });
    expect(result).toEqual({ ok: true, currentRevisionId: 'rev-cur' });
  });

  test('HTTP 错误映射为 ok:false', async () => {
    const client = createHttpWorkspaceStagingClient({
      serverUrl: 'http://localhost:9',
      token: 'tok',
      fetch: async () => new Response(JSON.stringify({ ok: false, error: 'VALIDATION_ERROR' }), { status: 400 }),
    });
    await expect(client.putChunk({
      teamId: 't', channelId: 'c', publishId: 'p', path: 'a', offset: 0, content: Buffer.from('x'),
    })).resolves.toEqual({ ok: false, error: 'VALIDATION_ERROR' });
  });
});
