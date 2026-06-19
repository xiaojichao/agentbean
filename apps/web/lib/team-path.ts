const TEAM_PATH_STORAGE_KEY = 'agentbean.teamPath';
const LEGACY_NETWORK_PATH_STORAGE_KEY = 'agentbean.networkPath';

export function readStoredTeamPath(): string | null {
  if (typeof window === 'undefined') return null;
  const stored = window.localStorage.getItem(TEAM_PATH_STORAGE_KEY);
  if (stored) return stored;

  const legacy = window.localStorage.getItem(LEGACY_NETWORK_PATH_STORAGE_KEY);
  if (legacy) {
    window.localStorage.setItem(TEAM_PATH_STORAGE_KEY, legacy);
    return legacy;
  }
  return null;
}

export function writeStoredTeamPath(teamPath: string) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(TEAM_PATH_STORAGE_KEY, teamPath);
  window.localStorage.removeItem(LEGACY_NETWORK_PATH_STORAGE_KEY);
}
