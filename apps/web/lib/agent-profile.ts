import type { AgentSnapshot } from './schema';

export interface AgentProfileMemberHint {
  id: string;
  name: string;
  kind: 'human' | 'agent';
}

export interface AgentProfileDmHint {
  dmTargetId: string;
  name: string;
}

interface AgentProfileSources {
  agents: Record<string, AgentSnapshot>;
  channelMembers: AgentProfileMemberHint[];
  mentionMembers: AgentProfileMemberHint[];
  dms: AgentProfileDmHint[];
  cache?: Record<string, AgentSnapshot>;
}

interface AgentProfileTitleSources {
  channelMembers: AgentProfileMemberHint[];
  mentionMembers: AgentProfileMemberHint[];
  dms: AgentProfileDmHint[];
}

interface GatewayProfileHint {
  adapterKind: 'hermes' | 'openclaw';
  name: string;
  deviceId: string | null;
}

function normalizeProfileName(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
}

function gatewayProfileHintFromId(targetId: string): GatewayProfileHint | null {
  const match = targetId.match(/(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-(hermes-agent|openclaw-agent)$/i);
  if (!match) return null;
  const adapterKind = match[2] === 'hermes-agent' ? 'hermes' : 'openclaw';
  return {
    adapterKind,
    name: adapterKind === 'hermes' ? 'Hermes-Agent' : 'OpenClaw-Agent',
    deviceId: match[1] ?? null,
  };
}

function profileNameHints(targetId: string, sources: AgentProfileTitleSources): string[] {
  const names = [
    ...sources.channelMembers
      .filter((item) => item.kind === 'agent' && item.id === targetId)
      .map((item) => item.name),
    ...sources.mentionMembers
      .filter((item) => item.kind === 'agent' && item.id === targetId)
      .map((item) => item.name),
    ...sources.dms
      .filter((item) => item.dmTargetId === targetId)
      .map((item) => item.name),
  ];
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

function findAgentByName(agents: Record<string, AgentSnapshot>, names: string[]): AgentSnapshot | null {
  const currentAgents = Object.values(agents);
  for (const name of names) {
    const exact = currentAgents.find((agent) => agent.name === name);
    if (exact) return exact;
  }
  const normalizedNames = new Set(names.map(normalizeProfileName).filter(Boolean));
  return currentAgents.find((agent) => normalizedNames.has(normalizeProfileName(agent.name))) ?? null;
}

function findAgentByGatewayHint(agents: Record<string, AgentSnapshot>, hint: GatewayProfileHint | null): AgentSnapshot | null {
  if (!hint) return null;
  const candidates = Object.values(agents).filter((agent) => agent.adapterKind === hint.adapterKind);
  if (candidates.length === 0) return null;

  const sameDevice = hint.deviceId
    ? candidates.filter((agent) => agent.deviceId === hint.deviceId || agent.id.includes(hint.deviceId!))
    : [];
  const pool = sameDevice.length > 0 ? sameDevice : candidates;
  const exact = pool.find((agent) => normalizeProfileName(agent.name) === normalizeProfileName(hint.name));
  if (exact) return exact;
  const named = pool.find((agent) => normalizeProfileName(agent.name).startsWith(`${normalizeProfileName(hint.name)}-`));
  return named ?? (pool.length === 1 ? pool[0]! : null);
}

export function resolveAgentProfileSnapshot(targetId: string, sources: AgentProfileSources): AgentSnapshot | null {
  const direct = sources.agents[targetId];
  if (direct) return direct;

  const names = profileNameHints(targetId, sources);
  const named = findAgentByName(sources.agents, names);
  if (named) return named;

  const gateway = findAgentByGatewayHint(sources.agents, gatewayProfileHintFromId(targetId));
  if (gateway) return gateway;

  return sources.cache?.[targetId] ?? null;
}

export function resolveAgentProfileTitle(
  targetId: string,
  agent: AgentSnapshot | null | undefined,
  sources: AgentProfileTitleSources,
): string {
  if (agent?.name) return agent.name;
  return profileNameHints(targetId, sources)[0] ?? gatewayProfileHintFromId(targetId)?.name ?? 'Agent';
}

export function agentProfileCacheKeys(targetId: string, agent: AgentSnapshot): string[] {
  return [...new Set([targetId, agent.id])];
}
