import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS, WEB_EVENTS, makeSuccess } from '../../../packages/contracts/src/index';
import {
  registerAgentSocketHandlers,
  registerWebSocketHandlers,
  type SocketLike,
} from '../src/transport/socket-handlers';
import type { ServerNextUseCases } from '../src/application/usecases';

describe('server-next socket handlers', () => {
  test('registers first-slice web events and forwards payloads to use cases', async () => {
    const socket = new FakeSocket();
    const app = {
      registerUser: vi.fn(async (payload) => makeSuccess({ payload })),
      loginUser: vi.fn(async (payload) => makeSuccess({ payload })),
      listTeams: vi.fn(async (payload) => makeSuccess({ payload })),
      createChannel: vi.fn(async (payload) => makeSuccess({ payload })),
      updateChannel: vi.fn(async (payload) => makeSuccess({ payload })),
      sendMessage: vi.fn(async (payload) => makeSuccess({ payload })),
    } as unknown as ServerNextUseCases;

    registerWebSocketHandlers(socket, app);

    expect(socket.eventNames()).toEqual([
      WEB_EVENTS.auth.register,
      WEB_EVENTS.auth.login,
      WEB_EVENTS.team.list,
      WEB_EVENTS.channel.create,
      WEB_EVENTS.channel.update,
      WEB_EVENTS.message.send,
    ]);
    expect(socket.eventNames()).not.toContain('network:list');

    await expect(socket.trigger(WEB_EVENTS.auth.register, { username: 'shaw' })).resolves.toEqual({
      ok: true,
      payload: { username: 'shaw' },
    });
    await socket.trigger(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    await socket.trigger(WEB_EVENTS.channel.create, {
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
    });
    await socket.trigger(WEB_EVENTS.channel.update, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      title: 'Team-wide updates',
    });

    expect(app.registerUser).toHaveBeenCalledWith({ username: 'shaw' });
    expect(app.sendMessage).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    expect(app.createChannel).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      name: 'ops',
      visibility: 'private',
    });
    expect(app.updateChannel).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      title: 'Team-wide updates',
    });
  });

  test('registers first-slice agent events and forwards payloads to use cases', async () => {
    const socket = new FakeSocket();
    const app = {
      deviceHello: vi.fn(async (payload) => makeSuccess({ payload })),
      reportDeviceRuntimes: vi.fn(async (payload) => makeSuccess({ payload })),
      registerDiscoveredAgents: vi.fn(async (payload) => makeSuccess({ payload })),
      receiveDispatchResult: vi.fn(async (payload) => makeSuccess({ payload })),
      receiveDispatchError: vi.fn(async (payload) => makeSuccess({ payload })),
    } as unknown as ServerNextUseCases;

    registerAgentSocketHandlers(socket, app);

    expect(socket.eventNames()).toEqual([
      AGENT_EVENTS.device.hello,
      AGENT_EVENTS.device.runtimes,
      AGENT_EVENTS.agent.registerBatch,
      AGENT_EVENTS.dispatch.result,
      AGENT_EVENTS.dispatch.error,
    ]);

    await socket.trigger(AGENT_EVENTS.device.hello, {
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
    });
    await socket.trigger(AGENT_EVENTS.dispatch.result, {
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'done',
    });
    await expect(socket.trigger(AGENT_EVENTS.dispatch.error, { dispatchId: 'dispatch-1' })).resolves.toEqual({
      ok: true,
      payload: { dispatchId: 'dispatch-1' },
    });

    expect(app.deviceHello).toHaveBeenCalledWith({
      teamId: 'team-1',
      ownerId: 'user-1',
      machineId: 'machine-1',
    });
    expect(app.receiveDispatchResult).toHaveBeenCalledWith({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'done',
    });
    expect(app.receiveDispatchError).toHaveBeenCalledWith({ dispatchId: 'dispatch-1' });
  });
});

class FakeSocket implements SocketLike {
  private readonly handlers = new Map<string, (payload: unknown, ack?: (result: unknown) => void) => Promise<void>>();

  on(event: string, handler: (payload: unknown, ack?: (result: unknown) => void) => Promise<void>): void {
    this.handlers.set(event, handler);
  }

  eventNames(): string[] {
    return Array.from(this.handlers.keys());
  }

  async trigger(event: string, payload: unknown): Promise<unknown> {
    const handler = this.handlers.get(event);
    if (!handler) {
      throw new Error(`No handler for ${event}`);
    }
    let ackResult: unknown;
    await handler(payload, (result) => {
      ackResult = result;
    });
    return ackResult;
  }
}
