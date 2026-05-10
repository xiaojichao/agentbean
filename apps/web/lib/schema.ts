export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'standalone';
export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';
export type AgentCategory = 'executor-hosted' | 'agentos-hosted' | 'standalone-cli';

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
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  deviceId?: string;
  publishedNetworkIds?: string[];
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

export interface ChannelSummary { id: string; name: string; visibility?: 'public' | 'private'; createdBy?: string | null; createdAt: number; }

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
  downloadUrl: string;
  previewUrl: string;
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
  networkId: string;
  hostname?: string;
  tailscaleIp?: string;
  lastSeenAt: number;
  status: AgentStatus;
  agentIds: string[];
}
