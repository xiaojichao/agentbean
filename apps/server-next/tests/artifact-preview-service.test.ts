import { mkdir, writeFile, stat } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createArtifactPreviewService, InMemoryArtifactPreviewRepository, UnsupportedPreviewError } from '../src/application/artifact-preview-service';

describe('artifact preview service', () => {
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
    expect(await service.get('a1')).toMatchObject({ status: 'ready', url: '/api/teams/t1/artifacts/a1/preview-derivative' });
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
});
