import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import {
  DEFAULT_ARTIFACT_MAX_BYTES,
  type ArtifactRole,
  type ArtifactSourceRootDto,
  type SkippedArtifactDiagnostic,
} from '../../../packages/contracts/src/index.js';

const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.turbo', 'node_modules', 'vendor', '.agentbean',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;
export type ArtifactSourceRootKind = Exclude<ArtifactSourceRootDto['kind'], 'legacy_run'>;
export type { ArtifactRole };

export interface ArtifactSourceRoot {
  id: string;
  kind: ArtifactSourceRootKind;
  label: string;
}

export interface CollectedArtifact {
  absolutePath: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  filename: string;
  sourceRoot: ArtifactSourceRoot;
  role: ArtifactRole;
}

export interface CollectArtifactsInput {
  /** per-run outputs/ directory; all matching files are collected regardless of mtime. */
  outputDir?: string;
  /** customAgent.cwd; fallback scan picks matching files with mtime > startedAt. */
  cwd?: string;
  /** Extra output roots such as Codex-native generated_images; mtime filtered. */
  extraOutputDirs?: string[];
  /** Additional roots with safe public labels; absolute paths never leave the daemon. */
  configuredOutputRoots?: Array<{ id?: string; path: string; label: string; envVar?: string; defaultRole?: ArtifactRole; recursive?: boolean }>;
  /** Stable public label for the agent workspace root. */
  workspaceLabel?: string;
  /** command start timestamp (ms); used as mtime threshold for the cwd fallback. */
  startedAt: number;
  /** Maximum artifact bytes to hash/read; defaults to server upload cap. */
  maxBytes?: number;
  /** Reports files that could not be collected without silently omitting them. */
  onSkipped?: (artifact: SkippedArtifactDiagnostic, sourceRoot: ArtifactSourceRoot) => void;
  /** Stable, path-free diagnostics for Run details and logs. */
  onDiagnostic?: (diagnostic: ArtifactCollectionDiagnostic) => void;
}

export interface ArtifactCollectionDiagnostic {
  code: 'SOURCE_ROOT_MISSING' | 'SOURCE_ROOT_INVALID' | 'SOURCE_ROOT_UNREADABLE' | 'ARTIFACT_FILE_UNREADABLE' | 'ARTIFACT_FILE_TOO_LARGE' | 'ARTIFACT_FILE_LIMIT_REACHED';
  sourceRootId: string;
  sourceRootLabel: string;
  relativePath?: string;
}

/**
 * Scans outputs/ (always) plus cwd (mtime > startedAt, fallback) for product files,
 * applies extension + ignored-dir filters, and dedupes by sha256 (keeping the more
 * semantic filename). Returns the candidate artifacts to upload.
 */
