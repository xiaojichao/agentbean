import type { AgentSnapshot } from './schema';

export function agentVisibleInNetwork(agent: Pick<AgentSnapshot, 'networkId' | 'publishedNetworkIds' | 'unpublishedNetworkIds'>, networkId: string): boolean {
  if (agent.unpublishedNetworkIds?.includes(networkId)) return false;
  return Boolean(agent.publishedNetworkIds?.includes(networkId)) || agent.networkId === networkId;
}
