import { describe, expect, test } from 'vitest';
import { AGENT_EVENTS, type DispatchRequestDto } from '../../../packages/contracts/src/index';
import {
  createDaemonProtocolClient,
  type DispatchRequestPayload,
  type DaemonProtocolSocket,
  type StubExecutor,
} from '../src/index';

describe('daemon-next protocol client', () => {
  test('announces device, runtimes, agents, and returns stub dispatch results', async () => {
    const socket = new FakeAgentSocket();
    const executor: StubExecutor = async (request) => `stub:${request.prompt}`;
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();

    expect(socket.emitted).toEqual([
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
    ]);

    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });

    expect(socket.emitted.at(-1)).toEqual([
      AGENT_EVENTS.dispatch.result,
      { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'stub:hello' },
    ]);
  });

  test('re-announces device, runtimes, and agents after reconnect', async () => {
    const socket = new FakeAgentSocket();
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => `stub:${request.prompt}`,
      device: {
        teamId: 'team-1',
        ownerId: 'user-1',
        machineId: 'machine-1',
        profileId: 'default',
      },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();
    await socket.triggerReconnect();

    expect(socket.emitted).toEqual([
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', profileId: 'default' }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-2', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-2', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
    ]);
  });

  test('reports dispatch errors without swallowing executor failures', async () => {
    const socket = new FakeAgentSocket();
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => {
        throw new Error('executor failed');
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });

    expect(socket.emitted.at(-1)).toEqual([
      AGENT_EVENTS.dispatch.error,
      { dispatchId: 'dispatch-1', agentId: 'agent-1', error: 'executor failed' },
    ]);
  });

  test('passes raw custom agent env only inside selected dispatch request', async () => {
    const socket = new FakeAgentSocket();
    const received: DispatchRequestPayload[] = [];
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => {
        received.push(request);
        return 'ok';
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
    });

    await client.start();

    const announcePayloads = socket.emitted.map(([, payload]) => JSON.stringify(payload));
    expect(announcePayloads.join('\n')).not.toContain('SECRET_TOKEN');

    await socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
      customAgent: {
        command: 'codex',
        args: ['--model', 'gpt-5.4'],
        cwd: '/workspace',
        env: { SECRET_TOKEN: 'secret-value' },
      },
    });

    expect(received[0]?.customAgent?.env).toEqual({ SECRET_TOKEN: 'secret-value' });
    expect(socket.emitted.at(-1)).toEqual([
      AGENT_EVENTS.dispatch.result,
      { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'ok' },
    ]);
  });
});

class FakeAgentSocket implements DaemonProtocolSocket {
  readonly emitted: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, (payload: unknown) => Promise<void>>();
  private reconnectHandler: (() => Promise<void>) | undefined;
  private deviceCounter = 0;

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    if (event === AGENT_EVENTS.device.hello) {
      this.deviceCounter += 1;
      return { ok: true, device: { id: `device-${this.deviceCounter}` } };
    }
    return { ok: true };
  }

  on(event: string, handler: (payload: unknown) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  onReconnect(handler: () => Promise<void>): void {
    this.reconnectHandler = handler;
  }

  async trigger(event: string, payload: DispatchRequestDto & { id: string }): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    await handler(payload);
  }

  async triggerReconnect(): Promise<void> {
    if (!this.reconnectHandler) {
      throw new Error('No reconnect handler');
    }
    await this.reconnectHandler();
  }
}
