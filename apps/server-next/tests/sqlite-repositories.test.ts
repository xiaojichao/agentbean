import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories';

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };

const requireFromWorkspace = createRequire(import.meta.url);
const Database = loadBetterSqlite3();

describe('server-next SQLite repositories', () => {
  test('applies executable first-slice migrations to global and team databases', () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      expect(tableNames(globalDb)).toEqual(
        expect.arrayContaining([
          'users',
          'teams',
          'team_members',
          'devices',
          'device_runtimes',
          'agents',
          'agent_identity_links',
          'agent_publications',
          'join_links',
          'device_invites',
        ]),
      );
      expect(tableNames(teamDb)).toEqual(
        expect.arrayContaining([
          'channels',
          'channel_human_members',
          'channel_agent_members',
          'messages',
          'dispatches',
          'artifacts',
          'workspace_runs',
        ]),
      );
    } finally {
      close();
    }
  });

  test('applies device invite migration after an existing first-slice SQLite database', () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      globalDb.prepare("DELETE FROM schema_migrations WHERE id = 'global/0002_device_invites.sql'").run();
      globalDb.prepare('DROP TABLE device_invites').run();

      applyGlobalMigrations(globalDb);

      expect(tableNames(globalDb)).toEqual(expect.arrayContaining(['device_invites']));
      expect(globalDb.prepare("SELECT id FROM schema_migrations WHERE id = 'global/0002_device_invites.sql'").get()).toEqual({
        id: 'global/0002_device_invites.sql',
      });
    } finally {
      teamDb.exec('SELECT 1');
      close();
    }
  });

  test('applies agent delete metadata migration', () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const agentColumns = columnNames(globalDb, 'agents');
      expect(agentColumns).toContain('deleted_at');
      expect(globalDb.prepare("SELECT id FROM schema_migrations WHERE id = 'global/0003_agent_deleted_at.sql'").get()).toEqual({
        id: 'global/0003_agent_deleted_at.sql',
      });
    } finally {
      teamDb.exec('SELECT 1');
      close();
    }
  });

  test('persists user join links and consumes them with SQLite', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 900 },
        ids: {
          nextId: createIds(['user-1', 'team-1', 'channel-1', 'join-1', 'user-2', 'team-2', 'channel-2']),
        },
        joinCodes: {
          nextCode: createIds(['code-1']),
        },
      });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

      await expect(app.createJoinLink({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
        ok: true,
        link: { id: 'join-1', code: 'code-1', teamId: 'team-1', usesCount: 0, maxUses: 1 },
      });
      expect(globalDb.prepare('SELECT code, team_id AS teamId, uses_count AS usesCount FROM join_links WHERE code = ?').get('code-1')).toEqual({
        code: 'code-1',
        teamId: 'team-1',
        usesCount: 0,
      });

      await expect(
        app.registerUser({
          username: 'lin',
          password: 'secret',
          teamName: 'Lin Private',
          joinCode: 'code-1',
        }),
      ).resolves.toMatchObject({
        ok: true,
        currentTeam: { id: 'team-1', currentUserRole: 'member' },
        joinedTeam: { id: 'team-1', currentUserRole: 'member' },
      });
      expect(globalDb.prepare('SELECT role FROM team_members WHERE team_id = ? AND user_id = ?').get('team-1', 'user-2')).toEqual({
        role: 'member',
      });
      expect(globalDb.prepare('SELECT uses_count AS usesCount FROM join_links WHERE code = ?').get('code-1')).toEqual({
        usesCount: 1,
      });
      expect(globalDb.prepare('SELECT current_team_id AS currentTeamId FROM users WHERE id = ?').get('user-2')).toEqual({
        currentTeamId: 'team-1',
      });
      await expect(repositories.joinLinks.incrementUses('code-1')).resolves.toBeNull();
      expect(globalDb.prepare('SELECT uses_count AS usesCount FROM join_links WHERE code = ?').get('code-1')).toEqual({
        usesCount: 1,
      });
    } finally {
      close();
    }
  });

  test('persists device invites and completes daemon onboarding with SQLite', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 910 },
        ids: {
          nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-invite-1', 'device-1']),
        },
        deviceInviteCodes: {
          nextCode: createIds(['device-code-1']),
        },
      });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

      await expect(
        app.createDeviceInvite({ userId: 'user-1', teamId: 'team-1', profileId: 'agentbean-next' }),
      ).resolves.toMatchObject({
        ok: true,
        invite: { id: 'device-invite-1', code: 'device-code-1', teamId: 'team-1' },
      });
      expect(
        globalDb
          .prepare('SELECT code, team_id AS teamId, profile_id AS profileId FROM device_invites WHERE code = ?')
          .get('device-code-1'),
      ).toEqual({
        code: 'device-code-1',
        teamId: 'team-1',
        profileId: 'agentbean-next',
      });

      await app.waitForDeviceInvite({ code: 'device-code-1', machineId: 'machine-1', hostname: 'shaw-mbp' });
      const completed = await app.completeDeviceInvite({ userId: 'user-1', code: 'device-code-1' });
      expect(completed).toMatchObject({
        ok: true,
        credentials: {
          token: expect.stringMatching(/^abn_device\./),
          teamId: 'team-1',
          ownerId: 'user-1',
          machineId: 'machine-1',
          profileId: 'agentbean-next',
          hostname: 'shaw-mbp',
        },
      });
      if (!completed.ok) {
        throw new Error('device invite completion failed');
      }
      expect(globalDb.prepare('SELECT completed_at AS completedAt FROM device_invites WHERE code = ?').get('device-code-1')).toEqual({
        completedAt: 910,
      });
      await expect(app.deviceHelloFromCredentials({ token: completed.credentials.token })).resolves.toMatchObject({
        ok: true,
        device: { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', name: 'shaw-mbp' },
      });
    } finally {
      close();
    }
  });

  test('persists register, login, message, and dispatch use cases with SQLite', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 500 },
        ids: {
          nextId: createIds(['user-1', 'team-1', 'channel-1', 'channel-ops', 'message-1', 'dispatch-1', 'request-1']),
        },
      });

      await expect(
        app.registerUser({ username: 'Shaw', password: 'secret', teamName: 'AgentBean' }),
      ).resolves.toMatchObject({
        ok: true,
        user: { id: 'user-1', username: 'shaw', primaryTeamId: 'team-1' },
        currentTeam: { id: 'team-1', path: 'agentbean', currentUserRole: 'owner' },
        defaultChannel: { id: 'channel-1', name: 'all' },
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
        lastSeenAt: 500,
      });
      await repositories.users.create({
        id: 'user-2',
        username: 'teammate',
        role: 'user',
        passwordHash: 'unused',
        createdAt: 500,
        updatedAt: 500,
      });
      await repositories.teams.addMember({
        teamId: 'team-1',
        userId: 'user-2',
        username: 'teammate',
        role: 'member',
        joinedAt: 500,
      });

      await expect(app.loginUser({ username: 'shaw', password: 'secret' })).resolves.toMatchObject({
        ok: true,
        currentTeam: { id: 'team-1', currentUserRole: 'owner' },
      });
      await expect(app.listChannels({ teamId: 'team-1', userId: 'user-1' })).resolves.toMatchObject({
        ok: true,
        channels: [{ id: 'channel-1', visibility: 'public' }],
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
        channel: { id: 'channel-ops', visibility: 'private', createdBy: 'user-1' },
      });
      await expect(
        app.updateChannel({
          userId: 'user-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          title: 'Team-wide updates',
        }),
      ).resolves.toMatchObject({
        ok: true,
        channel: { id: 'channel-1', name: 'all', title: 'Team-wide updates' },
      });
      await expect(
        app.sendMessage({
          userId: 'user-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          body: '@Codex hello',
          senderId: 'client-spoof',
          senderKind: 'agent',
        }),
      ).resolves.toMatchObject({
        ok: true,
        message: { id: 'message-1', senderKind: 'human', senderId: 'user-1' },
        dispatches: [{ id: 'dispatch-1', requestId: 'request-1', agentId: 'agent-1' }],
      });

      expect(globalDb.prepare('SELECT current_team_id AS currentTeamId FROM users WHERE id = ?').get('user-1')).toEqual({
        currentTeamId: 'team-1',
      });
      expect(teamDb.prepare('SELECT user_id AS userId FROM channel_human_members WHERE channel_id = ?').get('channel-1')).toEqual({
        userId: 'user-1',
      });
      expect(teamDb.prepare('SELECT description AS title FROM channels WHERE id = ?').get('channel-1')).toEqual({
        title: 'Team-wide updates',
      });
      expect(teamDb.prepare('SELECT user_id AS userId FROM channel_human_members WHERE channel_id = ?').get('channel-ops')).toEqual({
        userId: 'user-1',
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
        channel: { humanMemberIds: ['user-1', 'user-2'] },
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
        channel: { agentMemberIds: ['agent-1'] },
      });
      await expect(
        app.listChannelMembers({
          userId: 'user-2',
          teamId: 'team-1',
          channelId: 'channel-ops',
        }),
      ).resolves.toMatchObject({
        ok: true,
        humanMemberIds: ['user-1', 'user-2'],
        agentMemberIds: ['agent-1'],
        humans: [
          { userId: 'user-1', username: 'shaw', role: 'owner' },
          { userId: 'user-2', username: 'teammate', role: 'member' },
        ],
        agents: [{ id: 'agent-1', name: 'Codex', status: 'online' }],
      });
      await app.removeChannelHumanMember({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        memberUserId: 'user-2',
      });
      await app.removeChannelAgentMember({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        agentId: 'agent-1',
      });
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM channel_human_members WHERE channel_id = ? AND user_id = ?').get('channel-ops', 'user-2')).toEqual({
        count: 0,
      });
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM channel_agent_members WHERE channel_id = ? AND agent_id = ?').get('channel-ops', 'agent-1')).toEqual({
        count: 0,
      });
      expect(teamDb.prepare('SELECT sender_kind AS senderKind, sender_id AS senderId FROM messages WHERE id = ?').get('message-1')).toEqual({
        senderKind: 'human',
        senderId: 'user-1',
      });
    } finally {
      close();
    }
  });

  test('persists direct messages and thread ids with SQLite', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 520 },
        ids: {
          nextId: createIds([
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
        },
      });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await repositories.agents.upsert({
        id: 'agent-1',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'Codex',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'scanned',
        status: 'online',
        lastSeenAt: 520,
      });

      await expect(app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' })).resolves.toMatchObject({
        ok: true,
        dm: { channel: { id: 'dm-1', kind: 'direct', dmTargetAgentId: 'agent-1' } },
      });
      expect(teamDb.prepare('SELECT dm_target_agent_id AS dmTargetAgentId FROM channels WHERE id = ?').get('dm-1')).toEqual({
        dmTargetAgentId: 'agent-1',
      });

      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1', body: 'hello' });
      await app.receiveDispatchResult({ dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'reply' });
      await app.sendMessage({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'dm-1',
        threadId: 'message-1',
        body: 'follow up',
      });

      expect(teamDb.prepare('SELECT thread_id AS threadId FROM messages WHERE id = ?').get('message-3')).toEqual({
        threadId: 'message-1',
      });
      await expect(app.getDispatchRequest({ dispatchId: 'dispatch-2' })).resolves.toMatchObject({
        ok: true,
        request: {
          threadId: 'message-1',
          history: [
            { messageId: 'message-1', body: 'hello' },
            { messageId: 'message-2', body: 'reply' },
          ],
        },
      });
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM users').get()).toEqual({ count: 1 });
    } finally {
      close();
    }
  });

  test('marks stale queued dispatches as timed out without deleting the original message', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 1000 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1']) },
      });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await repositories.agents.upsert({
        id: 'agent-1',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'Codex',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'scanned',
        status: 'online',
        lastSeenAt: 1000,
      });
      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });

      await expect(app.failTimedOutDispatches({ olderThan: 1001 })).resolves.toMatchObject({
        ok: true,
        dispatches: [{ id: 'dispatch-1', status: 'timed_out', error: 'DISPATCH_TIMEOUT' }],
      });
      expect(teamDb.prepare('SELECT body FROM messages WHERE id = ?').get('message-1')).toEqual({ body: '@Codex hello' });
    } finally {
      close();
    }
  });

  test('reconciles device hello, replaces runtimes, and dedupes discovered agents', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 700 },
        ids: {
          nextId: createIds([
            'user-1',
            'team-1',
            'channel-1',
            'device-1',
            'runtime-1',
            'runtime-2',
            'runtime-3',
            'agent-1',
          ]),
        },
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });

      await expect(
        app.deviceHello({
          teamId: 'team-1',
          ownerId: 'user-1',
          machineId: 'machine-1',
          profileId: 'default',
          hostname: 'First Host',
        }),
      ).resolves.toMatchObject({
        ok: true,
        device: { id: 'device-1', teamId: 'team-1', ownerId: 'user-1', status: 'online' },
      });
      await expect(
        app.deviceHello({
          teamId: 'team-1',
          ownerId: 'user-1',
          machineId: 'machine-1',
          profileId: 'default',
          hostname: 'Renamed Host',
        }),
      ).resolves.toMatchObject({
        ok: true,
        device: { id: 'device-1', name: 'Renamed Host' },
      });
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM devices').get()).toEqual({ count: 1 });

      await expect(
        app.reportDeviceRuntimes({
          teamId: 'team-1',
          deviceId: 'device-1',
          runtimes: [
            {
              adapterKind: 'codex-cli',
              name: 'Codex CLI',
              command: '/Applications/Codex',
              cwd: '/Work/AgentBean/',
              version: '1.0.0',
            },
            {
              adapterKind: 'claude',
              name: 'Claude Code',
              command: '/Applications/Claude',
            },
          ],
        }),
      ).resolves.toMatchObject({
        ok: true,
        runtimes: [
          {
            id: 'runtime-1',
            adapterKind: 'codex',
            name: 'Codex CLI',
            installed: true,
            command: '/Applications/Codex',
            cwd: '/Work/AgentBean/',
            normalizedCommandKey: '/Applications/Codex',
            normalizedCwdKey: '/Work/AgentBean',
          },
          { id: 'runtime-2', adapterKind: 'claude-code', name: 'Claude Code', installed: true },
        ],
      });
      await app.reportDeviceRuntimes({
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI', command: '/Applications/Codex' }],
      });
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM device_runtimes WHERE device_id = ?').get('device-1')).toEqual({
        count: 1,
      });

      await expect(
        app.registerDiscoveredAgents({
          teamId: 'team-1',
          deviceId: 'device-1',
          agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
        }),
      ).resolves.toMatchObject({
        ok: true,
        agents: [{ id: 'agent-1', adapterKind: 'codex', name: 'Codex', status: 'online' }],
        missingOfflineIds: [],
      });
      await expect(
        app.registerDiscoveredAgents({
          teamId: 'team-1',
          deviceId: 'device-1',
          agents: [{ name: 'codex', adapterKind: 'codex', category: 'executor-hosted' }],
        }),
      ).resolves.toMatchObject({
        ok: true,
        agents: [{ id: 'agent-1', name: 'codex' }],
      });
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM agents').get()).toEqual({ count: 1 });
      expect(globalDb.prepare('SELECT agent_id AS agentId FROM agent_identity_links').get()).toEqual({
        agentId: 'agent-1',
      });

      await expect(
        app.registerDiscoveredAgents({ teamId: 'team-1', deviceId: 'device-1', agents: [] }),
      ).resolves.toMatchObject({
        ok: true,
        agents: [],
        missingOfflineIds: ['agent-1'],
      });
      await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
        ok: true,
        agents: [{ id: 'agent-1', status: 'offline' }],
      });
    } finally {
      close();
    }
  });

  test('persists dispatch result as an agent message and succeeded dispatch', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 900 },
        ids: {
          nextId: createIds([
            'user-1',
            'team-1',
            'channel-1',
            'device-1',
            'agent-1',
            'message-1',
            'dispatch-1',
            'request-1',
            'reply-1',
          ]),
        },
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
      await app.registerDiscoveredAgents({
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex', category: 'executor-hosted' }],
      });
      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });

      await expect(
        app.receiveDispatchResult({
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          body: 'done',
          artifactIds: ['artifact-1'],
        }),
      ).resolves.toMatchObject({
        ok: true,
        dispatch: { id: 'dispatch-1', status: 'succeeded', completedAt: 900 },
        message: { id: 'reply-1', senderKind: 'agent', senderId: 'agent-1', body: 'done' },
      });

      expect(teamDb.prepare('SELECT status, completed_at AS completedAt FROM dispatches WHERE id = ?').get('dispatch-1')).toEqual({
        status: 'succeeded',
        completedAt: 900,
      });
      expect(
        teamDb
          .prepare('SELECT sender_kind AS senderKind, sender_id AS senderId, body, meta_json AS metaJson FROM messages WHERE id = ?')
          .get('reply-1'),
      ).toEqual({
        senderKind: 'agent',
        senderId: 'agent-1',
        body: 'done',
        metaJson: JSON.stringify({ dispatchId: 'dispatch-1', artifactIds: ['artifact-1'] }),
      });
    } finally {
      close();
    }
  });

  test('associates daemon-reported artifacts and workspace runs with team-scoped dispatch replies', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 1200 },
        ids: {
          nextId: createIds([
            'user-1',
            'team-1',
            'channel-1',
            'device-1',
            'agent-1',
            'message-1',
            'dispatch-1',
            'request-1',
            'user-2',
            'team-2',
            'channel-2',
            'workspace-run-1',
            'reply-1',
          ]),
        },
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
      await app.registerDiscoveredAgents({
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex', category: 'executor-hosted' }],
      });
      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex produce docs' });
      await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team' });

      await expect(
        app.receiveDispatchResult({
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          body: 'done',
          artifacts: [
            {
              id: 'artifact-1',
              filename: 'result.md',
              mimeType: 'text/markdown',
              sizeBytes: 128,
              storagePath: 'artifacts/artifact-1/result.md',
              relativePath: 'outputs/result.md',
              pathKind: 'workspace',
              sha256: 'sha256-result',
            },
          ],
          workspaceRun: {
            cwd: '/Users/shaw/AgentBean',
            exitCode: 0,
            startedAt: 1190,
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        message: {
          id: 'reply-1',
          artifacts: [
            {
              id: 'artifact-1',
              filename: 'result.md',
              downloadUrl: '/api/teams/team-1/artifacts/artifact-1/download',
              previewUrl: '/api/teams/team-1/artifacts/artifact-1/preview',
              workspaceRunId: 'workspace-run-1',
            },
          ],
          workspaceRun: {
            id: 'workspace-run-1',
            agentId: 'agent-1',
            deviceId: 'device-1',
            dispatchId: 'dispatch-1',
            artifactIds: ['artifact-1'],
          },
        },
      });

      await expect(app.getArtifact({ userId: 'user-1', teamId: 'team-1', artifactId: 'artifact-1' })).resolves.toMatchObject({
        ok: true,
        artifact: { id: 'artifact-1', teamId: 'team-1', messageId: 'reply-1' },
      });
      await expect(app.getArtifact({ userId: 'user-2', teamId: 'team-2', artifactId: 'artifact-1' })).resolves.toMatchObject({
        ok: false,
        error: 'NOT_FOUND',
      });
      await expect(app.getWorkspaceRun({ userId: 'user-1', teamId: 'team-1', runId: 'workspace-run-1' })).resolves.toMatchObject({
        ok: true,
        workspaceRun: {
          id: 'workspace-run-1',
          teamId: 'team-1',
          channelId: 'channel-1',
          messageId: 'reply-1',
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          deviceId: 'device-1',
          artifactIds: ['artifact-1'],
        },
      });

      expect(teamDb.prepare('SELECT team_id AS teamId, message_id AS messageId FROM artifacts WHERE id = ?').get('artifact-1')).toEqual({
        teamId: 'team-1',
        messageId: 'reply-1',
      });
      expect(teamDb.prepare('SELECT agent_id AS agentId, device_id AS deviceId FROM workspace_runs WHERE id = ?').get('workspace-run-1')).toEqual({
        agentId: 'agent-1',
        deviceId: 'device-1',
      });
    } finally {
      close();
    }
  });

  test('records dispatch error without appending an agent reply', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 950 },
        ids: {
          nextId: createIds([
            'user-1',
            'team-1',
            'channel-1',
            'device-1',
            'agent-1',
            'message-1',
            'dispatch-1',
            'request-1',
          ]),
        },
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
      await app.registerDiscoveredAgents({
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex', category: 'executor-hosted' }],
      });
      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex hello' });

      await expect(
        app.receiveDispatchError({
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          error: 'executor failed',
        }),
      ).resolves.toMatchObject({
        ok: true,
        dispatch: { id: 'dispatch-1', status: 'failed', error: 'executor failed' },
      });

      expect(
        teamDb.prepare('SELECT status, error_message AS errorMessage, completed_at AS completedAt FROM dispatches WHERE id = ?').get('dispatch-1'),
      ).toEqual({
        status: 'failed',
        errorMessage: 'executor failed',
        completedAt: 950,
      });
      expect(teamDb.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender_kind = 'agent'").get()).toEqual({ count: 0 });
      expect(globalDb.prepare('SELECT status, last_error AS lastError FROM agents WHERE id = ?').get('agent-1')).toEqual({
        status: 'offline',
        lastError: 'executor failed',
      });
    } finally {
      close();
    }
  });

  test('persists custom agent management without deleting message or dispatch history', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 940 },
        ids: {
          nextId: createIds([
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
        },
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.createTeam({ userId: 'user-1', name: 'Client Team' });
      await app.switchTeam({ userId: 'user-1', teamId: 'team-1' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
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
      await app.publishAgent({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', targetTeamId: 'team-2' });
      await app.updateAgentConfig({
        userId: 'user-1',
        teamId: 'team-1',
        agentId: 'agent-1',
        name: 'Renamed Codex',
        env: { OPENAI_API_KEY: 'new-secret' },
      });
      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'hello from renamed config' });
      await app.deleteAgent({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });

      await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({ ok: true, agents: [] });
      await expect(app.listVisibleAgents({ teamId: 'team-2' })).resolves.toMatchObject({ ok: true, agents: [] });
      expect(globalDb.prepare('SELECT deleted_at AS deletedAt, env_json AS envJson FROM agents WHERE id = ?').get('agent-1')).toEqual({
        deletedAt: 940,
        envJson: null,
      });
      expect(globalDb.prepare('SELECT COUNT(*) AS count FROM agent_publications WHERE agent_id = ?').get('agent-1')).toEqual({ count: 0 });
      expect(teamDb.prepare('SELECT body FROM messages WHERE id = ?').get('message-1')).toEqual({
        body: 'hello from renamed config',
      });
      expect(teamDb.prepare('SELECT agent_id AS agentId, status FROM dispatches WHERE id = ?').get('dispatch-1')).toEqual({
        agentId: 'agent-1',
        status: 'queued',
      });
    } finally {
      close();
    }
  });
});

function openMigratedDatabases() {
  const globalDb = new Database(':memory:');
  const teamDb = new Database(':memory:');
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  return {
    globalDb,
    teamDb,
    close() {
      globalDb.close();
      teamDb.close();
    },
  };
}

function tableNames(db: SqliteDatabase): string[] {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

function columnNames(db: SqliteDatabase, tableName: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((row) => (row as { name: string }).name);
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

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const candidates = [
    () => requireFromWorkspace('better-sqlite3') as BetterSqlite3Constructor,
    () => {
      const requireFromServer = createRequire(new URL('../../server/package.json', import.meta.url));
      return requireFromServer('better-sqlite3') as BetterSqlite3Constructor;
    },
  ];

  for (const loadCandidate of candidates) {
    try {
      const Candidate = loadCandidate();
      const db = new Candidate(':memory:');
      db.close();
      return Candidate;
    } catch {
      // Try the next installed copy; native modules are ABI-specific.
    }
  }
  throw new Error('No compatible better-sqlite3 installation found for this Node.js runtime');
}
