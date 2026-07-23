import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.turbo', 'node_modules', 'vendor', '.agentbean',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;
const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
export type ArtifactSourceRootKind = 'run_output' | 'agent_workspace' | 'configured_output' | 'adapter_generated';
export type ArtifactRole = 'intermediate' | 'run_output' | 'deliverable' | 'attachment';

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
  configuredOutputRoots?: Array<{ path: string; label: string; envVar?: string; defaultRole?: ArtifactRole; recursive?: boolean }>;
  /** Stable public label for the agent workspace root. */
  workspaceLabel?: string;
  /** command start timestamp (ms); used as mtime threshold for the cwd fallback. */
  startedAt: number;
  /** Maximum artifact bytes to hash/read; defaults to server upload cap. */
  maxBytes?: number;
}

/**
 * Scans outputs/ (always) plus cwd (mtime > startedAt, fallback) for product files,
 * applies extension + ignored-dir filters, and dedupes by sha256 (keeping the more
 * semantic filename). Returns the candidate artifacts to upload.
 */
export async function collectArtifacts(input: CollectArtifactsInput): Promise<CollectedArtifact[]> {
  const byRootPath = new Map<string, CollectedArtifact>();
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  const excludedNestedRoots = new Set([
    ...(input.outputDir ? [input.outputDir] : []),
    ...(input.extraOutputDirs ?? []),
    ...(input.configuredOutputRoots ?? []).map((root) => root.path),
  ]);
  const ingest = (rootAbs: string, rootForRelative: string, timeFilter: boolean, sourceRoot: ArtifactSourceRoot, role: ArtifactRole, recursive = true): void => {
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
            continue;
          }
          if (timeFilter && stat.mtimeMs <= input.startedAt) {
            continue;
          }
          if (stat.size > maxBytes) {
            continue;
          }
          visited += 1;
          if (visited > MAX_OUTPUT_FILES_PER_ROOT) {
            return;
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
            sourceRoot,
            role,
          };
          const key = `${sourceRoot.id}:${sha256}`;
          const existing = byRootPath.get(key);
          if (!existing || fileNamePreference(candidate.filename) < fileNamePreference(existing.filename)) {
            byRootPath.set(key, candidate);
          }
        }
      }
    }
  };

  if (input.outputDir) {
    ingest(input.outputDir, input.outputDir, false, makeSourceRoot('run_output', '默认运行输出'), 'run_output');
  }
  for (const dir of input.extraOutputDirs ?? []) {
    ingest(dir, dir, true, makeSourceRoot('adapter_generated', '适配器生成目录'), 'run_output');
  }
  for (const root of input.configuredOutputRoots ?? []) {
    ingest(root.path, root.path, true, makeSourceRoot('configured_output', root.label), root.defaultRole ?? 'run_output', root.recursive ?? true);
  }
  if (input.cwd) {
    ingest(input.cwd, input.cwd, true, makeSourceRoot('agent_workspace', input.workspaceLabel ?? 'Agent 工作目录'), 'run_output');
  }
  return [...byRootPath.values()];
}

function makeSourceRoot(kind: ArtifactSourceRootKind, label: string): ArtifactSourceRoot {
  const id = createHash('sha256').update(`agentbean:artifact-source-root:${kind}:${label}`).digest('hex').slice(0, 24);
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
