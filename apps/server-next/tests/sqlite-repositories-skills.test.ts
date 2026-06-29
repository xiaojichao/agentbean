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

describe('agents skills_json 持久化', () => {
  test('upsert 写入 skills_json，mapAgent 读回一致', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 500 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']) },
      });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });

      // 直接 upsert 一个带 skills 的 custom agent
      await repositories.agents.upsert({
        id: 'agent-1',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'mindmap-ppt',
        adapterKind: 'claude-code',
        category: 'executor-hosted',
        source: 'custom',
        status: 'online',
        deviceId: 'device-1',
        lastSeenAt: 500,
        skills: [
          {
            name: 'analyze',
            description: 'deep analysis',
            scope: 'user',
            sourcePath: '/h/.claude/skills/analyze',
            adapterKind: 'claude-code',
          },
        ],
      } as any);

      const got = await repositories.agents.getById('agent-1');
      expect(got?.skills).toEqual([
        {
          name: 'analyze',
          description: 'deep analysis',
          scope: 'user',
          sourcePath: '/h/.claude/skills/analyze',
          adapterKind: 'claude-code',
        },
      ]);
    } finally {
      close();
    }
  });

  test('updateSkills 单独更新 skills_json', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const app = createServerNextUseCases({
        repositories,
        clock: { now: () => 500 },
        ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']) },
      });
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
      await repositories.agents.upsert({
        id: 'agent-1',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'a',
        adapterKind: 'claude-code',
        category: 'executor-hosted',
        source: 'custom',
        status: 'online',
        deviceId: 'device-1',
        lastSeenAt: 500,
      } as any);

      await repositories.agents.updateSkills({
        agentId: 'agent-1',
        skills: [
          { name: 's1', description: 'd', scope: 'system', sourcePath: '<builtin>', adapterKind: 'codex' },
        ],
        timestamp: 600,
      });

      const got = await repositories.agents.getById('agent-1');
      expect(got?.skills?.length).toBe(1);
      expect(got?.skills?.[0].name).toBe('s1');
    } finally {
      close();
    }
  });

  test('脏 skills_json 不崩 mapAgent，回退 undefined', async () => {
    const { globalDb, teamDb, close } = openMigratedDatabases();
    try {
      // 直接塞脏数据测容错：关闭外键约束以绕过 primary_team_id 引用。
      globalDb.pragma('foreign_keys = OFF');
      globalDb.exec(
        `INSERT INTO agents (id, primary_team_id, name, normalized_name, adapter_kind, category, source, status, last_seen_at, created_at, updated_at, skills_json) VALUES ('x','t','n','n','claude-code','executor-hosted','custom','online',0,0,0,'{not json')`,
      );
      globalDb.pragma('foreign_keys = ON');
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      const got = await repositories.agents.getById('x');
      expect(got?.skills).toBeUndefined();
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