export async function collectArtifacts(input: CollectArtifactsInput): Promise<CollectedArtifact[]> {
  const byRootPath = new Map<string, CollectedArtifact>();
  const maxBytes = input.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES;

  const excludedNestedRoots = new Set([
    ...(input.outputDir ? [input.outputDir] : []),
    ...(input.extraOutputDirs ?? []),
    ...(input.configuredOutputRoots ?? []).map((root) => root.path),
  ]);
  const ingest = async (
    rootAbs: string,
    rootForRelative: string,
    timeFilter: boolean,
    sourceRoot: ArtifactSourceRoot,
    role: ArtifactRole,
    recursive = true,
    reportRootFailure = true,
  ): Promise<void> => {
    let visited = 0;
    const stack: string[] = [rootAbs];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        if (reportRootFailure) {
          input.onDiagnostic?.({
            code: 'SOURCE_ROOT_UNREADABLE',
            sourceRootId: sourceRoot.id,
            sourceRootLabel: sourceRoot.label,
          });
        }
        continue;
      }
      for (const entry of entries) {
        const abs = join(current, entry.name);
        if (entry.isDirectory()) {
          if (IGNORED_OUTPUT_DIRS.has(entry.name)) {
            continue;
          }
          if (recursive && !(sourceRoot.kind === 'agent_workspace' && excludedNestedRoots.has(abs))) stack.push(abs);
        } else if (entry.isFile() && OUTPUT_FILE_EXT_RE.test(entry.name)) {
          visited += 1;
          let stat;
          try {
            stat = statSync(abs);
          } catch {
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath: relative(rootForRelative, abs),
            });
            continue;
          }
          if (timeFilter && stat.mtimeMs <= input.startedAt) {
            continue;
          }
          const relativePath = relative(rootForRelative, abs);
          if (stat.size > maxBytes) {
            input.onSkipped?.({
              filename: basename(abs),
              relativePath,
              sizeBytes: stat.size,
              reason: 'FILE_TOO_LARGE',
            }, sourceRoot);
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_TOO_LARGE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath,
            });
            continue;
          }
          if (visited > MAX_OUTPUT_FILES_PER_ROOT) {
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_LIMIT_REACHED',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
            });
            return;
          }
          let hash = createHash('sha256');
          let sizeBytes = 0;
          try {
            for await (const chunk of createReadStream(abs)) {
              const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              sizeBytes += buffer.length;
              hash.update(buffer);
              if (sizeBytes > maxBytes) break;
            }
          } catch {
            input.onSkipped?.({
              filename: basename(abs),
              relativePath,
              sizeBytes,
              reason: 'COLLECTION_FAILED',
            }, sourceRoot);
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath,
            });
            continue;
          }
          if (sizeBytes > maxBytes || sizeBytes !== stat.size) {
            input.onSkipped?.({
              filename: basename(abs),
              relativePath,
              sizeBytes,
              reason: sizeBytes > maxBytes ? 'FILE_TOO_LARGE' : 'COLLECTION_FAILED',
            }, sourceRoot);
            input.onDiagnostic?.({
              code: sizeBytes > maxBytes ? 'ARTIFACT_FILE_TOO_LARGE' : 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath,
            });
            continue;
          }
          const sha256 = hash.digest('hex');
          const candidate: CollectedArtifact = {
            absolutePath: abs,
            relativePath,
            sha256,
            sizeBytes,
            filename: basename(abs),
            sourceRoot,
            role,
          };
          const key = `${sourceRoot.id}:${candidate.relativePath}`;
          const existing = byRootPath.get(key);
          if (!existing || fileNamePreference(candidate.filename) < fileNamePreference(existing.filename)) {
            byRootPath.set(key, candidate);
          }
        }
      }
    }
  };

  if (input.outputDir) {
    await ingest(input.outputDir, input.outputDir, false, makeSourceRoot('run_output', '默认运行输出', input.outputDir), 'run_output');
  }
  for (const dir of input.extraOutputDirs ?? []) {
    await ingest(dir, dir, true, makeSourceRoot('adapter_generated', '适配器生成目录', dir), 'run_output', true, false);
  }
  for (const root of input.configuredOutputRoots ?? []) {
    const sourceRoot = root.id
      ? { id: root.id, kind: 'configured_output' as const, label: root.label }
      : makeSourceRoot('configured_output', root.label, root.path);
    await ingest(root.path, root.path, true, sourceRoot, root.defaultRole ?? 'run_output', root.recursive ?? true);
  }
  if (input.cwd) {
    await ingest(input.cwd, input.cwd, true, makeSourceRoot('agent_workspace', input.workspaceLabel ?? 'Agent 工作目录', input.cwd), 'run_output');
  }
  return [...byRootPath.values()];
}

function makeSourceRoot(kind: ArtifactSourceRootKind, label: string, localIdentity: string): ArtifactSourceRoot {
  const id = createHash('sha256').update(`agentbean:artifact-source-root:${kind}:${localIdentity}`).digest('hex').slice(0, 24);
  return { id, kind, label };
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
