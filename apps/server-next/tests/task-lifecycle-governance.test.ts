import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import {
  createTaskLifecycleKernel,
  unpackLifecycleReceiptResultJson,
} from '../src/application/management/task-lifecycle-kernel.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type { TaskLifecycleCommandEnvelopeV1 } from '../../../packages/contracts/src/index.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

type Authority = {
  managementRunId: string;
  workerId: string;
  leaseToken: string;
  fencingToken: number;
};

let idemSeq = 0;
function nextIdem(): string {
  idemSeq += 1;
  return `gov-idem-${idemSeq}`;
}
function makeEnvelope(
  commandName: TaskLifecycleCommandEnvelopeV1['commandName'],
): TaskLifecycleCommandEnvelopeV1 {
  return {
    schemaVersion: 1,
    commandName,
    commandSchemaVersion: 1,
    idempotencyKey: nextIdem(),
  };
}

/**
 * #996：reason 审计、tombstone 读取、cascade 与 domain 纯函数对齐。
 */
describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA foreign_keys = ON;');
    applyTeamMigrations(db);
    return {
      repositories: createSqliteRepositories({ globalDb: db, teamDb: db }),
      close: () => db.close(),
    };
  }],
] as const)('Task lifecycle governance (#996, %s)', (_name, createFixture) => {
  test('cancel 将 reason 写入 event 与 receipt，可查询', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const envelope = makeEnvelope('cancel-task');
      const r = await h.lifecycle.cancelTask(
        envelope,
        { taskId: 'root-task', expectedTaskRevision: 1, reason: '预算耗尽' },
        h.authority,
        'admin',
        'team-1',
      );
      expect(r.result.status).toBe('cancelled');
      expect(r.reason).toBe('预算耗尽');

      const receipt = await fixture.repositories.taskCoordinationUnitOfWork.run(async (repos) =>
        repos.lifecycle.receipts.getReceiptByIdempotencyKey(envelope.idempotencyKey));
      expect(receipt).toBeTruthy();
      const unpacked = unpackLifecycleReceiptResultJson<{ status: string }>(receipt!.resultJson);
      expect(unpacked.reason).toBe('预算耗尽');
      expect(unpacked.result.status).toBe('cancelled');

      const events = await fixture.repositories.management.events.list('run-1');
      const stateChanged = events.find(({ event }) =>
        event.type === 'task-state-changed' && event.idempotencyKey === envelope.idempotencyKey);
      expect(stateChanged?.event.type).toBe('task-state-changed');
      if (stateChanged?.event.type === 'task-state-changed') {
        expect(stateChanged.event.payload.reason).toBe('预算耗尽');
        expect(stateChanged.event.payload.to).toBe('cancelled');
      }
    } finally {
      fixture.close();
    }
  });

  test('同 idempotencyKey 重放读 receipt，不二次 cascade', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories, { withSubtask: true });
      const envelope = makeEnvelope('cancel-task');
      const first = await h.lifecycle.cancelTask(
        envelope,
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'abort tree' },
        h.authority,
        'admin',
        'team-1',
      );
      expect(first.disposition).toBe('applied');
      expect(first.result.cancelledSubtaskIds).toContain('sub-task');

      const second = await h.lifecycle.cancelTask(
        envelope,
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'abort tree' },
        h.authority,
        'admin',
        'team-1',
      );
      expect(second.disposition).toBe('replayed');
      expect(second.result.cancelledSubtaskIds).toEqual(first.result.cancelledSubtaskIds);
      expect(second.reason).toBe('abort tree');

      await expect(fixture.repositories.tasks.getById('sub-task')).resolves.toMatchObject({
        status: 'cancelled',
      });
    } finally {
      fixture.close();
    }
  });

  test('治理压缩 receipt 后仍可读 tombstone，不 silent re-apply', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const envelope = makeEnvelope('close-task');
      await h.lifecycle.closeTask(
        envelope,
        { taskId: 'root-task', expectedTaskRevision: 1, reason: '行政关闭' },
        h.authority,
        'admin',
        'team-1',
      );

      const deleted = await fixture.repositories.taskCoordinationUnitOfWork.run(async (repos) =>
        repos.lifecycle.receipts.deleteReceiptByIdempotencyKey(envelope.idempotencyKey));
      expect(deleted).toBe(true);
      const tombstone = await fixture.repositories.taskCoordinationUnitOfWork.run(async (repos) =>
        repos.lifecycle.receipts.getTombstoneByIdempotencyKey(envelope.idempotencyKey));
      expect(tombstone).toBeTruthy();

      const replay = await h.lifecycle.closeTask(
        envelope,
        { taskId: 'root-task', expectedTaskRevision: 1, reason: '行政关闭' },
        h.authority,
        'admin',
        'team-1',
      );
      expect(replay.disposition).toBe('replayed');
      await expect(fixture.repositories.tasks.getById('root-task')).resolves.toMatchObject({
        status: 'closed',
      });
    } finally {
      fixture.close();
    }
  });

  test('cascade 仅影响非终态子任务（与 evaluateRootCascadeCloseout 一致）', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories, {
        withSubtask: true,
        subtaskStatus: 'done',
      });
      await fixture.repositories.tasks.create({
        id: 'sub-open',
        teamId: 'team-1',
        title: 'Open sub',
        description: '',
        status: 'todo',
        creatorId: 'user-1',
        channelId: 'channel-1',
        tags: [],
        sortOrder: 2,
        createdAt: 2,
        updatedAt: 2,
      });
      await fixture.repositories.taskCoordinationUnitOfWork.run(async (repos) => {
        await repos.coordination.coordinations.create({
          schemaVersion: 1,
          taskId: 'sub-open',
          teamId: 'team-1',
          managementRunId: 'run-1',
          rootTaskId: 'root-task',
          nodeKind: 'subtask',
          parentTaskId: 'root-task',
          reviewPolicy: 'manager',
          taskRevision: 1,
          attempt: 1,
          maxAttempts: 1,
          claimPolicy: 'open',
          requiredCapabilities: [],
          createdAt: 2,
          updatedAt: 2,
        });
      });

      const r = await h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'cascade check' },
        h.authority,
        'admin',
        'team-1',
      );
      expect(r.result.cancelledSubtaskIds).toContain('sub-open');
      expect(r.result.cancelledSubtaskIds).not.toContain('sub-task');
      await expect(fixture.repositories.tasks.getById('sub-task')).resolves.toMatchObject({
        status: 'done',
      });
      await expect(fixture.repositories.tasks.getById('sub-open')).resolves.toMatchObject({
        status: 'cancelled',
      });
    } finally {
      fixture.close();
    }
  });
});

