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
    // 原型 @选择器扩展:成员/智能体 + 文件包 + 文件 三类候选(原 threadMentionMembers 已扩展为 threadMentionItems)。
    expect(panel).toContain('threadMentionItems');
    expect(panel).toContain('data-smoke="thread-mention-candidate"');
    expect(panel).toContain('data-smoke="thread-mention-package"');
    expect(panel).toContain('data-smoke="thread-mention-file"');
    expect(panel).toContain("if (e.key === 'ArrowDown')");
    expect(panel).toContain("if (e.key === 'Enter' || e.key === 'Tab')");
  });

  test('every channel message send carries an idempotency key', () => {
    const chatSource = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const taskSource = readFileSync(new URL('../app/[teamPath]/tasks/page.tsx', import.meta.url), 'utf8');
    const chatSends = chatSource.match(/getWebSocket\(\)\.emit\(WEB_EVENTS\.message\.send,[^\n]+/g) ?? [];
    const taskSends = taskSource.match(/getWebSocket\(\)\.emit\(WEB_EVENTS\.message\.send,[^\n]+/g) ?? [];

    expect(chatSends).toHaveLength(2);
    expect(taskSends).toHaveLength(1);
    for (const callsite of [...chatSends, ...taskSends]) {
      expect(callsite).toContain('clientMessageId');
    }
  });
});
