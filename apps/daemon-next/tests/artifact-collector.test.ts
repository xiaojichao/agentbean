import { mkdirSync, mkdtempSync, realpathSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { collectArtifacts, extractReportedOutputPaths, shouldCollectWindowedFile } from '../src/artifact-collector';

async function touch(path: string, mtimeMs: number): Promise<void> {
  writeFileSync(path, 'x');
  const seconds = Math.floor(mtimeMs / 1000);
  utimesSync(path, seconds, seconds);
}

describe('artifact-collector', () => {
  describe('extractReportedOutputPaths', () => {
    test('提取回复中明确报告的交付文件路径并去重', () => {
      const body = [
        '搞定！总结文件已生成，保存在桌面上：',
        '',
        '/Users/shaw/Desktop/短视频二次创作总结.md',
        '',
        '参考了 /Users/shaw/notes.md 与 https://example.com/a.pdf',
        '已保存到：/Users/shaw/Documents/report.md。',
      ].join('\n');
      expect(extractReportedOutputPaths(body)).toEqual([
        '/Users/shaw/Desktop/短视频二次创作总结.md',
        '/Users/shaw/notes.md',
        '/Users/shaw/Documents/report.md',
      ]);
    });

    test('忽略非交付扩展名、相对路径、缺失正文并处理尾部标点', () => {
      expect(extractReportedOutputPaths('参考 /Users/a/state.json，路径 /Users/a/tmp.log')).toEqual([]);
      expect(extractReportedOutputPaths('使用 docs/a.md 作为模板')).toEqual([]);
      expect(extractReportedOutputPaths('文件在：/Users/x/报告.md。')).toEqual(['/Users/x/报告.md']);
      expect(extractReportedOutputPaths('a\n/Users/x/a.md\nb\n/Users/x/a.md')).toEqual(['/Users/x/a.md']);
      expect(extractReportedOutputPaths(undefined)).toEqual([]);
    });
  });

  test('collectArtifacts 收集回复报告的交付文件（任意目录 + 窗口/内部路径过滤）', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const desktopDir = join(cwd, 'Desktop');
    mkdirSync(desktopDir, { recursive: true });
    const target = join(desktopDir, '短视频二次创作总结.md');
    await touch(target, 5000);
    await touch(join(desktopDir, 'old.md'), 500);
    const internal = join(cwd, '.agentbean', 'runs', 'r', 'internal.md');
    mkdirSync(join(cwd, '.agentbean', 'runs', 'r'), { recursive: true });
    await touch(internal, 5000);

    const collected = await collectArtifacts({
      outputDir,
      reportedOutputPaths: [target, join(desktopDir, 'old.md'), join(desktopDir, 'missing.md'), internal],
      startedAt: 1000,
    });

    expect(collected.map((artifact) => artifact.filename)).toEqual(['短视频二次创作总结.md']);
    expect(collected[0]!.sourceRoot).toEqual({
      id: 'agent-reported-outputs', kind: 'adapter_generated', label: 'Agent 报告的输出',
    });
    expect(collected[0]!.role).toBe('run_output');
  });

  test('回复报告与 adapter 根收集同一文件时去重', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-reported-dedupe-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const target = join(cwd, '交付.md');
    await touch(target, 5000);

    const collected = await collectArtifacts({
      outputDir,
      adapterOutputRoots: [{ dir: cwd, recursive: false }],
      reportedOutputPaths: [target],
      startedAt: 1000,
    });

    expect(collected.filter((artifact) => artifact.absolutePath === target)).toHaveLength(1);
  });

  test('shouldCollectWindowedFile 只收 run 窗口内新建的共享目录文件', () => {
    const startedAt = Date.now() - 60_000;
    // 窗口内新建：mtime 与 birthtime 都在窗口内 → 收集。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: Date.now(), startedAt, createdInWindow: true,
    })).toBe(true);
    // 窗口外 mtime → 不收集。
    expect(shouldCollectWindowedFile({
      mtimeMs: startedAt - 1000, birthtimeMs: Date.now(), startedAt, createdInWindow: true,
    })).toBe(false);
    // 既有文件仅被修改（birthtime 早于窗口，mtime 在窗口内）→ 不收集。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: startedAt - 86_400_000, startedAt, createdInWindow: true,
    })).toBe(false);
    // 平台无 birthtime（<=0）→ 退化为仅 mtime 判断。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: 0, startedAt, createdInWindow: true,
    })).toBe(true);
    // 未开启 createdInWindow → 仅 mtime 判断。
    expect(shouldCollectWindowedFile({
      mtimeMs: Date.now(), birthtimeMs: startedAt - 86_400_000, startedAt,
    })).toBe(true);
  });

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

  test('missing optional adapter output dirs do not add Run diagnostics', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-')));
    const diagnostics: string[] = [];

    await collectArtifacts({
      extraOutputDirs: [join(cwd, 'missing-generated-images')],
      startedAt: 0,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.code),
    });

    expect(diagnostics).toEqual([]);
  });

  test('adapter output roots collect only whitelisted top-level and output/ files', async () => {
    const homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'col-adapter-home-')));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'col-adapter-')));
    const outputDir = join(cwd, 'outputs');
    mkdirSync(outputDir, { recursive: true });
    const hermesHomeDir = join(homeDir, '.hermes');
    mkdirSync(outputDir, { recursive: true });
    // 主目录顶层：交付 .md 可收集；.json/.yaml/隐藏项/子目录/超窗文件均排除。
    await touch(join(homeDir, 'HyperFrames视频制作完全指南-摘要.md'), 5000);
    await touch(join(homeDir, 'notes.json'), 5000);
    await touch(join(homeDir, '.hidden.md'), 5000);
    await touch(join(homeDir, 'old.md'), 500);
    mkdirSync(join(homeDir, 'Documents'), { recursive: true });
    await touch(join(homeDir, 'Documents', 'draft.md'), 5000);
    // AgentOS 数据根：顶层 总结.md 可收集；pairing/config 等状态排除；output/ 递归可收集。
    mkdirSync(hermesHomeDir, { recursive: true });
    await touch(join(hermesHomeDir, '总结.md'), 5000);
    await touch(join(hermesHomeDir, 'gateway_state.json'), 5000);
    await touch(join(hermesHomeDir, 'config.yaml'), 5000);
    mkdirSync(join(hermesHomeDir, 'pairing'), { recursive: true });
    await touch(join(hermesHomeDir, 'pairing', 'weixin.json'), 5000);
    mkdirSync(join(hermesHomeDir, 'output', '20260801'), { recursive: true });
    await touch(join(hermesHomeDir, 'output', '20260801', 'report.md'), 5000);

    const collected = await collectArtifacts({
      outputDir,
      adapterOutputRoots: [
        { dir: homeDir, recursive: false, createdInWindow: true },
        { dir: hermesHomeDir, recursive: false },
        { dir: join(hermesHomeDir, 'output'), recursive: true },
      ],
      startedAt: 1000,
    });

    const names = collected.map((c) => c.filename).sort();
    expect(names).toEqual(['HyperFrames视频制作完全指南-摘要.md', 'report.md', '总结.md']);
    expect(collected.every((artifact) => artifact.sourceRoot.kind === 'adapter_generated')).toBe(true);
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
