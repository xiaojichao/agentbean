import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './log.js';

const CODE_BLOCK_RE = /```python\n([\s\S]*?)```/g;
const CODEX_IMG_DIR = join(homedir(), '.codex', 'generated_images');

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
    if (entry.isDirectory()) results.push(...listAllFiles(full, maxDepth, depth + 1));
    else results.push(full);
  }
  return results;
}

export async function postProcess(
  reply: string,
  workspace: string | undefined,
  kind: string,
  dispatchStart: number,
): Promise<PostProcessResult> {
  const outputFiles: string[] = [];

  // Codex native image detection
  if (kind === 'codex') {
    const allCodexFiles = listAllFiles(CODEX_IMG_DIR);
    for (const f of allCodexFiles) {
      try {
        const st = statSync(f);
        if (st.mtimeMs > dispatchStart) {
          outputFiles.push(f);
        }
      } catch {}
    }
  }

  // Detect files created during this dispatch
  if (workspace) {
    for (const entry of readdirSync(workspace, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      const f = join(workspace, entry.name);
      if (entry.name.startsWith('.agentbean-exec-')) continue;
      try {
        const st = statSync(f);
        if (st.mtimeMs > dispatchStart) {
          outputFiles.push(f);
        }
      } catch {}
    }
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
  if (outputFiles.length > 0) {
    replyText += '\n\n已生成文件:\n' + outputFiles.map((f) => `- ${f}`).join('\n');
  }
  return { replyText, outputFiles };
}
