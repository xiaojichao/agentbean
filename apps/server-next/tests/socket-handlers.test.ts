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
      createTeam: vi.fn(async (payload) => makeSuccess({ payload })),
      switchTeam: vi.fn(async (payload) => makeSuccess({ payload })),
      createJoinLink: vi.fn(async (payload) => makeSuccess({ payload })),
      validateJoinLink: vi.fn(async (payload) => makeSuccess({ payload })),
      createDeviceInvite: vi.fn(async (payload) => makeSuccess({ payload })),
      completeDeviceInvite: vi.fn(async (payload) => makeSuccess({ payload })),
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
      archiveChannel: vi.fn(async (payload) => makeSuccess({ payload })),
      deleteChannel: vi.fn(async (payload) => makeSuccess({ payload })),
      startDirectMessage: vi.fn(async (payload) => makeSuccess({ payload })),
      listDirectMessages: vi.fn(async (payload) => makeSuccess({ payload })),
      snapshotDirectMessage: vi.fn(async (payload) => makeSuccess({ payload })),
      listChannels: vi.fn(async () => makeSuccess({
        channels: [{ id: 'channel-2', teamId: 'team-1', visibility: 'public' }],
      })),
      listChannelMessages: vi.fn(async () => makeSuccess({
        messages: [{ id: 'message-1', channelId: 'channel-2', body: 'hello' }],
      })),
      listVisibleAgents: vi.fn(async () => makeSuccess({
        agents: [{ id: 'agent-1', visibleTeamIds: ['team-1'] }],
      })),
      createCustomAgent: vi.fn(async (payload) => makeSuccess({ payload })),
      publishAgent: vi.fn(async (payload) => makeSuccess({ payload })),
      unpublishAgent: vi.fn(async (payload) => makeSuccess({ payload })),
      updateAgentConfig: vi.fn(async (payload) => makeSuccess({ payload })),
      deleteAgent: vi.fn(async (payload) => makeSuccess({ payload })),
      sendMessage: vi.fn(async (payload) => makeSuccess({ payload })),
      searchMessages: vi.fn(async (payload) => makeSuccess({ payload })),
      cancelDispatch: vi.fn(async (payload) => makeSuccess({ payload })),
      listTasks: vi.fn(async (payload) => makeSuccess({ payload })),
      createTask: vi.fn(async (payload) => makeSuccess({ payload })),
      updateTask: vi.fn(async (payload) => makeSuccess({ payload })),
      deleteTask: vi.fn(async (payload) => makeSuccess({ payload })),
      reorderTask: vi.fn(async (payload) => makeSuccess({ payload })),
      reactMessage: vi.fn(async (payload) => makeSuccess({ payload })),
      saveMessage: vi.fn(async (payload) => makeSuccess({ payload })),
      listSavedMessages: vi.fn(async (payload) => makeSuccess({ payload })),
      updateMemberRole: vi.fn(async (payload) => makeSuccess({ payload })),
      removeMember: vi.fn(async (payload) => makeSuccess({ payload })),
      transferOwner: vi.fn(async (payload) => makeSuccess({ payload })),
      listMembers: vi.fn(async (payload) => makeSuccess({ payload })),
      updateMemberHuman: vi.fn(async (payload) => makeSuccess({ payload })),
      updateTeam: vi.fn(async (payload) => makeSuccess({ payload })),
      deleteTeam: vi.fn(async (payload) => makeSuccess({ payload })),
    } as unknown as ServerNextUseCases;

    registerWebSocketHandlers(socket, app);

    expect(socket.eventNames()).toEqual([
      WEB_EVENTS.auth.register,
      WEB_EVENTS.auth.login,
      WEB_EVENTS.auth.whoami,
      WEB_EVENTS.team.list,
      WEB_EVENTS.team.create,
      WEB_EVENTS.team.switch,
      WEB_EVENTS.team.update,
      WEB_EVENTS.team.delete,
      WEB_EVENTS.join.create,
      WEB_EVENTS.join.validate,
      WEB_EVENTS.deviceInvite.create,
      WEB_EVENTS.deviceInvite.complete,
      WEB_EVENTS.device.list,
      WEB_EVENTS.device.get,
      WEB_EVENTS.device.scan,
      WEB_EVENTS.channel.create,
      WEB_EVENTS.channel.update,
      WEB_EVENTS.channel.addMember,
      WEB_EVENTS.channel.removeMember,
      WEB_EVENTS.channel.addAgent,
      WEB_EVENTS.channel.removeAgent,
      WEB_EVENTS.channel.members,
      WEB_EVENTS.channel.archive,
      WEB_EVENTS.channel.delete,
      WEB_EVENTS.channel.join,
      WEB_EVENTS.agent.create,
      WEB_EVENTS.agent.publish,
      WEB_EVENTS.agent.unpublish,
      WEB_EVENTS.agent.updateConfig,
      WEB_EVENTS.agent.delete,
      WEB_EVENTS.message.send,
      WEB_EVENTS.message.search,
      WEB_EVENTS.message.react,
      WEB_EVENTS.message.save,
      WEB_EVENTS.message.listSaved,
      WEB_EVENTS.member.updateRole,
      WEB_EVENTS.member.remove,
      WEB_EVENTS.member.transferOwner,
      WEB_EVENTS.member.list,
      WEB_EVENTS.member.updateHuman,
      WEB_EVENTS.dispatch.cancel,
      WEB_EVENTS.task.list,
      WEB_EVENTS.task.create,
      WEB_EVENTS.task.update,
      WEB_EVENTS.task.delete,
      WEB_EVENTS.task.reorder,
    ]);
    expect(socket.eventNames()).not.toContain('network:list');

    await expect(socket.trigger(WEB_EVENTS.auth.register, { username: 'shaw' })).resolves.toEqual({
      ok: true,
      payload: { username: 'shaw' },
    });
    await socket.trigger(WEB_EVENTS.auth.whoami, { token: 'token-1' });
    await socket.trigger(WEB_EVENTS.team.create, {
      userId: 'user-1',
      name: 'Ops Team',
    });
    await socket.trigger(WEB_EVENTS.team.switch, {
      userId: 'user-1',
      teamId: 'team-2',
    });
    await socket.trigger(WEB_EVENTS.join.create, {
      userId: 'user-1',
      teamId: 'team-1',
    });
    await socket.trigger(WEB_EVENTS.join.validate, {
      code: 'join-1',
    });
    await socket.trigger(WEB_EVENTS.deviceInvite.create, {
      userId: 'user-1',
      teamId: 'team-1',
    });
    await socket.trigger(WEB_EVENTS.deviceInvite.complete, {
      userId: 'user-1',
      code: 'device-code-1',
    });
    await socket.trigger(WEB_EVENTS.message.send, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: 'hello',
    });
    await socket.trigger(WEB_EVENTS.message.search, {
      userId: 'user-1',
      teamId: 'team-1',
      query: 'hello',
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
    await socket.trigger(WEB_EVENTS.channel.archive, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
    });
    await socket.trigger(WEB_EVENTS.channel.delete, {
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-3',
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
    await socket.trigger(WEB_EVENTS.agent.publish, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    });
    await socket.trigger(WEB_EVENTS.agent.unpublish, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    });
    await socket.trigger(WEB_EVENTS.agent.updateConfig, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Renamed Codex',
    });
    await socket.trigger(WEB_EVENTS.agent.delete, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
    await socket.trigger(WEB_EVENTS.dispatch.cancel, {
      userId: 'user-1',
      dispatchId: 'dispatch-1',
    });
    await socket.trigger(WEB_EVENTS.task.list, {
      userId: 'user-1',
      teamId: 'team-1',
    });
    await socket.trigger(WEB_EVENTS.task.create, {
      userId: 'user-1',
      teamId: 'team-1',
      title: 'Ship task',
    });
    await socket.trigger(WEB_EVENTS.task.update, {
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-1',
      status: 'done',
    });
    await socket.trigger(WEB_EVENTS.task.delete, {
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-1',
    });
    await socket.trigger(WEB_EVENTS.task.reorder, {
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-2',
      sortOrder: 100,
    });
    await socket.trigger(WEB_EVENTS.message.react, {
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    });
    await socket.trigger(WEB_EVENTS.message.save, {
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    });
    await socket.trigger(WEB_EVENTS.message.listSaved, {
      userId: 'user-1',
      teamId: 'team-1',
    });

    expect(app.registerUser).toHaveBeenCalledWith({ username: 'shaw' });
    expect(app.whoami).toHaveBeenCalledWith({ token: 'token-1' });
    expect(app.createTeam).toHaveBeenCalledWith({
      userId: 'user-1',
      name: 'Ops Team',
    });
    expect(app.switchTeam).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-2',
    });
    expect(app.createJoinLink).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
    });
    expect(app.validateJoinLink).toHaveBeenCalledWith({
      code: 'join-1',
    });
    expect(app.createDeviceInvite).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
    });
    expect(app.completeDeviceInvite).toHaveBeenCalledWith({
      userId: 'user-1',
      code: 'device-code-1',
    });
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
    expect(app.archiveChannel).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-2',
    });
    expect(app.deleteChannel).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-3',
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
    expect(app.publishAgent).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    });
    expect(app.unpublishAgent).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    });
    expect(app.updateAgentConfig).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      name: 'Renamed Codex',
    });
    expect(app.deleteAgent).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    });
    expect(app.cancelDispatch).toHaveBeenCalledWith({
      userId: 'user-1',
      dispatchId: 'dispatch-1',
    });
    expect(app.searchMessages).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      query: 'hello',
    });
    expect(app.listTasks).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
    });
    expect(app.createTask).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      title: 'Ship task',
    });
    expect(app.updateTask).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-1',
      status: 'done',
    });
    expect(app.deleteTask).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-1',
    });
    expect(app.reorderTask).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'task-2',
      sortOrder: 100,
    });
    expect(app.reactMessage).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    });
    expect(app.saveMessage).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
      messageId: 'msg-1',
      on: true,
    });
    expect(app.listSavedMessages).toHaveBeenCalledWith({
      userId: 'user-1',
      teamId: 'team-1',
    });
  });

  test('registers first-slice agent events and forwards payloads to use cases', async () => {
    const socket = new FakeSocket();
    const app = {
      waitForDeviceInvite: vi.fn(async (payload) => makeSuccess({ payload })),
      deviceHello: vi.fn(async (payload) => makeSuccess({ payload })),
      reportDeviceRuntimes: vi.fn(async (payload) => makeSuccess({ payload })),
      registerDiscoveredAgents: vi.fn(async (payload) => makeSuccess({ payload })),
      receiveDispatchResult: vi.fn(async (payload) => makeSuccess({ payload })),
      receiveDispatchError: vi.fn(async (payload) => makeSuccess({ payload })),
    } as unknown as ServerNextUseCases;

    registerAgentSocketHandlers(socket, app);

    expect(socket.eventNames()).toEqual([
      AGENT_EVENTS.deviceInvite.wait,
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
    await socket.trigger(AGENT_EVENTS.deviceInvite.wait, {
      code: 'device-code-1',
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
    expect(app.waitForDeviceInvite).toHaveBeenCalledWith({
      code: 'device-code-1',
      machineId: 'machine-1',
    });
    expect(app.receiveDispatchResult).toHaveBeenCalledWith({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'done',
    });
    expect(app.receiveDispatchError).toHaveBeenCalledWith({ dispatchId: 'dispatch-1' });
  });

  test('enriches agent management refresh payloads without changing client acknowledgements', async () => {
    const socket = new FakeSocket();
    const afterAgentMutation = vi.fn();
    const app = {
      listVisibleAgents: vi.fn(async () => makeSuccess({
        agents: [{ id: 'agent-1', visibleTeamIds: ['team-1', 'team-2'] }],
      })),
      unpublishAgent: vi.fn(async () => makeSuccess({ agent: { id: 'agent-1', visibleTeamIds: ['team-1'] } })),
      deleteAgent: vi.fn(async () => makeSuccess({ agent: { id: 'agent-1', visibleTeamIds: [] } })),
    } as unknown as ServerNextUseCases;

    registerWebSocketHandlers(socket, app, { afterAgentMutation });

    await expect(socket.trigger(WEB_EVENTS.agent.unpublish, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
    })).resolves.toEqual({
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: ['team-1'] },
    });
    expect(afterAgentMutation).toHaveBeenNthCalledWith(1, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      targetTeamId: 'team-2',
      channelTeamIds: ['team-2'],
    }, {
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: ['team-1'] },
    });

    await expect(socket.trigger(WEB_EVENTS.agent.delete, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
    })).resolves.toEqual({
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: [] },
    });
    expect(afterAgentMutation).toHaveBeenNthCalledWith(2, {
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      affectedTeamIds: ['team-1', 'team-2'],
      channelTeamIds: ['team-1', 'team-2'],
    }, {
      ok: true,
      agent: { id: 'agent-1', visibleTeamIds: [] },
    });
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
