import type { ID, UnixMs } from './common.js';

export const ADAPTER_KINDS = ['codex', 'claude-code', 'gemini', 'kimi-cli', 'hermes', 'openclaw'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const AGENT_CATEGORIES = ['executor-hosted', 'agentos-hosted'] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

export const AGENT_SOURCES = ['custom', 'self-register', 'scanned'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

export const AGENT_STATUSES = ['connecting', 'online', 'busy', 'offline', 'error'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface RuntimeDto {
  id: ID;
  deviceId: ID;
  adapterKind: AdapterKind;
  name: string;
  installed: boolean;
  command?: string;
  cwd?: string;
  normalizedCommandKey?: string;
  normalizedCwdKey?: string;
  version?: string;
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
  ownerId?: ID;
  deviceId?: ID;
  command?: string;
  args?: string[];
  cwd?: string;
  envKeys?: string[];
  description?: string;
  lastSeenAt?: UnixMs;
  lastError?: string;
}

export interface DiscoveredAgentDto {
  deviceId: ID;
  teamId: ID;
  adapterKind: AdapterKind;
  name: string;
  category: AgentCategory;
  source: 'scanned' | 'self-register';
  command?: string;
  args?: string[];
  cwd?: string;
  gatewayId?: string;
  gatewayName?: string;
  gatewayInstanceKey?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateAgentCommandDto {
  userId: ID;
  teamId: ID;
  deviceId: ID;
  runtimeId?: ID;
  name: string;
  description?: string;
  adapterKind?: AdapterKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PublishAgentCommandDto {
  userId: ID;
  teamId: ID;
  agentId: ID;
  targetTeamId: ID;
}

export interface UnpublishAgentCommandDto {
  userId: ID;
  teamId: ID;
  agentId: ID;
  targetTeamId: ID;
}

export interface UpdateAgentConfigCommandDto {
  userId: ID;
  teamId: ID;
  agentId: ID;
  runtimeId?: ID;
  name?: string;
  description?: string;
  adapterKind?: AdapterKind;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface DeleteAgentCommandDto {
  userId: ID;
  teamId: ID;
  agentId: ID;
}
