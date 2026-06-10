import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import { createSocketIoDaemonSocket, parseDaemonNextCliConfig, waitForDeviceInviteCredentials } from '../src/cli';

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
