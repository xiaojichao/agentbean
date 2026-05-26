import { describe, expect, it } from 'vitest';
import { TASK_STATUS_BY_ID, TASK_STATUS_COLUMNS, taskStatusDotClass } from '../lib/task-status.js';

describe('task status styles', () => {
  it('keeps every status badge paired with the same dot color used by menus', () => {
    for (const status of TASK_STATUS_COLUMNS) {
      expect(taskStatusDotClass(status.id)).toBe(status.dot);
      expect(TASK_STATUS_BY_ID[status.id].dot).toBe(status.dot);
    }
  });

  it('uses the closed status neutral dot instead of the completed green dot', () => {
    expect(TASK_STATUS_BY_ID.closed.dot).toBe('bg-neutral-500');
    expect(TASK_STATUS_BY_ID.closed.badge).toContain('text-neutral-600');
  });
});
