import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function agentbeanHome(): string {
  return process.env.AGENTBEAN_HOME?.trim() || join(homedir(), '.agentbean');
}

export function profileIdForNetwork(networkId?: string | null): string {
  const source = networkId?.trim() || 'default';
  const slug = source.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'default';
}

export function profileRoot(profileId?: string | null): string {
  const explicitDir = process.env.AGENTBEAN_PROFILE_DIR?.trim();
  if (explicitDir && profileId) return explicitDir;
  if (!profileId) return agentbeanHome();
  return join(agentbeanHome(), 'teams', profileIdForNetwork(profileId));
}

export function ensureProfileRoot(profileId?: string | null): string {
  const root = profileRoot(profileId);
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

export function authFile(profileId?: string | null): string {
  return join(profileRoot(profileId), 'auth.json');
}

export function scanCacheFile(profileId?: string | null): string {
  return join(profileRoot(profileId), 'scanned-agents.json');
}

export function localAgentsDir(profileId?: string | null): string {
  return join(profileRoot(profileId), 'agents');
}

export function deviceInstanceId(machineId: string, networkId: string): string {
  const hash = createHash('sha256').update(`${networkId}:${machineId}`).digest('hex');
  return `dev_${hash.slice(0, 24)}`;
}
