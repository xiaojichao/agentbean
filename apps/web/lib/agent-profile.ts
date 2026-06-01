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

function normalizeProfileName(value?: string | null): string {
  return (value ?? '').trim().toLowerCase();
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

export function resolveAgentProfileSnapshot(targetId: string, sources: AgentProfileSources): AgentSnapshot | null {
  const direct = sources.agents[targetId];
  if (direct) return direct;

  const names = profileNameHints(targetId, sources);
  const named = findAgentByName(sources.agents, names);
  if (named) return named;

  return sources.cache?.[targetId] ?? null;
}

export function resolveAgentProfileTitle(
  targetId: string,
  agent: AgentSnapshot | null | undefined,
  sources: AgentProfileTitleSources,
): string {
  if (agent?.name) return agent.name;
  return profileNameHints(targetId, sources)[0] ?? 'Agent';
}

export function agentProfileCacheKeys(targetId: string, agent: AgentSnapshot): string[] {
  return [...new Set([targetId, agent.id])];
}
