import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentbeanHome, authFile, ensureProfileRoot, profileIdForNetwork } from './profile-paths.js';

export interface AuthData {
  token: string;
  serverUrl: string;
  userId?: string;
  networkId?: string;
}

export type AuthProfileOptions = { profileId?: string | null };
export type AuthProfile = AuthData & { profileId: string };

export function loadAuth(options: AuthProfileOptions = {}): AuthData | null {
  const file = authFile(options.profileId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData, options: AuthProfileOptions = {}): void {
  const profileId = options.profileId ?? null;
  ensureProfileRoot(profileId);
  writeFileSync(authFile(profileId), JSON.stringify(data, null, 2));
}

export function clearAuth(options: AuthProfileOptions = {}): void {
  const file = authFile(options.profileId);
  if (existsSync(file)) unlinkSync(file);
}

export function listAuthProfiles(): AuthProfile[] {
  const profiles: AuthProfile[] = [];
  const teamsDir = join(agentbeanHome(), 'teams');
  if (existsSync(teamsDir)) {
    for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const auth = loadAuth({ profileId: entry.name });
      if (auth?.networkId) profiles.push({ ...auth, profileId: entry.name });
    }
  }
  const legacy = loadAuth();
  if (legacy?.networkId) {
    const profileId = profileIdForNetwork(legacy.networkId);
    if (!profiles.some((profile) => profile.profileId === profileId)) profiles.push({ ...legacy, profileId });
  }
  return profiles;
}
