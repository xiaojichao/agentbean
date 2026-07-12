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

async function bootstrap() {
  const { globalDb, teamDb, close } = openMigratedDatabases();
  const repositories = createSqliteRepositories({ globalDb, teamDb });
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 1000 },
    ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']) },
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
  // 直接造一个 custom agent
  await repositories.agents.upsert({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    name: 'mindmap',
    adapterKind: 'claude-code',
    category: 'executor-hosted',
    source: 'custom',
    status: 'online',
    deviceId: 'device-1',
    lastSeenAt: 1000,
    cwd: '/proj',
  } as any);
  return { app, repositories, close };
}

describe('reportCustomSkills usecase', () => {
  test('按 agentId 更新 skills_json', async () => {
    const { app, repositories, close } = await bootstrap();
    try {
      const result = await app.reportCustomSkills({
        teamId: 'team-1',
        deviceId: 'device-1',
        items: [
          {
            agentId: 'agent-1',
            skills: [
              { name: 's', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' },
            ],
          },
        ],
      } as any);
      expect((result as any).ok).toBe(true);
      const got = await repositories.agents.getById('agent-1');
      expect(got?.skills?.[0].name).toBe('s');
    } finally {
      close();
    }
  });

  test('未知 agentId 跳过，不报错', async () => {
    const { app, close } = await bootstrap();
    try {
      const result = await app.reportCustomSkills({
        teamId: 'team-1',
        deviceId: 'device-1',
        items: [{ agentId: 'nope', skills: [] }],
      } as any);
      expect((result as any).ok).toBe(true);
    } finally {
      close();
    }
  });

  test('同设备非 custom agent 跳过，不写入 skills_json', async () => {
    const { app, repositories, close } = await bootstrap();
    try {
      await repositories.agents.upsert({
        id: 'agent-scanned',
        primaryTeamId: 'team-1',
        visibleTeamIds: ['team-1'],
        name: 'scanned',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'scanned',
        status: 'online',
        deviceId: 'device-1',
        lastSeenAt: 1000,
      } as any);

      const result = await app.reportCustomSkills({
        teamId: 'team-1',
        deviceId: 'device-1',
        items: [
          {
            agentId: 'agent-scanned',
            skills: [
              { name: 'should-not-write', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'codex' },
            ],
          },
        ],
      } as any);
      expect((result as any).ok).toBe(true);
      expect((result as any).updated).toBe(0);
      const got = await repositories.agents.getById('agent-scanned');
      expect(got?.skills).toBeUndefined();
    } finally {
      close();
    }
  });

  test('过滤 name 非字符串等畸形 skill，不持久化脏数据', async () => {
    const { app, repositories, close } = await bootstrap();
    try {
      const result = await app.reportCustomSkills({
        teamId: 'team-1',
        deviceId: 'device-1',
        items: [
          {
            agentId: 'agent-1',
            skills: [
              // 合法
              { name: 'good', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' },
              // name 非字符串 → 过滤
              { name: 123 as unknown as string, description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' },
              // name 空串 → 过滤
              { name: '   ', description: 'd', scope: 'user', sourcePath: '/p', adapterKind: 'claude-code' },
              // scope 非法 → 过滤
              { name: 'bad-scope', description: 'd', scope: 'global' as any, sourcePath: '/p', adapterKind: 'claude-code' },
              // description 非字符串 → 过滤
              { name: 'bad-desc', description: 42 as unknown as string, scope: 'project', sourcePath: '/p', adapterKind: 'claude-code' },
            ],
          },
        ],
      } as any);
      expect((result as any).ok).toBe(true);
      const got = await repositories.agents.getById('agent-1');
      const names = (got?.skills ?? []).map((s: any) => s.name);
      expect(names).toEqual(['good']);
    } finally {
      close();
    }
  });
});

describe('requestDeviceScan 下发 customAgents', () => {
  test('request 含该 device 的 custom agent 列表', async () => {
    const { app, close } = await bootstrap();
    try {
      const result = await app.requestDeviceScan({ teamId: 'team-1', userId: 'user-1', deviceId: 'device-1' } as any);
      const request = (result as any).value?.request ?? (result as any).request;
      expect(request.customAgents).toEqual([{ id: 'agent-1', adapterKind: 'claude-code', cwd: '/proj' }]);
    } finally {
      close();
    }
  });

  test('buildDeviceScanRequest 跳过 userId 校验，按 deviceId 构造 request', async () => {
    const { app, close } = await bootstrap();
    try {
      // 不传 userId —— 模拟 hello 首推（device 自身触发）
      const result = (await (app as any).buildDeviceScanRequest({ deviceId: 'device-1' })) as any;
      expect(result.ok).toBe(true);
      const request = result.value?.request ?? result.request;
      expect(request.deviceId).toBe('device-1');
      expect(request.customAgents).toEqual([{ id: 'agent-1', adapterKind: 'claude-code', cwd: '/proj' }]);
    } finally {
      close();
    }
  });

  test('buildDeviceScanRequest 未知 deviceId 返回 skipped，不报错', async () => {
    const { app, close } = await bootstrap();
    try {
      const result = (await (app as any).buildDeviceScanRequest({ deviceId: 'nope' })) as any;
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.request).toBeUndefined();
    } finally {
      close();
    }
  });

  test('buildDeviceScanRequest 对 offline device 返回 skipped，不消耗 requestId', async () => {
    const { app, repositories, close } = await bootstrap();
    try {
      // deviceHello 默认 online；手工 markOffline 模拟断连中
      await repositories.devices.markOffline({ deviceId: 'device-1', timestamp: 2000 });
      const result = (await (app as any).buildDeviceScanRequest({ deviceId: 'device-1' })) as any;
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.request).toBeUndefined();
    } finally {
      close();
    }
  });

  test('buildDeviceScanRequest 无 custom agent 时 skipped，不消耗 requestId', async () => {
    const { globalDb, teamDb } = openMigratedDatabases();
    const repositories = createSqliteRepositories({ globalDb, teamDb });
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1000 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']) },
    });
    try {
      await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
      await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
      // 不造任何 custom agent
      const result = (await app.buildDeviceScanRequest({ deviceId: 'device-1' })) as any;
      expect(result.ok).toBe(true);
      expect(result.skipped).toBe(true);
      expect(result.request).toBeUndefined();
    } finally {
      globalDb.close();
      teamDb.close();
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
      // Try the next installed copy; native modules are ABI-specific.
    }
  }
  throw new Error('No compatible better-sqlite3 installation found for this Node.js runtime');
}
