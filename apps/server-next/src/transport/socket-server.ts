import type { ServerNextUseCases } from '../application/usecases';
import { AGENT_EVENTS, WEB_EVENTS } from '../../../../packages/contracts/src/index';
import { registerAgentSocketHandlers, registerWebSocketHandlers, type SocketLike } from './socket-handlers';

export interface NamespaceLike {
  on(event: 'connection', handler: (socket: SocketLike) => void): void;
  emit?(event: string, payload: unknown): void;
}

export interface SocketServerLike {
  of(namespace: '/web' | '/agent'): NamespaceLike;
}

interface ChannelSubscription {
  userId: string;
  teamId: string;
}

type AgentSubscription = ChannelSubscription;

interface WebSocketSubscription {
  socket: SocketLike;
  channels?: ChannelSubscription;
  agents?: AgentSubscription;
}

export function attachServerNextNamespaces(server: SocketServerLike, app: ServerNextUseCases): void {
  const agentNamespace = server.of('/agent');
  const webSubscribers = new Set<WebSocketSubscription>();

  server.of('/web').on('connection', (socket) => {
    const subscriber: WebSocketSubscription = { socket };
    webSubscribers.add(subscriber);
    socket.on('disconnect', async () => {
      webSubscribers.delete(subscriber);
    });
    socket.on(WEB_EVENTS.channel.subscribe, async (payload, ack) => {
      const input = asChannelSubscription(payload);
      if (!input) {
        ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'Invalid channel subscription payload' });
        return;
      }
      const result = await app.listChannels(input);
      ack?.(result);
      if (result.ok) {
        subscriber.channels = input;
        socket.emit?.(WEB_EVENTS.channel.snapshot, result.channels);
      }
    });
    socket.on(WEB_EVENTS.agent.subscribe, async (payload, ack) => {
      const input = asAgentSubscription(payload);
      if (!input) {
        ack?.({ ok: false, error: 'VALIDATION_ERROR', message: 'Invalid agent subscription payload' });
        return;
      }
      const teamAccess = await app.listChannels(input);
      if (!teamAccess.ok) {
        ack?.(teamAccess);
        return;
      }
      const result = await app.listVisibleAgents({ teamId: input.teamId });
      ack?.(result);
      if (result.ok) {
        subscriber.agents = input;
        socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
      }
    });
    registerWebSocketHandlers(socket, app, {
      dispatch(request) {
        agentNamespace.emit?.(AGENT_EVENTS.dispatch.request, request);
      },
      async afterChannelMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const teamId = payloadTeamId(payload);
        if (!teamId) {
          return;
        }
        await refreshChannelSubscribers(webSubscribers, app, teamId);
      },
    });
  });
  agentNamespace.on('connection', (socket) => {
    registerAgentSocketHandlers(socket, app, {
      async afterAgentMutation(payload, result) {
        if (!isSuccessAck(result)) {
          return;
        }
        const teamId = payloadTeamId(payload) ?? resultDispatchTeamId(result);
        if (!teamId) {
          return;
        }
        await refreshAgentSubscribers(webSubscribers, app, teamId);
      },
    });
  });
}

async function refreshChannelSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.channels?.teamId !== teamId) {
      continue;
    }
    const result = await app.listChannels(subscriber.channels);
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.channel.snapshot, result.channels);
    }
  }
}

async function refreshAgentSubscribers(
  subscribers: Set<WebSocketSubscription>,
  app: ServerNextUseCases,
  teamId: string,
): Promise<void> {
  for (const subscriber of subscribers) {
    if (subscriber.agents?.teamId !== teamId) {
      continue;
    }
    const result = await app.listVisibleAgents({ teamId: subscriber.agents.teamId });
    if (result.ok) {
      subscriber.socket.emit?.(WEB_EVENTS.agent.snapshot, result.agents);
    }
  }
}

function asChannelSubscription(payload: unknown): ChannelSubscription | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const candidate = payload as { userId?: unknown; teamId?: unknown };
  if (typeof candidate.userId !== 'string' || typeof candidate.teamId !== 'string') {
    return null;
  }
  return { userId: candidate.userId, teamId: candidate.teamId };
}

const asAgentSubscription = asChannelSubscription;

function isSuccessAck(result: unknown): result is { ok: true } {
  return Boolean(result && typeof result === 'object' && (result as { ok?: unknown }).ok === true);
}

function payloadTeamId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const teamId = (payload as { teamId?: unknown }).teamId;
  return typeof teamId === 'string' ? teamId : null;
}

function resultDispatchTeamId(result: unknown): string | null {
  if (!result || typeof result !== 'object') {
    return null;
  }
  const dispatch = (result as { dispatch?: { teamId?: unknown } }).dispatch;
  return typeof dispatch?.teamId === 'string' ? dispatch.teamId : null;
}
