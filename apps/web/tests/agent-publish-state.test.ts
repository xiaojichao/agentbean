import { describe, expect, it } from 'vitest';
import { updateAgentPublishState } from '../lib/agent-publish-state';

describe('updateAgentPublishState', () => {
  it('updates the matching agent publish count immediately', () => {
    const agents = [
      { id: 'a1', name: 'Agent 1', publishedNetworkIds: ['team-a'], unpublishedNetworkIds: [] },
      { id: 'a2', name: 'Agent 2', publishedNetworkIds: [] },
    ];

    const unpublished = updateAgentPublishState(agents, 'a1', 'team-a', false);
    expect(unpublished.find((agent) => agent.id === 'a1')?.publishedNetworkIds).toEqual([]);
    expect(unpublished.find((agent) => agent.id === 'a1')?.unpublishedNetworkIds).toEqual(['team-a']);

    const published = updateAgentPublishState(unpublished, 'a1', 'team-b', true);
    expect(published.find((agent) => agent.id === 'a1')?.publishedNetworkIds).toEqual(['team-b']);
    expect(published.find((agent) => agent.id === 'a1')?.unpublishedNetworkIds).toEqual(['team-a']);
    expect(published.find((agent) => agent.id === 'a2')).toBe(agents[1]);
  });
});
