import type { AgentSnapshot } from './schema';

// 按 id 去重：agents 是别名 map（输家 id → 赢家），Object.values 可能含重复赢家对象
// （多个 id 指向同一赢家）。遍历/列表显示前需去重，避免成员重复。
export function uniqueAgents(list: AgentSnapshot[]): AgentSnapshot[] {
  const seen = new Set<string>();
  const out: AgentSnapshot[] = [];
  for (const agent of list) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    out.push(agent);
  }
  return out;
}

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
  return uniqueAgents(Object.values(agents))
    .filter((agent) => agent.ownerId === ownerId)
    .sort(compareAgentListItems);
}
