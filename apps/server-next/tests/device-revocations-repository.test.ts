import { describe, test, expect } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';

describe('device revocations repository (memory)', () => {
  test('find returns null when no revocation', async () => {
    const repos = createInMemoryRepositories();
    const found = await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' });
    expect(found).toBeNull();
  });

  test('upsertAll then find hits (teamId, machineId, profileId)', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [
        { teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 },
      ],
    });
    const found = await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' });
    expect(found?.deviceId).toBe('d1');
  });

  test('find is scoped by teamId (cross-team isolation)', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [{ teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 }],
    });
    const other = await repos.revocations.find({ teamId: 't2', machineId: 'm1', profileId: 'p1' });
    expect(other).toBeNull();
  });

  test('clear removes all profileIds for (teamId, machineId)', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [
        { teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 },
        { teamId: 't1', machineId: 'm1', profileId: 'p2', deviceId: 'd2', deletedAt: 1000 },
      ],
    });
    await repos.revocations.clear({ teamId: 't1', machineId: 'm1' });
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' })).toBeNull();
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p2' })).toBeNull();
  });

  test('profileId null matches revocations with null profileId', async () => {
    const repos = createInMemoryRepositories();
    await repos.revocations.upsertAll({
      revocations: [{ teamId: 't1', machineId: 'm1', profileId: null, deviceId: 'd1', deletedAt: 1000 }],
    });
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null })).not.toBeNull();
    expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' })).toBeNull();
  });
});

import Database from 'better-sqlite3';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
} from '../src/infra/sqlite/repositories';

function openMigratedRepos() {
  const globalDb = new Database(':memory:');
  const teamDb = new Database(':memory:');
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  return {
    globalDb,
    repos: createSqliteRepositories({ globalDb, teamDb }),
    close() {
      globalDb.close();
      teamDb.close();
    },
  };
}

describe('device revocations repository (sqlite)', () => {
  test('upsertAll/find/clear round-trip with profileId value', async () => {
    const { repos, close } = openMigratedRepos();
    try {
      await repos.revocations.upsertAll({
        revocations: [{ teamId: 't1', machineId: 'm1', profileId: 'p1', deviceId: 'd1', deletedAt: 1000 }],
      });
      expect((await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' }))?.deviceId).toBe('d1');
      await repos.revocations.clear({ teamId: 't1', machineId: 'm1' });
      expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' })).toBeNull();
    } finally {
      close();
    }
  });

  test('NULL profileId round-trips via IS NULL (not = NULL)', async () => {
    const { repos, close } = openMigratedRepos();
    try {
      await repos.revocations.upsertAll({
        revocations: [{ teamId: 't1', machineId: 'm1', profileId: null, deviceId: 'd1', deletedAt: 1000 }],
      });
      expect((await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null }))?.deviceId).toBe('d1');
      // a non-null profileId must not match the null row
      expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: 'p1' })).toBeNull();
      await repos.revocations.clear({ teamId: 't1', machineId: 'm1' });
      expect(await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null })).toBeNull();
    } finally {
      close();
    }
  });

  test('NULL profileId upsert replaces the existing revocation row', async () => {
    const { globalDb, repos, close } = openMigratedRepos();
    try {
      await repos.revocations.upsertAll({
        revocations: [{ teamId: 't1', machineId: 'm1', profileId: null, deviceId: 'd1', deletedAt: 1000 }],
      });
      await repos.revocations.upsertAll({
        revocations: [{ teamId: 't1', machineId: 'm1', profileId: null, deviceId: 'd2', deletedAt: 2000 }],
      });

      const found = await repos.revocations.find({ teamId: 't1', machineId: 'm1', profileId: null });
      expect(found).toMatchObject({ deviceId: 'd2', deletedAt: 2000 });
      const rowCount = globalDb
        .prepare('SELECT COUNT(*) AS count FROM device_revocations WHERE teamId = ? AND machineId = ?')
        .get('t1', 'm1') as { count: number };
      expect(rowCount.count).toBe(1);
    } finally {
      close();
    }
  });
});
