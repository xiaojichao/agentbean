import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import type { MemoryItemRecord, ServerNextRepositories } from '../src/index.js';
import { createCapsuleInjectionValidator } from '../src/application/capsule-injection-validator.js';
import {
  createCollaborativeMemorySearchService,
  type MemorySearchPermissions,
} from '../src/application/collaborative-memory-search-service.js';
import { createMemoryCapsuleService, toMemoryCapsuleRef } from '../src/application/memory-capsule-service.js';
import {
  createServerCapsuleRuntimeContextService,
  ServerCapsuleRuntimeContextError,
  type ResolveServerCapsuleRuntimeContextInput,
} from '../src/application/server-capsule-runtime-context-service.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;
const POLICY_VERSION = 7;

const permissions: MemorySearchPermissions = {
  async canSearchTeam() { return true; },
  async evaluateScopeVisibility() { return 'visible'; },
  async isSourceAvailable() { return true; },
};

function harness(repositories: ServerNextRepositories) {
  let counter = 0;
  const ids = { nextId: () => `runtime-id-${++counter}` };
  const searchService = createCollaborativeMemorySearchService({ repositories: repositories.memory, permissions });
  const capsuleService = createMemoryCapsuleService({
    searchService, unitOfWork: repositories.memoryUnitOfWork, clock: { now: () => 5_000 }, ids,
  });
  const validator = createCapsuleInjectionValidator({ unitOfWork: repositories.memoryUnitOfWork, permissions, ids });
  const runtime = createServerCapsuleRuntimeContextService({
    unitOfWork: repositories.memoryUnitOfWork,
    validator,
    ids,
    currentPolicyVersion: () => POLICY_VERSION,
  });
  return { repositories, capsuleService, runtime };
}

async function seed(repositories: ServerNextRepositories, id: string, content: string): Promise<void> {
  await repositories.memoryUnitOfWork.run(async (memory) => {
    await memory.items.create({
      schemaVersion: 1, id, teamId: 'team-1', kind: 'decision', status: 'active',
      scopeType: 'team', scopeRef: 'team-1', content, summary: `summary-${id}`,
      createdByUserId: 'user-1', approvedByUserId: 'user-1', validFrom: 1,
      createdAt: 1, updatedAt: 1,
    });
    await memory.sources.create({
      memoryId: id, teamId: 'team-1', sourceKind: 'message', sourceId: `message-${id}`,
      snapshotHash: `sha256:${id}`, sourceScopeType: 'team', sourceScopeRef: 'team-1',
      sourceVisibility: 'team', createdAt: 1,
    });
  });
}

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { repositories: createSqliteRepositories({ globalDb: db, teamDb: db }), close: () => db.close() };
  }],
] as const)('Server Capsule runtime context (%s)', (_name, createFixture) => {
  test('rebuilds the Invocation-bound Capsule after service restart and writes body-free audit', async () => {
    const fixture = createFixture();
    try {
      const first = harness(fixture.repositories);
      await seed(fixture.repositories, 'mem-b', 'server capsule private body B');
      await seed(fixture.repositories, 'mem-a', 'server capsule private body A');
      const capsule = await first.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1', taskId: 'task-1',
        targetAgentId: 'agent-1', prompt: 'body', limit: 8, now: 5_000,
        currentPolicyVersion: POLICY_VERSION,
      });

      // New service instance proves the runtime path does not depend on an in-process Capsule cache.
      const restarted = harness(fixture.repositories).runtime;
      const result = await restarted.resolve({
        teamId: 'team-1', managementRunId: 'run-1', taskId: 'task-1', targetAgentId: 'agent-1',
        memoryCapsuleRef: toMemoryCapsuleRef(capsule), now: 6_000,
      });

      expect(result.map((item) => item.id)).toEqual(capsule.items.map((item) => item.memoryId));
      expect(result.every((item) => item.provenance.origin === 'server')).toBe(true);
      const audits = await fixture.repositories.memory.auditEvents.listBySubject({
        teamId: 'team-1', subjectKind: 'capsule', subjectId: capsule.id,
      });
      expect(audits.map((audit) => audit.eventType)).toEqual(expect.arrayContaining([
        'capsule-read', 'capsule-injected',
      ]));
      expect(JSON.stringify(audits)).not.toContain('server capsule private body');
    } finally {
      fixture.close();
    }
  });

  test('fails closed and denies the authoritative ref after current Memory drifts', async () => {
    const fixture = createFixture();
    try {
      const current = harness(fixture.repositories);
      await seed(fixture.repositories, 'mem-1', 'original');
      const capsule = await current.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1', taskId: 'task-1',
        targetAgentId: 'agent-1', prompt: 'original', limit: 8, now: 5_000,
        currentPolicyVersion: POLICY_VERSION,
      });
      await fixture.repositories.memoryUnitOfWork.run(async (memory) => {
        const item = await memory.items.getById({ teamId: 'team-1', id: 'mem-1' }) as MemoryItemRecord;
        await memory.items.update({ record: { ...item, content: 'drifted', updatedAt: 2 }, expectedUpdatedAt: 1 });
      });

      await expect(current.runtime.resolve({
        teamId: 'team-1', managementRunId: 'run-1', taskId: 'task-1', targetAgentId: 'agent-1',
        memoryCapsuleRef: toMemoryCapsuleRef(capsule), now: 6_000,
      })).rejects.toMatchObject<Partial<ServerCapsuleRuntimeContextError>>({
        code: 'SERVER_CAPSULE_REVALIDATION_FAILED',
      });
      await expect(fixture.repositories.memory.capsuleRefs.getById({ teamId: 'team-1', id: capsule.id }))
        .resolves.toMatchObject({ deniedAt: 6_000 });
    } finally {
      fixture.close();
    }
  });

  test('rejects a Capsule ref rebound to another Invocation target', async () => {
    const fixture = createFixture();
    try {
      const current = harness(fixture.repositories);
      await seed(fixture.repositories, 'mem-1', 'bound');
      const capsule = await current.capsuleService.createCapsule({
        teamId: 'team-1', requesterUserId: 'user-1', managementRunId: 'run-1', taskId: 'task-1',
        targetAgentId: 'agent-1', prompt: 'bound', limit: 8, now: 5_000,
        currentPolicyVersion: POLICY_VERSION,
      });
      await expect(current.runtime.resolve({
        teamId: 'team-1', managementRunId: 'run-1', taskId: 'task-1', targetAgentId: 'agent-2',
        memoryCapsuleRef: toMemoryCapsuleRef(capsule), now: 6_000,
      })).rejects.toMatchObject({ code: 'SERVER_CAPSULE_INVOCATION_BINDING_INVALID' });
    } finally {
      fixture.close();
    }
  });
});

