import { describe, expect, it } from 'vitest';
import { ownedAgentsForMember } from '../lib/agent-list';
import type { AgentSnapshot } from '../lib/schema';

function agent(overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    id: 'agent-1',
    name: 'Hermes-Agent',
    role: 'gateway-agent',
    adapterKind: 'hermes',
    status: 'online',
    lastSeenAt: 1,
    connectCommand: 'npx @agentbean/daemon',
    ownerId: 'owner-1',
    ...overrides,
  };
}

describe('agent list helpers', () => {
  it('keeps member-owned agents stable across map insertion order changes', () => {
    const mindmap = agent({ id: 'mindmap-ppt', name: 'mindmap-ppt', adapterKind: 'codex' });
    const hermesMini = agent({ id: 'hermes-mini', name: 'Hermes-Agent-xiao-mini', adapterKind: 'hermes' });
    const openclawMini = agent({ id: 'openclaw-mini', name: 'OpenClaw-Agent-xiao-mini', adapterKind: 'openclaw' });
    const hermesMb1 = agent({ id: 'hermes-mb1', name: 'Hermes-Agent-xiao-mb1', adapterKind: 'hermes' });
    const otherOwner = agent({ id: 'other-owner-agent', name: 'aaa-other', ownerId: 'owner-2' });

    const firstSnapshot = {
      [mindmap.id]: mindmap,
      [hermesMini.id]: hermesMini,
      [openclawMini.id]: openclawMini,
      [hermesMb1.id]: hermesMb1,
      [otherOwner.id]: otherOwner,
    };
    const refreshedSnapshot = {
      [mindmap.id]: mindmap,
      [hermesMb1.id]: hermesMb1,
      [hermesMini.id]: hermesMini,
      [openclawMini.id]: openclawMini,
      [otherOwner.id]: otherOwner,
    };

    const firstOrder = ownedAgentsForMember(firstSnapshot, 'owner-1').map((item) => item.id);
    const refreshedOrder = ownedAgentsForMember(refreshedSnapshot, 'owner-1').map((item) => item.id);

    expect(firstOrder).toEqual(['hermes-mb1', 'hermes-mini', 'mindmap-ppt', 'openclaw-mini']);
    expect(refreshedOrder).toEqual(firstOrder);
  });
});
