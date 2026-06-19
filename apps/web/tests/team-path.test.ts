// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { readStoredTeamPath, writeStoredTeamPath } from '../lib/team-path';

afterEach(() => {
  localStorage.clear();
});

describe('team path storage', () => {
  it('reads and writes the teamPath key', () => {
    writeStoredTeamPath('alpha');
    expect(readStoredTeamPath()).toBe('alpha');
  });

  it('migrates the legacy networkPath key when present', () => {
    localStorage.setItem('agentbean.networkPath', 'legacy-team');
    expect(readStoredTeamPath()).toBe('legacy-team');
    expect(localStorage.getItem('agentbean.teamPath')).toBe('legacy-team');
  });
});
