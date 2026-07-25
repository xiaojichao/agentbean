import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  CommandArtifactPreviewProcessor,
  createArtifactPreviewService,
  InMemoryArtifactPreviewRepository,
  supportsArtifactPreviewMime,
  UnsupportedPreviewError,
} from '../src/application/artifact-preview-service';

describe('artifact preview service', () => {
  test('accepts supported MIME types with parameters', () => {
    expect(supportsArtifactPreviewMime('Image/PNG; charset=binary')).toBe(true);
    expect(supportsArtifactPreviewMime('image/avif')).toBe(true);
    expect(supportsArtifactPreviewMime('application/pdf; version=1.7')).toBe(true);
  });

  test('enqueues idempotently and publishes a bounded derivative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'cover.png');
    await writeFile(source, 'source');
    const service = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      processor: { async process({ outputPath }) { await mkdir(join(outputPath, '..'), { recursive: true }); await writeFile(outputPath, 'webp'); return { width: 12, height: 8 }; } },
    });
    const first = await service.enqueue({ artifactId: 'a1', teamId: 't1', inputPath: source, mimeType: 'image/png' });
    const second = await service.enqueue({ artifactId: 'a1', teamId: 't1', inputPath: source, mimeType: 'image/png' });
    expect(second.id).toBe(first.id);
    await service.runOnce();
    expect(await service.get('a1')).toMatchObject({
      status: 'ready',
      url: '/api/teams/t1/artifacts/a1/preview-derivative',
      width: 12,
      height: 8,
    });
    expect((await stat(join(root, 'derivatives/t1/a1/preview.webp'))).size).toBe(4);
  });

  test('marks unsupported input without affecting the original artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'audio.mp3');
    await writeFile(source, 'original');
    const service = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      processor: { async process() { throw new UnsupportedPreviewError('audio/mpeg'); } },
    });
    await service.enqueue({ artifactId: 'a2', teamId: 't1', inputPath: source, mimeType: 'audio/mpeg' });
    await service.runOnce();
    expect(await service.get('a2')).toMatchObject({ status: 'unsupported' });
    expect(await stat(source)).toBeTruthy();
  });

  test('retries processing failures and caps them as failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'bad.png');
    await writeFile(source, 'source');
    const repository = new InMemoryArtifactPreviewRepository();
    const service = createArtifactPreviewService({ outputDir: join(root, 'derivatives'), repository, processor: { async process() { throw new Error('malformed'); } } });
    await service.enqueue({ artifactId: 'a3', teamId: 't1', inputPath: source, mimeType: 'image/png' });
    await service.runOnce(); await service.runOnce(); await service.runOnce();
    expect(await service.get('a3')).toMatchObject({ status: 'failed' });
  });

  test('recovers an expired processing lease after a worker restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'recover.png');
    await writeFile(source, 'source');
    const repository = new InMemoryArtifactPreviewRepository();
    let currentTime = 100;
    const firstWorker = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      repository,
      now: () => currentTime,
      leaseMs: 10,
      processor: { async process() { throw new Error('worker crashed'); } },
    });
    await firstWorker.enqueue({ artifactId: 'a4', teamId: 't1', inputPath: source, mimeType: 'image/png' });
    await repository.claimNext({ now: currentTime, leasedUntil: 110, maxAttempts: 3 });

    currentTime = 111;
    const restartedWorker = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      repository,
      now: () => currentTime,
      processor: {
        async process({ outputPath }) {
          await mkdir(join(outputPath, '..'), { recursive: true });
          await writeFile(outputPath, 'webp');
          return {};
        },
      },
    });
    await restartedWorker.runOnce();
    expect(await restartedWorker.get('a4')).toMatchObject({ status: 'ready' });
  });
});

<<<<<<< ours
const FFMPEG_OK_STUB = '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\necho webp > "$out"\n';

