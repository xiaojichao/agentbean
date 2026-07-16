import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type {
  MemoryItemRecord,
  MemorySourceKind,
  MemorySourceRecord,
  ServerNextRepositories,
} from '../src/index.js';
import { createMemorySourceInvalidationService } from '../src/application/memory-source-invalidation-service.js';
import { createMemoryGovernanceService } from '../src/application/memory-governance-service.js';
import { createCapsuleInjectionValidator } from '../src/application/capsule-injection-validator.js';
import { createMemoryCapsuleService } from '../src/application/memory-capsule-service.js';
import { createServerMemorySearchPermissions } from '../src/application/server-memory-permissions.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import {
  createCollaborativeMemorySearchService,
  type MemorySearchPermissions,
} from '../src/application/collaborative-memory-search-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

// P3-15 来源失效 E2E 闭环：验证 spec §16.4「无可用来源不得注入」的端到端链路——
// 真实删除 usecase → invalidateSources → memory 过期 → production permissions 复验拒绝。
// 同时把 source-invalidation-service / capsule-injection-validator 串到同一组 repositories，
// 覆盖多来源分次失效和部分失效时的 fail-closed 语义。

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

interface Harness {
  readonly repositories: ServerNextRepositories;
  readonly capsuleService: ReturnType<typeof createMemoryCapsuleService>;
  readonly validator: ReturnType<typeof createCapsuleInjectionValidator>;
  readonly invalidationService: ReturnType<typeof createMemorySourceInvalidationService>;
  readonly markSourceUnavailable: (sourceKind: MemorySourceKind, sourceId: string) => void;
  readonly close(): void;
}

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  let counter = 0;
  const unavailableSources = new Set<string>();
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `id-${++counter}` };
  // 两个 service 的 isSourceAvailable 入参形状不同：source-invalidation 用 flat（sourceKind/sourceId 顶层），
  // capsule-injection 用 wrapper（source: MemorySourceRecord 嵌套）。共享 unavailableSources 保证闭环一致。
  const isUnavailable = (sourceKind: MemorySourceKind, sourceId: string) =>
    unavailableSources.has(`${sourceKind}:${sourceId}`);
  const permissions: MemorySearchPermissions = {
    async canSearchTeam() { return true; },
    async evaluateScopeVisibility() { return 'visible'; },
    async isSourceAvailable(input) {
      return !isUnavailable(input.source.sourceKind, input.source.sourceId);
    },
  };
  const searchService = createCollaborativeMemorySearchService({ repositories: repositories.memory, permissions });
  return {
    repositories,
    capsuleService: createMemoryCapsuleService({ searchService, unitOfWork: repositories.memoryUnitOfWork, clock, ids }),
    validator: createCapsuleInjectionValidator({ unitOfWork: repositories.memoryUnitOfWork, permissions, ids }),
    invalidationService: createMemorySourceInvalidationService({
      unitOfWork: repositories.memoryUnitOfWork, clock, ids,
      isSourceAvailable: async (input: { sourceKind: MemorySourceKind; sourceId: string }) =>
        !isUnavailable(input.sourceKind, input.sourceId),
    }),
    markSourceUnavailable: (sourceKind, sourceId) => unavailableSources.add(`${sourceKind}:${sourceId}`),
    close() {},
  };
}

async function seedMemory(
  repositories: ServerNextRepositories,
  memoryId: string,
  sources: ReadonlyArray<Pick<MemorySourceRecord, 'sourceKind' | 'sourceId'>>,
  identity: { readonly teamId: string; readonly userId: string } = { teamId: 'team-1', userId: 'user-1' },
): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    const item: MemoryItemRecord = {
      schemaVersion: 1, id: memoryId, teamId: identity.teamId, kind: 'decision', status: 'active',
      scopeType: 'team', scopeRef: identity.teamId, content: `content ${memoryId}`, summary: 's',
      createdByUserId: identity.userId, approvedByUserId: identity.userId,
      validFrom: 1, createdAt: 1, updatedAt: 1,
    };
    await memory.items.create(item);
    for (const source of sources) {
      await memory.sources.create({
        memoryId, teamId: identity.teamId, sourceKind: source.sourceKind, sourceId: source.sourceId,
        snapshotHash: `sha256:${source.sourceId}`, sourceScopeType: 'team', sourceScopeRef: identity.teamId,
        sourceVisibility: 'team', createdAt: 1,
      });
    }
  });
}

