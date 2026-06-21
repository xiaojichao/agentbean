import type { ID, UnixMs } from './common.js';
import type { TeamDto } from './team.js';
import type { AgentDto, RuntimeDto } from './agent.js';

export type DeviceStatus = 'online' | 'offline' | 'unknown';

export type DaemonVersionStatus = 'current' | 'update-available' | 'unknown';

export interface DaemonVersionInfo {
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  status: DaemonVersionStatus;
}

export interface DeviceSystemInfoDto {
  hostname?: string;
  platform?: string;
  arch?: string;
  release?: string;
  osVersion?: string;
  cpuModel?: string;
  cpuCores?: number;
  totalMemoryGB?: number;
  freeMemoryGB?: number;
  nodeVersion?: string;
  daemonVersion?: string;
}

export interface DeviceCapabilitiesDto {
  scanAgents?: boolean;
  runDispatches?: boolean;
}

export interface DeviceDto {
  id: ID;
  teamId: ID;
  ownerId: ID;
  ownerName?: string;
  status: DeviceStatus;
  name?: string;
  systemInfo?: DeviceSystemInfoDto;
  capabilities?: DeviceCapabilitiesDto;
  daemonVersion?: string;
  daemonVersionInfo?: DaemonVersionInfo;
  latestDaemonVersion?: string | null;
  daemonUpdateAvailable?: boolean;
  connectCommand?: string;
  lastSeenAt?: UnixMs;
}

export interface DeviceDetailDto extends DeviceDto {
  runtimes: RuntimeDto[];
  agents: AgentDto[];
}

export interface DeviceInviteDto {
  id: ID;
  code: string;
  teamId: ID;
  createdBy: ID;
  createdAt: UnixMs;
  expiresAt?: UnixMs;
  completedAt?: UnixMs;
  profileId?: string;
  /** 可直接运行的 daemon 连接命令，仅 createDeviceInvite 返回；daemon 侧等待/完成流程不返回。 */
  command?: string;
}

export interface CreateDeviceInviteCommandDto {
  userId: ID;
  teamId: ID;
  profileId?: string;
  expiresAt?: UnixMs;
}

export interface CompleteDeviceInviteCommandDto {
  userId: ID;
  code: string;
  serverUrl?: string;
}

export interface WaitForDeviceInviteCommandDto {
  code: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
  serverUrl?: string;
}

export interface DeviceInviteCredentialsDto {
  token: string;
  teamId: ID;
  ownerId: ID;
  deviceId?: ID;
  serverUrl?: string;
  machineId?: string;
  profileId?: string;
  hostname?: string;
}

export interface DeviceInviteAckDto {
  invite: DeviceInviteDto;
  team: TeamDto;
}
