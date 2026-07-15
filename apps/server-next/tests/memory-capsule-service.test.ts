import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { MemoryCapsuleDto, MemorySourceRefDto } from '../src/index.js';
import type { MemoryItemRecord, MemorySourceRecord, ServerNextRepositories } from '../src/index.js';
import { createMemoryCapsuleService } from '../src/application/memory-capsule-service.js';
import {
  createCollaborativeMemorySearchService,
  type MemorySearchPermissions,
} from '../src/application/collaborative-memory-search-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const permissiveSearchPermissions: MemorySearchPermissions = {
  async canSearchTeam() { return true; },
  async evaluateScopeVisibility() { return 'visible'; },
  async isSourceAvailable() { return true; },
};

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly capsuleService: ReturnType<typeof createMemoryCapsuleService>;
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  let counter = 0;
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `id-${++counter}` };
  const searchService = createCollaborativeMemorySearchService({
    repositories: repositories.memory,
    permissions: permissiveSearchPermissions,
  });
  return {
    repositories,
    capsuleService: createMemoryCapsuleService({ searchService, unitOfWork: repositories.memoryUnitOfWork, clock, ids }),
    close() {},
  };
}

interface SeedMemoryInput {
  readonly teamId?: string;
  readonly memoryId: string;
  readonly status?: MemoryItemRecord['status'];
  readonly scopeType?: MemoryItemRecord['scopeType'];
  readonly scopeRef?: string;
  readonly content?: string;
  readonly summary?: string;
  readonly validUntil?: number;
  readonly sources?: ReadonlyArray<Pick<MemorySourceRecord, 'sourceKind' | 'sourceId'> & {
    readonly snapshotHash?: string;
    readonly sourceScopeType?: MemorySourceRecord['sourceScopeType'];
    readonly sourceScopeRef?: string;
    readonly sourceVisibility?: MemorySourceRecord['sourceVisibility'];
  }>;
}

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
      content: input.content ?? `decision ${input.memoryId}`,
      summary: input.summary,
      createdByUserId: 'user-1',
      approvedByUserId: 'user-1',
      validFrom: 1,
      validUntil: input.validUntil,
      createdAt: 1,
      updatedAt: 1,
    };
    await memory.items.create(item);
    for (const source of input.sources ?? [{ sourceKind: 'message', sourceId: `${input.memoryId}-msg` }]) {
      await memory.sources.create({
        memoryId: item.id,
        teamId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        snapshotHash: source.snapshotHash ?? `sha256:${source.sourceId}`,
        sourceScopeType: source.sourceScopeType ?? item.scopeType,
        sourceScopeRef: source.sourceScopeRef ?? item.scopeRef,
        sourceVisibility: source.sourceVisibility ?? 'team',
        createdAt: 1,
      });
    }
  });
}

const hashContent = (content: string) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
const hashSourceRefs = (refs: readonly MemorySourceRefDto[]) =>
  `sha256:${createHash('sha256').update(
    [...refs].map((ref) => `${ref.sourceKind}:${ref.sourceId}:${ref.snapshotHash}`).sort().join('|'),
  ).digest('hex')}`;

