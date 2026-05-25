import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type DaemonVersionStatus = 'current' | 'update-available' | 'unknown';

export interface DaemonVersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  status: DaemonVersionStatus;
}

function cleanVersion(version: unknown): string | null {
  if (typeof version !== 'string') return null;
  const trimmed = version.trim();
  if (!trimmed || trimmed === 'unknown') return null;
  return trimmed.replace(/^v/i, '');
}

function parseVersion(version: string): number[] {
  return version
    .split(/[.-]/)
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

function readPackageVersion(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return cleanVersion(parsed.version);
  } catch {
    return null;
  }
}

export function getLatestDaemonVersion(): string | null {
  const fromEnv = cleanVersion(process.env.AGENT_BEAN_DAEMON_LATEST_VERSION);
  if (fromEnv) return fromEnv;

  const candidates = [
    resolve(process.cwd(), '../daemon/package.json'),
    resolve(process.cwd(), 'apps/daemon/package.json'),
    resolve(process.cwd(), '../../apps/daemon/package.json'),
  ];
  for (const candidate of candidates) {
    const version = readPackageVersion(candidate);
    if (version) return version;
  }
  return null;
}

export function buildDaemonVersionInfo(systemInfo?: Record<string, unknown> | null): DaemonVersionInfo {
  const current = cleanVersion(systemInfo?.daemonVersion);
  const latest = getLatestDaemonVersion();
  if (!current || !latest) {
    return { current, latest, updateAvailable: false, status: 'unknown' };
  }
  const updateAvailable = compareVersions(current, latest) < 0;
  return {
    current,
    latest,
    updateAvailable,
    status: updateAvailable ? 'update-available' : 'current',
  };
}
