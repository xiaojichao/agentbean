import type { AgentSnapshot, DeviceInfo } from './schema';

export function agentDeviceDisplayName(
  agent: Pick<AgentSnapshot, 'deviceId' | 'deviceName'>,
  device?: Pick<DeviceInfo, 'hostname'>,
): string {
  const deviceName = device?.hostname?.trim() || agent.deviceName?.trim();
  if (deviceName) return deviceName;
  return agent.deviceId ? '未知设备' : '未关联设备';
}