const POLICY_VERSION = 7;

describe.each([
  ['memory', () => ({ ...makeHarness(createInMemoryRepositories()), close() {} })],
  ['sqlite', () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    return {
      ...makeHarness(createSqliteRepositories({ globalDb, teamDb })),
      close: () => {
        globalDb.close();
        teamDb.close();
      },
    };
  }],
] as const)('P3-15 来源失效 E2E 闭环 (%s)', (_name, createHarness) => {
  test('真实 message 删除 usecase→memory 过期→production capsule inject 拒绝', async () => {
    const harness = createHarness();
    try {
      let counter = 0;
      let now = 1_000;
      const clock = { now: () => ++now };
      const ids = { nextId: () => `production-${++counter}` };
      const app = createServerNextUseCases({ repositories: harness.repositories, clock, ids });
      const registered = await app.registerUser({
        username: `owner-${_name}`,
        password: 'secret',
        teamName: 'Team',
      });
      if (!registered.ok) throw new Error(`register failed: ${registered.error}`);
      const userId = registered.user.id;
      const teamId = registered.currentTeam.id;
      const channelId = registered.defaultChannel.id;
      await harness.repositories.agents.upsert({
        id: 'agent-production',
        primaryTeamId: teamId,
        visibleTeamIds: [teamId],
        name: 'Production Agent',
        adapterKind: 'codex',
        category: 'executor-hosted',
        source: 'custom',
        status: 'online',
      });
      await harness.repositories.messages.append({
        id: 'message-production',
        teamId,
        channelId,
        senderKind: 'human',
        senderId: userId,
        body: 'production source',
        createdAt: 1,
      });
      await seedMemory(
        harness.repositories,
        'mem-production',
        [{ sourceKind: 'message', sourceId: 'message-production' }],
        { teamId, userId },
      );
      await harness.repositories.memory.candidates.create({
        schemaVersion: 1, id: 'candidate-production', teamId, managementRunId: 'run-production',
        sourceAgentId: 'agent-production', sourceInvocationId: 'invocation-production',
        targetAgentId: 'agent-production', scopeType: 'team', scopeRef: teamId,
        contentKind: 'fact', proposedContent: 'production candidate',
        projectionHash: 'sha256:candidate-production', status: 'candidate', conflictMemoryIds: [],
        createdAt: 1, updatedAt: 1,
      });
      await harness.repositories.memory.candidateSources.create({
        candidateId: 'candidate-production', teamId, sourceKind: 'message', sourceId: 'message-production',
        snapshotHash: 'sha256:message-production', sourceScopeType: 'team', sourceScopeRef: teamId,
        sourceVisibility: 'team', createdAt: 1,
      });

      const permissions = createServerMemorySearchPermissions(harness.repositories);
      const searchService = createCollaborativeMemorySearchService({
        repositories: harness.repositories.memory,
        permissions,
      });
      const capsuleService = createMemoryCapsuleService({
        searchService,
        unitOfWork: harness.repositories.memoryUnitOfWork,
        clock,
        ids,
      });
      const validator = createCapsuleInjectionValidator({
        unitOfWork: harness.repositories.memoryUnitOfWork,
        permissions,
        ids,
      });
      const capsule = await capsuleService.createCapsule({
        teamId,
        requesterUserId: userId,
        managementRunId: 'run-production',
        targetAgentId: 'agent-production',
        prompt: 'production',
        limit: 10,
        now: 5_000,
        currentPolicyVersion: POLICY_VERSION,
      });
      expect(capsule.items).toHaveLength(1);
      await expect(validator.validateCapsuleForInjection({
        capsule,
        requesterUserId: userId,
        now: 5_000,
        currentPolicyVersion: POLICY_VERSION,
      })).resolves.toMatchObject({ decisions: [{ memoryId: 'mem-production', allowed: true }] });

      const deleted = await app.deleteMessage({ userId, teamId, messageId: 'message-production' });
      if (!deleted.ok) throw new Error(`message delete failed: ${deleted.error}`);
      await expect(harness.repositories.memory.items.getById({ teamId, id: 'mem-production' }))
        .resolves.toMatchObject({ status: 'expired' });
      await expect(harness.repositories.memory.candidates.getById({ teamId, id: 'candidate-production' }))
        .resolves.toMatchObject({ status: 'rejected', decidedBy: 'system' });
      // 模拟进程重启后重新创建 governance service：Candidate 只能作为终态历史出现，不能恢复为未决。
      const recoveredSnapshot = await createMemoryGovernanceService({ repositories: harness.repositories, clock })
        .getSnapshot({ teamId, userId });
      expect(recoveredSnapshot.candidates).toMatchObject([{
        id: 'candidate-production', status: 'rejected', sourceState: 'source-invalid',
      }]);
      await expect(validator.validateCapsuleForInjection({
        capsule,
        requesterUserId: userId,
        now: 6_000,
        currentPolicyVersion: POLICY_VERSION,
      })).resolves.toMatchObject({
        decisions: [{
          memoryId: 'mem-production',
          allowed: false,
          reason: 'MEMORY_SOURCE_UNAVAILABLE',
        }],
      });
    } finally {
      harness.close();
    }
  });

  test('单来源 memory：删除来源→memory 过期→capsule inject 拒绝（spec §16.4）', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-1', [{ sourceKind: 'message', sourceId: 'msg-1' }]);
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(capsule.items).toHaveLength(1);
      // baseline：失效前 capsule inject 通过。
      const before = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 5_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(before.decisions.every((decision) => decision.allowed)).toBe(true);

      // 删除来源 → memory 过期。
      harness.markSourceUnavailable('message', 'msg-1');
      const invalidation = await harness.invalidationService.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1'], actorId: 'user-1',
      });
      expect(invalidation.expiredMemoryIds).toEqual(['mem-1']);

      // inject 复验拒绝（来源不可用 / memory 已过期）。
      const after = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(after.decisions.every((decision) => !decision.allowed)).toBe(true);
      expect(after.decisions.some((decision) => /SOURCE_UNAVAILABLE|NOT_ACTIVE|EXPIRED/.test(decision.reason ?? ''))).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('多来源 memory：全部来源分次删除→memory 过期→inject 拒绝（部分失效时仍 active）', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-2', [
        { sourceKind: 'message', sourceId: 'msg-a' },
        { sourceKind: 'task', sourceId: 'task-a' },
      ]);
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(capsule.items).toHaveLength(1);
      const before = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 5_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(before.decisions.every((decision) => decision.allowed)).toBe(true);

      // 失效第一个来源 → memory 仍 active（还有 task 来源）。
      harness.markSourceUnavailable('message', 'msg-a');
      const first = await harness.invalidationService.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-a'], actorId: 'user-1',
      });
      expect(first.expiredMemoryIds).toEqual([]);

      // 失效第二个来源 → memory 过期。
      harness.markSourceUnavailable('task', 'task-a');
      const second = await harness.invalidationService.invalidateSources({
        teamId: 'team-1', sourceKind: 'task', sourceIds: ['task-a'], actorId: 'user-1',
      });
      expect(second.expiredMemoryIds).toEqual(['mem-2']);

      const after = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 7_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(after.decisions.every((decision) => !decision.allowed)).toBe(true);
    } finally {
      harness.close();
    }
  });

  test('部分来源失效（memory 仍 active）→inject 仍拒绝（逐来源检查，spec §16.4 最严解读）', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, 'mem-3', [
        { sourceKind: 'message', sourceId: 'msg-x' },
        { sourceKind: 'task', sourceId: 'task-x' },
      ]);
      const capsule = await harness.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1',
        targetAgentId: 'agent-1', prompt: 'x', limit: 10, now: 5_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(capsule.items).toHaveLength(1);
      // 失效其中一个来源 → memory 仍 active（另一来源还在）。
      harness.markSourceUnavailable('message', 'msg-x');
      const invalidation = await harness.invalidationService.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-x'], actorId: 'user-1',
      });
      expect(invalidation.expiredMemoryIds).toEqual([]);

      // 但 inject 复验逐来源检查 → 任一来源不可用即拒（MEMORY_SOURCE_UNAVAILABLE）。
      const after = await harness.validator.validateCapsuleForInjection({
        capsule, requesterUserId: 'user-1', now: 6_000, currentPolicyVersion: POLICY_VERSION,
      });
      expect(after.decisions.every((decision) => !decision.allowed)).toBe(true);
      expect(after.decisions.some((decision) => decision.reason === 'MEMORY_SOURCE_UNAVAILABLE')).toBe(true);
    } finally {
      harness.close();
    }
  });
});