describe('command artifact preview processor（#799 视频时长）', () => {
  test('propagates processor-reported durationMs to the public preview DTO', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'clip.mp4');
    await writeFile(source, 'source');
    const service = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      processor: {
        async process({ outputPath }) {
          await mkdir(join(outputPath, '..'), { recursive: true });
          await writeFile(outputPath, 'webp');
          return { durationMs: 42_350 };
        },
      },
    });
    await service.enqueue({ artifactId: 'v1', teamId: 't1', inputPath: source, mimeType: 'video/mp4' });
    await service.runOnce();
    expect(await service.get('v1')).toMatchObject({ status: 'ready', durationMs: 42_350 });
  });

  test('extracts video duration through the prober after producing the first frame', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'clip.mp4');
    await writeFile(source, 'source');
    const output = join(root, 'out.webp');
    const processor = new CommandArtifactPreviewProcessor(
      await makeStubCommand(root, 'ffmpeg-ok', FFMPEG_OK_STUB),
      5_000,
      await makeStubCommand(root, 'ffprobe-ok', '#!/bin/sh\necho "42.350000"\n'),
    );
    await expect(processor.process({ inputPath: source, outputPath: output, mimeType: 'video/mp4' }))
      .resolves.toEqual({ durationMs: 42_350 });
    expect((await stat(output)).size).toBeGreaterThan(0);
  });

  test('drops only the duration field when the prober fails, keeping the derivative', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'clip.mp4');
    await writeFile(source, 'source');
    const output = join(root, 'out.webp');
    const processor = new CommandArtifactPreviewProcessor(
      await makeStubCommand(root, 'ffmpeg-ok', FFMPEG_OK_STUB),
      5_000,
      await makeStubCommand(root, 'ffprobe-fail', '#!/bin/sh\nexit 1\n'),
    );
    await expect(processor.process({ inputPath: source, outputPath: output, mimeType: 'video/mp4' }))
      .resolves.toEqual({});
    expect((await stat(output)).size).toBeGreaterThan(0);
  });

  test('does not probe non-video derivatives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'cover.png');
    await writeFile(source, 'source');
    const output = join(root, 'out.webp');
    const probeLog = join(root, 'probe.log');
    const processor = new CommandArtifactPreviewProcessor(
      await makeStubCommand(root, 'ffmpeg-ok', FFMPEG_OK_STUB),
      5_000,
      await makeStubCommand(root, 'ffprobe-log', `#!/bin/sh\necho called >> "${probeLog}"\necho "1.0"\n`),
    );
    await expect(processor.process({ inputPath: source, outputPath: output, mimeType: 'image/png' }))
      .resolves.toEqual({});
    await expect(stat(probeLog)).rejects.toThrow();
=======
describe('command artifact preview processor（#800 PDF 首页缩略图）', () => {
  test('renders the first PDF page through the pdf adapter and reuses the ffmpeg webp pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'doc.pdf');
    await writeFile(source, 'pdf');
    const output = join(root, 'out.webp');
    const calls = join(root, 'calls.log');
    const processor = new CommandArtifactPreviewProcessor(
      await makeStubCommand(root, 'ffmpeg-ok', `#!/bin/sh\necho "ffmpeg $@" >> "${calls}"\nout=""\nfor a in "$@"; do out="$a"; done\necho webp > "$out"\n`),
      5_000,
      await makeStubCommand(root, 'pdftoppm-ok', `#!/bin/sh\necho "pdftoppm $@" >> "${calls}"\nout=""\nfor a in "$@"; do out="$a"; done\necho png > "\${out}.png"\n`),
    );
    await expect(processor.process({ inputPath: source, outputPath: output, mimeType: 'application/pdf' }))
      .resolves.toEqual({});
    expect((await stat(output)).size).toBeGreaterThan(0);
    const log = String(await readFile(calls));
    expect(log).toContain('pdftoppm');
    expect(log).toContain('ffmpeg');
    // 中间 PNG 已清理
    await expect(stat(`${output}.page.png`)).rejects.toThrow();
  });

  test('ready PDF derivative flows through the standard preview DTO used by cards and folder mosaics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'doc.pdf');
    await writeFile(source, 'pdf');
    const service = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      processor: new CommandArtifactPreviewProcessor(
        await makeStubCommand(root, 'ffmpeg-ok', '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\necho webp > "$out"\n'),
        5_000,
        await makeStubCommand(root, 'pdftoppm-ok', '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\necho png > "${out}.png"\n'),
      ),
    });
    await service.enqueue({ artifactId: 'p1', teamId: 't1', inputPath: source, mimeType: 'application/pdf' });
    await service.runOnce();
    expect(await service.get('p1')).toMatchObject({
      status: 'ready',
      url: '/api/teams/t1/artifacts/p1/preview-derivative',
    });
  });

  test('marks the job unsupported with an explicit code and no retry when the pdf adapter is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'doc.pdf');
    await writeFile(source, 'pdf');
    const repository = new InMemoryArtifactPreviewRepository();
    const service = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      repository,
      processor: new CommandArtifactPreviewProcessor(
        await makeStubCommand(root, 'ffmpeg-ok', '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\necho webp > "$out"\n'),
        5_000,
        join(root, 'pdftoppm-not-installed'),
      ),
    });
    await service.enqueue({ artifactId: 'p2', teamId: 't1', inputPath: source, mimeType: 'application/pdf' });
    await service.runOnce();
    const job = await repository.get('p2');
    expect(job?.status).toBe('unsupported');
    expect(job?.errorCode).toBe('PREVIEW_PDF_ADAPTER_MISSING');
    expect(job?.attempts).toBe(1);
    // 不进入重试：再次 runOnce 不再认领该 job
    expect(await service.runOnce()).toBe(false);
    expect(await stat(source)).toBeTruthy();
  });

  test('treats a malformed PDF as a bounded processing failure, not as unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentbean-preview-'));
    const source = join(root, 'broken.pdf');
    await writeFile(source, 'not-a-pdf');
    const repository = new InMemoryArtifactPreviewRepository();
    const service = createArtifactPreviewService({
      outputDir: join(root, 'derivatives'),
      repository,
      processor: new CommandArtifactPreviewProcessor(
        await makeStubCommand(root, 'ffmpeg-ok', '#!/bin/sh\nout=""\nfor a in "$@"; do out="$a"; done\necho webp > "$out"\n'),
        5_000,
        await makeStubCommand(root, 'pdftoppm-fail', '#!/bin/sh\necho "Syntax Error: broken" >&2\nexit 1\n'),
      ),
    });
    await service.enqueue({ artifactId: 'p3', teamId: 't1', inputPath: source, mimeType: 'application/pdf' });
    await service.runOnce(); await service.runOnce(); await service.runOnce();
    const job = await repository.get('p3');
    expect(job?.status).toBe('failed');
    expect(job?.errorCode).not.toBe('PREVIEW_PDF_ADAPTER_MISSING');
    expect(job?.errorCode).not.toBe('PREVIEW_UNSUPPORTED');
>>>>>>> theirs
  });
});

async function makeStubCommand(dir: string, name: string, body: string): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, body, { mode: 0o755 });
  return path;
}
