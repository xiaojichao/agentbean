import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createChannelCoordinator } from '../src/application/channel-coordination-coordinator.js';
import { isLegacyCoordinationWriteFenced } from '../src/application/legacy-coordination-fence.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import type { TeamPiAuthorityMigrationRecord } from '../src/application/pi-authority-cutover-repositories.js';

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error(`ID pool exhausted at ${index}`);
    return id;
  };
}

function fencedMigration(teamId: string, now = 1000): TeamPiAuthorityMigrationRecord {
  return {
    teamId,
    authorityEpoch: 1,
    migrationRevision: 2,
    state: 'new_authority',
    legacyWriterFenced: true,
    emergencyStop: false,
    cutoverVersion: 1,
    cutoverAt: now,
    cutoverBy: 'owner-1',
    drainDeadlineAt: now + 60_000,
    createdAt: now,
    updatedAt: now,
  };
}

describe('isLegacyCoordinationWriteFenced', () => {
  test('无迁移记录不 fence；new_authority fence', () => {
    expect(isLegacyCoordinationWriteFenced(null)).toBe(false);
    expect(isLegacyCoordinationWriteFenced(fencedMigration('t1'))).toBe(true);
    expect(isLegacyCoordinationWriteFenced({
      ...fencedMigration('t1'),
      state: 'legacy',
      legacyWriterFenced: false,
      authorityEpoch: 0,
      cutoverVersion: null,
      cutoverAt: null,
      cutoverBy: null,
    })).toBe(false);
  });
});

describe('sendMessage after PI authority cutover', () => {
  test('消息仍提交，但不创建 coordination job（无 dual-write）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-unused']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await repositories.teamPiAuthorityMigrations.upsert(fencedMigration('team-1', 100));

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      clientMessageId: 'client-fence-1',
      body: 'hello after cutover',
    })).resolves.toMatchObject({
      ok: true,
      message: { id: 'message-1', body: 'hello after cutover' },
      dispatches: [],
    });

    await expect(repositories.channelCoordination.jobs.getByMessageId('message-1')).resolves.toBeNull();
  });

  test('未 cutover 的 Team 仍 enqueue coordination job', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'job-1']) },
      messageIngestionMode: 'durable-job',
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    await expect(app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      clientMessageId: 'client-legacy-1',
      body: 'still legacy path',
    })).resolves.toMatchObject({ ok: true });

    await expect(repositories.channelCoordination.jobs.getByMessageId('message-1')).resolves.toMatchObject({
      id: 'job-1',
      status: 'pending',
    });
  });
});

describe('coordinator after cutover', () => {
  test('pending job 被取消，不得继续执行', async () => {
    const repositories = createInMemoryRepositories();
    let seq = 0;
    const now = 20_000;
    const teamId = 'team-fence';
    const jobId = 'job-pending-1';

    await repositories.messages.append({
      id: 'msg-1',
      teamId,
      channelId: 'ch-1',
      threadId: 'msg-1',
      senderKind: 'human',
      senderId: 'user-1',
      body: 'pending work',
      createdAt: now,
    });
    await repositories.channelCoordination.jobs.create({
      id: jobId,
      teamId,
      channelId: 'ch-1',
      messageId: 'msg-1',
      idempotencyKey: 'idem-1',
      status: 'pending',
      attempt: 0,
      nextRetryAt: null,
      activeModel: { availability: 'unavailable' },
      createdAt: now,
      updatedAt: now,
    });
    await repositories.teamPiAuthorityMigrations.upsert(fencedMigration(teamId, now));

    const coordinator = createChannelCoordinator({
      jobs: repositories.channelCoordination.jobs,
      decisions: repositories.channelCoordination.decisions,
      unitOfWork: repositories.channelCoordinationUnitOfWork,
      messages: repositories.messages,
      channels: repositories.channels,
      teams: repositories.teams,
      agents: repositories.agents,
      teamPolicy: repositories.teamPiPolicy,
      modelResolver: {
        async resolveInvocationTarget() {
          return { kind: 'unavailable', diagnosticCode: 'NO_MODEL' };
        },
      },
      // fence 在 memory resolve 之前返回；此处仅满足 deps 类型。
      memoryContextResolver: {
        resolve: async () => {
          throw new Error('memory resolver must not run for fenced pending jobs');
        },
      } as never,
      clock: { now: () => now },
      ids: { nextId: () => `c-${++seq}` },
      teamPiAuthorityMigrations: repositories.teamPiAuthorityMigrations,
    });

    const outcome = await coordinator.processJob(jobId);
    expect(outcome).toEqual({ kind: 'terminal', status: 'cancelled' });
    const job = await repositories.channelCoordination.jobs.getById(jobId);
    expect(job?.status).toBe('cancelled');
  });
});
