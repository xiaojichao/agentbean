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
    if (!isDaemonScanSnapshot(parsed)) {
      return null;
    }
    return parsed;
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

function isDaemonScanSnapshot(value: unknown): value is DaemonScanSnapshot {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const snapshot = value as { runtimes?: unknown; agents?: unknown };
  return Array.isArray(snapshot.runtimes)
    && Array.isArray(snapshot.agents)
    && snapshot.runtimes.every(isRuntimeReport)
    && snapshot.agents.every(isAgentReport);
}

function isRuntimeReport(value: unknown): value is DaemonScanSnapshot['runtimes'][number] {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const runtime = value as { adapterKind?: unknown; name?: unknown; command?: unknown };
  return typeof runtime.adapterKind === 'string'
    && typeof runtime.name === 'string'
    && (runtime.command === undefined || typeof runtime.command === 'string');
}

function isAgentReport(value: unknown): value is DaemonScanSnapshot['agents'][number] {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const agent = value as { adapterKind?: unknown; name?: unknown; category?: unknown; gatewayInstanceKey?: unknown };
  return typeof agent.adapterKind === 'string'
    && typeof agent.name === 'string'
    && typeof agent.category === 'string'
    && (agent.gatewayInstanceKey === undefined || typeof agent.gatewayInstanceKey === 'string');
}
