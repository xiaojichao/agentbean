import { readdirSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './log.js';

const CODE_BLOCK_RE = /```python\n([\s\S]*?)```/g;
const CODEX_IMG_DIR = join(homedir(), '.codex', 'generated_images');
const OUTPUT_FILE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip)$/i;
const IGNORED_OUTPUT_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  'node_modules',
  'vendor',
]);
const MAX_OUTPUT_FILES_PER_ROOT = 2000;
const OUTPUT_DIR_ENV = 'AGENT_BEAN_OUTPUT_DIRS';

export interface PostProcessResult {
  replyText: string;
  outputFiles: string[];
}

export function listAllFiles(dir: string, maxDepth = 10, depth = 0): string[] {
  if (!existsSync(dir) || depth > maxDepth) return [];
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_OUTPUT_DIRS.has(entry.name)) continue;
      results.push(...listAllFiles(full, maxDepth, depth + 1));
    }
    else results.push(full);
    if (results.length >= MAX_OUTPUT_FILES_PER_ROOT) break;
  }
  return results;
}

function normalizeCandidatePath(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/^file:\/\//, '')
    .replace(/^["'`<({\[]+/, '')
    .replace(/["'`>)}\].,;:]+$/, '');
  if (!cleaned || !OUTPUT_FILE_EXT_RE.test(cleaned)) return null;
  return cleaned.replace(/^~(?=$|\/)/, homedir());
}

function extractMentionedFiles(reply: string, workspace: string | undefined, dispatchStart: number): string[] {
  const candidates = new Set<string>();
  const markdownLinkRe = /!?\[[^\]]*]\(([^)\s]+)\)/g;
  const plainPathRe = /(?:^|[\s"'`(<])((?:~?\/|\.{1,2}\/)?[\w@%+=:,./-]+\.(?:png|jpe?g|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip))(?:$|[\s"'`)>.,;:])/gim;

  let match: RegExpExecArray | null;
  while ((match = markdownLinkRe.exec(reply)) !== null) {
    const normalized = normalizeCandidatePath(match[1]!);
    if (normalized) candidates.add(normalized);
  }
  while ((match = plainPathRe.exec(reply)) !== null) {
    const normalized = normalizeCandidatePath(match[1]!);
    if (normalized) candidates.add(normalized);
  }

  const files: string[] = [];
  for (const candidate of candidates) {
    const abs = isAbsolute(candidate) ? candidate : workspace ? resolve(workspace, candidate) : null;
    if (!abs) continue;
    try {
      const st = statSync(abs);
      if (st.isFile()) files.push(abs);
    } catch {}
  }
  return files;
}

function outputDirsFromEnv(): string[] {
  const raw = process.env[OUTPUT_DIR_ENV];
  if (!raw?.trim()) return [];
  return raw
    .split(/[,:;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function resolveOutputRoots(workspace?: string, outputDirs: string[] = [], includeWorkspace = false): string[] {
  const roots = new Set<string>();
  if (workspace && includeWorkspace) roots.add(resolve(workspace));

  for (const raw of [...outputDirs, ...outputDirsFromEnv()]) {
    const expanded = raw.replace(/^~(?=$|\/)/, homedir());
    const root = isAbsolute(expanded)
      ? expanded
      : workspace
        ? resolve(workspace, expanded)
        : resolve(expanded);
    roots.add(root);
  }

  return [...roots].filter((root) => {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

function collectRecentOutputFiles(roots: string[], dispatchStart: number): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    for (const filePath of listAllFiles(root, 8)) {
      if (!OUTPUT_FILE_EXT_RE.test(filePath)) continue;
      try {
        const st = statSync(filePath);
        if (st.isFile() && st.mtimeMs > dispatchStart) {
          files.add(canonicalPath(filePath));
        }
      } catch {}
    }
  }
  return [...files];
}

export async function postProcess(
  reply: string,
  workspace: string | undefined,
  kind: string,
  dispatchStart: number,
  options: { outputDirs?: string[]; scanWorkspace?: boolean } = {},
): Promise<PostProcessResult> {
  const outputFiles = new Set<string>();

  // Codex native image detection
  if (kind === 'codex') {
    const allCodexFiles = listAllFiles(CODEX_IMG_DIR, 4);
    for (const f of allCodexFiles) {
      if (!OUTPUT_FILE_EXT_RE.test(f)) continue;
      try {
        const st = statSync(f);
        if (st.mtimeMs > dispatchStart) {
          outputFiles.add(canonicalPath(f));
        }
      } catch {}
    }
  }

  for (const filePath of extractMentionedFiles(reply, workspace, dispatchStart)) {
    outputFiles.add(canonicalPath(filePath));
  }

  for (const filePath of collectRecentOutputFiles(resolveOutputRoots(workspace, options.outputDirs, options.scanWorkspace), dispatchStart)) {
    outputFiles.add(filePath);
  }

  // Extract code blocks for logging but do NOT auto-execute (security)
  if (workspace) {
    const codeBlocks: string[] = [];
    let m: RegExpExecArray | null;
    const re = new RegExp(CODE_BLOCK_RE.source, 'g');
    while ((m = re.exec(reply)) !== null) {
      codeBlocks.push(m[1]!);
    }
    if (codeBlocks.length > 0) {
      logger.info({ count: codeBlocks.length }, 'code blocks detected but not executed (auto-exec disabled)');
    }
  }

  let replyText = reply;
  const files = [...outputFiles];
  if (files.length > 0) {
    replyText += '\n\n已生成文件:\n' + files.map((f) => `- ${f}`).join('\n');
  }
  return { replyText, outputFiles: files };
}
