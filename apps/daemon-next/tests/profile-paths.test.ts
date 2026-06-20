import { describe, expect, it } from 'vitest';
import { authFile, profileRoot, sanitizeProfileId } from '../src/profile-paths';

describe('profile-paths', () => {
  it('sanitizes profileId (lowercase, non-alnum → -)', () => {
    expect(sanitizeProfileId('AgentBean Dev')).toBe('agentbean-dev');
    expect(sanitizeProfileId('../../x')).toBe('x');
    expect(sanitizeProfileId('')).toBe('default');
    expect(sanitizeProfileId(undefined)).toBe('default');
  });
  it('authFile nests under teams/{profileId}/auth.json', () => {
    expect(authFile('team-1', '/root')).toBe('/root/teams/team-1/auth.json');
  });
  it('profileRoot defaults to ~/.agentbean when no baseDir', () => {
    expect(profileRoot('default').endsWith('.agentbean/teams/default')).toBe(true);
  });
});
