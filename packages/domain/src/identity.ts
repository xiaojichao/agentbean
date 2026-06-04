export type AgentIdentitySource = 'custom' | 'self-register' | 'scanned' | 'runtime';
export type AgentIdentityCategory =
  | 'custom'
  | 'executor-hosted'
  | 'agentos-concrete'
  | 'agentos-gateway'
  | 'runtime';
export type AgentIdentityStatus = 'busy' | 'online' | 'connecting' | 'error' | 'offline' | 'unknown';
export type PathPlatform = 'linux' | 'windows' | 'darwin' | 'unknown';

export interface AgentIdentityRecord {
  id: string;
  primaryTeamId: string;
  deviceId: string;
  adapterKind: string;
  name: string;
  source: AgentIdentitySource;
  category: AgentIdentityCategory;
  status: AgentIdentityStatus;
  lastSeenAt: number;
  visibleTeamIds?: string[];
  gatewayInstanceKey?: string;
  gatewayName?: string;
  command?: string;
  cwd?: string;
  args?: string[];
  channelMemberIds?: string[];
  historyMessageIds?: string[];
}

export type AgentIdentityKey =
  | { kind: 'custom'; agentId: string }
  | {
      kind: 'self-register';
      teamId: string;
      deviceId: string;
      adapterKind: string;
      name: string;
    }
  | {
      kind: 'agentos-concrete';
      teamId: string;
      deviceId: string;
      adapterKind: string;
      name: string;
    }
  | {
      kind: 'agentos-gateway';
      teamId: string;
      deviceId: string;
      adapterKind: string;
      gatewayInstanceKey: string;
    }
  | {
      kind: 'runtime';
      teamId: string;
      deviceId: string;
      adapterKind: string;
      location: string;
      argsKey: string;
    };

export interface AgentProjection extends AgentIdentityRecord {
  visibleTeamIds: string[];
}

const ADAPTER_ALIASES: Record<string, string> = {
  claude: 'claude-code',
  'codex-cli': 'codex',
  kimi: 'kimi-cli',
};

const STATUS_RANK: Record<AgentIdentityStatus, number> = {
  busy: 5,
  online: 4,
  connecting: 3,
  error: 2,
  offline: 1,
  unknown: 0,
};

export function normalizeAdapterKind(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return ADAPTER_ALIASES[normalized] ?? normalized;
}

export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

export function normalizePathForComparison(
  value: string,
  options: { platform: PathPlatform; caseSensitive?: boolean },
): string {
  const slashNormalized = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (options.platform === 'windows') {
    return slashNormalized.toLowerCase();
  }
  if (options.platform === 'darwin' && options.caseSensitive === false) {
    return slashNormalized.toLowerCase();
  }
  return slashNormalized;
}

export function identityKeyFor(record: AgentIdentityRecord): AgentIdentityKey {
  const adapterKind = normalizeAdapterKind(record.adapterKind);
  const common = {
    teamId: record.primaryTeamId,
    deviceId: record.deviceId,
    adapterKind,
  };

  if (record.source === 'custom') {
    return { kind: 'custom', agentId: record.id };
  }

  if (record.source === 'runtime' || record.category === 'runtime') {
    return {
      kind: 'runtime',
      ...common,
      location: normalizePathForComparison(record.command ?? record.cwd ?? record.name, {
        platform: 'unknown',
      }),
      argsKey: normalizeArgs(record.args),
    };
  }

  if (record.source === 'self-register') {
    return {
      kind: 'self-register',
      ...common,
      name: normalizeAgentName(record.name),
    };
  }

  if (record.category === 'agentos-gateway') {
    return {
      kind: 'agentos-gateway',
      ...common,
      gatewayInstanceKey:
        record.gatewayInstanceKey ??
        normalizeAgentName(record.gatewayName ?? record.name),
    };
  }

  return {
    kind: 'agentos-concrete',
    ...common,
    name: normalizeAgentName(record.name),
  };
}

