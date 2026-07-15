import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import type { ManagementEventV1, ManagementRunDto } from '../../../packages/contracts/src/index.js';
import { createInMemoryManagementPersistence } from '../src/infra/memory/management-repositories.js';
import { createSqliteManagementPersistence } from '../src/infra/sqlite/management-repositories.js';
import { applyTeamMigrations, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe.each([
  ['memory', () => {
    const persistence = createInMemoryManagementPersistence();
    return { ...persistence, close() {} };
  }],
  ['sqlite', () => {
    const db = new Database(':memory:');
    applyTeamMigrations(db);
    return { ...createSqliteManagementPersistence(db), close: () => db.close() };
  }],
] as const)('management Unit of Work (%s)', (_name, createPersistence) => {
  test('atomically creates request reservation, Run, and first Event', async () => {
    const persistence = createPersistence();
    try {
      await expect(persistence.unitOfWork.createRun(createRunInput())).resolves.toMatchObject({
        reservation: { requestKey: 'request-1' },
        run: { id: 'run-1' },
        firstEvent: { event: { id: 'event-1', sequence: 1 } },
      });
      await expect(persistence.repositories.runs.getById('run-1')).resolves.toMatchObject({ id: 'run-1' });
      await expect(persistence.repositories.events.list('run-1')).resolves.toHaveLength(1);
    } finally {
      persistence.close();
    }
  });

  test('rolls back reservation and Run when first Event fails', async () => {
    const persistence = createPersistence();
    try {
      const input = createRunInput();
      await persistence.unitOfWork.createRun(input);
      await expect(persistence.unitOfWork.createRun({
        ...input,
        reservation: { ...input.reservation, id: 'reservation-2', requestKey: 'request-2', managementRunId: 'run-2' },
        run: { ...input.run, id: 'run-2', rootMessageId: 'message-2' },
        firstEvent: { ...input.firstEvent, managementRunId: 'run-2' },
      })).rejects.toThrow();

      await expect(persistence.repositories.reservations.getByRequestKey({ teamId: 'team-1', requestKey: 'request-2' })).resolves.toBeNull();
      await expect(persistence.repositories.runs.getById('run-2')).resolves.toBeNull();
    } finally {
      persistence.close();
    }
  });
});

describe('management SQLite constraints', () => {
  test('persists Phase 2 rollout policy and immutable Run phase while existing rows default to Phase 1', async () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      const { repositories } = createSqliteManagementPersistence(db);
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = 'team/0014_management_phase_2_rollout.sql'").get())
        .toEqual({ id: 'team/0014_management_phase_2_rollout.sql' });
      await repositories.policies.upsert({
        schemaVersion: 2, teamId: 'team-1', mode: 'managed', maxManagementPhase: 2,
        placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
        updatedBy: 'owner-1', updatedAt: 1,
      });
      await expect(repositories.policies.get('team-1')).resolves.toMatchObject({ maxManagementPhase: 2 });
      await repositories.runs.create({
        schemaVersion: 2, managementPhase: 2, id: 'run-phase-2', teamId: 'team-1',
        channelId: 'channel-1', rootTaskId: 'task-root', rootMessageId: 'message-1',
        mode: 'managed', status: 'queued',
        placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
        checkpointRevision: 0, budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
        createdAt: 1, updatedAt: 1,
      });
      await expect(repositories.runs.getById('run-phase-2')).resolves.toMatchObject({
        schemaVersion: 2, managementPhase: 2, rootTaskId: 'task-root',
      });
    } finally {
      db.close();
    }
  });

  test('allows at most one active Dispatch attempt per Invocation', async () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      const { repositories, unitOfWork } = createSqliteManagementPersistence(db);
      await unitOfWork.createRun(createRunInput());
      await repositories.invocations.create({
        schemaVersion: 1,
        id: 'invocation-1',
        managementRunId: 'run-1',
        intent: { schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom', objective: 'answer', acceptanceCriteria: [], dependencyResults: [], attachmentIds: [] },
        intentHash: 'intent-hash',
        idempotencyKey: 'invocation-key',
        createdAt: 1,
      });
      await repositories.dispatchAttempts.create({ id: 'attempt-1', invocationId: 'invocation-1', dispatchId: 'dispatch-1', attemptNumber: 1, status: 'queued', startedAt: 2 });
      await expect(repositories.dispatchAttempts.create({ id: 'attempt-2', invocationId: 'invocation-1', dispatchId: 'dispatch-2', attemptNumber: 2, status: 'running', startedAt: 3 })).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  test('records migration 0010 once and exposes all Phase 1 tables', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      applyTeamMigrations(db);
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = 'team/0010_management_phase_1.sql'").get()).toEqual({ id: 'team/0010_management_phase_1.sql' });
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => (item as { name: string }).name);
      expect(names).toEqual(expect.arrayContaining(['team_management_policies', 'managed_request_reservations', 'management_runs', 'manager_leases', 'management_events', 'management_checkpoints', 'agent_invocations', 'invocation_dispatch_attempts', 'management_shadow_decisions']));
    } finally {
      db.close();
    }
  });

  test('records migration 0017 and exposes the handoff persistence boundary', () => {
    const db = new Database(':memory:');
    try {
      applyTeamMigrations(db);
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = 'team/0017_management_handoff.sql'").get())
        .toEqual({ id: 'team/0017_management_handoff.sql' });
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all().map((item) => (item as { name: string }).name);
      expect(names).toEqual(expect.arrayContaining([
        'agent_collaboration_proposals',
        'agent_handoffs',
      ]));
      const runColumns = db.prepare('PRAGMA table_info(management_runs)').all()
        .map((item) => (item as { name: string }).name);
      expect(runColumns).toEqual(expect.arrayContaining([
        'main_agent_id',
        'active_agent_id',
        'collaboration_mode',
      ]));
    } finally {
      db.close();
    }
  });

  test('rolls back schema when recording the 0010 migration ledger fails', () => {
    const db = new Database(':memory:');
    const phase2Tables = ['agent_handoffs', 'agent_collaboration_proposals', 'subtask_acceptance_evidence_refs', 'subtask_acceptance_criterion_results', 'subtask_acceptances', 'subtask_delivery_evidence_refs', 'subtask_deliveries', 'evidence_snapshots', 'task_claim_leases', 'task_dependencies', 'task_acceptance_criteria', 'task_coordinations'];
    const tables = ['management_shadow_decisions', 'invocation_dispatch_attempts', 'agent_invocations', 'management_checkpoints', 'management_events', 'manager_leases', 'management_runs', 'managed_request_reservations', 'team_management_policies'];
    try {
      applyTeamMigrations(db);
      db.prepare("DELETE FROM schema_migrations WHERE id = 'team/0010_management_phase_1.sql'").run();
      db.prepare("DELETE FROM schema_migrations WHERE id = 'team/0017_management_handoff.sql'").run();
      for (const table of phase2Tables) db.exec(`DROP TABLE ${table};`);
      for (const table of tables) db.exec(`DROP TABLE ${table};`);
      db.exec(`CREATE TRIGGER reject_0010_ledger BEFORE INSERT ON schema_migrations
        WHEN NEW.id = 'team/0010_management_phase_1.sql' BEGIN SELECT RAISE(ABORT, 'reject 0010 ledger'); END;`);

      expect(() => applyTeamMigrations(db)).toThrow(/reject 0010 ledger/);
      const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((item) => (item as { name: string }).name);
      expect(names).not.toEqual(expect.arrayContaining(tables));
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = 'team/0010_management_phase_1.sql'").get()).toBeUndefined();

      db.exec('DROP TRIGGER reject_0010_ledger;');
      applyTeamMigrations(db);
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = 'team/0010_management_phase_1.sql'").get()).toEqual({ id: 'team/0010_management_phase_1.sql' });
    } finally {
      db.close();
    }
  });
});

function createRunInput() {
  const run: ManagementRunDto = {
    schemaVersion: 1, id: 'run-1', teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', mode: 'managed', status: 'queued',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
    checkpointRevision: 0, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 }, createdAt: 1, updatedAt: 1,
  };
  const firstEvent: ManagementEventV1 = {
    schemaVersion: 1, id: 'event-1', managementRunId: 'run-1', sequence: 1, type: 'run-started', actorKind: 'system', idempotencyKey: 'event-key', payload: { rootMessageId: 'message-1', mode: 'managed' }, createdAt: 1,
  };
  return {
    reservation: { id: 'reservation-1', teamId: 'team-1', requestKey: 'request-1', requestHash: 'request-hash', managementRunId: 'run-1', createdAt: 1 },
    run,
    firstEvent,
    firstEventPayloadHash: 'payload-hash',
  };
}
