import { access, mkdir, rename, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { ArtifactPreviewDto, ArtifactPreviewStatus } from '../../../../packages/contracts/src/index.js';

export interface ArtifactPreviewJob {
  id: string;
  artifactId: string;
  teamId: string;
  inputPath: string;
  mimeType: string;
  attempts: number;
  status: ArtifactPreviewStatus;
  leasedUntil?: number;
  error?: string;
  updatedAt: number;
}

export interface ArtifactPreviewRepository {
  get(artifactId: string): Promise<ArtifactPreviewJob | undefined>;
  save(job: ArtifactPreviewJob): Promise<void>;
  listLeasable(now: number): Promise<ArtifactPreviewJob[]>;
}

export class InMemoryArtifactPreviewRepository implements ArtifactPreviewRepository {
  private readonly jobs = new Map<string, ArtifactPreviewJob>();
  async get(artifactId: string) { return this.jobs.get(artifactId); }
  async save(job: ArtifactPreviewJob) { this.jobs.set(job.artifactId, { ...job }); }
  async listLeasable(now: number) {
    return [...this.jobs.values()].filter((job) =>
      (job.status === 'pending' || (job.status === 'processing' && (job.leasedUntil ?? 0) <= now)) &&
      job.attempts < 3,
    );
  }
}

export interface ArtifactPreviewProcessor {
  process(input: { inputPath: string; outputPath: string; mimeType: string }): Promise<{ width?: number; height?: number; durationMs?: number }>;
}

export class CommandArtifactPreviewProcessor implements ArtifactPreviewProcessor {
  constructor(private readonly command = process.env.AGENTBEAN_PREVIEW_PROCESSOR ?? 'ffmpeg') {}

  async process(input: { inputPath: string; outputPath: string; mimeType: string }) {
    if (!isSupportedMime(input.mimeType)) throw new UnsupportedPreviewError(input.mimeType);
    const args = input.mimeType === 'application/pdf'
      ? ['-y', '-i', input.inputPath, '-frames:v', '1', '-f', 'webp', input.outputPath]
      : ['-y', '-i', input.inputPath, '-frames:v', '1', '-vf', 'scale=800:800:force_original_aspect_ratio=decrease', '-f', 'webp', input.outputPath];
    await runCommand(this.command, args);
    return {};
  }
}

export class UnsupportedPreviewError extends Error {
  constructor(mimeType: string) { super(`Preview is unsupported for ${mimeType}`); this.name = 'UnsupportedPreviewError'; }
}

function isSupportedMime(mimeType: string) {
  return /^(image\/(jpeg|png|webp|gif|svg\+xml)|video\/(mp4|webm|quicktime)|application\/pdf)$/.test(mimeType.toLowerCase());
}

function runCommand(command: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', (chunk) => { error += String(chunk).slice(-1000); });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(error || `${command} exited with ${code}`)));
  });
}

export interface ArtifactPreviewServiceOptions {
  repository?: ArtifactPreviewRepository;
  processor?: ArtifactPreviewProcessor;
  outputDir: string;
  now?: () => number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

export function createArtifactPreviewService(options: ArtifactPreviewServiceOptions) {
  const repository = options.repository ?? new InMemoryArtifactPreviewRepository();
  const processor = options.processor ?? new CommandArtifactPreviewProcessor();
  const now = options.now ?? (() => Date.now());
  const maxInputBytes = options.maxInputBytes ?? 250 * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const enqueue = async (input: { artifactId: string; teamId: string; inputPath: string; mimeType: string }) => {
    const existing = await repository.get(input.artifactId);
    if (existing) return existing;
    const job: ArtifactPreviewJob = { id: randomUUID(), ...input, attempts: 0, status: 'pending', updatedAt: now() };
    await repository.save(job);
    return job;
  };
  const get = async (artifactId: string): Promise<ArtifactPreviewDto | undefined> => {
    const job = await repository.get(artifactId);
    if (!job) return undefined;
    return { status: job.status, ...(job.status === 'ready' ? { url: `/api/teams/${encodeURIComponent(job.teamId)}/artifacts/${encodeURIComponent(job.artifactId)}/preview-derivative` } : {}), updatedAt: job.updatedAt };
  };
  const runOnce = async () => {
    const job = (await repository.listLeasable(now()))[0];
    if (!job) return false;
    job.status = 'processing'; job.attempts += 1; job.leasedUntil = now() + 30_000; job.updatedAt = now(); await repository.save(job);
    const outputDir = join(options.outputDir, job.teamId, job.artifactId);
    const tempPath = join(outputDir, `${basename(job.inputPath)}.${job.id}.tmp.webp`);
    const outputPath = join(outputDir, 'preview.webp');
    try {
      const inputStat = await stat(job.inputPath);
      if (inputStat.size > maxInputBytes) throw new Error('Preview input exceeds configured limit');
      await access(job.inputPath); await mkdir(outputDir, { recursive: true });
      await processor.process({ inputPath: job.inputPath, outputPath: tempPath, mimeType: job.mimeType });
      const outputStat = await stat(tempPath);
      if (outputStat.size > maxOutputBytes) throw new Error('Preview output exceeds configured limit');
      await rename(tempPath, outputPath); job.status = 'ready'; job.error = undefined;
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      job.status = error instanceof UnsupportedPreviewError ? 'unsupported' : job.attempts >= 3 ? 'failed' : 'pending';
    }
    job.leasedUntil = undefined; job.updatedAt = now(); await repository.save(job); return true;
  };
  return { enqueue, get, runOnce, repository };
}

export type ArtifactPreviewService = ReturnType<typeof createArtifactPreviewService>;
