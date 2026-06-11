import { describe, expect, test } from 'vitest';
import {
  applyMissingScan,
  canApplyChannelUpdate,
  canViewChannel,
  channelHumanMembersForCreate,
  identityKeyFor,
  mergeAgentProjection,
  normalizeAdapterKind,
  normalizePathForComparison,
  projectPublishedAgent,
  routeMessage,
  shouldMergeAgents,
  type AgentIdentityRecord,
  type RouteAgent,
} from '../src/index';

const onlineAgent = (id: string, name: string): RouteAgent => ({
  id,
  name,
  status: 'online',
});

describe('Phase 1 message routing rules', () => {
  test('routes a leading mention to the matching online agent', () => {
    const result = routeMessage({
      body: '@Codex please inspect this',
      agents: [onlineAgent('agent-1', 'Codex')],
      humanMembers: [],
    });

    expect(result).toEqual({
      kind: 'dispatch',
      agentId: 'agent-1',
      reason: 'mention',
    });
  });

  test('routes a leading mention to a multi-word agent name', () => {
    const result = routeMessage({
      body: '@Renamed Codex please inspect this',
      agents: [onlineAgent('agent-1', 'Renamed Codex')],
      humanMembers: [],
    });

    expect(result).toEqual({
      kind: 'dispatch',
      agentId: 'agent-1',
      reason: 'mention',
    });
  });

  test('prefers the longest matching leading mention name', () => {
    const result = routeMessage({
      body: '@Codex Pro please inspect this',
      agents: [
        onlineAgent('agent-1', 'Codex'),
        onlineAgent('agent-2', 'Codex Pro'),
      ],
      humanMembers: [],
    });

    expect(result).toEqual({
      kind: 'dispatch',
      agentId: 'agent-2',
      reason: 'mention',
    });
  });

  test('does not fallback when the leading mention is unknown', () => {
    const result = routeMessage({
      body: '@Unknown please inspect this',
      agents: [onlineAgent('agent-1', 'Codex')],
      humanMembers: [],
    });

    expect(result).toEqual({
      kind: 'no-dispatch',
      reason: 'unknown-mention',
    });
  });

  test('does not dispatch agent work for a human mention', () => {
    const result = routeMessage({
      body: '@Shaw this is for you',
      agents: [onlineAgent('agent-1', 'Codex')],
      humanMembers: [{ id: 'user-1', username: 'shaw', displayName: 'Shaw' }],
    });

    expect(result).toEqual({
      kind: 'no-dispatch',
      reason: 'human-mention',
    });
  });

  test('falls back to the first eligible online agent without a mention', () => {
    const result = routeMessage({
      body: 'please inspect this',
      agents: [
        { id: 'agent-offline', name: 'Claude', status: 'offline' },
        onlineAgent('agent-1', 'Codex'),
        onlineAgent('agent-2', 'Gemini'),
      ],
      humanMembers: [],
    });

    expect(result).toEqual({
      kind: 'dispatch',
      agentId: 'agent-1',
      reason: 'fallback',
    });
  });

  test('returns a non-fatal no-online result when no agent is online', () => {
    const result = routeMessage({
      body: 'please inspect this',
      agents: [{ id: 'agent-1', name: 'Codex', status: 'offline' }],
      humanMembers: [],
    });

    expect(result).toEqual({
      kind: 'no-dispatch',
      reason: 'no-online-agent',
    });
  });
});

