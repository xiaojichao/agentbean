import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import { createSocketIoDaemonSocket, formatScanSnapshot, parseDaemonNextCliConfig, resolveDaemonServerUrl, runDaemonNextCli, waitForDeviceInviteCredentials, type DaemonNextCliConfig, type DaemonNextCliDeps } from '../src/cli';
import type { AuthData } from '../src/auth-store';
import type { CreateDaemonProtocolClientInput, DaemonScanSnapshot } from '../src/index';

function writeYamlFixture(content: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-cfg-')));
  const path = join(dir, 'c.yaml');
  writeFileSync(path, content);
  return path;
}

const EMPTY_SCAN: DaemonScanSnapshot = { runtimes: [], agents: [] };

function baseRunConfig(overrides: Partial<DaemonNextCliConfig> = {}): DaemonNextCliConfig {
  return {
    serverUrl: 'http://127.0.0.1:4000',
    profileId: 'default',
    hostname: 'host.local',
    fallbackPrefix: 'daemon-next:',
    ...overrides,
  };
}

function createRunDaemonHarness(overrides: Partial<DaemonNextCliDeps> = {}) {
  const runtimeSocket = new FakeRuntimeSocket();
  const start = vi.fn(async () => undefined);
  const protocolInputs: CreateDaemonProtocolClientInput[] = [];
  const scanProvider = vi.fn(async () => EMPTY_SCAN);
  const executor = vi.fn(async () => 'ok');
  const deps: DaemonNextCliDeps = {
    connectSocket: vi.fn(async () => runtimeSocket),
    loadAuth: vi.fn(() => null),
    saveAuth: vi.fn(),
    loadScanCache: vi.fn(() => EMPTY_SCAN),
    saveScanCache: vi.fn(),
    createScanProvider: vi.fn(() => scanProvider),
    createProtocolClient: vi.fn((input) => {
      protocolInputs.push(input);
      return { start };
    }),
    createExecutor: vi.fn(() => executor),
    collectSystemInfo: vi.fn(() => ({ hostname: 'host.local' })),
    readDaemonVersion: vi.fn(() => '0.2.2-test'),
    createEnvResolver: vi.fn(() => vi.fn(async () => ({}))),
    ...overrides,
  };
  return { deps, protocolInputs, runtimeSocket, start };
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error('Timed out waiting for test condition');
}

