import { AGENT_EVENTS, WEB_EVENTS, makeFailure, type DispatchRequestDto } from '../../../../packages/contracts/src/index.js';
import type { ServerNextUseCases } from '../application/usecases.js';

export interface SocketLike {
  on(event: string, handler: SocketHandler): void;
  emit?(event: string, payload: unknown): void;
}

export type SocketAck = (result: unknown) => void;
export type SocketHandler = (payload: unknown, ack?: SocketAck) => Promise<void>;

type UseCaseName = keyof ServerNextUseCases;

export interface WebSocketHandlerOptions {
  dispatch?(request: DispatchRequestDto & { id: string }): void;
  deviceScan?(request: { requestId: string; deviceId: string }): void;
  afterChannelMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterAgentMutation?(payload: unknown, result: unknown): Promise<void> | void;
}

export interface AgentSocketHandlerOptions {
  afterDeviceMutation?(payload: unknown, result: unknown): Promise<void> | void;
  afterAgentMutation?(payload: unknown, result: unknown): Promise<void> | void;
}

export function registerWebSocketHandlers(
  socket: SocketLike,
  app: ServerNextUseCases,
  options: WebSocketHandlerOptions = {},
): void {
  bind(socket, WEB_EVENTS.auth.register, app, 'registerUser');
  bind(socket, WEB_EVENTS.auth.login, app, 'loginUser');
  bind(socket, WEB_EVENTS.auth.whoami, app, 'whoami');
  bind(socket, WEB_EVENTS.team.list, app, 'listTeams');
  bind(socket, WEB_EVENTS.device.get, app, 'getDevice');
  bind(socket, WEB_EVENTS.device.scan, app, 'requestDeviceScan', (_payload, result) => {
    if (!options.deviceScan || !isDeviceScanAck(result)) {
      return;
    }
    options.deviceScan(result.request);
  });
  bind(socket, WEB_EVENTS.channel.create, app, 'createChannel');
  bind(socket, WEB_EVENTS.channel.update, app, 'updateChannel');
  const afterChannelMutation = (payload: unknown, result: unknown) =>
    options.afterChannelMutation?.(payload, result);
  bind(socket, WEB_EVENTS.channel.addMember, app, 'addChannelHumanMember', afterChannelMutation);
  bind(socket, WEB_EVENTS.channel.removeMember, app, 'removeChannelHumanMember', afterChannelMutation);
  bind(socket, WEB_EVENTS.channel.addAgent, app, 'addChannelAgentMember', afterChannelMutation);
  bind(socket, WEB_EVENTS.channel.removeAgent, app, 'removeChannelAgentMember', afterChannelMutation);
  bind(socket, WEB_EVENTS.channel.members, app, 'listChannelMembers');
  socket.on(WEB_EVENTS.channel.join, async (payload, ack) => {
    try {
      const input = asChannelJoinInput(payload);
      if (!input) {
        ack?.(makeFailure('VALIDATION_ERROR', 'Invalid channel join payload'));
        return;
      }
      const channels = await app.listChannels({ userId: input.userId, teamId: input.teamId });
      if (!channels.ok) {
        ack?.(channels);
        return;
      }
      const channel = channels.channels.find((candidate) => candidate.id === input.channelId);
      if (!channel) {
        ack?.(makeFailure('NOT_FOUND', 'Channel not found'));
        return;
      }
      const messages = await app.listChannelMessages({ channelId: input.channelId, limit: input.limit });
      if (!messages.ok) {
        ack?.(messages);
        return;
      }
      ack?.({ ok: true, channel, messages: messages.messages });
    } catch (error) {
      ack?.(makeFailure('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unhandled socket handler error'));
    }
  });
  bind(socket, WEB_EVENTS.agent.create, app, 'createCustomAgent', (payload, result) =>
    options.afterAgentMutation?.(payload, result),
  );
  bind(socket, WEB_EVENTS.message.send, app, 'sendMessage', async (_payload, result) => {
    if (!options.dispatch || !isSendMessageAck(result)) {
      return;
    }
    for (const dispatch of result.dispatches) {
      const request = await app.getDispatchRequest({ dispatchId: dispatch.id });
      if (request.ok) {
        options.dispatch(request.request);
      }
    }
  });
}

export function registerAgentSocketHandlers(
  socket: SocketLike,
  app: ServerNextUseCases,
  options: AgentSocketHandlerOptions = {},
): void {
  const afterDeviceMutation = (payload: unknown, result: unknown) =>
    options.afterDeviceMutation?.(payload, result);
  bind(socket, AGENT_EVENTS.device.hello, app, 'deviceHello', afterDeviceMutation);
  bind(socket, AGENT_EVENTS.device.runtimes, app, 'reportDeviceRuntimes', afterDeviceMutation);
  const afterAgentMutation = (payload: unknown, result: unknown) =>
    options.afterAgentMutation?.(payload, result);
  bind(socket, AGENT_EVENTS.agent.registerBatch, app, 'registerDiscoveredAgents', afterAgentMutation);
  bind(socket, AGENT_EVENTS.dispatch.result, app, 'receiveDispatchResult', afterAgentMutation);
  bind(socket, AGENT_EVENTS.dispatch.error, app, 'receiveDispatchError', afterAgentMutation);
}

function bind(
  socket: SocketLike,
  event: string,
  app: ServerNextUseCases,
  methodName: UseCaseName,
  afterResult?: (payload: unknown, result: unknown) => Promise<void> | void,
): void {
  socket.on(event, async (payload, ack) => {
    try {
      const method = app[methodName] as (input: unknown) => Promise<unknown>;
      const result = await method(payload);
      ack?.(result);
      await afterResult?.(payload, result);
    } catch (error) {
      ack?.(makeFailure('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unhandled socket handler error'));
    }
  });
}

function asChannelJoinInput(payload: unknown): { userId: string; teamId: string; channelId: string; limit: number } | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { userId?: unknown; teamId?: unknown; channelId?: unknown; limit?: unknown };
  if (
    typeof candidate.userId !== 'string' ||
    typeof candidate.teamId !== 'string' ||
    typeof candidate.channelId !== 'string'
  ) {
    return null;
  }
  const limit = typeof candidate.limit === 'number' && Number.isInteger(candidate.limit)
    ? candidate.limit
    : 50;
  return {
    userId: candidate.userId,
    teamId: candidate.teamId,
    channelId: candidate.channelId,
    limit: Math.min(Math.max(limit, 1), 200),
  };
}

function isDeviceScanAck(result: unknown): result is {
  ok: true;
  request: {
    requestId: string;
    deviceId: string;
  };
} {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const request = (result as { ok?: unknown; request?: { requestId?: unknown; deviceId?: unknown } }).request;
  return (
    (result as { ok?: unknown }).ok === true &&
    typeof request?.requestId === 'string' &&
    typeof request?.deviceId === 'string'
  );
}

function isSendMessageAck(result: unknown): result is {
  ok: true;
  message: { body: string };
  dispatches: Array<{
    id: string;
    teamId: string;
    channelId: string;
    messageId: string;
    agentId: string;
    requestId: string;
  }>;
} {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const candidate = result as { ok?: unknown; message?: { body?: unknown }; dispatches?: unknown };
  return (
    candidate.ok === true &&
    typeof candidate.message?.body === 'string' &&
    Array.isArray(candidate.dispatches)
  );
}
