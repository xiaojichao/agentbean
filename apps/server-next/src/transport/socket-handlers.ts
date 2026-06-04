import { AGENT_EVENTS, WEB_EVENTS, makeFailure, type DispatchRequestDto } from '../../../../packages/contracts/src/index';
import type { ServerNextUseCases } from '../application/usecases';

export interface SocketLike {
  on(event: string, handler: SocketHandler): void;
}

export type SocketAck = (result: unknown) => void;
export type SocketHandler = (payload: unknown, ack?: SocketAck) => Promise<void>;

type UseCaseName = keyof ServerNextUseCases;

export interface WebSocketHandlerOptions {
  dispatch?(request: DispatchRequestDto & { id: string }): void;
}

export function registerWebSocketHandlers(
  socket: SocketLike,
  app: ServerNextUseCases,
  options: WebSocketHandlerOptions = {},
): void {
  bind(socket, WEB_EVENTS.auth.register, app, 'registerUser');
  bind(socket, WEB_EVENTS.auth.login, app, 'loginUser');
  bind(socket, WEB_EVENTS.team.list, app, 'listTeams');
  bind(socket, WEB_EVENTS.channel.create, app, 'createChannel');
  bind(socket, WEB_EVENTS.channel.update, app, 'updateChannel');
  bind(socket, WEB_EVENTS.channel.addMember, app, 'addChannelHumanMember');
  bind(socket, WEB_EVENTS.channel.removeMember, app, 'removeChannelHumanMember');
  bind(socket, WEB_EVENTS.channel.addAgent, app, 'addChannelAgentMember');
  bind(socket, WEB_EVENTS.channel.removeAgent, app, 'removeChannelAgentMember');
  bind(socket, WEB_EVENTS.channel.members, app, 'listChannelMembers');
  bind(socket, WEB_EVENTS.message.send, app, 'sendMessage', (result) => {
    if (!options.dispatch || !isSendMessageAck(result)) {
      return;
    }
    for (const dispatch of result.dispatches) {
      options.dispatch({
        id: dispatch.id,
        teamId: dispatch.teamId,
        channelId: dispatch.channelId,
        messageId: dispatch.messageId,
        agentId: dispatch.agentId,
        requestId: dispatch.requestId,
        prompt: result.message.body,
      });
    }
  });
}

export function registerAgentSocketHandlers(socket: SocketLike, app: ServerNextUseCases): void {
  bind(socket, AGENT_EVENTS.device.hello, app, 'deviceHello');
  bind(socket, AGENT_EVENTS.device.runtimes, app, 'reportDeviceRuntimes');
  bind(socket, AGENT_EVENTS.agent.registerBatch, app, 'registerDiscoveredAgents');
  bind(socket, AGENT_EVENTS.dispatch.result, app, 'receiveDispatchResult');
  bind(socket, AGENT_EVENTS.dispatch.error, app, 'receiveDispatchError');
}

function bind(
  socket: SocketLike,
  event: string,
  app: ServerNextUseCases,
  methodName: UseCaseName,
  afterResult?: (result: unknown) => void,
): void {
  socket.on(event, async (payload, ack) => {
    try {
      const method = app[methodName] as (input: unknown) => Promise<unknown>;
      const result = await method(payload);
      ack?.(result);
      afterResult?.(result);
    } catch (error) {
      ack?.(makeFailure('INTERNAL_ERROR', error instanceof Error ? error.message : 'Unhandled socket handler error'));
    }
  });
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
