import { describe, expect, test } from 'vitest';
import { taskMessageSummary } from '../lib/task-message-summary';

describe('taskMessageSummary', () => {
  test('uses task title, number, assignee and status for task messages', () => {
    expect(taskMessageSummary({
      task: {
        title: 'Fix checkout',
        description: 'Handle failed payment retry',
        status: 'in_progress',
        updatedAt: 123,
      },
      taskNumber: 7,
      assigneeName: 'Agent A',
      fallbackBody: 'fallback',
    })).toEqual({
      label: '#7',
      title: 'Fix checkout',
      description: 'Handle failed payment retry',
      assigneeName: 'Agent A',
      status: 'in_progress',
      updatedAt: 123,
    });
  });

  test('hides duplicate descriptions and falls back to the message body', () => {
    expect(taskMessageSummary({
      task: {
        title: 'Ship task card',
        description: 'Ship task card',
        status: 'todo',
        updatedAt: 456,
      },
      assigneeName: 'Agent B',
      fallbackBody: 'fallback body',
    })).toMatchObject({
      label: '#任务',
      title: 'Ship task card',
      description: null,
      status: 'todo',
    });

    expect(taskMessageSummary({
      task: null,
      assigneeName: 'Agent C',
      fallbackBody: 'Create a report',
    })).toMatchObject({
      title: 'Create a report',
      status: 'todo',
      updatedAt: null,
    });
  });
});
