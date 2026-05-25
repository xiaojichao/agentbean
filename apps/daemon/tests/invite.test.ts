import { describe, expect, it } from 'vitest';
import { createInviteSocketOptions, INVITE_CONNECTION_TIMEOUT_MS, socketErrorMessage } from '../src/index.js';

describe('invite CLI connection behavior', () => {
  it('allows Socket.IO transport fallback instead of forcing websocket-only', () => {
    const options = createInviteSocketOptions();

    expect(options.auth).toEqual({ invite: true });
    expect(options.reconnection).toBe(false);
    expect(options.timeout).toBe(INVITE_CONNECTION_TIMEOUT_MS);
    expect(options).not.toHaveProperty('transports');
  });

  it('surfaces nested socket connection error details', () => {
    expect(socketErrorMessage({
      message: 'xhr poll error',
      description: { message: 'getaddrinfo ENOTFOUND api.agentbean.dev' },
    })).toBe('xhr poll error: getaddrinfo ENOTFOUND api.agentbean.dev');
  });
});
