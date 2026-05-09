import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTH_DIR = join(homedir(), '.agentbean');
const AUTH_FILE = join(AUTH_DIR, 'auth.json');

export interface AuthData {
  token: string;
  serverUrl: string;
  userId?: string;
  networkId?: string;
}

export function loadAuth(): AuthData | null {
  if (!existsSync(AUTH_FILE)) return null;
  try {
    return JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as AuthData;
  } catch {
    return null;
  }
}

export function saveAuth(data: AuthData): void {
  if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2));
}

export function clearAuth(): void {
  if (existsSync(AUTH_FILE)) unlinkSync(AUTH_FILE);
}
