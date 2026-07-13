import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

// 复现 bug：AgentOS 托管型 Agent（agentos-hosted）改名保存后点「扫描」按钮，名称恢复原名。
//
// 根因（H1）：registerDiscoveredAgents → agents.upsert 的 ON CONFLICT(id) DO UPDATE
// 无条件 `name = excluded.name`，用设备报告的 discovered.name 覆盖了用户通过
// updateAgentConfig 改的名。identity_links 不随改名更新，二次扫描按设备旧名算 key
// 仍命中 existing → upsert 覆盖 name。
//
// 修复（对齐 devices 表 PR#393）：agents 加 name_source 列（'scanned'|'custom'），
// upsert 冲突时 'custom' 名受保护（CASE WHEN name_source='custom' THEN agents.name），
// updateConfig 改名时置 name_source='custom'。
//
// 两套实现（in-memory + sqlite）分别验证：bug 原发在 sqlite SQL，两套都改了，
// 必须分别驱动才能发现任一实现的语法/逻辑问题（避免 in-memory 假绿）。
//
// 各断言排除的竞争假设：
//   H2（identity 匹配失败→新建）：断言 id 不变 / 数量为 1 排除
//   H3（仅前端 store 被覆盖、DB 正确）：断言查 DB getById 排除
//   H4（改名未落库）：改名后立即查 DB 排除

type BetterSqlite3Constructor = new (filename: string) => SqliteDatabase & { close(): void };
const requireFromWorkspace = createRequire(import.meta.url);

function loadBetterSqlite3(): BetterSqlite3Constructor {
  const candidates = [
    () => requireFromWorkspace('better-sqlite3') as BetterSqlite3Constructor,
    () => {
      const requireFromServer = createRequire(new URL('../package.json', import.meta.url));
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
      // native 模块 ABI 相关，逐个候选尝试。
    }
  }
  throw new Error('No compatible better-sqlite3 installation found for this Node.js runtime');
}

function openMigratedDatabases() {
  const Database = loadBetterSqlite3();
  const globalDb = new Database(':memory:');
  const teamDb = new Database(':memory:');
  applyGlobalMigrations(globalDb);
  applyTeamMigrations(teamDb);
  return { globalDb, teamDb, close: () => { globalDb.close(); teamDb.close(); } };
}

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

describe('AgentOS managed agent: scan must not override user rename', () => {
  test('in-memory: agentos-hosted agent renamed via updateAgentConfig keeps user name after re-scan', async () => {
    const repositories = createInMemoryRepositories();
    let now = 10;
    let id = 0;
    const clock = { now: () => ++now };
    const ids = { nextId: () => `id-${++id}` };

    await repositories.users.create({
      id: 'user-1', username: 'owner', role: 'user', passwordHash: 'hash',
      primaryTeamId: 'team-1', currentTeamId: 'team-1', createdAt: 1, updatedAt: 1,
    });
    await repositories.teams.create({
      id: 'team-1', name: 'Team', path: 'team', visibility: 'private',
      ownerId: 'user-1', createdAt: 1,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1,
    });
    await repositories.devices.upsertHello({
      id: 'device-1', teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1',
      profileId: 'profile-1', status: 'online', createdAt: 1, updatedAt: 1,
    });

    const app = createServerNextUseCases({ repositories, clock, ids });

    const first = await app.registerDiscoveredAgents({
      teamId: 'team-1', deviceId: 'device-1',
      agents: [{ name: 'hermes-01', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    if (!first.ok) throw new Error(`first scan failed: ${first.error}`);
    const agentId = first.agents[0]!.id;

    const renamed = await app.updateAgentConfig({
      userId: 'user-1', teamId: 'team-1', agentId, name: '我的助手',
    });
    if (!renamed.ok) throw new Error(`rename failed: ${renamed.error}`);
    // 排除 H4（改名未落库）
    expect((await repositories.agents.getById(agentId))?.name).toBe('我的助手');

    const second = await app.registerDiscoveredAgents({
      teamId: 'team-1', deviceId: 'device-1',
      agents: [{ name: 'hermes-01', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    if (!second.ok) throw new Error(`second scan failed: ${second.error}`);

    // 排除 H2（identity 匹配失败→新建）：同一 agent，未产生第二条
    expect(second.agents).toHaveLength(1);
    expect(second.agents[0]!.id).toBe(agentId);
    // 主断言（H1）：再次扫描后用户改的名必须保留（查 DB 排除 H3）
    expect((await repositories.agents.getById(agentId))?.name).toBe('我的助手');
    expect(second.agents[0]!.name).toBe('我的助手');
  });

  test('sqlite: agentos-hosted agent renamed via updateAgentConfig keeps user name after re-scan', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 500 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1', 'agent-2', 'agent-3']) },
      });
      await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'host-1' });

      const first = await app.registerDiscoveredAgents({
        teamId: 'team-1', deviceId: 'device-1',
        agents: [{ name: 'hermes-01', adapterKind: 'hermes', category: 'agentos-hosted' }],
      });
      if (!first.ok) throw new Error(`first scan failed: ${first.error}`);
      const agentId = first.agents[0]!.id;

      const renamed = await app.updateAgentConfig({
        userId: 'user-1', teamId: 'team-1', agentId, name: '我的助手',
      });
      if (!renamed.ok) throw new Error(`rename failed: ${renamed.error}`);
      expect((await repositories.agents.getById(agentId))?.name).toBe('我的助手');

      const second = await app.registerDiscoveredAgents({
        teamId: 'team-1', deviceId: 'device-1',
        agents: [{ name: 'hermes-01', adapterKind: 'hermes', category: 'agentos-hosted' }],
      });
      if (!second.ok) throw new Error(`second scan failed: ${second.error}`);

      expect(second.agents).toHaveLength(1);
      expect(second.agents[0]!.id).toBe(agentId);
      expect((await repositories.agents.getById(agentId))?.name).toBe('我的助手');
      expect(second.agents[0]!.name).toBe('我的助手');
    } finally {
      close();
    }
  });
});
