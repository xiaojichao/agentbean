import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createInMemoryServerNext } from '../src/index';

const migrationPath = (...parts: string[]) =>
  join(fileURLToPath(new URL('../src/infra/sqlite/migrations', import.meta.url)), ...parts);

describe('server-next first-slice migrations', () => {
  test('defines global and team-scoped first-slice tables with team terminology', () => {
    const globalSql = [
      readFileSync(migrationPath('global/0001_first_slice.sql'), 'utf8'),
      readFileSync(migrationPath('global/0002_device_invites.sql'), 'utf8'),
      readFileSync(migrationPath('global/0003_agent_deleted_at.sql'), 'utf8'),
    ].join('\n');
    const teamSql = [
      readFileSync(migrationPath('team/0001_first_slice.sql'), 'utf8'),
      readFileSync(migrationPath('team/0002_artifacts_workspace_runs.sql'), 'utf8'),
      readFileSync(migrationPath('team/0003_tasks.sql'), 'utf8'),
      readFileSync(migrationPath('team/0004_reactions_saved.sql'), 'utf8'),
      readFileSync(migrationPath('team/0005_workspace_run_command.sql'), 'utf8'),
      readFileSync(migrationPath('team/0006_workspace_run_log_excerpt.sql'), 'utf8'),
    ].join('\n');

    for (const tableName of [
      'users',
      'teams',
      'team_members',
      'devices',
      'device_runtimes',
      'device_invites',
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
      'tasks',
      'message_reactions',
      'saved_messages',
    ]) {
      expect(teamSql).toContain(`CREATE TABLE ${tableName}`);
    }

    expect(`${globalSql}\n${teamSql}`).toContain('team_id');
    expect(teamSql).toContain('ADD COLUMN command TEXT');
    expect(teamSql).toContain('ADD COLUMN log_excerpt TEXT');
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
      token: expect.stringMatching(/^abn\./),
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
      token: expect.stringMatching(/^abn\./),
      user: { id: 'user-1', username: 'shaw', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1', currentUserRole: 'owner' },
    });
  });

  test('listTeams returns the current team id', async () => {
    const app = createInMemoryServerNext({
      now: () => 210,
      ids: createIds(['user-1', 'team-1', 'channel-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(app.listTeams({ userId: 'user-1' })).resolves.toMatchObject({
      ok: true,
      currentTeamId: 'team-1',
      teams: [{ id: 'team-1', currentUserRole: 'owner' }],
    });
  });

  test('createTeam creates an owned private team, default all channel, and switches current team', async () => {
    const app = createInMemoryServerNext({
      now: () => 230,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'team-2', 'channel-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(app.createTeam({ userId: 'user-1', name: 'Ops Team' })).resolves.toMatchObject({
      ok: true,
      team: {
        id: 'team-2',
        name: 'Ops Team',
        path: 'ops-team',
        visibility: 'private',
        ownerId: 'user-1',
        currentUserRole: 'owner',
      },
      defaultChannel: {
        id: 'channel-2',
        teamId: 'team-2',
        name: 'all',
        visibility: 'public',
      },
    });
    await expect(app.listTeams({ userId: 'user-1' })).resolves.toMatchObject({
      ok: true,
      currentTeamId: 'team-2',
      teams: [
        { id: 'team-1', currentUserRole: 'owner' },
        { id: 'team-2', currentUserRole: 'owner' },
      ],
    });
    await expect(app.loginUser({ username: 'shaw', password: 'secret' })).resolves.toMatchObject({
      ok: true,
      currentTeam: { id: 'team-2' },
    });
  });

  test('switchTeam updates current team only for existing team members', async () => {
    const app = createInMemoryServerNext({
      now: () => 240,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'team-2',
        'channel-2',
        'user-2',
        'team-3',
        'channel-3',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createTeam({ userId: 'user-1', name: 'Ops Team' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team' });

    await expect(app.switchTeam({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      currentTeam: { id: 'team-1', currentUserRole: 'owner' },
    });
    await expect(app.listTeams({ userId: 'user-1' })).resolves.toMatchObject({
      ok: true,
      currentTeamId: 'team-1',
    });
    await expect(app.switchTeam({ userId: 'user-2', teamId: 'team-2' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('searchMessages returns only messages from channels visible to the user', async () => {
    const app = createInMemoryServerNext({
      now: () => 245,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-1',
        'user-2',
        'team-2',
        'channel-2',
        'channel-private',
        'message-public',
        'message-private',
      ]),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team', joinCode: 'code-1' });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'private-search',
      visibility: 'private',
    });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'public roadmap search' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-private', body: 'secret roadmap search' });

    await expect(app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-private', body: 'secret roadmap search' },
        { id: 'message-public', body: 'public roadmap search' },
      ],
    });
    await expect(app.searchMessages({ userId: 'user-2', teamId: 'team-1', query: 'roadmap' })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-public', body: 'public roadmap search' },
      ],
    });
    await expect(app.searchMessages({ userId: 'user-2', teamId: 'team-1', query: 'secret' })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });
    await expect(app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'r' })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });
  });

  test('searchMessages includes direct messages visible to the user without leaking to non-participants', async () => {
    const app = createInMemoryServerNext({
      now: () => 260,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-1',
        'user-2',
        'team-2',
        'channel-2',
        'dm-1',
        'dm-human-member-1',
        'dm-agent-member-1',
        'message-public',
        'message-dm',
      ]),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team', joinCode: 'code-1' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'scanned',
      status: 'offline',
      deviceId: 'device-1',
      lastSeenAt: 260,
    });
    await app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'public roadmap note' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1', body: 'private dm roadmap note' });

    const ownResult = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' });
    expect(ownResult).toMatchObject({ ok: true });
    expect(ownResult.messages.map((message) => message.body)).toEqual(
      expect.arrayContaining(['public roadmap note', 'private dm roadmap note']),
    );

    // user-2 is a team member but NOT a participant of dm-1, so the DM message must not leak into their search.
    const otherResult = await app.searchMessages({ userId: 'user-2', teamId: 'team-1', query: 'roadmap' });
    expect(otherResult).toMatchObject({ ok: true });
    expect(otherResult.messages.map((message) => message.body)).toEqual(['public roadmap note']);
  });

  test('tasks can be created, listed, and updated without leaking private channels', async () => {
    const app = createInMemoryServerNext({
      now: () => 300,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-1',
        'user-2',
        'team-2',
        'channel-2',
        'channel-private',
        'task-public',
        'task-private',
        'task-global',
      ]),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team', joinCode: 'code-1' });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'private-tasks',
      visibility: 'private',
    });

    await expect(app.createTask({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      assigneeId: 'user-2',
      title: '  public task  ',
      tags: ['ops', 'ops', ' ship '],
    })).resolves.toMatchObject({
      ok: true,
      task: {
        id: 'task-public',
        title: 'public task',
        status: 'todo',
        creatorId: 'user-1',
        assigneeId: 'user-2',
        channelId: 'channel-1',
        tags: ['ops', 'ship'],
      },
    });
    await app.createTask({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-private',
      title: 'private task',
    });

    await expect(app.listTasks({ userId: 'user-2', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      tasks: [{ id: 'task-public' }],
    });
    await expect(app.listTasks({ userId: 'user-2', teamId: 'team-1', channelId: 'channel-private' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.updateTask({
      userId: 'user-2',
      teamId: 'team-1',
      taskId: 'task-public',
      status: 'in_progress',
      assigneeId: null,
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-public', status: 'in_progress', assigneeId: undefined },
    });
    await expect(app.updateTask({
      userId: 'user-2',
      teamId: 'team-1',
      taskId: 'task-private',
      status: 'done',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.createTask({ userId: 'user-1', teamId: 'team-1', title: '   ' })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });
    await expect(app.createTask({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: '',
      title: 'global task',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-global', channelId: undefined, title: 'global task' },
    });
    await expect(app.listTasks({ userId: 'user-2', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      tasks: expect.arrayContaining([
        expect.objectContaining({ id: 'task-global', channelId: undefined }),
        expect.objectContaining({ id: 'task-public' }),
      ]),
    });
    await expect(app.updateTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-global',
      sortOrder: 'bad' as unknown as number,
    })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });

    // delete: owner can delete their own task
    await expect(app.deleteTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-private',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-private' },
    });
    // delete: non-member of another team cannot delete
    await expect(app.deleteTask({
      userId: 'user-1',
      teamId: 'team-2',
      taskId: 'task-public',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    // delete: already-deleted task returns NOT_FOUND
    await expect(app.deleteTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-private',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    // delete: nonexistent task returns NOT_FOUND
    await expect(app.deleteTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-nope',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });

    // reorder: valid reorder
    await expect(app.reorderTask({
      userId: 'user-2',
      teamId: 'team-1',
      taskId: 'task-public',
      sortOrder: 999,
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-public', sortOrder: 999 },
    });
    // reorder: invalid sortOrder
    await expect(app.reorderTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-global',
      sortOrder: NaN,
    })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });
    // reorder: wrong team
    await expect(app.reorderTask({
      userId: 'user-1',
      teamId: 'team-2',
      taskId: 'task-global',
      sortOrder: 50,
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    // reorder: after delete, task is gone
    await expect(app.reorderTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-private',
      sortOrder: 10,
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    // delete remaining task
    await expect(app.deleteTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-global',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-global' },
    });
    // list should now only contain task-public
    await expect(app.listTasks({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      tasks: [{ id: 'task-public' }],
    });
  });

  test('channels can be archived (soft) and deleted (hard cascade) with proper access control', async () => {
    const app = createInMemoryServerNext({
      now: () => 400,
      ids: createIds([
        'user-1', 'team-1', 'channel-1',
        'join-1',
        'user-2', 'team-2', 'channel-2',
        'channel-archive', 'channel-delete',
        'message-1', 'dispatch-1',
      ]),
      joinCodes: createIds(['code-join']),
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'OwnerTeam' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'member', password: 'secret', teamName: 'MemberTeam', joinCode: 'code-join' });

    // Create channels for testing
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'to-archive',
      visibility: 'public',
    });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'to-delete',
      visibility: 'public',
    });

    // Archive: default channel is protected
    await expect(app.archiveChannel({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    // Archive: non-creator cannot archive
    await expect(app.archiveChannel({
      userId: 'user-2',
      teamId: 'team-1',
      channelId: 'channel-archive',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    // Archive: creator can archive
    await expect(app.archiveChannel({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-archive',
    })).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-archive', archivedAt: 400 },
    });

    // Archived channel excluded from listForUser
    await expect(app.listChannels({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      channels: expect.arrayContaining([
        expect.objectContaining({ id: 'channel-1' }),
        expect.objectContaining({ id: 'channel-delete' }),
      ]),
    });
    const listResult = await app.listChannels({ userId: 'user-1', teamId: 'team-1' });
    expect(listResult.channels?.some((c: any) => c.id === 'channel-archive')).toBe(false);

    // Delete: default channel is protected
    await expect(app.deleteChannel({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    // Delete: non-creator cannot delete
    await expect(app.deleteChannel({
      userId: 'user-2',
      teamId: 'team-1',
      channelId: 'channel-delete',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    // Delete: wrong team — fails at membership check
    await expect(app.deleteChannel({
      userId: 'user-1',
      teamId: 'team-2',
      channelId: 'channel-delete',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    // Delete: nonexistent channel
    await expect(app.deleteChannel({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-nope',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });

    // Add a message to the channel to verify cascade delete
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-delete',
      body: 'this should be gone after delete',
    });

    // Delete: creator can delete (cascade removes messages)
    await expect(app.deleteChannel({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-delete',
    })).resolves.toMatchObject({
      ok: true,
      channel: { id: 'channel-delete' },
    });

    // Deleted channel excluded from listForUser
    const afterDelete = await app.listChannels({ userId: 'user-1', teamId: 'team-1' });
    expect(afterDelete.channels?.some((c: any) => c.id === 'channel-delete')).toBe(false);
  });

  test('reactions and saved messages persist with proper access control', async () => {
    const app = createInMemoryServerNext({
      now: () => 500,
      ids: createIds([
        'user-1', 'team-1', 'channel-1',
        'join-1',
        'user-2', 'team-2', 'channel-2',
        'msg-1', 'dispatch-1',
        'r1', 'r2', 'r3', 'r4', 's1', 's2',
      ]),
      joinCodes: createIds(['code-join']),
    });
    await app.registerUser({ username: 'alice', password: 'secret', teamName: 'AliceTeam' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'bob', password: 'secret', teamName: 'BobTeam', joinCode: 'code-join' });

    // Send a message to react to
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'Hello world',
    });

    // React: team member can react
    await expect(app.reactMessage({
      userId: 'user-2',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: true, messageId: 'msg-1' });

    // React: non-member cannot react
    await expect(app.reactMessage({
      userId: 'user-1',
      teamId: 'team-2',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    // React: toggle off
    await expect(app.reactMessage({
      userId: 'user-2',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: false,
    })).resolves.toMatchObject({ ok: true });

    // React: nonexistent message
    await expect(app.reactMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-nope',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    // Save: team member can save
    await expect(app.saveMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: true, messageId: 'msg-1' });

    // Save: non-member cannot save
    await expect(app.saveMessage({
      userId: 'user-1',
      teamId: 'team-2',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    // List saved: returns saved messages
    await expect(app.listSavedMessages({
      userId: 'user-1',
      teamId: 'team-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'msg-1', body: 'Hello world' }],
    });

    // Unsave
    await expect(app.saveMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: false,
    })).resolves.toMatchObject({ ok: true });

    // List saved: empty after unsave
    await expect(app.listSavedMessages({
      userId: 'user-1',
      teamId: 'team-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });
  });

  test('manages member roles, removal, and owner transfer with role boundaries', async () => {
    const app = createInMemoryServerNext({
      now: () => 520,
      ids: createIds([
        'user-owner', 'team-main', 'channel-main',
        'join-admin',
        'user-admin', 'team-admin', 'channel-admin',
        'join-member',
        'user-member', 'team-member', 'channel-member',
      ]),
      joinCodes: createIds(['code-admin', 'code-member']),
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'MainTeam' });
    await app.createJoinLink({ userId: 'user-owner', teamId: 'team-main' });
    await app.registerUser({ username: 'admin', password: 'secret', teamName: 'AdminTeam', joinCode: 'code-admin' });
    await app.createJoinLink({ userId: 'user-owner', teamId: 'team-main' });
    await app.registerUser({ username: 'member', password: 'secret', teamName: 'MemberTeam', joinCode: 'code-member' });

    await expect(app.updateMemberRole({
      userId: 'user-member',
      teamId: 'team-main',
      targetUserId: 'user-admin',
      role: 'admin',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    await expect(app.updateMemberRole({
      userId: 'user-owner',
      teamId: 'team-main',
      targetUserId: 'user-admin',
      role: 'admin',
    })).resolves.toMatchObject({
      ok: true,
      member: { userId: 'user-admin', role: 'admin' },
    });

    await expect(app.updateMemberRole({
      userId: 'user-admin',
      teamId: 'team-main',
      targetUserId: 'user-member',
      role: 'admin',
    })).resolves.toMatchObject({
      ok: true,
      member: { userId: 'user-member', role: 'admin' },
    });

    await expect(app.updateMemberRole({
      userId: 'user-admin',
      teamId: 'team-main',
      targetUserId: 'user-member',
      role: 'member',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    await expect(app.updateMemberRole({
      userId: 'user-owner',
      teamId: 'team-main',
      targetUserId: 'user-member',
      role: 'member',
    })).resolves.toMatchObject({
      ok: true,
      member: { userId: 'user-member', role: 'member' },
    });

    await expect(app.removeMember({
      userId: 'user-admin',
      teamId: 'team-main',
      targetUserId: 'user-member',
    })).resolves.toMatchObject({
      ok: true,
      userId: 'user-member',
    });

    await expect(app.transferOwner({
      userId: 'user-admin',
      teamId: 'team-main',
      targetUserId: 'user-owner',
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    await expect(app.transferOwner({
      userId: 'user-owner',
      teamId: 'team-main',
      targetUserId: 'user-admin',
    })).resolves.toMatchObject({
      ok: true,
      member: { userId: 'user-admin', role: 'owner' },
      team: { id: 'team-main' },
    });

    await expect(app.listMembers({ userId: 'user-admin', teamId: 'team-main' })).resolves.toMatchObject({
      ok: true,
      humans: expect.arrayContaining([
        expect.objectContaining({ userId: 'user-owner', role: 'admin' }),
        expect.objectContaining({ userId: 'user-admin', role: 'owner' }),
      ]),
    });
  });

  test('creates and validates a user join link for an existing team member', async () => {
    const app = createInMemoryServerNext({
      now: () => 250,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1']),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(app.createJoinLink({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      link: {
        id: 'join-1',
        code: 'code-1',
        teamId: 'team-1',
        createdBy: 'user-1',
        usesCount: 0,
        maxUses: 1,
      },
      team: { id: 'team-1', name: 'AgentBean' },
    });
    await expect(app.validateJoinLink({ code: 'code-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', teamId: 'team-1', usesCount: 0, maxUses: 1 },
      team: { id: 'team-1', name: 'AgentBean' },
    });
  });

  test('team members can list and revoke join links for their own team', async () => {
    const app = createInMemoryServerNext({
      now: () => 290,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'join-2', 'user-2', 'team-2', 'channel-2']),
      joinCodes: createIds(['code-1', 'code-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1', maxUses: 5 });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin' });

    await expect(app.listJoinLinks({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      links: expect.arrayContaining([
        expect.objectContaining({ code: 'code-1', teamId: 'team-1', revokedAt: undefined }),
        expect.objectContaining({ code: 'code-2', teamId: 'team-1', maxUses: 5 }),
      ]),
    });

    await expect(app.listJoinLinks({ userId: 'user-2', teamId: 'team-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });

    await expect(app.revokeJoinLink({ userId: 'user-1', teamId: 'team-1', code: 'code-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', revokedAt: expect.any(Number) },
    });

    await expect(app.validateJoinLink({ code: 'code-1' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_INVALID',
    });

    await expect(app.listJoinLinks({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      links: [
        expect.objectContaining({ code: 'code-2', teamId: 'team-1' }),
      ],
    });

    await expect(app.revokeJoinLink({ userId: 'user-2', teamId: 'team-2', code: 'code-2' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/FORBIDDEN|NOT_FOUND/),
    });
  });

  test('registerUser with a join code joins the invited team and switches current team', async () => {
    const app = createInMemoryServerNext({
      now: () => 260,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'user-2', 'team-2', 'channel-2']),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });

    await expect(
      app.registerUser({
        username: 'lin',
        password: 'secret',
        teamName: 'Lin Private',
        joinCode: 'code-1',
      }),
    ).resolves.toMatchObject({
      ok: true,
      user: { id: 'user-2', username: 'lin', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1', currentUserRole: 'member' },
      defaultChannel: { id: 'channel-2', teamId: 'team-2' },
      joinedTeam: { id: 'team-1', currentUserRole: 'member' },
    });
    await expect(app.listTeams({ userId: 'user-2' })).resolves.toMatchObject({
      ok: true,
      currentTeamId: 'team-1',
      teams: expect.arrayContaining([
        expect.objectContaining({ id: 'team-1', currentUserRole: 'member' }),
        expect.objectContaining({ id: 'team-2', currentUserRole: 'owner' }),
      ]),
    });
    await expect(app.validateJoinLink({ code: 'code-1' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_ALREADY_USED',
    });
  });

  test('loginUser with a join code joins the invited team and switches current team', async () => {
    const app = createInMemoryServerNext({
      now: () => 270,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-1',
        'user-2',
        'team-2',
        'channel-2',
      ]),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Private' });

    await expect(app.loginUser({ username: 'lin', password: 'secret', joinCode: 'code-1' })).resolves.toMatchObject({
      ok: true,
      user: { id: 'user-2', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1', currentUserRole: 'member' },
      joinedTeam: { id: 'team-1', currentUserRole: 'member' },
    });
    await expect(app.listTeams({ userId: 'user-2' })).resolves.toMatchObject({
      ok: true,
      currentTeamId: 'team-1',
    });
  });

  test('existing team members can use a join code to switch teams without consuming it', async () => {
    const app = createInMemoryServerNext({
      now: () => 275,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'team-2', 'channel-2', 'user-2', 'team-3', 'channel-3']),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.createTeam({ userId: 'user-1', name: 'Ops Team' });

    await expect(app.loginUser({ username: 'shaw', password: 'secret', joinCode: 'code-1' })).resolves.toMatchObject({
      ok: true,
      currentTeam: { id: 'team-1', currentUserRole: 'owner' },
      joinedTeam: { id: 'team-1', currentUserRole: 'owner' },
    });
    await expect(app.validateJoinLink({ code: 'code-1' })).resolves.toMatchObject({
      ok: true,
      link: { code: 'code-1', usesCount: 0, maxUses: 1 },
    });
    await expect(
      app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Private', joinCode: 'code-1' }),
    ).resolves.toMatchObject({
      ok: true,
      currentTeam: { id: 'team-1', currentUserRole: 'member' },
    });
  });

  test('join links reject non-members, missing teams, expired codes, and exhausted codes', async () => {
    const app = createInMemoryServerNext({
      now: () => 280,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'join-2', 'user-2', 'team-2', 'channel-2', 'user-3', 'team-3', 'channel-3']),
      joinCodes: createIds(['code-1', 'code-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1', expiresAt: 279 });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Private' });

    await expect(app.createJoinLink({ userId: 'user-2', teamId: 'team-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.validateJoinLink({ code: 'missing-code' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_INVALID',
    });
    await expect(app.validateJoinLink({ code: 'code-2' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_EXPIRED',
    });
    await expect(app.loginUser({ username: 'lin', password: 'secret', joinCode: 'code-1' })).resolves.toMatchObject({
      ok: true,
      currentTeam: { id: 'team-1' },
    });
    await expect(
      app.registerUser({ username: 'mei', password: 'secret', teamName: 'Mei Private', joinCode: 'code-1' }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_ALREADY_USED',
    });
  });

  test('whoami restores user and current team from a signed session token', async () => {
    const app = createInMemoryServerNext({
      now: () => 220,
      ids: createIds(['user-1', 'team-1', 'channel-1']),
    });

    const loginAck = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    if (!loginAck.ok) {
      throw new Error('registration failed');
    }

    await expect(app.whoami({ token: loginAck.token })).resolves.toMatchObject({
      ok: true,
      user: { id: 'user-1', username: 'shaw', primaryTeamId: 'team-1' },
      currentTeam: { id: 'team-1', currentUserRole: 'owner' },
    });
    await expect(app.whoami({ token: `${loginAck.token}x` })).resolves.toMatchObject({
      ok: false,
      error: 'UNAUTHENTICATED',
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

  test('sendMessage attaches same-channel uploaded artifacts to the human message', async () => {
    const app = createInMemoryServerNext({
      now: () => 320,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'artifact-1', 'message-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.uploadArtifact({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'brief.md',
      mimeType: 'text/markdown',
      sizeBytes: 12,
      storagePath: 'artifacts/team-1/artifact-1/brief.md',
      relativePath: 'brief.md',
      sha256: 'hash-1',
    });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'see attached',
      artifactIds: ['artifact-1'],
    });

    expect(ack).toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        meta: { artifactIds: ['artifact-1'] },
        artifacts: [
          {
            id: 'artifact-1',
            filename: 'brief.md',
            pathKind: 'upload',
          },
        ],
      },
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          id: 'message-1',
          artifacts: [{ id: 'artifact-1', filename: 'brief.md' }],
        },
      ],
    });
  });

  test('sendMessage passes uploaded artifacts through to the dispatch request', async () => {
    const app = createInMemoryServerNext({
      now: () => 330,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'artifact-1', 'message-1', 'dispatch-1', 'request-1']),
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
      lastSeenAt: 330,
    });
    await app.uploadArtifact({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'brief.md',
      mimeType: 'text/markdown',
      sizeBytes: 12,
      storagePath: 'artifacts/team-1/artifact-1/brief.md',
      relativePath: 'brief.md',
      sha256: 'hash-1',
    });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex read this',
      artifactIds: ['artifact-1'],
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1' }],
    });

    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-1' })).resolves.toMatchObject({
      ok: true,
      request: {
        id: 'dispatch-1',
        messageId: 'message-1',
        attachments: [
          {
            id: 'artifact-1',
            name: 'brief.md',
            mimeType: 'text/markdown',
            sizeBytes: 12,
          },
        ],
      },
    });
  });

  test('sendMessage rejects artifacts that are already bound to another message', async () => {
    const app = createInMemoryServerNext({
      now: () => 340,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'artifact-1', 'message-1', 'message-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.uploadArtifact({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'brief.md',
      mimeType: 'text/markdown',
      sizeBytes: 12,
      storagePath: 'artifacts/team-1/artifact-1/brief.md',
      relativePath: 'brief.md',
      sha256: 'hash-1',
    });
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'first attach',
      artifactIds: ['artifact-1'],
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', artifacts: [{ id: 'artifact-1' }] },
    });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'reuse attach',
      artifactIds: ['artifact-1'],
    })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-1', artifacts: [{ id: 'artifact-1' }] },
      ],
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

  test('starts and restores direct messages while thread dispatch history excludes the current prompt', async () => {
    let now = 410;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'dm-1',
        'message-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'message-3',
        'dispatch-2',
        'request-2',
      ]),
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
      lastSeenAt: now,
    });

    await expect(app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' })).resolves.toMatchObject({
      ok: true,
      dm: {
        channel: {
          id: 'dm-1',
          kind: 'direct',
          visibility: 'private',
          dmTargetAgentId: 'agent-1',
        },
        agent: { id: 'agent-1' },
      },
    });
    await expect(app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' })).resolves.toMatchObject({
      ok: true,
      dm: { channel: { id: 'dm-1' } },
    });
    await expect(app.listDirectMessages({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      dms: [{ channel: { id: 'dm-1' }, agent: { id: 'agent-1' } }],
    });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'dm-1',
      body: 'hello in dm',
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        threadId: 'message-1',
        meta: { routeReason: 'DIRECT' },
      },
      route: { kind: 'dispatch', agentId: 'agent-1', reason: 'direct' },
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1' }],
    });

    now = 411;
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'first reply',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-2', threadId: 'message-1', body: 'first reply' },
    });

    now = 412;
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'dm-1',
      threadId: 'message-1',
      body: 'follow up',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-3', threadId: 'message-1' },
      dispatches: [{ id: 'dispatch-2', messageId: 'message-3' }],
    });
    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-2' })).resolves.toMatchObject({
      ok: true,
      request: {
        id: 'dispatch-2',
        threadId: 'message-1',
        prompt: 'follow up',
        history: [
          { messageId: 'message-1', body: 'hello in dm' },
          { messageId: 'message-2', body: 'first reply' },
        ],
      },
    });
    const request = await app.getDispatchRequest({ dispatchId: 'dispatch-2' });
    if (!request.ok) {
      throw new Error('dispatch request failed');
    }
    expect(request.request.history?.map((item) => item.body)).not.toContain('follow up');

    await expect(app.snapshotDirectMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-1' },
        { id: 'message-2' },
        { id: 'message-3' },
      ],
    });
    await expect(app.snapshotDirectMessage({ userId: 'user-2', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('cancelDispatch marks a pending dispatch as cancelled for team members', async () => {
    let now = 430;
    const app = createInMemoryServerNext({
      now: () => now,
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
      lastSeenAt: now,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });

    now = 450;
    await expect(app.cancelDispatch({ userId: 'user-1', dispatchId: 'dispatch-1' })).resolves.toMatchObject({
      ok: true,
      dispatch: {
        id: 'dispatch-1',
        status: 'cancelled',
        completedAt: 450,
      },
    });
    await expect(app.cancelDispatch({ userId: 'user-2', dispatchId: 'dispatch-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'late reply',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
    await expect(app.failTimedOutDispatches({ olderThan: 999 })).resolves.toMatchObject({
      ok: true,
      dispatches: [],
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          id: 'message-1',
          senderKind: 'human',
          body: '@Codex hello',
        },
      ],
    });
  });

  test('receiveDispatchResult is idempotent against same-millisecond duplicate results', async () => {
    const app = createInMemoryServerNext({
      now: () => 470,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1', 'message-2']),
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
      lastSeenAt: 470,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });

    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'first reply',
    })).resolves.toMatchObject({
      ok: true,
      dispatch: { status: 'succeeded' },
      message: { id: 'message-2', body: 'first reply' },
    });
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'duplicate reply',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-1', body: '@Codex hello' },
        { id: 'message-2', body: 'first reply' },
      ],
    });
  });

  test('returns device detail with runtimes and visible agents for team members only', async () => {
    const app = createInMemoryServerNext({
      now: () => 500,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'runtime-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'shaw-mbp',
    });
    await app.reportDeviceRuntimes({
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
    });
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
      lastSeenAt: 500,
    });

    await expect(app.getDevice({ userId: 'user-1', deviceId: 'device-1' })).resolves.toMatchObject({
      ok: true,
      device: {
        id: 'device-1',
        teamId: 'team-1',
        name: 'shaw-mbp',
        runtimes: [{ id: 'runtime-1', name: 'Codex CLI' }],
        agents: [{ id: 'agent-1', name: 'Codex' }],
      },
    });
    await expect(app.getDevice({ userId: 'user-2', deviceId: 'device-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('creates a visible custom agent from an installed device runtime without exposing raw env', async () => {
    const app = createInMemoryServerNext({
      now: () => 550,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'runtime-1',
        'agent-1',
        'message-1',
        'dispatch-1',
        'request-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'shaw-mbp',
    });
    await app.reportDeviceRuntimes({
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          cwd: '/Users/shaw/AgentBean',
          installed: true,
        },
      ],
    });

    const ack = await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
      description: 'Local Codex preview agent',
      args: ['--model', 'gpt-5.4'],
      env: {
        OPENAI_API_KEY: 'secret-value',
      },
    });

    expect(ack).toMatchObject({
      ok: true,
      agent: {
        id: 'agent-1',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'Custom Codex',
        description: 'Local Codex preview agent',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'custom',
        status: 'online',
        ownerId: 'user-1',
        deviceId: 'device-1',
        command: '/opt/homebrew/bin/codex',
        args: ['--model', 'gpt-5.4'],
        cwd: '/Users/shaw/AgentBean',
        envKeys: ['OPENAI_API_KEY'],
        lastSeenAt: 550,
      },
    });
    expect(JSON.stringify(ack)).not.toContain('secret-value');
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', source: 'custom', envKeys: ['OPENAI_API_KEY'] }],
    });
    const sendAck = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    expect(sendAck).toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', agentId: 'agent-1' }],
    });
    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-1' })).resolves.toMatchObject({
      ok: true,
      request: {
        id: 'dispatch-1',
        deviceId: 'device-1',
        customAgent: {
          adapterKind: 'codex',
          command: '/opt/homebrew/bin/codex',
          args: ['--model', 'gpt-5.4'],
          cwd: '/Users/shaw/AgentBean',
          env: { OPENAI_API_KEY: 'secret-value' },
        },
      },
    });
    await expect(
      app.createCustomAgent({
        userId: 'user-2',
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimeId: 'runtime-1',
        name: 'Forbidden Codex',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('manages custom agent publication, config, and delete without exposing secrets or removing history', async () => {
    const app = createInMemoryServerNext({
      now: () => 700,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'team-2',
        'channel-2',
        'device-1',
        'runtime-1',
        'agent-1',
        'message-1',
        'dispatch-1',
        'request-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createTeam({ userId: 'user-1', name: 'Client Team' });
    await app.switchTeam({ userId: 'user-1', teamId: 'team-1' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'shaw-mbp',
    });
    await app.reportDeviceRuntimes({
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
          cwd: '/Users/shaw/AgentBean',
          installed: true,
        },
      ],
    });
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
      env: { OPENAI_API_KEY: 'old-secret' },
    });

    await expect(
      app.publishAgent({
        userId: 'user-1',
        teamId: 'team-1',
        agentId: 'agent-1',
        targetTeamId: 'team-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });

    await expect(
      app.publishAgent({
        userId: 'user-1',
        teamId: 'team-1',
        agentId: 'agent-1',
        targetTeamId: 'team-2',
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: ['team-1', 'team-2'] },
    });
    await expect(app.listVisibleAgents({ teamId: 'team-2' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', name: 'Custom Codex' }],
    });

    const updateAck = await app.updateAgentConfig({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Renamed Codex',
      description: 'Updated custom agent',
      args: ['--model', 'gpt-5.4'],
      env: { OPENAI_API_KEY: 'new-secret' },
    });
    expect(updateAck).toMatchObject({
      ok: true,
      agent: {
        id: 'agent-1',
        name: 'Renamed Codex',
        description: 'Updated custom agent',
        envKeys: ['OPENAI_API_KEY'],
      },
    });
    expect(JSON.stringify(updateAck)).not.toContain('new-secret');

    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello from renamed config',
    });
    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-1' })).resolves.toMatchObject({
      ok: true,
      request: {
        customAgent: {
          name: 'Renamed Codex',
          args: ['--model', 'gpt-5.4'],
          env: { OPENAI_API_KEY: 'new-secret' },
        },
      },
    });

    await expect(
      app.unpublishAgent({
        userId: 'user-1',
        teamId: 'team-1',
        agentId: 'agent-1',
        targetTeamId: 'team-2',
      }),
    ).resolves.toMatchObject({
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: ['team-1'] },
    });
    await expect(app.listVisibleAgents({ teamId: 'team-2' })).resolves.toMatchObject({
      ok: true,
      agents: [],
    });

    const deleteAck = await app.deleteAgent({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
    expect(deleteAck).toMatchObject({
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: [], status: 'offline' },
    });
    expect(JSON.stringify(deleteAck)).not.toContain('deletedAt');
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'late reply',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    await expect(app.receiveDispatchError({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      error: 'late failure',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [],
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'message-1', body: 'hello from renamed config' }],
    });
  });

  test('creates device scan requests for online devices visible to team members', async () => {
    const app = createInMemoryServerNext({
      now: () => 500,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'scan-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });

    await expect(app.requestDeviceScan({ userId: 'user-1', deviceId: 'device-1' })).resolves.toEqual({
      ok: true,
      request: {
        requestId: 'scan-1',
        deviceId: 'device-1',
      },
    });
    await expect(app.requestDeviceScan({ userId: 'user-2', deviceId: 'device-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.requestDeviceScan({ userId: 'user-1', deviceId: 'missing-device' })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  test('device invite issues credentials to a waiting daemon and registers it without manual team config', async () => {
    const app = createInMemoryServerNext({
      now: () => 720,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-invite-1', 'device-1']),
      deviceInviteCodes: createIds(['device-code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(
      app.createDeviceInvite({ userId: 'user-1', teamId: 'team-1', profileId: 'agentbean-next' }),
    ).resolves.toMatchObject({
      ok: true,
      invite: {
        id: 'device-invite-1',
        code: 'device-code-1',
        teamId: 'team-1',
        createdBy: 'user-1',
        profileId: 'agentbean-next',
      },
      team: { id: 'team-1', name: 'AgentBean' },
    });

    await expect(
      app.waitForDeviceInvite({
        code: 'device-code-1',
        machineId: 'machine-1',
        profileId: 'agentbean-next',
        hostname: 'shaw-mbp',
      }),
    ).resolves.toMatchObject({
      ok: true,
      invite: { code: 'device-code-1', teamId: 'team-1' },
      team: { id: 'team-1' },
    });

    const completed = await app.completeDeviceInvite({
      userId: 'user-1',
      code: 'device-code-1',
      serverUrl: 'http://127.0.0.1:4000',
    });
    expect(completed).toMatchObject({
      ok: true,
      credentials: {
        token: expect.stringMatching(/^abn_device\./),
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'agentbean-next',
        hostname: 'shaw-mbp',
        serverUrl: 'http://127.0.0.1:4000',
      },
    });
    if (!completed.ok) {
      throw new Error('device invite completion failed');
    }

    await expect(
      app.deviceHelloFromCredentials({
        token: completed.credentials.token,
        machineId: completed.credentials.machineId,
        profileId: completed.credentials.profileId,
        hostname: completed.credentials.hostname,
      }),
    ).resolves.toMatchObject({
      ok: true,
      device: {
        id: 'device-1',
        teamId: 'team-1',
        ownerId: 'user-1',
        name: 'shaw-mbp',
      },
    });

    await expect(app.completeDeviceInvite({ userId: 'user-1', code: 'device-code-1' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_ALREADY_USED',
    });
  });

  test('rejects unauthorized or invalid custom agent management operations', async () => {
    const app = createInMemoryServerNext({
      now: () => 720,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-1',
        'user-2',
        'team-2',
        'channel-2',
        'device-1',
        'runtime-1',
        'agent-1',
        'agent-2',
      ]),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Private', joinCode: 'code-1' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await app.reportDeviceRuntimes({
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimes: [{ adapterKind: 'codex', name: 'Codex CLI', installed: true }],
    });
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
    });
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ adapterKind: 'claude-code', name: 'Scanned Claude', category: 'executor-hosted' }],
    });

    await expect(app.updateAgentConfig({
      userId: 'user-2',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Member Rename',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.deleteAgent({
      userId: 'user-2',
      teamId: 'team-1',
      agentId: 'agent-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.publishAgent({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.deleteAgent({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-2',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    await expect(app.deleteAgent({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    })).resolves.toMatchObject({ ok: true });
    await expect(app.updateAgentConfig({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Deleted Rename',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.deleteAgent({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
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