describe('unpackLifecycleReceiptResultJson', () => {
  test('兼容旧版直接存 result 的 receipt', () => {
    const legacy = unpackLifecycleReceiptResultJson<{ status: string }>(
      JSON.stringify({ status: 'cancelled', taskId: 't1' }),
    );
    expect(legacy.result.status).toBe('cancelled');
    expect(legacy.reason).toBeUndefined();
  });

  test('解析 v1 包装与 reason', () => {
    const modern = unpackLifecycleReceiptResultJson<{ status: string }>(
      JSON.stringify({ v: 1, result: { status: 'closed' }, reason: 'admin' }),
    );
    expect(modern.result.status).toBe('closed');
    expect(modern.reason).toBe('admin');
  });
});

async function createHarness(
  repositories: ServerNextRepositories,
  options: { withSubtask?: boolean; subtaskStatus?: 'todo' | 'done' } = {},
) {
  let id = 0;
  const clock = { now: () => 100 };
  const ids = { nextId: () => (id++ === 0 ? 'run-1' : `gov-${id}`) };
  await repositories.tasks.create({
    id: 'root-task',
    teamId: 'team-1',
    title: 'Root',
    description: 'root objective',
    status: 'todo',
    creatorId: 'user-1',
    channelId: 'channel-1',
    tags: [],
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });
  const managementKernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock,
    ids,
  });
  await managementKernel.createOrResumeRun({
    teamId: 'team-1',
    channelId: 'channel-1',
    rootTaskId: 'root-task',
    rootMessageId: 'message-1',
    requestKey: 'request-1',
    requestHash: 'request-hash',
    placementPolicy: {
      placement: 'device' as const,
      allowServerContext: false,
      requireLocalModelCredentials: true,
    },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  await managementKernel.acquireLease({
    managementRunId: 'run-1',
    workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' },
    leaseToken: 'lease-token',
    ttlMs: 1_000,
  });
  const authority: Authority = {
    managementRunId: 'run-1',
    workerId: 'worker-1',
    leaseToken: 'lease-token',
    fencingToken: 1,
  };

  const coordKernel = createTaskCoordinationKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  await coordKernel.createRootCoordination({
    authority,
    idempotencyKey: 'root-coordination',
    taskId: 'root-task',
    claimPolicy: 'open' as const,
    requiredCapabilities: [],
    acceptanceCriteria: [
      { id: 'criterion-root', description: 'root done', evidenceRequired: false },
    ],
    maxAttempts: 1,
  });

  if (options.withSubtask) {
    const subStatus = options.subtaskStatus ?? 'todo';
    await repositories.tasks.create({
      id: 'sub-task',
      teamId: 'team-1',
      title: 'Sub',
      description: '',
      status: subStatus,
      creatorId: 'user-1',
      channelId: 'channel-1',
      tags: [],
      sortOrder: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    await repositories.taskCoordinationUnitOfWork.run(async (repos) => {
      await repos.coordination.coordinations.create({
        schemaVersion: 1,
        taskId: 'sub-task',
        teamId: 'team-1',
        managementRunId: 'run-1',
        rootTaskId: 'root-task',
        nodeKind: 'subtask',
        parentTaskId: 'root-task',
        reviewPolicy: 'manager',
        taskRevision: 1,
        attempt: 1,
        maxAttempts: 1,
        claimPolicy: 'open',
        requiredCapabilities: [],
        createdAt: 1,
        updatedAt: 1,
      });
    });
  }

  return {
    authority,
    lifecycle: createTaskLifecycleKernel({
      unitOfWork: repositories.taskCoordinationUnitOfWork,
      clock,
      ids,
    }),
  };
}
