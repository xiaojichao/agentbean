import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const source = readFileSync(
  fileURLToPath(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url)),
  'utf8',
);

describe('channel collaboration composer', () => {
  test('only sends the structured trigger after explicit user selection', () => {
    expect(source).toContain('data-smoke="chat-channel-collaboration-toggle"');
    expect(source).toContain('频道 Agent 协作');
    expect(source).toContain('collaborationTask: ALL_CHANNEL_AGENTS_COLLABORATION_TRIGGER_V1');
    expect(source).toContain('setChannelCollaboration(false)');
  });

  test('keeps direct messages and regular task mode separate', () => {
    expect(source).toContain('{!isDm && (');
    expect(source).toContain('const collaborationMode = channelCollaboration && !isDm');
    expect(source).toContain('...(collaborationMode');
    expect(source).toContain('if (e.target.checked) setChannelCollaboration(false)');
    expect(source).toContain('if (e.target.checked) setAsTask(false)');
  });

  test('refreshes authoritative history after Server-owned collaboration messages are appended', () => {
    expect(source).toContain('WEB_EVENTS.message.messageTracer.delivered, onServerMessageDelivered');
    expect(source).toContain('const result = await channelEvents(socket).join(currentTeamId, activeChannel)');
    expect(source).toContain('applyChannelHistory(activeChannel, result.messages)');
    expect(source).toContain('deliveredRefreshPending = true');
    expect(source).toContain('socket.off(WEB_EVENTS.message.messageTracer.delivered, onServerMessageDelivered)');
  });
});
