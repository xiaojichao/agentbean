import { describe, expect, test } from 'vitest';
import { taskRootIdFromMessageMeta, taskStatusEventSummary } from '../lib/task-status-event';

describe('taskStatusEventSummary', () => {
  test('extracts task id, title label and valid status from task status events', () => {
    expect(taskStatusEventSummary({
      kind: 'task-status-updated',
      taskId: 'task-1',
      taskTitle: 'Ship task card',
      status: 'done',
    })).toEqual({
      taskId: 'task-1',
      label: '「Ship task card」',
      status: 'done',
    });
  });

  test('prefers task number and falls back to todo for invalid status', () => {
    expect(taskStatusEventSummary({
      kind: 'task-status-updated',
      taskId: '',
      taskNumber: 12,
      status: 'bad',
    })).toEqual({
      taskId: null,
      label: '#12',
      status: 'todo',
    });
  });

  test('ignores non task status events', () => {
    expect(taskStatusEventSummary({ kind: 'task-created', taskId: 'task-1' })).toBeNull();
  });

  test('does not treat task status events as task root messages', () => {
    expect(taskRootIdFromMessageMeta({
      kind: 'task-status-updated',
      taskId: 'task-1',
      status: 'done',
    })).toBeNull();
  });

  test('keeps ordinary task-linked messages eligible as task roots', () => {
    expect(taskRootIdFromMessageMeta({ taskId: 'task-1' })).toBe('task-1');
  });
});
