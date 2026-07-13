import { describe, expect, it } from 'vitest';
import { agentBeanHome, authFile, machineIdFile, managementOutboxFile, profileRoot, sanitizeProfileId } from '../src/profile-paths';

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
  it('machineIdFile is rooted at the AgentBean home', () => {
    expect(machineIdFile('/root')).toBe('/root/machine-id');
  });
  it('management outbox is isolated under the sanitized profile', () => {
    expect(managementOutboxFile('Team A', '/root')).toBe('/root/teams/team-a/management/outbox.json');
  });
  it('profileRoot defaults to ~/.agentbean when no baseDir', () => {
    expect(profileRoot('default').endsWith('.agentbean/teams/default')).toBe(true);
  });
  it('uses AGENTBEAN_HOME as the default state root when present', () => {
    const original = process.env.AGENTBEAN_HOME;
    process.env.AGENTBEAN_HOME = '/tmp/agentbean-home';
    try {
      expect(agentBeanHome()).toBe('/tmp/agentbean-home');
      expect(authFile('Team A')).toBe('/tmp/agentbean-home/teams/team-a/auth.json');
    } finally {
      if (original === undefined) {
        delete process.env.AGENTBEAN_HOME;
      } else {
        process.env.AGENTBEAN_HOME = original;
      }
    }
  });
});
