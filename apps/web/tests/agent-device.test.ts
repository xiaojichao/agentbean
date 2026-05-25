import { describe, expect, it } from 'vitest';
import { agentDeviceDisplayName } from '../lib/agent-device';

describe('agentDeviceDisplayName', () => {
  it('uses the agent deviceName when the device snapshot is not available yet', () => {
    expect(agentDeviceDisplayName({ deviceId: 'device-1', deviceName: 'MyMBP' })).toBe('MyMBP');
  });

  it('prefers the live device hostname over the agent snapshot fallback', () => {
    expect(agentDeviceDisplayName(
      { deviceId: 'device-1', deviceName: 'Old Name' },
      { hostname: 'MyMBP' },
    )).toBe('MyMBP');
  });

  it('only shows unlinked when the agent has no device identity at all', () => {
    expect(agentDeviceDisplayName({ deviceName: null })).toBe('未关联设备');
  });
});
