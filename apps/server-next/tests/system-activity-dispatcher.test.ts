import { describe, expect, test } from 'vitest';
import { createSystemActivityDispatcher } from '../src/application/system-activity-dispatcher.js';
import { createMemorySystemActivityUnitOfWork } from '../src/application/system-activity-unit-of-work.js';
import {
  cloneSystemActivityMemoryState,
  createInMemorySystemActivityRepositories,
  createSystemActivityMemoryState,
  restoreSystemActivityMemoryState,
} from '../src/infra/memory/system-activity-repositories.js';

function createDispatcher() {
  const state = createSystemActivityMemoryState();
  const repos = createInMemorySystemActivityRepositories(state);
  let seq = 0;
  return createSystemActivityDispatcher({
    teamId: 'team-1',
    unitOfWork: createMemorySystemActivityUnitOfWork({
      repos,
      snapshot: () => cloneSystemActivityMemoryState(state),
      restore: (snap) => restoreSystemActivityMemoryState(
        state,
        snap as ReturnType<typeof createSystemActivityMemoryState>,
      ),
    }),
    ids: { nextId: () => `id-${++seq}` },
    clock: { now: () => 1000 + seq },
  });
}

describe('system-activity dispatcher', () => {
  test('command 路由 project-source-fact', async () => {
    const d = createDispatcher();
    const res = await d.dispatchCommand({
      envelope: {
        schemaVersion: 1,
        commandName: 'project-source-fact',
        commandSchemaVersion: 1,
        idempotencyKey: 'k1',
      },
      payload: {
        fact: {
          schemaVersion: 1,
          eventId: 'evt-1',
          streamKind: 'task',
          streamId: 'task-1',
          sequence: 1,
          teamId: 'team-1',
          taskId: 'task-1',
          factKind: 'task_created',
          occurredAt: 100,
          visibleRecipientIds: ['user-a'],
          responsibleRecipientIds: ['user-a'],
          summary: 'created',
        },
        projectionWatermark: 1,
      },
    });
    expect(res.outcome).toBe('applied');
  });

  test('query 路由 query-task-activity', async () => {
    const d = createDispatcher();
    await d.dispatchCommand({
      envelope: {
        schemaVersion: 1,
        commandName: 'project-source-fact',
        commandSchemaVersion: 1,
        idempotencyKey: 'k1',
      },
      payload: {
        fact: {
          schemaVersion: 1,
          eventId: 'evt-1',
          streamKind: 'task',
          streamId: 'task-1',
          sequence: 1,
          teamId: 'team-1',
          taskId: 'task-1',
          factKind: 'task_created',
          occurredAt: 100,
          visibleRecipientIds: ['user-a'],
          responsibleRecipientIds: ['user-a'],
          summary: 'created',
        },
        projectionWatermark: 1,
      },
    });
    const q = await d.dispatchQuery({
      queryName: 'query-task-activity',
      payload: { taskId: 'task-1', recipientId: 'user-a', limit: 10 },
    });
    expect(q.outcome).toBe('ready');
  });

  test('非法 envelope 拒绝', async () => {
    const d = createDispatcher();
    const res = await d.dispatchCommand({
      envelope: { schemaVersion: 1, commandName: 'nope', commandSchemaVersion: 1, idempotencyKey: 'x' },
      payload: {},
    });
    expect(res.outcome).toBe('rejected');
  });
});
