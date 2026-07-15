import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('chat thread mentions', () => {
  test('thread composer offers current-channel members and keyboard selection', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ThreadPanel');
    const end = source.indexOf('function ProfilePanel', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const panel = source.slice(start, end);
    expect(panel).toContain('activeMentionDraft');
    expect(panel).toContain('replaceActiveMention');
    expect(panel).toContain('threadMentionMembers');
    expect(panel).toContain('data-smoke="thread-mention-candidate"');
    expect(panel).toContain("if (e.key === 'ArrowDown')");
    expect(panel).toContain("if (e.key === 'Enter' || e.key === 'Tab')");
  });
});
