import type { ID, UnixMs } from './common';

export type AdapterKind = 'codex' | 'claude-code' | 'gemini' | 'cursor' | 'custom';
export type AgentCategory = 'executor-hosted' | 'cloud' | 'external';
export type AgentSource = 'scanned' | 'created' | 'imported';
export type AgentStatus = 'online' | 'offline' | 'busy' | 'unknown';

export interface RuntimeDto {
  id: ID;
  deviceId: ID;
  adapterKind: AdapterKind;
  name: string;
  version?: string;
  status: AgentStatus;
  lastSeenAt?: UnixMs;
}

export interface AgentDto {
  id: ID;
  primaryTeamId: ID;
  visibleTeamIds: ID[];
  name: string;
  adapterKind: AdapterKind;
  category: AgentCategory;
  source: AgentSource;
  status: AgentStatus;
  deviceId?: ID;
  runtimeId?: ID;
  description?: string;
  lastSeenAt?: UnixMs;
}

export interface DiscoveredAgentDto {
  id: ID;
  deviceId: ID;
  runtimeId?: ID;
  adapterKind: AdapterKind;
  name: string;
  status: AgentStatus;
  discoveredAt: UnixMs;
}
