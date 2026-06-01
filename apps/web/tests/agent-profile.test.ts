import { describe, expect, it } from 'vitest';
import { agentProfileCacheKeys, resolveAgentProfileSnapshot, resolveAgentProfileTitle } from '../lib/agent-profile';
import type { AgentSnapshot } from '../lib/schema';

function agent(overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    id: 'agent-current',
    name: 'OpenClaw-Agent-xiao-mini',
    role: 'gateway-agent',
    adapterKind: 'openclaw',
    status: 'online',
    lastSeenAt: 42,
    connectCommand: 'npx @agentbean/daemon',
    category: 'agentos-hosted',
    ...overrides,
  };
}

describe('agent profile resolution', () => {
  it('resolves a stale profile id through the member name to the current full agent snapshot', () => {
    const current = agent({ id: 'agent-current' });
    const resolved = resolveAgentProfileSnapshot('agent-stale', {
      agents: { [current.id]: current },
      channelMembers: [{ id: 'agent-stale', name: 'OpenClaw-Agent-xiao-mini', kind: 'agent' }],
      mentionMembers: [],
      dms: [],
    });

    expect(resolved).toBe(current);
  });

  it('uses stable display hints instead of falling back to generic Agent', () => {
    expect(resolveAgentProfileTitle('agent-stale', null, {
      channelMembers: [],
      mentionMembers: [{ id: 'agent-stale', name: 'OpenClaw-Agent-xiao-mini', kind: 'agent' }],
      dms: [],
    })).toBe('OpenClaw-Agent-xiao-mini');
  });

  it('caches both the stale URL id and the canonical snapshot id', () => {
    expect(agentProfileCacheKeys('agent-stale', agent({ id: 'agent-current' }))).toEqual([
      'agent-stale',
      'agent-current',
    ]);
  });
});
