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
  fsBrowse?: boolean;
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
  /** Device Service 内用于恢复同一 Team 连接的本地 Profile 标识。 */
  profileId?: string;
  lastSeenAt?: UnixMs;
  /** 是否为当前 web 连接所在的本地设备（相对值：序列化时按 currentDeviceId 计算，daemon/admin 路径不下发）。 */
  isLocal?: boolean;
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
  /** 可直接运行的一次性 Device Service 连接命令，仅 createDeviceInvite 返回。 */
  command?: string;
  /** 连接完成后可复制使用的 Device Service 生命周期命令。 */
  operationCommands?: DeviceServiceOperationCommandDto[];
}

export interface DeviceServiceOperationCommandDto {
  id: 'status' | 'logs' | 'restart' | 'update' | 'stop' | 'start' | 'uninstall';
  label: string;
  command: string;
  advanced?: boolean;
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
