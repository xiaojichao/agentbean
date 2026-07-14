import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createSubtaskDeliveryService } from '../src/application/management/subtask-delivery-service.js';
import { applyGlobalMigrations, applyTeamMigrations, createSqliteRepositories,
  type SqliteDatabase } from '../src/infra/sqlite/repositories.js';
import { createSubtaskEvidenceHarness } from './subtask-evidence-harness.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('Subtask Delivery Service', () => {
  test('atomically snapshots evidence, records one delivery and moves the Task to in_review', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const service = createSubtaskDeliveryService({ unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock, ids: harness.ids });
    const created = await service.submit(harness.deliveryInput);
    const replay = await service.submit(harness.deliveryInput);

    expect(created).toMatchObject({ disposition: 'created', delivery: {
      taskId: 'task-child', invocationId: 'invocation-1', evidenceRefs: expect.any(Array),
    } });
    expect(replay).toEqual({ ...created, disposition: 'existing' });
    await expect(harness.repositories.tasks.getById('task-child'))
      .resolves.toMatchObject({ status: 'in_review' });
    await expect(harness.repositories.taskCoordination.deliveries.listByTask('task-child'))
      .resolves.toHaveLength(1);
    await expect(harness.repositories.taskCoordination.evidenceSnapshots.listByTask('task-child'))
      .resolves.toHaveLength(5);
    const events = await harness.repositories.management.events.list(harness.run.id);
    expect(events.slice(-2).map(({ event }) => event.type))
      .toEqual(['subtask-delivered', 'task-state-changed']);
  });

  test('rolls back snapshots, delivery and Task status when a locator is not visible', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const service = createSubtaskDeliveryService({ unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock, ids: harness.ids });
    await expect(service.submit({ ...harness.deliveryInput, idempotencyKey: 'delivery-hidden',
      locators: [{ kind: 'message', id: 'delivery-message' },
        { kind: 'artifact', id: 'artifact-private' }] })).rejects.toThrow('EVIDENCE_SOURCE_NOT_VISIBLE');
    await expect(harness.repositories.taskCoordination.evidenceSnapshots.listByTask('task-child'))
      .resolves.toEqual([]);
    await expect(harness.repositories.taskCoordination.deliveries.listByTask('task-child'))
      .resolves.toEqual([]);
    await expect(harness.repositories.tasks.getById('task-child'))
      .resolves.toMatchObject({ status: 'in_progress' });
  });

  test('persists the canonical delivery transaction through SQLite', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    try {
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      const harness = await createSubtaskEvidenceHarness(createSqliteRepositories({ globalDb, teamDb }));
      const service = createSubtaskDeliveryService({
        unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
        clock: harness.clock, ids: harness.ids });
      await expect(service.submit(harness.deliveryInput)).resolves.toMatchObject({
        disposition: 'created', delivery: { evidenceRefs: expect.any(Array) },
      });
      await expect(harness.repositories.tasks.getById('task-child'))
        .resolves.toMatchObject({ status: 'in_review' });
      await expect(harness.repositories.taskCoordination.evidenceSnapshots.listByTask('task-child'))
        .resolves.toHaveLength(5);
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });
});
