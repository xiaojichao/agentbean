import { describe, expect, it } from 'vitest';
import { daemonVersionDisplay } from '../lib/daemon-version';

describe('daemonVersionDisplay', () => {
  it('shows current and latest daemon versions when an upgrade is available', () => {
    expect(daemonVersionDisplay({
      status: 'online',
      systemInfo: { daemonVersion: '0.1.13' },
      latestDaemonVersion: '0.1.19',
      daemonUpdateAvailable: true,
    })).toEqual({
      currentLabel: 'v0.1.13',
      latestLabel: 'v0.1.19',
      updateAvailable: true,
      unknown: false,
    });
  });

  it('keeps unknown versions non-blocking', () => {
    expect(daemonVersionDisplay({ status: 'online', systemInfo: null })).toMatchObject({
      currentLabel: '版本未知',
      updateAvailable: false,
      unknown: true,
    });
  });
});
