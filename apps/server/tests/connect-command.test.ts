import { describe, it, expect } from 'vitest';
import { renderConnectCommand } from '../src/connect-command.js';

describe('renderConnectCommand', () => {
  it('returns npx command with default localhost url', () => {
    const out = renderConnectCommand({ adapterKind: 'codex' });
    expect(out).toBe('npx @agentbean/daemon@latest --server-url http://localhost:4000');
  });

  it('includes token when provided', () => {
    const out = renderConnectCommand({ adapterKind: 'claude-code', token: 'my-token' });
    expect(out).toBe('npx @agentbean/daemon@latest --server-url http://localhost:4000 --token my-token');
  });

  it('uses custom server url', () => {
    const out = renderConnectCommand({ adapterKind: 'codex', serverUrl: 'https://api.example.com' });
    expect(out).toBe('npx @agentbean/daemon@latest --server-url https://api.example.com');
  });
});
