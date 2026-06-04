import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createInMemoryServerNext } from '../src/index';

const migrationPath = (...parts: string[]) =>
  join(fileURLToPath(new URL('../src/infra/sqlite/migrations', import.meta.url)), ...parts);

describe('server-next first-slice migrations', () => {
  test('defines global and team-scoped first-slice tables with team terminology', () => {
    const globalSql = readFileSync(migrationPath('global/0001_first_slice.sql'), 'utf8');
    const teamSql = readFileSync(migrationPath('team/0001_first_slice.sql'), 'utf8');

    for (const tableName of [
      'users',
      'teams',
      'team_members',
      'devices',
      'device_runtimes',
      'agents',
      'agent_identity_links',
      'agent_publications',
    ]) {
      expect(globalSql).toContain(`CREATE TABLE ${tableName}`);
    }

    for (const tableName of [
      'channels',
      'channel_human_members',
      'channel_agent_members',
      'messages',
      'dispatches',
    ]) {
      expect(teamSql).toContain(`CREATE TABLE ${tableName}`);
    }

    expect(`${globalSql}\n${teamSql}`).toContain('team_id');
    expect(`${globalSql}\n${teamSql}`).not.toMatch(/\bnetwork/i);
  });
});

describe('server-next first-slice use cases', () => {
  test('registers a user with a private team, owner membership, current team, and default all channel', async () => {
    const app = createInMemoryServerNext({
      now: () => 100,
      ids: createIds(['user-1', 'team-1', 'channel-1']),
    });

    const ack = await app.registerUser({
      username: 'shaw',
      password: 'secret',
      teamName: 'AgentBean',
    });

    expect(ack).toMatchObject({
      ok: true,
      user: { id: 'user-1', username: 'shaw', role: 'user', primaryTeamId: 'team-1' },
      currentTeam: {
        id: 'team-1',
        name: 'AgentBean',
        path: 'agentbean',
        visibility: 'private',
        ownerId: 'user-1',
        currentUserRole: 'owner',
      },
      defaultChannel: {
        id: 'channel-1',
        teamId: 'team-1',
        name: 'all',
        visibility: 'public',
      },
    });
    await expect(app.listTeams({ userId: 'user-1' })).resolves.toMatchObject({
      ok: true,
      teams: [{ id: 'team-1', currentUserRole: 'owner' }],
    });
  });

  test('login restores the saved current team when membership is valid', async () => {
    const app = createInMemoryServerNext({
      now: () => 200,
      ids: createIds(['user-1', 'team-1', 'channel-1']),
    });

    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const ack = await app.loginUser({ username: 'shaw', password: 'secret' });

    expect(ack).toMatchObject({
      ok: true,
      user: { id: 'user-1', username: 'shaw', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1', currentUserRole: 'owner' },
    });
  });

  test('sendMessage persists server-derived human sender and returns non-fatal no-online route result', async () => {
    const app = createInMemoryServerNext({
      now: () => 300,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
      senderId: 'client-spoof',
      senderKind: 'agent',
    });

    expect(ack).toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        senderKind: 'human',
        senderId: 'user-1',
        body: 'hello',
      },
      dispatches: [],
      route: { kind: 'no-dispatch', reason: 'no-online-agent' },
    });
  });

  test('sendMessage creates a dispatch for the first eligible online agent', async () => {
    const app = createInMemoryServerNext({
      now: () => 400,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
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
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 400,
    });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });

    expect(ack).toMatchObject({
      ok: true,
      route: { kind: 'dispatch', agentId: 'agent-1', reason: 'mention' },
      dispatches: [
        {
          id: 'dispatch-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          messageId: 'message-1',
          agentId: 'agent-1',
          status: 'queued',
        },
      ],
    });
  });
});

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
