import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createManagementKernel, ManagementConflictError } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return { repositories: createSqliteRepositories({ globalDb: db, teamDb: db }), close: () => db.close() };
  }],
] as const)('Task Coordination Kernel (%s)', (_name, createFixture) => {
  test('creates root coordination and a bounded subtask batch with idempotent typed events', async () => {
    const fixture = createFixture();
    try {
      const harness = await createHarness(fixture.repositories);
      const root = await harness.kernel.createRootCoordination(rootInput(harness.authority));
      const rootReplay = await harness.kernel.createRootCoordination(rootInput(harness.authority));
      expect(root.disposition).toBe('created');
      expect(rootReplay).toEqual({ ...root, disposition: 'existing' });

      const created = await harness.kernel.createSubtasks(subtasksInput(harness.authority));
      const replay = await harness.kernel.createSubtasks(subtasksInput(harness.authority));
      expect(created.disposition).toBe('created');
      expect(created.taskIds).toEqual(['task-a', 'task-b']);
      expect(replay).toEqual({ ...created, disposition: 'existing' });
      await expect(harness.kernel.createSubtasks({
        ...subtasksInput(harness.authority),
        subtasks: [{ ...subtasksInput(harness.authority).subtasks[0]!, title: 'different' }],
      })).rejects.toMatchObject<Partial<ManagementConflictError>>({
        code: 'TASK_COMMAND_IDEMPOTENCY_CONFLICT',
      });

      await expect(fixture.repositories.taskCoordination.coordinations.listByManagementRun('run-1'))
        .resolves.toHaveLength(3);
      await expect(fixture.repositories.management.events.list('run-1')).resolves.toMatchObject([
        { event: { sequence: 1, type: 'run-started' } },
        { event: { sequence: 2, type: 'worker-leased' } },
        { event: { sequence: 3, type: 'task-created', payload: { taskId: 'root-task' } } },
        { event: { sequence: 4, type: 'task-created', payload: { taskId: 'task-a', parentTaskId: 'root-task' } } },
        { event: { sequence: 5, type: 'task-created', payload: { taskId: 'task-b', parentTaskId: 'root-task' } } },
      ]);
    } finally {
      fixture.close();
    }
  });

  test('revises a Task when adding a dependency and rejects a cycle atomically', async () => {
    const fixture = createFixture();
    try {
      const harness = await createGraphHarness(fixture.repositories);
      const added = await harness.kernel.addDependency({
        authority: harness.authority, idempotencyKey: 'dependency-a-b',
        taskId: 'task-a', dependencyTaskId: 'task-b', expectedTaskRevision: 1,
      });
      expect(added).toMatchObject({ disposition: 'updated', taskId: 'task-a', taskRevision: 2 });
      await expect(harness.kernel.addDependency({
        authority: harness.authority, idempotencyKey: 'dependency-b-a',
        taskId: 'task-b', dependencyTaskId: 'task-a', expectedTaskRevision: 1,
      })).rejects.toMatchObject<Partial<ManagementConflictError>>({ code: 'TASK_DAG_DEPENDENCY_CYCLE' });
      await expect(fixture.repositories.tasks.getById('task-b')).resolves.toMatchObject({ revision: 1 });
      await expect(fixture.repositories.taskCoordination.dependencies.list('task-b')).resolves.toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test('revises criteria and invalidates current claim plus matching Invocation in one transaction', async () => {
    const fixture = createFixture();
    try {
      const harness = await createGraphHarness(fixture.repositories);
      await fixture.repositories.taskCoordination.claimLeases.create(claim());
      await fixture.repositories.management.invocations.create(invocation());

      const revised = await harness.kernel.reviseTask({
        authority: harness.authority, idempotencyKey: 'revise-a', taskId: 'task-a',
        expectedTaskRevision: 1, objective: 'revised objective',
        acceptanceCriteria: [{ id: 'criterion-a-2', description: 'new criterion', evidenceRequired: true }],
        requiredCapabilities: ['research'], claimPolicy: 'open', maxAttempts: 3,
        reasonCode: 'requirements_changed',
      });
      expect(revised).toMatchObject({ taskId: 'task-a', taskRevision: 2 });
      await expect(fixture.repositories.tasks.getById('task-a')).resolves.toMatchObject({
        revision: 2, description: 'revised objective',
      });
      await expect(fixture.repositories.taskCoordination.claimLeases.getById('claim-a'))
        .resolves.toMatchObject({ status: 'invalidated' });
      await expect(fixture.repositories.taskCoordination.criteria.list('task-a')).resolves.toMatchObject([
        { id: 'criterion-a', retiredRevision: 2 },
        { id: 'criterion-a-2', introducedRevision: 2 },
      ]);
      const events = await fixture.repositories.management.events.list('run-1');
      expect(events.slice(-2)).toMatchObject([
        { event: { type: 'task-revised', payload: { previousRevision: 1, taskRevision: 2 } } },
        { event: { type: 'claim-invalidated', payload: {
          claimLeaseId: 'claim-a', invalidatedInvocationIds: ['invocation-a'],
        } } },
      ]);
    } finally {
      fixture.close();
    }
  });

  test('records exact publish/assign events and preserves optimistic revision semantics', async () => {
    const fixture = createFixture();
    try {
      const harness = await createGraphHarness(fixture.repositories);
      const assigned = await harness.kernel.assignTask({
        authority: harness.authority, idempotencyKey: 'assign-a', taskId: 'task-a',
        agentId: 'agent-1', expectedTaskRevision: 1,
      });
      expect(assigned).toMatchObject({ taskRevision: 2, agentId: 'agent-1' });
      const published = await harness.kernel.publishForClaim({
        authority: harness.authority, idempotencyKey: 'publish-a', taskId: 'task-a',
        expectedTaskRevision: 2,
      });
      expect(published).toMatchObject({ taskRevision: 3, status: 'todo' });
      await expect(harness.kernel.assignTask({
        authority: harness.authority, idempotencyKey: 'assign-a', taskId: 'task-a',
        agentId: 'agent-1', expectedTaskRevision: 1,
      })).resolves.toEqual({ ...assigned, disposition: 'existing' });
      await expect(fixture.repositories.tasks.getById('task-a')).resolves.toMatchObject({
        revision: 3, assigneeId: undefined,
      });
      const events = await fixture.repositories.management.events.list('run-1');
      expect(events.slice(-4).map(({ event }) => event.type)).toEqual([
        'task-revised', 'task-assigned', 'task-revised', 'task-published-for-claim',
      ]);
      await harness.kernel.transitionTaskState({
        authority: harness.authority, idempotencyKey: 'start-a', taskId: 'task-a',
        expectedTaskRevision: 3, from: 'todo', to: 'in_progress',
      });
      await expect(harness.kernel.publishForClaim({
        authority: harness.authority, idempotencyKey: 'publish-a', taskId: 'task-a',
        expectedTaskRevision: 2,
      })).resolves.toEqual({ ...published, disposition: 'existing' });
    } finally {
      fixture.close();
    }
  });

  test('transitions state at the expected revision and replays before checking current state', async () => {
    const fixture = createFixture();
    try {
      const harness = await createGraphHarness(fixture.repositories);
      const input = {
        authority: harness.authority, idempotencyKey: 'state-a', taskId: 'task-a',
        expectedTaskRevision: 1, from: 'todo' as const, to: 'in_progress' as const,
      };
      const changed = await harness.kernel.transitionTaskState(input);
      await expect(harness.kernel.transitionTaskState(input)).resolves.toEqual({
        ...changed, disposition: 'existing',
      });
      await expect(harness.kernel.transitionTaskState({ ...input, to: 'in_review' }))
        .rejects.toMatchObject<Partial<ManagementConflictError>>({
          code: 'TASK_COMMAND_IDEMPOTENCY_CONFLICT',
        });
      await expect(harness.kernel.transitionTaskState({
        ...input, idempotencyKey: 'state-stale', expectedTaskRevision: 2,
      })).rejects.toMatchObject<Partial<ManagementConflictError>>({ code: 'TASK_REVISION_FUTURE' });
    } finally {
      fixture.close();
    }
  });

  test('blocks publish and targeted assign until dependencies are done', async () => {
    const fixture = createFixture();
    try {
      const harness = await createGraphHarness(fixture.repositories);
      await harness.kernel.addDependency({
        authority: harness.authority, idempotencyKey: 'dependency-readiness',
        taskId: 'task-a', dependencyTaskId: 'task-b', expectedTaskRevision: 1,
      });
      await expect(harness.kernel.publishForClaim({
        authority: harness.authority, idempotencyKey: 'publish-blocked',
        taskId: 'task-a', expectedTaskRevision: 2,
      })).rejects.toMatchObject<Partial<ManagementConflictError>>({
        code: 'TASK_DEPENDENCIES_NOT_READY',
      });
      await expect(harness.kernel.assignTask({
        authority: harness.authority, idempotencyKey: 'assign-blocked',
        taskId: 'task-a', agentId: 'agent-1', expectedTaskRevision: 2,
      })).rejects.toMatchObject<Partial<ManagementConflictError>>({
        code: 'TASK_DEPENDENCIES_NOT_READY',
      });
      await harness.kernel.transitionTaskState({
        authority: harness.authority, idempotencyKey: 'complete-dependency',
        taskId: 'task-b', expectedTaskRevision: 1, from: 'todo', to: 'done',
      });
      await expect(harness.kernel.assignTask({
        authority: harness.authority, idempotencyKey: 'assign-ready',
        taskId: 'task-a', agentId: 'agent-1', expectedTaskRevision: 2,
      })).resolves.toMatchObject({ taskRevision: 3, agentId: 'agent-1' });
    } finally {
      fixture.close();
    }
  });

  test('exposes standalone claim invalidation as an idempotent command', async () => {
    const fixture = createFixture();
    try {
      const harness = await createGraphHarness(fixture.repositories);
      await fixture.repositories.taskCoordination.claimLeases.create(claim());
      const input = { authority: harness.authority, idempotencyKey: 'invalidate-a',
        taskId: 'task-a', expectedTaskRevision: 1, reasonCode: 'MANUAL_REASSIGN' };
      const invalidated = await harness.kernel.invalidateClaim(input);
      await expect(harness.kernel.invalidateClaim(input)).resolves.toEqual({
        ...invalidated, disposition: 'existing',
      });
      await expect(fixture.repositories.taskCoordination.claimLeases.getById('claim-a'))
        .resolves.toMatchObject({ status: 'invalidated' });
    } finally {
      fixture.close();
    }
  });

  test('rolls back an over-budget batch and a failed Event append', async () => {
    const fixture = createFixture();
    try {
      const harness = await createHarness(fixture.repositories);
      await harness.kernel.createRootCoordination(rootInput(harness.authority));
      const drafts = Array.from({ length: 5 }, (_, index) => ({
        taskId: `too-many-${index}`, clientKey: `too-many-${index}`, title: `Too many ${index}`,
        claimPolicy: 'open' as const, requiredCapabilities: [],
        acceptanceCriteria: [{ id: `criterion-too-many-${index}`,
          description: 'accepted', evidenceRequired: false }], maxAttempts: 1,
      }));
      await expect(harness.kernel.createSubtasks({ authority: harness.authority,
        idempotencyKey: 'too-many', parentTaskId: 'root-task', subtasks: drafts }))
        .rejects.toMatchObject<Partial<ManagementConflictError>>({
          code: 'TASK_DAG_MAX_FAN_OUT_EXCEEDED',
        });
      await expect(fixture.repositories.tasks.getById('too-many-0')).resolves.toBeNull();

      const duplicateEventId = (await fixture.repositories.management.events.list('run-1'))[0]!.event.id;
      const failingKernel = createTaskCoordinationKernel({
        unitOfWork: fixture.repositories.taskCoordinationUnitOfWork,
        clock: { now: () => 100 }, ids: { nextId: () => duplicateEventId },
      });
      await expect(failingKernel.createSubtasks({ authority: harness.authority,
        idempotencyKey: 'event-failure', parentTaskId: 'root-task', subtasks: [{
          taskId: 'event-failure-task', clientKey: 'event-failure', title: 'Event failure',
          claimPolicy: 'open', requiredCapabilities: [], acceptanceCriteria: [{
            id: 'criterion-event-failure', description: 'accepted', evidenceRequired: false,
          }], maxAttempts: 1,
        }] })).rejects.toThrow(/management event|management_events/i);
      await expect(fixture.repositories.tasks.getById('event-failure-task')).resolves.toBeNull();
      await expect(fixture.repositories.taskCoordination.coordinations.getByTaskId('event-failure-task'))
        .resolves.toBeNull();
    } finally {
      fixture.close();
    }
  });
});

function rootInput(authority: Authority) {
  return {
    authority, idempotencyKey: 'root-coordination', taskId: 'root-task',
    claimPolicy: 'open' as const, requiredCapabilities: [],
    acceptanceCriteria: [{ id: 'criterion-root', description: 'root accepted', evidenceRequired: false }],
    maxAttempts: 1,
  };
}

function subtasksInput(authority: Authority) {
  return {
    authority, idempotencyKey: 'create-subtasks', parentTaskId: 'root-task',
    subtasks: [
      { taskId: 'task-a', clientKey: 'a', title: 'Task A', description: 'objective a',
        claimPolicy: 'open' as const, requiredCapabilities: ['research'],
        acceptanceCriteria: [{ id: 'criterion-a', description: 'A accepted', evidenceRequired: true }],
        maxAttempts: 3 },
      { taskId: 'task-b', clientKey: 'b', title: 'Task B', description: 'objective b',
        claimPolicy: 'targeted' as const, targetAgentId: 'agent-2', requiredCapabilities: [],
        acceptanceCriteria: [{ id: 'criterion-b', description: 'B accepted', evidenceRequired: false }],
        maxAttempts: 2 },
    ],
  };
}

type Authority = { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number };

async function createGraphHarness(repositories: ServerNextRepositories) {
  const harness = await createHarness(repositories);
  await harness.kernel.createRootCoordination(rootInput(harness.authority));
  await harness.kernel.createSubtasks(subtasksInput(harness.authority));
  return harness;
}

async function createHarness(repositories: ServerNextRepositories) {
  let id = 0;
  const clock = { now: () => 100 };
  const ids = { nextId: () => id++ === 0 ? 'run-1' : `kernel-${id}` };
  await repositories.tasks.create({ id: 'root-task', teamId: 'team-1', title: 'Root',
    description: 'root objective', status: 'todo', creatorId: 'user-1', channelId: 'channel-1',
    tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
  const managementKernel = createManagementKernel({
    repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork,
    clock, ids,
  });
  await managementKernel.createOrResumeRun(runInput());
  await managementKernel.acquireLease({ managementRunId: 'run-1', workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'lease-token', ttlMs: 1_000 });
  const authority: Authority = { managementRunId: 'run-1', workerId: 'worker-1',
    leaseToken: 'lease-token', fencingToken: 1 };
  return {
    authority,
    kernel: createTaskCoordinationKernel({ unitOfWork: repositories.taskCoordinationUnitOfWork,
      clock, ids }),
  };
}

function runInput() {
  return {
    teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'root-task',
    rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'request-hash',
    placementPolicy: { placement: 'device' as const, allowServerContext: false,
      requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  };
}

function claim() {
  return { id: 'claim-a', teamId: 'team-1', taskId: 'task-a', taskRevision: 1,
    taskAttempt: 1, agentId: 'agent-1', leaseTokenHash: 'claim-hash',
    leaseFingerprint: 'claim-fingerprint', fencingToken: 1, status: 'active' as const,
    acquiredAt: 10, heartbeatAt: 10, expiresAt: 1_000 };
}

function invocation() {
  return { schemaVersion: 1 as const, id: 'invocation-a', managementRunId: 'run-1',
    intent: { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1',
      targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: 'objective a',
      taskContext: { taskId: 'task-a', rootTaskId: 'root-task', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-a' }, acceptanceCriteria: [],
      dependencyResults: [], attachmentIds: [] }, intentHash: 'intent-hash',
    idempotencyKey: 'invocation-key', createdAt: 20 };
}
