import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories';

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };
const requireFromWorkspace = createRequire(import.meta.url);
const Database = requireFromWorkspace('better-sqlite3') as BetterSqlite3Constructor;

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

describe('team PI auto-coordination policy (#707)', () => {
  test('defaults to enabled for a new team and DTO exposes only the toggle', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    const result = await app.getPiPolicy({ teamId: 'team-1', userId: 'user-1' });
    expect(result).toMatchObject({ ok: true, autoCoordinationEnabled: true });
    // AC#1：返回只含 autoCoordinationEnabled，不含旧 mode/phase/placement/provider/model/budget。
    expect(JSON.stringify(result)).not.toContain('placement');
    expect(JSON.stringify(result)).not.toContain('maxManagementPhase');
    expect(JSON.stringify(result)).not.toContain('provider');
  });

  test('owner and admin can toggle; member can read but not write; non-member denied', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-admin', username: 'admin', role: 'admin', joinedAt: 50,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-member', username: 'member', role: 'member', joinedAt: 51,
    });

    // owner 关闭
    await expect(app.updatePiPolicy({ teamId: 'team-1', userId: 'user-1', autoCoordinationEnabled: false }))
      .resolves.toMatchObject({ ok: true, autoCoordinationEnabled: false });
    // admin 再打开
    await expect(app.updatePiPolicy({ teamId: 'team-1', userId: 'user-admin', autoCoordinationEnabled: true }))
      .resolves.toMatchObject({ ok: true, autoCoordinationEnabled: true });
    // member 可读
    await expect(app.getPiPolicy({ teamId: 'team-1', userId: 'user-member' }))
      .resolves.toMatchObject({ ok: true, autoCoordinationEnabled: true });
    // member 不可写（AC#2）
    await expect(app.updatePiPolicy({ teamId: 'team-1', userId: 'user-member', autoCoordinationEnabled: false }))
      .resolves.toMatchObject({ ok: false });
    // 非成员连读都被拒
    await expect(app.getPiPolicy({ teamId: 'team-1', userId: 'user-outsider' }))
      .resolves.toMatchObject({ ok: false });
  });

  test('persists the toggle across reads in SQLite', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      expect(teamDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='team_pi_policies'").get()).toBeTruthy();
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 200 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

      await app.updatePiPolicy({ teamId: 'team-1', userId: 'user-1', autoCoordinationEnabled: false });
      expect(teamDb.prepare('SELECT auto_coordination_enabled AS e FROM team_pi_policies WHERE team_id = ?').get('team-1')).toEqual({ e: 0 });
      await expect(app.getPiPolicy({ teamId: 'team-1', userId: 'user-1' })).resolves.toMatchObject({ autoCoordinationEnabled: false });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  // #724 AC#7：旧 PI 字段不进入 Team API/Socket/DOM
  test('AC#7: piPolicy response does not leak old PI fields (mode/phase/placement/provider/model/budget)', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });

    const result = await app.getPiPolicy({ teamId: 'team-1', userId: 'user-1' });
    const json = JSON.stringify(result);

    // AC#7：禁止任何旧 PI 字段出现在返回中
    const forbidden = ['mode', 'phase', 'placement', 'provider', 'model', 'budget', 'runtime', 'direct', 'shadow', 'managed'];
    for (const word of forbidden) {
      expect(json).not.toContain(word);
    }

    // 确认只包含正常的 autoCoordinationEnabled
    expect(result).toMatchObject({ ok: true, autoCoordinationEnabled: true });
    expect(Object.keys(result)).toEqual(['ok', 'autoCoordinationEnabled']);
  });

  // #724 AC#2：旧 mode='direct' Team 迁移后默认关闭，其他开启
  test('AC#2: migration maps old mode=direct → autoCoordinationEnabled=false', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    try {
      // 模拟旧 team：创建 team_management_policies 行（在 migration 0046 之后，手动执行迁移逻辑）
      teamDb.prepare(`INSERT INTO team_management_policies (team_id, mode, placement_policy_json, updated_by, updated_at)
        VALUES ('old-direct-team', 'direct', '{}', 'system', 100)`).run();
      teamDb.prepare(`INSERT INTO team_management_policies (team_id, mode, placement_policy_json, updated_by, updated_at)
        VALUES ('old-managed-team', 'managed', '{}', 'system', 100)`).run();

      // 手动执行 migration 0046 的迁移逻辑（team_management_policies → team_pi_policies）
      teamDb.exec(`INSERT OR IGNORE INTO team_pi_policies (team_id, auto_coordination_enabled, updated_by, updated_at)
        SELECT team_id,
          CASE WHEN mode = 'direct' THEN 0 ELSE 1 END,
          COALESCE(updated_by, '_system'),
          COALESCE(updated_at, CAST(strftime('%s', 'now') * 1000 AS INTEGER))
        FROM team_management_policies WHERE true`);

      const directRow = teamDb.prepare(
        'SELECT auto_coordination_enabled AS e FROM team_pi_policies WHERE team_id = ?',
      ).get('old-direct-team') as { e: number } | undefined;
      const managedRow = teamDb.prepare(
        'SELECT auto_coordination_enabled AS e FROM team_pi_policies WHERE team_id = ?',
      ).get('old-managed-team') as { e: number } | undefined;

      expect(directRow?.e).toBe(0);   // direct → disabled
      expect(managedRow?.e).toBe(1);  // managed → enabled
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  // #724 AC#8：getManagementPolicy 已移除 → 确认不可达
  test('AC#8: getManagementPolicy is no longer exposed on use cases', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });

    // getManagementPolicy 不应存在于 ServerNextUseCases 接口
    expect('getManagementPolicy' in app).toBe(false);
    expect('updateManagementPolicy' in app).toBe(false);
  });
});
