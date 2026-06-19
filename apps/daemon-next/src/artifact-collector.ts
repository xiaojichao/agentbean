import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.turbo', 'node_modules', 'vendor', '.agentbean',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;

export interface CollectedArtifact {
  absolutePath: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
}

export interface CollectArtifactsInput {
  /** per-run outputs/ directory; all matching files are collected regardless of mtime. */
  outputDir: string;
  /** customAgent.cwd; fallback scan picks matching files with mtime > startedAt. */
  cwd: string;
  /** command start timestamp (ms); used as mtime threshold for the cwd fallback. */
  startedAt: number;
}

/**
 * Scans outputs/ (always) plus cwd (mtime > startedAt, fallback) for product files,
 * applies extension + ignored-dir filters, and dedupes by sha256 (keeping the more
 * semantic filename). Returns the candidate artifacts to upload.
 */
export async function collectArtifacts(input: CollectArtifactsInput): Promise<CollectedArtifact[]> {
  const bySha = new Map<string, CollectedArtifact>();

  const ingest = (rootAbs: string, rootForRelative: string, timeFilter: boolean): void => {
    let visited = 0;
    const stack: string[] = [rootAbs];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (visited > MAX_OUTPUT_FILES_PER_ROOT) {
          return;
        }
        const abs = join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_OUTPUT_DIRS.has(entry.name)) {
            continue;
          }
          stack.push(abs);
        } else if (entry.isFile() && OUTPUT_FILE_EXT_RE.test(entry.name)) {
          visited += 1;
          let stat;
          try {
            stat = statSync(abs);
          } catch {
            continue;
          }
          if (timeFilter && stat.mtimeMs <= input.startedAt) {
            continue;
          }
          let content;
          try {
            content = readFileSync(abs);
          } catch {
            continue;
          }
          const sha256 = createHash('sha256').update(content).digest('hex');
          const candidate: CollectedArtifact = {
            absolutePath: abs,
            relativePath: relative(rootForRelative, abs),
            sha256,
            sizeBytes: stat.size,
            filename: basename(abs),
          };
          const existing = bySha.get(sha256);
          if (!existing || fileNamePreference(candidate.filename) < fileNamePreference(existing.filename)) {
            bySha.set(sha256, candidate);
          }
        }
      }
    }
  };

  ingest(input.outputDir, input.outputDir, false);
  ingest(input.cwd, input.cwd, true);
  return [...bySha.values()];
}

function fileNamePreference(name: string): number {
  const lower = name.toLowerCase();
  if (/^ig_[a-f0-9]{32,}\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    return 0;
  }
  if (/^(image|output|generated)[._-]?\d*\.(png|jpe?g|gif|webp)$/i.test(lower)) {
    return 1;
  }
  return 2;
}
