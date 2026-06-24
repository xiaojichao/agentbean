import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentBeanHome, authFile, profileRoot, sanitizeProfileId } from './profile-paths.js';

export interface AuthData {
  token: string;
  serverUrl: string;
  teamId: string;
  ownerId: string;
}

export interface AuthProfile extends AuthData {
  profileId: string;
}

export type RenameAuthProfileResult =
  | { ok: true; profileId: string }
  | { ok: false; error: string };

export function loadAuth(options: { profileId?: string; baseDir?: string } = {}): AuthData | null {
  try {
    const file = authFile(options.profileId, options.baseDir);
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.token !== 'string' || typeof parsed.serverUrl !== 'string' || typeof parsed.teamId !== 'string' || typeof parsed.ownerId !== 'string') {
      return null;
    }
    return parsed as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData, options: { profileId?: string; baseDir?: string } = {}): void {
  try {
    const file = authFile(options.profileId, options.baseDir);
    // Restrictive permissions: the file holds a device token (a credential).
    // 0o700 for the directory, 0o600 for the file — owner-only read/write.
    // mkdirSync/writeFileSync `mode` is masked by process umask, so this is
    // best-effort, but the explicit mode documents intent and lands 0o600 on
    // most systems. Do NOT change umask globally (process-wide side effects).
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch {
    // best-effort persistence; never throw
  }
}

export function clearAuth(options: { profileId?: string; baseDir?: string } = {}): void {
  try {
    const file = authFile(options.profileId, options.baseDir);
    if (existsSync(file)) rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

export function renameAuthProfile(options: {
  fromProfileId: string;
  toProfileId: string;
  baseDir?: string;
}): RenameAuthProfileResult {
  const fromProfileId = sanitizeProfileId(options.fromProfileId);
  const toProfileId = sanitizeProfileId(options.toProfileId);
  if (fromProfileId === toProfileId) {
    return { ok: false, error: `Profile "${fromProfileId}" is already named "${toProfileId}"` };
  }
  const source = loadAuth({ profileId: fromProfileId, baseDir: options.baseDir });
  if (!source) {
    return { ok: false, error: `Profile "${fromProfileId}" was not found` };
  }
  if (existsSync(profileRoot(toProfileId, options.baseDir))) {
    return { ok: false, error: `Profile "${toProfileId}" already exists` };
  }
  saveAuth(source, { profileId: toProfileId, baseDir: options.baseDir });
  const saved = loadAuth({ profileId: toProfileId, baseDir: options.baseDir });
  if (!saved) {
    return { ok: false, error: `Profile "${toProfileId}" could not be written` };
  }
  clearAuth({ profileId: fromProfileId, baseDir: options.baseDir });
  return { ok: true, profileId: toProfileId };
}

export function listAuthProfiles(options: { baseDir?: string } = {}): AuthProfile[] {
  try {
    const teamsDir = join(agentBeanHome(options.baseDir), 'teams');
    if (!existsSync(teamsDir)) return [];
    const profiles: AuthProfile[] = [];
    for (const entry of readdirSync(teamsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const profileId = entry.name;
      const data = loadAuth({ profileId, baseDir: options.baseDir });
      if (data) profiles.push({ ...data, profileId });
    }
    return profiles;
  } catch {
    return [];
  }
}
