import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git', '.hg', '.svn', '.cache', '.next', '.nuxt', '.turbo', 'node_modules', 'vendor', '.agentbean',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
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
  configuredOutputRoots?: Array<{ id?: string; path: string; label: string; defaultRole?: ArtifactRole; recursive?: boolean }>;
  /** Stable public label for the agent workspace root. */
  workspaceLabel?: string;
  /** command start timestamp (ms); used as mtime threshold for the cwd fallback. */
  startedAt: number;
  /** Maximum artifact bytes to hash/read; defaults to server upload cap. */
  maxBytes?: number;
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
 * applies extension + ignored-dir filters, and keeps each root-relative path
 * independent. Returns the candidate artifacts to upload.
 */
export async function collectArtifacts(input: CollectArtifactsInput): Promise<CollectedArtifact[]> {
  const byRootPath = new Map<string, CollectedArtifact>();
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;

  const excludedNestedRoots = new Set([
    ...(input.outputDir ? [input.outputDir] : []),
    ...(input.extraOutputDirs ?? []),
    ...(input.configuredOutputRoots ?? []).map((root) => root.path),
  ]);
  const ingest = (
    rootAbs: string,
    rootForRelative: string,
    timeFilter: boolean,
    sourceRoot: ArtifactSourceRoot,
    role: ArtifactRole,
    recursive = true,
    reportRootFailure = true,
  ): void => {
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
          if (stat.size > maxBytes) {
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_TOO_LARGE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath: relative(rootForRelative, abs),
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
          let content;
          try {
            content = readFileSync(abs);
          } catch {
            input.onDiagnostic?.({
              code: 'ARTIFACT_FILE_UNREADABLE',
              sourceRootId: sourceRoot.id,
              sourceRootLabel: sourceRoot.label,
              relativePath: relative(rootForRelative, abs),
            });
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
          const key = `${sourceRoot.id}:${candidate.relativePath}`;
          byRootPath.set(key, candidate);
        }
      }
    }
  };

  if (input.outputDir) {
    ingest(input.outputDir, input.outputDir, false, makeSourceRoot('run_output', '默认运行输出', input.outputDir), 'run_output');
  }
  for (const dir of input.extraOutputDirs ?? []) {
    ingest(dir, dir, true, makeSourceRoot('adapter_generated', '适配器生成目录', dir), 'run_output', true, false);
  }
  for (const root of input.configuredOutputRoots ?? []) {
    const sourceRoot = root.id
      ? { id: root.id, kind: 'configured_output' as const, label: root.label }
      : makeSourceRoot('configured_output', root.label, root.path);
    ingest(root.path, root.path, true, sourceRoot, root.defaultRole ?? 'run_output', root.recursive ?? true);
  }
  if (input.cwd) {
    ingest(input.cwd, input.cwd, true, makeSourceRoot('agent_workspace', input.workspaceLabel ?? 'Agent 工作目录', input.cwd), 'run_output');
  }
  return [...byRootPath.values()];
}

function makeSourceRoot(kind: ArtifactSourceRootKind, label: string, localIdentity: string): ArtifactSourceRoot {
  const id = createHash('sha256').update(`agentbean:artifact-source-root:${kind}:${localIdentity}`).digest('hex').slice(0, 24);
  return { id, kind, label };
}
