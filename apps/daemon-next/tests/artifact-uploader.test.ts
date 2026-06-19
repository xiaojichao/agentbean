import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { uploadArtifacts } from '../src/artifact-uploader';
import type { CollectedArtifact } from '../src/artifact-collector';

function makeArtifact(dir: string, filename: string, content: string): CollectedArtifact {
  const absolutePath = join(dir, filename);
  writeFileSync(absolutePath, content);
  return {
    absolutePath,
    relativePath: `outputs/${filename}`,
    sha256: `sha-${filename}`,
    sizeBytes: content.length,
    filename,
  };
}

describe('artifact-uploader', () => {
  test('uploads each artifact via multipart and returns ids', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const collected = [makeArtifact(dir, 'a.png', 'pic'), makeArtifact(dir, 'b.txt', 'text')];
    const seenBodies: string[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      seenBodies.push(String((init?.body as FormData)?.get('channelId')));
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      const id = `id-${file.name}`;
      return new Response(JSON.stringify({ ok: true, artifact: { id } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch },
      collected,
    );

    expect(uploaded.map((u) => u.id).sort()).toEqual(['id-a.png', 'id-b.txt']);
    expect(uploaded[0]).toMatchObject({ filename: 'a.png', pathKind: 'generated', sha256: 'sha-a.png' });
    expect(seenBodies).toEqual(['chan-1', 'chan-1']);
  });

  test('retries up to maxRetries then skips a persistently failing artifact', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const collected = [makeArtifact(dir, 'flaky.png', 'x')];
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts += 1;
      return new Response('err', { status: 500 });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch, maxRetries: 2 },
      collected,
    );

    expect(uploaded).toEqual([]);
    expect(attempts).toBe(3);
  });

  test('succeeds on retry after a transient failure', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const collected = [makeArtifact(dir, 'c.png', 'x')];
    let attempts = 0;
    const fakeFetch: typeof fetch = async (_input, init) => {
      attempts += 1;
      if (attempts === 1) {
        return new Response('err', { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true, artifact: { id: 'id-c' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch, maxRetries: 2 },
      collected,
    );

    expect(uploaded.map((u) => u.id)).toEqual(['id-c']);
    expect(attempts).toBe(2);
  });

  test('skips artifacts larger than maxBytes', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'up-')));
    const big = makeArtifact(dir, 'big.zip', 'x'.repeat(50));
    const small = makeArtifact(dir, 'small.txt', 'y');
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ ok: true, artifact: { id: 'id' } }), { status: 201 });
    };

    const uploaded = await uploadArtifacts(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', channelId: 'chan-1', fetch: fakeFetch, maxBytes: 20 },
      [big, small],
    );

    expect(uploaded.map((u) => u.filename)).toEqual(['small.txt']);
  });
});
