import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('server-next second-slice channel controls', () => {
  test('creates private channels visible to the creator without explicit members', async () => {
    const { app, repositories } = createApp(['user-1', 'team-1', 'channel-all', 'channel-ops']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'user-2',
      username: 'teammate',
      role: 'member',
      joinedAt: 100,
    });

    await expect(
      app.createChannel({
        userId: 'user-1',
        teamId: 'team-1',
        name: 'ops',
        visibility: 'private',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: {
        id: 'channel-ops',
        teamId: 'team-1',
        name: 'ops',
        visibility: 'private',
        createdBy: 'user-1',
      },
    });
    await expect(app.listChannels({ teamId: 'team-1', userId: 'user-1' })).resolves.toMatchObject({
      ok: true,
      channels: [{ id: 'channel-all' }, { id: 'channel-ops' }],
    });
    await expect(app.listChannels({ teamId: 'team-1', userId: 'user-2' })).resolves.toMatchObject({
      ok: true,
      channels: [{ id: 'channel-all' }],
    });
  });

  test('lets only a channel creator change ordinary channel settings', async () => {
    const { app, repositories } = createApp(['user-1', 'team-1', 'channel-all', 'channel-ops']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'user-2',
      username: 'teammate',
      role: 'member',
      joinedAt: 100,
    });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
      humanMemberIds: ['user-2'],
    });

    await expect(
      app.updateChannel({
        userId: 'user-2',
        teamId: 'team-1',
        channelId: 'channel-ops',
        name: 'war-room',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(
      app.updateChannel({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        name: 'war-room',
        visibility: 'public',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: {
        id: 'channel-ops',
        name: 'war-room',
        visibility: 'public',
      },
    });
  });

  test('keeps all channel management limited to creator title updates', async () => {
    const { app } = createApp(['user-1', 'team-1', 'channel-all']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(
      app.updateChannel({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-all',
        name: 'announcements',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(
      app.updateChannel({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-all',
        title: 'Team-wide updates',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: {
        id: 'channel-all',
        name: 'all',
        title: 'Team-wide updates',
      },
    });
  });
});

function createApp(ids: string[]) {
  const repositories = createInMemoryRepositories();
  return {
    repositories,
    app: createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(ids) },
    }),
  };
}

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
