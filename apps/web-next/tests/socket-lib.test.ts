import { describe, expect, test } from 'vitest';
import { resolveDeviceLoginDeviceId } from '../lib/socket';

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
});
