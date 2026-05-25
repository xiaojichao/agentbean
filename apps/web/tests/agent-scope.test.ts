import { describe, expect, it } from 'vitest';
import { agentVisibleInNetwork } from '../lib/agent-scope';

describe('agentVisibleInNetwork', () => {
  it('keeps agents scoped to their own team unless explicitly published', () => {
    expect(agentVisibleInNetwork({ networkId: 'team-a', publishedNetworkIds: [] }, 'team-a')).toBe(true);
    expect(agentVisibleInNetwork({ networkId: 'team-a', publishedNetworkIds: [] }, 'team-b')).toBe(false);
    expect(agentVisibleInNetwork({ networkId: 'team-a', publishedNetworkIds: ['team-b'] }, 'team-b')).toBe(true);
  });
});
