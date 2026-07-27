/**
 * Regression: unmentioned channel messages must not fall back to a team-visible
 * agent that is not a member of that channel.
 *
 * Symptom (production): in channel "AI短剧", message
 * "帮我写一个剧本，主题是AI陪伴机器人" was claimed by BettaFish, who was not a
 * channel member, instead of a channel agent / PI coordination.
 */
import { describe, expect, test } from 'vitest';
import { createInMemoryServerNext } from '../src/index';

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

describe('channel membership constrains legacy dispatch fallback', () => {
  test('does not dispatch an unmentioned message to a non-member online agent (BettaFish-style)', async () => {
    const now = 1_000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'channel-drama',
        // BettaFish is team-visible and online, but never added to channel-drama
        'agent-bettafish',
        // Channel member that should receive work if any agent does
        'agent-pi',
        'message-1',
        'task-1',
        'dispatch-1',
        'request-1',
        'ack-1',
      ]),
    });

    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'AI短剧',
      visibility: 'public',
    });

    // Register outsider first so listVisibleInTeam order would pick it as legacy fallback[0]
    await app.registerAgent({
      id: 'agent-bettafish',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'BettaFish',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-betta',
      lastSeenAt: now,
    });
    await app.registerAgent({
      id: 'agent-pi',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'PI',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-pi',
      lastSeenAt: now,
    });
    await app.addChannelAgentMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-drama',
      agentId: 'agent-pi',
    });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-drama',
      body: '帮我写一个剧本，主题是AI陪伴机器人',
    });

    expect(ack.ok).toBe(true);
    if (!ack.ok) return;

    // Must never route to the non-member BettaFish
    expect(ack.route).not.toMatchObject({ kind: 'dispatch', agentId: 'agent-bettafish' });
    for (const dispatch of ack.dispatches ?? []) {
      expect(dispatch.agentId).not.toBe('agent-bettafish');
    }
    if (ack.acknowledgementMessage) {
      expect(ack.acknowledgementMessage.senderId).not.toBe('agent-bettafish');
    }

    // Channel member is the only valid fallback target
    expect(ack).toMatchObject({
      route: { kind: 'dispatch', agentId: 'agent-pi', reason: 'fallback' },
      dispatches: [{ agentId: 'agent-pi' }],
    });
  });

  test('does not fallback-dispatch when the channel has no online agent members', async () => {
    const now = 2_000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'channel-drama',
        'agent-bettafish',
        'message-1',
      ]),
    });

    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'AI短剧',
      visibility: 'public',
    });
    await app.registerAgent({
      id: 'agent-bettafish',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'BettaFish',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-betta',
      lastSeenAt: now,
    });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-drama',
      body: '帮我写一个剧本，主题是AI陪伴机器人',
    });

    expect(ack).toMatchObject({
      ok: true,
      route: { kind: 'no-dispatch', reason: 'no-online-agent' },
      dispatches: [],
    });
  });
});
