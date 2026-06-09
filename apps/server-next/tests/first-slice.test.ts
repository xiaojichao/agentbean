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
