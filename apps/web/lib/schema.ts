export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'standalone';
export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';
export type AgentCategory = 'executor-hosted' | 'agentos-hosted';

export interface AgentSnapshot {
  id: string;
  name: string;
  role: string;
  adapterKind: AdapterKind;
  status: AgentStatus;
  lastSeenAt: number;
  lastError?: string;
  connectCommand: string;
  visibility?: 'public' | 'private';
  category?: AgentCategory;
  networkId?: string;
  ownerId?: string | null;
  ownerName?: string | null;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  description?: string | null;
  deviceId?: string;
  deviceName?: string | null;
  publishedNetworkIds?: string[];
  unpublishedNetworkIds?: string[];
  source?: 'self-register' | 'scanned' | 'custom';
}

export interface DiscoveredAgent {
  name: string;
  category: AgentCategory;
  adapterKind: AdapterKind;
  command: string;
  args?: string[];
  cwd?: string;
  source: 'gateway' | 'filesystem';
}

export interface RuntimeInfo {
  name: string;
  adapterKind: AdapterKind;
  command: string;
  installed: boolean;
}

export type ConnState = 'connecting' | 'open' | 'lost';

export interface ChannelSummary { id: string; name: string; description?: string | null; visibility?: 'public' | 'private'; createdBy?: string | null; createdAt: number; archivedAt?: number | null; }

export interface ChatMessage {
  id: string;
  channelId: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson?: string | null;
  artifacts?: Artifact[];
}

export interface Artifact {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: number;
  downloadUrl?: string;
  previewUrl?: string;
}

export interface AgentWorkspaceFile extends Artifact {
  pathKind: string;
  relativePath: string;
  downloadUrl: string;
  previewUrl: string;
  originalPath?: string | null;
  sha256?: string | null;
  deviceId?: string | null;
}

export interface AgentWorkspaceRun {
  runId: string;
  createdAt: number;
  updatedAt: number;
  files: AgentWorkspaceFile[];
}

export interface OutboundMessage {
  id: string;
  channelId: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
}

export interface NetworkSummary {
  id: string;
  ownerId: string;
  name: string;
  path: string;
  description: string | null;
  visibility?: 'public' | 'private';
  type?: 'public' | 'local' | 'private';
  createdAt: number;
}

export interface UserInfo {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'user';
  primaryTeamId?: string;
}

export interface InviteInfo {
  code: string;
  expiresAt: number;
  command?: string;
}

export interface JoinLinkInfo {
  id: string;
  code: string;
  url: string;
  maxUses: number | null;
  usesCount: number;
  expiresAt: number | null;
  createdAt: number;
  usedAt?: number | null;
}

export interface AgentMetricsSummary {
  agentId: string;
  totalRequests: number;
  successCount: number;
  failCount: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  lastError?: string;
  lastErrorAt?: number;
}

export interface DeviceInfo {
  id: string;
  userId: string;
  ownerName?: string | null;
  userName?: string | null;
  networkId: string;
  hostname?: string;
  lastSeenAt: number;
  status: AgentStatus;
  agentIds: string[];
  canManage?: boolean;
  isLocal?: boolean;
  runtimes?: RuntimeInfo[];
  connectCommand?: string | null;
  latestDaemonVersion?: string | null;
  daemonUpdateAvailable?: boolean;
  daemonVersionInfo?: {
    current: string | null;
    latest: string | null;
    updateAvailable: boolean;
    status: 'current' | 'update-available' | 'unknown';
  };
  systemInfo?: {
    platform?: string;
    arch?: string;
    osVersion?: string;
    hostname?: string;
    cpuModel?: string;
    cpuCores?: number;
    totalMemoryGB?: number;
    freeMemoryGB?: number;
    nodeVersion?: string;
    daemonVersion?: string;
  } | null;
}

export type WorkspaceRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface WorkspaceRunDetail {
  id: string;
  teamId: string;
  channelId: string;
  messageId?: string;
  dispatchId: string;
  agentId: string;
  deviceId?: string;
  status: WorkspaceRunStatus;
  cwd?: string;
  exitCode?: number;
  startedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
  artifactIds: string[];
}

export interface WorkspaceArtifact {
  id: string;
  teamId: string;
  channelId: string;
  messageId?: string;
  dispatchId?: string;
  workspaceRunId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  relativePath?: string;
  pathKind?: string;
  sha256?: string;
  createdAt: number;
}
