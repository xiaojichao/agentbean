import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAuth, listAuthProfiles, loadAuth, saveAuth } from '../src/auth-store.js';
import { deviceInstanceId, profileIdForNetwork } from '../src/profile-paths.js';

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.AGENTBEAN_HOME;
  home = mkdtempSync(join(tmpdir(), 'agentbean-daemon-profile-'));
  process.env.AGENTBEAN_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.AGENTBEAN_HOME;
  else process.env.AGENTBEAN_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('team daemon profiles', () => {
  it('stores each team auth under its own profile without overwriting another team', () => {
    saveAuth({ token: 'test01:team-a:a', serverUrl: 'http://server/agent', networkId: 'team-a' }, { profileId: 'team-a' });
    saveAuth({ token: 'test01:team-b:b', serverUrl: 'http://server/agent', networkId: 'team-b' }, { profileId: 'team-b' });

    expect(loadAuth({ profileId: 'team-a' })?.token).toBe('test01:team-a:a');
    expect(loadAuth({ profileId: 'team-b' })?.token).toBe('test01:team-b:b');
    expect(listAuthProfiles().map((profile) => profile.profileId).sort()).toEqual(['team-a', 'team-b']);
    expect(existsSync(join(home, 'auth.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'teams', 'team-a', 'auth.json'), 'utf8')).networkId).toBe('team-a');
  });

  it('keeps legacy default auth compatible when no profile is selected', () => {
    saveAuth({ token: 'test01:default:legacy', serverUrl: 'http://server/agent', networkId: 'default' });

    expect(loadAuth()?.token).toBe('test01:default:legacy');
    expect(existsSync(join(home, 'auth.json'))).toBe(true);
    clearAuth();
    expect(loadAuth()).toBeNull();
  });

  it('derives stable team-scoped device instance ids from the same machine id', () => {
    const machineId = 'machine-shaw-mbp';

    expect(deviceInstanceId(machineId, 'team-a')).toBe(deviceInstanceId(machineId, 'team-a'));
    expect(deviceInstanceId(machineId, 'team-a')).not.toBe(deviceInstanceId(machineId, 'team-b'));
    expect(profileIdForNetwork('AgentBean Dev')).toBe('agentbean-dev');
  });
});
