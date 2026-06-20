export type AgentPublishState = {
  id: string;
  publishedNetworkIds?: string[];
  unpublishedNetworkIds?: string[];
};

function withoutNetwork(ids: string[] | undefined, networkId: string): string[] {
  return (ids ?? []).filter((id) => id !== networkId);
}

export function updateAgentPublishState<T extends AgentPublishState>(
  agents: T[],
  agentId: string,
  networkId: string,
  published: boolean,
): T[] {
  return agents.map((agent) => {
    if (agent.id !== agentId) return agent;
    const publishedNetworkIds = withoutNetwork(agent.publishedNetworkIds, networkId);
    const unpublishedNetworkIds = withoutNetwork(agent.unpublishedNetworkIds, networkId);
    return {
      ...agent,
      publishedNetworkIds: published ? [...publishedNetworkIds, networkId] : publishedNetworkIds,
      unpublishedNetworkIds: published ? unpublishedNetworkIds : [...unpublishedNetworkIds, networkId],
    };
  });
}
