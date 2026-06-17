import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index';
import {
  createDaemonProtocolClient,
  type DaemonDispatchResult,
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

  test('forwards structured executor workspace run metadata with dispatch results', async () => {
    const socket = new FakeAgentSocket();
    const executor: StubExecutor = async (request): Promise<DaemonDispatchResult> => ({
      body: `stub:${request.prompt}`,
      artifacts: [
        {
          id: 'workspace-log-dispatch-1',
          filename: 'workspace-run.log',
          mimeType: 'text/plain',
          relativePath: 'logs/workspace-run.log',
          pathKind: 'workspace',
          contentBase64: Buffer.from('stdout:\nhello').toString('base64'),
        },
      ],
      workspaceRun: {
        status: 'succeeded',
        cwd: '/workspace',
        command: 'codex --model gpt-5.4',
        logExcerpt: 'OPENAI_API_KEY=[redacted]\nfinished',
        exitCode: 0,
        startedAt: 1000,
        completedAt: 1010,
      },
    });
    const client = createDaemonProtocolClient({
      socket,
      executor,
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
      AGENT_EVENTS.dispatch.result,
      {
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        body: 'stub:hello',
        artifacts: [
          {
            id: 'workspace-log-dispatch-1',
            filename: 'workspace-run.log',
            mimeType: 'text/plain',
            relativePath: 'logs/workspace-run.log',
            pathKind: 'workspace',
            contentBase64: Buffer.from('stdout:\nhello').toString('base64'),
          },
        ],
        workspaceRun: {
          status: 'succeeded',
          cwd: '/workspace',
          command: 'codex --model gpt-5.4',
          logExcerpt: 'OPENAI_API_KEY=[redacted]\nfinished',
          exitCode: 0,
          startedAt: 1000,
          completedAt: 1010,
        },
      },
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

  test('handles targeted scan requests by reporting fresh runtimes and agents', async () => {
    const socket = new FakeAgentSocket();
    let scanCount = 0;
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
      scan: async () => {
        scanCount += 1;
        return {
          runtimes: [{ adapterKind: 'claude-code', name: 'Claude Code' }],
          agents: [{ name: 'Claude', adapterKind: 'claude-code', category: 'executor-hosted' }],
        };
      },
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.device.scanRequested, {
      requestId: 'scan-1',
      deviceId: 'device-1',
    });

    expect(scanCount).toBe(1);
    expect(socket.emitted.slice(-2)).toEqual([
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'claude-code', name: 'Claude Code' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Claude', adapterKind: 'claude-code', category: 'executor-hosted' }] }],
    ]);
  });

  test('ignores scan requests for a different device id', async () => {
    const socket = new FakeAgentSocket();
    let scanCount = 0;
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => `stub:${request.prompt}`,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      scan: async () => {
        scanCount += 1;
        return {
          runtimes: [],
          agents: [],
        };
      },
    });

    await client.start();
    await socket.trigger(AGENT_EVENTS.device.scanRequested, {
      requestId: 'scan-1',
      deviceId: 'other-device',
    });

    expect(scanCount).toBe(0);
    expect(socket.emitted).toEqual([
      [AGENT_EVENTS.device.hello, { teamId: 'team-1', ownerId: 'user-1' }],
      [AGENT_EVENTS.device.runtimes, { teamId: 'team-1', deviceId: 'device-1', runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }] }],
      [AGENT_EVENTS.agent.registerBatch, { teamId: 'team-1', deviceId: 'device-1', agents: [{ name: 'Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }] }],
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

  test('resolves custom agent env references before executing a dispatch', async () => {
    const socket = new FakeAgentSocket();
    const received: DispatchRequestPayload[] = [];
    const resolvedRefs: unknown[] = [];
    const client = createDaemonProtocolClient({
      socket,
      executor: async (request) => {
        received.push(request);
        return 'ok';
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
      envResolver: async (envRef) => {
        resolvedRefs.push(envRef);
        return { SECRET_TOKEN: 'secret-value' };
      },
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
      customAgent: {
        command: 'codex',
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });

    expect(resolvedRefs).toEqual([{ agentId: 'agent-1', teamId: 'team-1' }]);
    expect(received[0]?.customAgent).toMatchObject({
      command: 'codex',
      env: { SECRET_TOKEN: 'secret-value' },
      envRef: { agentId: 'agent-1', teamId: 'team-1' },
    });
    expect(socket.emitted.at(-1)).toEqual([
      AGENT_EVENTS.dispatch.result,
      { dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'ok' },
    ]);
  });

  test('reports a dispatch error when an env reference cannot be resolved locally', async () => {
    const socket = new FakeAgentSocket();
    const executor = vi.fn(async () => 'ok');
    const client = createDaemonProtocolClient({
      socket,
      executor,
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [{ adapterKind: 'codex-cli', name: 'Codex CLI' }],
      agents: [{ name: 'Custom Codex', adapterKind: 'codex-cli', category: 'executor-hosted' }],
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
      customAgent: {
        command: 'codex',
        envRef: { agentId: 'agent-1', teamId: 'team-1' },
      },
    });

    expect(executor).not.toHaveBeenCalled();
    expect(socket.emitted.at(-1)).toEqual([
      AGENT_EVENTS.dispatch.error,
      {
        dispatchId: 'dispatch-1',
        agentId: 'agent-1',
        error: 'Custom agent env resolver is not configured',
      },
    ]);
  });

  test('ignores dispatch results after a cancel request', async () => {
    const socket = new FakeAgentSocket();
    let resolveExecutor: ((body: string) => void) | undefined;
    let executorStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      executorStarted = resolve;
    });
    const client = createDaemonProtocolClient({
      socket,
      executor: async () => {
        executorStarted?.();
        return new Promise<string>((resolve) => {
          resolveExecutor = resolve;
        });
      },
      device: { teamId: 'team-1', ownerId: 'user-1' },
      runtimes: [],
      agents: [],
    });

    await client.start();
    const running = socket.trigger(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      agentId: 'agent-1',
      requestId: 'request-1',
      prompt: 'hello',
    });
    await started;
    await socket.trigger(AGENT_EVENTS.dispatch.cancel, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
    });
    resolveExecutor?.('late result');
    await running;

    expect(socket.emitted.some(([event]) => event === AGENT_EVENTS.dispatch.result)).toBe(false);
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

  async trigger(event: string, payload: unknown): Promise<void> {
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
