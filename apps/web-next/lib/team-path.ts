const TEAM_PATH_KEY = 'agentbean.teamPath';
const LEGACY_PATH_KEY = ['agentbean', 'networkPath'].join('.');

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readStoredTeamPath(storage: StorageLike): string | null {
  const current = storage.getItem(TEAM_PATH_KEY);
  if (current) return current;

  const legacy = storage.getItem(LEGACY_PATH_KEY);
  if (!legacy) return null;

  storage.setItem(TEAM_PATH_KEY, legacy);
  storage.removeItem(LEGACY_PATH_KEY);
  return legacy;
}

export function writeStoredTeamPath(storage: StorageLike, teamPath: string): void {
  storage.setItem(TEAM_PATH_KEY, teamPath);
  storage.removeItem(LEGACY_PATH_KEY);
}
