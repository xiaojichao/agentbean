import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import {
  supportsArtifactPreviewDerivativeMimeType,
  type ArtifactPreviewDto,
  type ArtifactPreviewStatus,
} from '../../../../packages/contracts/src/index.js';

const MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 20_000;

export interface ArtifactPreviewJob {
  id: string;
  artifactId: string;
  teamId: string;
  inputPath: string;
  mimeType: string;
  attempts: number;
  status: ArtifactPreviewStatus;
  leasedUntil?: number;
  errorCode?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  updatedAt: number;
}

export interface ArtifactPreviewRepository {
  get(artifactId: string): Promise<ArtifactPreviewJob | undefined>;
  createIfAbsent(job: ArtifactPreviewJob): Promise<ArtifactPreviewJob>;
  claimNext(input: { now: number; leasedUntil: number; maxAttempts: number }): Promise<ArtifactPreviewJob | undefined>;
  save(job: ArtifactPreviewJob): Promise<void>;
}

export class InMemoryArtifactPreviewRepository implements ArtifactPreviewRepository {
  private readonly jobs = new Map<string, ArtifactPreviewJob>();

  async get(artifactId: string) {
    const job = this.jobs.get(artifactId);
    return job ? { ...job } : undefined;
  }

  async createIfAbsent(job: ArtifactPreviewJob) {
    const existing = this.jobs.get(job.artifactId);
    if (existing) return { ...existing };
    this.jobs.set(job.artifactId, { ...job });
    return { ...job };
  }

  async claimNext(input: { now: number; leasedUntil: number; maxAttempts: number }) {
    const job = [...this.jobs.values()]
      .filter((candidate) =>
        (candidate.status === 'pending'
          || (candidate.status === 'processing' && (candidate.leasedUntil ?? 0) <= input.now))
        && candidate.attempts < input.maxAttempts)
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))[0];
    if (!job) return undefined;
    const claimed = {
      ...job,
      status: 'processing' as const,
      attempts: job.attempts + 1,
      leasedUntil: input.leasedUntil,
      updatedAt: input.now,
    };
    this.jobs.set(job.artifactId, claimed);
    return { ...claimed };
  }

  async save(job: ArtifactPreviewJob) {
    this.jobs.set(job.artifactId, { ...job });
  }
}

export interface ArtifactPreviewProcessor {
  process(input: {
    inputPath: string;
    outputPath: string;
    mimeType: string;
  }): Promise<{ width?: number; height?: number; durationMs?: number }>;
}

export class CommandArtifactPreviewProcessor implements ArtifactPreviewProcessor {
  constructor(
    private readonly command = process.env.AGENTBEAN_PREVIEW_PROCESSOR ?? 'ffmpeg',
    private readonly timeoutMs = DEFAULT_PROCESS_TIMEOUT_MS,
  ) {}

  async process(input: { inputPath: string; outputPath: string; mimeType: string }) {
    const mimeType = input.mimeType.toLowerCase();
    if (!supportsArtifactPreviewMime(mimeType)) throw new UnsupportedPreviewError(mimeType);
    const args = processorArgs(input, mimeType);
    try {
      await runCommand(this.command, args, this.timeoutMs);
    } catch (error) {
      if (mimeType.startsWith('audio/')) throw new UnsupportedPreviewError(mimeType);
      throw error;
    }
    return {};
  }
}

export class UnsupportedPreviewError extends Error {
  constructor(mimeType: string) {
    super(`Preview is unsupported for ${mimeType}`);
    this.name = 'UnsupportedPreviewError';
  }
}

export function supportsArtifactPreviewMime(mimeType: string): boolean {
  return supportsArtifactPreviewDerivativeMimeType(mimeType);
}

