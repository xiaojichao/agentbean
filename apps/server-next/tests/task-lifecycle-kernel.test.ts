import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createTaskLifecycleKernel, type TaskLifecycleKernelDependencies } from '../src/application/management/task-lifecycle-kernel.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type {
  TaskLifecycleCommandEnvelopeV1,
  TaskLifecycleCommandInputMapV1,
} from '../../../packages/contracts/src/index.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

type Authority = { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number };

/**
 * #926 Task lifecycle kernel 测试：覆盖 10 个 command handler 的 happy path、
 * 幂等 replay、idempotency conflict、precondition 失败与 terminal immutability。
 * 用 memory + sqlite 双 fixture（与 task-coordination-kernel.test.ts 同款）。
 */

let idemSeq = 0;
function nextIdem(): string { idemSeq += 1; return `lifecycle-idem-${idemSeq}`; }
function makeEnvelope(commandName: TaskLifecycleCommandEnvelopeV1['commandName']): TaskLifecycleCommandEnvelopeV1 {
  return { schemaVersion: 1, commandName, commandSchemaVersion: 1, idempotencyKey: nextIdem() };
}

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { repositories: createSqliteRepositories({ globalDb: db, teamDb: db }), close: () => db.close() };
  }],
] as const)('Task Lifecycle Kernel (%s)', (_name, createFixture) => {
  test('transition-task-in-progress: root todo → in_progress', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const r = await h.lifecycle.transitionTaskInProgress(
        makeEnvelope('transition-task-in-progress'),
        { taskId: 'root-task', expectedTaskRevision: 1 },
        h.authority, 'pi_driver', 'team-1',
      );
      expect(r.result.status).toBe('in_progress');
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('in_progress');
    } finally { fixture.close(); }
  });

  test('transition-task-in-progress rejects non-todo root', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      // in_review（非 todo）→ validateTransition allowed，但 status !== 'todo' → TASK_NOT_TODO
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_review', updatedAt: 100 } });
      await expect(h.lifecycle.transitionTaskInProgress(
        makeEnvelope('transition-task-in-progress'),
        { taskId: 'root-task', expectedTaskRevision: 1 },
        h.authority, 'pi_driver', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TASK_NOT_TODO' });
    } finally { fixture.close(); }
  });

  test('start-execution records start without changing status', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_progress', updatedAt: 100 } });
      // 需要 claim
      const claim = await fixture.repositories.taskCoordination.claimLeases.create({
        id: 'claim-exec', teamId: 'team-1', taskId: 'root-task', taskRevision: 1, taskAttempt: 1,
        agentId: 'agent-1', leaseTokenHash: 'h', leaseFingerprint: 'f', fencingToken: 1,
        status: 'active', acquiredAt: 10, heartbeatAt: 10, expiresAt: 1000,
      });
      const r = await h.lifecycle.startExecution(
        makeEnvelope('start-execution'),
        { taskId: 'root-task', expectedTaskRevision: 1, claimLeaseId: claim.id },
        h.authority, 'agent', 'team-1',
      );
      expect(r.result.startedAt).toBe(100);
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('in_progress'); // 不改 status
    } finally { fixture.close(); }
  });

  test('cancel-task: todo → cancelled', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const r = await h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'not needed' },
        h.authority, 'admin', 'team-1',
      );
      expect(r.result.status).toBe('cancelled');
      expect(r.result.cancelledSubtaskIds).toEqual([]);
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('cancelled');
    } finally { fixture.close(); }
  });

  test('cancel-task rejects terminal task (done)', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'done', updatedAt: 100 } });
      await expect(h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'x' },
        h.authority, 'admin', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_ALREADY_TERMINAL' });
    } finally { fixture.close(); }
  });

  test('close-task: admin only', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      // human 不能 close
      await expect(h.lifecycle.closeTask(
        makeEnvelope('close-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'x' },
        h.authority, 'human', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REQUIRES_ADMIN' });
      // admin 可以
      const r = await h.lifecycle.closeTask(
        makeEnvelope('close-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'admin close' },
        h.authority, 'admin', 'team-1',
      );
      expect(r.result.status).toBe('closed');
    } finally { fixture.close(); }
  });

  test('idempotent replay: same envelope+input returns same result', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const env = makeEnvelope('cancel-task');
      const input: TaskLifecycleCommandInputMapV1['cancel-task'] = { taskId: 'root-task', expectedTaskRevision: 1, reason: 'dup' };
      const first = await h.lifecycle.cancelTask(env, input, h.authority, 'admin', 'team-1');
      const second = await h.lifecycle.cancelTask(env, input, h.authority, 'admin', 'team-1');
      expect(second.result).toEqual(first.result);
    } finally { fixture.close(); }
  });

  test('idempotency conflict: same key, different input', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const env = makeEnvelope('cancel-task');
      await h.lifecycle.cancelTask(env, { taskId: 'root-task', expectedTaskRevision: 1, reason: 'a' }, h.authority, 'admin', 'team-1');
      await expect(h.lifecycle.cancelTask(
        env, { taskId: 'root-task', expectedTaskRevision: 1, reason: 'different' },
        h.authority, 'admin', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_COMMAND_IDEMPOTENCY_CONFLICT' });
    } finally { fixture.close(); }
  });

  test('authority check: agent cannot cancel', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await expect(h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'x' },
        h.authority, 'agent', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REQUIRES_REQUESTER_OR_ADMIN' });
    } finally { fixture.close(); }
  });

  test('revision fencing: stale revision rejected', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await expect(h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 5, reason: 'stale' }, // 实际 revision=1
        h.authority, 'admin', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_FUTURE_REVISION' });
    } finally { fixture.close(); }
  });

  test('accept-root-delivery: human accepts in_review root → done', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_review', updatedAt: 100 } });
      await fixture.repositories.management.runs.update({ ...(await fixture.repositories.management.runs.getByRootTaskId('root-task'))!, status: 'in_review', updatedAt: 100 });
      const r = await h.lifecycle.acceptRootDelivery(
        makeEnvelope('accept-root-delivery'),
        { taskId: 'root-task', expectedTaskRevision: 1, deliveryMessageId: 'msg-1' },
        h.authority, 'human', 'team-1',
      );
      expect(r.result.status).toBe('done');
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('done');
    } finally { fixture.close(); }
  });

  test('reject-root-delivery: human rejects in_review root → in_progress (new revision)', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_review', updatedAt: 100 } });
      const run = await fixture.repositories.management.runs.getByRootTaskId('root-task');
      await fixture.repositories.management.runs.update({ ...run!, status: 'in_review', updatedAt: 100 });
      const r = await h.lifecycle.rejectRootDelivery(
        makeEnvelope('reject-root-delivery'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'needs rework' },
        h.authority, 'human', 'team-1',
      );
      expect(r.result.status).toBe('in_progress');
      expect(r.result.taskRevision).toBe(2); // revision bumped
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('in_progress');
      expect(task?.revision).toBe(2);
    } finally { fixture.close(); }
  });

  test('submit-root-delivery rejects when no subtasks (readiness)', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_progress', updatedAt: 100 } });
      // 无 subtask → readiness 失败
      await expect(h.lifecycle.submitRootDelivery(
        makeEnvelope('submit-root-delivery'),
        { taskId: 'root-task', expectedTaskRevision: 1, messageId: 'msg-1', contributingInvocationIds: [] },
        h.authority, 'pi_driver', 'team-1',
      )).rejects.toMatchObject({ code: 'MANAGEMENT_ROOT_DELIVERY_SUBTASKS_REQUIRED' });
    } finally { fixture.close(); }
  });
});

