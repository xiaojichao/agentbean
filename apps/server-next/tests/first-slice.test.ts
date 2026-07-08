import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createInMemoryServerNext, createServerNextUseCases } from '../src/index';

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
      readFileSync(migrationPath('team/0009_pinned_messages.sql'), 'utf8'),
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
      'pinned_messages',
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

    const ownSearch = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' });
    expect(ownSearch).toMatchObject({ ok: true });
    expect(ownSearch.messages).toHaveLength(2);
    expect(ownSearch.messages.map((message) => ({ id: message.id, body: message.body }))).toEqual(
      expect.arrayContaining([
        { id: 'message-private', body: 'secret roadmap search' },
        { id: 'message-public', body: 'public roadmap search' },
      ]),
    );
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
    await expect(app.searchMessages({ userId: 'user-2', teamId: 'team-1', query: 'roadmap', channelId: 'channel-private' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
    await expect(app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'r' })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });
  });

  test('searchMessages can be scoped to one channel', async () => {
    const app = createInMemoryServerNext({
      now: () => 255,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'channel-2',
        'message-all',
        'message-focused',
        'message-other-term',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'focused-search',
      visibility: 'public',
    });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'roadmap in all channel' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', body: 'roadmap in focused channel' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', body: 'shipping notes' });

    const scoped = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap', channelId: 'channel-2' });
    expect(scoped).toMatchObject({ ok: true });
    expect(scoped.messages.map((message) => ({ id: message.id, channelId: message.channelId, body: message.body }))).toEqual([
      { id: 'message-focused', channelId: 'channel-2', body: 'roadmap in focused channel' },
    ]);

    const global = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' });
    expect(global).toMatchObject({ ok: true });
    expect(global.messages.map((message) => message.id)).toEqual(expect.arrayContaining(['message-all', 'message-focused']));
  });

  test('getMessageContext returns a thread root with the matched reply', async () => {
    const app = createInMemoryServerNext({
      now: () => 260,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-root',
        'message-reply',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'thread root' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-root', body: 'thread reply roadmap' });

    const context = await app.getMessageContext({ userId: 'user-1', teamId: 'team-1', messageId: 'message-reply' });

    expect(context).toMatchObject({
      ok: true,
      targetMessageId: 'message-reply',
      threadRootId: 'message-root',
    });
    expect(context.messages.map((message) => ({ id: message.id, body: message.body }))).toEqual([
      { id: 'message-root', body: 'thread root' },
      { id: 'message-reply', body: 'thread reply roadmap' },
    ]);
  });

  test('getMessageContext includes the thread root even when the matched reply is deep', async () => {
    let now = 300;
    const replyIds = Array.from({ length: 55 }, (_, index) => `message-reply-${index + 1}`);
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-root',
        ...replyIds,
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'thread root' });
    for (let index = 0; index < replyIds.length; index += 1) {
      now = 301 + index;
      await app.sendMessage({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        threadId: 'message-root',
        body: `thread reply ${index + 1}`,
      });
    }

    const context = await app.getMessageContext({ userId: 'user-1', teamId: 'team-1', messageId: 'message-reply-55' });

    expect(context).toMatchObject({
      ok: true,
      targetMessageId: 'message-reply-55',
      threadRootId: 'message-root',
    });
    expect(context.messages.map((message) => message.id)).toContain('message-root');
    expect(context.messages.at(-1)?.id).toBe('message-reply-55');
  });

  test('searchMessages rejects scoped archived channels', async () => {
    const app = createInMemoryServerNext({
      now: () => 275,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'channel-archived',
        'message-archived',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createChannel({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'archived-search',
      visibility: 'public',
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-archived',
      body: 'archived roadmap note',
    });
    await app.archiveChannel({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-archived' });

    await expect(app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });
    await expect(app.searchMessages({
      userId: 'user-1',
      teamId: 'team-1',
      query: 'roadmap',
      channelId: 'channel-archived',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
  });

  test('searchMessages requires all terms and ranks phrase matches above scattered matches', async () => {
    const app = createInMemoryServerNext({
      now: () => 300,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'm-phrase', 'm-scattered', 'm-partial']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'the roadmap shipping plan' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'roadmap needs more shipping' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'roadmap only' });

    const result = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap shipping' });
    expect(result).toMatchObject({ ok: true });
    // partial match (only "roadmap") is filtered out; both remaining messages contain every term.
    expect(result.messages.map((message) => message.body)).toEqual([
      'the roadmap shipping plan',
      'roadmap needs more shipping',
    ]);
    // the phrase match ("roadmap shipping" contiguous) ranks above the scattered match.
    expect(result.messages[0].body).toBe('the roadmap shipping plan');
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
      category: 'agentos-hosted',
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

  test('searchMessages excludes direct messages whose target agent is no longer visible', async () => {
    const app = createInMemoryServerNext({
      now: () => 270,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'runtime-1',
        'agent-1',
        'dm-1',
        'message-dm',
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
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
    });
    await app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1', body: 'hidden dm roadmap note' });

    await expect(app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'message-dm', body: 'hidden dm roadmap note' }],
    });

    await app.deleteAgent({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });

    await expect(app.listDirectMessages({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      dms: [],
    });
    await expect(app.snapshotDirectMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    await expect(app.getMessageContext({ userId: 'user-1', teamId: 'team-1', messageId: 'message-dm' })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
    await expect(app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'roadmap' })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });
    await expect(app.searchMessages({
      userId: 'user-1',
      teamId: 'team-1',
      query: 'roadmap',
      channelId: 'dm-1',
    })).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });
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
        'message-task-status',
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
      message: {
        id: 'message-task-status',
        senderKind: 'system',
        senderId: 'system',
        body: '任务「public task」状态更新为进行中',
        meta: {
          kind: 'task-status-updated',
          taskId: 'task-public',
          taskTitle: 'public task',
          previousStatus: 'todo',
          status: 'in_progress',
        },
      },
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          id: 'message-task-status',
          senderKind: 'system',
          meta: {
            kind: 'task-status-updated',
            taskId: 'task-public',
            previousStatus: 'todo',
            status: 'in_progress',
          },
        },
      ],
    });
    await expect(app.updateTask({
      userId: 'user-2',
      teamId: 'team-1',
      taskId: 'task-public',
      status: 'in_progress',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-public', status: 'in_progress' },
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          id: 'message-task-status',
        },
      ],
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
        'r1', 'r2', 'r3', 'r4', 's1', 's2', 'p1', 'p2', 's3', 'p3',
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

    // Pin: channel-visible pin is shared across members
    await expect(app.pinMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: true, messageId: 'msg-1' });

    await expect(app.listPinnedMessages({
      userId: 'user-2',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'msg-1', body: 'Hello world' }],
    });

    // Pin: non-member cannot pin
    await expect(app.pinMessage({
      userId: 'user-1',
      teamId: 'team-2',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    // Unpin
    await expect(app.pinMessage({
      userId: 'user-2',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: false,
    })).resolves.toMatchObject({ ok: true });

    await expect(app.listPinnedMessages({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });

    // Edit: only the original human author can edit an ordinary message
    await expect(app.editMessage({
      userId: 'user-2',
      teamId: 'team-1',
      messageId: 'msg-1',
      body: 'Edited world',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    await expect(app.editMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      body: '   ',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

    await expect(app.editMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      body: 'Edited world',
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        body: 'Edited world',
        meta: {
          editedAt: 500,
          editedBy: 'user-1',
        },
      },
    });

    await expect(app.searchMessages({
      userId: 'user-1',
      teamId: 'team-1',
      query: 'Edited',
    })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'msg-1', body: 'Edited world' }],
    });

    await expect(app.saveMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: true });
    await expect(app.pinMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: true });

    // Delete: only the original human author can soft-delete an ordinary message
    await expect(app.deleteMessage({
      userId: 'user-2',
      teamId: 'team-1',
      messageId: 'msg-1',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });

    await expect(app.deleteMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'msg-1',
        body: '消息已删除',
        meta: {
          deletedAt: 500,
          deletedBy: 'user-1',
        },
      },
    });

    await expect(app.listChannelMessages({
      userId: 'user-2',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'msg-1', body: '消息已删除' }],
    });

    await expect(app.reactMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.saveMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.pinMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.convertMessageToTask({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.listSavedMessages({
      userId: 'user-1',
      teamId: 'team-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });
    await expect(app.listPinnedMessages({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      messages: [],
    });

    await expect(app.searchMessages({
      userId: 'user-1',
      teamId: 'team-1',
      query: 'Hello',
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

  test('lists visible scanned and custom agents with team members', async () => {
    const app = createInMemoryServerNext({
      now: () => 310,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1', 'agent-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'MacBook Pro',
    });
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{
        name: 'Hermes Gateway',
        adapterKind: 'hermes',
        category: 'agentos-hosted',
        command: '/usr/local/bin/hermes',
        args: ['gateway', 'run'],
        cwd: '/Users/shaw/hermes',
      }],
    });
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      name: 'Local Codex',
      adapterKind: 'codex',
      command: '/usr/local/bin/codex',
      args: ['--model', 'gpt-5.4'],
      cwd: '/Users/shaw/project',
    });

    await expect(app.listMembers({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      humans: [expect.objectContaining({ userId: 'user-1' })],
      agents: expect.arrayContaining([
        expect.objectContaining({
          id: 'agent-1',
          name: 'Hermes Gateway',
          category: 'agentos-hosted',
          source: 'scanned',
          deviceId: 'device-1',
          deviceName: 'MacBook Pro',
        }),
        expect.objectContaining({
          id: 'agent-2',
          name: 'Local Codex',
          category: 'executor-hosted',
          source: 'custom',
          deviceId: 'device-1',
          deviceName: 'MacBook Pro',
        }),
      ]),
    });
  });

  test('collapses duplicated hosted agents onto the canonical device in members page', async () => {
    let now = 100;
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids: {
        nextId: createIds(['user-1', 'team-1', 'channel-1']),
      },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.devices.upsertHello({
      id: 'stale-device',
      teamId: 'team-1',
      ownerId: 'user-1',
      name: 'Hermes Mac',
      status: 'online',
      lastSeenAt: 100,
      createdAt: 100,
      updatedAt: 100,
    });
    await repositories.agents.upsert({
      id: 'stale-agent',
      name: 'Hermes Agent',
      adapterKind: 'hermes',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      deviceId: 'stale-device',
      command: '/usr/local/bin/hermes',
      lastSeenAt: 100,
    });
    now = 200;
    await repositories.devices.upsertHello({
      id: 'canonical-device',
      teamId: 'team-1',
      ownerId: 'user-1',
      name: 'Hermes Mac',
      status: 'online',
      machineId: 'machine-1',
      profileId: 'default',
      lastSeenAt: 200,
      createdAt: 200,
      updatedAt: 200,
    });
    await repositories.agents.upsert({
      id: 'canonical-agent',
      name: 'Hermes Agent',
      adapterKind: 'hermes',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'offline',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      deviceId: 'canonical-device',
      command: '/usr/local/bin/hermes',
      lastSeenAt: 200,
    });

    const members = await app.listMembers({ userId: 'user-1', teamId: 'team-1' });

    expect(members).toMatchObject({ ok: true });
    if (!members.ok) {
      throw new Error('list members failed');
    }
    expect(members.agents).toEqual([
      expect.objectContaining({
        id: 'canonical-agent',
        name: 'Hermes Agent',
        category: 'agentos-hosted',
        source: 'scanned',
        deviceId: 'canonical-device',
        deviceName: 'Hermes Mac',
        status: 'offline',
        lastSeenAt: 200,
      }),
    ]);
  });

  test('keeps custom agents with the same runtime separate in members page', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 300 },
      ids: {
        nextId: createIds(['user-1', 'team-1', 'channel-1']),
      },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.devices.upsertHello({
      id: 'device-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      name: 'Dev Mac',
      status: 'online',
      lastSeenAt: 300,
      createdAt: 300,
      updatedAt: 300,
    });
    for (const id of ['custom-agent-1', 'custom-agent-2']) {
      await repositories.agents.upsert({
        id,
        name: id === 'custom-agent-1' ? 'Codex Reviewer' : 'Codex Builder',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'custom',
        status: 'online',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        deviceId: 'device-1',
        command: '/usr/local/bin/codex',
        args: ['--model', 'gpt-5.4'],
        cwd: '/Users/shaw/project',
        lastSeenAt: 300,
      });
    }

    const members = await app.listMembers({ userId: 'user-1', teamId: 'team-1' });

    expect(members).toMatchObject({ ok: true });
    if (!members.ok) {
      throw new Error('list members failed');
    }
    expect(members.agents.map((agent) => agent.id).sort()).toEqual(['custom-agent-1', 'custom-agent-2']);
  });

  test('keeps gateway instances separate when their gateway identity differs', async () => {
    const app = createInMemoryServerNext({
      now: () => 320,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1', 'agent-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'Gateway Host',
    });
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: ['workspace-a', 'workspace-b'].map((gatewayInstanceKey) => ({
        adapterKind: 'openclaw',
        name: 'OpenClaw Agent',
        category: 'agentos-hosted',
        command: '/usr/local/bin/openclaw',
        gatewayInstanceKey,
      })),
    });

    const members = await app.listMembers({ userId: 'user-1', teamId: 'team-1' });

    expect(members).toMatchObject({ ok: true });
    if (!members.ok) {
      throw new Error('list members failed');
    }
    expect(members.agents.map((agent) => agent.gatewayInstanceKey).sort()).toEqual(['workspace-a', 'workspace-b']);
  });

  test('lists canonical hosted agents when device detail is opened through a stale duplicate id', async () => {
    let now = 100;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'stale-device',
        'canonical-device',
        'agent-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'Hermes Mac',
    });
    now = 200;
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      hostname: 'Hermes Mac',
    });
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'canonical-device',
      agents: [{
        name: 'Hermes Agent',
        adapterKind: 'hermes',
        category: 'agentos-hosted',
        command: '/usr/local/bin/hermes',
      }],
    });

    await expect(app.getDevice({ userId: 'user-1', deviceId: 'stale-device' })).resolves.toMatchObject({
      ok: true,
      device: {
        id: 'canonical-device',
        agents: [
          expect.objectContaining({
            id: 'agent-1',
            name: 'Hermes Agent',
            deviceName: 'Hermes Mac',
          }),
        ],
      },
    });
    await expect(app.listDeviceAgents({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'stale-device',
    })).resolves.toMatchObject({
      ok: true,
      agents: [
        expect.objectContaining({
          id: 'agent-1',
          name: 'Hermes Agent',
          deviceName: 'Hermes Mac',
        }),
      ],
    });
  });

  test('listMembers always includes the current authenticated user as a human member', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories: {
        ...repositories,
        teams: {
          ...repositories.teams,
          async listAllMembers(teamId) {
            const humans = await repositories.teams.listAllMembers(teamId);
            return humans.filter((human) => human.userId !== 'user-1');
          },
        },
      },
      clock: { now: () => 250 },
      ids: {
        nextId: createIds(['user-1', 'team-1', 'channel-1']),
      },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    await expect(app.listMembers({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      humans: expect.arrayContaining([
        expect.objectContaining({
          id: 'team-1:user-1',
          teamId: 'team-1',
          userId: 'user-1',
          username: 'shaw',
          role: 'owner',
          joinedAt: 250,
        }),
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

  test('sendMessage with asTask persists a linked channel task', async () => {
    const app = createInMemoryServerNext({
      now: () => 310,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'task-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

    const ack = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'ship Raft parity',
      asTask: true,
    });

    expect(ack).toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        meta: { taskId: 'task-1' },
      },
      task: {
        id: 'task-1',
        title: 'ship Raft parity',
      },
    });
    await expect(app.listTasks({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' })).resolves.toMatchObject({
      ok: true,
      tasks: [
        {
          id: 'task-1',
          title: 'ship Raft parity',
          status: 'todo',
          channelId: 'channel-1',
          creatorId: 'user-1',
          assigneeId: undefined,
        },
      ],
    });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          id: 'message-1',
          meta: { taskId: 'task-1' },
        },
      ],
    });
  });

  test('sendMessage auto-threadifies task-like agent requests and nests the agent result', async () => {
    let now = 320;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-1',
        'task-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'message-3',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Hermes-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });

    const sendAck = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Hermes-Agent 总结一下今天的国内新闻 Top20',
    });

    expect(sendAck).toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        threadId: 'message-1',
        meta: { taskId: 'task-1', routeReason: 'MENTION' },
      },
      task: {
        id: 'task-1',
        title: '@Hermes-Agent 总结一下今天的国内新闻 Top20',
        assigneeId: 'agent-1',
        status: 'in_progress',
      },
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1' }],
      acknowledgementMessage: {
        id: 'message-2',
        senderKind: 'agent',
        senderId: 'agent-1',
        threadId: 'message-1',
        body: '我来处理，会先看请求和附件，再把结果发在线程里。',
        meta: {
          kind: 'task-claim-confirmed',
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentMessageId: 'message-1',
          replyScope: 'thread',
        },
      },
    });

    now = 321;
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: '国内新闻 Top20 结果',
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'message-3',
        threadId: 'message-1',
        body: '国内新闻 Top20 结果',
        meta: { parentMessageId: 'message-1', replyScope: 'thread' },
      },
      task: { id: 'task-1', status: 'in_review' },
    });

    await expect(app.getMessageContext({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'message-3',
    })).resolves.toMatchObject({
      ok: true,
      threadRootId: 'message-1',
      messages: [
        { id: 'message-1', body: '@Hermes-Agent 总结一下今天的国内新闻 Top20' },
        { id: 'message-2', body: '我来处理，会先看请求和附件，再把结果发在线程里。' },
        { id: 'message-3', body: '国内新闻 Top20 结果' },
      ],
    });
  });

  test('sendMessage routes task thread replies back to the assigned agent', async () => {
    let now = 326;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-1',
        'task-1',
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
      id: 'agent-2',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Claude-Agent',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-2',
      lastSeenAt: now,
    });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Codex-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex-Agent 实现任务归属规则',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-1', assigneeId: 'agent-1' },
      dispatches: [{ id: 'dispatch-1', agentId: 'agent-1' }],
    });

    now = 327;
    await app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: '已完成第一轮',
    });

    now = 328;
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      body: '继续补一条回归测试',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-3', threadId: 'message-1' },
      dispatches: [{ id: 'dispatch-2', agentId: 'agent-1', messageId: 'message-3' }],
      route: { kind: 'dispatch', agentId: 'agent-1' },
    });
  });

  test('sendMessage does not let another agent steal a thread when the assignee is offline', async () => {
    let now = 329;
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'task-1', 'dispatch-1', 'request-1', 'message-2']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-2',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Claude-Agent',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-2',
      lastSeenAt: now,
    });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Codex-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });

    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex-Agent 实现任务归属规则',
    });
    await repositories.agents.updateStatus({
      agentId: 'agent-1',
      status: 'offline',
      lastSeenAt: now,
    });

    now = 330;
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      body: '继续补一条回归测试',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-2', threadId: 'message-1' },
      dispatches: [],
      route: { kind: 'no-dispatch', reason: 'no-online-agent' },
    });
  });

  test('sendMessage keeps non-task thread replies with the latest agent responder', async () => {
    let now = 331;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
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
      id: 'agent-2',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Claude-Agent',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-2',
      lastSeenAt: now,
    });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Codex-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });

    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex-Agent 你有哪些 skills?',
    });

    now = 332;
    await app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: '我可以写代码、查日志和整理计划。',
    });

    now = 333;
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      body: '那你继续说说怎么做验证',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-2', agentId: 'agent-1', messageId: 'message-3' }],
      route: { kind: 'dispatch', agentId: 'agent-1' },
    });
  });

  test('sendMessage resolves non-task thread ownership outside the latest channel window', async () => {
    let now = 334;
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids: {
        nextId: createIds([
          'user-1',
          'team-1',
          'channel-1',
          'message-1',
          'dispatch-1',
          'request-1',
          'message-2',
          'message-3',
          'dispatch-2',
          'request-2',
        ]),
      },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-2',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Claude-Agent',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-2',
      lastSeenAt: now,
    });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Codex-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });

    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex-Agent 你有哪些 skills?',
    });

    now = 335;
    await app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: '我可以写代码、查日志和整理计划。',
    });

    for (let index = 0; index < 205; index += 1) {
      await repositories.messages.append({
        id: `unrelated-${index}`,
        teamId: 'team-1',
        channelId: 'channel-1',
        threadId: `unrelated-${index}`,
        senderKind: 'human',
        senderId: 'user-1',
        body: `unrelated channel message ${index}`,
        createdAt: 336 + index,
        meta: {},
      });
    }

    now = 542;
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      body: '那你继续说说怎么做验证',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-2', agentId: 'agent-1', messageId: 'message-3' }],
      route: { kind: 'dispatch', agentId: 'agent-1' },
    });
  });

  test('sendMessage does not dispatch unmentioned task replies assigned to a human', async () => {
    let now = 543;
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids: {
        nextId: createIds([
          'user-1',
          'team-1',
          'channel-1',
          'join-1',
          'user-2',
          'task-1',
          'message-2',
          'message-3',
          'message-4',
        ]),
      },
      joinCodes: { nextCode: createIds(['code-1']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'AgentBean', joinCode: 'code-1' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Codex-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });
    const taskAck = await app.createTask({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      title: '人工负责人任务',
      assigneeId: 'user-2',
    });
    if (!taskAck.ok) {
      throw new Error(`Expected task creation to succeed: ${taskAck.error}`);
    }
    await repositories.messages.append({
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: '这个任务由 lin 负责',
      createdAt: now,
      meta: { taskId: taskAck.task.id },
    });

    now = 544;
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      body: '继续跟进一下',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [],
      route: { kind: 'no-dispatch', reason: 'human-assignee' },
    });
  });

  test('sendMessage keeps lightweight capability questions as ordinary channel messages', async () => {
    const app = createInMemoryServerNext({
      now: () => 325,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      channelIds: ['channel-1'],
      name: 'Hermes-Agent',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 325,
    });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Hermes-Agent 你有哪些skills?',
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        threadId: 'message-1',
        meta: { routeReason: 'MENTION' },
      },
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1' }],
    });
    await expect(app.listTasks({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' })).resolves.toMatchObject({
      ok: true,
      tasks: [],
    });
  });

  test('convertMessageToTask links an existing channel message to a task', async () => {
    const app = createInMemoryServerNext({
      now: () => 315,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'task-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'turn this into work',
    });

    const ack = await app.convertMessageToTask({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'message-1',
    });

    expect(ack).toMatchObject({
      ok: true,
      task: {
        id: 'task-1',
        title: 'turn this into work',
        status: 'todo',
        channelId: 'channel-1',
        creatorId: 'user-1',
      },
      message: {
        id: 'message-1',
        meta: { taskId: 'task-1' },
      },
    });
    await expect(app.editMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'message-1',
      body: 'ordinary edit no longer applies',
    })).resolves.toMatchObject({ ok: false, error: 'CONFLICT' });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        {
          id: 'message-1',
          meta: { taskId: 'task-1' },
        },
      ],
    });
  });

  test('message task claim keeps convert-to-task idempotent', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.messages.append({
      id: 'message-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: 'message-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'turn this into one task',
      createdAt: 320,
      meta: {},
    });

    await expect(repositories.messages.setTaskIdIfAbsent({ messageId: 'message-1', taskId: 'task-1' })).resolves.toMatchObject({
      taskId: 'task-1',
      inserted: true,
      message: { meta: { taskId: 'task-1' } },
    });
    await expect(repositories.messages.setTaskIdIfAbsent({ messageId: 'message-1', taskId: 'task-2' })).resolves.toMatchObject({
      taskId: 'task-1',
      inserted: false,
      message: { meta: { taskId: 'task-1' } },
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

    const deleteAck = await app.deleteMessage({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'message-1',
    });
    expect(deleteAck).toMatchObject({
      ok: true,
      message: {
        id: 'message-1',
        body: '消息已删除',
      },
    });
    if (deleteAck.ok) {
      expect(deleteAck.message).not.toHaveProperty('artifacts');
    }

    const listAck = await app.listChannelMessages({ channelId: 'channel-1', limit: 10 });
    expect(listAck).toMatchObject({
      ok: true,
      messages: [{ id: 'message-1', body: '消息已删除' }],
    });
    if (listAck.ok) {
      expect(listAck.messages[0]).not.toHaveProperty('artifacts');
    }
  });

  test('listChannelMessages 投影进行中 dispatch 状态到对应消息（修复切页面/刷新后"正在处理"消失）', async () => {
    const app = createInMemoryServerNext({
      now: () => 330,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 330,
    });
    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex read this',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1' }],
    });
    // dispatch 尚未完成（agent 未 respond）。listChannelMessages 应把进行中 dispatch 状态投影到 message-1，
    // 使前端切频道/刷新后能恢复「正在处理」指示——dispatchStatus 不在 MessageRecord，靠此 enrich 投影。
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-1', dispatchId: 'dispatch-1', dispatchStatus: expect.stringMatching(/^(queued|sent|accepted|running)$/) },
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
      category: 'agentos-hosted',
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
      category: 'agentos-hosted',
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

  test('sendMessage marks the dispatched agent as busy', async () => {
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
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 400,
    });

    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'busy' }],
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
        'message-4',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
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
      message: {
        id: 'message-2',
        threadId: 'message-1',
        body: 'first reply',
        meta: { replyScope: 'channel' },
      },
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

    now = 413;
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-2',
      agentId: 'agent-1',
      body: 'thread reply',
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'message-4',
        threadId: 'message-1',
        meta: { parentMessageId: 'message-1', replyScope: 'thread' },
      },
    });

    await expect(app.snapshotDirectMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({
      ok: true,
      messages: [
        { id: 'message-1' },
        { id: 'message-2' },
        { id: 'message-3' },
        { id: 'message-4' },
      ],
    });
    await expect(app.snapshotDirectMessage({ userId: 'user-2', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({
      ok: false,
      error: 'FORBIDDEN',
    });
  });

  test('dispatch request includes scanned agent execution config without env ref', async () => {
    const app = createInMemoryServerNext({
      now: () => 410,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1', 'message-1', 'dispatch-1', 'request-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{
        name: 'Codex',
        adapterKind: 'codex',
        category: 'agentos-hosted',
        command: '/opt/homebrew/bin/codex',
        args: ['exec'],
        cwd: '/Users/shaw/AgentBean',
      }],
    });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', agentId: 'agent-1' }],
    });

    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-1' })).resolves.toMatchObject({
      ok: true,
      request: {
        id: 'dispatch-1',
        deviceId: 'device-1',
        customAgent: {
          id: 'agent-1',
          name: 'Codex',
          adapterKind: 'codex',
          command: '/opt/homebrew/bin/codex',
          args: ['exec'],
          cwd: '/Users/shaw/AgentBean',
        },
      },
    });
    const request = await app.getDispatchRequest({ dispatchId: 'dispatch-1' });
    expect(request.ok && request.request.customAgent?.envRef).toBeUndefined();
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
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      lastSeenAt: now,
    });
    await app.registerAgent({
      id: 'agent-2',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Claude',
      adapterKind: 'claude-code',
      category: 'agentos-hosted',
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

  test('cancelChannelDispatches cancels pending dispatches in a channel once', async () => {
    let now = 460;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1', 'team-1', 'channel-1',
        'message-1', 'dispatch-1', 'request-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      lastSeenAt: now,
    });
    const firstSend = await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex stop this channel',
    });
    expect(firstSend.ok ? firstSend.dispatches : []).toHaveLength(1);
    const firstDispatchId = firstSend.ok ? firstSend.dispatches[0]!.id : '';

    now = 480;
    await expect(app.cancelChannelDispatches({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [
        {
          id: firstDispatchId,
          channelId: 'channel-1',
          messageId: 'message-1',
          status: 'cancelled',
          completedAt: 480,
        },
      ],
    });
    await expect(app.receiveDispatchResult({
      dispatchId: firstDispatchId,
      agentId: 'agent-1',
      body: 'late cancelled reply',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
    });
    await expect(app.cancelChannelDispatches({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      dispatches: [],
    });
  });

  test('cancelDispatch clears busy back to online', async () => {
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
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 400,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });

    const ack = await app.cancelDispatch({ userId: 'user-1', dispatchId: 'dispatch-1' });

    expect(ack).toMatchObject({ ok: true, dispatch: { id: 'dispatch-1', status: 'cancelled' } });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'online' }],
    });
  });

  test('cancelDispatch does not revive an offline agent', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'offline',
      deviceId: 'device-1',
      lastSeenAt: 400,
    });
    await repositories.dispatches.create({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      status: 'queued',
      requestId: 'req-1',
      createdAt: 500,
      updatedAt: 500,
      prompt: 'hello',
    });

    await app.cancelDispatch({ userId: 'user-1', dispatchId: 'dispatch-1' });

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'offline' }],
    });
  });

  test('failTimedOutDispatches clears busy back to online on timeout', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 1000,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex hello',
    });

    const ack = await app.failTimedOutDispatches({ olderThan: 1001 });

    expect(ack).toMatchObject({ ok: true, dispatches: [{ id: 'dispatch-1', status: 'timed_out' }] });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'online' }],
    });
  });

  test('receiveDispatchResult accepts a late result after dispatch timeout and completes its task', async () => {
    let now = 1000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-1',
        'task-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'workspace-run-1',
        'reply-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex write a long article',
      asTask: true,
    });

    now = 1301;
    await expect(app.failTimedOutDispatches({ olderThan: 1300 })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', status: 'timed_out' }],
    });

    now = 1500;
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'late but complete',
      workspaceRun: {
        cwd: '/Users/shaw/longvideo',
        status: 'succeeded',
        exitCode: 0,
        startedAt: 1001,
        completedAt: 1500,
      },
    })).resolves.toMatchObject({
      ok: true,
      dispatch: { id: 'dispatch-1', status: 'succeeded', completedAt: 1500 },
      task: { id: 'task-1', status: 'in_review', updatedAt: 1500 },
      message: {
        id: 'reply-1',
        body: 'late but complete',
        workspaceRun: {
          id: 'workspace-run-1',
          status: 'succeeded',
        },
      },
    });
    await expect(app.getWorkspaceRunDetail({
      userId: 'user-1',
      teamId: 'team-1',
      runId: 'workspace-run-1',
    })).resolves.toMatchObject({
      ok: true,
      workspaceRun: {
        id: 'workspace-run-1',
        sourceMessageId: 'message-1',
      },
    });
    await expect(app.listTasks({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' })).resolves.toMatchObject({
      ok: true,
      tasks: [{ id: 'task-1', status: 'in_review' }],
    });
  });

  test('receiveDispatchResult keeps a failed late workspace run failed and leaves its task open', async () => {
    let now = 2000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-1',
        'task-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'workspace-run-1',
        'reply-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex write a long article',
      asTask: true,
    });

    now = 2301;
    await expect(app.failTimedOutDispatches({ olderThan: 2300 })).resolves.toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', status: 'timed_out' }],
    });

    now = 2500;
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'late and failed',
      workspaceRun: {
        cwd: '/Users/shaw/longvideo',
        status: 'failed',
        exitCode: 1,
        startedAt: 2001,
        completedAt: 2500,
      },
    })).resolves.toMatchObject({
      ok: true,
      dispatch: { id: 'dispatch-1', status: 'failed', error: 'WORKSPACE_RUN_FAILED', completedAt: 2500 },
      message: {
        id: 'reply-1',
        body: 'late and failed',
        workspaceRun: {
          id: 'workspace-run-1',
          status: 'failed',
        },
      },
    });
    await expect(app.listTasks({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1' })).resolves.toMatchObject({
      ok: true,
      tasks: [{ id: 'task-1', status: 'in_progress' }],
    });
  });

  test('receiveDispatchResult does not clear busy for a newer pending dispatch', async () => {
    let now = 3000;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'message-1',
        'dispatch-1',
        'request-1',
        'message-2',
        'dispatch-2',
        'request-2',
        'reply-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: now,
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex first long task',
    });

    now = 3301;
    await app.failTimedOutDispatches({ olderThan: 3300 });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex second task',
    });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'busy' }],
    });

    now = 3500;
    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'first task eventually succeeded',
    })).resolves.toMatchObject({
      ok: true,
      dispatch: { id: 'dispatch-1', status: 'succeeded' },
    });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'busy' }],
    });
  });

  test('failTimedOutDispatches does not revive an offline agent', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 2000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'offline',
      deviceId: 'device-1',
      lastSeenAt: 400,
    });
    await repositories.dispatches.create({
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      status: 'queued',
      requestId: 'req-1',
      createdAt: 500,
      updatedAt: 500,
      prompt: 'hello',
    });

    await app.failTimedOutDispatches({ olderThan: 1000 });

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'offline' }],
    });
  });

  test('receiveDispatchResult links uploaded artifact ids without clearing storage path', async () => {
    const app = createInMemoryServerNext({
      now: () => 465,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'artifact-1',
        'message-1',
        'dispatch-1',
        'request-1',
        'workspace-run-1',
        'reply-1',
      ]),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.registerAgent({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      lastSeenAt: 465,
    });
    await app.uploadArtifact({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'result.png',
      mimeType: 'image/png',
      sizeBytes: 12,
      storagePath: 'artifacts/team-1/artifact-1/result.png',
      relativePath: 'outputs/result.png',
      sha256: 'sha-result',
    });
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex render',
    });

    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'done',
      artifactIds: ['artifact-1'],
      workspaceRun: {
        cwd: '/tmp/agentbean',
        exitCode: 0,
        startedAt: 450,
        completedAt: 465,
      },
    })).resolves.toMatchObject({
      ok: true,
      message: {
        id: 'reply-1',
        meta: { artifactIds: ['artifact-1'], workspaceRunId: 'workspace-run-1' },
        artifacts: [
          {
            id: 'artifact-1',
            messageId: 'reply-1',
            dispatchId: 'dispatch-1',
            workspaceRunId: 'workspace-run-1',
            pathKind: 'generated',
          },
        ],
        workspaceRun: {
          id: 'workspace-run-1',
          artifactIds: ['artifact-1'],
        },
      },
    });
    await expect(app.getArtifactFile({
      userId: 'user-1',
      teamId: 'team-1',
      artifactId: 'artifact-1',
    })).resolves.toMatchObject({
      ok: true,
      storagePath: 'artifacts/team-1/artifact-1/result.png',
    });
    await expect(app.getWorkspaceRunDetail({
      userId: 'user-1',
      teamId: 'team-1',
      runId: 'workspace-run-1',
    })).resolves.toMatchObject({
      ok: true,
      workspaceRun: {
        id: 'workspace-run-1',
        messageId: 'reply-1',
        sourceMessageId: 'message-1',
      },
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
      category: 'agentos-hosted',
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
      category: 'agentos-hosted',
      source: 'scanned',
      status: 'online',
      deviceId: 'device-1',
      lastSeenAt: 500,
    });

    await expect(app.listDevices({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      devices: [
        {
          id: 'device-1',
          ownerId: 'user-1',
          ownerName: 'shaw',
        },
      ],
    });
    await expect(app.getDevice({ userId: 'user-1', deviceId: 'device-1' })).resolves.toMatchObject({
      ok: true,
      device: {
        id: 'device-1',
        teamId: 'team-1',
        ownerId: 'user-1',
        ownerName: 'shaw',
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
        'message-2',
        'dispatch-2',
        'request-2',
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
          envRef: { agentId: 'agent-1', teamId: 'team-1' },
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

  test('revives custom agents to online when their device reconnects via deviceHello', async () => {
    let now = 700;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-1',
        'runtime-1',
        'agent-1',
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
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'mindmap-ppt',
    });

    // 设备掉线：级联把该设备托管的 custom agent 拉成 offline（markDeviceAndHostedAgentsOffline）
    now = 800;
    await app.markDeviceOffline({ deviceId: 'device-1', timestamp: now });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'offline' }],
    });

    // 设备重连：deviceHello 让 device 重新 online，理应同时恢复其托管的 custom agent
    now = 900;
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'shaw-mbp',
    });

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'online' }],
    });
  });

  test('deviceHello preserves a busy custom agent (does not clobber busy to online on reconnect)', async () => {
    // Socket-flap race：device 未经历完整 offline→cascade，或 hello 在 cascade 跑完前重发。
    // 此前 deviceHello 的 custom-agent 恢复循环只跳过 online，会把 busy 误恢复成 online。
    let now = 950;
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => now },
      ids: {
        nextId: createIds([
          'user-1',
          'team-1',
          'channel-1',
          'device-1',
          'runtime-1',
          'agent-1',
        ]),
      },
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
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'mindmap-ppt',
    });

    // 直接把 custom agent 置为 busy（模拟 dispatching 中或任何非掉线导致的 busy 态）
    now = 1000;
    await repositories.agents.updateStatus({
      agentId: 'agent-1',
      status: 'busy',
      lastSeenAt: now,
    });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'busy' }],
    });

    // hello 重发：恢复循环必须跳过 busy（busy 在线，无需恢复）
    now = 1100;
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'shaw-mbp',
    });

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: [{ id: 'agent-1', status: 'busy' }],
    });
  });

  test('deviceHello revives custom agents but leaves scanned agents for registerDiscoveredAgents', async () => {
    let now = 750;
    const app = createInMemoryServerNext({
      now: () => now,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1', 'agent-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'MacBook Pro',
    });
    // scanned agent (agent-1) —— 由 daemon 扫描上报，其在线语义绑定到 registerDiscoveredAgents
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [
        {
          name: 'Hermes Gateway',
          adapterKind: 'hermes',
          category: 'agentos-hosted',
          command: '/usr/local/bin/hermes',
        },
      ],
    });
    // custom agent (agent-2) —— 用户声明，其在线语义绑定到所驻留 device
    await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      name: 'mindmap-ppt',
      adapterKind: 'codex',
      command: '/usr/local/bin/codex',
    });

    // 设备掉线：scanned 与 custom 都被级联成 offline
    now = 800;
    await app.markDeviceOffline({ deviceId: 'device-1', timestamp: now });
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: expect.arrayContaining([
        expect.objectContaining({ id: 'agent-1', status: 'offline' }),
        expect.objectContaining({ id: 'agent-2', status: 'offline' }),
      ]),
    });

    // 设备重连：custom 恢复 online；scanned 必须保持 offline，等待 daemon 重新 registerDiscoveredAgents
    now = 900;
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'default',
      hostname: 'MacBook Pro',
    });

    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
      ok: true,
      agents: expect.arrayContaining([
        expect.objectContaining({ id: 'agent-1', status: 'offline' }),
        expect.objectContaining({ id: 'agent-2', status: 'online' }),
      ]),
    });
  });

  test('returns custom agent env only to the bound device token', async () => {
    const app = createInMemoryServerNext({
      now: () => 610,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'device-invite-1',
        'device-1',
        'runtime-1',
        'agent-1',
        'user-2',
        'team-2',
        'channel-2',
        'device-invite-2',
        'device-2',
      ]),
      deviceInviteCodes: createIds(['device-code-1', 'device-code-2']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createDeviceInvite({ userId: 'user-1', teamId: 'team-1', profileId: 'agentbean-next' });
    await app.waitForDeviceInvite({
      code: 'device-code-1',
      profileId: 'agentbean-next',
      hostname: 'shaw-mbp',
    });
    const completed = await app.completeDeviceInvite({
      userId: 'user-1',
      code: 'device-code-1',
      serverUrl: 'http://127.0.0.1:4000',
    });
    if (!completed.ok) {
      throw new Error('device invite completion failed');
    }
    const hello = await app.deviceHelloFromCredentials({
      token: completed.credentials.token,
      machineId: completed.credentials.machineId,
      profileId: completed.credentials.profileId,
      hostname: completed.credentials.hostname,
    });
    expect(hello).toMatchObject({
      ok: true,
      credentials: {
        token: expect.stringMatching(/^abn_device\./),
        teamId: 'team-1',
        ownerId: 'user-1',
        deviceId: 'device-1',
      },
    });
    if (!hello.ok || !hello.credentials) {
      throw new Error('device hello did not issue refreshed credentials');
    }
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
      env: { OPENAI_API_KEY: 'secret-value' },
    });

    await expect(
      app.getAgentEnvForDevice({
        token: completed.credentials.token,
        teamId: 'team-1',
        agentId: 'agent-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'UNAUTHENTICATED',
    });
    await expect(
      app.getAgentEnvForDevice({
        token: hello.credentials.token,
        teamId: 'team-1',
        agentId: 'agent-1',
      }),
    ).resolves.toEqual({
      ok: true,
      env: { OPENAI_API_KEY: 'secret-value' },
    });

    await expect(
      app.getAgentEnvForDevice({
        token: hello.credentials.token,
        teamId: 'team-1',
        agentId: 'missing-agent',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'NOT_FOUND',
    });

    await app.registerUser({ username: 'outsider', password: 'secret', teamName: 'Other' });
    await app.createDeviceInvite({ userId: 'user-2', teamId: 'team-2', profileId: 'agentbean-next' });
    await app.waitForDeviceInvite({
      code: 'device-code-2',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'shaw-mbp',
    });
    const outsiderCompleted = await app.completeDeviceInvite({
      userId: 'user-2',
      code: 'device-code-2',
      serverUrl: 'http://127.0.0.1:4000',
    });
    if (!outsiderCompleted.ok) {
      throw new Error('outsider device invite completion failed');
    }
    await app.deviceHelloFromCredentials({
      token: outsiderCompleted.credentials.token,
      machineId: outsiderCompleted.credentials.machineId,
      profileId: outsiderCompleted.credentials.profileId,
      hostname: outsiderCompleted.credentials.hostname,
    });

    await expect(
      app.getAgentEnvForDevice({
        token: outsiderCompleted.credentials.token,
        teamId: 'team-1',
        agentId: 'agent-1',
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: 'UNAUTHENTICATED',
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
        'message-2',
        'dispatch-2',
        'request-2',
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

    const updateAck = await app.updateAgentConfig({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Renamed Codex',
      description: 'Updated custom agent',
      args: ['--model', 'gpt-5.4'],
      env: { OPENAI_API_KEY: 'new-secret' },
      currentDeviceId: 'device-1',
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
          envRef: { agentId: 'agent-1', teamId: 'team-1' },
        },
      },
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
      ids: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'user-2', 'team-2', 'channel-2', 'device-invite-1', 'device-1']),
      joinCodes: createIds(['join-code-1']),
      deviceInviteCodes: createIds(['device-code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Private', joinCode: 'join-code-1' });

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

    await expect(app.completeDeviceInvite({ userId: 'user-2', code: 'device-code-1' })).resolves.toMatchObject({
      ok: false,
      error: 'INVITE_ALREADY_USED',
    });
    await expect(app.completeDeviceInvite({ userId: 'user-1', code: 'device-code-1' })).resolves.toMatchObject({
      ok: true,
      credentials: {
        token: expect.stringMatching(/^abn_device\./),
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'agentbean-next',
      },
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
    // 该 agent 仅用于触发 deleteAgent 对「非 custom」source 的 VALIDATION_ERROR 校验，
    // 故必须是 agentos-hosted（scanned 源）；executor-hosted 自 Task 2 起不入库 agents 表。
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{ adapterKind: 'claude-code', name: 'Scanned Claude', category: 'agentos-hosted' }],
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

  test('lets a device owner rename a scanned AgentOS agent while preserving its runtime config', async () => {
    const app = createInMemoryServerNext({
      now: () => 730,
      ids: createIds([
        'user-1',
        'team-1',
        'channel-1',
        'join-1',
        'user-2',
        'team-2',
        'channel-2',
        'device-1',
        'agent-1',
      ]),
      joinCodes: createIds(['code-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
    await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Private', joinCode: 'code-1' });
    await app.deviceHello({
      teamId: 'team-1',
      ownerId: 'user-2',
      machineId: 'machine-1',
      profileId: 'default',
    });
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId: 'device-1',
      agents: [{
        adapterKind: 'hermes',
        name: 'Hermes-Agent',
        category: 'agentos-hosted',
        command: '/opt/homebrew/bin/hermes',
        args: ['gateway', 'run'],
        cwd: '/Users/shaw',
        discoverySource: 'gateway',
      }],
    });

    await expect(app.updateAgentConfig({
      userId: 'user-2',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Hermes-Renamed',
      description: 'Local Hermes gateway',
      command: '/tmp/should-not-replace-hermes',
      cwd: '/tmp/should-not-replace-cwd',
      env: { SHOULD_NOT: 'persist' },
    })).resolves.toMatchObject({
      ok: true,
      agent: {
        id: 'agent-1',
        name: 'Hermes-Renamed',
        description: 'Local Hermes gateway',
        command: '/opt/homebrew/bin/hermes',
        args: ['gateway', 'run'],
        cwd: '/Users/shaw',
        source: 'scanned',
        category: 'agentos-hosted',
      },
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