function processorArgs(
  input: { inputPath: string; outputPath: string },
  mimeType: string,
): string[] {
  const common = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-max_alloc', '134217728', '-max_pixels', '40000000', '-y', '-i', input.inputPath];
  if (mimeType.startsWith('audio/')) {
    return [...common, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=800:800:force_original_aspect_ratio=decrease', '-f', 'webp', input.outputPath];
  }
  return [...common, '-frames:v', '1', '-vf', 'scale=800:800:force_original_aspect_ratio=decrease', '-f', 'webp', input.outputPath];
}

function runCommand(command: string, args: string[], timeoutMs: number) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      child.kill('SIGKILL');
      settled = true;
      reject(new Error('PREVIEW_PROCESSOR_TIMEOUT'));
    }, timeoutMs);
    child.stderr.on('data', (chunk) => {
      error = `${error}${String(chunk)}`.slice(-1000);
    });
    child.once('error', (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(spawnError);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(error || `PREVIEW_PROCESSOR_EXIT_${code}`));
    });
  });
}

export interface ArtifactPreviewServiceOptions {
  repository?: ArtifactPreviewRepository;
  processor?: ArtifactPreviewProcessor;
  outputDir: string;
  now?: () => number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
  leaseMs?: number;
}

export function createArtifactPreviewService(options: ArtifactPreviewServiceOptions) {
  const repository = options.repository ?? new InMemoryArtifactPreviewRepository();
  const processor = options.processor ?? new CommandArtifactPreviewProcessor();
  const now = options.now ?? (() => Date.now());
  const maxInputBytes = options.maxInputBytes ?? 10 * 1024 * 1024;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;

  const enqueue = async (input: { artifactId: string; teamId: string; inputPath: string; mimeType: string }) =>
    repository.createIfAbsent({
      id: randomUUID(),
      ...input,
      attempts: 0,
      status: 'pending',
      updatedAt: now(),
    });

  const get = async (artifactId: string): Promise<ArtifactPreviewDto | undefined> => {
    const job = await repository.get(artifactId);
    if (!job) return undefined;
    return {
      status: job.status,
      ...(job.status === 'ready'
        ? { url: `/api/teams/${encodeURIComponent(job.teamId)}/artifacts/${encodeURIComponent(job.artifactId)}/preview-derivative` }
        : {}),
      width: job.width,
      height: job.height,
      durationMs: job.durationMs,
      updatedAt: job.updatedAt,
    };
  };

  const runOnce = async () => {
    const claimedAt = now();
    const job = await repository.claimNext({
      now: claimedAt,
      leasedUntil: claimedAt + leaseMs,
      maxAttempts: MAX_ATTEMPTS,
    });
    if (!job) return false;
    const outputDir = join(options.outputDir, job.teamId, job.artifactId);
    const tempPath = join(outputDir, `${basename(job.inputPath)}.${job.id}.tmp.webp`);
    const outputPath = join(outputDir, 'preview.webp');
    try {
      const inputStat = await stat(job.inputPath);
      if (inputStat.size > maxInputBytes) throw new Error('PREVIEW_INPUT_TOO_LARGE');
      await mkdir(outputDir, { recursive: true });
      const metadata = await processor.process({
        inputPath: job.inputPath,
        outputPath: tempPath,
        mimeType: job.mimeType,
      });
      const outputStat = await stat(tempPath);
      if (outputStat.size > maxOutputBytes) throw new Error('PREVIEW_OUTPUT_TOO_LARGE');
      await rename(tempPath, outputPath);
      Object.assign(job, metadata, { status: 'ready', errorCode: undefined });
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      job.errorCode = previewErrorCode(error);
      job.status = error instanceof UnsupportedPreviewError
        ? 'unsupported'
        : job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
    }
    job.leasedUntil = undefined;
    job.updatedAt = now();
    await repository.save(job);
    return true;
  };

  return { enqueue, get, runOnce, repository };
}

function previewErrorCode(error: unknown): string {
  if (error instanceof UnsupportedPreviewError) return 'PREVIEW_UNSUPPORTED';
  if (!(error instanceof Error)) return 'PREVIEW_PROCESSING_FAILED';
  if (/^[A-Z][A-Z0-9_]+$/.test(error.message)) return error.message;
  return 'PREVIEW_PROCESSING_FAILED';
}

export type ArtifactPreviewService = ReturnType<typeof createArtifactPreviewService>;
