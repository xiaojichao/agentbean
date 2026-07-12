const TEAM_PATH_KEY = 'agentbean.teamPath';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readStoredTeamPath(storage: StorageLike): string | null {
  return storage.getItem(TEAM_PATH_KEY);
}

export function writeStoredTeamPath(storage: StorageLike, teamPath: string): void {
  storage.setItem(TEAM_PATH_KEY, teamPath);
}
