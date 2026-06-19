import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { downloadAttachments, safeAttachmentFilename } from '../src/attachments';

describe('attachments', () => {
  test('safeAttachmentFilename strips path and unsafe chars', () => {
    expect(safeAttachmentFilename('report.pdf')).toBe('report.pdf');
    expect(safeAttachmentFilename('../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentFilename('a b/c.txt')).toBe('c.txt');
    expect(safeAttachmentFilename('中文文件.json')).toBe('.json');
  });

  test('downloadAttachments fetches each attachment into inputDir with id-prefixed name', async () => {
    const inputDir = realpathSync(mkdtempSync(join(tmpdir(), 'attachments-')));
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      const id = url.match(/artifacts\/([^/]+)\/download$/)?.[1] ?? 'unknown';
      return new Response(`${id}-body`, { status: 200 });
    };

    const downloaded = await downloadAttachments(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', inputDir, fetch: fakeFetch },
      [
        { id: 'att-1', name: 'a.txt', mimeType: 'text/plain', sizeBytes: 8 },
        { id: 'att-2', name: '../b.json' },
      ],
    );

    expect(downloaded).toHaveLength(2);
    expect(downloaded[0].localPath).toBe(join(inputDir, 'att-1-a.txt'));
    expect(readFileSync(downloaded[0].localPath, 'utf8')).toBe('att-1-body');
    expect(downloaded[1].localPath).toBe(join(inputDir, 'att-2-b.json'));
    expect(calls[0]).toContain('/api/teams/team-1/artifacts/att-1/download');
  });

  test('downloadAttachments skips attachments whose download fails (non-ok), keeps the rest', async () => {
    const inputDir = realpathSync(mkdtempSync(join(tmpdir(), 'attachments-')));
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('att-bad')) {
        return new Response('nope', { status: 404 });
      }
      return new Response('ok', { status: 200 });
    };

    const downloaded = await downloadAttachments(
      { serverUrl: 'http://server.test', token: 'tok', teamId: 'team-1', inputDir, fetch: fakeFetch },
      [
        { id: 'att-good', name: 'g.txt' },
        { id: 'att-bad', name: 'x.txt' },
      ],
    );

    expect(downloaded.map((d) => d.id)).toEqual(['att-good']);
  });
});
