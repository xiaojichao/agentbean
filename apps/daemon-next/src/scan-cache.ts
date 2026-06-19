import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { DaemonScanSnapshot } from './index.js';

function sanitizeProfile(profileId?: string): string {
  const raw = (profileId ?? 'default').trim() || 'default';
  return raw.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function scanCachePath(profileId?: string, baseDir?: string): string {
  const root = baseDir ?? join(homedir(), '.agentbean');
  return join(root, 'teams', sanitizeProfile(profileId), 'scanned-agents.json');
}

export function loadScanCache(profileId?: string, baseDir?: string): DaemonScanSnapshot | null {
  const file = scanCachePath(profileId, baseDir);
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.runtimes) || !Array.isArray(parsed.agents)) {
      return null;
    }
    return parsed as DaemonScanSnapshot;
  } catch {
    return null;
  }
}

export function saveScanCache(snapshot: DaemonScanSnapshot, profileId?: string, baseDir?: string): void {
  try {
    const file = scanCachePath(profileId, baseDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
  } catch {
    // cache is an optimization; never throw on write failure
  }
}