describe.each([
  ['memory', () => ({ ...makeHarness(createInMemoryRepositories()), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { ...makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db })), close: () => db.close() };
  }],
] as const)('Phase 3 Memory Capsule creation (%s)', (_name, createHarness) => {
  test('packages scope-policy matches into a bound, authorized, audited Capsule', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, { memoryId: 'mem-1', content: 'Use Node 24' });
      await seedMemory(harness.repositories, { memoryId: 'mem-2', content: 'Prefer tabs' });

      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'runtime', limit: 10, now: 5_000, currentPolicyVersion: 7,
      });

      expect(capsule.items).toHaveLength(2);
      expect(capsule.teamId).toBe('team-1');
      expect(capsule.managementRunId).toBe('run-1');
      expect(capsule.targetAgentId).toBe('agent-1');
      expect(capsule.expiresAt).toBeGreaterThan(5_000);

      const item = capsule.items[0]!;
      expect(item.authorization.mode).toBe('scope-policy');
      expect(item.authorization.policyVersion).toBe(7);
      expect(item.authorization.targetAgentId).toBe('agent-1');
      expect(item.authorization.sourceScopeType).toBe(item.scopeType);
      expect(item.authorization.authorizedRedactionLevel).toBe('none');
      // 授权快照必须与脱敏后内容 / 来源指纹自洽（P3-07 复验会逐字段比对）。
      expect(item.authorization.contentHash).toBe(hashContent(item.content));
      expect(item.authorization.sourceRefsHash).toBe(hashSourceRefs(item.sourceRefs));
      expect(item.redactionLevel).toBe('none');
      expect(item.sourceVisibility).toBe('team');

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'capsule', subjectId: capsule.id,
      });
      expect(audit).toHaveLength(capsule.items.length);
      const itemAudit = audit.find((event) => event.decisionId === item.authorization.decisionId)!;
      expect(itemAudit.eventType).toBe('capsule-created');
      expect(itemAudit.actorKind).toBe('system');
      expect(itemAudit.targetAgentId).toBe('agent-1');
      expect(itemAudit.scopeType).toBe(item.scopeType);
      expect(itemAudit.scopeRef).toBe(item.scopeRef);
      expect(itemAudit.sourceRefs).toEqual(item.sourceRefs);
      expect(itemAudit.sourceRefsHash).toBe(item.authorization.sourceRefsHash);
      expect(itemAudit.contentHash).toBe(item.authorization.contentHash);
      expect(itemAudit.redactionLevel).toBe(item.redactionLevel);
      // 审计同样不携带敏感正文。
      expect(itemAudit).not.toHaveProperty('content');
    } finally {
      harness.close();
    }
  });

  test('excludes non-active memories (search already filters them)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, { memoryId: 'mem-active', content: 'active one' });
      await seedMemory(harness.repositories, { memoryId: 'mem-expired', status: 'expired', content: 'expired one' });
      await seedMemory(harness.repositories, { memoryId: 'mem-cand', status: 'candidate', content: 'candidate one' });

      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: 1,
      });
      expect(capsule.items.map((item) => item.memoryId)).toEqual(['mem-active']);
    } finally {
      harness.close();
    }
  });

  test('filters explicit-grant matches before applying the Capsule limit', async () => {
    // dm scope 在最小 Capsule 里要求 explicit-grant，本片只打包 scope-policy。
    const searchPermissions: MemorySearchPermissions = {
      async canSearchTeam() { return true; },
      async evaluateScopeVisibility(input) {
        return input.scopeType === 'dm' ? 'explicit-grant' : 'visible';
      },
      async isSourceAvailable() { return true; },
    };
    const repositories = createInMemoryRepositories();
    let tick = 1_000;
    let counter = 0;
    const searchService = createCollaborativeMemorySearchService({ repositories: repositories.memory, permissions: searchPermissions });
    const capsuleService = createMemoryCapsuleService({
      searchService, unitOfWork: repositories.memoryUnitOfWork,
      clock: { now: () => (tick += 1_000) }, ids: { nextId: () => `id-${++counter}` },
    });

    await seedMemory(repositories, { memoryId: 'mem-team', scopeType: 'team', scopeRef: 'team-1', content: 'team fact' });
    await seedMemory(repositories, { memoryId: 'mem-dm', scopeType: 'dm', scopeRef: 'dm-1', content: 'dm secret' });
    // dm 需要一个 active grant 才能被 search 判为 explicit-grant match。
    await repositories.memoryUnitOfWork.run(async (memory) => {
      await memory.grants.create({
        id: 'grant-dm', version: 1, teamId: 'team-1', sourceScopeType: 'dm', sourceScopeRef: 'dm-1',
        targetAgentId: 'agent-1', authorizedContentKind: 'decision', authorizedRedactionLevel: 'none',
        status: 'active', issuedByUserId: 'user-1', issuedAt: 1, expiresAt: 1_000_000,
      });
    });

    const capsule: MemoryCapsuleDto = await capsuleService.createCapsule({
      teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
      targetAgentId: 'agent-1', prompt: 'dm secret', limit: 1, now: 5_000, currentPolicyVersion: 1,
    });
    expect(capsule.items.map((item) => item.memoryId)).toEqual(['mem-team']);
    expect(capsule.items.every((item) => item.authorization.mode === 'scope-policy')).toBe(true);
  });

  test('fails closed for DM scope and non-team source visibility without an explicit grant', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-private-source', scopeType: 'task', scopeRef: 'task-1',
        sources: [{
          sourceKind: 'message', sourceId: 'private-message', sourceScopeType: 'channel',
          sourceScopeRef: 'private-channel', sourceVisibility: 'private',
        }],
      });
      await seedMemory(harness.repositories, {
        memoryId: 'mem-dm-scope', scopeType: 'dm', scopeRef: 'dm-1',
        sources: [{
          sourceKind: 'message', sourceId: 'dm-message', sourceScopeType: 'dm',
          sourceScopeRef: 'dm-1', sourceVisibility: 'team',
        }],
      });

      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1', taskId: 'task-1',
        channelId: 'dm-1', targetAgentId: 'agent-1', prompt: 'decision', limit: 10,
        now: 5_000, currentPolicyVersion: 1,
      });
      expect(capsule.items).toEqual([]);
    } finally {
      harness.close();
    }
  });

  test('caps Capsule and item authorization expiry at the earliest Memory validity', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, { memoryId: 'mem-short', validUntil: 6_000 });
      await seedMemory(harness.repositories, { memoryId: 'mem-long', validUntil: 20_000 });

      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'decision', limit: 10, now: 5_000,
        currentPolicyVersion: 1, ttlMs: 30_000,
      });
      expect(capsule.expiresAt).toBe(6_000);
      expect(capsule.items.every((item) => item.expiresAt === 6_000)).toBe(true);
      expect(capsule.items.every((item) => item.authorization.expiresAt === 6_000)).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('respects the limit after ranking', async () => {
    const harness = createHarness();
    try {
      for (const id of ['mem-a', 'mem-b', 'mem-c']) {
        await seedMemory(harness.repositories, { memoryId: id, content: `decision ${id}` });
      }
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'decision', limit: 2, now: 5_000, currentPolicyVersion: 1,
      });
      expect(capsule.items.length).toBeLessThanOrEqual(2);
    } finally {
      harness.close();
    }
  });

  test('returns an empty (but audited) Capsule when nothing matches', async () => {
    const harness = createHarness();
    try {
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'nothing here', limit: 10, now: 5_000, currentPolicyVersion: 1,
      });
      expect(capsule.items).toEqual([]);
      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'capsule', subjectId: capsule.id,
      });
      expect(audit.map((event) => event.eventType)).toContain('capsule-created');
    } finally {
      harness.close();
    }
  });
});
