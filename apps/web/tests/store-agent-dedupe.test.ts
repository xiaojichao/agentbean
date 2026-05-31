import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentSnapshot } from '../lib/schema';
import { useAgentBeanStore } from '../lib/store';

function agent(overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    id: 'agent-1',
    name: 'Hermes-Agent',
    role: 'gateway-agent',
    adapterKind: 'hermes',
    category: 'agentos-hosted',
    source: 'self-register',
    status: 'online',
    lastSeenAt: 1,
    connectCommand: 'npx @agentbean/daemon',
    networkId: 'default',
    visibility: 'public',
    deviceId: 'device-1',
    publishedNetworkIds: ['default'],
    unpublishedNetworkIds: [],
    ...overrides,
  };
}

describe('agent store dedupe', () => {
  beforeEach(() => {
    useAgentBeanStore.setState({
      agents: {},
      currentNetworkId: 'default',
    });
  });

  it('does not let status updates reintroduce duplicate AgentOS gateway members', () => {
    useAgentBeanStore.getState().applyAgentsSnapshot([
      agent({
        id: 'hermes-current',
        name: 'Hermes-Agent-xiao-mbp',
        source: 'self-register',
        lastSeenAt: 20,
        command: '/Users/shaw/.local/bin/hermes',
        cwd: '/Users/shaw/.local/bin',
      }),
    ]);

    useAgentBeanStore.getState().applyAgentStatus(agent({
      id: 'hermes-old',
      name: 'Hermes-Agent',
      source: 'scanned',
      lastSeenAt: 30,
    }));

    const hermesRows = Object.values(useAgentBeanStore.getState().agents)
      .filter((item) => item.deviceId === 'device-1' && item.adapterKind === 'hermes');
    expect(hermesRows).toHaveLength(1);
    expect(hermesRows[0]).toMatchObject({
      id: 'hermes-current',
      name: 'Hermes-Agent-xiao-mbp',
    });
  });

  it('merges online status into the renamed AgentOS gateway row', () => {
    useAgentBeanStore.getState().applyAgentsSnapshot([
      agent({
        id: 'hermes-renamed',
        name: 'Hermes-Agent-xiao-mbp',
        source: 'scanned',
        status: 'offline',
        lastSeenAt: 20,
        command: '/Users/shaw/.local/bin/hermes',
        cwd: '/Users/shaw/.local/bin',
      }),
    ]);

    useAgentBeanStore.getState().applyAgentStatus(agent({
      id: 'hermes-generic',
      name: 'Hermes-Agent',
      source: 'scanned',
      status: 'online',
      lastSeenAt: 30,
      command: '/Users/shaw/.local/bin/hermes',
      cwd: '/Users/shaw/.local/bin',
    }));

    const hermesRows = Object.values(useAgentBeanStore.getState().agents)
      .filter((item) => item.deviceId === 'device-1' && item.adapterKind === 'hermes');
    expect(hermesRows).toHaveLength(1);
    expect(hermesRows[0]).toMatchObject({
      id: 'hermes-renamed',
      name: 'Hermes-Agent-xiao-mbp',
      status: 'online',
    });
  });

  it('still applies status changes for the same agent id', () => {
    useAgentBeanStore.getState().applyAgentsSnapshot([
      agent({
        id: 'hermes-current',
        name: 'Hermes-Agent-xiao-mbp',
        status: 'online',
        lastSeenAt: 20,
      }),
    ]);

    useAgentBeanStore.getState().applyAgentStatus(agent({
      id: 'hermes-current',
      name: 'Hermes-Agent-xiao-mbp',
      status: 'offline',
      lastSeenAt: 30,
    }));

    expect(useAgentBeanStore.getState().agents['hermes-current']).toMatchObject({
      status: 'offline',
      lastSeenAt: 30,
    });
  });
});
