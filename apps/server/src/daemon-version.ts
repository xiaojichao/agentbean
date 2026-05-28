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

function getPackagedLatestDaemonVersion(): string | null {
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

let cachedNpmLatestVersion: string | null = null;
let lastNpmLatestCheckedAt = 0;
let pendingNpmLatestRefresh: Promise<string | null> | null = null;

function npmRegistryUrl(): string {
  return process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL ?? 'https://registry.npmjs.org/%40agentbean%2Fdaemon';
}

function npmRefreshIntervalMs(): number {
  const raw = Number.parseInt(process.env.AGENT_BEAN_DAEMON_VERSION_REFRESH_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5 * 60_000;
}

function npmFetchTimeoutMs(): number {
  const raw = Number.parseInt(process.env.AGENT_BEAN_DAEMON_VERSION_FETCH_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 2_000;
}

async function fetchNpmLatestDaemonVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), npmFetchTimeoutMs());
  try {
    const res = await fetch(npmRegistryUrl(), {
      signal: controller.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    });
    if (!res.ok) return null;
    const json = await res.json() as { 'dist-tags'?: { latest?: unknown } };
    return cleanVersion(json['dist-tags']?.latest);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function getLatestDaemonVersion(): string | null {
  return cachedNpmLatestVersion ?? getPackagedLatestDaemonVersion();
}

export function resetDaemonVersionCacheForTests(): void {
  cachedNpmLatestVersion = null;
  lastNpmLatestCheckedAt = 0;
  pendingNpmLatestRefresh = null;
}

export async function refreshLatestDaemonVersionFromNpm(): Promise<string | null> {
  if (process.env.NODE_ENV === 'test' && !process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL) {
    return getLatestDaemonVersion();
  }

  const now = Date.now();
  if (cachedNpmLatestVersion && now - lastNpmLatestCheckedAt < npmRefreshIntervalMs()) {
    return cachedNpmLatestVersion;
  }
  if (pendingNpmLatestRefresh) return pendingNpmLatestRefresh;

  pendingNpmLatestRefresh = fetchNpmLatestDaemonVersion()
    .then((latest) => {
      lastNpmLatestCheckedAt = Date.now();
      if (latest) cachedNpmLatestVersion = latest;
      return getLatestDaemonVersion();
    })
    .finally(() => {
      pendingNpmLatestRefresh = null;
    });
  return pendingNpmLatestRefresh;
}

export function startDaemonVersionRefresh(onRefresh?: () => void): () => void {
  if (process.env.NODE_ENV === 'test' && !process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL) {
    return () => {};
  }

  let stopped = false;
  const refresh = async () => {
    const before = getLatestDaemonVersion();
    await refreshLatestDaemonVersionFromNpm();
    if (!stopped && before !== getLatestDaemonVersion()) onRefresh?.();
  };
  void refresh();
  const timer = setInterval(() => { void refresh(); }, npmRefreshIntervalMs());
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
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
