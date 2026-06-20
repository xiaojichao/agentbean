import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import { createSocketIoDaemonSocket, parseDaemonNextCliConfig, waitForDeviceInviteCredentials } from '../src/cli';

function writeYamlFixture(content: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-cfg-')));
  const path = join(dir, 'c.yaml');
  writeFileSync(path, content);
  return path;
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
    const waiting = waitForDeviceInviteCredentials(socket, {
      code: 'device-code-1',
      machineId: 'machine-1',
      profileId: 'agentbean-next',
      hostname: 'host.local',
    });

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

  test('bridges Socket.IO client events to daemon protocol without treating first connect as reconnect', async () => {
    const runtimeSocket = new FakeRuntimeSocket();
    const socket = createSocketIoDaemonSocket(runtimeSocket);
    const reconnects: string[] = [];
    const scans: unknown[] = [];

    socket.onReconnect(async () => {
      reconnects.push('reconnected');
    });
    socket.on('device:scan-requested', async (payload) => {
      scans.push(payload);
    });

    await runtimeSocket.trigger('connect');
    expect(reconnects).toEqual([]);

    await runtimeSocket.trigger('connect');
    expect(reconnects).toEqual(['reconnected']);

    await runtimeSocket.trigger('device:scan-requested', { deviceId: 'device-1' });
    expect(scans).toEqual([{ deviceId: 'device-1' }]);
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

  async trigger(event: string, payload?: unknown): Promise<void> {
    if (event === 'connect') {
      this.connected = true;
    }
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload);
    }
  }
}
