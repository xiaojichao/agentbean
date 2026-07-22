import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { ServerNextRepositories } from '../src/index.js';
import {
  createCollaborativeMemoryService,
  type MemoryPermissions,
} from '../src/application/collaborative-memory-service.js';
import { createFormalMemoryService } from '../src/application/formal-memory-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

/** 默认放行的权限 collaborator；测试可覆盖 assertWriteAuthority 模拟拒绝。 */
function permissivePermissions(): MemoryPermissions {
  return {
    assertWriteAuthority: async () => undefined,
    assertSourceAuthority: async () => undefined,
    assertGrantAuthority: async () => undefined,
  };
}

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly collaborative: ReturnType<typeof createCollaborativeMemoryService>;
  readonly formal: ReturnType<typeof createFormalMemoryService>;
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  let counter = 0;
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `id-${++counter}` };
  const collaborative = createCollaborativeMemoryService({
    unitOfWork: repositories.memoryUnitOfWork,
    permissions: permissivePermissions(),
    clock,
    ids,
  });
  const formal = createFormalMemoryService({ repositories, collaborativeMemory: collaborative, clock });
  return { repositories, collaborative, formal, close() {} };
}

describe.each([
  ['memory', () => ({ ...makeHarness(createInMemoryRepositories()), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    const harness = makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db }));
    return { ...harness, close: () => db.close() };
  }],
] as const)('Phase 3 Formal Memory Service (%s)', (_name, createHarness) => {
  test('create writes formal_kind and initializes version_family_id to self id', async () => {
    const harness = createHarness();
    try {
      const dto = await harness.formal.create({
        teamId: 'team-1',
        actorId: 'user-1',
        kind: 'decision',
        scopeType: 'team',
        scopeRef: 'team-1',
        content: 'Adopt Node 24 for all packages',
        summary: 'runtime decision',
        tags: ['runtime'],
        changeReason: 'initial decision',
      });

      expect(dto.kind).toBe('decision');
      expect(dto.status).toBe('active');
      expect(dto.scopeType).toBe('team');
      expect(dto.versionFamilyId).toBe(dto.id);
      expect(dto.createdByUserId).toBe('user-1');
      expect(dto.changeReason).toBe('initial decision');

      // 底层存储 record 含 formalKind 与 versionFamilyId。
      const stored = await harness.repositories.memory.items.getById({ teamId: 'team-1', id: dto.id });
      expect(stored?.formalKind).toBe('decision');
      expect(stored?.versionFamilyId).toBe(dto.id);
    } finally {
      harness.close();
    }
  });

  test('create maps fact→semantic storage kind while projecting as fact', async () => {
    const harness = createHarness();
    try {
      const dto = await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'fact',
        scopeType: 'team', scopeRef: 'team-1', content: 'sky is blue',
      });
      expect(dto.kind).toBe('fact');
      const stored = await harness.repositories.memory.items.getById({ teamId: 'team-1', id: dto.id });
      // fact 适配到底层 semantic 存储 kind。
      expect(stored?.kind).toBe('semantic');
      expect(stored?.formalKind).toBe('fact');
    } finally {
      harness.close();
    }
  });

  test('revise supersedes old version, inherits version_family_id, records changeReason', async () => {
    const harness = createHarness();
    try {
      const created = await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'rule',
        scopeType: 'team', scopeRef: 'team-1', content: 'always squash merge',
      });
      const revised = await harness.formal.revise({
        teamId: 'team-1', actorId: 'user-2', memoryId: created.id,
        content: 'prefer rebase merge', summary: 'updated rule',
        changeReason: 'team voted for rebase',
      });

      // 新版本 active，继承版本族。
      expect(revised.status).toBe('active');
      expect(revised.versionFamilyId).toBe(created.versionFamilyId);
      expect(revised.id).not.toBe(created.id);
      expect(revised.changeReason).toBe('team voted for rebase');
      expect(revised.content).toBe('prefer rebase merge');

      // 旧版本被 superseded，指向新版本。
      const oldStored = await harness.repositories.memory.items.getById({ teamId: 'team-1', id: created.id });
      expect(oldStored?.status).toBe('superseded');
      expect(oldStored?.supersededById).toBe(revised.id);
    } finally {
      harness.close();
    }
  });

  test('getDetail returns version history with both versions ascending', async () => {
    const harness = createHarness();
    try {
      const created = await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'v1 decision',
      });
      const revised = await harness.formal.revise({
        teamId: 'team-1', actorId: 'user-1', memoryId: created.id,
        content: 'v2 decision', changeReason: 'revised',
      });

      const detail = await harness.formal.getDetail({ teamId: 'team-1', memoryId: revised.id });
      expect(detail.id).toBe(revised.id);
      expect(detail.versions).toHaveLength(2);
      // 升序：v1 在前，v2 在后。
      expect(detail.versions[0].content).toBe('v1 decision');
      expect(detail.versions[0].status).toBe('superseded');
      expect(detail.versions[1].content).toBe('v2 decision');
      expect(detail.versions[1].status).toBe('active');
    } finally {
      harness.close();
    }
  });

  test('getDetail throws FORMAL_MEMORY_NOT_FOUND for missing or non-formal memory', async () => {
    const harness = createHarness();
    try {
      await expect(harness.formal.getDetail({ teamId: 'team-1', memoryId: 'missing' }))
        .rejects.toThrow(/FORMAL_MEMORY_NOT_FOUND/);

      // 非 formal memory（无 formalKind）也应拒绝。
      const nonFormal = await harness.collaborative.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'episodic',
        scopeType: 'team', scopeRef: 'team-1', content: 'an episodic note',
      });
      await expect(harness.formal.getDetail({ teamId: 'team-1', memoryId: nonFormal.item.id }))
        .rejects.toThrow(/FORMAL_MEMORY_NOT_FOUND/);
    } finally {
      harness.close();
    }
  });

  test('deactivate marks status=expired with changeReason', async () => {
    const harness = createHarness();
    try {
      const created = await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'preference',
        scopeType: 'team', scopeRef: 'team-1', content: 'prefer dark mode',
      });
      const deactivated = await harness.formal.deactivate({
        teamId: 'team-1', actorId: 'user-1', memoryId: created.id,
        changeReason: 'no longer relevant',
      });
      expect(deactivated.status).toBe('expired');
      expect(deactivated.changeReason).toBe('no longer relevant');
    } finally {
      harness.close();
    }
  });

  test('delete marks status=deleted', async () => {
    const harness = createHarness();
    try {
      const created = await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'fact',
        scopeType: 'team', scopeRef: 'team-1', content: 'temporary fact',
      });
      const deleted = await harness.formal.delete({
        teamId: 'team-1', actorId: 'user-1', memoryId: created.id,
        changeReason: 'wrong info',
      });
      expect(deleted.status).toBe('deleted');
      expect(deleted.changeReason).toBe('wrong info');
    } finally {
      harness.close();
    }
  });

  test('list returns only formal_kind rows and excludes non-formal memory', async () => {
    const harness = createHarness();
    try {
      await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'formal decision',
      });
      await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'rule',
        scopeType: 'team', scopeRef: 'team-1', content: 'formal rule',
      });
      // 非 formal 协作记忆，不应出现在 formal 列表中。
      await harness.collaborative.createMemory({
        teamId: 'team-1', actorId: 'user-1', kind: 'episodic',
        scopeType: 'team', scopeRef: 'team-1', content: 'casual episodic note',
      });

      const items = await harness.formal.list({
        teamId: 'team-1', scopeType: 'team', scopeRef: 'team-1',
      });
      expect(items).toHaveLength(2);
      expect(items.map((item) => item.kind).sort()).toEqual(['decision', 'rule']);
    } finally {
      harness.close();
    }
  });

  test('list with channel scope returns only that scope formal items', async () => {
    const harness = createHarness();
    try {
      await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'fact',
        scopeType: 'channel', scopeRef: 'channel-1', content: 'channel fact',
      });
      await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'fact',
        scopeType: 'team', scopeRef: 'team-1', content: 'team fact',
      });

      const channelItems = await harness.formal.list({
        teamId: 'team-1', scopeType: 'channel', scopeRef: 'channel-1',
      });
      expect(channelItems).toHaveLength(1);
      expect(channelItems[0].channelId).toBe('channel-1');

      const teamItems = await harness.formal.list({
        teamId: 'team-1', scopeType: 'team', scopeRef: 'team-1',
      });
      expect(teamItems).toHaveLength(1);
      expect(teamItems[0].channelId).toBeUndefined();
    } finally {
      harness.close();
    }
  });

  test('proposeCorrection creates a candidate with changeReason and status=candidate', async () => {
    const harness = createHarness();
    try {
      const target = await harness.formal.create({
        teamId: 'team-1', actorId: 'user-1', kind: 'decision',
        scopeType: 'team', scopeRef: 'team-1', content: 'original decision',
      });
      const candidate = await harness.formal.proposeCorrection({
        teamId: 'team-1', actorId: 'user-2',
        scopeType: 'team', scopeRef: 'team-1',
        targetMemoryId: target.id,
        correctionType: 'revise',
        kind: 'decision',
        content: 'corrected decision',
        reason: 'original is outdated',
      });

      expect(candidate.status).toBe('candidate');
      expect(candidate.changeReason).toBe('original is outdated');
      expect(candidate.kind).toBe('decision');
      expect(candidate.createdByUserId).toBe('user-2');

      // candidate 来源应关联到被纠错的目标 memory。
      const stored = await harness.repositories.memory.items.getById({ teamId: 'team-1', id: candidate.id });
      expect(stored?.formalKind).toBe('decision');
    } finally {
      harness.close();
    }
  });

  test('proposeCorrection without kind defaults to semantic storage', async () => {
    const harness = createHarness();
    try {
      const candidate = await harness.formal.proposeCorrection({
        teamId: 'team-1', actorId: 'user-1',
        scopeType: 'team', scopeRef: 'team-1',
        correctionType: 'delete',
        targetMemoryId: undefined,
        content: 'please delete this',
        reason: 'spam',
      });
      expect(candidate.status).toBe('candidate');
      const stored = await harness.repositories.memory.items.getById({ teamId: 'team-1', id: candidate.id });
      // 无 kind → 默认 semantic 存储；formalKind 为 undefined（delete 申请不强制 kind）。
      expect(stored?.kind).toBe('semantic');
    } finally {
      harness.close();
    }
  });
});