export function shouldMergeAgents(left: AgentIdentityRecord, right: AgentIdentityRecord): boolean {
  if (left.source === 'custom' || right.source === 'custom') {
    return left.source === 'custom' && right.source === 'custom' && left.id === right.id;
  }

  if (left.source === 'runtime' || right.source === 'runtime') {
    return left.source === 'runtime' && right.source === 'runtime' && sameKey(left, right);
  }

  const leftKey = identityKeyFor(left);
  const rightKey = identityKeyFor(right);

  if (leftKey.kind === rightKey.kind) {
    return sameKey(left, right);
  }

  return isSelfRegisterScanPair(leftKey, rightKey);
}

export function mergeAgentProjection(records: AgentIdentityRecord[]): AgentProjection {
  if (records.length === 0) {
    throw new Error('mergeAgentProjection requires at least one record');
  }

  const displayRecord = [...records].sort((left, right) => {
    const rankDiff = displayRank(right) - displayRank(left);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return right.lastSeenAt - left.lastSeenAt;
  })[0];
  const statusRecord = [...records].sort((left, right) => {
    const timeDiff = right.lastSeenAt - left.lastSeenAt;
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return STATUS_RANK[right.status] - STATUS_RANK[left.status];
  })[0];

  if (!displayRecord || !statusRecord) {
    throw new Error('mergeAgentProjection could not resolve records');
  }

  return {
    ...displayRecord,
    status: statusRecord.status,
    lastSeenAt: statusRecord.lastSeenAt,
    visibleTeamIds: mergeVisibleTeamIds(records),
  };
}

export function projectPublishedAgent(
  agent: AgentIdentityRecord,
  targetTeamId: string,
): AgentProjection {
  return {
    ...agent,
    visibleTeamIds: mergeUnique([agent.primaryTeamId, ...(agent.visibleTeamIds ?? []), targetTeamId]),
  };
}

export function applyMissingScan(agent: AgentIdentityRecord, missingAt: number): AgentIdentityRecord {
  if (agent.source !== 'scanned') {
    return agent;
  }
  return {
    ...agent,
    status: 'offline',
    lastSeenAt: missingAt,
  };
}

function sameKey(left: AgentIdentityRecord, right: AgentIdentityRecord): boolean {
  return JSON.stringify(identityKeyFor(left)) === JSON.stringify(identityKeyFor(right));
}

function isSelfRegisterScanPair(left: AgentIdentityKey, right: AgentIdentityKey): boolean {
  if (left.kind === 'self-register' && right.kind === 'agentos-concrete') {
    return sameCoreIdentity(left, right);
  }
  if (left.kind === 'agentos-concrete' && right.kind === 'self-register') {
    return sameCoreIdentity(left, right);
  }
  return false;
}

function sameCoreIdentity(
  left: Extract<AgentIdentityKey, { kind: 'self-register' | 'agentos-concrete' }>,
  right: Extract<AgentIdentityKey, { kind: 'self-register' | 'agentos-concrete' }>,
): boolean {
  return (
    left.teamId === right.teamId &&
    left.deviceId === right.deviceId &&
    left.adapterKind === right.adapterKind &&
    left.name === right.name
  );
}

function displayRank(record: AgentIdentityRecord): number {
  if (record.source === 'custom') {
    return 5;
  }
  if (record.source === 'self-register') {
    return 4;
  }
  if (record.category === 'agentos-concrete') {
    return 3;
  }
  if (record.category === 'agentos-gateway') {
    return 2;
  }
  return 1;
}

function normalizeArgs(args: string[] | undefined): string {
  return (args ?? []).map((arg) => String(arg).trim()).filter(Boolean).join('\u001f');
}

function mergeVisibleTeamIds(records: AgentIdentityRecord[]): string[] {
  return mergeUnique(records.flatMap((record) => [record.primaryTeamId, ...(record.visibleTeamIds ?? [])]));
}

function mergeUnique(values: string[]): string[] {
  return Array.from(new Set(values));
}
