import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectArtifacts } from '../src/artifact-collector';

async function touch(path: string, mtimeMs: number): Promise<void> {
  writeFileSync(path, 'x');
  const seconds = Math.floor(mtimeMs / 1000);
  utimesSync(path, seconds, seconds);
}

describe('artifact-collector', () => {
  test('collects all matching files from outputs dir regardless of mtime', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'a.png'), 'pic');
    writeFileSync(join(outputDir, 'b.txt'), 'text');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    const names = collected.map((c) => c.filename).sort();
    expect(names).toEqual(['a.png', 'b.txt']);
  });

  test('ignores files without whitelisted extension', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'keep.pdf'), 'p');
    writeFileSync(join(outputDir, 'skip.exe'), 'x');
    writeFileSync(join(outputDir, 'skip.log'), 'x');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    expect(collected.map((c) => c.filename)).toEqual(['keep.pdf']);
  });

  test('cwd fallback scan only picks files with mtime > startedAt', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    await touch(join(cwd, 'old.json'), 1000);
    await touch(join(cwd, 'new.json'), 5000);

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 3000 });
    const names = collected.map((c) => c.filename);
    expect(names).toContain('new.json');
    expect(names).not.toContain('old.json');
  });

  test('cwd fallback skips ignored dirs like node_modules and .agentbean', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(join(cwd, 'node_modules'), { recursive: true });
    mkdirSync(join(cwd, '.agentbean', 'runs', 'r'), { recursive: true });
    await touch(join(cwd, 'node_modules', 'leak.png'), 5000);
    await touch(join(cwd, '.agentbean', 'runs', 'r', 'nested.png'), 5000);

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    expect(collected.map((c) => c.filename)).not.toContain('leak.png');
    expect(collected.map((c) => c.filename)).not.toContain('nested.png');
  });

  test('dedupes by sha256, keeping the more semantic filename', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'image-001.png'), 'same-bytes');
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    await touch(join(cwd, 'sub', 'zzz.png'), 5000);
    writeFileSync(join(cwd, 'sub', 'zzz.png'), 'same-bytes');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    const sameContent = collected.filter((c) => c.sha256 === collected[0].sha256);
    expect(sameContent).toHaveLength(1);
    expect(collected.length).toBeLessThanOrEqual(2);
  });

  test('fills sha256 and sizeBytes', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'a.txt'), 'hello');
    const [collected] = await collectArtifacts({ outputDir, cwd, startedAt: 0 });
    expect(collected.sizeBytes).toBe(5);
    expect(collected.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
