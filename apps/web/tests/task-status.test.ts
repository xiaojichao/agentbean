import { describe, expect, it } from 'vitest';
import {
  TASK_STATUS_BY_ID,
  TASK_STATUS_COLUMNS,
  TASK_STATUS_MENU_DOT_CLASS,
  TASK_STATUS_MENU_ITEM_CLASS,
  TASK_STATUS_MENU_LABEL_CLASS,
  TASK_STATUS_MENU_PANEL_CLASS,
  TASK_STATUS_MENU_PANEL_STYLE,
  taskStatusDotClass,
} from '../lib/task-status.js';

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

  it('keeps the compact dropdown menu styling shared across chat and task views', () => {
    expect(TASK_STATUS_MENU_PANEL_CLASS).toContain('z-50');
    expect(TASK_STATUS_MENU_PANEL_STYLE.width).toBe(136);
    expect(TASK_STATUS_MENU_PANEL_STYLE.boxShadow).toBe('0 4px 14px rgba(15, 23, 42, 0.14)');
    expect(TASK_STATUS_MENU_ITEM_CLASS).toContain('h-6');
    expect(TASK_STATUS_MENU_DOT_CLASS).toContain('h-2');
    expect(TASK_STATUS_MENU_LABEL_CLASS).toContain('truncate');
  });
});
