import { createRequire } from 'node:module';
import { describe, expect, test, vi } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases';
import type { WorkspaceRunRecord } from '../src/application/repositories';
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
          'message_reactions',
          'saved_messages',
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

  test('applies workspace run pagination index migration', () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      globalDb.exec('SELECT 1');
      expect(indexNames(teamDb, 'workspace_runs')).toContain('idx_workspace_runs_team_updated_id');
      expect(teamDb.prepare("SELECT id FROM schema_migrations WHERE id = 'team/0007_workspace_run_pagination_index.sql'").get()).toEqual({
        id: 'team/0007_workspace_run_pagination_index.sql',
      });
    } finally {
      close();
    }
  });

  test('recreates join_links on a drifted database missing the table (regression for INTERNAL_ERROR)', () => {
    const { globalDb, close } = openMigratedDatabases();
    try {
      // 模拟生产 schema 漂移：0001_first_slice.sql 在 join_links 加入前已应用，
      // 导致 schema_migrations 记录 0001 完成但 join_links 表缺失。
      globalDb.exec('DROP TABLE join_links');
      // 生产此前从未应用过 0004（本修复新增），回退到该状态
      globalDb
        .prepare('DELETE FROM schema_migrations WHERE id = ?')
        .run('global/0004_join_links.sql');
      expect(tableNames(globalDb)).not.toContain('join_links');

      // 模拟生产重启：重新应用 migrations
      applyGlobalMigrations(globalDb);

      // 修复后：新 migration 必须补建 join_links（CREATE TABLE IF NOT EXISTS）
      expect(tableNames(globalDb)).toContain('join_links');
      expect(columnNames(globalDb, 'join_links')).toEqual(
        expect.arrayContaining([
          'id',
          'code',
          'team_id',
          'created_by',
          'created_at',
          'expires_at',
          'max_uses',
          'uses_count',
          'revoked_at',
        ]),
      );
    } finally {
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
          nextId: createIds([
            'user-1',
            'team-1',
            'channel-1',
            'channel-ops',
            'message-1',
            'dispatch-1',
            'request-1',
            'task-public',
            'task-private',
          ]),
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
      await repositories.messages.append({
        id: 'message-search-public',
        teamId: 'team-1',
        channelId: 'channel-1',
        threadId: 'message-search-public',
        senderKind: 'human',
        senderId: 'user-1',
        body: 'public sqlite search',
        createdAt: 501,
      });
      await repositories.messages.append({
        id: 'message-search-private',
        teamId: 'team-1',
        channelId: 'channel-ops',
        threadId: 'message-search-private',
        senderKind: 'human',
        senderId: 'user-1',
        body: 'secret sqlite search',
        createdAt: 502,
      });
      const sqliteSearch = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'sqlite' });
      expect(sqliteSearch).toMatchObject({ ok: true });
      expect(sqliteSearch.messages).toHaveLength(2);
      expect(sqliteSearch.messages.map((message) => ({ id: message.id, body: message.body }))).toEqual(
        expect.arrayContaining([
          { id: 'message-search-public', body: 'public sqlite search' },
          { id: 'message-search-private', body: 'secret sqlite search' },
        ]),
      );
      await repositories.messages.append({
        id: 'message-search-old-phrase',
        teamId: 'team-1',
        channelId: 'channel-1',
        threadId: 'message-search-old-phrase',
        senderKind: 'human',
        senderId: 'user-1',
        body: 'alpha beta exact phrase',
        createdAt: 600,
      });
      for (let index = 0; index < 250; index += 1) {
        await repositories.messages.append({
          id: `message-search-new-scattered-${index}`,
          teamId: 'team-1',
          channelId: 'channel-1',
          threadId: `message-search-new-scattered-${index}`,
          senderKind: 'human',
          senderId: 'user-1',
          body: `alpha scattered filler ${index} beta`,
          createdAt: 700 + index,
        });
      }
      const sqliteRanking = await app.searchMessages({ userId: 'user-1', teamId: 'team-1', query: 'alpha beta' });
      expect(sqliteRanking).toMatchObject({ ok: true });
      expect(sqliteRanking.messages[0]).toMatchObject({
        id: 'message-search-old-phrase',
        body: 'alpha beta exact phrase',
      });
      await expect(app.searchMessages({ userId: 'user-2', teamId: 'team-1', query: 'sqlite' })).resolves.toMatchObject({
        ok: true,
        messages: [
          { id: 'message-search-public', body: 'public sqlite search' },
        ],
      });
      await expect(app.createTask({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        assigneeId: 'agent-1',
        title: 'SQLite task',
        tags: ['sqlite'],
      })).resolves.toMatchObject({
        ok: true,
        task: { id: 'task-public', title: 'SQLite task', assigneeId: 'agent-1', tags: ['sqlite'] },
      });
      await app.createTask({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-ops',
        title: 'Private SQLite task',
      });
      await expect(app.listTasks({ userId: 'user-2', teamId: 'team-1' })).resolves.toMatchObject({
        ok: true,
        tasks: [{ id: 'task-public' }],
      });
      await expect(app.updateTask({
        userId: 'user-2',
        teamId: 'team-1',
        taskId: 'task-public',
        status: 'done',
        assigneeId: null,
      })).resolves.toMatchObject({
        ok: true,
        task: { id: 'task-public', status: 'done', assigneeId: undefined },
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
      teamDb.prepare('DELETE FROM channel_agent_members WHERE channel_id = ?').run('dm-1');
      await expect(app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' })).resolves.toMatchObject({
        ok: true,
        dm: { channel: { id: 'dm-1', kind: 'direct', dmTargetAgentId: 'agent-1' } },
      });

      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1', body: 'hello' });
      await app.receiveDispatchResult({
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        body: 'reply',
        artifacts: [
          {
            id: 'artifact-1',
            filename: 'reply.md',
            mimeType: 'text/markdown',
            sizeBytes: 12,
            storagePath: 'artifacts/artifact-1/reply.md',
          },
        ],
      });
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
      await expect(app.snapshotDirectMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({
        ok: true,
        messages: [
          { id: 'message-1', body: 'hello' },
          { id: 'message-2', body: 'reply', artifacts: [{ id: 'artifact-1', filename: 'reply.md' }] },
          { id: 'message-3', body: 'follow up' },
        ],
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

  test('reconciles connected devices and hosted agents to offline after process restart', async () => {
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
          ]),
        },
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
        hostname: 'MacBook',
      });
      await app.registerDiscoveredAgents({
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      });

      await expect(app.reconcileDisconnectedDevices({ timestamp: 1200 })).resolves.toMatchObject({
        ok: true,
        devices: [{ id: 'device-1', status: 'offline' }],
        affectedTeamIds: ['team-1'],
      });
      await expect(app.listDevices({ teamId: 'team-1', userId: 'user-1' })).resolves.toMatchObject({
        ok: true,
        devices: [{ id: 'device-1', status: 'offline' }],
      });
      await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({
        ok: true,
        agents: [{ id: 'agent-1', status: 'offline', lastSeenAt: 1200 }],
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
            'artifact-1',
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
      await app.uploadArtifact({
        userId: 'user-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        filename: 'artifact.md',
        mimeType: 'text/markdown',
        sizeBytes: 12,
        storagePath: 'artifacts/team-1/artifact-1/artifact.md',
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

  test('rejects late dispatch completions for deleted agents', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 910 },
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
      await repositories.agents.softDelete({ agentId: 'agent-1', timestamp: 905 });

      await expect(
        app.receiveDispatchResult({
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          body: 'late result',
        }),
      ).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
      await expect(
        app.receiveDispatchError({
          dispatchId: 'dispatch-1',
          agentId: 'agent-1',
          error: 'late error',
        }),
      ).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

      expect(teamDb.prepare('SELECT status FROM dispatches WHERE id = ?').get('dispatch-1')).toEqual({
        status: 'queued',
      });
      expect(teamDb.prepare("SELECT COUNT(*) AS count FROM messages WHERE sender_kind = 'agent'").get()).toEqual({ count: 0 });
    } finally {
      close();
    }
  });

  test('associates daemon-reported artifacts and workspace runs with team-scoped dispatch replies', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const artifactContentStore = {
        writeContent: vi.fn(async (input: { teamId: string; artifactId: string; filename: string; content: Buffer }) => ({
          storagePath: `artifacts/${input.teamId}/${input.artifactId}/${input.filename}`,
          sizeBytes: input.content.length,
          sha256: 'sha256-log',
        })),
      };
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
            'join-1',
            'user-2',
            'team-2',
            'channel-2',
            'channel-3',
            'message-1',
            'dispatch-1',
            'request-1',
            'workspace-run-1',
            'reply-1',
          ]),
        },
        joinCodes: {
          nextCode: createIds(['code-1']),
        },
        artifactContentStore,
      });

      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' });
      await app.registerDiscoveredAgents({
        teamId: 'team-1',
        deviceId: 'device-1',
        agents: [{ name: 'Codex', adapterKind: 'codex', category: 'executor-hosted' }],
      });
      await app.createJoinLink({ userId: 'user-1', teamId: 'team-1' });
      await app.registerUser({ username: 'lin', password: 'secret', teamName: 'Lin Team', joinCode: 'code-1' });
      const privateChannelAck = await app.createChannel({
        userId: 'user-1',
        teamId: 'team-1',
        name: 'private-artifacts',
        title: 'Private Artifacts',
        visibility: 'private',
        agentMemberIds: ['agent-1'],
      });
      expect(privateChannelAck).toMatchObject({
        ok: true,
        channel: { visibility: 'private', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'] },
      });
      if (!privateChannelAck.ok) {
        throw new Error('private channel setup failed');
      }
      const privateChannelId = privateChannelAck.channel.id;
      const sendAck = await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: privateChannelId, body: '@Codex produce docs' });
      expect(sendAck).toMatchObject({
        ok: true,
      });
      if (!sendAck.ok || !sendAck.dispatches[0]) {
        throw new Error('private channel dispatch setup failed');
      }
      const dispatchId = sendAck.dispatches[0].id;

      const resultAck = await app.receiveDispatchResult({
        dispatchId,
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
          {
            id: 'workspace-log-1',
            filename: 'workspace-run.log',
            mimeType: 'text/plain',
            relativePath: 'logs/workspace-run.log',
            pathKind: 'workspace',
            contentBase64: Buffer.from('stdout:\nhello\nOPENAI_API_KEY=[redacted]\nfinished').toString('base64'),
          },
        ],
        workspaceRun: {
          cwd: '/Users/shaw/AgentBean',
          command: 'npm run test:server-next -- tests/sqlite-repositories.test.ts',
          logExcerpt: `starting workspace run\n${'x'.repeat(17000)}\nOPENAI_API_KEY="sk-test"\nSECRET_TOKEN='quoted-secret'\nfinished workspace run`,
          exitCode: 0,
          startedAt: 1190,
        },
      });
      expect(resultAck).toMatchObject({
        ok: true,
        message: {
          workspaceRun: {
            agentId: 'agent-1',
            deviceId: 'device-1',
            command: 'npm run test:server-next -- tests/sqlite-repositories.test.ts',
            logExcerpt: expect.stringContaining('OPENAI_API_KEY=[redacted]'),
            dispatchId,
            artifactIds: ['artifact-1', 'workspace-log-1'],
          },
        },
      });
      if (!resultAck.ok || !resultAck.message.workspaceRun) {
        throw new Error('workspace run setup failed');
      }
      const replyId = resultAck.message.id;
      const workspaceRunId = resultAck.message.workspaceRun.id;
      expect(resultAck.message.artifacts?.map((artifact) => artifact.id)).toEqual(['artifact-1', 'workspace-log-1']);
      expect(resultAck.message.artifacts?.[0]?.workspaceRunId).toBe(workspaceRunId);
      expect(resultAck.message.artifacts?.[1]).toMatchObject({
        id: 'workspace-log-1',
        filename: 'workspace-run.log',
        workspaceRunId,
        relativePath: 'logs/workspace-run.log',
        pathKind: 'workspace',
        sizeBytes: Buffer.byteLength('stdout:\nhello\nOPENAI_API_KEY=[redacted]\nfinished'),
        sha256: 'sha256-log',
      });
      expect(artifactContentStore.writeContent).toHaveBeenCalledWith({
        teamId: 'team-1',
        artifactId: 'workspace-log-1',
        filename: 'workspace-run.log',
        content: Buffer.from('stdout:\nhello\nOPENAI_API_KEY=[redacted]\nfinished'),
      });

      await expect(app.getArtifact({ userId: 'user-1', teamId: 'team-1', artifactId: 'artifact-1' })).resolves.toMatchObject({
        ok: true,
        artifact: { id: 'artifact-1', teamId: 'team-1', messageId: replyId },
      });
      await expect(app.getArtifactFile({ userId: 'user-1', teamId: 'team-1', artifactId: 'workspace-log-1' })).resolves.toMatchObject({
        ok: true,
        artifact: { id: 'workspace-log-1', teamId: 'team-1', messageId: replyId },
        storagePath: 'artifacts/team-1/workspace-log-1/workspace-run.log',
      });
      await expect(app.getArtifact({ userId: 'user-2', teamId: 'team-2', artifactId: 'artifact-1' })).resolves.toMatchObject({
        ok: false,
        error: 'NOT_FOUND',
      });
      await expect(app.getWorkspaceRun({ userId: 'user-1', teamId: 'team-1', runId: workspaceRunId })).resolves.toMatchObject({
        ok: true,
        workspaceRun: {
          id: workspaceRunId,
          teamId: 'team-1',
          channelId: privateChannelId,
          messageId: replyId,
          dispatchId,
          agentId: 'agent-1',
          deviceId: 'device-1',
          artifactIds: ['artifact-1', 'workspace-log-1'],
        },
      });
      await expect(app.getWorkspaceRunDetail({ userId: 'user-1', teamId: 'team-1', runId: workspaceRunId })).resolves.toMatchObject({
        ok: true,
        workspaceRun: {
          id: workspaceRunId,
          teamId: 'team-1',
          channelId: privateChannelId,
          command: 'npm run test:server-next -- tests/sqlite-repositories.test.ts',
          logExcerpt: expect.stringContaining('finished workspace run'),
        },
        artifacts: [
          {
            id: 'artifact-1',
            filename: 'result.md',
            workspaceRunId,
            relativePath: 'outputs/result.md',
          },
          {
            id: 'workspace-log-1',
            filename: 'workspace-run.log',
            workspaceRunId,
            relativePath: 'logs/workspace-run.log',
            pathKind: 'workspace',
          },
        ],
      });
      await expect(app.getArtifact({ userId: 'user-2', teamId: 'team-1', artifactId: 'artifact-1' })).resolves.toMatchObject({
        ok: false,
        error: 'FORBIDDEN',
      });
      await expect(app.getArtifactFile({ userId: 'user-2', teamId: 'team-1', artifactId: 'workspace-log-1' })).resolves.toMatchObject({
        ok: false,
        error: 'FORBIDDEN',
      });
      await expect(app.getWorkspaceRun({ userId: 'user-2', teamId: 'team-1', runId: workspaceRunId })).resolves.toMatchObject({
        ok: false,
        error: 'FORBIDDEN',
      });
      await expect(app.getWorkspaceRunDetail({ userId: 'user-2', teamId: 'team-1', runId: workspaceRunId })).resolves.toMatchObject({
        ok: false,
        error: 'FORBIDDEN',
      });
      await expect(app.listAgentWorkspaceRuns({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' })).resolves.toMatchObject({
        ok: true,
        runs: [
          {
            runId: workspaceRunId,
            status: 'succeeded',
            cwd: '/Users/shaw/AgentBean',
            command: 'npm run test:server-next -- tests/sqlite-repositories.test.ts',
            exitCode: 0,
            files: [
              {
                id: 'artifact-1',
                filename: 'result.md',
                relativePath: 'outputs/result.md',
                pathKind: 'workspace',
              },
              {
                id: 'workspace-log-1',
                filename: 'workspace-run.log',
                relativePath: 'logs/workspace-run.log',
                pathKind: 'workspace',
              },
            ],
          },
        ],
      });
      await expect(app.listAgentWorkspaceRuns({ userId: 'user-2', teamId: 'team-1', agentId: 'agent-1' })).resolves.toMatchObject({
        ok: true,
        runs: [],
      });
      await expect(app.listTeamWorkspaceRuns({ userId: 'user-1', teamId: 'team-1' })).resolves.toMatchObject({
        ok: true,
        runs: [
          {
            workspaceRun: {
              id: workspaceRunId,
              teamId: 'team-1',
              channelId: privateChannelId,
              agentId: 'agent-1',
              deviceId: 'device-1',
              status: 'succeeded',
              command: 'npm run test:server-next -- tests/sqlite-repositories.test.ts',
            },
            artifacts: [
              {
                id: 'artifact-1',
                filename: 'result.md',
                relativePath: 'outputs/result.md',
                pathKind: 'workspace',
              },
              {
                id: 'workspace-log-1',
                filename: 'workspace-run.log',
                relativePath: 'logs/workspace-run.log',
                pathKind: 'workspace',
              },
            ],
          },
        ],
      });
      await expect(app.listTeamWorkspaceRuns({ userId: 'user-2', teamId: 'team-1' })).resolves.toMatchObject({
        ok: true,
        runs: [],
      });

      expect(teamDb.prepare('SELECT team_id AS teamId, message_id AS messageId FROM artifacts WHERE id = ?').get('artifact-1')).toEqual({
        teamId: 'team-1',
        messageId: replyId,
      });
      const persistedRun = teamDb.prepare('SELECT agent_id AS agentId, device_id AS deviceId, command, log_excerpt AS logExcerpt FROM workspace_runs WHERE id = ?').get(workspaceRunId);
      expect(persistedRun).toMatchObject({
        agentId: 'agent-1',
        deviceId: 'device-1',
        command: 'npm run test:server-next -- tests/sqlite-repositories.test.ts',
      });
      expect((persistedRun as { logExcerpt?: string }).logExcerpt).toContain('OPENAI_API_KEY=[redacted]');
      expect((persistedRun as { logExcerpt?: string }).logExcerpt).toContain('SECRET_TOKEN=[redacted]');
      expect((persistedRun as { logExcerpt?: string }).logExcerpt).not.toContain('sk-test');
      expect((persistedRun as { logExcerpt?: string }).logExcerpt).not.toContain('quoted-secret');
      expect((persistedRun as { logExcerpt?: string }).logExcerpt).toContain('finished workspace run');
      expect((persistedRun as { logExcerpt?: string }).logExcerpt?.length).toBeLessThanOrEqual(16000);
    } finally {
      close();
    }
  });

  test('workspaceRuns.listByTeam filters by agentId, deviceId and status while keeping team isolation', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const mk = (
        id: string,
        teamId: string,
        agentId: string,
        deviceId: string,
        status: WorkspaceRunRecord['status'],
        updatedAt: number,
      ): WorkspaceRunRecord => ({
        id,
        teamId,
        channelId: `${teamId}-channel`,
        dispatchId: `d-${id}`,
        agentId,
        deviceId,
        status,
        createdAt: 1000,
        updatedAt,
        artifactIds: [],
      });
      await repositories.workspaceRuns.create(mk('run-a', 'team-1', 'agent-1', 'device-1', 'succeeded', 3000));
      await repositories.workspaceRuns.create(mk('run-b', 'team-1', 'agent-2', 'device-1', 'failed', 2000));
      await repositories.workspaceRuns.create(mk('run-c', 'team-1', 'agent-1', 'device-2', 'running', 1500));
      await repositories.workspaceRuns.create(mk('run-x', 'team-2', 'agent-1', 'device-1', 'succeeded', 5000));

      const ids = (runs: WorkspaceRunRecord[]) => runs.map((run) => run.id);

      // No filter: team-1 only, ordered by updatedAt DESC.
      expect(ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-1', limit: 100 }))).toEqual([
        'run-a',
        'run-b',
        'run-c',
      ]);

      // agentId filter.
      expect(
        ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-1', limit: 100, agentId: 'agent-1' })),
      ).toEqual(['run-a', 'run-c']);

      // deviceId filter.
      expect(
        ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-1', limit: 100, deviceId: 'device-1' })),
      ).toEqual(['run-a', 'run-b']);

      // status filter.
      expect(
        ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-1', limit: 100, status: 'failed' })),
      ).toEqual(['run-b']);

      // Combined AND: agent-1 + succeeded.
      expect(
        ids(
          await repositories.workspaceRuns.listByTeam({
            teamId: 'team-1',
            limit: 100,
            agentId: 'agent-1',
            status: 'succeeded',
          }),
        ),
      ).toEqual(['run-a']);

      // Team isolation: team-2 only sees its own run, never team-1's.
      expect(ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-2', limit: 100 }))).toEqual(['run-x']);
      expect(
        ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-2', limit: 100, agentId: 'agent-1' })),
      ).toEqual(['run-x']);
    } finally {
      close();
    }
  });

  test('workspaceRuns.listByTeam paginates by cursor on (updatedAt DESC, id DESC)', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const mk = (id: string, updatedAt: number): WorkspaceRunRecord => ({
        id,
        teamId: 'team-1',
        channelId: 'channel-1',
        dispatchId: `d-${id}`,
        agentId: 'agent-1',
        deviceId: 'device-1',
        status: 'succeeded',
        createdAt: 1000,
        updatedAt,
        artifactIds: [],
      });
      // run-1 and run-2 share updatedAt=3000; id DESC breaks the tie (run-2 before run-1).
      await repositories.workspaceRuns.create(mk('run-1', 3000));
      await repositories.workspaceRuns.create(mk('run-2', 3000));
      await repositories.workspaceRuns.create(mk('run-3', 2000));
      await repositories.workspaceRuns.create(mk('run-4', 1000));

      const ids = (runs: WorkspaceRunRecord[]) => runs.map((run) => run.id);

      // First page (no cursor), limit 2: updatedAt DESC then id DESC.
      expect(ids(await repositories.workspaceRuns.listByTeam({ teamId: 'team-1', limit: 2 }))).toEqual([
        'run-2',
        'run-1',
      ]);

      // Next page: cursor = last item (3000, run-1) -> strictly older.
      expect(
        ids(
          await repositories.workspaceRuns.listByTeam({
            teamId: 'team-1',
            limit: 2,
            cursor: { updatedAt: 3000, id: 'run-1' },
          }),
        ),
      ).toEqual(['run-3', 'run-4']);

      // cursor = (2000, run-3) -> only updatedAt < 2000 remains.
      expect(
        ids(
          await repositories.workspaceRuns.listByTeam({
            teamId: 'team-1',
            limit: 10,
            cursor: { updatedAt: 2000, id: 'run-3' },
          }),
        ),
      ).toEqual(['run-4']);

      // cursor = (3000, run-2) -> same updatedAt, id < run-2 (run-1) plus everything older.
      expect(
        ids(
          await repositories.workspaceRuns.listByTeam({
            teamId: 'team-1',
            limit: 10,
            cursor: { updatedAt: 3000, id: 'run-2' },
          }),
        ),
      ).toEqual(['run-1', 'run-3', 'run-4']);
    } finally {
      close();
    }
  });

  test('listTeamWorkspaceRuns paginates by pageSize with nextCursor and rejects invalid cursor', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const artifactContentStore = {
        writeContent: vi.fn(async (input: { teamId: string; artifactId: string; filename: string; content: Buffer }) => ({
          storagePath: `artifacts/${input.teamId}/${input.artifactId}/${input.filename}`,
          sizeBytes: input.content.length,
          sha256: 'sha',
        })),
      };
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 9000 },
        ids: { nextId: createIds(Array.from({ length: 30 }, (_, index) => `seq-${index}`)) },
        joinCodes: { nextCode: createIds(['join-code-1']) },
        artifactContentStore,
      });
      const reg = await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'Bean' });
      if (!reg.ok) throw new Error('register failed');
      const userId = reg.user.id;
      const teamId = reg.currentTeam.id;
      const channelId = reg.defaultChannel.id;

      // 4 runs, updatedAt DESC order: run-0 (4000) > run-1 (3000) > run-2 (2000) > run-3 (1000).
      for (let i = 0; i < 4; i++) {
        await repositories.workspaceRuns.create({
          id: `run-${i}`,
          teamId,
          channelId,
          dispatchId: `dispatch-${i}`,
          agentId: 'agent-1',
          status: 'succeeded',
          createdAt: 1000 + i,
          updatedAt: 4000 - i * 1000,
          artifactIds: [],
        });
      }

      const page1 = await app.listTeamWorkspaceRuns({ userId, teamId, pageSize: 2 });
      expect(page1.ok).toBe(true);
      if (!page1.ok) throw new Error('page1 failed');
      expect(page1.runs.map((r) => r.workspaceRun.id)).toEqual(['run-0', 'run-1']);
      expect(typeof page1.nextCursor).toBe('string');

      const page2 = await app.listTeamWorkspaceRuns({ userId, teamId, pageSize: 2, cursor: page1.nextCursor });
      expect(page2.ok).toBe(true);
      if (!page2.ok) throw new Error('page2 failed');
      expect(page2.runs.map((r) => r.workspaceRun.id)).toEqual(['run-2', 'run-3']);
      expect(page2.nextCursor).toBeUndefined();

      const bad = await app.listTeamWorkspaceRuns({ userId, teamId, cursor: '@@@' });
      expect(bad).toMatchObject({ ok: false, error: 'BAD_REQUEST' });
    } finally {
      close();
    }
  });

  test('returns the existing artifact when an id conflict belongs to another team or channel', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      globalDb.exec('SELECT 1');
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const existing = await repositories.artifacts.create({
        id: 'artifact-1',
        teamId: 'team-1',
        channelId: 'channel-1',
        messageId: 'message-1',
        dispatchId: 'dispatch-1',
        workspaceRunId: 'workspace-run-1',
        uploaderId: 'user-1',
        filename: 'first.md',
        mimeType: 'text/markdown',
        sizeBytes: 128,
        storagePath: 'artifacts/artifact-1/first.md',
        relativePath: 'outputs/first.md',
        pathKind: 'workspace',
        sha256: 'sha256-first',
        createdAt: 1200,
      });

      const result = await repositories.artifacts.create({
        id: 'artifact-1',
        teamId: 'team-2',
        channelId: 'channel-2',
        messageId: 'message-2',
        dispatchId: 'dispatch-2',
        workspaceRunId: 'workspace-run-2',
        uploaderId: 'user-2',
        filename: 'second.md',
        mimeType: 'text/markdown',
        sizeBytes: 256,
        storagePath: 'artifacts/artifact-1/second.md',
        relativePath: 'outputs/second.md',
        pathKind: 'workspace',
        sha256: 'sha256-second',
        createdAt: 1300,
      });

      expect(result).toEqual(existing);
      expect(teamDb.prepare('SELECT team_id AS teamId, channel_id AS channelId, filename FROM artifacts WHERE id = ?').get('artifact-1')).toEqual({
        teamId: 'team-1',
        channelId: 'channel-1',
        filename: 'first.md',
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
            'runtime-2',
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
      await app.reportDeviceRuntimes({
        teamId: 'team-1',
        deviceId: 'device-1',
        runtimes: [
          {
            adapterKind: 'codex',
            name: 'Codex CLI',
            installed: true,
          },
        ],
      });
      await app.updateAgentConfig({
        userId: 'user-1',
        teamId: 'team-1',
        agentId: 'agent-1',
        runtimeId: 'runtime-2',
        name: 'Renamed Codex',
        env: { OPENAI_API_KEY: 'new-secret' },
      });
      await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: 'hello from renamed config' });
      const request = await app.getDispatchRequest({ dispatchId: 'dispatch-1' });
      expect(request.ok).toBe(true);
      if (request.ok) {
        expect(request.request.customAgent?.command).toBeUndefined();
        expect(request.request.customAgent?.cwd).toBeUndefined();
        expect(request.request.customAgent?.envRef).toEqual({ agentId: 'agent-1', teamId: 'team-1' });
        expect(request.request.customAgent?.env).toBeUndefined();
        expect(JSON.stringify(request)).not.toContain('new-secret');
      }
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

function indexNames(db: SqliteDatabase, tableName: string): string[] {
  return db
    .prepare(`PRAGMA index_list(${tableName})`)
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
