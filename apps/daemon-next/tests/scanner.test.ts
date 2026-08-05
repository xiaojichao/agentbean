import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import { createBuiltinScanProvider, scanBuiltinRuntimeAgents } from '../src/index';
import { pathEntries } from '../src/scanner';

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
        projectDocumentInputSetVersions: [1],
      },
      {
        adapterKind: 'codex',
        name: 'Codex CLI',
        category: 'executor-hosted',
        command: '/opt/homebrew/bin/codex',
        cwd: '/opt/homebrew/bin',
        discoverySource: 'runtime',
        projectDocumentInputSetVersions: [1],
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
        projectDocumentInputSetVersions: [1],
        descriptor: null,
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
        projectDocumentInputSetVersions: [1],
        descriptor: null,
      },
      {
        adapterKind: 'codex',
        name: 'Local-Helper',
        category: 'executor-hosted',
        command: '/opt/homebrew/bin/codex',
        args: ['exec'],
        cwd: '/Users/shaw/project',
        discoverySource: 'filesystem',
        descriptor: null,
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

  test('pathEntries includes nvm/volta/fnm version bin dirs so a launchd-detached daemon can resolve runtimes', async () => {
    // 回归：daemon 作为 launchd 后台服务时 process.env.PATH=/usr/bin:/bin:/usr/sbin:/sbin，
    // scanner 必须显式纳入版本管理器的 bin 目录，否则装在 nvm/volta/fnm 下的运行时会查无此人。
    const home = await mkdtemp(join(tmpdir(), 'agentbean-scanner-dirs-'));
    tempDirs.push(home);
    await mkdir(join(home, '.nvm/versions/node/v24.15.0/bin'), { recursive: true });
    await mkdir(join(home, '.nvm/versions/node/v22.0.0/bin'), { recursive: true });
    await mkdir(join(home, '.volta/bin'), { recursive: true });
    await mkdir(join(home, '.fnm/node-versions/v20.10.0/installation/bin'), { recursive: true });

    const dirs = pathEntries({ envPath: '/usr/bin:/bin:/usr/sbin:/sbin', homeDir: home });

    // nvm：版本号可变，每个版本目录的 bin 都要入列（写死任一版本都会漏）。
    expect(dirs).toContain(join(home, '.nvm/versions/node/v24.15.0/bin'));
    expect(dirs).toContain(join(home, '.nvm/versions/node/v22.0.0/bin'));
    // volta：静态 shim 目录。
    expect(dirs).toContain(join(home, '.volta/bin'));
    // fnm：版本化安装目录。
    expect(dirs).toContain(join(home, '.fnm/node-versions/v20.10.0/installation/bin'));
  });
});
