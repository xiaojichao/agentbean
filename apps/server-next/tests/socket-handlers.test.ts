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
      whoami: vi.fn(async (payload) => makeSuccess({ payload })),
      listTeams: vi.fn(async (payload) => makeSuccess({ payload })),
      getDevice: vi.fn(async (payload) => makeSuccess({ payload })),
      requestDeviceScan: vi.fn(async (payload) =>
        makeSuccess({ request: { requestId: 'scan-1', deviceId: (payload as { deviceId: string }).deviceId } }),
      ),
      createChannel: vi.fn(async (payload) => makeSuccess({ payload })),
      updateChannel: vi.fn(async (payload) => makeSuccess({ payload })),
      addChannelHumanMember: vi.fn(async (payload) => makeSuccess({ payload })),
      removeChannelHumanMember: vi.fn(async (payload) => makeSuccess({ payload })),
      addChannelAgentMember: vi.fn(async (payload) => makeSuccess({ payload })),
      removeChannelAgentMember: vi.fn(async (payload) => makeSuccess({ payload })),
      listChannelMembers: vi.fn(async (payload) => makeSuccess({ payload })),
      listChannels: vi.fn(async () => makeSuccess({
        channels: [{ id: 'channel-2', teamId: 'team-1', visibility: 'public' }],
      })),
      listChannelMessages: vi.fn(async () => makeSuccess({
        messages: [{ id: 'message-1', channelId: 'channel-2', body: 'hello' }],
      })),
      createCustomAgent: vi.fn(async (payload) => makeSuccess({ payload })),
      sendMessage: vi.fn(async (payload) => makeSuccess({ payload })),
    } as unknown as ServerNextUseCases;

    registerWebSocketHandlers(socket, app);

    expect(socket.eventNames()).toEqual([
      WEB_EVENTS.auth.register,
      WEB_EVENTS.auth.login,
      WEB_EVENTS.auth.whoami,
      WEB_EVENTS.team.list,
      WEB_EVENTS.device.get,
      WEB_EVENTS.device.scan,
      WEB_EVENTS.channel.create,
      WEB_EVENTS.channel.update,
      WEB_EVENTS.channel.addMember,
      WEB_EVENTS.channel.removeMember,
      WEB_EVENTS.channel.addAgent,
      WEB_EVENTS.channel.removeAgent,
      WEB_EVENTS.channel.members,
      WEB_EVENTS.channel.join,
      WEB_EVENTS.agent.create,
      WEB_EVENTS.message.send,
    ]);
    expect(socket.eventNames()).not.toContain('network:list');

    await expect(socket.trigger(WEB_EVENTS.auth.register, { username: 'shaw' })).resolves.toEqual({
      ok: true,
      payload: { username: 'shaw' },
    });
    await socket.trigger(WEB_EVENTS.auth.whoami, { token: 'token-1' });
    await socket.trigger(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    await socket.trigger(WEB_EVENTS.device.get, {
      userId: 'user-1',
      deviceId: 'device-1',
    });
    await socket.trigger(WEB_EVENTS.device.scan, {
      userId: 'user-1',
      deviceId: 'device-1',
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
    await socket.trigger(WEB_EVENTS.channel.addMember, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      memberUserId: 'user-2',
    });
    await socket.trigger(WEB_EVENTS.channel.removeMember, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      memberUserId: 'user-2',
    });
    await socket.trigger(WEB_EVENTS.channel.addAgent, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      agentId: 'agent-1',
    });
    await socket.trigger(WEB_EVENTS.channel.removeAgent, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      agentId: 'agent-1',
    });
    await socket.trigger(WEB_EVENTS.channel.members, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
    });
    await expect(socket.trigger(WEB_EVENTS.channel.join, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      limit: 25,
    })).resolves.toEqual({
      ok: true,
      channel: { id: 'channel-2', teamId: 'team-1', visibility: 'public' },
      messages: [{ id: 'message-1', channelId: 'channel-2', body: 'hello' }],
    });
    await socket.trigger(WEB_EVENTS.agent.create, {
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
    });

    expect(app.registerUser).toHaveBeenCalledWith({ username: 'shaw' });
    expect(app.whoami).toHaveBeenCalledWith({ token: 'token-1' });
    expect(app.sendMessage).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    expect(app.getDevice).toHaveBeenCalledWith({
      userId: 'user-1',
      deviceId: 'device-1',
    });
    expect(app.requestDeviceScan).toHaveBeenCalledWith({
      userId: 'user-1',
      deviceId: 'device-1',
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
    expect(app.addChannelHumanMember).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      memberUserId: 'user-2',
    });
    expect(app.removeChannelHumanMember).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      memberUserId: 'user-2',
    });
    expect(app.addChannelAgentMember).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      agentId: 'agent-1',
    });
    expect(app.removeChannelAgentMember).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
      agentId: 'agent-1',
    });
    expect(app.listChannelMembers).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
    });
    expect(app.listChannels).toHaveBeenCalledWith({ userId: 'user-1', teamId: 'team-1' });
    expect(app.listChannelMessages).toHaveBeenCalledWith({ channelId: 'channel-2', limit: 25 });
    expect(app.createCustomAgent).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId: 'device-1',
      runtimeId: 'runtime-1',
      name: 'Custom Codex',
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
