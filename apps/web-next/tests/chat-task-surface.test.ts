import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('chat task surface', () => {
  test('keeps task-linked messages as compact timeline badges', () => {
    const source = readFileSync(new URL('../app/[networkPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source).toContain('function ChatTaskBadge');
    expect(source).not.toContain('data-smoke="chat-task-card"');
    expect(source).not.toContain('function ChatTaskCard');
  });

  test('opens the status menu from the whole task badge instead of task detail', () => {
    const source = readFileSync(new URL('../app/[networkPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ChatTaskBadge');
    const end = source.indexOf('function taskBadgeIcon', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const badge = source.slice(start, end);
    expect(badge).toContain("if (canChange) onOpen?.(!open);");
    expect(badge).not.toContain('onOpenDetail');
    expect(badge).not.toContain('rounded-l-full');
    expect(badge).not.toContain('rounded-r-full');
  });
});