describe('daemon-next CLI wiring', () => {
  test('parses required device config from args and env', () => {
    const config = parseDaemonNextCliConfig({
      hostname: 'host.local',
      env: {
        AGENTBEAN_NEXT_OWNER_ID: 'user-from-env',
        AGENTBEAN_NEXT_SERVER_URL: 'http://127.0.0.1:4100/',
      },
      argv: [
        '--team-id',
        'team-1',
        '--machine-id',
        'machine-1',
        '--profile-id',
        'agentbean-next',
      ],
    });

    expect(config).toEqual({
      serverUrl: 'http://127.0.0.1:4100',
      teamId: 'team-1',
      ownerId: 'user-from-env',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'host.local',
      fallbackPrefix: 'daemon-next:',
      serverUrlExplicit: true,
    });
  });

  test('parseDaemonNextCliConfig reads server-url', () => {
    const config = parseDaemonNextCliConfig({
      argv: ['--team-id', 't1', '--owner-id', 'o1', '--server-url', 'https://api.example.com'],
    });
    expect(config.serverUrl).toBe('https://api.example.com');
  });

  test('allows invite-code onboarding without manual team or owner config', () => {
    const config = parseDaemonNextCliConfig({
      hostname: 'host.local',
      env: {
        AGENTBEAN_NEXT_SERVER_URL: 'http://127.0.0.1:4100/',
        AGENTBEAN_NEXT_INVITE_CODE: 'device-code-1',
      },
      argv: [
        '--machine-id',
        'machine-1',
        '--profile-id',
        'agentbean-next',
      ],
    });

    expect(config).toEqual({
      serverUrl: 'http://127.0.0.1:4100',
      inviteCode: 'device-code-1',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'host.local',
      fallbackPrefix: 'daemon-next:',
      serverUrlExplicit: true,
    });
  });

  describe('parseDaemonNextCliConfig yaml merge (CLI > env > yaml > default)', () => {
    test('CLI overrides yaml for server-url', () => {
      const configPath = writeYamlFixture('serverUrl: http://yaml\n');
      const config = parseDaemonNextCliConfig({
        configPath,
        argv: ['--team-id', 't1', '--owner-id', 'o1', '--server-url', 'http://cli'],
      });
      expect(config.serverUrl).toBe('http://cli');
    });

    test('env overrides yaml for server-url', () => {
      const configPath = writeYamlFixture('serverUrl: http://yaml\n');
      const config = parseDaemonNextCliConfig({
        configPath,
        env: { AGENTBEAN_NEXT_SERVER_URL: 'http://env' },
        argv: ['--team-id', 't1', '--owner-id', 'o1'],
      });
      expect(config.serverUrl).toBe('http://env');
    });

    test('yaml overrides built-in default for server-url', () => {
      const configPath = writeYamlFixture('serverUrl: http://yaml\n');
      const config = parseDaemonNextCliConfig({
        configPath,
        argv: ['--team-id', 't1', '--owner-id', 'o1'],
      });
      expect(config.serverUrl).toBe('http://yaml');
    });

    test('yaml provides teamId and ownerId when no CLI/env invite/team/owner given', () => {
      const configPath = writeYamlFixture('teamId: t1\nownerId: o1\nserverUrl: http://yaml\n');
      const config = parseDaemonNextCliConfig({ configPath });
      expect(config.teamId).toBe('t1');
      expect(config.ownerId).toBe('o1');
      expect(config.serverUrl).toBe('http://yaml');
    });

    test('falls back to built-in default when no CLI/env/yaml', () => {
      const configPath = writeYamlFixture('teamId: t1\nownerId: o1\n');
      const config = parseDaemonNextCliConfig({ configPath });
      expect(config.serverUrl).toBe('http://127.0.0.1:4000');
    });

    test('corrupt/missing yaml is ignored gracefully (falls through to env/default)', () => {
      const configPath = join(tmpdir(), 'does-not-exist.yaml');
      const config = parseDaemonNextCliConfig({
        configPath,
        env: { AGENTBEAN_NEXT_TEAM_ID: 't1', AGENTBEAN_NEXT_OWNER_ID: 'o1' },
      });
      expect(config.serverUrl).toBe('http://127.0.0.1:4000');
      expect(config.teamId).toBe('t1');
      expect(config.ownerId).toBe('o1');
    });

    test('corrupt yaml file is ignored gracefully', () => {
      const configPath = writeYamlFixture('serverUrl: ${SRV}\n  bad-indent: oops\n- [unclosed\n');
      const config = parseDaemonNextCliConfig({
        configPath,
        env: { AGENTBEAN_NEXT_TEAM_ID: 't1', AGENTBEAN_NEXT_OWNER_ID: 'o1' },
      });
      expect(config.serverUrl).toBe('http://127.0.0.1:4000');
    });

    test('records the resolved configPath on the returned config', () => {
      const configPath = writeYamlFixture('teamId: t1\nownerId: o1\n');
      const config = parseDaemonNextCliConfig({ configPath });
      expect(config.configPath).toBe(configPath);
    });

    test('resolves configPath from argv --config-path', () => {
      const configPath = writeYamlFixture('serverUrl: http://from-yaml\n');
      const config = parseDaemonNextCliConfig({
        argv: ['--config-path', configPath, '--team-id', 't1', '--owner-id', 'o1'],
        env: {},
      });
      expect(config.serverUrl).toBe('http://from-yaml');
    });

    test('resolves configPath from env AGENTBEAN_NEXT_CONFIG_PATH', () => {
      const configPath = writeYamlFixture('serverUrl: http://from-yaml\n');
      const config = parseDaemonNextCliConfig({
        argv: [],
        env: {
          AGENTBEAN_NEXT_CONFIG_PATH: configPath,
          AGENTBEAN_NEXT_TEAM_ID: 't1',
          AGENTBEAN_NEXT_OWNER_ID: 'o1',
        },
      });
      expect(config.serverUrl).toBe('http://from-yaml');
    });

    test('argv --config-path overrides env AGENTBEAN_NEXT_CONFIG_PATH', () => {
      const configPathA = writeYamlFixture('serverUrl: http://a\n');
      const configPathB = writeYamlFixture('serverUrl: http://b\n');
      const config = parseDaemonNextCliConfig({
        argv: ['--config-path', configPathA, '--team-id', 't1', '--owner-id', 'o1'],
        env: {
          AGENTBEAN_NEXT_CONFIG_PATH: configPathB,
        },
      });
      expect(config.serverUrl).toBe('http://a');
    });

    test('drops non-string yaml values via the typeof guard (falls back to default)', () => {
      const configPath = writeYamlFixture('serverUrl: 12345\nteamId: t1\nownerId: o1\n');
      const config = parseDaemonNextCliConfig({ configPath });
      expect(config.serverUrl).toBe('http://127.0.0.1:4000');
    });
  });

  test('waits for device invite credentials over the daemon socket', async () => {
    const runtimeSocket = new FakeRuntimeSocket();
    const socket = createSocketIoDaemonSocket(runtimeSocket);
    const onStatus = vi.fn();
    const waiting = waitForDeviceInviteCredentials(socket, {
      code: 'device-code-1',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'host.local',
    }, { onStatus });

    expect(onStatus).toHaveBeenCalledWith('Connected. Waiting for device invite approval...');
    expect(runtimeSocket.emitted).toEqual([
      [
        AGENT_EVENTS.deviceInvite.wait,
        {
          code: 'device-code-1',
          machineId: 'machine-1',
          profileId: 'agentbean-next',
          hostname: 'host.local',
        },
      ],
    ]);
    await runtimeSocket.trigger(AGENT_EVENTS.deviceInvite.credentials, {
      token: 'device-token-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'host.local',
    });

    await expect(waiting).resolves.toEqual({
      token: 'device-token-1',
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'host.local',
    });
  });

  test('formats device scan output with runtimes and discovered agents', () => {
    expect(formatScanSnapshot({
      runtimes: [
        {
          adapterKind: 'claude-code',
          name: 'Claude Code',
          command: '/Users/shaw/.local/share/claude-latest/current/claude',
          cwd: '/Users/shaw/.local/share/claude-latest/current',
          installed: true,
        },
        {
          adapterKind: 'gemini',
          name: 'Gemini CLI',
          installed: false,
        },
        {
          adapterKind: 'codex',
          name: 'Codex CLI',
          command: '/opt/homebrew/bin/codex',
        },
      ],
      agents: [
        {
          adapterKind: 'claude-code',
          name: 'Claude Code',
          category: 'executor-hosted',
          command: '/Users/shaw/.local/share/claude-latest/current/claude',
          cwd: '/Users/shaw/.local/share/claude-latest/current',
          discoverySource: 'runtime',
        },
        {
          adapterKind: 'openclaw',
          name: 'OpenClaw-Agent',
          category: 'agentos-hosted',
          command: '/opt/homebrew/bin/openclaw',
          args: ['agent', '--agent', 'main'],
          cwd: '/opt/homebrew/bin',
          discoverySource: 'gateway',
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
      ],
    })).toEqual([
      'Initial scan: 2/3 coding runtimes available, 3 agents discovered.',
      'Coding runtimes:',
      '  - Claude Code [installed] claude-code -> /Users/shaw/.local/share/claude-latest/current/claude',
      '  - Gemini CLI [missing] gemini',
      '  - Codex CLI [installed] codex -> /opt/homebrew/bin/codex',
      'Agents discovered:',
      '  - Claude Code [coding runtime] claude-code -> /Users/shaw/.local/share/claude-latest/current/claude cwd=/Users/shaw/.local/share/claude-latest/current',
      '  - OpenClaw-Agent [AgentOS gateway] openclaw -> /opt/homebrew/bin/openclaw agent --agent main cwd=/opt/homebrew/bin',
      '  - Local-Helper [local definition] codex -> /opt/homebrew/bin/codex exec cwd=/Users/shaw/project',
    ]);
  });

  test('rejects device invite onboarding when the wait ack fails', async () => {
    const runtimeSocket = new FakeRuntimeSocket();
    runtimeSocket.nextAck = { ok: false, error: 'INVITE_INVALID', message: 'Device invite is invalid' };
    const socket = createSocketIoDaemonSocket(runtimeSocket);

    await expect(waitForDeviceInviteCredentials(socket, { code: 'bad-code' })).rejects.toThrow(
      'Device invite is invalid',
    );
  });

  test('rejects device invite onboarding when the socket disconnects before credentials arrive', async () => {
    const runtimeSocket = new FakeRuntimeSocket();
    const socket = createSocketIoDaemonSocket(runtimeSocket);
    const waiting = waitForDeviceInviteCredentials(socket, { code: 'device-code-1' });

    await runtimeSocket.trigger('disconnect');

    await expect(waiting).rejects.toThrow('Socket disconnected while waiting for invite credentials');
  });

  test('rejects device invite onboarding when credentials are not delivered before timeout', async () => {
    vi.useFakeTimers();
    try {
      const runtimeSocket = new FakeRuntimeSocket();
      const socket = createSocketIoDaemonSocket(runtimeSocket);
      const waiting = waitForDeviceInviteCredentials(socket, { code: 'device-code-1' }, { timeoutMs: 1000 });
      const assertion = expect(waiting).rejects.toThrow('Timed out waiting for invite credentials');

      await vi.advanceTimersByTimeAsync(1000);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  test('parseDaemonNextCliConfig exposes profileId for scan cache', () => {
    const config = parseDaemonNextCliConfig({
      argv: ['--team-id', 't1', '--owner-id', 'o1', '--profile-id', 'laptop'],
      env: {},
    });
    expect(config.profileId).toBe('laptop');
  });

  test('parseDaemonNextCliConfig normalizes profileId before it reaches storage or hello', () => {
    const config = parseDaemonNextCliConfig({
      argv: ['--team-id', 't1', '--owner-id', 'o1', '--profile-id', 'Team A'],
      env: {},
    });
    expect(config.profileId).toBe('team-a');
  });

  test('resolveDaemonServerUrl uses saved serverUrl unless the user provided one explicitly', () => {
    const saved: AuthData = {
      token: 'tok',
      serverUrl: 'https://saved.example/',
      teamId: 'team-1',
      ownerId: 'owner-1',
    };
    const implicitDefault = parseDaemonNextCliConfig({ argv: ['--profile-id', 'default'], env: {}, hostname: 'host.local' });
    expect(resolveDaemonServerUrl(implicitDefault, saved)).toBe('https://saved.example');

    const explicit = parseDaemonNextCliConfig({
      argv: ['--profile-id', 'default', '--server-url', 'https://explicit.example'],
      env: {},
      hostname: 'host.local',
    });
    expect(resolveDaemonServerUrl(explicit, saved)).toBe('https://explicit.example');
  });

  test('bridges Socket.IO client events to daemon protocol without treating first connect as reconnect', async () => {
    const runtimeSocket = new FakeRuntimeSocket();
    const socket = createSocketIoDaemonSocket(runtimeSocket);
    const reconnects: string[] = [];
    const scans: unknown[] = [];
    const ack = vi.fn();

    socket.onReconnect(async () => {
      reconnects.push('reconnected');
    });
    socket.on('device:scan-requested', async (payload, reply) => {
      scans.push(payload);
      reply?.({ ok: true });
    });

    await runtimeSocket.trigger('connect');
    expect(reconnects).toEqual([]);

    await runtimeSocket.trigger('connect');
    expect(reconnects).toEqual(['reconnected']);

    await runtimeSocket.trigger('device:scan-requested', { deviceId: 'device-1' }, ack);
    expect(scans).toEqual([{ deviceId: 'device-1' }]);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });
});

describe('runDaemonNextCli wiring (loadAuth / saveAuth / device.token)', () => {
  test('invite path: saveAuth called with resolved persist payload + config.profileId; loadAuth NOT called', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { deps, protocolInputs, runtimeSocket } = createRunDaemonHarness();
      const running = runDaemonNextCli(
        baseRunConfig({
          inviteCode: 'device-code-1',
          machineId: 'machine-1',
          profileId: 'agentbean-next',
          serverUrl: 'http://agentbean.example',
          serverUrlExplicit: true,
        }),
        deps,
      );

      await waitForCondition(() => runtimeSocket.emitted.length === 1);
      await runtimeSocket.trigger(AGENT_EVENTS.deviceInvite.credentials, {
        token: 'device-token-1',
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'agentbean-next',
        hostname: 'host.local',
      });
      await running;

      expect(deps.connectSocket).toHaveBeenCalledWith('http://agentbean.example');
      expect(deps.loadAuth).not.toHaveBeenCalled();
      expect(deps.saveAuth).toHaveBeenCalledWith(
        {
          token: 'device-token-1',
          serverUrl: 'http://agentbean.example',
          teamId: 'team-1',
          ownerId: 'user-1',
        },
        { profileId: 'agentbean-next' },
      );
      expect(protocolInputs).toHaveLength(1);
      expect(protocolInputs[0]?.device).toMatchObject({
        token: 'device-token-1',
        teamId: 'team-1',
        ownerId: 'user-1',
        profileId: 'agentbean-next',
        machineId: 'machine-1',
        daemonVersion: '0.2.2-test',
      });
    } finally {
      log.mockRestore();
    }
  });

  test('invite path: explicit --profile-id is the saveAuth profileId (not slugify(teamId))', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { deps, runtimeSocket } = createRunDaemonHarness();
      const running = runDaemonNextCli(
        baseRunConfig({
          inviteCode: 'device-code-2',
          profileId: 'my-laptop',
          serverUrl: 'http://agentbean.example',
          serverUrlExplicit: true,
        }),
        deps,
      );

      await waitForCondition(() => runtimeSocket.emitted.length === 1);
      await runtimeSocket.trigger(AGENT_EVENTS.deviceInvite.credentials, {
        token: 'device-token-2',
        teamId: 'Team With Spaces',
        ownerId: 'user-2',
      });
      await running;

      expect(deps.saveAuth).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'device-token-2',
          teamId: 'Team With Spaces',
          ownerId: 'user-2',
        }),
        { profileId: 'my-laptop' },
      );
      expect(deps.saveAuth).not.toHaveBeenCalledWith(expect.anything(), { profileId: 'team-with-spaces' });
    } finally {
      log.mockRestore();
    }
  });

  test('saved path: loadAuth called with { profileId: config.profileId }; device gets saved.token; saveAuth NOT called', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const saved: AuthData = {
        token: 'saved-token-1',
        serverUrl: 'http://saved.example/',
        teamId: 'saved-team',
        ownerId: 'saved-owner',
      };
      const { deps, protocolInputs } = createRunDaemonHarness({
        loadAuth: vi.fn(() => saved),
      });

      await runDaemonNextCli(baseRunConfig({ profileId: 'saved-profile' }), deps);

      expect(deps.loadAuth).toHaveBeenCalledWith({ profileId: 'saved-profile' });
      expect(deps.connectSocket).toHaveBeenCalledWith('http://saved.example');
      expect(deps.saveAuth).not.toHaveBeenCalled();
      expect(protocolInputs).toHaveLength(1);
      expect(protocolInputs[0]?.device).toMatchObject({
        token: 'saved-token-1',
        teamId: 'saved-team',
        ownerId: 'saved-owner',
        profileId: 'saved-profile',
      });
    } finally {
      log.mockRestore();
    }
  });
});

class FakeRuntimeSocket {
  connected = false;
  nextAck: unknown;
  readonly emitted: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  connect(): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    return this.nextAck ?? { ok: true, event, payload };
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  off(event: string, handler: (...args: unknown[]) => void): void {
    const handlers = this.handlers.get(event) ?? [];
    this.handlers.set(event, handlers.filter((candidate) => candidate !== handler));
  }

  async trigger(event: string, payload?: unknown, ack?: (result: unknown) => void): Promise<void> {
    if (event === 'connect') {
      this.connected = true;
    }
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, ack);
    }
  }
}
