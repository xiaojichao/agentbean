// @vitest-environment jsdom

import { describe, expect, test } from 'vitest';
import { clearStoredAuth, resolveDeviceLoginDeviceId } from '../lib/socket';

describe('web socket helpers', () => {
  test('resolves device-login local device hint from invite, credentials, then machineId', () => {
    expect(resolveDeviceLoginDeviceId({
      invite: { deviceId: 'invite-device' },
      credentials: { deviceId: 'credential-device', machineId: 'machine-1' },
    })).toBe('invite-device');
    expect(resolveDeviceLoginDeviceId({
      credentials: { deviceId: 'credential-device', machineId: 'machine-1' },
    })).toBe('credential-device');
    expect(resolveDeviceLoginDeviceId({
      credentials: { machineId: 'machine-1' },
    })).toBe('machine-1');
  });

  test('clears user and Device credentials together', () => {
    localStorage.setItem('agentbean.token', 'user-token');
    localStorage.setItem('agentbean.deviceToken', 'device-token');
    localStorage.setItem('agentbean.deviceId', 'device-1');

    clearStoredAuth();

    expect(localStorage.getItem('agentbean.token')).toBeNull();
    expect(localStorage.getItem('agentbean.deviceToken')).toBeNull();
    expect(localStorage.getItem('agentbean.deviceId')).toBeNull();
  });
});
