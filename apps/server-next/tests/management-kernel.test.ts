import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createManagementKernel, ManagementConflictError } from '../src/application/management/management-kernel.js';
import { createInMemoryManagementPersistence } from '../src/infra/memory/management-repositories.js';
import { createSqliteManagementPersistence } from '../src/infra/sqlite/management-repositories.js';
import { applyTeamMigrations, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('Server Collaboration Kernel', () => {
  test('atomically creates/resumes a Run and rejects request hash drift', async () => {
    const harness = createHarness();
    const first = await harness.kernel.createOrResumeRun(runInput());
    const replay = await harness.kernel.createOrResumeRun(runInput());
    expect(first.disposition).toBe('created');
    expect(replay).toEqual({ run: first.run, disposition: 'existing' });
    await expect(harness.kernel.createOrResumeRun({ ...runInput(), requestHash: 'different' }))
      .rejects.toMatchObject<Partial<ManagementConflictError>>({ code: 'MANAGEMENT_REQUEST_CONFLICT' });
    await expect(harness.repositories.events.list(first.run.id)).resolves.toHaveLength(1);
  });

  test('stores only lease hash/fingerprint and fences every authorized event write', async () => {
    const harness = createHarness();
    const { run } = await harness.kernel.createOrResumeRun(runInput());
    const acquired = await harness.kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'raw-secret-token', ttlMs: 100 });
    expect(acquired.lease).not.toHaveProperty('leaseToken');
    expect(acquired.lease.leaseTokenHash).not.toContain('raw-secret-token');
    expect(acquired.lease.leaseFingerprint).toHaveLength(16);

    const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'raw-secret-token', fencingToken: 1 };
    const first = await harness.kernel.appendEvent({ authority, type: 'waiting-for-user', actorKind: 'manager', actorId: 'worker-1', idempotencyKey: 'wait-1', payload: { reasonCode: 'NEEDS_SCOPE' } });
    const replay = await harness.kernel.appendEvent({ authority, type: 'waiting-for-user', actorKind: 'manager', actorId: 'worker-1', idempotencyKey: 'wait-1', payload: { reasonCode: 'NEEDS_SCOPE' } });
    expect(replay).toEqual(first);
    await expect(harness.kernel.appendEvent({ authority, type: 'waiting-for-user', actorKind: 'manager', idempotencyKey: 'wait-1', payload: { reasonCode: 'DIFFERENT' } })).rejects.toMatchObject({ code: 'MANAGEMENT_EVENT_IDEMPOTENCY_CONFLICT' });
    await expect(harness.kernel.appendEvent({ authority: { ...authority, fencingToken: 2 }, type: 'run-failed', actorKind: 'manager', idempotencyKey: 'fail-1', payload: { errorCode: 'E', recoverable: false } })).rejects.toMatchObject({ code: 'LEASE_FUTURE_FENCING_TOKEN' });
    await expect(harness.repositories.events.list(run.id)).resolves.toMatchObject([
      { event: { sequence: 1, type: 'run-started' } },
      { event: { sequence: 2, type: 'worker-leased' } },
      { event: { sequence: 3, type: 'waiting-for-user' } },
    ]);
  });

  test('projects terminal Event status and release recovery atomically', async () => {
    const harness = createHarness();
    const { run } = await harness.kernel.createOrResumeRun(runInput());
    await harness.kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
    const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 };
    const completed = await harness.kernel.appendEvent({ authority, type: 'run-completed', actorKind: 'manager', idempotencyKey: 'complete-1', payload: { deliveryMessageId: 'message-2' } });
    await expect(harness.kernel.appendEvent({ authority, type: 'run-completed', actorKind: 'manager', idempotencyKey: 'complete-1', payload: { deliveryMessageId: 'message-2' } })).resolves.toEqual(completed);
    await expect(harness.kernel.appendEvent({ authority, type: 'waiting-for-user', actorKind: 'manager', idempotencyKey: 'late-write', payload: { reasonCode: 'LATE' } })).rejects.toMatchObject({ code: 'MANAGEMENT_RUN_TERMINAL' });
    await expect(harness.repositories.runs.getById(run.id)).resolves.toMatchObject({ status: 'completed', completedAt: 10 });
  });

  test('preserves the same atomic/idempotent semantics with SQLite repositories', async () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      const persistence = createSqliteManagementPersistence(db);
      let id = 0;
      const kernel = createManagementKernel({ ...persistence, clock: { now: () => 10 }, ids: { nextId: () => `sqlite-${++id}` } });
      const { run } = await kernel.createOrResumeRun(runInput());
      await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
      const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 };
      const event = await kernel.appendEvent({ authority, type: 'run-failed', actorKind: 'manager', idempotencyKey: 'failure-1', payload: { errorCode: 'PROVIDER_DOWN', recoverable: true } });
      await expect(kernel.appendEvent({ authority, type: 'run-failed', actorKind: 'manager', idempotencyKey: 'failure-1', payload: { errorCode: 'PROVIDER_DOWN', recoverable: true } })).resolves.toEqual(event);
      await expect(persistence.repositories.runs.getById(run.id)).resolves.toMatchObject({ status: 'failed' });
    } finally {
      db.close();
    }
  });
});

function runInput() {
  return {
    teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1',
    placementPolicy: { placement: 'device' as const, allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  };
}
function createHarness() {
  const persistence = createInMemoryManagementPersistence();
  let id = 0;
  return {
    ...persistence,
    kernel: createManagementKernel({ ...persistence, clock: { now: () => 10 }, ids: { nextId: () => `id-${++id}` } }),
  };
}