describe('Server Capsule dispatch wiring', () => {
  test('injects only the resolver result for the Invocation-bound Capsule', async () => {
    const repositories = createInMemoryRepositories();
    const ref = await seedManagedDispatch(repositories);
    let received: ResolveServerCapsuleRuntimeContextInput | undefined;
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 6_000 },
      ids: { nextId: () => 'usecase-id' },
      sessionSecret: 'test-secret',
      serverCapsuleRuntimeContextResolver: {
        async resolve(input) {
          received = input;
          return [{
            schemaVersion: 1, id: 'mem-1', kind: 'decision', scopeType: 'team', content: 'current',
            selectionReason: 'current-test', provenance: {
              origin: 'server', capsuleId: ref.id, authorizationDecisionId: 'decision-1', sourceRefs: [],
            },
          }];
        },
      },
    });

    const result = await app.getDispatchRequest({ dispatchId: 'dispatch-1' });
    expect(received).toEqual({
      teamId: 'team-1', managementRunId: 'run-1', taskId: 'task-1', targetAgentId: 'agent-1',
      memoryCapsuleRef: ref, now: 6_000,
    });
    expect(result).toMatchObject({ ok: true, request: { memoryContext: [{ id: 'mem-1' }] } });
  });

  test('fails closed when an Invocation carries a Capsule but runtime resolution is unavailable', async () => {
    const repositories = createInMemoryRepositories();
    await seedManagedDispatch(repositories);
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 6_000 }, ids: { nextId: () => 'usecase-id' },
      sessionSecret: 'test-secret',
    });
    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-1' }))
      .rejects.toThrow('SERVER_CAPSULE_RUNTIME_CONTEXT_UNAVAILABLE');
  });

  test('builds a route-only request without resolving or auditing Capsule runtime context', async () => {
    const repositories = createInMemoryRepositories();
    await seedManagedDispatch(repositories);
    let resolutions = 0;
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 20_000 }, ids: { nextId: () => 'usecase-id' },
      sessionSecret: 'test-secret',
      serverCapsuleRuntimeContextResolver: {
        async resolve() {
          resolutions += 1;
          throw new Error('expired Capsule must not block routing');
        },
      },
    });

    await expect(app.getDispatchRequest({ dispatchId: 'dispatch-1', purpose: 'route' }))
      .resolves.toMatchObject({ ok: true, request: { id: 'dispatch-1', deviceId: undefined } });
    expect(resolutions).toBe(0);
  });
});

async function seedManagedDispatch(repositories: ServerNextRepositories) {
  const ref = {
    schemaVersion: 1 as const, id: 'capsule-1', teamId: 'team-1', managementRunId: 'run-1',
    taskId: 'task-1', targetAgentId: 'agent-1', contentHash: 'sha256:content',
    authorizationDecisionId: 'decision-1', expiresAt: 10_000,
  };
  await repositories.agents.upsert({
    id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent',
    adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online',
  });
  await repositories.messages.append({
    id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human',
    senderId: 'user-1', body: 'run', createdAt: 1,
  });
  await repositories.dispatches.create({
    id: 'dispatch-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
    agentId: 'agent-1', status: 'queued', requestId: 'request-1', prompt: 'run', createdAt: 1, updatedAt: 1,
  });
  await repositories.management.invocations.create({
    schemaVersion: 1, id: 'invocation-1', managementRunId: 'run-1', intent: {
      schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1',
      targetKind: 'custom', objective: 'run', taskContext: {
        taskId: 'task-1', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-1',
      }, acceptanceCriteria: [], dependencyResults: [], memoryCapsuleRef: ref, attachmentIds: [],
    }, intentHash: 'hash', idempotencyKey: 'invoke-1', createdAt: 1,
  });
  await repositories.management.dispatchAttempts.create({
    id: 'attempt-1', invocationId: 'invocation-1', dispatchId: 'dispatch-1', attemptNumber: 1,
    status: 'queued', startedAt: 1,
  });
  return ref;
}
