import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuthData } from '../src/auth-store';
import { loadAuth, saveAuth, clearAuth, listAuthProfiles } from '../src/auth-store';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'auth-')));
const data: AuthData = { token: 'tok-1', serverUrl: 'http://s', teamId: 'team-1', ownerId: 'owner-1' };

describe('auth-store', () => {
  it('save → load round-trip', () => {
    saveAuth(data, { profileId: 'team-1', baseDir: base });
    expect(loadAuth({ profileId: 'team-1', baseDir: base })).toEqual(data);
  });
  it('load returns null when missing or corrupt', () => {
    expect(loadAuth({ profileId: 'missing', baseDir: base })).toBeNull();
  });
  it('returns null on corrupt JSON', () => {
    mkdirSync(join(base, 'teams/corrupt'), { recursive: true });
    writeFileSync(join(base, 'teams/corrupt/auth.json'), '{not valid json');
    expect(loadAuth({ profileId: 'corrupt', baseDir: base })).toBeNull();
  });
  it('returns null when token or serverUrl is missing/invalid', () => {
    mkdirSync(join(base, 'teams/invalid'), { recursive: true });
    writeFileSync(join(base, 'teams/invalid/auth.json'), JSON.stringify({ teamId: 't', ownerId: 'o' }));
    expect(loadAuth({ profileId: 'invalid', baseDir: base })).toBeNull();
  });
  it('clear removes the auth file', () => {
    saveAuth(data, { profileId: 'team-1', baseDir: base });
    clearAuth({ profileId: 'team-1', baseDir: base });
    expect(loadAuth({ profileId: 'team-1', baseDir: base })).toBeNull();
  });
  it('listAuthProfiles enumerates saved profiles', () => {
    saveAuth(data, { profileId: 'team-1', baseDir: base });
    saveAuth({ ...data, token: 'tok-2', teamId: 'team-2' }, { profileId: 'team-2', baseDir: base });
    const profiles = listAuthProfiles({ baseDir: base });
    expect(profiles.map((p) => p.profileId).sort()).toEqual(['team-1', 'team-2']);
    expect(profiles.find((p) => p.profileId === 'team-2')?.token).toBe('tok-2');
  });
});
