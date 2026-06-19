import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  buildDaemonVersionInfo,
  compareVersions,
  getLatestDaemonVersion,
  refreshLatestDaemonVersionFromNpm,
  resetDaemonVersionCacheForTests,
} from '../src/daemon-version';

const originalFetch = globalThis.fetch;

afterEach(() => {
  resetDaemonVersionCacheForTests();
  delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
  delete process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
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

  test('getLatestDaemonVersion prefers env over cached npm latest', async () => {
    process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL = 'https://registry.test/@agentbean/daemon';
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': { latest: '0.4.0' },
    }), { status: 200 })) as typeof fetch;

    await expect(refreshLatestDaemonVersionFromNpm()).resolves.toBe('0.4.0');

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

  test('buildDaemonVersionInfo falls back to top-level daemonVersion', () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.3.0';
    const info = buildDaemonVersionInfo({}, '0.2.1');
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
