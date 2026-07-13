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

  test('lets a channel creator add and remove human members with real visibility changes', async () => {
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
    });

    await expect(
      app.addChannelHumanMember({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        memberUserId: 'user-2',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', humanMemberIds: ['user-1', 'user-2'] },
    });
    await expect(app.listChannels({ teamId: 'team-1', userId: 'user-2' })).resolves.toMatchObject({
      ok: true,
      channels: [{ id: 'channel-all' }, { id: 'channel-ops' }],
    });

    await expect(
      app.removeChannelHumanMember({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        memberUserId: 'user-2',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', humanMemberIds: ['user-1'] },
    });
    await expect(app.listChannels({ teamId: 'team-1', userId: 'user-2' })).resolves.toMatchObject({
      ok: true,
      channels: [{ id: 'channel-all' }],
    });
  });

  test('lets a non-creator member leave a channel on their own', async () => {
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
    });
    await app.addChannelHumanMember({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-ops',
      memberUserId: 'user-2',
    });

    // user-2 是普通成员（非创建者）：removeChannelHumanMember 移除自己会被 creator 权限拒绝，
    // 但 leaveChannel 允许任何成员自行退出。
    await expect(
      app.leaveChannel({ userId: 'user-2', teamId: 'team-1', channelId: 'channel-ops' }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', humanMemberIds: ['user-1'] },
    });
    await expect(app.listChannels({ teamId: 'team-1', userId: 'user-2' })).resolves.toMatchObject({
      ok: true,
      channels: [{ id: 'channel-all' }],
    });
  });

  test('lets a channel creator manage agent members and list channel membership', async () => {
    const { app, repositories } = createApp(['user-1', 'team-1', 'channel-all', 'channel-ops']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.teams.addMember({
      teamId: 'team-1',
      userId: 'user-2',
      username: 'teammate',
      role: 'member',
      joinedAt: 100,
    });
    await repositories.agents.upsert({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'scanned',
      status: 'online',
      lastSeenAt: 100,
    });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
    });

    await expect(
      app.addChannelAgentMember({
        userId: 'user-2',
        teamId: 'team-1',
        channelId: 'channel-ops',
        agentId: 'agent-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(
      app.addChannelAgentMember({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        agentId: 'agent-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', agentMemberIds: ['agent-1'] },
    });
    await expect(
      app.listChannelMembers({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
      }),
    ).resolves.toMatchObject({
      ok: true,
      humanMemberIds: ['user-1'],
      agentMemberIds: ['agent-1'],
      humans: [
        {
          userId: 'user-1',
          username: 'shaw',
          role: 'owner',
        },
      ],
      agents: [
        {
          id: 'agent-1',
          name: 'Codex',
          status: 'online',
        },
      ],
    });

    await expect(
      app.removeChannelAgentMember({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        agentId: 'agent-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', agentMemberIds: [] },
    });
  });

  test('removes device-hosted agents from channels when their device is deleted', async () => {
    const { app, repositories } = createApp(['user-1', 'team-1', 'channel-all', 'channel-ops']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.devices.upsertHello({
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      name: 'Mac',
      status: 'online',
      lastSeenAt: 100,
      createdAt: 100,
      updatedAt: 100,
    });
    await repositories.agents.upsert({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 100,
    });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
      agentMemberIds: ['agent-1'],
    });

    await expect(
      app.deleteDevice({
        userId: 'user-1',
        deviceId: 'device-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      affectedTeamIds: ['team-1'],
      channelTeamIds: ['team-1'],
    });
    await expect(
      app.listChannelMembers({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
      }),
    ).resolves.toMatchObject({
      ok: true,
      agentMemberIds: [],
      agents: [],
    });
  });

  test('preserves non-ASCII (Chinese) channel names on create and update (#525)', async () => {
    const { app } = createApp(['user-1', 'team-1', 'channel-all', 'channel-ops']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    // Regression #525: slugify used to collapse pure-Chinese names ("一起努力" → "team"),
    // so creating or renaming a channel with a Chinese name silently failed — the socket
    // ack came back ok, but the stored name became a meaningless English slug.
    await expect(
      app.createChannel({
        userId: 'user-1',
        teamId: 'team-1',
        name: '一起努力',
        visibility: 'private',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', name: '一起努力', visibility: 'private' },
    });

    await expect(
      app.updateChannel({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        name: '闲聊小队',
      }),
    ).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-ops', name: '闲聊小队' },
    });
  });

  test('keeps a non-empty fallback name when creating a channel with a blank name', async () => {
    const { app } = createApp(['user-1', 'team-1', 'channel-all', 'channel-ops']);
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(
      app.createChannel({
        userId: 'user-1',
        teamId: 'team-1',
        name: '   ',
        visibility: 'public',
      }),
    ).resolves.toMatchObject({ ok: true, channel: { id: 'channel-ops' } });

    const listed = await app.listChannels({ teamId: 'team-1', userId: 'user-1' });
    const ops = listed.channels!.find((c) => c.id === 'channel-ops');
    expect(ops?.name).toBeTruthy();
    expect(ops?.name).not.toBe('');
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
