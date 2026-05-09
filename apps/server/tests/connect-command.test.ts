import { describe, it, expect } from 'vitest';
import { renderConnectCommand } from '../src/connect-command.js';

describe('renderConnectCommand', () => {
  it('uses adapterKind to pick a config example', () => {
    const out = renderConnectCommand({ adapterKind: 'codex' });
    expect(out).toContain('AGENT_CONFIG=examples/codex-shaw.yaml.example');
    expect(out).toContain('cd apps/agent');
  });

  it('falls back to the generic example for unknown kinds', () => {
    const out = renderConnectCommand({ adapterKind: 'hermes' });
    expect(out).toContain('AGENT_CONFIG=examples/agent.config.yaml.example');
  });
});
