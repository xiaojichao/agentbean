import { describe, expect, test } from 'vitest';
import { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from '../src/index';

describe('daemon-next builtin scanner', () => {
  test('reports known runtimes without creating visible product agents', async () => {
    const snapshot = await scanBuiltinRuntimeAgents({
      findExecutable: async (bin) => {
        if (bin === 'codex') {
          return '/opt/homebrew/bin/codex';
        }
        if (bin === 'claude') {
          return '/Users/shaw/.local/share/claude-latest/current/claude';
        }
        return null;
      },
    });

    expect(snapshot.runtimes).toEqual([
      {
        adapterKind: 'claude-code',
        name: 'Claude Code',
        command: '/Users/shaw/.local/share/claude-latest/current/claude',
        cwd: '/Users/shaw/.local/share/claude-latest/current',
        installed: true,
      },
      {
        adapterKind: 'codex',
        name: 'Codex CLI',
        command: '/opt/homebrew/bin/codex',
        cwd: '/opt/homebrew/bin',
        installed: true,
      },
      {
        adapterKind: 'gemini',
        name: 'Gemini CLI',
        command: undefined,
        cwd: undefined,
        installed: false,
      },
    ]);
    expect(snapshot.agents).toEqual([]);
  });

  test('creates a scan provider wrapper for protocol rescan injection', async () => {
    const scan = createBuiltinScanProvider({
      findExecutable: async (bin) => (bin === 'gemini' ? '/usr/local/bin/gemini' : null),
    });

    await expect(scan()).resolves.toMatchObject({
      runtimes: [
        { adapterKind: 'claude-code', installed: false },
        { adapterKind: 'codex', installed: false },
        { adapterKind: 'gemini', command: '/usr/local/bin/gemini', installed: true },
      ],
      agents: [],
    });
  });
});
