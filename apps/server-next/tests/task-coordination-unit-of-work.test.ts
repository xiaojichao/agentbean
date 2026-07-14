import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import type { ManagementEventV1, ManagementRunDto } from '../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

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
] as const)('Task coordination Unit of Work (%s)', (_name, createFixture) => {
  test('atomically creates Task revision, coordination, criterion, and Event', async () => {
    const fixture = createFixture();
    try {
      await seedRun(fixture.repositories);
      await fixture.repositories.taskCoordinationUnitOfWork.run(async ({
        tasks, coordination, management,
      }) => {
        await tasks.create(task('task-1'));
        await coordination.coordinations.create(coordinationRecord('task-1'));
        await coordination.criteria.create(criterion('task-1'));
        await management.events.append({ event: taskCreatedEvent('event-2', 2, 'task-1'), payloadHash: 'event-hash-2' });
      });

      await expect(fixture.repositories.tasks.getById('task-1')).resolves.toMatchObject({ revision: 1 });
      await expect(fixture.repositories.taskCoordination.coordinations.getByTaskId('task-1'))
        .resolves.toMatchObject({ taskRevision: 1, managementRunId: 'run-1' });
      await expect(fixture.repositories.taskCoordination.criteria.list('task-1'))
        .resolves.toMatchObject([{ id: 'criterion-1', introducedRevision: 1 }]);
      await expect(fixture.repositories.management.events.list('run-1')).resolves.toHaveLength(2);
    } finally {
      fixture.close();
    }
  });

  test('rolls back Task and coordination when Event append fails', async () => {
    const fixture = createFixture();
    try {
      await seedRun(fixture.repositories);
      await expect(fixture.repositories.taskCoordinationUnitOfWork.run(async ({
        tasks, coordination, management,
      }) => {
        await tasks.create(task('task-rollback'));
        await coordination.coordinations.create(coordinationRecord('task-rollback'));
        await management.events.append({
          event: taskCreatedEvent('event-duplicate', 1, 'task-rollback'),
          payloadHash: 'duplicate-hash',
        });
      })).rejects.toThrow();

      await expect(fixture.repositories.tasks.getById('task-rollback')).resolves.toBeNull();
      await expect(fixture.repositories.taskCoordination.coordinations.getByTaskId('task-rollback'))
        .resolves.toBeNull();
      await expect(fixture.repositories.management.events.list('run-1')).resolves.toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  test('updates Task and coordination only at the exact expected revision', async () => {
    const fixture = createFixture();
    try {
      await seedTaskGraph(fixture.repositories);
      await fixture.repositories.taskCoordinationUnitOfWork.run(async ({ tasks, coordination }) => {
        await expect(tasks.updateAtRevision({
          taskId: 'task-1', expectedRevision: 1, nextRevision: 2,
          changes: { title: 'Revised', updatedAt: 20 },
        })).resolves.toMatchObject({ revision: 2, title: 'Revised' });
        await expect(coordination.coordinations.update({
          expectedTaskRevision: 1,
          record: { ...coordinationRecord('task-1'), taskRevision: 2, updatedAt: 20 },
        })).resolves.toMatchObject({ taskRevision: 2 });
      });

      await expect(fixture.repositories.tasks.updateAtRevision({
        taskId: 'task-1', expectedRevision: 1, nextRevision: 3,
        changes: { title: 'Stale', updatedAt: 30 },
      })).resolves.toBeNull();
      await expect(fixture.repositories.taskCoordination.coordinations.update({
        expectedTaskRevision: 1,
        record: { ...coordinationRecord('task-1'), taskRevision: 3, updatedAt: 30 },
      })).resolves.toBeNull();
    } finally {
      fixture.close();
    }
  });

  test('rolls back Task and coordination revision together when Event append fails', async () => {
    const fixture = createFixture();
    try {
      await seedTaskGraph(fixture.repositories);
      await expect(fixture.repositories.taskCoordinationUnitOfWork.run(async ({
        tasks, coordination, management,
      }) => {
        const revisedTask = await tasks.updateAtRevision({
          taskId: 'task-1', expectedRevision: 1, nextRevision: 2,
          changes: { title: 'Must roll back', updatedAt: 20 },
        });
        if (!revisedTask) throw new Error('unexpected Task revision conflict');
        const revisedCoordination = await coordination.coordinations.update({
          expectedTaskRevision: 1,
          record: { ...coordinationRecord('task-1'), taskRevision: 2, updatedAt: 20 },
        });
        if (!revisedCoordination) throw new Error('unexpected coordination revision conflict');
        await management.events.append({
          event: taskCreatedEvent('duplicate-event', 1, 'task-1'),
          payloadHash: 'duplicate-event-hash',
        });
      })).rejects.toThrow();

      await expect(fixture.repositories.tasks.getById('task-1'))
        .resolves.toMatchObject({ revision: 1, title: 'Task' });
      await expect(fixture.repositories.taskCoordination.coordinations.getByTaskId('task-1'))
        .resolves.toMatchObject({ taskRevision: 1, updatedAt: 1 });
    } finally {
      fixture.close();
    }
  });

  test('enforces one active claim per Task revision and attempt', async () => {
    const fixture = createFixture();
    try {
      await seedTaskGraph(fixture.repositories);
      await fixture.repositories.taskCoordination.claimLeases.create(claim('claim-1', 'agent-1'));
      await expect(fixture.repositories.taskCoordination.claimLeases.getLatest({
        taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
      })).resolves.toMatchObject({ id: 'claim-1', fencingToken: 1 });
      await expect(fixture.repositories.taskCoordination.claimLeases.listActive())
        .resolves.toMatchObject([{ id: 'claim-1' }]);
      await expect(fixture.repositories.taskCoordination.claimLeases.create(
        claim('claim-2', 'agent-2'),
      )).rejects.toThrow(/active task claim/i);
      await expect(fixture.repositories.taskCoordination.claimLeases.update({
        id: 'claim-1', expectedStatus: 'released', status: 'active', heartbeatAt: 3,
        expiresAt: 101,
      })).resolves.toBeNull();
      await expect(fixture.repositories.taskCoordination.claimLeases.update({
        id: 'claim-1', expectedStatus: 'active', status: 'released', heartbeatAt: 3,
        expiresAt: 101, releasedAt: 3,
      })).resolves.toMatchObject({ status: 'released' });
      await expect(fixture.repositories.taskCoordination.claimLeases.listActive()).resolves.toEqual([]);
      await expect(fixture.repositories.taskCoordination.claimLeases.getLatest({
        taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
      })).resolves.toMatchObject({ id: 'claim-1', status: 'released', fencingToken: 1 });
      await expect(fixture.repositories.taskCoordination.claimLeases.create(
        claim('claim-2', 'agent-2'),
      )).resolves.toMatchObject({ id: 'claim-2', fencingToken: 2 });
      await expect(fixture.repositories.taskCoordination.claimLeases.getLatest({
        taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
      })).resolves.toMatchObject({ id: 'claim-2', fencingToken: 2 });
    } finally {
      fixture.close();
    }
  });

  test('preserves invalidated claim and evidence history after revision advances', async () => {
    const fixture = createFixture();
    try {
      await seedTaskGraph(fixture.repositories);
      await fixture.repositories.management.invocations.create(invocation());
      await fixture.repositories.taskCoordination.claimLeases.create(claim('claim-1', 'agent-1'));
      await fixture.repositories.taskCoordination.evidenceSnapshots.create(snapshot());
      await fixture.repositories.taskCoordinationUnitOfWork.run(async ({
        tasks, coordination, management,
      }) => {
        await coordination.claimLeases.update({ id: 'claim-1', expectedStatus: 'active',
          status: 'invalidated', heartbeatAt: 2, expiresAt: 100, releasedAt: 20 });
        const revisedTask = await tasks.updateAtRevision({
          taskId: 'task-1', expectedRevision: 1, nextRevision: 2,
          changes: { title: 'Revision 2', updatedAt: 20 },
        });
        if (!revisedTask) throw new Error('unexpected Task revision conflict');
        const revisedCoordination = await coordination.coordinations.update({
          expectedTaskRevision: 1,
          record: { ...coordinationRecord('task-1'), taskRevision: 2, updatedAt: 20 },
        });
        if (!revisedCoordination) throw new Error('unexpected coordination revision conflict');
        await management.events.append({ event: taskRevisedEvent(), payloadHash: 'event-hash-3' });
      });

      await expect(fixture.repositories.taskCoordination.claimLeases.getById('claim-1'))
        .resolves.toMatchObject({ taskRevision: 1, status: 'invalidated' });
      await expect(fixture.repositories.taskCoordination.evidenceSnapshots.getById('snapshot-1'))
        .resolves.toMatchObject({ taskRevision: 1, snapshotHash: 'snapshot-hash' });
      await expect(fixture.repositories.taskCoordination.coordinations.getByTaskId('task-1'))
        .resolves.toMatchObject({ taskRevision: 2 });
    } finally {
      fixture.close();
    }
  });

  test('binds delivery and canonical acceptance to exact evidence authority', async () => {
    const fixture = createFixture();
    try {
      await seedTaskGraph(fixture.repositories);
      await fixture.repositories.management.invocations.create(invocation());
      await fixture.repositories.taskCoordination.claimLeases.create(claim('claim-1', 'agent-1'));
      await fixture.repositories.taskCoordination.evidenceSnapshots.create(snapshot());
      await expect(fixture.repositories.taskCoordination.deliveries.create({
        ...delivery('delivery-wrong-evidence', 'wrong-evidence-key'),
        evidenceRefs: [{ ...evidenceRef(), snapshotHash: 'untrusted-agent-hash' }],
      })).rejects.toThrow(/canonical snapshot/i);
      await fixture.repositories.taskCoordination.deliveries.create(delivery('delivery-1', 'delivery-key'));

      await expect(fixture.repositories.taskCoordination.deliveries.create(
        delivery('delivery-2', 'delivery-key'),
      )).rejects.toThrow(/idempotency/i);
      await expect(fixture.repositories.taskCoordination.acceptances.create(
        acceptance('acceptance-1', 1),
      )).resolves.toMatchObject({ canonical: true, decision: 'accepted' });
      await expect(fixture.repositories.taskCoordination.acceptances.create(
        acceptance('acceptance-2', 2),
      )).rejects.toThrow(/canonical/i);
      await expect(fixture.repositories.taskCoordination.acceptances.getCanonicalByDelivery('delivery-1'))
        .resolves.toMatchObject({ id: 'acceptance-1', decisionVersion: 1 });
    } finally {
      fixture.close();
    }
  });
});

describe('Phase 2 Task DAG SQLite migration', () => {
  test('upgrades an old database, backfills revision, and applies once', () => {
    const db = legacyTeamDatabase();
    try {
      db.prepare(`INSERT INTO tasks
        (id, team_id, title, status, creator_id, tags_json, sort_order, created_at, updated_at)
        VALUES ('legacy-task', 'team-1', 'Legacy', 'todo', 'user-1', '[]', 0, 1, 1)`).run();
      applyTeamMigrations(db);
      applyTeamMigrations(db);
      expect(db.prepare("SELECT revision FROM tasks WHERE id = 'legacy-task'").get())
        .toEqual({ revision: 1 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM schema_migrations
        WHERE id = 'team/0013_management_phase_2_task_dag.sql'`).get()).toEqual({ count: 1 });
      const claimColumns = db.prepare("SELECT name FROM pragma_table_info('task_claim_leases')")
        .all().map((item) => (item as { name: string }).name);
      expect(claimColumns).toEqual(expect.arrayContaining(['lease_token_hash', 'lease_fingerprint']));
      expect(claimColumns).not.toContain('lease_token');
    } finally {
      db.close();
    }
  });

  test('rolls back schema when the 0013 migration ledger write fails', () => {
    const db = legacyTeamDatabase();
    try {
      db.exec(`CREATE TRIGGER reject_0013_ledger BEFORE INSERT ON schema_migrations
        WHEN NEW.id = 'team/0013_management_phase_2_task_dag.sql'
        BEGIN SELECT RAISE(ABORT, 'reject 0013 ledger'); END;`);
      expect(() => applyTeamMigrations(db)).toThrow(/reject 0013 ledger/);
      expect(db.prepare(`SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'task_coordinations'`).get()).toBeUndefined();
      expect(db.prepare("SELECT name FROM pragma_table_info('tasks') WHERE name = 'revision'").get())
        .toBeUndefined();
      expect(db.prepare(`SELECT id FROM schema_migrations
        WHERE id = 'team/0013_management_phase_2_task_dag.sql'`).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

async function seedRun(repositories: ServerNextRepositories): Promise<void> {
  await repositories.managementUnitOfWork.createRun(createRunInput());
}

async function seedTaskGraph(repositories: ServerNextRepositories): Promise<void> {
  await seedRun(repositories);
  await repositories.taskCoordinationUnitOfWork.run(async ({ tasks, coordination, management }) => {
    await tasks.create(task('task-1'));
    await coordination.coordinations.create(coordinationRecord('task-1'));
    await coordination.criteria.create(criterion('task-1'));
    await management.events.append({ event: taskCreatedEvent('event-2', 2, 'task-1'), payloadHash: 'event-hash-2' });
  });
}

function task(id: string) {
  return { id, teamId: 'team-1', title: 'Task', status: 'todo' as const,
    creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 };
}

function coordinationRecord(taskId: string) {
  return { schemaVersion: 1 as const, taskId, teamId: 'team-1', managementRunId: 'run-1',
    rootTaskId: taskId, nodeKind: 'root' as const, reviewPolicy: 'human' as const,
    claimPolicy: 'open' as const, requiredCapabilities: [], taskRevision: 1,
    attempt: 1, maxAttempts: 2,
    createdAt: 1, updatedAt: 1 };
}

function criterion(taskId: string) {
  return { taskId, id: 'criterion-1', description: 'Must pass', evidenceRequired: true,
    allowedEvidenceKinds: ['message'] as const, introducedRevision: 1, position: 0 };
}

function claim(id: string, agentId: string) {
  return { id, teamId: 'team-1', taskId: 'task-1', taskRevision: 1, taskAttempt: 1,
    agentId, leaseTokenHash: `${id}-hash`, leaseFingerprint: `${id}-fingerprint`,
    fencingToken: id === 'claim-1' ? 1 : 2, status: 'active' as const,
    acquiredAt: 2, heartbeatAt: 2, expiresAt: 100 };
}

function snapshot() {
  return { id: 'snapshot-1', teamId: 'team-1', taskId: 'task-1', taskRevision: 1,
    taskAttempt: 1, invocationId: 'invocation-1', kind: 'message' as const,
    sourceId: 'message-1', snapshotHash: 'snapshot-hash', snapshot: { body: 'done' },
    capturedAt: 5 };
}

function evidenceRef() {
  return { kind: 'message' as const, id: 'message-1', snapshotHash: 'snapshot-hash', capturedAt: 5 };
}

function delivery(id: string, idempotencyKey: string) {
  return { schemaVersion: 1 as const, id, teamId: 'team-1', taskId: 'task-1',
    taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-1', invocationId: 'invocation-1',
    idempotencyKey, summary: 'done', claims: [{ statement: 'done', evidenceRefs: [evidenceRef()] }],
    evidenceRefs: [evidenceRef()], createdAt: 6 };
}

function acceptance(id: string, decisionVersion: number) {
  return { schemaVersion: 1 as const, id, teamId: 'team-1', taskId: 'task-1',
    deliveryId: 'delivery-1', expectedTaskRevision: 1, taskAttempt: 1,
    claimLeaseId: 'claim-1', decision: 'accepted' as const,
    criteriaResults: [{ criterionId: 'criterion-1', passed: true, evidenceRefs: [evidenceRef()] }],
    reason: 'all criteria passed', decidedBy: 'manager' as const, decidedAt: 7,
    decisionVersion, canonical: true };
}

function invocation() {
  return { schemaVersion: 1 as const, id: 'invocation-1', managementRunId: 'run-1',
    intent: { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1',
      targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: 'do task',
      taskContext: { taskId: 'task-1', rootTaskId: 'task-1', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-1' },
      acceptanceCriteria: [], dependencyResults: [], attachmentIds: [] },
    intentHash: 'intent-hash', idempotencyKey: 'invocation-key', createdAt: 3 };
}

function createRunInput() {
  const run: ManagementRunDto = { schemaVersion: 1, id: 'run-1', teamId: 'team-1',
    channelId: 'channel-1', rootTaskId: 'task-1', rootMessageId: 'message-1', mode: 'managed',
    status: 'queued', placementPolicy: { placement: 'device', allowServerContext: false,
      requireLocalModelCredentials: true }, checkpointRevision: 0,
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
    createdAt: 1, updatedAt: 1 };
  const firstEvent: ManagementEventV1 = { schemaVersion: 1, id: 'event-1',
    managementRunId: 'run-1', sequence: 1, type: 'run-started', actorKind: 'system',
    idempotencyKey: 'event-key-1', payload: { rootTaskId: 'task-1', rootMessageId: 'message-1',
      mode: 'managed' }, createdAt: 1 };
  return { reservation: { id: 'reservation-1', teamId: 'team-1', requestKey: 'request-1',
    requestHash: 'request-hash', managementRunId: 'run-1', createdAt: 1 }, run, firstEvent,
    firstEventPayloadHash: 'event-hash-1' };
}

function taskCreatedEvent(id: string, sequence: number, taskId: string): ManagementEventV1 {
  return { schemaVersion: 1, id, managementRunId: 'run-1', sequence, type: 'task-created',
    actorKind: 'manager', idempotencyKey: `event-key-${sequence}`, payload: { taskId,
      taskRevision: 1 }, createdAt: sequence };
}

function taskRevisedEvent(): ManagementEventV1 {
  return { schemaVersion: 1, id: 'event-3', managementRunId: 'run-1', sequence: 3,
    type: 'task-revised', actorKind: 'manager', idempotencyKey: 'event-key-3',
    payload: { taskId: 'task-1', previousRevision: 1, taskRevision: 2,
      criterionIds: ['criterion-1'], reasonCode: 'requirements_changed' }, createdAt: 20 };
}

function legacyTeamDatabase(): DatabaseWithClose {
  const db = new Database(':memory:');
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL, creator_id TEXT NOT NULL, assignee_id TEXT, channel_id TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]', sort_order REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE team_management_policies (team_id TEXT PRIMARY KEY);
    CREATE TABLE management_runs (id TEXT PRIMARY KEY);
    CREATE TABLE agent_invocations (id TEXT PRIMARY KEY);
  `);
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, 1)');
  for (let index = 1; index <= 12; index += 1) {
    const id = String(index).padStart(4, '0');
    const name = index === 1 ? 'first_slice'
      : index === 2 ? 'artifacts_workspace_runs'
      : index === 3 ? 'tasks'
      : index === 4 ? 'reactions_saved'
      : index === 5 ? 'workspace_run_command'
      : index === 6 ? 'workspace_run_log_excerpt'
      : index === 7 ? 'workspace_run_pagination_index'
      : index === 8 ? 'artifact_workspace_boundary_index'
      : index === 9 ? 'pinned_messages'
      : index === 10 ? 'management_phase_1'
      : index === 11 ? 'management_shadow_namespace'
      : 'management_frozen_target';
    insert.run(`team/${id}_${name}.sql`);
  }
  return db;
}
