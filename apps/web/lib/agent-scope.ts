import type { AgentSnapshot } from './schema';

export function agentVisibleInNetwork(agent: Pick<AgentSnapshot, 'networkId' | 'publishedNetworkIds'>, networkId: string): boolean {
  return agent.networkId === networkId || Boolean(agent.publishedNetworkIds?.includes(networkId));
}
