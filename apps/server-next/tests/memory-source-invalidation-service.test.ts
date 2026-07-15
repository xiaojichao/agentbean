import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type {
  MemoryItemRecord,
  MemorySourceKind,
  MemorySourceRecord,
  ServerNextRepositories,
} from '../src/index.js';
import { createMemorySourceInvalidationService } from '../src/application/memory-source-invalidation-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly service: ReturnType<typeof createMemorySourceInvalidationService>;
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  let counter = 0;
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `audit-${++counter}` };
  return {
    repositories,
    service: createMemorySourceInvalidationService({ unitOfWork: repositories.memoryUnitOfWork, clock, ids }),
    close() {},
  };
}

interface SeedMemoryInput {
  readonly teamId?: string;
  readonly memoryId: string;
  readonly status?: MemoryItemRecord['status'];
  readonly scopeType?: MemoryItemRecord['scopeType'];
  readonly scopeRef?: string;
  readonly sources: ReadonlyArray<Pick<MemorySourceRecord, 'sourceKind' | 'sourceId'> & { readonly snapshotHash?: string }>;
}

/** 直接通过 repository 写入 memory item + 其来源，隔离测试 invalidation 逻辑。 */
async function seedMemory(repositories: ServerNextRepositories, input: SeedMemoryInput): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    const teamId = input.teamId ?? 'team-1';
    const item: MemoryItemRecord = {
      schemaVersion: 1,
      id: input.memoryId,
      teamId,
      kind: 'decision',
      status: input.status ?? 'active',
      scopeType: input.scopeType ?? 'team',
      scopeRef: input.scopeRef ?? teamId,
      content: `content for ${input.memoryId}`,
      summary: 'seed',
      createdByUserId: 'user-1',
      approvedByUserId: 'user-1',
      validFrom: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    await memory.items.create(item);
    for (const source of input.sources) {
      await memory.sources.create({
        memoryId: item.id,
        teamId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        snapshotHash: source.snapshotHash ?? `sha256:${source.sourceId}`,
        sourceScopeType: 'team',
        sourceScopeRef: teamId,
        sourceVisibility: 'team',
        createdAt: 1,
      });
    }
  });
}

async function getStatus(repositories: ServerNextRepositories, teamId: string, memoryId: string): Promise<string | null> {
  const item = await repositories.memory.items.getById({ teamId, id: memoryId });
  return item?.status ?? null;
}

describe.each([
  ['memory', () => ({ ...makeHarness(createInMemoryRepositories()), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { ...makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db })), close: () => db.close() };
  }],
] as const)('Phase 3 Memory Source Invalidation (%s)', (_name, createHarness) => {
  test('expires a memory whose only source is invalidated and audits the cascade', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-1', sources: [{ sourceKind: 'message', sourceId: 'msg-1' }],
      });
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1'], actorId: 'user-1',
      });
      expect(result.expiredMemoryIds).toEqual(['mem-1']);
      expect(await getStatus(harness.repositories, 'team-1', 'mem-1')).toBe('expired');

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'memory', subjectId: 'mem-1',
      });
      expect(audit.map((event) => event.eventType)).toContain('memory-expired');
      expect(audit[audit.length - 1].actorKind).toBe('system');
      // 反应式级联审计也不携带敏感正文。
      expect(audit[audit.length - 1]).not.toHaveProperty('content');
      expect(audit[audit.length - 1]).not.toHaveProperty('body');
    } finally {
      harness.close();
    }
  });

  test('keeps a memory that still has another source of a different kind', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-2',
        sources: [{ sourceKind: 'message', sourceId: 'msg-1' }, { sourceKind: 'task', sourceId: 'task-1' }],
      });
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1'],
      });
      expect(result.expiredMemoryIds).toEqual([]);
      expect(await getStatus(harness.repositories, 'team-1', 'mem-2')).toBe('active');
    } finally {
      harness.close();
    }
  });

  test('keeps a multi-source memory on partial invalidation, expires only when the whole batch clears it', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-3',
        sources: [{ sourceKind: 'message', sourceId: 'msg-1' }, { sourceKind: 'message', sourceId: 'msg-2' }],
      });
      // 仅失效一个来源：还剩 msg-2，保留（读取侧懒检查兜底 msg-1 不可用）。
      await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1'],
      });
      expect(await getStatus(harness.repositories, 'team-1', 'mem-3')).toBe('active');
      // 整批失效全部来源才主动过期。
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1', 'msg-2'],
      });
      expect(result.expiredMemoryIds).toEqual(['mem-3']);
      expect(await getStatus(harness.repositories, 'team-1', 'mem-3')).toBe('expired');
    } finally {
      harness.close();
    }
  });

  test('skips memories that are already terminal', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-superseded', status: 'superseded',
        sources: [{ sourceKind: 'message', sourceId: 'msg-1' }],
      });
      await seedMemory(harness.repositories, {
        memoryId: 'mem-candidate', status: 'candidate',
        sources: [{ sourceKind: 'message', sourceId: 'msg-2' }],
      });
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1', 'msg-2'],
      });
      // superseded 已终态，跳过；candidate 仍可迁移到 expired。
      expect(result.expiredMemoryIds).toEqual(['mem-candidate']);
      expect(await getStatus(harness.repositories, 'team-1', 'mem-superseded')).toBe('superseded');
      expect(await getStatus(harness.repositories, 'team-1', 'mem-candidate')).toBe('expired');
    } finally {
      harness.close();
    }
  });

  test('invalidates many source ids across memories in one call', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-a', sources: [{ sourceKind: 'task', sourceId: 'task-1' }],
      });
      await seedMemory(harness.repositories, {
        memoryId: 'mem-b', sources: [{ sourceKind: 'task', sourceId: 'task-2' }],
      });
      await seedMemory(harness.repositories, {
        memoryId: 'mem-c',
        sources: [{ sourceKind: 'task', sourceId: 'task-3' }, { sourceKind: 'task', sourceId: 'task-4' }],
      });
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'task' as MemorySourceKind, sourceIds: ['task-1', 'task-2', 'task-3'],
      });
      expect([...result.expiredMemoryIds].sort()).toEqual(['mem-a', 'mem-b']);
      // mem-c 仍有 task-4，保留。
      expect(await getStatus(harness.repositories, 'team-1', 'mem-c')).toBe('active');
    } finally {
      harness.close();
    }
  });

  test('fails closed across Team boundaries', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        teamId: 'team-1', memoryId: 'mem-x',
        sources: [{ sourceKind: 'message', sourceId: 'shared-msg' }],
      });
      // 跨 Team 失效不应触及 team-1 的 memory。
      const result = await harness.service.invalidateSources({
        teamId: 'team-2', sourceKind: 'message', sourceIds: ['shared-msg'],
      });
      expect(result.expiredMemoryIds).toEqual([]);
      expect(await getStatus(harness.repositories, 'team-1', 'mem-x')).toBe('active');
    } finally {
      harness.close();
    }
  });

  test('returns an empty result when nothing references the source', async () => {
    const harness = createHarness();
    try {
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['orphan-msg'],
      });
      expect(result.expiredMemoryIds).toEqual([]);
    } finally {
      harness.close();
    }
  });
});
