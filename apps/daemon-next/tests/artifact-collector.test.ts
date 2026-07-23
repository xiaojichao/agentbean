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

  test('extra output dirs collect Codex-native generated images by mtime', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    const generatedImagesDir = join(cwd, 'codex-generated-images', 'run-1');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(generatedImagesDir, { recursive: true });
    await touch(join(generatedImagesDir, 'old.png'), 1000);
    await touch(join(generatedImagesDir, 'ig_abc123.png'), 5000);

    const collected = await collectArtifacts({
      outputDir,
      cwd,
      extraOutputDirs: [join(cwd, 'codex-generated-images')],
      startedAt: 3000,
    });

    const names = collected.map((c) => c.filename);
    expect(names).toContain('ig_abc123.png');
    expect(names).not.toContain('old.png');
  });

  test('extra output dirs do not let many old files hide a new generated image', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    const generatedImagesDir = join(cwd, 'codex-generated-images');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(generatedImagesDir, { recursive: true });
    for (let i = 0; i < 2005; i += 1) {
      await touch(join(generatedImagesDir, `old-${i}.png`), 1000);
    }
    await touch(join(generatedImagesDir, 'ig_new.png'), 5000);

    const collected = await collectArtifacts({
      outputDir,
      cwd,
      extraOutputDirs: [generatedImagesDir],
      startedAt: 3000,
    });

    expect(collected.map((c) => c.filename)).toContain('ig_new.png');
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

  test('keeps distinct relative paths even when file content is identical', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'image-001.png'), 'same-bytes');
    mkdirSync(join(outputDir, 'sub'), { recursive: true });
    await touch(join(outputDir, 'sub', 'zzz.png'), 5000);
    writeFileSync(join(outputDir, 'sub', 'zzz.png'), 'same-bytes');

    const collected = await collectArtifacts({ outputDir, cwd, startedAt: 1000 });
    const sameContent = collected.filter((c) => c.sha256 === collected[0].sha256);
    expect(sameContent).toHaveLength(2);
    expect(sameContent.map((artifact) => artifact.relativePath).sort()).toEqual([
      'image-001.png',
      join('sub', 'zzz.png'),
    ]);
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

  test('skips files larger than maxBytes before hashing', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, 'big.zip'), 'x'.repeat(50));
    writeFileSync(join(outputDir, 'small.txt'), 'ok');

    const diagnostics: string[] = [];
    const collected = await collectArtifacts({
      outputDir,
      cwd,
      startedAt: 0,
      maxBytes: 10,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    expect(collected.map((c) => c.filename)).toEqual(['small.txt']);
    expect(diagnostics).toContain('ARTIFACT_FILE_TOO_LARGE');
  });

  test('keeps same relative files independent across source roots and assigns explicit roles', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const outputDir = join(cwd, 'outputs');
    const configuredDir = join(cwd, 'deliverables');
    mkdirSync(outputDir, { recursive: true });
    mkdirSync(configuredDir, { recursive: true });
    writeFileSync(join(outputDir, 'report.md'), 'same');
    writeFileSync(join(configuredDir, 'report.md'), 'same');

    const collected = await collectArtifacts({
      outputDir,
      configuredOutputRoots: [{ id: 'deliverables', path: configuredDir, label: '交付目录', defaultRole: 'deliverable' }],
      startedAt: 0,
    });

    const reports = collected.filter((artifact) => artifact.filename === 'report.md');
    expect(reports).toHaveLength(2);
    expect(new Set(reports.map((artifact) => artifact.sourceRoot.id)).size).toBe(2);
    expect(reports.map((artifact) => artifact.role).sort()).toEqual(['deliverable', 'run_output']);
    expect(reports.find((artifact) => artifact.role === 'deliverable')?.sourceRoot.id).toBe('deliverables');
    expect(reports.every((artifact) => !artifact.absolutePath.includes('AGENTBEAN_OUTPUT_DIR'))).toBe(true);
  });
});
