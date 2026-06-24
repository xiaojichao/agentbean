import { describe, expect, test } from 'vitest';
import { createInMemoryServerNext } from '../src/index';

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) {
      throw new Error('Test id sequence exhausted');
    }
    return id;
  };
}

// Every team ships a default public channel `#all`. Every member of the team —
// humans and agents alike — must be enrolled in that channel automatically, no
// matter which entry point brought them into the team. These tests pin that
// invariant for the two flows that join an *existing* team (the create-team
// path already seeds the owner into #all at creation time).
describe('default #all channel membership', () => {
  test('a human who joins a team via join link is enrolled in #all', async () => {
    const app = createInMemoryServerNext({
      now: () => 100,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-link-1',
        'user-2',
        'team-2',
        'channel-2',
      ]),
      joinCodes: createIds(['code-1']),
    });

    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    // lin first provisions their own team (user-2/team-2/channel-2), then joins team-1 via the link.
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team', joinCode: 'code-1' });

    await expect(
      app.listChannelMembers({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' }),
    ).resolves.toMatchObject({
      ok: true,
      humanMemberIds: expect.arrayContaining(['user-1', 'user-2']),
    });
  });

  test('removing a human from a team also removes them from #all', async () => {
    const app = createInMemoryServerNext({
      now: () => 100,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-link-1',
        'user-2',
        'team-2',
        'channel-2',
      ]),
      joinCodes: createIds(['code-1']),
    });

    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team', joinCode: 'code-1' });

    await expect(app.removeMember({ userId: 'user-1', teamId: 'team-1', targetUserId: 'user-2' })).resolves.toMatchObject({
      ok: true,
    });
    await expect(
      app.listChannelMembers({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' }),
    ).resolves.toMatchObject({
      ok: true,
      humanMemberIds: ['user-1'],
    });
  });

  test('an agent registered into a team is enrolled in #all', async () => {
    const app = createInMemoryServerNext({
      now: () => 100,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'agent-1']),
    });

    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'scanned',
      status: 'offline',
      lastSeenAt: 100,
    });

    await expect(
      app.listChannelMembers({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' }),
    ).resolves.toMatchObject({
      ok: true,
      agentMemberIds: expect.arrayContaining(['agent-1']),
    });
  });
});
