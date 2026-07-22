import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import {
  createInMemoryRepositories,
  createServerNextUseCases,
} from '../src/index';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories';

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };

const requireFromWorkspace = createRequire(import.meta.url);
const Database = requireFromWorkspace('better-sqlite3') as BetterSqlite3Constructor;

describe('human message coordination enqueue', () => {
  test('persists one message and one unavailable job before acknowledging', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      clientMessageId: 'client-1',
      body: '请理解这条消息',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', body: '请理解这条消息' },
      dispatches: [],
    });

    await expect(repositories.channelCoordination.jobs.getByMessageId('message-1')).resolves.toMatchObject({
      id: 'job-1',
      messageId: 'message-1',
      activeModel: { availability: 'unavailable' },
    });
  });

  test('uses the same durable enqueue boundary for human direct messages', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'dm-1', 'message-1', 'job-1']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.registerAgent({
      id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent',
      adapterKind: 'codex', category: 'agentos-hosted', source: 'scanned', status: 'offline',
      deviceId: 'device-1', lastSeenAt: 90,
    });
    await app.startDirectMessage({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });

    await expect(app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'dm-1', body: 'DM 也先可靠保存',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', channelId: 'dm-1' },
      dispatches: [],
    });
    await expect(repositories.channelCoordination.jobs.getByMessageId('message-1')).resolves.toMatchObject({
      id: 'job-1', channelId: 'dm-1', status: 'pending',
    });
  });

  test('replays the same client idempotency key as the original message and job', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    const input = {
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      clientMessageId: 'client-1', body: '幂等消息',
    };
    const first = await app.sendMessage(input);
    const replay = await app.sendMessage(input);

    expect(replay).toEqual(first);
    await expect(repositories.messages.listByChannel('channel-1', 10)).resolves.toHaveLength(1);
    await expect(repositories.channelCoordination.jobs.listByChannel('channel-1', 10)).resolves.toHaveLength(1);
  });

  test('replays the same durable message id as the original message and job', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'job-1']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const input = {
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
      messageId: 'message-client-1', body: '稳定 Message ID',
    };

    const first = await app.sendMessage(input);
    const replay = await app.sendMessage(input);

    expect(replay).toEqual(first);
    await expect(repositories.messages.listByChannel('channel-1', 10)).resolves.toHaveLength(1);
    await expect(repositories.channelCoordination.jobs.listByChannel('channel-1', 10)).resolves.toHaveLength(1);
  });

  test('pins the active model revision that existed when the job was created', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.piProvider.revisions.create({
      id: 'revision-1',
      cardId: 'card-1',
      status: 'published',
      displayName: 'PI',
      notes: null,
      consoleUrl: null,
      config: {
        protocol: 'openai_chat_completions',
        baseUrl: 'https://example.com/v1',
        endpointMode: 'chat_completions',
        modelId: 'model-1',
        timeoutMs: 10_000,
        maxOutputTokens: 1_000,
        compatibilityParams: {},
      },
      createdBy: 'admin-1',
      createdAt: 90,
    });
    await repositories.piProvider.activeModel.set({
      cardId: 'card-1', revisionId: 'revision-1', changedBy: 'admin-1', changedAt: 95,
    });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    const result = await app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '固定模型',
    });

    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain('model-1');
    expect(JSON.stringify(result)).not.toContain('revision-1');
    await expect(repositories.channelCoordination.jobs.getByMessageId('message-1')).resolves.toMatchObject({
      activeModel: {
        availability: 'available',
        cardId: 'card-1',
        revisionId: 'revision-1',
        modelId: 'model-1',
      },
    });
  });

  test('persists every job lifecycle status with attempt and retry time', async () => {
    const repositories = createInMemoryRepositories();
    await repositories.messages.append({
      id: 'message-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'human', senderId: 'user-1', body: '状态测试', createdAt: 100,
    });
    await repositories.channelCoordination.jobs.create({
      id: 'job-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      idempotencyKey: 'message:message-1', status: 'pending', attempt: 0, nextRetryAt: null,
      activeModel: { availability: 'unavailable' }, createdAt: 100, updatedAt: 100,
    });
    const states = ['running', 'retry_wait', 'completed', 'failed', 'cancelled'] as const;
    for (const [index, status] of states.entries()) {
      await expect(repositories.channelCoordination.jobs.updateState({
        jobId: 'job-1',
        status,
        attempt: index + 1,
        nextRetryAt: status === 'retry_wait' ? 1_000 : null,
        updatedAt: 200 + index,
      })).resolves.toMatchObject({
        status,
        attempt: index + 1,
        nextRetryAt: status === 'retry_wait' ? 1_000 : null,
      });
    }
  });

  test('rejects archived and unauthorized channels without a message or job side effect', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'private-1']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-2', username: 'member', role: 'member', joinedAt: 50,
    });
    await repositories.channels.create({
      id: 'private-1', teamId: 'team-1', kind: 'channel', name: 'private', visibility: 'private',
      humanMemberIds: ['user-1'], agentMemberIds: [], createdAt: 60,
    });
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: 70 });

    await expect(app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '归档后写入',
    })).resolves.toMatchObject({ ok: false });
    await expect(app.sendMessage({
      userId: 'user-2', teamId: 'team-1', channelId: 'private-1', body: '越权写入',
    })).resolves.toMatchObject({ ok: false });
    await expect(repositories.messages.listByChannel('channel-1', 10)).resolves.toEqual([]);
    await expect(repositories.messages.listByChannel('private-1', 10)).resolves.toEqual([]);
    await expect(repositories.channelCoordination.jobs.listByChannel('channel-1', 10)).resolves.toEqual([]);
    await expect(repositories.channelCoordination.jobs.listByChannel('private-1', 10)).resolves.toEqual([]);
  });
});

describe('SQLite message and coordination job transaction', () => {
  test('commits one message and job when the client request is replayed', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 100 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
        messageIngestionMode: 'durable-job',
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      const input = {
        userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
        clientMessageId: 'client-1', body: 'SQLite 幂等消息',
      };

      const first = await app.sendMessage(input);
      const replay = await app.sendMessage(input);

      expect(replay).toEqual(first);
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 });
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM channel_coordination_jobs').get()).toEqual({ count: 1 });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  test('rolls back the message when the job insert fails', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 100 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
        messageIngestionMode: 'durable-job',
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      teamDb.exec(`
        CREATE TRIGGER fail_coordination_job
        BEFORE INSERT ON channel_coordination_jobs
        BEGIN
          SELECT RAISE(FAIL, 'injected coordination job failure');
        END;
      `);

      await expect(app.sendMessage({
        userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '必须同时回滚',
      })).rejects.toThrow('injected coordination job failure');
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 });
      expect(teamDb.prepare('SELECT COUNT(*) AS count FROM channel_coordination_jobs').get()).toEqual({ count: 0 });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });
});

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}
