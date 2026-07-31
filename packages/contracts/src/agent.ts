import type { ID, UnixMs } from './common.js';

export const ADAPTER_KINDS = ['codex', 'claude-code', 'gemini', 'kimi-cli', 'hermes', 'openclaw'] as const;
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

export const AGENT_CATEGORIES = ['executor-hosted', 'agentos-hosted'] as const;
export type AgentCategory = (typeof AGENT_CATEGORIES)[number];

export const AGENT_SOURCES = ['custom', 'self-register', 'scanned'] as const;
export type AgentSource = (typeof AGENT_SOURCES)[number];

export const AGENT_STATUSES = ['connecting', 'online', 'busy', 'offline', 'error'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface SkillDto {
  name: string;
  description: string;
  scope: 'user' | 'project' | 'system';
  sourcePath: string;
  adapterKind: AdapterKind;
}

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
  ownerName?: string | null;
  deviceId?: ID;
  command?: string;
  args?: string[];
  cwd?: string;
  gatewayInstanceKey?: string;
  envKeys?: string[];
  description?: string | null;
  /** description 的来源：agent_md=扫描自 AGENTS.md/CLAUDE.md，manual=用户手工填写。 */
  descriptionSource?: 'agent_md' | 'manual';
  skills?: SkillDto[];
  /** 机械提取自 AGENTS.md/CLAUDE.md 能力小节的候选（已验证，无 sourcePath 泄露）。 */
  scannedCapabilities?: string[];
  /** LLM 总结 AGENTS.md/CLAUDE.md 全文得到的候选（AI 总结，待用户确认）。 */
  scannedCapabilitiesSummarized?: string[];
  lastSeenAt?: UnixMs;
  lastError?: string;
  /** Agent adapter 公开支持的 ProjectDocumentInputSet 合同版本。 */
  projectDocumentInputSetVersions?: number[];
}

/** daemon 扫描 AGENTS.md/CLAUDE.md 得到的 Agent 自描述（descriptor 事实层）。 */
export interface AgentDescriptorDto {
  name: string | null;
  description: string | null;
  /** 机械提取（确定性快路径）：能力小节列表项。 */
  capabilities: string[];
  /** LLM 总结（慢路径）：server 侧异步生成后写回。 */
  capabilitiesSummarized: string[];
  /** AGENTS.md/CLAUDE.md 全文（最多 8KB），供 server 异步 LLM 总结。 */
  rawContent: string | null;
  /** sha256(rawContent)，去重 + LLM 总结缓存 key。 */
  contentHash: string | null;
  sourcePath: string | null;
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
  /** Agent adapter 公开支持的 ProjectDocumentInputSet 合同版本。 */
  projectDocumentInputSetVersions?: number[];
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
  /** 创建 Agent 时由 adapter 显式声明的 ProjectDocumentInputSet 合同版本。 */
  projectDocumentInputSetVersions?: number[];
}

export interface UpdateAgentConfigCommandDto {
  userId: ID;
  teamId: ID;
  agentId: ID;
  runtimeId?: ID;
  name?: string;
  description?: string | null;
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

// 切换 Agent 在其 primary team 上的可见性（隐藏 = 移出当前团队成员页）。
// 仅允许在 primary team 上操作；Task 3/4 会通过 socket + 前端消费此 usecase。
export interface SetAgentTeamVisibilityInput {
  userId: ID;
  teamId: ID;
  agentId: ID;
  visible: boolean;
}

export interface AgentMetricsSummary {
  agentId: ID;
  totalRequests: number;
  successCount: number;
  failCount: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  lastError?: string;
  lastErrorAt?: UnixMs;
}
