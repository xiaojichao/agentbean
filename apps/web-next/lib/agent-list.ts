import type { AgentSnapshot } from './schema';

function compareText(a?: string | null, b?: string | null): number {
  return (a ?? '').localeCompare(b ?? '', 'zh-CN', { sensitivity: 'base', numeric: true });
}

export function compareAgentListItems(a: AgentSnapshot, b: AgentSnapshot): number {
  return compareText(a.name, b.name)
    || compareText(a.adapterKind, b.adapterKind)
    || compareText(a.deviceName ?? a.deviceId, b.deviceName ?? b.deviceId)
    || a.id.localeCompare(b.id);
}

export function ownedAgentsForMember(agents: Record<string, AgentSnapshot>, ownerId: string): AgentSnapshot[] {
  return Object.values(agents)
    .filter((agent) => agent.ownerId === ownerId)
    .sort(compareAgentListItems);
}
