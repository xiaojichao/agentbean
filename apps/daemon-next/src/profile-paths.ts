import { join } from 'node:path';
import { homedir } from 'node:os';

export function sanitizeProfileId(profileId?: string): string {
  const raw = (profileId ?? '').trim();
  if (!raw) return 'default';
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'default';
}

export function profileRoot(profileId?: string, baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.agentbean'), 'teams', sanitizeProfileId(profileId));
}

export function authFile(profileId?: string, baseDir?: string): string {
  return join(profileRoot(profileId, baseDir), 'auth.json');
}
