import { afterEach, describe, expect, test } from 'vitest';
import {
  buildDaemonVersionInfo,
  compareVersions,
  getLatestDaemonVersion,
  resetDaemonVersionCacheForTests,
} from '../src/daemon-version';

afterEach(() => {
  resetDaemonVersionCacheForTests();
  delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
});

describe('daemon-version', () => {
  test('compareVersions orders semver correctly', () => {
    expect(compareVersions('0.2.1', '0.2.0')).toBeGreaterThan(0);
    expect(compareVersions('0.2.0', '0.2.1')).toBeLessThan(0);
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0);
  });

  test('getLatestDaemonVersion prefers env over packaged', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '9.9.9';
    expect(getLatestDaemonVersion()).toBe('9.9.9');
  });

  test('buildDaemonVersionInfo reports update-available when current < latest', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    const info = buildDaemonVersionInfo({ daemonVersion: '0.2.1' });
    expect(info).toEqual({
      current: '0.2.1', latest: '0.3.0', updateAvailable: true, status: 'update-available',
    });
  });

  test('buildDaemonVersionInfo reports current when up-to-date', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.2.1';
    const info = buildDaemonVersionInfo({ daemonVersion: '0.2.1' });
    expect(info.status).toBe('current');
    expect(info.updateAvailable).toBe(false);
  });

  test('buildDaemonVersionInfo is unknown when current missing', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    const info = buildDaemonVersionInfo({});
    expect(info.status).toBe('unknown');
    expect(info.current).toBeNull();
  });
});
