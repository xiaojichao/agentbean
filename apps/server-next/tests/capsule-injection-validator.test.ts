import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type { MemoryCapsuleDto, MemoryItemRecord, ServerNextRepositories } from '../src/index.js';
import { createCapsuleInjectionValidator } from '../src/application/capsule-injection-validator.js';
import { createMemoryCapsuleService } from '../src/application/memory-capsule-service.js';
import {
  createCollaborativeMemorySearchService,
  type MemorySearchPermissions,
  type MemoryScopeVisibility,
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

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly capsuleService: ReturnType<typeof createMemoryCapsuleService>;
  readonly validator: ReturnType<typeof createCapsuleInjectionValidator>;
  readonly permissions: { scopeVisibility: MemoryScopeVisibility; sourceAvailable: boolean };
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  let counter = 0;
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `id-${++counter}` };
  // 可翻转的权限：默认全可见 + 来源可用；测试改 scopeVisibility/sourceAvailable 触发 deny。
  const permissionsState = { scopeVisibility: 'visible' as MemoryScopeVisibility, sourceAvailable: true };
  const permissions: MemorySearchPermissions = {
    async canSearchTeam() { return true; },
    async evaluateScopeVisibility() { return permissionsState.scopeVisibility; },
    async isSourceAvailable() { return permissionsState.sourceAvailable; },
  };
  const searchService = createCollaborativeMemorySearchService({ repositories: repositories.memory, permissions });
  return {
    repositories,
    capsuleService: createMemoryCapsuleService({ searchService, unitOfWork: repositories.memoryUnitOfWork, clock, ids }),
    validator: createCapsuleInjectionValidator({ unitOfWork: repositories.memoryUnitOfWork, permissions, ids }),
    permissions: permissionsState,
    close() {},
  };
}

async function seedMemory(repositories: ServerNextRepositories, memoryId: string, content = `content ${memoryId}`): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    const item: MemoryItemRecord = {
      schemaVersion: 1, id: memoryId, teamId: 'team-1', kind: 'decision', status: 'active',
      scopeType: 'team', scopeRef: 'team-1', content, summary: 's',
      createdByUserId: 'user-1', approvedByUserId: 'user-1', validFrom: 1, createdAt: 1, updatedAt: 1,
    };
    await memory.items.create(item);
    await memory.sources.create({
      memoryId, teamId: 'team-1', sourceKind: 'message', sourceId: `${memoryId}-msg`,
      snapshotHash: `sha256:${memoryId}-msg`, sourceScopeType: 'team', sourceScopeRef: 'team-1',
      sourceVisibility: 'team', createdAt: 1,
    });
  });
}

/** 直接改 memory 内容/状态（绕过 service，模拟创建 capsule 之后的外部变化）。 */
async function mutateMemory(
  repositories: ServerNextRepositories,
  memoryId: string,
  change: (item: MemoryItemRecord) => MemoryItemRecord,
): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    const item = await memory.items.getById({ teamId: 'team-1', id: memoryId });
    if (!item) throw new Error('seed memory missing');
    const next = { ...change(item), updatedAt: item.updatedAt + 1 };
    const updated = await memory.items.update({ record: next, expectedUpdatedAt: item.updatedAt });
    if (!updated) throw new Error('memory update failed');
  });
}

async function addSource(repositories: ServerNextRepositories, memoryId: string): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    await memory.sources.create({
      memoryId, teamId: 'team-1', sourceKind: 'task', sourceId: `${memoryId}-extra-task`,
      snapshotHash: 'sha256:extra', sourceScopeType: 'team', sourceScopeRef: 'team-1',
      sourceVisibility: 'team', createdAt: 99,
    });
  });
}

const BASE_POLICY_VERSION = 7;

