import { describe, expect, test } from 'vitest';
import { AGENT_EVENTS, type DispatchRequestDto } from '../../../packages/contracts/src/index';
import {
  createDaemonProtocolClient,
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
});

class FakeAgentSocket implements DaemonProtocolSocket {
  readonly emitted: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, (payload: unknown) => Promise<void>>();

  async emitWithAck(event: string, payload: unknown): Promise<unknown> {
    this.emitted.push([event, payload]);
    if (event === AGENT_EVENTS.device.hello) {
      return { ok: true, device: { id: 'device-1' } };
    }
    return { ok: true };
  }

  on(event: string, handler: (payload: unknown) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  async trigger(event: string, payload: DispatchRequestDto & { id: string }): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    await handler(payload);
  }
}
