import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url)),
  'utf8',
);

describe('channel collaboration composer', () => {
  test('频道普通消息无需勾选协作模式，意图统一交给 Server 路由', () => {
    expect(source).not.toContain('data-smoke="chat-channel-collaboration-toggle"');
    expect(source).not.toContain('频道 Agent 协作');
    expect(source).not.toContain('collaborationTask: ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1');
    expect(source).not.toContain('channelCollaboration');
  });

  test('保留用户明确选择的“作为任务”，但不把它当成自动协作前提', () => {
    expect(source).toContain('data-smoke="chat-as-task-toggle"');
    expect(source).toContain('const createTask = asTask');
    expect(source).toContain('onChange={(e) => setAsTask(e.target.checked)}');
  });

  test('refreshes authoritative history after Server-owned collaboration messages are appended', () => {
    expect(source).toContain('WEB_EVENTS.message.messageTracer.delivered, onServerMessageDelivered');
    expect(source).toContain('const result = await channelEvents(socket).join(currentTeamId, activeChannel)');
    expect(source).toContain('applyChannelHistory(activeChannel, result.messages)');
    expect(source).toContain('deliveredRefreshPending = true');
    expect(source).toContain('socket.off(WEB_EVENTS.message.messageTracer.delivered, onServerMessageDelivered)');
  });
});
