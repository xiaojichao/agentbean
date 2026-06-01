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

  it('resolves a stale gateway profile id after member hints disappear', () => {
    const current = agent({
      id: 'scan-network-3c00f768-8423-2933-879c-2a7000f9031b-openclaw-agent-xiao-mini',
      deviceId: '3c00f768-8423-2933-879c-2a7000f9031b',
    });
    const resolved = resolveAgentProfileSnapshot('scan-network-3c00f768-8423-2933-879c-2a7000f9031b-openclaw-agent', {
      agents: { [current.id]: current },
      channelMembers: [],
      mentionMembers: [],
      dms: [],
    });

    expect(resolved).toBe(current);
  });

  it('derives a gateway title from a stale profile id when no snapshot is available yet', () => {
    expect(resolveAgentProfileTitle('scan-network-3c00f768-8423-2933-879c-2a7000f9031b-hermes-agent', null, {
      channelMembers: [],
      mentionMembers: [],
      dms: [],
    })).toBe('Hermes-Agent');
  });

  it('caches both the stale URL id and the canonical snapshot id', () => {
    expect(agentProfileCacheKeys('agent-stale', agent({ id: 'agent-current' }))).toEqual([
      'agent-stale',
      'agent-current',
    ]);
  });
});
