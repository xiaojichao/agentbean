import type { AgentSnapshot } from './schema';

export function agentVisibleInNetwork(
  agent: Pick<AgentSnapshot, 'networkId' | 'publishedNetworkIds' | 'unpublishedNetworkIds' | 'primaryTeamId' | 'visibleTeamIds' | 'visibility'>,
  networkId: string,
): boolean {
  if (agent.unpublishedNetworkIds?.includes(networkId)) return false;
  return Boolean(agent.publishedNetworkIds?.includes(networkId)) ||
    Boolean(agent.visibleTeamIds?.includes(networkId)) ||
    agent.networkId === networkId ||
    agent.primaryTeamId === networkId ||
    agent.visibility === 'public';
}
