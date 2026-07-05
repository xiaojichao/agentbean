export type AdapterKind = 'codex' | 'claude-code' | 'openclaw' | 'hermes' | 'standalone';
export type AgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error';
export type AgentCategory = 'executor-hosted' | 'agentos-hosted';

export interface SkillDto {
  name: string;
  description: string;
  scope: 'user' | 'project' | 'system';
  sourcePath: string;
  adapterKind: AdapterKind;
}

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
  primaryTeamId?: string;
  visibleTeamIds?: string[];
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
  skills?: SkillDto[];
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

export type DispatchStatus =
  | 'queued' | 'sent' | 'accepted' | 'running'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface ChatMessage {
  id: string;
  teamId?: string;
  channelId: string;
  threadId?: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId: string | null;
  body: string;
  createdAt: number;
  metaJson?: string | null;
  meta?: Record<string, unknown>;
  artifacts?: Artifact[];
  workspaceRun?: WorkspaceRunDetail;
  dispatchStatus?: DispatchStatus;
  dispatchId?: string;
}

export interface Artifact {
  id: string;
  teamId?: string;
  channelId?: string;
  messageId?: string;
  dispatchId?: string;
  workspaceRunId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  relativePath?: string;
  pathKind?: string;
  sha256?: string | null;
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
  status: WorkspaceRunStatus;
  cwd?: string;
  command?: string;
  exitCode?: number;
  files: AgentWorkspaceFile[];
}

export interface TeamWorkspaceRun {
  workspaceRun: WorkspaceRunDetail;
  artifacts: WorkspaceArtifact[];
}

export interface OutboundMessage {
  id: string;
  channelId: string;
  body: string;
  status: 'pending' | 'sent' | 'failed';
}

export interface TeamSummary {
  id: string;
  ownerId: string;
  name: string;
  path: string;
  description: string | null;
  currentUserRole?: 'owner' | 'admin' | 'member';
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

// 团队内的人类成员（区别于 UserInfo：这里 role 是团队角色 owner/admin/member，
// 并携带 joinedAt 等成员元数据）。与 memberEvents().list 返回的 humans 形状一致。
export interface HumanMember {
  userId: string;
  role: string;
  username: string;
  email?: string | null;
  description?: string | null;
  joinedAt?: number;
  createdAt?: number;
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
  teamId?: string;
  ownerId?: string | null;
  userId?: string | null;
  ownerName?: string | null;
  userName?: string | null;
  name?: string;
  networkId?: string;
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
  sourceMessageId?: string;
  dispatchId: string;
  agentId: string;
  deviceId?: string;
  status: WorkspaceRunStatus;
  cwd?: string;
  command?: string;
  logExcerpt?: string;
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

export interface WorkspaceRunLogResponse {
  ok: boolean;
  teamId?: string;
  runId?: string;
  artifact?: WorkspaceArtifact;
  mode?: 'tail' | 'search';
  text?: string;
  totalLines?: number;
  returnedLines?: number;
  matchedLines?: number;
  query?: string;
  truncated?: boolean;
  error?: string;
}