describe.each([
  ['memory', () => ({ ...makeHarness(createInMemoryRepositories()), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { ...makeHarness(createSqliteRepositories({ globalDb: db, teamDb: db })), close: () => db.close() };
  }],
] as const)('Phase 3 Capsule injection revalidation (%s)', (_name, createHarness) => {
  test('allows a freshly-created, unmodified Capsule', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.capsuleExpired).toBe(false);
      expect(result.decisions).toHaveLength(capsule.items.length);
      expect(result.decisions.every((decision) => decision.allowed)).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('denies when the memory content drifted (CAPSULE_CONTENT_HASH_MISMATCH)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      await mutateMemory(harness.repositories, 'mem-1', (item) => ({ ...item, content: 'tampered content' }));
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.decisions.every((decision) => !decision.allowed)).toBe(true);
      expect(result.decisions.some((decision) => decision.reason === 'CAPSULE_CONTENT_HASH_MISMATCH')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('denies when sources drifted (CAPSULE_SOURCE_REFS_HASH_MISMATCH)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      await addSource(harness.repositories, 'mem-1');
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.decisions.some((decision) => decision.reason === 'CAPSULE_SOURCE_REFS_HASH_MISMATCH')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('denies non-active memories via fresh status (MEMORY_NOT_ACTIVE)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      // memory 被过期/替代/删除都使 status !== active，evaluateMemoryInjection 一律 MEMORY_NOT_ACTIVE。
      await mutateMemory(harness.repositories, 'mem-1', (item) => ({ ...item, status: 'expired' }));
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.decisions.some((d) => d.reason === 'MEMORY_NOT_ACTIVE')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('denies when a source is no longer available (MEMORY_SOURCE_UNAVAILABLE)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      harness.permissions.sourceAvailable = false;
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.decisions.some((d) => d.reason === 'MEMORY_SOURCE_UNAVAILABLE')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('denies when the scope now requires an explicit grant (CAPSULE_EXPLICIT_GRANT_REQUIRED)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      harness.permissions.scopeVisibility = 'explicit-grant';
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.decisions.some((d) => d.reason === 'CAPSULE_EXPLICIT_GRANT_REQUIRED')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('denies when the policy version is stale (CAPSULE_POLICY_VERSION_STALE)', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION + 1,
      });
      expect(result.decisions.some((d) => d.reason === 'CAPSULE_POLICY_VERSION_STALE')).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('rejects the whole Capsule when it is past expiry', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
        ttlMs: 1_000,
      });
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 5_000 + 2_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.capsuleExpired).toBe(true);
      expect(result.decisions.every((d) => d.reason === 'CAPSULE_EXPIRED')).toBe(true);
      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'capsule', subjectId: capsule.id,
      });
      expect(audit.map((event) => event.eventType)).toContain('capsule-expired');
    } finally {
      harness.close();
    }
  });

  test('writes body-free capsule-denied audit for each rejected item', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1');
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      await mutateMemory(harness.repositories, 'mem-1', (item) => ({ ...item, content: 'tampered' }));
      await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'capsule', subjectId: capsule.id,
      });
      const denied = audit.filter((event) => event.eventType === 'capsule-denied');
      expect(denied.length).toBeGreaterThan(0);
      expect(denied[0]).not.toHaveProperty('content');
      expect(denied[0]).not.toHaveProperty('body');
    } finally {
      harness.close();
    }
  });

  test('denies a Capsule item whose memory no longer exists (MEMORY_NOT_FOUND)', async () => {
    const harness = createHarness();
    try {
      // 手工构造一个指向不存在 memoryId 的 capsule item。
      const capsule: MemoryCapsuleDto = {
        schemaVersion: 1, id: 'cap-ghost', teamId: 'team-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', createdAt: 5_000, expiresAt: 1_000_000,
        items: [{
          schemaVersion: 1, memoryId: 'never-existed', scopeType: 'team', scopeRef: 'team-1',
          sourceVisibility: 'team', contentKind: 'decision', redactionLevel: 'none', content: 'x',
          sourceRefs: [{ schemaVersion: 1, sourceKind: 'message', sourceId: 'm', snapshotHash: 'sha256:m' }],
          expiresAt: 1_000_000,
          authorization: {
            schemaVersion: 1, decisionId: 'dec-1', mode: 'scope-policy', policyVersion: BASE_POLICY_VERSION,
            targetAgentId: 'agent-1', sourceScopeType: 'team', sourceScopeRef: 'team-1',
            sourceRefsHash: 'sha256:frozen', contentHash: 'sha256:frozen', authorizedContentKind: 'decision',
            authorizedRedactionLevel: 'none', issuedAt: 5_000, expiresAt: 1_000_000,
          },
        }],
      };
      const result = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: BASE_POLICY_VERSION,
      });
      expect(result.decisions.every((d) => d.reason === 'MEMORY_NOT_FOUND')).toBe(true);
    } finally {
      harness.close();
    }
  });
});
