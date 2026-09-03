import { describe, expect, test, vi } from 'vitest';
import { WEB_EVENTS } from '../../../packages/contracts/src/index';
import { createTaskSocketProjection } from '../src/transport/task-socket-projection';

describe('Task socket projection', () => {
  test('deduplicates Task updates and refreshes each Team projection once', async () => {
    const channelEvents: Array<{ event: string; payload: unknown }> = [];
    const agentEvents: Array<{ event: string; payload: unknown }> = [];
    const subscribers = new Set([
      {
        socket: { emit: (event: string, payload: unknown) => channelEvents.push({ event, payload }) },
        channels: { userId: 'user-1', teamId: 'team-1' },
      },
      {
        socket: { emit: (event: string, payload: unknown) => agentEvents.push({ event, payload }) },
        agents: { userId: 'user-2', teamId: 'team-1' },
      },
    ]);
    const listTasks = vi.fn().mockResolvedValue({
      ok: true,
      tasks: [{ id: 'task-1' }, { id: 'task-2' }],
    });
    const projection = createTaskSocketProjection(subscribers, { listTasks });

    await projection.handleMutation({
      ok: true,
      tasks: [
        { id: 'task-1', teamId: 'team-1', status: 'todo' },
        { id: 'task-1', teamId: 'team-1', status: 'todo' },
        { id: 'task-2', teamId: 'team-1', status: 'in_progress' },
      ],
    });

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(listTasks).toHaveBeenCalledWith({ userId: 'user-1', teamId: 'team-1' });
    expect(channelEvents).toEqual([
      { event: WEB_EVENTS.task.updated, payload: expect.objectContaining({ id: 'task-1' }) },
      { event: WEB_EVENTS.task.updated, payload: expect.objectContaining({ id: 'task-2' }) },
      { event: WEB_EVENTS.task.snapshot, payload: [{ id: 'task-1' }, { id: 'task-2' }] },
      { event: WEB_EVENTS.memory.changed, payload: { teamId: 'team-1' } },
    ]);
    expect(agentEvents).toEqual([
      { event: WEB_EVENTS.task.updated, payload: expect.objectContaining({ id: 'task-1' }) },
      { event: WEB_EVENTS.task.updated, payload: expect.objectContaining({ id: 'task-2' }) },
      { event: WEB_EVENTS.memory.changed, payload: { teamId: 'team-1' } },
    ]);
  });

  test('does not project failed or Task-less results', async () => {
    const emit = vi.fn();
    const listTasks = vi.fn();
    const projection = createTaskSocketProjection(new Set([
      {
        socket: { emit },
        channels: { userId: 'user-1', teamId: 'team-1' },
      },
    ]), { listTasks });

    await projection.handleMutation({ ok: false, error: 'CONFLICT' });
    await projection.handleMutation({ ok: true });

    expect(emit).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
  });
});
