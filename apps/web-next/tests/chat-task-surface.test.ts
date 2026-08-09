import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('chat task surface', () => {
  test('keeps task-linked messages as compact timeline badges', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source).toContain('function ChatTaskBadge');
    expect(source).not.toContain('data-smoke="chat-task-card"');
    expect(source).not.toContain('function ChatTaskCard');
  });

  test('opens the status menu from the whole task badge instead of task detail', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
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

  test('聊天、Activity 与消息搜索共用 chat-view 投影，TaskDetail 从原始消息恢复状态历史', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source.match(/projectChatViewMessages\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('taskStatusMessagesForTask(messages, taskDetailTaskId)');
    expect(source).toContain('taskIdForStatusMessageDeepLink(messages, targetMessageId)');
  });

  test('隐藏状态消息深链只重写 Task URL，不复制 TaskDetail 本地状态', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const linkedTaskId = taskIdForStatusMessageDeepLink');
    const end = source.indexOf("setTab('chat');", start);
    const redirectBranch = source.slice(start, end);

    expect(redirectBranch).toContain("params.set('task'");
    expect(redirectBranch).not.toContain('setTaskDetailMessageId');
    expect(redirectBranch).not.toContain('setTaskDetailOnlyTaskId');
  });

  test('ThreadPanel 只把根消息解析出的 Task id 交给既有活动卡 section', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ThreadPanel');
    const end = source.indexOf('function ProfilePanel', start);
    const threadPanel = source.slice(start, end);

    expect(threadPanel).toContain('const rootTaskId = metaTaskId(root);');
    expect(threadPanel).toContain('<TaskThreadActivitySection');
    expect(threadPanel).toContain('taskId={rootTaskId}');
    expect(threadPanel).toContain('threadId={root.id}');
  });
});
