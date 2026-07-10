import type { AgentSnapshot, DiscoveredAgent } from './schema';

export function findRegisteredExecutor(
  discoveredAgent: DiscoveredAgent,
  agents: AgentSnapshot[],
  scanDeviceId: string,
): AgentSnapshot | null {
  if (discoveredAgent.category !== 'executor-hosted') return null;

  return agents.find((agent) =>
    agent.deviceId === scanDeviceId
    && agent.adapterKind === discoveredAgent.adapterKind
    && agent.name === discoveredAgent.name
    && agent.category === 'executor-hosted'
    && agent.source === 'custom'
  ) ?? null;
}
