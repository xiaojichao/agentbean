import { describe, expect, test, vi } from 'vitest';
import { createClientMessageId, messageSendFailureText } from '../lib/message-send';

describe('channel message send helpers', () => {
  test('creates a non-empty idempotency key for each composer send', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_234);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(createClientMessageId('chat')).toBe('chat-1234-8');

    vi.restoreAllMocks();
  });

  test('shows the server diagnostic instead of collapsing every failure to its error code', () => {
    expect(messageSendFailureText({
      error: 'VALIDATION_ERROR',
      message: 'MANAGEMENT_CLIENT_MESSAGE_ID_REQUIRED',
    })).toBe('发送失败：MANAGEMENT_CLIENT_MESSAGE_ID_REQUIRED');
    expect(messageSendFailureText({ error: 'FORBIDDEN' })).toBe('发送失败：FORBIDDEN');
  });

  test('does not render a successful message object as an error detail', () => {
    expect(messageSendFailureText({ error: 'VALIDATION_ERROR', message: { id: 'message-1' } }))
      .toBe('发送失败：VALIDATION_ERROR');
  });
});