describe('Phase 1 agent identity and visibility rules', () => {
  const baseRecord: AgentIdentityRecord = {
    id: 'agent-1',
    primaryTeamId: 'team-1',
    deviceId: 'device-1',
    adapterKind: 'codex',
    name: 'Codex',
    source: 'self-register',
    category: 'executor-hosted',
    status: 'online',
    lastSeenAt: 10,
  };

  test('normalizes adapter aliases', () => {
    expect(normalizeAdapterKind('codex_cli')).toBe('codex');
    expect(normalizeAdapterKind('Claude')).toBe('claude-code');
  });

  test('normalizes paths according to platform comparison safety', () => {
    expect(normalizePathForComparison('/Work/AgentBean/', { platform: 'linux' })).toBe(
      '/Work/AgentBean',
    );
    expect(normalizePathForComparison('C:\\Work\\AgentBean\\', { platform: 'windows' })).toBe(
      'c:/work/agentbean',
    );
    expect(normalizePathForComparison('/Work/AgentBean', { platform: 'unknown' })).toBe(
      '/Work/AgentBean',
    );
  });

  test('lets self-register win over same team/device/name scan duplicates', () => {
    const scanned: AgentIdentityRecord = {
      ...baseRecord,
      id: 'scan-device-1-codex',
      source: 'scanned',
      category: 'agentos-concrete',
      status: 'offline',
      lastSeenAt: 8,
    };

    expect(shouldMergeAgents(baseRecord, scanned)).toBe(true);
    expect(mergeAgentProjection([scanned, baseRecord])).toMatchObject({
      id: 'agent-1',
      name: 'Codex',
      status: 'online',
    });
  });

  test('does not merge custom agents with scanned runtime availability', () => {
    const custom: AgentIdentityRecord = {
      ...baseRecord,
      id: 'custom-1',
      source: 'custom',
      command: 'codex',
    };
    const runtime: AgentIdentityRecord = {
      ...baseRecord,
      id: 'runtime-1',
      source: 'runtime',
      command: 'codex',
    };

    expect(shouldMergeAgents(custom, runtime)).toBe(false);
  });

  test('keeps concrete AgentOS display ahead of generic gateway display', () => {
    const generic: AgentIdentityRecord = {
      ...baseRecord,
      id: 'gateway-1',
      name: 'hermes-agent',
      source: 'scanned',
      category: 'agentos-gateway',
      gatewayInstanceKey: 'gateway-a',
      status: 'online',
      lastSeenAt: 12,
    };
    const concrete: AgentIdentityRecord = {
      ...baseRecord,
      id: 'reviewer-1',
      name: 'Reviewer',
      source: 'scanned',
      category: 'agentos-concrete',
      status: 'offline',
      lastSeenAt: 9,
    };

    expect(mergeAgentProjection([generic, concrete])).toMatchObject({
      id: 'reviewer-1',
      name: 'Reviewer',
      status: 'online',
    });
  });

  test('does not merge same-adapter gateway instances unless gatewayInstanceKey matches', () => {
    const gatewayA: AgentIdentityRecord = {
      ...baseRecord,
      id: 'gateway-a',
      source: 'scanned',
      category: 'agentos-gateway',
      gatewayInstanceKey: 'a',
    };
    const gatewayB: AgentIdentityRecord = {
      ...gatewayA,
      id: 'gateway-b',
      gatewayInstanceKey: 'b',
    };
    const gatewayAAgain: AgentIdentityRecord = {
      ...gatewayA,
      id: 'gateway-a-again',
    };

    expect(shouldMergeAgents(gatewayA, gatewayB)).toBe(false);
    expect(shouldMergeAgents(gatewayA, gatewayAAgain)).toBe(true);
    expect(identityKeyFor(gatewayA)).toEqual({
      kind: 'agentos-gateway',
      teamId: 'team-1',
      deviceId: 'device-1',
      adapterKind: 'codex',
      gatewayInstanceKey: 'a',
    });
  });

  test('uses newer status events before status rank, and rank only for same batch conflicts', () => {
    expect(
      mergeAgentProjection([
        { ...baseRecord, status: 'busy', lastSeenAt: 10 },
        { ...baseRecord, status: 'offline', lastSeenAt: 12 },
      ]),
    ).toMatchObject({ status: 'offline', lastSeenAt: 12 });

    expect(
      mergeAgentProjection([
        { ...baseRecord, status: 'online', lastSeenAt: 12 },
        { ...baseRecord, status: 'busy', lastSeenAt: 12 },
      ]),
    ).toMatchObject({ status: 'busy', lastSeenAt: 12 });
  });

  test('keeps a published agent identity while projecting visible teams', () => {
    expect(projectPublishedAgent(baseRecord, 'team-2')).toMatchObject({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1', 'team-2'],
    });
  });

  test('marks missing scanned agents offline without deleting relationships', () => {
    expect(
      applyMissingScan(
        {
          ...baseRecord,
          source: 'scanned',
          channelMemberIds: ['channel-1'],
          historyMessageIds: ['message-1'],
        },
        20,
      ),
    ).toMatchObject({
      status: 'offline',
      lastSeenAt: 20,
      channelMemberIds: ['channel-1'],
      historyMessageIds: ['message-1'],
    });
  });

  test('allows private channel members and rejects non-members', () => {
    const privateChannel = {
      id: 'channel-1',
      teamId: 'team-1',
      kind: 'channel' as const,
      name: 'ops',
      visibility: 'private' as const,
      humanMemberIds: ['user-1'],
      agentMemberIds: ['agent-1'],
      createdAt: 1,
    };

    expect(canViewChannel(privateChannel, { memberId: 'user-1', kind: 'human' })).toBe(true);
    expect(canViewChannel(privateChannel, { memberId: 'user-2', kind: 'human' })).toBe(false);
    expect(canViewChannel({ ...privateChannel, visibility: 'public' }, { memberId: 'user-2', kind: 'human' })).toBe(true);
  });

  test('keeps a private channel visible to its creator even when no members are supplied', () => {
    expect(
      channelHumanMembersForCreate({
        visibility: 'private',
        createdBy: 'user-1',
        humanMemberIds: [],
      }),
    ).toEqual(['user-1']);
  });

  test('allows only the channel creator to manage ordinary channel settings', () => {
    const channel = {
      name: 'ops',
      visibility: 'private' as const,
      createdBy: 'user-1',
    };

    expect(canApplyChannelUpdate(channel, 'user-1', { name: 'war-room' })).toBe(true);
    expect(canApplyChannelUpdate(channel, 'user-2', { name: 'war-room' })).toBe(false);
  });

  test('limits the default all channel to creator description updates', () => {
    const allChannel = {
      name: 'all',
      visibility: 'public' as const,
      createdBy: 'user-1',
    };

    expect(canApplyChannelUpdate(allChannel, 'user-1', { title: 'Team-wide updates' })).toBe(true);
    expect(canApplyChannelUpdate(allChannel, 'user-1', { name: 'announcements' })).toBe(false);
    expect(canApplyChannelUpdate(allChannel, 'user-2', { title: 'Team-wide updates' })).toBe(false);
  });
});
