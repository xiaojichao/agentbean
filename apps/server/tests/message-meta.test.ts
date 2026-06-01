import { describe, expect, it } from 'vitest';
import { enrichAgentSenderName } from '../src/message-meta.js';

describe('enrichAgentSenderName', () => {
  it('adds a resolved senderName to old agent messages that do not have one', () => {
    const msg = {
      id: 'm1',
      channelId: 'c1',
      senderKind: 'agent' as const,
      senderId: 'gateway-agent',
      body: '我是 gateway-agent',
      createdAt: 1,
      metaJson: JSON.stringify({ kind: 'intro' }),
    };

    const enriched = enrichAgentSenderName(msg, 'gateway-agent');

    expect(JSON.parse(enriched.metaJson ?? '{}')).toMatchObject({
      kind: 'intro',
      senderName: 'gateway-agent',
    });
  });

  it('keeps an existing senderName unchanged', () => {
    const msg = {
      id: 'm1',
      channelId: 'c1',
      senderKind: 'agent' as const,
      senderId: 'gateway-agent',
      body: 'hello',
      createdAt: 1,
      metaJson: JSON.stringify({ senderName: 'Stored Agent' }),
    };

    const enriched = enrichAgentSenderName(msg, 'Fresh Agent');

    expect(JSON.parse(enriched.metaJson ?? '{}').senderName).toBe('Stored Agent');
  });
});
