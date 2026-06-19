import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const chatPage = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

describe('chat page dispatch status integration', () => {
  it('listens for dispatch status updates on the routed chat page', () => {
    expect(chatPage).toContain("socket.on('message:dispatch-status', onDispatchStatus);");
    expect(chatPage).toContain("socket.off('message:dispatch-status', onDispatchStatus);");
    expect(chatPage).toContain('applyDispatchStatus(activeChannel, dispatch.messageId, dispatch.status, dispatch.id);');
  });

  it('seeds dispatch state from message:send acknowledgements', () => {
    expect(chatPage.match(/appendAckMessage\(res\);/g)).toHaveLength(2);
    expect(chatPage).toContain("dispatchStatus: dispatch.status ?? 'queued'");
    expect(chatPage).toContain('dispatchId: dispatch.id');
  });

  it('renders a cancellable dispatch status in ChatBubble using ack truth', () => {
    expect(chatPage).toContain('const renderDispatchStatus = () => {');
    expect(chatPage).toContain("emitWithTimeout(getWebSocket(), 'dispatch:cancel', { dispatchId: msg.dispatchId })");
    expect(chatPage).toContain('applyDispatchStatus(msg.channelId, msg.id, res.dispatch.status, res.dispatch.id);');
    expect(chatPage).toContain('{renderDispatchStatus()}');
  });
});
