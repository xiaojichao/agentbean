import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

import type {
  MemoryCandidateRecord,
  MemoryItemRecord,
  MemorySourceKind,
  MemorySourceRecord,
  ServerNextRepositories,
} from '../src/index.js';
import { createMemorySourceInvalidationService } from '../src/application/memory-source-invalidation-service.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
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
  readonly markSourceUnavailable: (sourceKind: MemorySourceKind, sourceId: string) => void;
  readonly close(): void;
}

const usecaseBackends = [
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    return {
      repositories: createSqliteRepositories({ globalDb, teamDb }),
      close: () => {
        globalDb.close();
        teamDb.close();
      },
    };
  }],
] as const;

function makeHarness(repositories: ServerNextRepositories): Harness {
  let tick = 1_000;
  let counter = 0;
  const unavailableSources = new Set<string>();
  const clock = { now: () => (tick += 1_000) };
  const ids = { nextId: () => `audit-${++counter}` };
  return {
    repositories,
    service: createMemorySourceInvalidationService({
      unitOfWork: repositories.memoryUnitOfWork,
      clock,
      ids,
      isSourceAvailable: async (source) => !unavailableSources.has(`${source.sourceKind}:${source.sourceId}`),
    }),
    markSourceUnavailable: (sourceKind, sourceId) => unavailableSources.add(`${sourceKind}:${sourceId}`),
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

async function seedCandidate(
  repositories: ServerNextRepositories,
  input: {
    readonly candidateId: string;
    readonly status?: MemoryCandidateRecord['status'];
    readonly teamId?: string;
    readonly sources: ReadonlyArray<Pick<MemorySourceRecord, 'sourceKind' | 'sourceId'>>;
  },
): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    const teamId = input.teamId ?? 'team-1';
    const status = input.status ?? 'candidate';
    const decided = status !== 'candidate' && status !== 'conflict';
    await memory.candidates.create({
      schemaVersion: 1,
      id: input.candidateId,
      teamId,
      managementRunId: 'run-1',
      sourceAgentId: 'agent-source',
      sourceInvocationId: `invocation-${input.candidateId}`,
      targetAgentId: 'agent-target',
      scopeType: 'team',
      scopeRef: teamId,
      contentKind: 'fact',
      proposedContent: `candidate ${input.candidateId}`,
      projectionHash: `sha256:${input.candidateId}`,
      status,
      conflictMemoryIds: status === 'conflict' ? ['memory-conflict'] : [],
      ...(decided ? { decidedAt: 2, decidedBy: 'user-1' } : {}),
      createdAt: 1,
      updatedAt: decided ? 2 : 1,
    });
    for (const source of input.sources) {
      await memory.candidateSources.create({
        candidateId: input.candidateId,
        teamId,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        snapshotHash: `sha256:${source.sourceId}`,
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

  test('expires a multi-source memory when separate deletions remove its last available source', async () => {
    const harness = createHarness();
    try {
      await seedMemory(harness.repositories, {
        memoryId: 'mem-3',
        sources: [{ sourceKind: 'message', sourceId: 'msg-1' }, { sourceKind: 'message', sourceId: 'msg-2' }],
      });
      harness.markSourceUnavailable('message', 'msg-1');
      await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1'],
      });
      expect(await getStatus(harness.repositories, 'team-1', 'mem-3')).toBe('active');
      harness.markSourceUnavailable('message', 'msg-2');
      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-2'],
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

  test('system-rejects every pending Candidate that cites an invalidated source', async () => {
    const harness = createHarness();
    try {
      await seedCandidate(harness.repositories, {
        candidateId: 'candidate-pending',
        sources: [
          { sourceKind: 'message', sourceId: 'msg-1' },
          { sourceKind: 'task', sourceId: 'task-still-valid' },
        ],
      });
      await seedCandidate(harness.repositories, {
        candidateId: 'candidate-conflict', status: 'conflict',
        sources: [{ sourceKind: 'message', sourceId: 'msg-1' }],
      });
      await seedCandidate(harness.repositories, {
        candidateId: 'candidate-terminal', status: 'rejected',
        sources: [{ sourceKind: 'message', sourceId: 'msg-1' }],
      });

      const result = await harness.service.invalidateSources({
        teamId: 'team-1', sourceKind: 'message', sourceIds: ['msg-1'], actorId: 'user-1',
      });

      expect(result.expiredMemoryIds).toEqual([]);
      expect(result.rejectedCandidateIds).toEqual(['candidate-conflict', 'candidate-pending']);
      await expect(harness.repositories.memory.candidates.getById({
        teamId: 'team-1', id: 'candidate-pending',
      })).resolves.toMatchObject({ status: 'rejected', decidedBy: 'system' });
      await expect(harness.repositories.memory.candidates.getById({
        teamId: 'team-1', id: 'candidate-conflict',
      })).resolves.toMatchObject({ status: 'rejected', decidedBy: 'system' });
      await expect(harness.repositories.memory.candidates.getById({
        teamId: 'team-1', id: 'candidate-terminal',
      })).resolves.toMatchObject({ status: 'rejected', updatedAt: 2 });

      const audit = await harness.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'candidate', subjectId: 'candidate-pending',
      });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ eventType: 'candidate-decided', actorKind: 'system' });
      expect(audit[0]).not.toHaveProperty('content');
      expect(audit[0]).not.toHaveProperty('body');
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

describe('Phase 3 Memory Source Invalidation usecase wiring', () => {
  test('rechecks prior soft-deleted messages when sources are deleted separately', async () => {
    const repositories = createInMemoryRepositories();
    let counter = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1_000 + counter },
      ids: { nextId: () => `id-${++counter}` },
    });
    const registered = await app.registerUser({ username: 'alice', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(`register failed: ${registered.error}`);
    const userId = registered.user.id;
    const teamId = registered.currentTeam.id;
    const channelId = registered.defaultChannel.id;
    const first = await app.sendMessage({ userId, teamId, channelId, body: 'first source' });
    const second = await app.sendMessage({ userId, teamId, channelId, body: 'second source' });
    if (!first.ok || !second.ok) throw new Error('message setup failed');
    await seedMemory(repositories, {
      teamId,
      memoryId: 'mem-separate-delete',
      sources: [
        { sourceKind: 'message', sourceId: first.message.id },
        { sourceKind: 'message', sourceId: second.message.id },
      ],
    });

    await app.deleteMessage({ userId, teamId, messageId: first.message.id });
    expect(await getStatus(repositories, teamId, 'mem-separate-delete')).toBe('active');
    await app.deleteMessage({ userId, teamId, messageId: second.message.id });
    expect(await getStatus(repositories, teamId, 'mem-separate-delete')).toBe('expired');
  });

  test('invalidates message sources removed by channel deletion', async () => {
    const repositories = createInMemoryRepositories();
    let counter = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 2_000 + counter },
      ids: { nextId: () => `id-${++counter}` },
    });
    const registered = await app.registerUser({ username: 'bob', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(`register failed: ${registered.error}`);
    const userId = registered.user.id;
    const teamId = registered.currentTeam.id;
    const created = await app.createChannel({ userId, teamId, name: 'temporary', visibility: 'public' });
    if (!created.ok) throw new Error(`channel setup failed: ${created.error}`);
    const sent = await app.sendMessage({
      userId,
      teamId,
      channelId: created.channel.id,
      body: 'channel source',
    });
    if (!sent.ok) throw new Error(`message setup failed: ${sent.error}`);
    await seedMemory(repositories, {
      teamId,
      memoryId: 'mem-channel-delete',
      sources: [{ sourceKind: 'message', sourceId: sent.message.id }],
    });

    await app.deleteChannel({ userId, teamId, channelId: created.channel.id });
    expect(await getStatus(repositories, teamId, 'mem-channel-delete')).toBe('expired');
  });

  test.each(usecaseBackends)('invalidates artifact, workspace-run, and invocation sources when their channel is deleted (%s)', async (_backend, createBackend) => {
    const { repositories, close } = createBackend();
    try {
    let counter = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 3_000 + counter },
      ids: { nextId: () => `id-${++counter}` },
    });
    const registered = await app.registerUser({ username: 'carol', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(`register failed: ${registered.error}`);
    const userId = registered.user.id;
    const teamId = registered.currentTeam.id;
    const created = await app.createChannel({ userId, teamId, name: 'temporary', visibility: 'public' });
    if (!created.ok) throw new Error(`channel setup failed: ${created.error}`);
    const channelId = created.channel.id;

    await repositories.artifacts.create({
      id: 'artifact-channel-delete', teamId, channelId, uploaderId: userId,
      filename: 'result.md', mimeType: 'text/markdown', sizeBytes: 10, createdAt: 1,
    });
    await repositories.workspaceRuns.create({
      id: 'workspace-run-channel-delete', teamId, channelId, dispatchId: 'dispatch-channel-delete',
      agentId: 'agent-1', status: 'succeeded', createdAt: 1, updatedAt: 1, artifactIds: [],
    });
    await repositories.management.runs.create({
      schemaVersion: 1, id: 'management-run-channel-delete', teamId, channelId,
      rootMessageId: 'root-message', mode: 'managed', status: 'running',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      checkpointRevision: 0, budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: 1, updatedAt: 1,
    });
    await repositories.management.invocations.create({
      schemaVersion: 1,
      id: 'invocation-channel-delete',
      managementRunId: 'management-run-channel-delete',
      intent: {
        schemaVersion: 1, teamId, channelId, targetAgentId: 'agent-1', targetKind: 'custom',
        objective: 'produce result', acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
      },
      intentHash: 'sha256:invocation-channel-delete',
      idempotencyKey: 'invocation-channel-delete',
      createdAt: 1,
    });
    await repositories.dispatches.create({
      id: 'dispatch-channel-delete', teamId, channelId, messageId: 'message-channel-delete',
      agentId: 'agent-1', status: 'succeeded', requestId: 'request-channel-delete',
      prompt: 'produce result', createdAt: 1, updatedAt: 2, completedAt: 2,
    });
    await repositories.management.dispatchAttempts.create({
      id: 'attempt-channel-delete', invocationId: 'invocation-channel-delete',
      dispatchId: 'dispatch-channel-delete', attemptNumber: 1, status: 'succeeded',
      startedAt: 1, completedAt: 2,
    });
    await seedMemory(repositories, {
      teamId, memoryId: 'mem-channel-artifact',
      sources: [{ sourceKind: 'artifact', sourceId: 'artifact-channel-delete' }],
    });
    await seedMemory(repositories, {
      teamId, memoryId: 'mem-channel-workspace-run',
      sources: [{ sourceKind: 'workspace-run', sourceId: 'workspace-run-channel-delete' }],
    });
    await seedMemory(repositories, {
      teamId, memoryId: 'mem-channel-invocation',
      sources: [{ sourceKind: 'invocation', sourceId: 'invocation-channel-delete' }],
    });

    await app.deleteChannel({ userId, teamId, channelId });
    await expect(Promise.all([
      getStatus(repositories, teamId, 'mem-channel-artifact'),
      getStatus(repositories, teamId, 'mem-channel-workspace-run'),
      getStatus(repositories, teamId, 'mem-channel-invocation'),
    ])).resolves.toEqual(['expired', 'expired', 'expired']);
    } finally {
      close();
    }
  });

  test.each(usecaseBackends)('invalidates invocation sources bound to a deleted task (%s)', async (_backend, createBackend) => {
    const { repositories, close } = createBackend();
    try {
    let counter = 0;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 4_000 + counter },
      ids: { nextId: () => `id-${++counter}` },
    });
    const registered = await app.registerUser({ username: 'dave', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(`register failed: ${registered.error}`);
    const userId = registered.user.id;
    const teamId = registered.currentTeam.id;
    const channelId = registered.defaultChannel.id;
    const created = await app.createTask({ userId, teamId, channelId, title: 'temporary task' });
    if (!created.ok) throw new Error(`task setup failed: ${created.error}`);
    const taskId = created.task.id;

    await repositories.management.runs.create({
      schemaVersion: 2, managementPhase: 2, id: 'management-run-task-delete', teamId, channelId,
      rootTaskId: taskId, rootMessageId: 'root-message', mode: 'managed', status: 'running',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      checkpointRevision: 0, budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: 1, updatedAt: 1,
    });
    await repositories.taskCoordination.coordinations.create({
      schemaVersion: 1, taskId, teamId, managementRunId: 'management-run-task-delete',
      rootTaskId: taskId, nodeKind: 'root', reviewPolicy: 'human', claimPolicy: 'open',
      requiredCapabilities: [], taskRevision: 1, attempt: 1, maxAttempts: 1,
      createdAt: 1, updatedAt: 1,
    });
    await repositories.management.invocations.create({
      schemaVersion: 1,
      id: 'invocation-task-delete',
      managementRunId: 'management-run-task-delete',
      intent: {
        schemaVersion: 1, teamId, channelId, targetAgentId: 'agent-1', targetKind: 'custom',
        objective: 'complete task',
        taskContext: { taskId, rootTaskId: taskId, taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-1' },
        acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
      },
      intentHash: 'sha256:invocation-task-delete',
      idempotencyKey: 'invocation-task-delete',
      createdAt: 1,
    });
    await seedMemory(repositories, {
      teamId,
      memoryId: 'mem-task-invocation',
      sources: [{ sourceKind: 'invocation', sourceId: 'invocation-task-delete' }],
    });

    await app.deleteTask({ userId, teamId, taskId });
    expect(await getStatus(repositories, teamId, 'mem-task-invocation')).toBe('expired');
    } finally {
      close();
    }
  });
});
