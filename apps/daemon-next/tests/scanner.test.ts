import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from '../src/index';

describe('daemon-next builtin scanner', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  test('reports installed coding runtimes as device-hosted agents', async () => {
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
    expect(snapshot.agents).toEqual([
      {
        adapterKind: 'claude-code',
        name: 'Claude Code',
        category: 'executor-hosted',
        command: '/Users/shaw/.local/share/claude-latest/current/claude',
        cwd: '/Users/shaw/.local/share/claude-latest/current',
        discoverySource: 'runtime',
      },
      {
        adapterKind: 'codex',
        name: 'Codex CLI',
        category: 'executor-hosted',
        command: '/opt/homebrew/bin/codex',
        cwd: '/opt/homebrew/bin',
        discoverySource: 'runtime',
      },
    ]);
  });

  test('reports AgentOS gateways and local agent definitions in the initial scan snapshot', async () => {
    const localAgentsDir = await mkdtemp(join(tmpdir(), 'agentbean-daemon-next-agents-'));
    tempDirs.push(localAgentsDir);
    await mkdir(join(localAgentsDir, 'helper'));
    await writeFile(join(localAgentsDir, 'helper', 'agent.json'), JSON.stringify({
      name: 'Local Helper',
      category: 'executor-hosted',
      adapterKind: 'codex',
      command: '/opt/homebrew/bin/codex',
      args: ['exec'],
      cwd: '/Users/shaw/project',
    }));

    const snapshot = await scanBuiltinRuntimeAgents({
      localAgentsDir,
      findExecutable: async (bin) => {
        if (bin === 'hermes') {
          return '/opt/homebrew/bin/hermes';
        }
        if (bin === 'openclaw') {
          return '/opt/homebrew/bin/openclaw';
        }
        return null;
      },
      runCommand: async (command, args) => {
        if (command === '/opt/homebrew/bin/hermes' && args.join(' ') === 'gateway status') {
          return 'gateway running';
        }
        if (command === '/opt/homebrew/bin/openclaw' && args.join(' ') === 'gateway status') {
          return 'gateway stopped';
        }
        if (command === '/opt/homebrew/bin/openclaw' && args.join(' ') === 'agents list --json') {
          return JSON.stringify({ agents: [{ id: 'main' }] });
        }
        return '';
      },
    });

    expect(snapshot.agents).toEqual([
      {
        adapterKind: 'hermes',
        name: 'Hermes-Agent',
        category: 'agentos-hosted',
        command: '/opt/homebrew/bin/hermes',
        args: [],
        cwd: '/opt/homebrew/bin',
        discoverySource: 'gateway',
        gatewayInstanceKey: 'hermes:/opt/homebrew/bin/hermes',
      },
      {
        adapterKind: 'openclaw',
        name: 'OpenClaw-Agent',
        category: 'agentos-hosted',
        command: '/opt/homebrew/bin/openclaw',
        args: ['agent', '--agent', 'main'],
        cwd: '/opt/homebrew/bin',
        discoverySource: 'gateway',
        gatewayInstanceKey: 'openclaw:/opt/homebrew/bin/openclaw:main',
      },
      {
        adapterKind: 'codex',
        name: 'Local-Helper',
        category: 'executor-hosted',
        command: '/opt/homebrew/bin/codex',
        args: ['exec'],
        cwd: '/Users/shaw/project',
        discoverySource: 'filesystem',
      },
    ]);
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
      agents: [
        {
          adapterKind: 'gemini',
          name: 'Gemini CLI',
          category: 'executor-hosted',
          command: '/usr/local/bin/gemini',
          cwd: '/usr/local/bin',
          discoverySource: 'runtime',
        },
      ],
    });
  });
});
