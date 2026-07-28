/**
 * ADR 0061 + #885:
 * - Unmentioned channel messages must not implicitly dispatch (no first-online fallback).
 * - Channel membership still bounds any dispatch that does occur (@ or thread owner).
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

describe('channel message dispatch under membership + unmentioned intake rules', () => {
  test('does not implicitly dispatch an unmentioned root message even to a channel member', async () => {
    const now = 1_000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'channel-drama',
        'agent-bettafish',
        'agent-pi',
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
    await app.registerAgent({
      id: 'agent-pi',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Writer',
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

    expect(ack).toMatchObject({
      ok: true,
      route: { kind: 'no-dispatch', reason: 'no-online-agent' },
      dispatches: [],
    });
  });

  test('does not dispatch to a non-member when the message explicitly @-mentions a channel member', async () => {
    const now = 2_000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-all',
        'channel-drama',
        'agent-bettafish',
        'agent-writer',
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
      id: 'agent-writer',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Writer',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-writer',
      lastSeenAt: now,
    });
    await app.addChannelAgentMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-drama',
      agentId: 'agent-writer',
    });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-drama',
      body: '@Writer 帮我写一个剧本，主题是AI陪伴机器人',
    });

    expect(ack).toMatchObject({
      ok: true,
      route: { kind: 'dispatch', agentId: 'agent-writer', reason: 'mention' },
      dispatches: [{ agentId: 'agent-writer' }],
    });
    if (ack.ok) {
      for (const dispatch of ack.dispatches ?? []) {
        expect(dispatch.agentId).not.toBe('agent-bettafish');
      }
    }
  });

  test('does not fallback-dispatch when the only online agents are outside the channel', async () => {
    const now = 3_000;
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