// ---------------------------------------------------------------------------
// Test harness（复用 task-coordination-kernel.test.ts 的 setup 模式）
// ---------------------------------------------------------------------------

async function createHarness(repositories: ServerNextRepositories) {
  let id = 0;
  const clock = { now: () => 100 };
  const ids = { nextId: () => id++ === 0 ? 'run-1' : `lc-${id}` };
  await repositories.tasks.create({
    id: 'root-task', teamId: 'team-1', title: 'Root', description: 'root objective',
    status: 'todo', creatorId: 'user-1', channelId: 'channel-1',
    tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
  });
  const managementKernel = createManagementKernel({
    repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork,
    clock, ids,
  });
  await managementKernel.createOrResumeRun({
    teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'root-task',
    rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'request-hash',
    placementPolicy: { placement: 'device' as const, allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  await managementKernel.acquireLease({
    managementRunId: 'run-1', workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'lease-token', ttlMs: 1_000,
  });
  const authority: Authority = { managementRunId: 'run-1', workerId: 'worker-1', leaseToken: 'lease-token', fencingToken: 1 };

  // bootstrap root coordination（lifecycle handler 需要 coordination 记录）
  // 用 createRootCoordination（manager lease 授权），与 task-coordination-kernel.test.ts 同款
  const coordKernel = createTaskCoordinationKernel({ unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids });
  await coordKernel.createRootCoordination({
    authority, idempotencyKey: 'root-coordination', taskId: 'root-task',
    claimPolicy: 'open' as const, requiredCapabilities: [],
    acceptanceCriteria: [{ id: 'criterion-root', description: 'root done', evidenceRequired: false }],
    maxAttempts: 1,
    // #1061 AC4：root Human review authority 创建时预绑定（human accept 测试的 actor）。
    humanReviewAuthorityIds: ['worker-1'],
  });

  const lifecycleDeps: TaskLifecycleKernelDependencies = {
    unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids,
  };

  return {
    authority,
    lifecycle: createTaskLifecycleKernel(lifecycleDeps),
  };
}
