import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { logger } from './log.js';
import { getAgentWorkspaceDir } from './workspace-manager.js';

type WorkspaceFile = {
  id: string;
  filename: string;
  relativePath: string;
  sha256?: string | null;
  downloadUrl: string;
};

type WorkspaceAgent = {
  id: string;
  name: string;
  runs: Array<{ runId: string; files: WorkspaceFile[] }>;
};

function hashFile(path: string): string | null {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}

function safeRelativePath(value: string): string | null {
  const normalized = normalize(value).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!normalized || isAbsolute(normalized) || normalized.startsWith('..')) return null;
  return normalized;
}

export async function syncWorkspaceArtifacts(input: {
  serverUrl: string;
  token: string;
  networkId: string;
}): Promise<void> {
  const base = input.serverUrl.replace(/\/agent$/, '');
  let payload: { ok?: boolean; agents?: WorkspaceAgent[] };
  try {
    const resp = await fetch(`${base}/api/networks/${encodeURIComponent(input.networkId)}/workspace`, {
      headers: { Authorization: `Bearer ${input.token}` },
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, body: await resp.text() }, 'workspace sync manifest rejected');
      return;
    }
    payload = await resp.json() as { ok?: boolean; agents?: WorkspaceAgent[] };
  } catch (err: any) {
    logger.warn({ err: err?.message }, 'workspace sync manifest failed');
    return;
  }

  if (!payload.ok || !payload.agents?.length) return;
  let downloaded = 0;
  for (const agent of payload.agents) {
    const agentDir = getAgentWorkspaceDir(input.networkId, agent.id);
    for (const run of agent.runs) {
      for (const file of run.files) {
        const rel = safeRelativePath(file.relativePath);
        if (!rel) continue;
        const dest = join(agentDir, rel);
        if (file.sha256 && existsSync(dest) && hashFile(dest) === file.sha256) continue;
        try {
          const resp = await fetch(`${base}${file.downloadUrl}`, {
            headers: { Authorization: `Bearer ${input.token}` },
          });
          if (!resp.ok) continue;
          const bytes = Buffer.from(await resp.arrayBuffer());
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, bytes);
          downloaded += 1;
        } catch (err: any) {
          logger.warn({ err: err?.message, fileId: file.id }, 'workspace artifact download failed');
        }
      }
    }
  }
  if (downloaded > 0) logger.info({ downloaded }, 'workspace artifacts synced');
}
