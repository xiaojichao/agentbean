import { afterEach, describe, expect, it } from 'vitest';
import { buildDaemonVersionInfo, compareVersions } from '../src/daemon-version.js';

const previousLatest = process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;

afterEach(() => {
  if (previousLatest === undefined) delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
  else process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = previousLatest;
});

describe('daemon version compatibility metadata', () => {
  it('compares semantic versions without requiring an external dependency', () => {
    expect(compareVersions('0.1.18', '0.1.19')).toBeLessThan(0);
    expect(compareVersions('0.1.19', '0.1.19')).toBe(0);
    expect(compareVersions('0.2.0', '0.1.19')).toBeGreaterThan(0);
  });

  it('marks older daemon versions as upgradeable', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.1.19';
    expect(buildDaemonVersionInfo({ daemonVersion: '0.1.13' })).toEqual({
      current: '0.1.13',
      latest: '0.1.19',
      updateAvailable: true,
      status: 'update-available',
    });
  });

  it('keeps missing daemon versions compatible and non-blocking', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.1.19';
    expect(buildDaemonVersionInfo(null)).toEqual({
      current: null,
      latest: '0.1.19',
      updateAvailable: false,
      status: 'unknown',
    });
  });
});
