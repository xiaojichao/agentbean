import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildDaemonVersionInfo,
  compareVersions,
  refreshLatestDaemonVersionFromNpm,
  resetDaemonVersionCacheForTests,
} from '../src/daemon-version.js';

const previousLatest = process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
const previousRegistryUrl = process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL;

afterEach(() => {
  if (previousLatest === undefined) delete process.env.AGENT_BEAN_DAEMON_LATEST_VERSION;
  else process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = previousLatest;
  if (previousRegistryUrl === undefined) delete process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL;
  else process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL = previousRegistryUrl;
  vi.restoreAllMocks();
  resetDaemonVersionCacheForTests();
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

  it('refreshes the latest daemon version from npm metadata', async () => {
    process.env.AGENT_BEAN_DAEMON_LATEST_VERSION = '0.1.19';
    process.env.AGENT_BEAN_DAEMON_NPM_REGISTRY_URL = 'https://registry.example.test/@agentbean/daemon';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      'dist-tags': { latest: '0.1.34' },
    }), { status: 200 })));

    await refreshLatestDaemonVersionFromNpm();

    expect(buildDaemonVersionInfo({ daemonVersion: '0.1.33' })).toEqual({
      current: '0.1.33',
      latest: '0.1.34',
      updateAvailable: true,
      status: 'update-available',
    });
  });
});
