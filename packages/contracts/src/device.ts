import type { ID, UnixMs } from './common.js';
import type { AgentDto, RuntimeDto } from './agent.js';

export type DeviceStatus = 'online' | 'offline' | 'unknown';

export interface DeviceSystemInfoDto {
  hostname?: string;
  platform?: string;
  arch?: string;
  release?: string;
}

export interface DeviceCapabilitiesDto {
  scanAgents?: boolean;
  runDispatches?: boolean;
}

export interface DeviceDto {
  id: ID;
  teamId: ID;
  ownerId: ID;
  status: DeviceStatus;
  name?: string;
  systemInfo?: DeviceSystemInfoDto;
  capabilities?: DeviceCapabilitiesDto;
  lastSeenAt?: UnixMs;
}

export interface DeviceDetailDto extends DeviceDto {
  runtimes: RuntimeDto[];
  agents: AgentDto[];
}
